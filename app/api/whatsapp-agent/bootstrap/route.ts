import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const API_BASE = "https://api.whatsapp.com/agent/v1";
const PAGE_LIMIT = 100;
const MAX_DRAIN_PAGES = 10;

type UpdatePage = { next_offset?: number | string };

async function fetchUpdates(token: string, path: string) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
  });
}

// One-time cursor initializer. It drains the existing update buffer by offset only.
// It never inspects messages, sends replies, or marks messages read.
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

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

    // Start at offset 0 because this is an intentional one-time backlog skip.
    // Follow next_offset until the provider reports 204 (no more retained entries).
    // Polling does not consume messages, and this route never inspects their contents.
    let offset = 0;
    let pagesRead = 0;
    let lastNextOffset: number | null = null;
    let drained = false;

    while (pagesRead < MAX_DRAIN_PAGES) {
      const response = await fetchUpdates(
        whatsappToken,
        `/updates?offset=${encodeURIComponent(String(offset))}&limit=${PAGE_LIMIT}&timeout=0`,
      );

      if (response.status === 204) {
        drained = lastNextOffset !== null;
        break;
      }
      if (!response.ok) {
        return Response.json({
          ok: false,
          error: `WhatsApp offset lookup returned HTTP ${response.status}. The database cursor is unchanged; no messages were processed, marked read, or replied to.`,
        }, { status: 502 });
      }

      let update: UpdatePage | null = null;
      try {
        update = await response.json() as UpdatePage;
      } catch {
        update = null;
      }

      const nextOffset = Number(update?.next_offset);
      if (!Number.isSafeInteger(nextOffset) || nextOffset < 0 || nextOffset <= offset) {
        return Response.json({
          ok: false,
          error: "WhatsApp returned an invalid next_offset. The database cursor is unchanged; no messages were processed, marked read, or replied to.",
        }, { status: 502 });
      }

      lastNextOffset = nextOffset;
      offset = nextOffset;
      pagesRead += 1;
    }

    if (!drained) {
      return Response.json({
        ok: false,
        needsReview: true,
        pagesRead,
        cursorInitialized: false,
        message: "The update buffer did not become empty within the safe page limit. The database cursor is unchanged; nothing was processed or replied to. Do not retry yet—review the backlog size first.",
      }, { status: 409 });
    }

    const saved = await db
      .from("whatsapp_agent_poll_state")
      .update({ next_offset: lastNextOffset, updated_at: new Date().toISOString() })
      .eq("id", "default")
      .is("next_offset", null)
      .select("id")
      .maybeSingle();

    if (saved.error || !saved.data) {
      return Response.json({
        ok: false,
        error: "The cursor was not saved (another initializer may have won the race). Check database status before doing anything else.",
      }, { status: 409 });
    }

    return Response.json({
      ok: true,
      cursorInitialized: true,
      pagesRead,
      messagesProcessed: 0,
      repliesSent: 0,
      message: "The existing update buffer was skipped and the starting offset saved. No message contents were processed, no messages were marked read, and no replies were sent.",
    });
  } catch {
    return Response.json({
      ok: false,
      error: "Cursor initialization failed. The database cursor was not intentionally changed; no AI replies were generated. Verify status before retrying.",
    }, { status: 502 });
  }
}
