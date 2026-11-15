// Runs the evaluation in evals/rag-eval-cases.csv against the public demo.
//
//   node --env-file=.env.local evals/run-eval.mjs --label baseline
//   node --env-file=.env.local evals/run-eval.mjs --label baseline --skip-answers   (retrieval only, fast)
//
// Two separate measurements, as in the blueprint:
//   A. RETRIEVAL: calls match_rag_chunks directly (scope public_demo, top 5, no threshold) and checks
//      whether the gold passage text appears in the retrieved chunks. Independent of the generated answer.
//   B. ANSWERS: calls the live answer-question function in demo mode and scores what can be scored
//      automatically (key facts present, citations point at the gold passage, abstention). Faithfulness
//      needs a human (or reviewer) read, so it is left blank in the output.
//
// Only the public Supabase URL and publishable key are used. Requests are paced to stay under the demo
// rate limit (5 per minute per visitor, 40 per day).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { pipeline } from "@huggingface/transformers";
import { MODEL_DTYPE, MODEL_ID, MODEL_REVISION, QUERY_PREFIX } from "../src/lib/embeddingConfig.ts";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const label = args.includes("--label") ? args[args.indexOf("--label") + 1] : "run";
const skipAnswers = args.includes("--skip-answers");
const THRESHOLD = 0.5; // must match the function's MIN_SIMILARITY default
const PACE_MS = 13_000; // 5 requests/minute = one every 12 s; add margin

for (const k of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"]) {
  if (!process.env[k]) {
    console.error(`Missing env var ${k}`);
    process.exit(2);
  }
}
const base = process.env.VITE_SUPABASE_URL.replace(/\/+$/, "");
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;

// ---------------------------------------------------------------- CSV
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.length > 1);
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}
const toCsv = (rows, cols) =>
  [cols.join(","), ...rows.map((r) => cols.map((c) => `"${String(r[c] ?? "").replaceAll('"', '""')}"`).join(","))].join("\n");

const cases = parseCsv(readFileSync(join(here, "rag-eval-cases.csv"), "utf8"));

// ------------------------------------------------------------- helpers
const lc = (s) => s.toLowerCase();
const splitList = (s, sep) => s.split(sep).map((x) => x.trim()).filter(Boolean);
const matchRegexes = (answer, spec) => {
  const parts = splitList(spec, "&&");
  if (parts.length === 0) return { matched: 0, total: 0 };
  return { matched: parts.filter((p) => new RegExp(p, "i").test(answer)).length, total: parts.length };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ABSTAIN_PHRASES = /(not (available|enough|found|mentioned|contain)|no (evidence|information|mention)|cannot find|can't find|couldn't find|does not (say|specify|mention|contain|include)|isn't (mentioned|specified)|insufficient)/i;

// ---------------------------------------------------- embeddings + DB
console.log("Loading embedding model...");
const extractor = await pipeline("feature-extraction", MODEL_ID, { dtype: MODEL_DTYPE, revision: MODEL_REVISION });
const embedQuery = async (q) => (await extractor([QUERY_PREFIX + q], { pooling: "cls", normalize: true })).tolist()[0];
const anon = createClient(base, anonKey, { auth: { persistSession: false } });

const corpus = await anon.from("rag_documents").select("id,title").eq("visibility", "public_demo");
if (corpus.error || !corpus.data?.length) {
  console.error("No public demo documents found. Apply supabase/seed/demo_seed.sql first.");
  process.exit(2);
}
console.log(`Corpus: ${corpus.data.length} demo documents`);

// ------------------------------------------------------- A. retrieval
const results = [];
for (const c of cases) {
  const embedding = await embedQuery(c.question);
  const { data, error } = await anon.rpc("match_rag_chunks", {
    query_embedding: `[${embedding.join(",")}]`,
    match_count: 5,
    min_similarity: 0,
    scope: "public_demo",
  });
  if (error) throw new Error(`retrieval failed for ${c.id}: ${error.message}`);

  const groups = splitList(c.passage_contains, "||");
  const answerable = c.answerable !== "no";
  const retrieved = data.map((r, i) => ({ rank: i + 1, similarity: r.similarity, title: r.title, locator: r.source_locator, content: r.content }));
  const groupHit = (g, list) => list.some((r) => lc(r.content).includes(lc(g)));
  const relevantRank = groups.length
    ? retrieved.find((r) => groups.some((g) => lc(r.content).includes(lc(g))))?.rank ?? null
    : null;
  const aboveThreshold = retrieved.filter((r) => r.similarity >= THRESHOLD);

  results.push({
    ...c,
    retrieved,
    top_similarity: retrieved[0]?.similarity ?? null,
    retrieval: {
      applicable: answerable && groups.length > 0,
      hit_at_5: groups.length ? groups.some((g) => groupHit(g, retrieved)) : null,
      hit_at_5_above_threshold: groups.length ? groups.some((g) => groupHit(g, aboveThreshold)) : null,
      first_relevant_rank: relevantRank,
      coverage: groups.length ? groups.filter((g) => groupHit(g, retrieved)).length / groups.length : null,
      chunks_above_threshold: aboveThreshold.length,
    },
  });
}

// ---------------------------------------------------------- B. answers
if (!skipAnswers) {
  console.log(`Asking ${cases.length} questions via the live demo (paced, about ${Math.ceil((cases.length * PACE_MS) / 60000)} minutes)...`);
  for (const [i, r] of results.entries()) {
    const embedding = await embedQuery(r.question);
    const ask = () =>
      fetch(`${base}/functions/v1/answer-question`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: anonKey },
        body: JSON.stringify({ question: r.question, query_embedding: embedding, workspace: "demo" }),
      });
    let res = await ask();
    if (res.status === 429) {
      console.log(`  ${r.id}: rate limited, waiting 65 s and retrying once`);
      await sleep(65_000);
      res = await ask();
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON */
    }
    r.http_status = res.status;
    r.answer = body?.answer ?? "";
    r.insufficient_evidence = body?.insufficient_evidence ?? null;
    r.sources = (body?.sources ?? []).map((s) => ({ ref: s.ref, title: s.title, locator: s.locator, excerpt: s.excerpt }));
    r.error = body?.error ?? "";
    console.log(`  ${r.id} (${i + 1}/${results.length}): status ${res.status}, insufficient=${r.insufficient_evidence}`);
    if (i < results.length - 1) await sleep(PACE_MS);
  }

  // ---- automatic scoring
  for (const r of results) {
    const answerable = r.answerable !== "no";
    const groups = splitList(r.passage_contains, "||");
    const { matched, total } = matchRegexes(r.answer, r.answer_must_match);
    const forbidden = r.must_not_match && new RegExp(r.must_not_match, "i").test(r.answer);
    const abstained = r.insufficient_evidence === true || ABSTAIN_PHRASES.test(r.answer);

    if (r.http_status !== 200) {
      r.auto = { note: `request failed (status ${r.http_status})` };
      continue;
    }
    if (!answerable) {
      r.auto = {
        abstention: forbidden ? "fail" : abstained ? "pass" : "review",
        note: forbidden ? "answer contains forbidden content" : abstained ? "" : "did not clearly abstain; read the answer",
      };
      continue;
    }
    // answerable (yes or partial)
    const sourceHit = groups.filter((g) => r.sources.some((s) => lc(s.excerpt).includes(lc(g))));
    let correctness = total === 0 ? null : matched === total ? 2 : matched > 0 ? 1 : 0;
    if (r.insufficient_evidence === true && r.answerable === "yes") correctness = 0;
    let citation = r.sources.length === 0 ? 0 : sourceHit.length === groups.length ? 2 : sourceHit.length > 0 ? 1 : 1;
    if (r.sources.length > 0 && sourceHit.length === 0) citation = 1; // cited something, but not the gold passage
    r.auto = { correctness, citation, abstained_when_answerable: r.insufficient_evidence === true };
    if (r.answerable === "partial") r.auto.partial_ok = abstained || matched > 0;
  }
}

