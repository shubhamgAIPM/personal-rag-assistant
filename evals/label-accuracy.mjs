// Measures whether the section label shown next to a citation matches the section that actually
// contains the fact.   node evals/label-accuracy.mjs <results-label>
//
// For every chunk (cited source, or retrieved top-5 chunk) that contains a gold passage, finds the
// nearest heading before that passage in the original document in demo-docs/ and compares it to the
// chunk's label. A label is correct when its LAST path segment equals that heading, so the old
// single-heading labels and the new "Doc > Section" paths are judged by the same rule.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const label = process.argv[2];
if (!label) {
  console.error("Usage: node evals/label-accuracy.mjs <results-label>");
  process.exit(2);
}
const { results } = JSON.parse(readFileSync(join(here, "results", `${label}.json`), "utf8"));

const docsDir = join(here, "..", "demo-docs");
const docs = Object.fromEntries(readdirSync(docsDir).filter((f) => f.endsWith(".md")).map((f) => [f, readFileSync(join(docsDir, f), "utf8")]));

function headingBefore(file, passage) {
  const text = docs[file];
  if (!text) return null;
  const i = text.toLowerCase().indexOf(passage.toLowerCase());
  if (i < 0) return null;
  const hs = [...text.slice(0, i).matchAll(/^#{1,6}\s+(.+)$/gm)];
  return hs.length ? hs[hs.length - 1][1].trim() : null;
}

function measure(items) {
  // items: [{ caseId, title, locator, content }]
  let total = 0;
  const wrong = [];
  for (const it of items) {
    const groups = it.groups.filter((g) => it.content.toLowerCase().includes(g.toLowerCase()));
    for (const g of groups) {
      const want = headingBefore(it.title, g);
      if (!want) continue;
      total++;
      const got = (it.locator ?? "").split(" > ").pop().trim();
      if (got !== want) wrong.push(`${it.caseId}: label "${it.locator}" but the passage is under "${want}"`);
    }
  }
  return { total, correct: total - wrong.length, wrong };
}

const groupsOf = (r) => (r.passage_contains || "").split("||").map((x) => x.trim()).filter(Boolean);
const cited = results.flatMap((r) => (r.sources ?? []).map((s) => ({ caseId: r.id, title: s.title, locator: s.locator, content: s.excerpt, groups: groupsOf(r) })));
const retrieved = results.flatMap((r) => (r.retrieved ?? []).map((c) => ({ caseId: r.id, title: c.title, locator: c.locator, content: c.content, groups: groupsOf(r) })));

const a = measure(cited);
const b = measure(retrieved);
const pct = (m) => (m.total ? `${((m.correct / m.total) * 100).toFixed(0)}%` : "n/a");
console.log(`Results: ${label}`);
console.log(`Cited sources:        ${m(a)} labels correct (${pct(a)})`);
console.log(`Retrieved top-5 chunks: ${m(b)} labels correct (${pct(b)})`);
if (process.argv.includes("--verbose")) console.log("\nWrong cited labels:\n" + a.wrong.join("\n"));

function m(x) {
  return `${x.correct}/${x.total}`;
}
