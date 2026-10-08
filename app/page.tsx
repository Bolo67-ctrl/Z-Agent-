"use client";

import { useEffect, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { createClient } from "@/lib/supabase/client";

export default function Home() {
  const [input, setInput] = useState("");
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });

  useEffect(() => {
    let cancelled = false;

    async function initializeIdentity() {
      const supabase = createClient();
      const { data: existing } = await supabase.auth.getUser();

      if (existing.user) {
        if (!cancelled) setAuthReady(true);
        return;
      }

      const { error: signInError } = await supabase.auth.signInAnonymously();

      if (cancelled) return;

      if (signInError) {
        setAuthError(signInError.message);
      } else {
        setAuthReady(true);
      }
    }

    initializeIdentity();

    return () => {
      cancelled = true;
    };
  }, []);

  const busy = status === "submitted" || status === "streaming";
  const disabled = busy || !authReady;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || disabled) return;
    setInput("");
    await sendMessage({ text });
  }

  return (
    <main className="chat-shell">
      <header className="topbar">
        <div>
          <div className="brand">Z-AGENT</div>
          <div className="status">
            {busy ? "WORKING" : authReady ? "READY" : "CONNECTING"}
          </div>
        </div>
        <span className="version">V1</span>
      </header>

      <section className="messages" aria-live="polite">
        {messages.length === 0 ? (
          <div className="empty">
            <div className="badge">Z-AGENT · V1</div>
            <h1>Let&apos;s get to work.</h1>
            <p>Ask Z-Agent to reason, write, plan, or help you build something.</p>
            {!authReady && !authError ? <p>Setting up your private memory...</p> : null}
            {authError ? <div className="error">{authError}</div> : null}
          </div>
        ) : (
          messages.map((message) => (
            <article key={message.id} className={`message ${message.role}`}>
              <div className="role">{message.role === "user" ? "YOU" : "Z-AGENT"}</div>
              <div className="content">
                {message.parts.map((part, index) =>
                  part.type === "text" ? <span key={index}>{part.text}</span> : null
                )}
              </div>
            </article>
          ))
        )}
        {error ? <div className="error">{error.message}</div> : null}
      </section>

      <form className="composer" onSubmit={submit}>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={authReady ? "Tell Z-Agent what you need..." : "Connecting..."}
          rows={1}
          disabled={disabled}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button type="submit" disabled={disabled || !input.trim()}>
          {busy ? "Working..." : authReady ? "Send" : "Connecting..."}
        </button>
      </form>
    </main>
  );
}
