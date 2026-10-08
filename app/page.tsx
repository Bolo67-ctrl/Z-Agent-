"use client";

import { useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";

export default function Home() {
  const [input, setInput] = useState("");
  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });

  const busy = status === "submitted" || status === "streaming";

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    await sendMessage({ text });
  }

  return (
    <main className="chat-shell">
      <header className="topbar">
        <div>
          <div className="brand">Z-AGENT</div>
          <div className="status">{busy ? "WORKING" : "READY"}</div>
        </div>
        <span className="version">V1</span>
      </header>

      <section className="messages" aria-live="polite">
        {messages.length === 0 ? (
          <div className="empty">
            <div className="badge">Z-AGENT · V1</div>
            <h1>Let&apos;s get to work.</h1>
            <p>Ask Z-Agent to reason, write, plan, or help you build something.</p>
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
          placeholder="Tell Z-Agent what you need..."
          rows={1}
          disabled={busy}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button type="submit" disabled={busy || !input.trim()}>
          {busy ? "Working..." : "Send"}
        </button>
      </form>
    </main>
  );
}
