import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const API_BASE = "https://api.whatsapp.com/agent/v1";

// One-time cursor initializer. It reads provider offset metadata only and never processes or replies to messages.
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  // Allow this operation only while the Preview exact-message test guard remains enabled.
  if (process.env.WHATSAPP_TEST_MODE !== "true") {
    return Response.json({ ok: false, error: "Cursor initialization is available only while Preview test mode is enabled." }, { status: 403 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const whatsappToken = process.env.WHATSAPP_AGENT_API_TOKEN;
  if (!supabaseUrl || !serviceKey || !whatsappToken) {
    return Response.json({ ok: false, error: "A required server-side Preview setting is missing." }, { status: 503 });
  }

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const state = await db
      .from("whatsapp_agent_poll_state")
      .select("id, next_offset")
      .eq("id", "default")
      .maybeSingle();

    if (state.error || !state.data) {
      return Response.json({ ok: false, error: "WhatsApp reliability tables are not ready." }, { status: 503 });
    }
    if (state.data.next_offset != null) {
      return Response.json({ ok: false, alreadyInitialized: true, message: "The cursor is already initialized. No WhatsApp request was made." }, { status: 409 });
    }

    // Omitting offset asks the provider for the current head; messages are not inspected, processed, or acknowledged here.
    const response = await fetch(`${API_BASE}/updates?limit=50&timeout=0`, {
      headers: { Authorization: `Bearer ${whatsappToken}`, Accept: "application/json" },
      cache: "no-store",
    });

    if (!response.ok) {
      return Response.json({ ok: false, error: `WhatsApp offset lookup returned HTTP ${response.status}. No messages were processed or sent.` }, { status: 502 });
    }

    const responseText = await response.text();
    let update: any = null;
    try {
      update = responseText ? JSON.parse(responseText) : null;
    } catch {
      update = null;
    }

    const nextOffset = Number(update?.next_offset);
    if (!Number.isSafeInteger(nextOffset) || nextOffset < 0) {
      return Response.json({
        ok: false,
        error: "WhatsApp did not provide a valid next_offset. The database cursor was not changed; no messages were processed or sent.",
      }, { status: 502 });
    }

    const saved = await db
      .from("whatsapp_agent_poll_state")
      .update({ next_offset: nextOffset, updated_at: new Date().toISOString() })
      .eq("id", "default")
      .is("next_offset", null)
      .select("id")
      .maybeSingle();

    if (saved.error || !saved.data) {
      return Response.json({
        ok: false,
        error: "The cursor was not saved (another initializer may have won the race). Check the database status before trying again.",
      }, { status: 409 });
    }

    return Response.json({
      ok: true,
      cursorInitialized: true,
      messagesProcessed: 0,
      repliesSent: 0,
      message: "Starting offset saved. No WhatsApp messages were processed, acknowledged, or replied to.",
    });
  } catch {
    return Response.json({
      ok: false,
      error: "Cursor initialization failed. No AI replies were generated. Verify status before retrying.",
    }, { status: 502 });
  }
}
