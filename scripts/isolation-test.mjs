// Two-user RLS isolation test for rag_documents / rag_chunks / match_rag_chunks.
//
// Run against a NON-PRODUCTION Supabase project only:
//   node --env-file=.env.local scripts/isolation-test.mjs
//
// Required env vars (put them in the gitignored .env.local, never in code):
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
//   TEST_USER_A_EMAIL, TEST_USER_A_PASSWORD
//   TEST_USER_B_EMAIL, TEST_USER_B_PASSWORD
//
// Uses only the anon key + user sessions. The service-role key is never used.
import { createClient } from "@supabase/supabase-js";

const required = [
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "TEST_USER_A_EMAIL",
  "TEST_USER_A_PASSWORD",
  "TEST_USER_B_EMAIL",
  "TEST_USER_B_PASSWORD",
];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error("Missing env vars:", missing.join(", "));
  process.exit(2);
}

const url = process.env.VITE_SUPABASE_URL;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
const newClient = () =>
  createClient(url, anonKey, { auth: { persistSession: false } });

const DIM = 384;
const vec = Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0));
const vecLiteral = `[${vec.join(",")}]`;

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
};

async function signIn(email, password) {
  const client = newClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Sign-in failed for a test user: ${error.message}`);
  return { client, userId: data.user.id };
}

const A = await signIn(process.env.TEST_USER_A_EMAIL, process.env.TEST_USER_A_PASSWORD);
const B = await signIn(process.env.TEST_USER_B_EMAIL, process.env.TEST_USER_B_PASSWORD);
const anon = newClient();
if (A.userId === B.userId) {
  console.error("Test users A and B must be different accounts.");
  process.exit(2);
}

let docId = null;
try {
  // --- A creates a private document + chunk -------------------------------
  const ins = await A.client
    .from("rag_documents")
    .insert({
      owner_id: A.userId,
      visibility: "private",
      source_type: "upload",
      title: "isolation-test-doc",
      status: "ready",
    })
    .select("id")
    .single();
  check("A can insert own private document", !ins.error && !!ins.data, ins.error?.message);
  docId = ins.data?.id;
  if (!docId) throw new Error("Cannot continue without a document id");

  const chunkIns = await A.client.from("rag_chunks").insert({
    document_id: docId,
    owner_id: A.userId,
    visibility: "private",
    chunk_index: 0,
    content: "isolation test content",
    embedding: vecLiteral,
    embedding_model: "test",
  });
  check("A can insert chunk for own document", !chunkIns.error, chunkIns.error?.message);

  // --- Reads ---------------------------------------------------------------
  const aRead = await A.client.from("rag_documents").select("id").eq("id", docId);
  check("A can read own document", aRead.data?.length === 1);

  const bRead = await B.client.from("rag_documents").select("id").eq("id", docId);
  check("B cannot read A's document", !bRead.error && bRead.data.length === 0);

  const anonRead = await anon.from("rag_documents").select("id").eq("id", docId);
  check("Anonymous cannot read A's document", !anonRead.error && anonRead.data.length === 0);

  const bChunks = await B.client.from("rag_chunks").select("id").eq("document_id", docId);
  check("B cannot read A's chunks", !bChunks.error && bChunks.data.length === 0);

  // --- Writes by B against A's data ---------------------------------------
  await B.client.from("rag_documents").update({ title: "hijacked" }).eq("id", docId);
  const afterUpdate = await A.client.from("rag_documents").select("title").eq("id", docId).single();
  check("B cannot update A's document", afterUpdate.data?.title === "isolation-test-doc");

  await B.client.from("rag_documents").delete().eq("id", docId);
  const afterDelete = await A.client.from("rag_documents").select("id").eq("id", docId);
  check("B cannot delete A's document", afterDelete.data?.length === 1);

  const spoofOwner = await B.client.from("rag_documents").insert({
    owner_id: A.userId,
    visibility: "private",
    source_type: "upload",
    title: "spoofed",
  });
  check("B cannot insert a document owned by A", !!spoofOwner.error);

  const spoofPublic = await B.client.from("rag_documents").insert({
    visibility: "public_demo",
    source_type: "upload",
    title: "fake public",
  });
  check("Clients cannot insert public_demo documents", !!spoofPublic.error);

  const spoofChunk = await B.client.from("rag_chunks").insert({
    document_id: docId,
    owner_id: B.userId,
    visibility: "private",
    chunk_index: 99,
    content: "injected into A's document",
    embedding: vecLiteral,
    embedding_model: "test",
  });
  check("B cannot attach chunks to A's document", !!spoofChunk.error);

  // --- Retrieval function --------------------------------------------------
  const rpcArgs = { query_embedding: vecLiteral, match_count: 5, min_similarity: 0 };
  const aMatch = await A.client.rpc("match_rag_chunks", rpcArgs);
  check(
    "A retrieves own chunk via match_rag_chunks",
    !aMatch.error && aMatch.data.some((r) => r.document_id === docId),
    aMatch.error?.message,
  );
  const aPrivate = await A.client.rpc("match_rag_chunks", { ...rpcArgs, scope: "private" });
  check("scope=private still returns A's own chunk", !aPrivate.error && aPrivate.data.some((r) => r.document_id === docId), aPrivate.error?.message);
  const aDemoScope = await A.client.rpc("match_rag_chunks", { ...rpcArgs, scope: "public_demo" });
  check("scope=public_demo never returns A's private chunk", !aDemoScope.error && !aDemoScope.data.some((r) => r.document_id === docId), aDemoScope.error?.message);
  const ownDocs = await A.client.from("rag_documents").select("id").eq("visibility", "private").eq("owner_id", A.userId);
  const ownIds = new Set((ownDocs.data ?? []).map((d) => d.id));
  check(
    "scope=private returns only the caller's own private documents (no public demo)",
    !aPrivate.error && aPrivate.data.length > 0 && aPrivate.data.every((r) => ownIds.has(r.document_id)),
    aPrivate.error?.message,
  );
  const anonPrivate = await anon.rpc("match_rag_chunks", { ...rpcArgs, scope: "private" });
  check("anonymous scope=private returns nothing", !anonPrivate.error && anonPrivate.data.length === 0, anonPrivate.error?.message);
  const badScope = await A.client.rpc("match_rag_chunks", { ...rpcArgs, scope: "bogus" });
  check("unknown scope returns nothing", !badScope.error && badScope.data.length === 0, badScope.error?.message);
  const bMatch = await B.client.rpc("match_rag_chunks", rpcArgs);
  check(
    "B's retrieval never returns A's chunk",
    !bMatch.error && !bMatch.data.some((r) => r.document_id === docId),
    bMatch.error?.message,
  );
  const anonMatch = await anon.rpc("match_rag_chunks", rpcArgs);
  check(
    "Anonymous retrieval never returns A's chunk",
    !anonMatch.error && !anonMatch.data.some((r) => r.document_id === docId),
    anonMatch.error?.message,
  );
} finally {
  if (docId) {
    const del = await A.client.from("rag_documents").delete().eq("id", docId);
    console.log(del.error ? `Cleanup failed: ${del.error.message}` : "Cleanup: test document removed (chunks cascade).");
  }
}

console.log(failures === 0 ? "\nAll isolation checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
