# Case study: a source-grounded assistant over your own documents

**Version 1 · 15 November 2026** · **Live demo:** https://shubhamgaipm.github.io/personal-rag-assistant/ · **Code:** https://github.com/shubhamgAIPM/personal-rag-assistant · **Full evaluation:** [evaluation-results.md](evaluation-results.md)

> A small working MVP with a baseline evaluation, not a production system. The goal was to practise defining and shipping an AI product with honest quality checks, not to claim broad reliability. This is version 1; the open problems are listed at the end and will be tackled in later versions.

## In one minute

I built an assistant that answers questions about your documents and shows the exact passages it used, so you can verify any answer in seconds. If the documents don't contain the answer, it says so. A public demo needs no sign-in; a private workspace lets you upload your own files.

I then measured it with 20 questions, scoring search and answers separately. The evaluation found a real defect (wrong citation labels), I fixed it and re-measured, and the re-measurement showed the fix also had a cost. This write-up includes both runs, the fix that didn't work as I predicted, and what I'm still unsure about.

## Results at a glance

| Measure | Before (baseline) | After (current) | Notes |
|---|---|---|---|
| **Citation section labels correct** | **9%** (2 of 22) | **100%** (17 of 17 cited; 20 of 20 retrieved) | Fixed by keeping each chunk inside one section |
| Right passage ranked first | 41% (7 of 17) | 65% (11 of 17) | Retrieval only |
| Mean reciprocal rank | 0.62 | 0.73 | Retrieval only; higher is better |
| Right passage in top 5 | 94% (16 of 17) | 82% (14 of 17) | The baseline figure was flattered by an 8-chunk corpus; the current corpus has 36 chunks |
| Answerable questions fully correct | 15 of 16 | 14 of 16 | Within noise at this sample size |
| Faithfulness (0-2) | 1.88 | 1.94 | Hand-reviewed |
| Correct refusals | 3 of 3 | 2 of 2 scored | One question was rate limited and is recorded as not scored |
| **Vague questions** ("tell me about the project") | Unfocused but grounded | **Worse, not fixed** | The open problem for version 2 |

How to read this: the "After" retrieval numbers come from the latest run (chunks kept in one section, each embedded with its section path). The answer-level numbers (fully correct, faithfulness, refusals) come from the previous run, because the demo's daily question limit was used up before the latest run could ask questions. The effect of the latest change (the section-path embedding) on actual answers has therefore not been measured yet. See the [evaluation](evaluation-results.md) for exactly which run each number is from.

## 1. Problem

Project knowledge lives in specs, notes and architecture documents. Finding the right passage takes time, and a generic chat answer is hard to trust because you cannot tell where it came from. The product question: *can an assistant answer quickly and also make verification easy?*

## 2. User and use case

A product manager or project contributor with a small set of project documents who asks things like "when is the beta?", "why did we choose this database?" or "what did we decide about pricing?", and wants to confirm the answer in the source in seconds.

## 3. MVP decisions

| Included | Why |
|---|---|
| Cited answers with readable source excerpts | Trust comes from being able to check. This is the core of the product. |
| An honest "not enough evidence" answer | A wrong confident answer is worse than no answer. |
| Public demo with no sign-in | Anyone, including a reviewer, can try it in seconds. |
| Private workspace with upload | Shows the real use case and forces proper access control. |

Deliberately left out: private GitHub access, scheduled syncing, web search, rerankers, hybrid search, agents, multiple models, an evaluation dashboard. PDF upload and GitHub import were planned but are not built; they would add surface area without changing what the product proves.

## 4. Architecture

- **Ingestion:** a file is split into chunks (a new chunk starts at every heading, so a chunk never spans two sections; long sections are split at about 350 tokens with a small overlap) and embedded **in the browser** with a small open model, together with its section path. This avoids an embedding API and keeps document text off a third-party embedding service. Cost: the first question downloads about 35 MB.
- **Retrieval:** a vector search in Postgres (pgvector), run **on the server as the asking user**, so database row-level security decides what can be searched.
- **Generation:** a Supabase Edge Function sends the top chunks to a Groq-hosted model with a strict "use only these sources" prompt and requires structured output.
- **Authorization:** private rows are readable only by their owner; demo rows are explicitly marked. The private workspace searches only your own chunks, and the demo only demo chunks.

## 5. Trust and safety

- **Grounding:** answers must use only the supplied excerpts and cite them.
- **Citation validation:** unknown citation IDs are dropped; an answer with no valid citation is replaced by the no-evidence message.
- **Abstention:** weak matches never reach the model, and the model may refuse.
- **Untrusted text:** document content is delimited in the prompt and cannot forge the delimiters. A planted "ignore previous instructions" passage is part of the test suite and was ignored.
- **Isolation:** a two-user test checks that one user cannot read, change or retrieve another's data, and that the demo never exposes private documents.
- **Secrets:** the Groq key lives only in server-side secrets; the browser holds only the public publishable key.
- **Abuse limits:** per-user and per-visitor rate limits plus a global daily cap protect the shared free API quota. The service-role key is used for exactly one thing, counting demo usage.

