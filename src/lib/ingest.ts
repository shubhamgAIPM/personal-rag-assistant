import { embedDocument, type EmbedStage } from "./embedder.ts";
import { EMBEDDING_MODEL_LABEL } from "./embeddingConfig.ts";
import { supabase } from "./supabase.ts";

export const MAX_FILE_BYTES = 1_000_000; // 1 MB
export const SUPPORTED_EXTENSIONS = [".md", ".txt"] as const;
const INSERT_BATCH = 40;
/** A row still "processing" after this long is treated as orphaned (tab closed or crashed). */
export const STALE_PROCESSING_MS = 5 * 60 * 1000;

/** An error whose message is safe to show to the user. */
export class IngestError extends Error {}

export type IngestStage = "validating" | EmbedStage | "saving" | "done";
export type StageHandler = (stage: IngestStage, done?: number, total?: number) => void;

export function validateFile(file: { name: string; size: number }): void {
  const lower = file.name.toLowerCase();
  if (!SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    throw new IngestError("Unsupported file type. Upload a .md or .txt file (PDF support is coming).");
  }
  if (file.size === 0) throw new IngestError("The file is empty.");
  if (file.size > MAX_FILE_BYTES) {
    throw new IngestError(`The file is too large. The limit is ${MAX_FILE_BYTES / 1_000_000} MB.`);
  }
}

/** Decode as strict UTF-8 and reject binary content, regardless of file extension. */
export function decodeText(bytes: ArrayBuffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new IngestError("The file is not valid UTF-8 text.");
  }
  if (text.includes("\u0000")) throw new IngestError("The file looks like binary data, not text.");
  if (!text.trim()) throw new IngestError("The file has no text content.");
  return text;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function ingestFile(file: File, userId: string, onStage: StageHandler): Promise<string> {
  onStage("validating");
  validateFile(file);
  const text = decodeText(await file.arrayBuffer());
  const contentHash = await sha256Hex(text);

  // RLS already limits this query to the caller's own documents.
  const dup = await supabase
    .from("rag_documents")
    .select("id,title,status,created_at")
    .eq("content_hash", contentHash);
  if (dup.error) throw new IngestError("Could not check for duplicates. Please try again.");

  const now = Date.now();
  for (const d of dup.data) {
    if (d.status === "ready") {
      throw new IngestError(`This content was already uploaded as "${d.title}".`);
    }
    const ageMs = now - new Date(d.created_at).getTime();
    if (d.status !== "failed" && ageMs < STALE_PROCESSING_MS) {
      throw new IngestError(`"${d.title}" is still being processed. Wait for it to finish, or delete it to retry.`);
    }
  }
  // Remaining matches are failed or stale (e.g. the tab was closed mid-upload): clear them so the retry can proceed.
  const stale = dup.data.map((d) => d.id);
  if (stale.length > 0) {
    const cleared = await supabase.from("rag_documents").delete().in("id", stale);
    if (cleared.error) throw new IngestError("Could not clear an earlier failed upload. Delete it and try again.");
  }

  const inserted = await supabase
    .from("rag_documents")
    .insert({
      owner_id: userId,
      visibility: "private",
      source_type: "upload",
      title: file.name.slice(0, 300),
      content_hash: contentHash,
      status: "processing",
    })
    .select("id")
    .single();
  if (inserted.error || !inserted.data) throw new IngestError("Could not create the document. Please try again.");
  const documentId = inserted.data.id as string;

  const fail = async (message: string): Promise<never> => {
    // Best effort cleanup: remove partial chunks and record the failure.
    await supabase.from("rag_chunks").delete().eq("document_id", documentId);
    await supabase.from("rag_documents").update({ status: "failed", error_message: message }).eq("id", documentId);
    throw new IngestError(message);
  };

  try {
    const chunks = await embedDocument(text, (stage, done, total) => onStage(stage, done, total));
    if (chunks.length === 0) return await fail("No text could be extracted from this file.");

    onStage("saving", 0, chunks.length);
    for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
      const rows = chunks.slice(i, i + INSERT_BATCH).map((c) => ({
        document_id: documentId,
        owner_id: userId,
        visibility: "private",
        chunk_index: c.index,
        content: c.content,
        embedding: `[${c.embedding.join(",")}]`,
        embedding_model: EMBEDDING_MODEL_LABEL,
        source_locator: c.locator,
      }));
      const { error } = await supabase.from("rag_chunks").insert(rows);
      if (error) {
        console.error("chunk insert failed", error.code);
        return await fail("Saving the document failed. Please try again.");
      }
      onStage("saving", Math.min(i + INSERT_BATCH, chunks.length), chunks.length);
    }

    const done = await supabase
      .from("rag_documents")
      .update({ status: "ready", error_message: null, updated_at: new Date().toISOString() })
      .eq("id", documentId);
    if (done.error) return await fail("Could not finish processing the document.");
    onStage("done");
    return documentId;
  } catch (e) {
    if (e instanceof IngestError) throw e;
    console.error("ingest failed", e);
    return await fail(e instanceof Error && e.message.startsWith("Embedding") ? e.message : "Unexpected error while processing this file.");
  }
}
