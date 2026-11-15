// Tests the chunker with the real bge-small tokenizer.
//   node scripts/test-chunker.mjs
import { AutoTokenizer } from "@huggingface/transformers";
import { chunkText, DEFAULT_CHUNK_OPTIONS } from "../src/lib/chunker.ts";
import {
  MODEL_ID,
  MODEL_REVISION,
  MODEL_MAX_TOKENS,
  SPECIAL_TOKENS,
} from "../src/lib/embeddingConfig.ts";

const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, { revision: MODEL_REVISION });
const count = (t) => tokenizer.encode(t, { add_special_tokens: false }).length;
const HARD_LIMIT = MODEL_MAX_TOKENS - SPECIAL_TOKENS;

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
};

const sentence = (n) =>
  `Sentence number ${n} describes a project decision about the retrieval pipeline and its trade-offs.`;
const para = (start, n) => Array.from({ length: n }, (_, i) => sentence(start + i)).join(" ");

// 1. Empty / whitespace input
check("empty input gives no chunks", chunkText("   \n\n ", count).length === 0);

// 2. Short document -> one chunk
const short = chunkText("# Title\n\nA short note about the project.", count);
check("short doc is one chunk", short.length === 1, `chunks=${short.length}`);
check("short doc locator is heading", short[0]?.locator === "Title", String(short[0]?.locator));

// 3. Long structured markdown
const md = [
  "# Architecture",
  para(1, 40),
  "## Data model",
  para(100, 60),
  "## Privacy",
  para(200, 30),
].join("\n\n");
const chunks = chunkText(md, count);
check("long doc produces several chunks", chunks.length >= 4, `chunks=${chunks.length}`);
check(
  "every chunk within model limit",
  chunks.every((c) => c.tokens <= HARD_LIMIT),
  `max=${Math.max(...chunks.map((c) => c.tokens))} limit=${HARD_LIMIT}`,
);
check(
  "chunks stay near target (<= maxTokens + small join overhead)",
  chunks.every((c) => c.tokens <= DEFAULT_CHUNK_OPTIONS.maxTokens + 10),
);
check("chunk indexes are sequential", chunks.every((c, i) => c.index === i));
check(
  "locators are heading paths",
  chunks.some((c) => c.locator === "Architecture > Data model") && chunks.some((c) => c.locator === "Architecture > Privacy"),
  [...new Set(chunks.map((c) => c.locator))].join(" | "),
);
// A chunk must never span two sections: at most one heading line per chunk.
check(
  "no chunk spans two headings",
  chunks.every((c) => (c.content.match(/^#{1,6} /gm) ?? []).length <= 1),
);
// ...and no text from another section may appear under a section's label (no cross-section overlap).
const sectionRange = { "Architecture": [1, 40], "Architecture > Data model": [100, 159], "Architecture > Privacy": [200, 229] };
const stray = chunks.filter((c) => {
  const [lo, hi] = sectionRange[c.locator] ?? [0, -1];
  return [...c.content.matchAll(/Sentence number (\d+)/g)].some((m) => Number(m[1]) < lo || Number(m[1]) > hi);
});
check("every chunk only contains text from its own section", stray.length === 0, `offending=${stray.map((c) => c.locator).join(",")}`);

check(
  "no chunk ends with a dangling heading",
  chunks.every((c) => !/\n\n#{1,6} [^\n]+$/.test(c.content)),
);

// 4. Overlap: consecutive chunks share some trailing/leading text
let overlapPairs = 0;
for (let i = 1; i < chunks.length; i++) {
  const prevEnd = chunks[i - 1].content.slice(-60);
  if (chunks[i].content.includes(prevEnd.trim().slice(-30))) overlapPairs++;
}
check("consecutive chunks overlap", overlapPairs >= 1, `pairs=${overlapPairs}`);

// 5. Content coverage: every sentence appears in at least one chunk
const joined = chunks.map((c) => c.content).join("\n");
const missing = [1, 20, 40, 100, 150, 200, 229].filter((n) => !joined.includes(sentence(n)));
check("no sentences lost", missing.length === 0, `missing=${missing.join(",")}`);

// 6. Oversized unit with no sentence boundaries (e.g. one huge line)
const blob = Array.from({ length: 3000 }, (_, i) => `word${i}`).join(" ");
const blobChunks = chunkText(blob, count);
check("oversized paragraph is split", blobChunks.length > 1, `chunks=${blobChunks.length}`);
check(
  "oversized pieces within model limit",
  blobChunks.every((c) => c.tokens <= HARD_LIMIT),
  `max=${Math.max(...blobChunks.map((c) => c.tokens))}`,
);

// 7. No whitespace at all (hard split path)
const dense = "x".repeat(20000);
const denseChunks = chunkText(dense, count);
check(
  "unbroken string is split by character cap and within token limit",
  denseChunks.length > 1 &&
    denseChunks.every(
      (c) => c.tokens <= HARD_LIMIT && c.content.length <= DEFAULT_CHUNK_OPTIONS.maxChars,
    ),
  `chunks=${denseChunks.length} maxChars=${Math.max(...denseChunks.map((c) => c.content.length))}`,
);

// 8. Code fence kept together; heading inside fence not treated as heading
const fenced = "# Doc\n\nIntro text.\n\n```\n# not a heading\nconst a = 1;\n```\n\nAfter code.";
const fencedChunks = chunkText(fenced, count);
check(
  "heading inside code fence is not a locator",
  fencedChunks.every((c) => c.locator !== "not a heading"),
);

// 8b. Section structure edge cases
const nested = chunkText("# A\n\n## B\n\nBody of B.\n\n## C\n\nBody of C.\n\n### D\n\nBody of D.", count);
check(
  "sibling headings reset the path and nesting extends it",
  nested.map((c) => c.locator).join(" | ") === "A > B | A > C | A > C > D",
  nested.map((c) => c.locator).join(" | "),
);
check("parent heading with no body does not become its own chunk", nested.length === 3 && nested.every((c) => !/^# A\s*$/.test(c.content.trim())), `chunks=${nested.length}`);
const trailing = chunkText("# A\n\nBody.\n\n## Empty end", count);
check("trailing heading without body makes no chunk", trailing.length === 1 && trailing[0].locator === "A", `chunks=${trailing.length}`);
const plain = chunkText("Just some text without any headings. It has two sentences.", count);
check("text without headings has a null locator", plain.length === 1 && plain[0].locator === null);

// 9. Option validation
let threw = false;
try {
  chunkText("x", count, { targetTokens: 50, overlapTokens: 60 });
} catch {
  threw = true;
}
check("rejects overlap >= target", threw);

console.log(failures === 0 ? "\nAll chunker checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
