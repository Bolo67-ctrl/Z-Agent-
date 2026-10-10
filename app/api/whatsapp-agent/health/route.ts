import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only diagnostic. It does not call WhatsApp, generate AI, or send messages.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return Response.json({
      ok: false,
      checks: {
        supabaseUrl: Boolean(supabaseUrl),
        serviceRoleKeyConfigured: Boolean(serviceKey),
      },
      message: "A required server-side Supabase setting is missing in this Preview environment.",
    }, { status: 503 });
  }

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const [state, messages, claim] = await Promise.all([
      db.from("whatsapp_agent_poll_state")
        .select("id, next_offset")
        .eq("id", "default")
        .maybeSingle(),
      db.from("whatsapp_agent_messages")
        .select("status, created_at, updated_at, lease_until")
        .order("created_at", { ascending: false })
        .limit(5),
      // Empty ID exits the SQL function before any insert; this checks function availability without writing.
      db.rpc("claim_whatsapp_agent_message", {
        p_message_id: "",
        p_sender: "z-agent-health-check",
        p_lease_seconds: 60,
      }),
    ]);

    const checks = {
      pollStateTable: state.error ? "not_ready" : "ready",
      pollStateRow: state.data ? "ready" : "missing",
      messageTrackingTable: messages.error ? "not_ready" : "ready",
      claimFunction: claim.error ? "not_ready" : claim.data === false ? "ready" : "unexpected_response",
      cursorInitialized: state.data?.next_offset != null,
    };

    const ok =
      checks.pollStateTable === "ready" &&
      checks.pollStateRow === "ready" &&
      checks.messageTrackingTable === "ready" &&
      checks.claimFunction === "ready";

    return Response.json({
      ok,
      checks,
      // Status-only diagnostic for the most recent dedup rows. Never return message IDs,
      // sender identities, or message contents. This helps distinguish timeout stages
      // without polling WhatsApp or writing to the database.
      recentMessageStates: (messages.data ?? []).map((row) => ({
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        leaseUntil: row.lease_until,
      })),
      message: ok
        ? "Database setup verified. No WhatsApp poll was made and no message was sent."
        : "Database setup is incomplete. No WhatsApp poll was made and no message was sent.",
    }, { status: ok ? 200 : 503 });
  } catch {
    return Response.json({
      ok: false,
      message: "Database verification failed. No WhatsApp poll was made and no message was sent.",
    }, { status: 503 });
  }
}
