import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { deleteDocument, listDocuments, type DocumentRow } from "../lib/documents.ts";
import { ChatPanel } from "./ChatPanel.tsx";
import { IngestError, ingestFile, MAX_FILE_BYTES, STALE_PROCESSING_MS, type IngestStage } from "../lib/ingest.ts";

const STAGE_LABEL: Record<IngestStage, string> = {
  validating: "Checking file…",
  "loading-model": "Loading embedding model (first time can take a minute)…",
  chunking: "Splitting into chunks…",
  embedding: "Embedding chunks",
  saving: "Saving",
  done: "Done",
};

export function Workspace({ session }: { session: Session }) {
  const [docs, setDocs] = useState<DocumentRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadOk, setUploadOk] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploading = progress !== null;

  const refresh = useCallback(async () => {
    try {
      setDocs(await listDocuments());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load your documents.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setUploadError(null);
    setUploadOk(null);
    setProgress(STAGE_LABEL.validating);
    try {
      await ingestFile(file, session.user.id, (stage, done, total) => {
        const base = STAGE_LABEL[stage];
        setProgress(total ? `${base} ${done ?? 0}/${total}` : base);
      });
      setUploadOk(`"${file.name}" is ready to search.`);
    } catch (e) {
      setUploadError(e instanceof IngestError || (e instanceof Error && e.message.startsWith("Embedding")) ? e.message : "Upload failed. Please try again.");
    } finally {
      setProgress(null);
      if (fileInput.current) fileInput.current.value = "";
      void refresh();
    }
  };

  const onDelete = async (doc: DocumentRow) => {
    if (!window.confirm(`Delete "${doc.title}" and all its chunks? This cannot be undone.`)) return;
    try {
      await deleteDocument(doc.id);
      await refresh();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not delete the document.");
    }
  };

  return (
    <>
      <section className="card">
        <h2>Add a document</h2>
        <p className="hint">
          Markdown or plain text, up to {MAX_FILE_BYTES / 1_000_000} MB. Text is embedded in your browser; your file
          contents are stored in your private workspace. Keep this tab open while a file is processing.
        </p>
        <input
          ref={fileInput}
          type="file"
          accept=".md,.txt,text/markdown,text/plain"
          disabled={uploading}
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        {uploading && (
          <p role="status" className="msg">
            {progress}
          </p>
        )}
        {uploadError && (
          <p role="alert" className="msg error">
            {uploadError}
          </p>
        )}
        {uploadOk && (
          <p role="status" className="msg ok">
            {uploadOk}
          </p>
        )}
      </section>

      <ChatPanel workspace="private" hasReadyDocs={docs?.some((d) => d.status === "ready") ?? false} />

      <section className="card">
        <h2>Your documents</h2>
        {loadError && (
          <p role="alert" className="msg error">
            {loadError}
          </p>
        )}
        {docs === null && !loadError && <p className="hint">Loading…</p>}
        {docs?.length === 0 && <p className="hint">No documents yet. Upload a .md or .txt file to get started.</p>}
        {docs && docs.length > 0 && (
          <ul className="docs">
            {docs.map((d) => (
              <li key={d.id}>
                <div className="doc-main">
                  <span className="doc-title">{d.title}</span>
                  <span className="doc-meta">
                    {d.source_type} · {new Date(d.created_at).toLocaleString()}
                  </span>
                  {d.status === "failed" && d.error_message && <span className="doc-meta error">{d.error_message}</span>}
                </div>
                {d.status === "processing" && Date.now() - new Date(d.created_at).getTime() > STALE_PROCESSING_MS ? (
                  <span className="status failed" title="Processing was interrupted (the tab was probably closed). Delete it and upload again.">
                    stalled
                  </span>
                ) : (
                  <span className={`status ${d.status}`}>{d.status}</span>
                )}
                <button className="link danger" onClick={() => void onDelete(d)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
