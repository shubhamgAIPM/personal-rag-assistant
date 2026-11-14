# Personal RAG Assistant

Ask questions about your own documents and get short answers **with the exact source passages** shown next to them. If the documents don't contain the answer, the assistant says so instead of guessing.

> **Status: working MVP, not production software.** It is a portfolio project built to show a small, honest RAG product end to end. See [Known limitations](#known-limitations).

**Live demo:** _coming soon (deployment in progress)_

## What it does

- **Public demo, no sign-in:** ask questions about fictional sample documents (an imaginary product called "Orbit Notes").
- **Private workspace:** sign in, upload your own Markdown or plain-text files, and ask questions about only your documents.
- **Cited answers:** every answer lists the passages it used; expand a source to read it.
- **Honest refusals:** weak or missing evidence gives a "not enough evidence" answer rather than an invention.

## How it works

```text
 Browser (React + Vite)                       Supabase
 ──────────────────────                       ─────────────────────────────
 upload .md/.txt
   → split into chunks
   → embed IN THE BROWSER          ───────►   Postgres + pgvector (chunks, RLS)
     (bge-small-en-v1.5, 384-dim)

 ask a question
   → embed the question            ──────►    Edge Function: answer-question
                                                1. check who is asking (or demo mode)
                                                2. rate limit
                                                3. vector search, limited to the
                                                   caller's allowed chunks (RLS)
                                                4. drop weak matches
                                                5. ask Groq, using only those chunks
                                                6. validate the citations
   ◄── answer + cited sources      ◄──────    returns answer + sources
```

Key design choices:

- **Embeddings run in the browser** (Transformers.js), so there is no embedding API to pay for and document text is not sent to an embedding service. The trade-off: the first question downloads a ~35 MB model.
- **Retrieval happens on the server, as the caller.** The browser sends only a question and its embedding, never chunk text. The database's row-level security decides what can be searched, so access control does not depend on the UI.
- **The Groq API key never reaches the browser.** It lives only in Edge Function secrets.
- **Answers are checked.** The model must return JSON with citations. Unknown citation IDs are dropped, and an answer with no valid citation is replaced by the "not enough evidence" message.

## Privacy and security model

- Row Level Security is on for all data tables. Private rows are readable only by their owner; demo rows are explicitly marked `public_demo`.
- The **private** workspace searches only the signed-in user's own chunks. The **demo** searches only demo chunks, even if the visitor is signed in.
- Demo visitors are rate limited per visitor (a keyed hash of the IP address; raw IPs are never stored) plus a global daily cap, to protect the shared free API quota.
- Text inside documents is treated as untrusted. It is delimited in the prompt, and a planted "ignore your instructions" passage is part of the test suite.
- Only the Supabase **publishable** key is used in the browser. Do not put a service-role or secret key in any `VITE_` variable.
- **Documents you upload are sent to Groq** (as retrieved passages) to write answers. Do not upload anything confidential.

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | React, Vite, TypeScript |
| Auth, database, vector search | Supabase (Auth, Postgres, pgvector) |
| Server logic | Supabase Edge Function (Deno) |
| Embeddings | `Xenova/bge-small-en-v1.5` via Transformers.js, in the browser |
| Answer generation | Groq API (model set by the `GROQ_MODEL` secret) |

## Run it yourself

Use a **non-production** Supabase project. Node.js 22+ is recommended.

1. **Create a Supabase project.** Enable email sign-in. Optionally add `http://localhost:5173` under Authentication → URL Configuration.
2. **Apply the migrations** in order, using the SQL Editor: everything in `supabase/migrations/` that does not end in `_down.sql` (`0001` to `0004`).
3. **Seed the demo** (optional): run `supabase/seed/demo_seed.sql` in the SQL Editor. Regenerate it from `demo-docs/` with `node scripts/generate-demo-seed.mjs`.
4. **Set Edge Function secrets** and deploy (the Supabase CLI is required):
   ```bash
   supabase login
   # Type the key at the prompt so it stays out of your shell history:
   read -s "GROQ_API_KEY?Groq API key: " && supabase secrets set GROQ_API_KEY="$GROQ_API_KEY" --project-ref <project-ref>; unset GROQ_API_KEY
   supabase secrets set GROQ_MODEL=<a Groq model your account can use> --project-ref <project-ref>
   supabase functions deploy answer-question --project-ref <project-ref>
   ```
   Set `ALLOWED_ORIGINS` (comma-separated) to every web address that will call the function.
5. **Configure the frontend.** Copy `.env.example` to `.env.local` and set `VITE_SUPABASE_URL` (the `https://<project-ref>.supabase.co` address) and `VITE_SUPABASE_ANON_KEY` (the publishable key).
6. **Start it:**
   ```bash
   npm install
   npm run dev
   ```

## Tests

| Command | What it checks |
|---|---|
| `node scripts/test-chunker.mjs` | Chunking with the real tokenizer (sizes, overlap, headings, edge cases) |
| `node scripts/test-answer-logic.mjs` | Request validation, prompt building, citation validation |
| `deno check supabase/functions/answer-question/index.ts` | Edge Function type check |
| `node --env-file=.env.local scripts/isolation-test.mjs` | Two-user isolation and search scoping against your Supabase project |
| `node --env-file=.env.local scripts/answer-smoke-test.mjs` | The deployed function end to end, including demo mode, prompt injection and rate limits |

The last two need two throwaway test accounts (`TEST_USER_A_*`, `TEST_USER_B_*` in `.env.local`). They insert and then delete their own test rows, and the smoke test deliberately triggers the rate limits.

## Project layout

```text
src/            React app (components, chunker, embedding worker, ingestion, API client)
supabase/       migrations (with rollback scripts), seed, and the answer-question function
demo-docs/      the fictional sample documents behind the public demo
scripts/        tests and the demo-seed generator
```

## Known limitations

- **Vague questions work poorly.** A question like "explain the project in 2 lines" matches chunks only weakly, and the assistant may still answer from them. A "choose which document" picker or a clarifying follow-up is planned.
- **Only Markdown and plain text** are supported. PDF and GitHub import are not built yet.
- **Visitors cannot upload without signing in.** Anonymous upload needs bot protection first.
- **The "not enough evidence" cutoff is a first guess** (similarity 0.5) and has not been tuned on a real evaluation set. A formal evaluation is not done yet, so no quality numbers are claimed.
- **The first question in a browser downloads the search model** (~35 MB plus a runtime), so it is slow.
- **Free-tier limits apply.** Heavy use of the demo will hit the rate limits and show a "try again shortly" message.
- Chunks are about 300 to 400 tokens with a small overlap; the settings are not tuned.

## Credits

- Embedding model [`BAAI/bge-small-en-v1.5`](https://huggingface.co/BAAI/bge-small-en-v1.5) (MIT licence), converted for the browser as `Xenova/bge-small-en-v1.5`.
- [Transformers.js](https://github.com/huggingface/transformers.js), [Supabase](https://supabase.com), [React](https://react.dev), [Vite](https://vite.dev), and [Groq](https://groq.com).

## Licence

No licence has been chosen yet. Until one is added, all rights are reserved.
