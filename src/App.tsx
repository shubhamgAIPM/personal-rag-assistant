import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { AuthForm } from "./components/AuthForm.tsx";
import { Workspace } from "./components/Workspace.tsx";
import { supabase } from "./lib/supabase.ts";
import "./App.css";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setChecking(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  if (checking) return <main className="page"><p className="hint">Loading…</p></main>;

  return (
    <main className="page">
      {session ? (
        <Workspace key={session.user.id} session={session} />
      ) : (
        <>
          <header className="topbar">
            <div>
              <h1>Personal RAG Assistant</h1>
              <p className="tagline">Ask questions about your project knowledge and get source-grounded answers.</p>
            </div>
          </header>
          <AuthForm />
        </>
      )}
    </main>
  );
}
