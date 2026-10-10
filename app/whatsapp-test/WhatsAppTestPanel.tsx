"use client";

import { useState, type FormEvent } from "react";

const TEST_MESSAGE =
  "ZAGENT PREVIEW TEST 8f2d41. Reply with exactly: WHATSAPP TEST SUCCESSFUL.";

type PollResult = {
  status: number;
  body: unknown;
};

export default function WhatsAppTestPanel() {
  const [secret, setSecret] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<PollResult | null>(null);
  const [healthSecret, setHealthSecret] = useState("");
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthResult, setHealthResult] = useState<PollResult | null>(null);
  const [bootstrapSecret, setBootstrapSecret] = useState("");
  const [bootstrapLoading, setBootstrapLoading] = useState(false);
  const [bootstrapDone, setBootstrapDone] = useState(false);
  const [bootstrapResult, setBootstrapResult] = useState<PollResult | null>(null);

  async function verifyDatabase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = healthSecret.trim();
    if (!token || healthLoading) return;

    setHealthLoading(true);
    setHealthResult(null);
    try {
      const response = await fetch("/api/whatsapp-agent/health", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        cache: "no-store",
      });
      const body = await response.json().catch(() => ({ error: "The endpoint returned a non-JSON response." }));
      setHealthResult({ status: response.status, body });
    } catch {
      setHealthResult({ status: 0, body: { error: "Could not reach the Preview database check." } });
    } finally {
      setHealthSecret("");
      setHealthLoading(false);
    }
  }

  async function initializeCursor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = bootstrapSecret.trim();
    if (!token || bootstrapLoading || bootstrapDone) return;

    setBootstrapLoading(true);
    setBootstrapResult(null);
    try {
      const response = await fetch("/api/whatsapp-agent/bootstrap", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        cache: "no-store",
      });
      const body: any = await response.json().catch(() => ({ error: "The endpoint returned a non-JSON response." }));
      setBootstrapResult({ status: response.status, body });
      if (response.ok && body?.cursorInitialized === true) {
        setBootstrapDone(true);
      }
    } catch {
      setBootstrapResult({
        status: 0,
        body: { error: "Connection was interrupted. Check database status before trying again." },
      });
    } finally {
      setBootstrapSecret("");
      setBootstrapLoading(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = secret.trim();
    if (!token || loading || done) return;

    setLoading(true);
    setResult(null);
    try {
      const response = await fetch("/api/whatsapp-agent", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        cache: "no-store",
      });

      const body: any = await response.json().catch(() => ({ error: "The endpoint returned a non-JSON response." }));
      setResult({ status: response.status, body });
      if (response.ok && typeof body?.handled === "number" && body.handled > 0) {
        setDone(true);
      }
    } catch {
      setResult({ status: 0, body: { error: "Could not reach the Preview endpoint. Check your connection and try again." } });
    } finally {
      setSecret("");
      setLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 720, margin: "40px auto", padding: 24, fontFamily: "system-ui, sans-serif", color: "#171717" }}>
      <p style={{ fontSize: 12, letterSpacing: 2, fontWeight: 700, color: "#525252" }}>Z-AGENT · PREVIEW TEST</p>
      <h1 style={{ fontSize: 30, marginBottom: 8 }}>Safe WhatsApp test</h1>
      <p style={{ lineHeight: 1.55 }}>
        Test mode is enabled. The poller will only reply to the exact message below; all other queued messages are skipped.
      </p>

      <section style={{ border: "1px solid #d4d4d4", borderRadius: 12, padding: 16, margin: "20px 0" }}>
        <p style={{ fontSize: 12, fontWeight: 700, color: "#525252", marginTop: 0 }}>1 · Verify database setup (safe, no WhatsApp polling)</p>
        <p style={{ lineHeight: 1.55 }}>
          This check only verifies the Supabase tables and claim function. It does not poll WhatsApp, read messages, or send replies.
          Enter the Preview CRON_SECRET below; the value is cleared after the request.
        </p>
        <form onSubmit={verifyDatabase} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label htmlFor="health-cron-secret" style={{ fontSize: 14, fontWeight: 600 }}>Preview CRON_SECRET</label>
          <input
            id="health-cron-secret"
            type="password"
            autoComplete="off"
            value={healthSecret}
            onChange={event => setHealthSecret(event.target.value)}
            placeholder="Paste your saved Preview secret"
            disabled={healthLoading}
            style={{ border: "1px solid #a3a3a3", borderRadius: 8, padding: 12, fontSize: 16 }}
          />
          <button
            type="submit"
            disabled={healthLoading || !healthSecret.trim()}
            style={{
              border: 0, borderRadius: 8, padding: "12px 14px", fontSize: 15, fontWeight: 700,
              background: "#171717", color: "#ffffff",
              cursor: healthLoading || !healthSecret.trim() ? "not-allowed" : "pointer",
            }}
          >
            {healthLoading ? "Checking database…" : "Verify database only"}
          </button>
        </form>
        {healthResult ? (
          <div aria-live="polite" style={{ border: "1px solid #d4d4d4", borderRadius: 8, padding: 12, marginTop: 14 }}>
            <h2 style={{ fontSize: 16, marginTop: 0 }}>Database check · HTTP {healthResult.status || "network error"}</h2>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 13, lineHeight: 1.5 }}>{JSON.stringify(healthResult.body, null, 2)}</pre>
          </div>
        ) : null}
      </section>

      <section style={{ border: "1px solid #d4d4d4", borderRadius: 12, padding: 16, margin: "20px 0" }}>
        <p style={{ fontSize: 12, fontWeight: 700, color: "#525252", marginTop: 0 }}>2 · Initialize the starting offset (one-time, no replies)</p>
        <p style={{ lineHeight: 1.55 }}>
          This waits up to 25 seconds for a new WhatsApp update and saves only its starting offset. Click the button, then immediately send one harmless message to Jarvis while it says “Initializing…”. This setup request will not inspect, process, mark read, or reply to that message. If no update arrives and it reports HTTP 409, the cursor stays unchanged and you can retry when ready.
        </p>
        <form onSubmit={initializeCursor} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label htmlFor="bootstrap-cron-secret" style={{ fontSize: 14, fontWeight: 600 }}>Preview CRON_SECRET</label>
          <input
            id="bootstrap-cron-secret"
            type="password"
            autoComplete="off"
            value={bootstrapSecret}
            onChange={event => setBootstrapSecret(event.target.value)}
            placeholder="Paste your saved Preview secret"
            disabled={bootstrapLoading || bootstrapDone}
            style={{ border: "1px solid #a3a3a3", borderRadius: 8, padding: 12, fontSize: 16 }}
          />
          <button
            type="submit"
            disabled={bootstrapLoading || bootstrapDone || !bootstrapSecret.trim()}
            style={{
              border: 0, borderRadius: 8, padding: "12px 14px", fontSize: 15, fontWeight: 700,
              background: bootstrapDone ? "#e5e5e5" : "#171717",
              color: bootstrapDone ? "#525252" : "#ffffff",
              cursor: bootstrapLoading || bootstrapDone || !bootstrapSecret.trim() ? "not-allowed" : "pointer",
            }}
          >
            {bootstrapLoading ? "Initializing…" : bootstrapDone ? "Starting offset saved" : "Initialize cursor once"}
          </button>
        </form>
        {bootstrapResult ? (
          <div aria-live="polite" style={{ border: "1px solid #d4d4d4", borderRadius: 8, padding: 12, marginTop: 14 }}>
            <h2 style={{ fontSize: 16, marginTop: 0 }}>Cursor initialization · HTTP {bootstrapResult.status || "network error"}</h2>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 13, lineHeight: 1.5 }}>{JSON.stringify(bootstrapResult.body, null, 2)}</pre>
            {bootstrapDone ? (
              <p style={{ marginBottom: 0, fontWeight: 600 }}>Starting offset saved. Do not initialize again, and do not run the poll yet.</p>
            ) : (bootstrapResult.body as { waitingForUpdate?: boolean } | null)?.waitingForUpdate ? (
              <p style={{ marginBottom: 0 }}>No new event arrived during the wait. The cursor was not changed. You may retry once when ready, and send a harmless message immediately after clicking Initialize.</p>
            ) : (
              <p style={{ marginBottom: 0 }}>For any other error, do not keep retrying. Verify database status first.</p>
            )}
          </div>
        ) : null}
      </section>

      <section style={{ border: "1px solid #d4d4d4", borderRadius: 12, padding: 16, margin: "20px 0" }}>
        <p style={{ fontSize: 12, fontWeight: 700, color: "#525252", marginTop: 0 }}>3 · Send this exact message to your Jarvis agent chat</p>
        <p style={{ overflowWrap: "anywhere", fontFamily: "ui-monospace, monospace", lineHeight: 1.5 }}>{TEST_MESSAGE}</p>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(TEST_MESSAGE);
            setCopied(true);
          }}
          style={{ border: "1px solid #737373", borderRadius: 8, background: "white", padding: "8px 12px", cursor: "pointer" }}
        >
          {copied ? "Copied" : "Copy test message"}
        </button>
      </section>

      <section style={{ border: "1px solid #d4d4d4", borderRadius: 12, padding: 16, margin: "20px 0" }}>
        <p style={{ fontSize: 12, fontWeight: 700, color: "#525252", marginTop: 0 }}>4 · Run one authenticated poll (do not use this for the database or cursor checks)</p>
        <p style={{ lineHeight: 1.55 }}>
          Enter the CRON_SECRET you saved for Preview. It is used only for this request and cleared from the input afterward. Do not share it in chat.
        </p>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label htmlFor="cron-secret" style={{ fontSize: 14, fontWeight: 600 }}>Preview CRON_SECRET</label>
          <input
            id="cron-secret"
            type="password"
            autoComplete="off"
            value={secret}
            onChange={event => setSecret(event.target.value)}
            placeholder="Paste your saved secret"
            disabled={loading || done}
            style={{ border: "1px solid #a3a3a3", borderRadius: 8, padding: 12, fontSize: 16 }}
          />
          <button
            type="submit"
            disabled={loading || done || !secret.trim()}
            style={{
              border: 0, borderRadius: 8, padding: "12px 14px", fontSize: 15, fontWeight: 700,
              background: done ? "#e5e5e5" : "#171717", color: done ? "#525252" : "#ffffff",
              cursor: loading || done || !secret.trim() ? "not-allowed" : "pointer",
            }}
          >
            {loading ? "Polling WhatsApp…" : done ? "Test reply sent" : "Run safe test once"}
          </button>
        </form>
      </section>

      {result ? (
        <section aria-live="polite" style={{ border: "1px solid #d4d4d4", borderRadius: 12, padding: 16, marginTop: 20 }}>
          <h2 style={{ fontSize: 18, marginTop: 0 }}>Result · HTTP {result.status || "network error"}</h2>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 13, lineHeight: 1.5 }}>{JSON.stringify(result.body, null, 2)}</pre>
          {done ? (
            <p style={{ marginBottom: 0, fontWeight: 600 }}>A reply was sent. Do not run the poll again.</p>
          ) : (
            <p style={{ marginBottom: 0 }}>If no matching test message was found, send the exact message above before trying another poll. Avoid repeat polling after a reply.</p>
          )}
        </section>
      ) : null}

      <p style={{ color: "#525252", fontSize: 13, lineHeight: 1.5, marginTop: 22 }}>
        Preview test only. The test-mode flag must remain disabled in Production until normal message handling is reviewed.
      </p>
    </main>
  );
}
