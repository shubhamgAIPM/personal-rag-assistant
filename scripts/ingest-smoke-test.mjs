// End-to-end smoke test of the ingestion + retrieval path against a NON-PRODUCTION
// Supabase project: chunk -> embed (real model) -> insert -> match_rag_chunks.
//   node --env-file=.env.local scripts/ingest-smoke-test.mjs
// Uses TEST_USER_A_* credentials and the anon key only. Cleans up after itself.
import { AutoTokenizer, pipeline } from "@huggingface/transformers";
import { createClient } from "@supabase/supabase-js";
import { chunkText, embeddingText } from "../src/lib/chunker.ts";
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL_LABEL,
  MODEL_DTYPE,
  MODEL_ID,
  MODEL_REVISION,
  QUERY_PREFIX,
} from "../src/lib/embeddingConfig.ts";

for (const k of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD"]) {
  if (!process.env[k]) {
    console.error(`Missing env var ${k}`);
    process.exit(2);
  }
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
};

const DOC = `# Retrieval design

The assistant embeds every question in the browser and sends the vector to a secure Edge Function. The function searches only chunks that the signed-in user is allowed to read, using row level security in Postgres.

## Chunking decisions

We chose chunks of roughly 350 tokens with a 50 token overlap because the embedding model accepts at most 512 tokens. Larger chunks would be silently truncated and hurt retrieval quality.

## Cooking notes

To make a proper sourdough loaf, feed the starter twice a day and bake the dough in a preheated Dutch oven at 230 degrees Celsius for forty minutes.

## Budget

The team agreed to a monthly infrastructure budget of 120 dollars, to be reviewed in March.
`;

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const { data: auth, error: authErr } = await supabase.auth.signInWithPassword({
  email: process.env.TEST_USER_A_EMAIL,
  password: process.env.TEST_USER_A_PASSWORD,
});
if (authErr) {
  console.error("Sign-in failed. Check TEST_USER_A_* and the Supabase URL.");
  process.exit(2);
}
const userId = auth.user.id;

console.log("Loading model (first run downloads ~35 MB)...");
const extractor = await pipeline("feature-extraction", MODEL_ID, { dtype: MODEL_DTYPE, revision: MODEL_REVISION });
const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, { revision: MODEL_REVISION });
const count = (t) => tokenizer.encode(t, { add_special_tokens: false }).length;
const embed = async (texts) => (await extractor(texts, { pooling: "cls", normalize: true })).tolist();

// Small chunk sizes force several chunks from this short sample so retrieval has to
// discriminate between them. Production sizes are covered by scripts/test-chunker.mjs.
const chunks = chunkText(DOC, count, { targetTokens: 60, maxTokens: 100, overlapTokens: 10 });
check("document produced chunks", chunks.length >= 3, `chunks=${chunks.length}`);
const vectors = await embed(chunks.map((c) => embeddingText(c)));
check("embeddings have the expected dimension", vectors.every((v) => v.length === EMBEDDING_DIM), `dim=${vectors[0]?.length}`);

let docId = null;
try {
  const doc = await supabase
    .from("rag_documents")
    .insert({
      owner_id: userId,
      visibility: "private",
      source_type: "upload",
      title: "ingest-smoke-test.md",
      status: "processing",
    })
    .select("id")
    .single();
  check("document row inserted", !doc.error, doc.error?.message);
  docId = doc.data?.id;
  if (!docId) throw new Error("no document id");

  const ins = await supabase.from("rag_chunks").insert(
    chunks.map((c, i) => ({
      document_id: docId,
      owner_id: userId,
      visibility: "private",
      chunk_index: c.index,
      content: c.content,
      embedding: `[${vectors[i].join(",")}]`,
      embedding_model: EMBEDDING_MODEL_LABEL,
      source_locator: c.locator,
    })),
  );
  check("chunks inserted", !ins.error, ins.error?.message);

  // Before 'ready', match_rag_chunks must not return this document.
  const [qNotReady] = await embed([QUERY_PREFIX + "What budget did the team agree on?"]);
  const early = await supabase.rpc("match_rag_chunks", {
    query_embedding: `[${qNotReady.join(",")}]`,
    match_count: 5,
    min_similarity: 0,
  });
  check("processing documents are not retrievable", !early.error && !early.data.some((r) => r.document_id === docId));

  const ready = await supabase.from("rag_documents").update({ status: "ready" }).eq("id", docId);
  check("document marked ready", !ready.error, ready.error?.message);

  const ask = async (question) => {
    const [q] = await embed([QUERY_PREFIX + question]);
    const { data, error } = await supabase.rpc("match_rag_chunks", {
      query_embedding: `[${q.join(",")}]`,
      match_count: 3,
      min_similarity: 0,
    });
    if (error) throw new Error(error.message);
    return data.filter((r) => r.document_id === docId);
  };

  const budget = await ask("What monthly budget did the team agree on?");
  check("budget question retrieves the budget chunk first", budget[0]?.content.includes("120 dollars"), `top locator=${budget[0]?.source_locator} sim=${budget[0]?.similarity?.toFixed(3)}`);

  const chunking = await ask("Why are chunks about 350 tokens with overlap?");
  check("chunking question retrieves the chunking chunk first", chunking[0]?.content.includes("512 tokens"), `top locator=${chunking[0]?.source_locator} sim=${chunking[0]?.similarity?.toFixed(3)}`);

  const bread = await ask("How hot should the oven be for baking bread?");
  check("unrelated-topic question retrieves the cooking chunk first", bread[0]?.content.includes("Dutch oven"), `top locator=${bread[0]?.source_locator}`);

  // Informational: similarity for an off-topic question, to help pick a threshold later.
  const offTopic = await ask("Who won the football world cup in 2018?");
  console.log(`INFO  off-topic top similarity=${offTopic[0]?.similarity?.toFixed(3)} (use to tune the no-evidence threshold)`);
  console.log(`INFO  on-topic top similarities: budget=${budget[0]?.similarity?.toFixed(3)}, chunking=${chunking[0]?.similarity?.toFixed(3)}`);
} finally {
  if (docId) {
    const del = await supabase.from("rag_documents").delete().eq("id", docId);
    console.log(del.error ? `Cleanup failed: ${del.error.message}` : "Cleanup: test document removed (chunks cascade).");
  }
}

console.log(failures === 0 ? "\nAll ingestion smoke checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
