# Evaluation results

Two runs of a small, honest evaluation of the public demo: a **baseline**, then a **second run after one change** (chunks kept inside a single section, labelled with the heading path). It is a first measurement, not proof of broad reliability. Please read [How far to trust this](#how-far-to-trust-this).

## What was tested

- **System under test:** the live public demo (`workspace: "demo"`), with the production settings: search model `bge-small-en-v1.5`, top 5 chunks, similarity cutoff 0.5, answers from `openai/gpt-oss-20b` on Groq.
- **Corpus:** 3 fictional documents about an imaginary product ("Orbit Notes"). Baseline: **8 chunks**. Second run: **36 chunks** (median 54 tokens, largest 132), because chunks now stop at section boundaries.
- **Questions:** 20, in [`evals/rag-eval-cases.csv`](../evals/rag-eval-cases.csv). 16 have a clear answer in the documents, 1 is a false-premise question (partial), and 3 should be refused. Categories: direct facts, numbers and dates, two-document questions, conflicting sources, project decisions, detail inside long documents, a paraphrased question that avoids the document's wording, vague questions, off-topic questions, and a prompt-extraction attempt.
- **Gold passages:** each answerable question names text that must appear in a retrieved chunk. This is checked by text, not by chunk ID, so it still works when chunking changes.

## How it was scored

Retrieval and answers are scored **separately**, as in the original blueprint.

| Measurement | How |
|---|---|
| Retrieval | The search function is called directly (top 5, no cutoff) and the gold passage text is looked for in the results. Independent of the generated answer. |
| Correctness (0-2) | Pattern checks for the key facts, then read by hand. |
| Faithfulness (0-2) | Read by hand: is every claim supported by the cited documents? |
| Citation quality (0-2) | Do the cited sources contain the gold passage and support the claims? |
| Label accuracy | For each cited chunk containing a gold passage: does its section label match the section that holds the fact? ([`evals/label-accuracy.mjs`](../evals/label-accuracy.mjs)) |
| Abstention (pass/fail) | Did it refuse when the documents do not contain the answer? |

Rubric: 0 = incorrect, unsupported or missing; 1 = partly correct or incomplete; 2 = correct and supported.

Data: [baseline](../evals/results/baseline-2026-11-15.json) and [second run](../evals/results/after-section-chunks-2026-11-15.json) (raw), and the `-reviewed.csv` files next to them with a note on every judgment call.

## Results: before and after

| Measure | Baseline | After section-bounded chunks |
|---|---|---|
| **Citation labels correct** (cited sources) | **2 of 22 (9%)** | **17 of 17 (100%)** |
| Labels correct (retrieved chunks containing the gold passage) | 2 of 24 (8%) | 18 of 18 (100%) |
| Chunks in the demo corpus | 8 | 36 |
| Gold passage in top 5 (Hit@5) | 16 of 17 (94%) | 14 of 17 (82%) |
| Gold passage ranked first | 7 of 17 (41%) | 10 of 17 (59%) |
| Mean reciprocal rank | 0.62 | 0.69 |
| Average coverage of multi-passage questions | 0.94 | 0.82 |
| Answerable questions fully correct | 15 of 16 | 14 of 16 |
| Faithfulness (17 answerable or partial, out of 2) | 1.88 | 1.94 |
| Citation quality (out of 2) | 1.76 | 1.76 |
| Correct refusals | 3 of 3 | 2 of 2 scored (1 not scored: rate limited) |

Hit@5 in the baseline was weak evidence: the top 5 covered 62% of an 8-chunk corpus. With 36 chunks it covers 14%, so the second-run figures are more meaningful, although the corpus is still tiny.

### Verdict

- **The label problem is fixed**, which was the goal: 9% to 100%.
- **Specific-fact questions improved.** The right passage is first more often (41% to 59%). The paraphrased question that failed in the baseline (E12) now works, and several facts moved from rank 3-4 up to rank 1.
- **Vague and multi-source questions got worse.** Small section chunks mean the "overview" chunk no longer ranks for vague questions, and one two-document question (E04) was only half answered.
- **Net answer quality is about the same:** 14 of 16 fully correct instead of 15 of 16, with slightly better faithfulness. With 20 questions and a single run each, a one- or two-question difference cannot be separated from run-to-run variation in the language model.
- I kept the change: an authoritative-looking wrong label is a trust problem, and specific questions are the main use case. Vague questions are now the next problem to solve.

## What went wrong

**Baseline**

1. **Citation labels pointed at the wrong section (20 of 22).** The excerpt was right, but the label was the heading where the *chunk starts*, not where the fact is (for example, backup retention labelled "Cost estimate"). *Fixed in the second run.*
2. **The similarity cutoff does not decide refusals.** Off-topic questions scored 0.70 (the CEO question, which names the product), 0.55 (prompt extraction) and 0.45 (France); every answerable question's best match scored at least 0.58. A cutoff cannot separate "about this product but not documented" from "answerable". The refusals came from the model and the citation check. *Unchanged in the second run (0.75, 0.55, 0.45 against 0.60).*
3. **A paraphrased question missed (E12).** *Fixed in the second run.*
4. **A false claim about the documents (E09).** The baseline said the documents contain nothing about a mobile app; they list it as out of scope. In the second run the claim is accurate (nothing about its framework), but the out-of-scope chunk is no longer retrieved, so the answer is still incomplete.

**Second run (new or still open)**

5. **A two-document question was half answered (E04).** Both source passages were retrieved, but the model said the documents do not state an accuracy target, although the "Success metrics" chunk (rank 4) does. This is a generation failure, not retrieval.
6. **Vague questions regressed (E10).** "Tell me about the project" now returns a faithful but unfocused summary of customer research and never says what the product does. The best overview chunk is not retrieved.
7. **Rate limit hit during the run (E20).** The demo caps each visitor at 40 questions a day; earlier test runs from the same computer used it up, so the last question was refused with HTTP 429. It is recorded as not scored, not as a pass. Re-running the evaluation more than about twice a day from one address will hit this.

What worked in both runs: direct facts, numbers, dates and names; the prompt-extraction question leaked nothing; an off-topic general-knowledge question was refused (baseline).

## How far to trust this

- **Small:** 20 questions on a 3-document corpus. Treat the numbers as a baseline.
- **One run each.** The language model can vary between runs, and neither run was repeated.
- **Not independent.** The questions were written by the builder after reading the documents, and the hand reviews were done by an AI that also helped build the system. Judgment calls are noted in the reviewed files so they can be audited. Automatic scores were changed by hand in a few places (E04, E09, E10, E16), with the reasons recorded.
- **Different corpus granularity between runs** (8 vs 36 chunks), so rank-based numbers are not perfectly like-for-like.
- **Not covered here:** the private workspace, uploads and signing in. Cross-user isolation is tested separately by `scripts/isolation-test.mjs` and `scripts/answer-smoke-test.mjs`.

## Reproduce

```bash
node --env-file=.env.local evals/run-eval.mjs --label my-run                  # about 5 minutes, paced to the demo rate limit
node --env-file=.env.local evals/run-eval.mjs --label my-run --skip-answers   # retrieval only, seconds, no rate limit
node evals/label-accuracy.mjs my-run                                          # section-label accuracy
```

Needs only the public Supabase URL and publishable key in `.env.local`. A full run uses 20 of the demo's 40 daily questions per visitor address. Hand-review files are named `evals/manual-review-<label>.json`; `node evals/apply-review.mjs <label>` merges them into the results.

## Next changes to try, then re-measure

1. **Vague and overview questions.** Options: embed each chunk together with its document title and section path (so a small chunk carries its context), retrieve more chunks, or add a short summary chunk per document.
2. **Multi-source synthesis (E04).** Check whether more context per chunk, or a clearer instruction about combining sources, fixes it.
3. **A way to run the evaluation without the visitor cap**, for example against a dedicated test account's private workspace, so reruns are not blocked.
4. **Grow the corpus.** Rank-based measures are still crude with 36 chunks.
