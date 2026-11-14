import { useState, type FormEvent } from "react";
import { AskError, askQuestion, type Answer, type AskStage } from "../lib/ask.ts";

const MAX_QUESTION_CHARS = 1000;

const STAGE_LABEL: Record<AskStage, string> = {
  embedding: "Preparing your question (the first time loads the model)…",
  searching: "Searching your documents and writing an answer…",
};

export function ChatPanel({ hasReadyDocs }: { hasReadyDocs: boolean }) {
  const [question, setQuestion] = useState("");
  const [stage, setStage] = useState<AskStage | null>(null);
  const [result, setResult] = useState<{ asked: string; answer: Answer } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = stage !== null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    setError(null);
    setResult(null);
    setStage("embedding");
    try {
      setResult({ asked: q, answer: await askQuestion(q, setStage) });
    } catch (err) {
      setError(err instanceof AskError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setStage(null);
    }
  };

  return (
    <section className="card">
      <h2>Ask a question</h2>
      {!hasReadyDocs ? (
        <p className="hint">Upload a document and wait for it to be ready, then ask questions about it here.</p>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="ask">
          <label>
            Your question
            <textarea
              rows={3}
              maxLength={MAX_QUESTION_CHARS}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              disabled={busy}
              placeholder="e.g. What did we decide about the chunk size?"
            />
          </label>
          <button type="submit" disabled={busy || question.trim().length === 0}>
            {busy ? "Working…" : "Ask"}
          </button>
        </form>
      )}

      {busy && stage && (
        <p role="status" className="msg">
          {STAGE_LABEL[stage]}
        </p>
      )}
      {error && (
        <p role="alert" className="msg error">
          {error}
        </p>
      )}

      {result && (
        <div className="result" aria-live="polite">
          <p className="asked">Q: {result.asked}</p>
          {result.answer.insufficient_evidence && <span className="badge warn">Not enough evidence</span>}
          {/* Rendered as plain text: React escapes it, so model or document text cannot inject markup. */}
          <p className="answer">{result.answer.answer}</p>
          {result.answer.sources.length > 0 && (
            <div className="sources">
              <h3>Sources</h3>
              {result.answer.sources.map((s) => (
                <details key={s.chunk_id}>
                  <summary>
                    <strong>[{s.ref}]</strong> {s.title}
                    {s.locator ? ` — ${s.locator}` : ""}
                  </summary>
                  <blockquote>{s.excerpt}</blockquote>
                </details>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
