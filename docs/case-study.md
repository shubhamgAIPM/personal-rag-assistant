# Case study: a source-grounded assistant over your own documents

**Live demo:** https://shubhamgaipm.github.io/personal-rag-assistant/ · **Code:** https://github.com/shubhamgAIPM/personal-rag-assistant · **Evaluation:** [evaluation-results.md](evaluation-results.md)

> A small working MVP and a baseline evaluation, not a production system. The goal was to practise defining and shipping an AI product with honest quality checks, not to claim broad reliability.

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

- **Ingestion:** a file is split into chunks of about 350 tokens (by headings, paragraphs and sentences, with a small overlap) and embedded **in the browser** with a small open model. This avoids an embedding API and keeps document text off a third-party embedding service. Cost: the first question downloads about 35 MB.
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

## 6. Evaluation (summary)

20 questions on 3 fictional documents (8 chunks); retrieval and answers scored separately. Full details and caveats are in [evaluation-results.md](evaluation-results.md).

- **Retrieval:** the right passage was in the top 5 for 16 of 17 questions, but ranked first only 41% of the time. Hit@5 is flattered by the tiny corpus.
- **Answers:** 15 of 16 answerable questions fully correct; 3 of 3 refusals correct. Faithfulness averaged 1.88 out of 2.
- **Examples:** the conflicting beta date was reported as a conflict, with both sources cited. A prompt-extraction attempt leaked nothing.
- **Failures:** a paraphrased question missed in retrieval (honest refusal, but unhelpful), and a wrong claim that the documents say nothing about a mobile app (they list it as out of scope).

## 7. Trade-offs

- **Browser embeddings** over an API: cheaper and more private, but a heavy first load and slower for visitors.
- **Rate limits and a global cap** over open access: keeps the free demo alive, but a busy day shows "try again shortly".
- **Read-only demo** over anonymous uploads: far lower abuse risk. Visitor uploads need bot protection first.
- **No reranker or hybrid search:** kept the MVP small, but the paraphrase failure shows what that costs.
- **No LLM-as-judge:** with 20 cases, reading every answer is cheaper and more credible than building and validating a judge.

## 8. What I learned

- **Biggest defect found by testing:** private-workspace answers could cite *demo* documents, because every signed-in user is allowed to read demo rows. The first test passed anyway, because it did not inspect which sources were cited. Printing the sources revealed it. Fix: a `scope` argument on the search function, plus database-level and end-to-end tests. Lesson: a test that checks the answer but not its provenance can pass while the product is wrong.
- **Biggest defect found by the evaluation:** citation section labels were wrong 20 times out of 22, because a chunk only stores the heading where it starts. The excerpts were right, so the answers could still be verified, but the label looked authoritative and was misleading. This is the next fix.
- **Smaller lessons:**
  - A similarity cutoff cannot tell "about this product but not documented" from "answerable".
  - A character cap is needed as well as a token cap, since the tokenizer turns long unbroken strings into one token.
  - A "duplicate" check must not let a stuck or failed upload block a retry.
  - A dev server reloading mid-upload looked like a product bug until the logs showed otherwise.

## 9. What I would do next

Fix the citation labels and re-measure; improve retrieval for paraphrased questions; add a document picker or a clarifying question for vague queries; grow the corpus so rank-based measures mean more; then add PDF and GitHub import.
