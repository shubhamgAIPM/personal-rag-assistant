import { useState, type FormEvent } from "react";
import { supabase } from "../lib/supabase.ts";

export function AuthForm() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        // Generic message: do not reveal whether the account exists.
        if (error) setMessage({ kind: "error", text: "Sign-in failed. Check your email and password." });
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) setMessage({ kind: "error", text: "Sign-up failed. Try a different email or a longer password." });
        else if (!data.session) setMessage({ kind: "info", text: "Check your email to confirm your account, then sign in." });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card auth" onSubmit={submit}>
      <h2>{mode === "signin" ? "Sign in to your workspace" : "Create an account"}</h2>
      <label>
        Email
        <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label>
        Password
        <input
          type="password"
          required
          minLength={8}
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {message && (
        <p role="alert" className={message.kind === "error" ? "msg error" : "msg"}>
          {message.text}
        </p>
      )}
      <button type="submit" disabled={busy}>
        {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Sign up"}
      </button>
      <button
        type="button"
        className="link"
        onClick={() => {
          setMode(mode === "signin" ? "signup" : "signin");
          setMessage(null);
        }}
      >
        {mode === "signin" ? "Need an account? Sign up" : "Have an account? Sign in"}
      </button>
    </form>
  );
}