## 6. Evaluation

20 questions on 3 fictional documents; search and answers scored separately; three runs. Full details and caveats are in [evaluation-results.md](evaluation-results.md).

- **Baseline:** 15 of 16 answerable questions fully correct and 3 of 3 refusals correct. The right passage was in the top 5 for 16 of 17 questions, but first only 41% of the time.
- **The defect it found:** citation section labels were wrong 20 times out of 22. The quoted excerpt was right, but the heading beside it was not, which looks authoritative and is misleading.
- **Run 2, the fix** (chunks stay inside one section, labelled with the heading path): labels went from 9% to 100% correct, the right passage was first 59% of the time, and a paraphrased question that had failed now worked. The cost: vague "overview" questions got worse and one two-document question was only half answered. Net answer quality was about the same.
- **Run 3** (each chunk embedded with its section path; search only): a small further gain on specific questions (first 65%, mean reciprocal rank 0.73) and no regressions. It did **not** fix vague questions, contrary to my prediction.
- **Examples that worked:** a date that conflicts between two documents was reported as a conflict with both sources cited; a prompt-extraction attempt leaked nothing; an off-topic question was refused.

## 7. Trade-offs

- **Browser embeddings** over an API: cheaper and more private, but a heavy first load and slower for visitors.
- **Rate limits and a global cap** over open access: keeps the free demo alive, but a busy day shows "try again shortly". It also limited my own evaluation reruns.
- **Read-only demo** over anonymous uploads: far lower abuse risk. Visitor uploads need bot protection first.
- **No reranker or hybrid search:** kept the MVP small, but the paraphrase failure shows what that costs.
- **No LLM-as-judge:** with 20 cases, reading every answer is cheaper and more credible than building and validating a judge.
- **Smaller section chunks:** accurate labels and better specific-question retrieval, at the cost of weaker overview questions.

## 8. What I learned

- **A defect found by testing:** private-workspace answers could cite *demo* documents, because every signed-in user is allowed to read demo rows. The first test passed anyway, because it did not inspect which sources were cited. Printing the sources revealed it. Fix: a `scope` argument on the search function, plus database-level and end-to-end tests. Lesson: a test that checks the answer but not its provenance can pass while the product is wrong.
- **A defect found by the evaluation, and the change it led to:** citation labels were wrong 20 times out of 22, because a chunk stored only the heading where it started. The fix was to start a new chunk at every heading and label it with the full heading path. Re-measuring showed the labels at 100%, but also that smaller chunks hurt vague questions. A fix that improves one measure can cost another, so every change gets re-measured.
- **A prediction that was wrong:** I expected embedding each chunk with its section path to fix vague questions. It helped specific questions slightly but not vague ones. Inspecting the top 10 showed why: for "tell me about the project" every chunk scores about the same, so there is nothing to rank. I also checked whether flat scores could flag vague questions automatically; they could not, because some correct specific questions are just as flat, and a cutoff chosen from 20 questions would only be fitting the test. Vague questions need a product decision, not a better embedding.
- **An honest limit of the measurement itself:** my own earlier test runs used up the demo's daily question cap, so one evaluation question could not be run. I recorded it as not scored instead of assuming it passed.
- **Smaller lessons:**
  - A similarity cutoff cannot tell "about this product but not documented" from "answerable".
  - A character cap is needed as well as a token cap, since the tokenizer turns long unbroken strings into one token.
  - A "duplicate" check must not let a stuck or failed upload block a retry.
  - A dev server reloading mid-upload looked like a product bug until the logs showed otherwise.

## 9. Known limitations in version 1

- **Vague questions** ("tell me about the project") return a faithful but unfocused answer, or miss the overview.
- **A question that needs two sources** can be half answered (seen once).
- **The evaluation is small:** 20 questions on 3 fictional documents (36 chunks), one run each, questions written by the builder, and hand review done by an AI that also helped build the system. Treat the numbers as a baseline.
- Only Markdown and plain text are supported; PDF and GitHub import are not built. Visitors cannot upload without signing in.
- The "not enough evidence" similarity cutoff cannot decide refusals on its own; refusals currently depend on the model and the citation check.

## 10. Version 2: the plan

**Chosen approach for vague questions:** keep it cheap and avoid over-engineering. Tell the model, in the prompt, to ask which topic or document the user means when a question is too broad to answer from the excerpts, and give it the titles of the documents it was shown.

**Success criteria, written down before building:**

1. On the 2 vague questions, the answer asks what the user means (or gives a focused overview) instead of an unfocused summary.
2. No regression on the specific questions: every question that was fully correct stays fully correct.
3. Refusals stay correct.
4. Measured with the same 20 questions, the same scoring, and the demo's daily limit respected.

If the prompt-only approach does not meet these, the fallback is a document picker with an overview mode.

**Also next:** look at multi-source questions; make the evaluation runnable without the visitor cap; grow the corpus so rank-based measures mean more; then add PDF and GitHub import.
