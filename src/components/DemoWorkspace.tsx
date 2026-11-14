import { useEffect, useState } from "react";
import { listDocuments, type DocumentRow } from "../lib/documents.ts";
import { ChatPanel } from "./ChatPanel.tsx";

/** Read-only public demo: sample documents that anyone can ask questions about, no sign-in. */
export function DemoWorkspace() {
  const [docs, setDocs] = useState<DocumentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listDocuments("public_demo")
      .then((rows) => !cancelled && setDocs(rows))
      .catch(() => !cancelled && setError("Could not load the demo documents."));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <section className="card">
        <h2>Try the public demo</h2>
        <p className="hint">
          These are fictional sample documents about an imaginary product called Orbit Notes. Ask a question about
          them and see the answer with its sources. No sign-in needed. Sign in to use your own private documents.
        </p>
        <p className="hint">
          Try: &ldquo;When is the private beta?&rdquo;, &ldquo;How much does the team plan cost?&rdquo; or
          &ldquo;Why was PostgreSQL chosen?&rdquo;
        </p>
      </section>

      <ChatPanel workspace="demo" hasReadyDocs={docs?.some((d) => d.status === "ready") ?? false} />

      <section className="card">
        <h2>Demo documents</h2>
        {error && (
          <p role="alert" className="msg error">
            {error}
          </p>
        )}
        {docs === null && !error && <p className="hint">Loading…</p>}
        {docs?.length === 0 && <p className="hint">No demo documents have been added yet.</p>}
        {docs && docs.length > 0 && (
          <ul className="docs">
            {docs.map((d) => (
              <li key={d.id}>
                <div className="doc-main">
                  <span className="doc-title">{d.title}</span>
                  <span className="doc-meta">sample document</span>
                </div>
                <span className={`status ${d.status}`}>{d.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
