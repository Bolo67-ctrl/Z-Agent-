import { generateText } from "ai";
import { createClient } from "@supabase/supabase-js";
import { GEMINI_MODEL, gemini } from "@/lib/ai";

export const runtime = "nodejs";
export const maxDuration = 30;

const API_BASE = "https://api.whatsapp.com/agent/v1";
const MAX_REPLY_LENGTH = 4000;
// In test mode, process only this unique, explicitly sent message.
const WHATSAPP_TEST_MESSAGE =
  "ZAGENT PREVIEW TEST 8f2d41. Reply with exactly: WHATSAPP TEST SUCCESSFUL.";

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

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    cache: "no-store",
  });

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
      : "/updates?offset=" + encodeURIComponent(String(cursor)) + "&limit=50&timeout=5";
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

      // Do not reply to unsupported or malformed messages. They are passed by the cursor.
      if (!messageId || !recipient.startsWith("user:") || message.type !== "text" || !text) {
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
        skipped += 1;
        continue;
      }

      let reply = "";
      try {
        reply = await makeReply(text);
        if (!reply) throw new Error("The AI returned an empty reply.");
      } catch {
        await db
          .from("whatsapp_agent_messages")
          .update({ status: "failed", lease_until: null, updated_at: new Date().toISOString() })
          .eq("message_id", messageId);
        errors.push("AI reply generation failed; the message is eligible for a later retry.");
        continue;
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
        // A dropped connection can make delivery ambiguous. Do not auto-send it again.
        await db
          .from("whatsapp_agent_messages")
          .update({ status: "uncertain", lease_until: null, updated_at: new Date().toISOString() })
          .eq("message_id", messageId);
        errors.push("WhatsApp reply delivery is uncertain; automatic retry was blocked to avoid a duplicate.");
        continue;
      }

      const sentState = await db
        .from("whatsapp_agent_messages")
        .update({ status: "sent", lease_until: null, updated_at: new Date().toISOString() })
        .eq("message_id", messageId);
      if (sentState.error) {
        // Do not advance the cursor after a successful send if its dedup record could not be saved.
        errors.push("A reply was sent, but its deduplication state could not be saved.");
        continue;
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

    return Response.json({ ok: errors.length === 0, received: messages.length, handled, skipped, errors });
  } catch {
    return jsonError("WhatsApp polling failed. Check the server-side configuration and migration status.", 502);
  }
}

async function makeReply(message: string) {
  const { text } = await generateText({
    model: gemini(GEMINI_MODEL),
    system:
      "You are Jarvis, a helpful personal AI assistant speaking with your owner in a private WhatsApp agent chat. " +
      "Be warm, concise, and useful. You can answer questions and help plan tasks, but do not claim to have completed actions, " +
      "set reminders, browsed the internet, or accessed accounts unless a configured tool actually did so. " +
      "Ask for confirmation before sensitive or irreversible actions. Do not ask the user to send passwords, API keys, or authentication codes.",
    prompt: message,
  });

  return text.trim().slice(0, MAX_REPLY_LENGTH);
}

/**
 * Polls WhatsApp Agent Platform updates.
 * Configure WHATSAPP_AGENT_API_TOKEN, CRON_SECRET, and GEMINI_API_KEY in Vercel.
 * Set WHATSAPP_TEST_MODE=true in Preview to process only the unique test message below.
 */
export async function GET(request: Request) {
  if (!authorized(request)) return jsonError("Unauthorized.", 401);
  if (!process.env.GEMINI_API_KEY) return jsonError("GEMINI_API_KEY is not configured.", 503);
  if (!process.env.WHATSAPP_AGENT_API_TOKEN) return jsonError("WHATSAPP_AGENT_API_TOKEN is not configured.", 503);

  const testMode = process.env.WHATSAPP_TEST_MODE === "true";
  // Fail closed: disabling the test filter must not silently enable normal replies.
  if (!testMode && process.env.WHATSAPP_NORMAL_MODE_ENABLED !== "true") {
    return jsonError("Normal WhatsApp replies are disabled in this environment.", 503);
  }
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

      try {
        const reply = await makeReply(text);
        if (!reply) {
          skipped += 1;
          continue;
        }

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
          errors.push("Test reply was sent, but its read receipt failed; do not poll the test again.");
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "Failed to process a message.");
      }
    }

    return Response.json({ ok: errors.length === 0, received: messages.length, handled, skipped, errors });
  } catch (error) {
    // Avoid returning credentials or raw request headers in error responses.
    const message = error instanceof Error ? error.message : "WhatsApp agent polling failed.";
    return jsonError(message, 502);
  }
}
