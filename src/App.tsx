import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { AuthForm } from "./components/AuthForm.tsx";
import { DemoWorkspace } from "./components/DemoWorkspace.tsx";
import { Workspace } from "./components/Workspace.tsx";
import { supabase } from "./lib/supabase.ts";
import "./App.css";

type View = "demo" | "private";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [view, setView] = useState<View>("demo");

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setChecking(false);
    });
    let lastUserId: string | null | undefined; // undefined until the first event
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      const userId = next?.user.id ?? null;
      // Switch tabs only when the signed-in user actually changes (sign-in or sign-out).
      // Token refreshes and tab-focus re-checks fire this event too and must not move the user.
      if (lastUserId !== undefined && userId !== lastUserId) setView(userId ? "private" : "demo");
      lastUserId = userId;
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (checking) {
    return (
      <main className="page">
        <p className="hint">Loading…</p>
      </main>
    );
  }

  return (
    <main className="page">
      <header className="topbar">
        <div>
          <h1>Personal RAG Assistant</h1>
          <p className="tagline">Ask questions about your project knowledge and get source-grounded answers.</p>
        </div>
        {session && (
          <div className="who">
            <span className="email">{session.user.email}</span>
            <button className="link" onClick={() => void supabase.auth.signOut()}>
              Sign out
            </button>
          </div>
        )}
      </header>

      <nav className="tabs" aria-label="Workspace">
        <button className={view === "demo" ? "tab active" : "tab"} aria-pressed={view === "demo"} onClick={() => setView("demo")}>
          Public demo
        </button>
        <button className={view === "private" ? "tab active" : "tab"} aria-pressed={view === "private"} onClick={() => setView("private")}>
          {session ? "My private workspace" : "Sign in"}
        </button>
      </nav>

      {view === "demo" && <DemoWorkspace />}
      {view === "private" && (session ? <Workspace key={session.user.id} session={session} /> : <AuthForm />)}
    </main>
  );
}
