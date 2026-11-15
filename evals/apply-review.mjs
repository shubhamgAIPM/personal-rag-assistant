// Merges the hand review into the automatic results and prints the final numbers.
//   node evals/apply-review.mjs baseline-2026-11-15
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const label = process.argv[2];
if (!label) {
  console.error("Usage: node evals/apply-review.mjs <label>");
  process.exit(2);
}
const { results } = JSON.parse(readFileSync(join(here, "results", `${label}.json`), "utf8"));
const review = JSON.parse(readFileSync(join(here, `manual-review-${label}.json`), "utf8"));

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

const rows = results.map((r) => {
  const m = review[r.id] ?? {};
  return { ...r, manual: m };
});

const yes = rows.filter((r) => r.answerable === "yes");
const partial = rows.filter((r) => r.answerable === "partial");
const answerable = [...yes, ...partial];
const no = rows.filter((r) => r.answerable === "no");

const stats = {
  label,
  questions: rows.length,
  answerable_yes: yes.length,
  answerable_partial: partial.length,
  unanswerable: no.length,
  correctness_yes_avg: mean(yes.map((r) => r.manual.correctness)),
  correctness_yes_all_two: yes.filter((r) => r.manual.correctness === 2).length,
  faithfulness_answerable_avg: mean(answerable.map((r) => r.manual.faithfulness)),
  faithfulness_not_two: answerable.filter((r) => r.manual.faithfulness !== 2).map((r) => r.id),
  citation_avg_answerable: mean(answerable.map((r) => r.manual.citation)),
  abstention_pass: no.filter((r) => r.manual.abstention === "pass").length,
  abstention_not_scored: no.filter((r) => r.manual.abstention === "not_scored").map((r) => r.id),
  auto_vs_manual_differences: rows
    .filter((r) => r.auto?.correctness !== undefined && r.auto.correctness !== r.manual.correctness)
    .map((r) => `${r.id}: auto ${r.auto.correctness} -> manual ${r.manual.correctness}`),
};

const cols = ["id", "category", "question", "answerable", "answer", "cited_sources", "auto_correctness", "auto_citation", "manual_correctness", "manual_faithfulness", "manual_citation", "manual_abstention", "review_note"];
const q = (v) => `"${String(v ?? "").replaceAll('"', '""').replace(/\s+/g, " ")}"`;
const csv = [
  cols.join(","),
  ...rows.map((r) =>
    [
      r.id,
      r.category,
      r.question,
      r.answerable,
      r.answer,
      (r.sources ?? []).map((s) => s.title).join(" | "),
      r.auto?.correctness ?? "",
      r.auto?.citation ?? "",
      r.manual.correctness ?? "",
      r.manual.faithfulness ?? "",
      r.manual.citation ?? "",
      r.manual.abstention ?? "",
      r.manual.note ?? "",
    ]
      .map(q)
      .join(","),
  ),
].join("\n");
writeFileSync(join(here, "results", `${label}-reviewed.csv`), csv);

console.log(JSON.stringify(stats, null, 2));
console.log(`\nWrote evals/results/${label}-reviewed.csv`);