// ------------------------------------------------------------ summary
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const retrievable = results.filter((r) => r.retrieval.applicable);
const summary = {
  label,
  date: new Date().toISOString().slice(0, 10),
  corpus_documents: corpus.data.length,
  questions: results.length,
  retrieval: {
    answerable_with_gold_passage: retrievable.length,
    hit_at_5: retrievable.filter((r) => r.retrieval.hit_at_5).length,
    hit_at_5_above_threshold: retrievable.filter((r) => r.retrieval.hit_at_5_above_threshold).length,
    mrr: mean(retrievable.map((r) => (r.retrieval.first_relevant_rank ? 1 / r.retrieval.first_relevant_rank : 0))),
    avg_coverage: mean(retrievable.map((r) => r.retrieval.coverage)),
    off_topic_top_similarities: results.filter((r) => r.answerable === "no").map((r) => ({ id: r.id, sim: Number(r.top_similarity?.toFixed(3)) })),
    on_topic_min_top_similarity: Math.min(...retrievable.map((r) => r.top_similarity)),
  },
};
if (!skipAnswers) {
  const ans = results.filter((r) => r.answerable !== "no" && r.auto?.correctness !== undefined);
  const una = results.filter((r) => r.answerable === "no");
  summary.answers = {
    answerable_scored: ans.length,
    avg_correctness_0_2: mean(ans.map((r) => r.auto.correctness).filter((x) => x !== null)),
    avg_citation_0_2: mean(ans.map((r) => r.auto.citation)),
    wrongly_abstained: ans.filter((r) => r.answerable === "yes" && r.auto.abstained_when_answerable).map((r) => r.id),
    unanswerable: una.length,
    abstention_pass: una.filter((r) => r.auto?.abstention === "pass").length,
    abstention_needs_review: una.filter((r) => r.auto?.abstention === "review").map((r) => r.id),
    abstention_fail: una.filter((r) => r.auto?.abstention === "fail").map((r) => r.id),
    request_failures: results.filter((r) => r.http_status !== 200).map((r) => r.id),
  };
}

const outDir = join(here, "results");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${label}.json`), JSON.stringify({ summary, results }, null, 2));
const csvRows = results.map((r) => ({
  id: r.id,
  category: r.category,
  question: r.question,
  answerable: r.answerable,
  retrieved_titles: r.retrieved.map((x) => `${x.rank}:${x.title}`).join(" | "),
  top_similarity: r.top_similarity?.toFixed(3),
  hit_at_5: r.retrieval.hit_at_5,
  first_relevant_rank: r.retrieval.first_relevant_rank,
  coverage: r.retrieval.coverage,
  answer: r.answer ?? "",
  insufficient_evidence: r.insufficient_evidence ?? "",
  cited_sources: (r.sources ?? []).map((s) => s.title).join(" | "),
  auto_correctness: r.auto?.correctness ?? "",
  auto_citation: r.auto?.citation ?? "",
  auto_abstention: r.auto?.abstention ?? "",
  faithfulness_0_2: "",
  notes: r.auto?.note ?? "",
}));
writeFileSync(join(outDir, `${label}.csv`), toCsv(csvRows, Object.keys(csvRows[0])));

console.log("\n=== Summary ===");
console.log(JSON.stringify(summary, null, 2));
console.log(`\nWrote evals/results/${label}.json and .csv`);
process.exit(0);
