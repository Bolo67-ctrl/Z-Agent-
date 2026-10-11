import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 120;

const API_BASE = "https://api.whatsapp.com/agent/v1";
const MAX_REPLY_LENGTH = 4000;
// In test mode, process only this unique, explicitly sent message.
const WHATSAPP_TEST_MESSAGE =
  "ZAGENT PREVIEW TEST d91c6e. Reply with exactly: WHATSAPP TEST SUCCESSFUL.";

type AgentMessage = {
  id?: string;
  from?: string;
  type?: string;
  text?: { body?: string };
};

function jsonError(message: string, status: number) {
  return Response.json({ ok: false, error: message }, { status });
}

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

async function whatsappRequest(path: string, init: RequestInit = {}) {
  const token = process.env.WHATSAPP_AGENT_API_TOKEN;
  if (!token) throw new Error("WHATSAPP_AGENT_API_TOKEN is not configured.");

  // Bound upstream calls so they return control before the Vercel function deadline.
  // A /messages timeout is ambiguous; its durable pre-send lock remains terminal.
  const timeoutMs = path.startsWith("/updates")
    ? (path.includes("timeout=25") ? 30000 : path.includes("timeout=5") ? 7500 : 6000)
    : path === "/messages"
      ? 6000
      : 3000;
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    cache: "no-store",
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });

  // HTTP 204 means an empty long poll; keep the stored cursor unchanged.
  if (response.status === 204) return null;

  const body = await response.text();
  let data: any = null;
  try {
    data = body ? JSON.parse(body) : null;
  } catch {
    data = { raw: body.slice(0, 500) };
  }

  if (!response.ok) {
    throw new Error(`WhatsApp Agent API returned HTTP ${response.status}: ${data?.error?.message || data?.message || "request failed"}`);
  }

  return data;
}

function extractMessages(update: any): AgentMessage[] {
  if (Array.isArray(update?.messages)) return update.messages;
  if (Array.isArray(update?.updates)) {
    return update.updates.filter((item: any) => item && typeof item === "object" && item.from);
  }

  // WhatsApp Agent updates follow the standard entry/changes/value envelope.
  const entries = Array.isArray(update?.entry) ? update.entry : [];
  const messages: AgentMessage[] = [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const inbound = change?.value?.messages;
      if (Array.isArray(inbound)) messages.push(...inbound);
    }
  }
  return messages;
}

