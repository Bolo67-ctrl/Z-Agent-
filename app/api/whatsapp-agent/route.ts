import { generateText } from "ai";
import { GEMINI_MODEL, gemini } from "@/lib/ai";

export const runtime = "nodejs";
export const maxDuration = 30;

const API_BASE = "https://api.whatsapp.com/agent/v1";
const MAX_REPLY_LENGTH = 4000;

type AgentMessage = {
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
 * Vercel Cron calls this endpoint to poll WhatsApp Agent Platform updates.
 * Configure WHATSAPP_AGENT_API_TOKEN, CRON_SECRET, and GEMINI_API_KEY in Vercel.
 */
export async function GET(request: Request) {
  if (!authorized(request)) return jsonError("Unauthorized.", 401);
  if (!process.env.GEMINI_API_KEY) return jsonError("GEMINI_API_KEY is not configured.", 503);
  if (!process.env.WHATSAPP_AGENT_API_TOKEN) return jsonError("WHATSAPP_AGENT_API_TOKEN is not configured.", 503);

  try {
    // Keep the long poll short so the scheduled function can finish within its runtime limit.
    const updates = await whatsappRequest("/updates?limit=50&timeout=5");
    const messages: AgentMessage[] = Array.isArray(updates?.messages)
      ? updates.messages
      : Array.isArray(updates?.updates)
        ? updates.updates.filter((item: any) => item?.from)
        : [];

    let handled = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const message of messages) {
      const recipient = typeof message.from === "string" ? message.from : "";
      const text = typeof message.text?.body === "string" ? message.text.body.trim() : "";

      // The documented recipient identifier must be used exactly as received.
      // Only answer human user IDs. Ignore agent IDs and unknown sender formats to prevent loops.
      if (!recipient.startsWith("user:") || message.type !== "text" || !text) {
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
