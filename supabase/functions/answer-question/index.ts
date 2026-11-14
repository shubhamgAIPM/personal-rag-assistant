// answer-question: retrieval + grounded generation, entirely server-side.
//
// Two modes, chosen by the request's `workspace` field:
//   "private" (default): the caller must be signed in. Retrieval runs AS THE CALLER
//       (anon key + their Authorization header), so Postgres RLS limits it to
//       their own chunks.
//   "demo": no sign-in needed. Retrieval runs with the anon key and NO user
//       token, so RLS only exposes rows marked public_demo, even if the caller
//       happens to be signed in.
//
// Security properties:
//  - verify_jwt is off in config.toml (anonymous demo visitors have no JWT), so
//    this function does its own checks: private mode verifies the JWT with
//    auth.getUser(); demo mode is rate limited per (keyed-hash of) IP plus a
//    global daily cap.
//  - The service-role key is used for ONE thing only: calling the demo quota
//    function, which only service_role may execute. It is never used to read
//    documents or chunks.
//  - The client sends only a question and a query embedding, never chunk text.
//  - The Groq API key lives only in Edge Function secrets.
//  - Model output is validated: unknown citations are dropped, and an answer
//    with no valid citation is replaced by the no-evidence message.
//  - Logs contain status codes and counts only: no questions, chunk text, IPs or keys.
//
// Required secrets:  GROQ_API_KEY, GROQ_MODEL
// Optional:          ALLOWED_ORIGINS (comma separated), MIN_SIMILARITY (default 0.5)
// Provided by Supabase automatically: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  NO_EVIDENCE_MESSAGE,
  RequestError,
  SYSTEM_PROMPT,
  buildUserPrompt,
  clientIpFrom,
  groqModelParams,
  parseModelOutput,
  resolveAnswer,
  validateRequest,
  type PromptChunk,
} from "./logic.ts";

const TOP_K = 5;
const MAX_BODY_BYTES = 32_000;
const GROQ_TIMEOUT_MS = 25_000;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") ?? "http://localhost:5173,http://localhost:5174")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
  if (origin && allowedOrigins.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function respond(req: Request, status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json", ...extra },
  });
}

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, ...fields }));

interface MatchRow {
  id: string;
  document_id: string;
  title: string;
  source_locator: string | null;
  content: string;
  similarity: number;
}

/** Keyed hash of the visitor IP (HMAC-SHA-256, hex). The raw IP is never stored or logged. */
async function hashClient(ip: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(ip));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