async function productionPoll() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return jsonError("Production polling is disabled until SUPABASE_SERVICE_ROLE_KEY is configured for this environment.", 503);
  }

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // The command bot no longer stores chat text. Clear any context text written by the prior AI version after 30 days.
  const retentionCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await db
    .from("whatsapp_agent_messages")
    .update({ inbound_text: null, reply_text: null })
    .lt("created_at", retentionCutoff);

  const warnings: string[] = [];

  try {
    const stateResult = await db
      .from("whatsapp_agent_poll_state")
      .select("next_offset")
      .eq("id", "default")
      .maybeSingle();

    if (stateResult.error || !stateResult.data) {
      return jsonError("WhatsApp reliability tables are not ready. Apply the Supabase migration documented in docs/whatsapp-agent.md.", 503);
    }

    const cursor = stateResult.data.next_offset == null
      ? null
      : Number(stateResult.data.next_offset);
    const path = cursor == null
      ? "/updates?limit=50&timeout=0"
      : "/updates?offset=" + encodeURIComponent(String(cursor)) + "&limit=50&timeout=25";
    const updates = await whatsappRequest(path);

    // HTTP 204 means no update arrived. Keep the current cursor and try later.
    if (updates == null) {
      return Response.json({
        ok: true,
        bootstrapPending: cursor == null,
        received: 0,
        handled: 0,
        skipped: 0,
        errors: [],
      });
    }

    const messages = extractMessages(updates);
    const nextOffset = Number(updates?.next_offset);
    if (!Number.isSafeInteger(nextOffset) || nextOffset < 0) {
      return jsonError("WhatsApp updates did not include a valid next_offset; no messages were processed.", 502);
    }

    // First run intentionally establishes a cursor without replying to historical queued chats.
    if (cursor == null) {
      const { error } = await db
        .from("whatsapp_agent_poll_state")
        .update({ next_offset: nextOffset, updated_at: new Date().toISOString() })
        .eq("id", "default");
      if (error) return jsonError("Could not save the WhatsApp bootstrap cursor.", 503);

      return Response.json({
        ok: true,
        bootstrapped: true,
        received: messages.length,
        handled: 0,
        skipped: messages.length,
        errors: [],
      });
    }

    let handled = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const message of messages) {
      const messageId = typeof message.id === "string" ? message.id : "";
      const recipient = typeof message.from === "string" ? message.from : "";
      const text = typeof message.text?.body === "string" ? message.text.body.trim() : "";

      // Only slash commands are handled. Ordinary chat is intentionally ignored (no AI).
      if (!messageId || !recipient.startsWith("user:") || message.type !== "text" || !text || !text.startsWith("/")) {
        skipped += 1;
        continue;
      }

      const claim = await db.rpc("claim_whatsapp_agent_message", {
        p_message_id: messageId,
        p_sender: recipient,
        p_lease_seconds: 300,
      });
      if (claim.error) {
        errors.push("Could not claim an inbound message for safe processing.");
        break;
      }
      if (claim.data !== true) {
        const prior = await db
          .from("whatsapp_agent_messages")
          .select("status, lease_until")
          .eq("message_id", messageId)
          .maybeSingle();
        if (prior.error || !prior.data) {
          errors.push("Could not verify the prior processing state; the cursor was held to avoid losing a message.");
          break;
        }
        if (prior.data.status === "sent" || prior.data.status === "uncertain") {
          // A sent or ambiguous send is terminal: never let a replay send it again.
          skipped += 1;
          continue;
        }
        // An active claim (or unexpected state) must not be treated as already handled.
        errors.push("This message is already claimed or in an unexpected state; the cursor was held for a safe retry.");
        break;
      }

      const reply = commandReply(text);

      // Persist a one-way send lock BEFORE calling the external API. If delivery or the
      // subsequent DB write is ambiguous, this row remains terminal and cannot be resent.
      const sendIntentUpdate = {
        status: "uncertain",
        lease_until: null,
        updated_at: new Date().toISOString(),
      };
      const sendIntent = await db
        .from("whatsapp_agent_messages")
        .update(sendIntentUpdate)
        .eq("message_id", messageId)
        .eq("status", "processing")
        .select("message_id")
        .maybeSingle();
      if (sendIntent.error || !sendIntent.data) {
        errors.push("Could not reserve this message in the database before sending; no WhatsApp reply was attempted.");
        break;
      }

      try {
        await whatsappRequest("/messages", {
          method: "POST",
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: recipient,
            type: "text",
            text: { body: reply },
          }),
        });
      } catch {
        // The durable uncertain lock was written before this request; never auto-resend it.
        errors.push("WhatsApp reply delivery is uncertain; automatic resend is blocked to avoid duplicates.");
        break;
      }

      const sentState = await db
        .from("whatsapp_agent_messages")
        .update({ status: "sent", lease_until: null, updated_at: new Date().toISOString() })
        .eq("message_id", messageId)
        .eq("status", "uncertain")
        .select("message_id")
        .maybeSingle();
      if (sentState.error || !sentState.data) {
        // The durable row is still uncertain, so a replay will not send this again.
        errors.push("A reply may have been sent, but the state remains locked against automatic resend.");
        break;
      }

      handled += 1;
      try {
        await whatsappRequest("/statuses", {
          method: "POST",
          body: JSON.stringify({
            messaging_product: "whatsapp",
            status: "read",
            message_id: messageId,
          }),
        });
      } catch {
        // Sending succeeded; a read receipt is best-effort and must not trigger a resend.
        errors.push("Reply sent, but the read receipt could not be updated.");
      }
    }

    // Persist the cursor only when every operation in this batch was accounted for.
    // Replayed messages are guarded by the unique message_id claim.
    if (errors.length === 0) {
      const { error } = await db
        .from("whatsapp_agent_poll_state")
        .update({ next_offset: nextOffset, updated_at: new Date().toISOString() })
        .eq("id", "default");
      if (error) errors.push("Could not save the latest WhatsApp polling cursor.");
    }

    return Response.json({
      ok: errors.length === 0,
      received: messages.length,
      handled,
      skipped,
      errors,
      warnings,
      mode: "command-only",
    });
  } catch {
    return jsonError("WhatsApp polling failed. Check the server-side configuration and migration status.", 502);
  }
}

function commandReply(message: string) {
  const firstToken = message.trim().split(/\s+/, 1)[0] || "";
  const command = firstToken.split("@", 1)[0].toLowerCase();

  switch (command) {
    case "/help":
    case "/start":
      return [
        "🤖 *Jarvis Commands*",
        "",
        "/help — Show this command list",
        "/ping — Check if Jarvis responds",
        "/time — Show the current time (UTC)",
        "/status — Show bot mode",
        "/about — About Jarvis",
      ].join("\n");
    case "/ping":
      return "Pong! 🟢 Jarvis is responding.";
    case "/time":
      return "🕒 Current time: " +
        new Intl.DateTimeFormat("en-US", {
          dateStyle: "full",
          timeStyle: "short",
          timeZone: "UTC",
        }).format(new Date()) +
        " UTC";
    case "/status":
      return [
        "🟢 *Jarvis Status*",
        "Mode: command-only",
        "AI replies: disabled",
        "Commands: /help",
      ].join("\n");
    case "/about":
      return [
        "🤖 *Jarvis WhatsApp Bot*",
        "Version: 1.0",
        "Mode: deterministic commands",
        "No AI generation is used for command replies.",
      ].join("\n");
    default:
      return "Unknown command: " + command.slice(0, 80) + "\nSend /help to see available commands.";
  }
}

