# Evaluation results: baseline (2026-11-15)

A small, honest evaluation of the public demo. It is a first baseline, not proof of broad reliability. Please read [How far to trust this](#how-far-to-trust-this).

## What was tested

- **System under test:** the live public demo (`workspace: "demo"`), with the settings used in production: search model `bge-small-en-v1.5`, top 5 chunks, similarity cutoff 0.5, chunks of about 350 tokens, answers from `openai/gpt-oss-20b` on Groq.
- **Corpus:** 3 fictional documents about an imaginary product ("Orbit Notes"), split into **8 chunks** in total.
- **Questions:** 20, in [`evals/rag-eval-cases.csv`](../evals/rag-eval-cases.csv). 16 have a clear answer in the documents, 1 is a false-premise question (partial), and 3 should be refused. Categories: direct facts, numbers and dates, two-document questions, conflicting sources, project decisions, detail inside long documents, a paraphrased question that avoids the document's wording, vague questions, off-topic questions, and a prompt-extraction attempt.
- **Gold passages:** each answerable question names text that must appear in a retrieved chunk. This is checked by text, not by chunk ID, so it still works if chunking changes.

## How it was scored

Retrieval and answers are scored **separately**, as in the original blueprint.

| Measurement | How |
|---|---|
| Retrieval | The search function is called directly (top 5, no cutoff) and the gold passage text is looked for in the results. Independent of the generated answer. |
| Correctness (0-2) | Pattern checks for the key facts, then read by hand. |
| Faithfulness (0-2) | Read by hand: is every claim supported by the cited documents? |
| Citation quality (0-2) | Do the cited sources contain the gold passage? |
| Abstention (pass/fail) | Did it refuse when the documents do not contain the answer? |

Rubric: 0 = incorrect, unsupported or missing; 1 = partly correct or incomplete; 2 = correct and supported.

Raw data: [`evals/results/baseline-2026-11-15.json`](../evals/results/baseline-2026-11-15.json). Reviewed scores with a note on every judgment call: [`baseline-2026-11-15-reviewed.csv`](../evals/results/baseline-2026-11-15-reviewed.csv).

## Results

### Retrieval (17 questions with a gold passage)

| Measure | Result |
|---|---|
| Gold passage in the top 5 (Hit@5) | **16 of 17** (94%) |
| Gold passage ranked first | 7 of 17 (41%) |
| Mean reciprocal rank | 0.62 |
| Passage found at rank 1 / 2 / 3 / 4 / 5 / missed | 7 / 5 / 1 / 2 / 1 / 1 |

Hit@5 looks high but is **weak evidence**: the whole corpus is 8 chunks, so the top 5 already covers 62% of it. The rank distribution says more: the right passage was first only 41% of the time.

### Answers

| Measure | Result |
|---|---|
| Answerable questions fully correct | **15 of 16** (average 1.88 out of 2) |
| Faithfulness (17 answerable or partial) | 1.88 out of 2; two answers scored 1 |
| Citation quality (content of the cited excerpt) | 1.76 out of 2 |
| Correct refusals on unanswerable questions | **3 of 3** (CEO, prompt extraction, general knowledge) |

## What went wrong, and what it shows

1. **Citation labels point at the wrong section (20 of 22 checked).** The cited excerpt is correct and users can read it, but the heading shown next to it is the heading where the *chunk starts*, not the section containing the fact. For example, the backup-retention fact is labelled "Cost estimate" instead of "Backups and recovery". This is the clearest defect: a label that looks authoritative but is wrong. Cause: a chunk spans several sections but stores only its first heading.
2. **The similarity cutoff does not decide refusals.** The off-topic questions scored 0.70 (the CEO question, which mentions the product name), 0.55 (prompt extraction) and 0.45 (France). Every answerable question's best match scored at least 0.58. So a cutoff cannot separate "about this product but not in the documents" from "answerable". The three correct refusals came from the model and the citation check, not from retrieval.
3. **A paraphrased question missed entirely (E12).** "What happens if the automatic decision finder is not accurate enough in time?" avoids the document's words ("extraction"). The chunk with the answer was not in the top 5, and the assistant honestly said the documents do not say. Honest, but unhelpful: a retrieval failure, not a model failure.
4. **A false claim about the documents (E09).** Asked for the mobile app's framework, the assistant correctly invented nothing, but said the documents contain no information about a mobile app. They do: the brief lists a mobile app as out of scope. Scored 1, not 2.
5. **Vague questions give faithful but unfocused answers.** "Tell me about the project" returned a long list of budget, hiring and metrics. Every claim checked out, but it is not a good overview. In the 2-line answer, "for larger workspaces" was a small inference the documents do not state.

What worked: direct facts, numbers, dates and names (all correct); the conflicting beta date was reported as a conflict with both sources cited; the prompt-extraction question leaked nothing.

## How far to trust this

- **Small:** 20 questions and 8 chunks. Treat the numbers as a baseline, not a verdict.
- **One run.** Generated answers can vary between runs; this run was not repeated.
- **Not independent.** The questions were written by the builder after reading the documents, and the hand review was done by an AI that also helped build the system. Every judgment call is noted in the reviewed file, so it can be audited. Two automatic scores were changed by hand (E09, E16), and the reasons are recorded.
- **Not covered here:** the private workspace, uploads, and anyone signing in. Cross-user isolation is tested separately by `scripts/isolation-test.mjs` and `scripts/answer-smoke-test.mjs`.

## Reproduce

```bash
node --env-file=.env.local evals/run-eval.mjs --label my-run            # about 5 minutes (paced to the demo rate limit)
node --env-file=.env.local evals/run-eval.mjs --label my-run --skip-answers   # retrieval only, seconds
```

Needs only the public Supabase URL and publishable key in `.env.local`. Don't use the demo in a browser while it runs, because they share the rate limit.

## Next changes to try, then re-measure

1. Fix the citation labels (store the headings a chunk spans, or label by the best-matching section) and re-count label accuracy.
2. Improve paraphrase retrieval (for example, retrieve more chunks and re-order, or add a keyword match alongside vector search) and re-check E12.
3. Handle vague questions (a document picker or a clarifying follow-up).
4. Grow the corpus. With only 8 chunks, rank-based measures are crude.