const authOpts = { persistSession: false, autoRefreshToken: false };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return respond(req, 405, { error: "Method not allowed." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) {
    log("config_error", { missing: "supabase_env" });
    return respond(req, 500, { error: "Service is not configured." });
  }

  // --- validate input (cheap, before any database work) --------------------
  let question: string;
  let embedding: number[];
  let workspace: "demo" | "private";
  try {
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) throw new RequestError("Request too large.", 413);
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) throw new RequestError("Request too large.", 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new RequestError("Invalid JSON.");
    }
    ({ question, embedding, workspace } = validateRequest(body));
  } catch (e) {
    if (e instanceof RequestError) return respond(req, e.status, { error: e.message });
    return respond(req, 400, { error: "Invalid request." });
  }

  // --- identify caller, enforce rate limit, pick the retrieval client -------
  let retrieval: SupabaseClient;

  if (workspace === "private") {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return respond(req, 401, { error: "Please sign in." });

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: authOpts,
    });
    const { data: userData, error: userError } = await userClient.auth.getUser(authHeader.slice(7));
    if (userError || !userData.user) return respond(req, 401, { error: "Please sign in again." });

    const quota = await userClient.rpc("rag_consume_quota");
    if (quota.error) {
      log("quota_error", { mode: "private", code: quota.error.code });
      return respond(req, 500, { error: "Something went wrong. Please try again." });
    }
    if (quota.data !== true) {
      log("rate_limited", { mode: "private" });
      return respond(req, 429, { error: "Too many questions right now. Please wait a minute and try again." }, { "Retry-After": "60" });
    }
    retrieval = userClient; // RLS: the caller's own documents only
  } else {
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!serviceKey) {
      log("config_error", { missing: "service_role" });
      return respond(req, 500, { error: "Service is not configured." });
    }
    const clientHash = await hashClient(clientIpFrom(req.headers), serviceKey);
    // Service-role client is used ONLY for this quota call.
    const quotaClient = createClient(supabaseUrl, serviceKey, { auth: authOpts });
    const quota = await quotaClient.rpc("rag_consume_demo_quota", { client_hash: clientHash });
    if (quota.error) {
      log("quota_error", { mode: "demo", code: quota.error.code });
      return respond(req, 500, { error: "Something went wrong. Please try again." });
    }
    if (quota.data !== true) {
      log("rate_limited", { mode: "demo" });
      return respond(req, 429, { error: "The demo is getting a lot of use. Please wait a minute and try again." }, { "Retry-After": "60" });
    }
    // Anon key with NO user token: RLS exposes public_demo rows only.
    retrieval = createClient(supabaseUrl, anonKey, { auth: authOpts });
  }

  // --- retrieve (RLS-scoped) -----------------------------------------------
  const minSimilarity = Number(Deno.env.get("MIN_SIMILARITY") ?? "0.5");
  const match = await retrieval.rpc("match_rag_chunks", {
    query_embedding: `[${embedding.join(",")}]`,
    match_count: TOP_K,
    min_similarity: Number.isFinite(minSimilarity) ? minSimilarity : 0.5,
  });
  if (match.error) {
    log("retrieval_error", { mode: workspace, code: match.error.code });
    return respond(req, 500, { error: "Search failed. Please try again." });
  }
  const rows = (match.data ?? []) as MatchRow[];
  log("retrieved", { mode: workspace, count: rows.length });

  if (rows.length === 0) {
    // Nothing relevant enough: abstain without calling the model.
    return respond(req, 200, { answer: NO_EVIDENCE_MESSAGE, insufficient_evidence: true, sources: [] });
  }

  // --- generate -----------------------------------------------------------
  const groqKey = Deno.env.get("GROQ_API_KEY");
  const groqModel = Deno.env.get("GROQ_MODEL");
  if (!groqKey || !groqModel) {
    log("config_error", { missing: "groq_secret" });
    return respond(req, 500, { error: "Service is not configured." });
  }

  const promptChunks: PromptChunk[] = rows.map((r, i) => ({
    ref: `S${i + 1}`,
    title: r.title,
    locator: r.source_locator,
    content: r.content,
  }));
  const byRef = new Map(promptChunks.map((c, i) => [c.ref, rows[i]]));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
  let groqRes: Response;
  try {
    groqRes = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${groqKey}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: groqModel,
        temperature: 0,
        ...groqModelParams(groqModel),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(question, promptChunks) },
        ],
      }),
    });
  } catch (e) {
    log("groq_unreachable", { aborted: e instanceof DOMException && e.name === "AbortError" });
    return respond(req, 502, { error: "The answer service did not respond. Please try again." });
  } finally {
    clearTimeout(timer);
  }

  if (groqRes.status === 429) {
    const retryAfter = Math.min(Math.max(Number(groqRes.headers.get("retry-after")) || 30, 1), 120);
    log("groq_rate_limited");
    return respond(req, 429, { error: "The answer service is busy. Please try again shortly." }, { "Retry-After": String(retryAfter) });
  }
  if (!groqRes.ok) {
    log("groq_error", { status: groqRes.status });
    return respond(req, 502, { error: "The answer service returned an error. Please try again." });
  }

  let content = "";
  try {
    const data = await groqRes.json();
    content = data?.choices?.[0]?.message?.content ?? "";
  } catch {
    log("groq_bad_body");
  }

  // --- validate the model's output ----------------------------------------
  const final = resolveAnswer(parseModelOutput(content), new Set(byRef.keys()));
  if (final.override) log("answer_overridden", { reason: final.override });

  const sources = final.citations.map((ref) => {
    const r = byRef.get(ref)!;
    return {
      ref,
      chunk_id: r.id,
      document_id: r.document_id,
      title: r.title,
      locator: r.source_locator,
      excerpt: r.content,
      similarity: r.similarity,
    };
  });

  return respond(req, 200, {
    answer: final.answer,
    insufficient_evidence: final.insufficient_evidence,
    sources,
  });
});