/**
 * Polls WhatsApp Agent Platform updates.
 * Configure WHATSAPP_AGENT_API_TOKEN, CRON_SECRET, and GEMINI_API_KEY in Vercel.
 * Set WHATSAPP_TEST_MODE=true in Preview to process only the unique test message below.
 */
export async function GET(request: Request) {
  if (!authorized(request)) return jsonError("Unauthorized.", 401);

  const testMode = process.env.WHATSAPP_TEST_MODE === "true";
  // Fail closed before checking other settings: no lower-case/missing API key can enable normal replies.
  if (!testMode && process.env.WHATSAPP_NORMAL_MODE_ENABLED !== "true") {
    return jsonError("Normal WhatsApp replies are disabled in this environment.", 503);
  }
  if (!process.env.WHATSAPP_AGENT_API_TOKEN) return jsonError("WHATSAPP_AGENT_API_TOKEN is not configured.", 503);
  if (!testMode) return productionPoll();

  try {
    // Test mode replays the retained buffer so the just-sent test phrase is visible.
    // All non-matching unread messages are ignored below.
    const updates = await whatsappRequest(
      testMode
        ? "/updates?offset=0&limit=50&timeout=0"
        : "/updates?limit=50&timeout=5"
    );
    const messages = extractMessages(updates);
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) {
      return jsonError("Safe test replies require SUPABASE_SERVICE_ROLE_KEY so test messages can be deduplicated.", 503);
    }
    const db = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    let handled = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const message of messages) {
      const messageId = typeof message.id === "string" ? message.id : "";
      const recipient = typeof message.from === "string" ? message.from : "";
      const text = typeof message.text?.body === "string" ? message.text.body.trim() : "";

      // Test messages need a provider message ID so they can be marked read after replying.
      if (!messageId || !recipient.startsWith("user:") || message.type !== "text" || !text) {
        skipped += 1;
        continue;
      }

      // In test mode, fail closed: ignore every message except the unique test phrase.
      if (testMode && text !== WHATSAPP_TEST_MESSAGE) {
        skipped += 1;
        continue;
      }

      const claim = await db.rpc("claim_whatsapp_agent_message", {
        p_message_id: messageId,
        p_sender: recipient,
        p_lease_seconds: 300,
      });
      if (claim.error) {
        errors.push("Could not claim the test message for safe processing.");
        break;
      }
      if (claim.data !== true) {
        const prior = await db
          .from("whatsapp_agent_messages")
          .select("status")
          .eq("message_id", messageId)
          .maybeSingle();
        if (prior.error || !prior.data) {
          errors.push("Could not verify the test message state; no reply was sent.");
          break;
        }
        if (prior.data.status === "sent" || prior.data.status === "uncertain") {
          skipped += 1;
          break;
        }
        errors.push("The test message is already claimed or in an unexpected state; no reply was sent.");
        break;
      }

      const reply = "WHATSAPP TEST SUCCESSFUL.";

      // Commit the one-way send lock before touching the external messaging API.
      const sendIntent = await db
        .from("whatsapp_agent_messages")
        .update({ status: "uncertain", lease_until: null, updated_at: new Date().toISOString() })
        .eq("message_id", messageId)
        .eq("status", "processing")
        .select("message_id")
        .maybeSingle();
      if (sendIntent.error || !sendIntent.data) {
        errors.push("Could not reserve the test message before sending; no reply was attempted.");
        break;
      }

      try {
        await whatsappRequest("/messages", {
          method: "POST",
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: recipient,
            type: "text",
            text: { body: reply },
          }),
        });
        handled += 1;
      } catch {
        // The prior uncertain lock intentionally blocks retry after ambiguous delivery.
        errors.push("Test reply delivery is uncertain; automatic resend is blocked to avoid duplicates.");
        break;
      }

      const sentState = await db
        .from("whatsapp_agent_messages")
        .update({ status: "sent", lease_until: null, updated_at: new Date().toISOString() })
        .eq("message_id", messageId)
        .eq("status", "uncertain")
        .select("message_id")
        .maybeSingle();
      if (sentState.error || !sentState.data) {
        errors.push("Test reply may have been sent, but the state remains locked against automatic resend.");
        break;
      }

      try {
        await whatsappRequest("/statuses", {
          method: "POST",
          body: JSON.stringify({
            messaging_product: "whatsapp",
            status: "read",
            message_id: messageId,
          }),
        });
      } catch {
        errors.push("Test reply was sent, but its read receipt failed; the sent record prevents duplicate replies.");
      }
      // Handle at most one matching test message per request.
      break;
    }

    return Response.json({ ok: errors.length === 0, received: messages.length, handled, skipped, errors });
  } catch (error) {
    // Avoid returning credentials or raw request headers in error responses.
    const message = error instanceof Error ? error.message : "WhatsApp agent polling failed.";
    return jsonError(message, 502);
  }
}
