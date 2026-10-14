const DEFAULT_AGENT_URL = "https://z-agent-zeta.vercel.app";
const DASHBOARD_STATE_KEY = "dashboard-state-v1";
const LEGACY_LAST_POLL_KEY = "last-poll-v1";
const LEGACY_LAST_CRON_KEY = "last-cron-start-v1";

// Stay well inside the 15-minute Cron Trigger wall-time limit.
const LISTEN_WINDOW_MS = 14 * 60 * 1000 + 50 * 1000;
const REQUEST_TIMEOUT_MS = 40000;
const REQUEST_DEADLINE_BUFFER_MS = 42000;
const MAX_POLLS_PER_RUN = 42;
const STATE_SAVE_INTERVAL_MS = 150000;
const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_MS = 5000;
const STATE_TTL_SECONDS = 7 * 24 * 60 * 60;

function json(body, status) {
  return Response.json(body, {
    status: status || 200,
    headers: { "Cache-Control": "no-store" },
  });
}

function authorizeDashboard(request, env) {
  if (!env.DASHBOARD_TOKEN) {
    return json({
      ok: false,
      error: "Dashboard is not configured yet. Add the DASHBOARD_TOKEN secret in Cloudflare.",
    }, 503);
  }
  if (request.headers.get("authorization") !== "Bearer " + env.DASHBOARD_TOKEN) {
    return json({ ok: false, error: "Unauthorized." }, 401);
  }
  return null;
}

function agentBase(env) {
  return (env.AGENT_URL || DEFAULT_AGENT_URL).replace(/\/+$/, "");
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function readResponse(response) {
  const raw = await response.text();
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

async function loadDashboardState(env) {
  try {
    const current = await env.POLL_STATE.get(DASHBOARD_STATE_KEY, "json");
    if (current && typeof current === "object") {
      return {
        lastPoll: current.lastPoll || null,
        lastCronStart: current.lastCronStart || null,
        storageReady: true,
      };
    }

    // Read keys written by the earlier Worker version once during migration.
    const [lastPoll, lastCronStart] = await Promise.all([
      env.POLL_STATE.get(LEGACY_LAST_POLL_KEY, "json"),
      env.POLL_STATE.get(LEGACY_LAST_CRON_KEY, "json"),
    ]);
    return {
      lastPoll: lastPoll || null,
      lastCronStart: lastCronStart || null,
      storageReady: true,
    };
  } catch (error) {
    return { lastPoll: null, lastCronStart: null, storageReady: false };
  }
}

async function saveDashboardState(env, state) {
  try {
    const value = {
      lastPoll: state.lastPoll || null,
      lastCronStart: state.lastCronStart || null,
    };
    if (value.lastPoll) value.lastPoll.stateSaved = true;
    await env.POLL_STATE.put(DASHBOARD_STATE_KEY, JSON.stringify(value), {
      expirationTtl: STATE_TTL_SECONDS,
    });
    state.storageReady = true;
    return true;
  } catch (error) {
    state.storageReady = false;
    if (state.lastPoll) state.lastPoll.stateSaved = false;
    console.error("Could not save Jarvis dashboard state to KV.", error);
    return false;
  }
}

async function runPoll(env, scheduledTime) {
  const startedAt = new Date().toISOString();
  let result;

  if (!env.CRON_SECRET) {
    result = {
      trigger: "scheduled",
      checkedAt: startedAt,
      ok: false,
      error: "The CRON_SECRET secret is missing in Cloudflare.",
    };
  } else {
    try {
      const response = await fetch(agentBase(env) + "/api/whatsapp-agent", {
        method: "GET",
        headers: {
          Authorization: "Bearer " + env.CRON_SECRET,
          Accept: "application/json",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = await readResponse(response);
      result = {
        trigger: "scheduled",
        checkedAt: startedAt,
        ok: response.ok && body.ok === true,
        httpStatus: response.status,
        received: Number.isFinite(body.received) ? body.received : 0,
        handled: Number.isFinite(body.handled) ? body.handled : 0,
        skipped: Number.isFinite(body.skipped) ? body.skipped : 0,
        mode: typeof body.mode === "string" ? body.mode : "command-only",
        errors: Array.isArray(body.errors)
          ? body.errors.slice(0, 5).map(function (item) {
              return String(item).slice(0, 240);
            })
          : [],
        error: response.ok && body.ok === true
          ? null
          : (typeof body.error === "string"
              ? body.error.slice(0, 240)
              : "Poll endpoint returned HTTP " + response.status + "."),
      };
    } catch (error) {
      result = {
        trigger: "scheduled",
        checkedAt: startedAt,
        ok: false,
        error: "Could not reach the Vercel poll endpoint or the request timed out.",
      };
    }
  }

  if (scheduledTime) result.scheduledTime = new Date(scheduledTime).toISOString();
  if (!result.ok || result.received > 0 || result.handled > 0) {
    console.log(JSON.stringify({
      event: "jarvis_poll_result",
      checkedAt: result.checkedAt,
      ok: result.ok,
      httpStatus: result.httpStatus || null,
      received: result.received || 0,
      handled: result.handled || 0,
      error: result.error || null,
    }));
  }
  return result;
}

async function readAgentHealth(env) {
  if (!env.CRON_SECRET) {
    return { ok: false, message: "CRON_SECRET is not configured in Cloudflare." };
  }
  try {
    const response = await fetch(agentBase(env) + "/api/whatsapp-agent/health", {
      method: "GET",
      headers: {
        Authorization: "Bearer " + env.CRON_SECRET,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    const body = await readResponse(response);
    return {
      ok: response.ok && body.ok === true,
      httpStatus: response.status,
      checks: body.checks || {},
      message: typeof body.message === "string"
        ? body.message
        : (typeof body.error === "string" ? body.error : "Health check completed."),
      readOnly: true,
    };
  } catch (error) {
    return {
      ok: false,
      message: "Could not reach the read-only health endpoint.",
      readOnly: true,
    };
  }
}

async function dashboardStatus(env) {
  const state = await loadDashboardState(env);
  const health = await readAgentHealth(env);
  return json({
    ok: true,
    scheduler: {
      cron: "*/15 * * * *",
      intervalMinutes: 15,
      activeListenMinutes: 14,
      activeListenText: "14 min 50 sec",
      timezone: "UTC",
      note: "Cloudflare long-polls WhatsApp for about 14 minutes 50 seconds of each 15-minute cycle, leaving a short safety gap. Scheduling and provider delays still mean zero delay cannot be guaranteed.",
    },
    storageReady: state.storageReady !== false,
    lastCronStart: state.lastCronStart || null,
    lastPoll: state.lastPoll || null,
    agentHealth: health,
    mode: "command-only",
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const authFailure = authorizeDashboard(request, env);
      if (authFailure) return authFailure;
      if (url.pathname === "/api/status" && request.method === "GET") {
        return dashboardStatus(env);
      }
      return json({ ok: false, error: "Not found." }, 404);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env) {
    const startedMs = Date.now();
    const stopAt = startedMs + LISTEN_WINDOW_MS;
    const cronStart = {
      startedAt: new Date(startedMs).toISOString(),
      scheduledTime: controller.scheduledTime
        ? new Date(controller.scheduledTime).toISOString()
        : null,
      cron: controller.cron || "*/15 * * * *",
      listenerWindowMinutes: 14,
    };

    const state = await loadDashboardState(env);
    state.lastCronStart = cronStart;
    await saveDashboardState(env, state);
    let lastSavedAt = Date.now();

    console.log(JSON.stringify({ event: "jarvis_long_poll_cycle_started", ...cronStart }));

    if (!env.CRON_SECRET) {
      state.lastPoll = {
        trigger: "scheduled",
        checkedAt: new Date().toISOString(),
        ok: false,
        error: "The CRON_SECRET secret is missing in Cloudflare.",
      };
      await saveDashboardState(env, state);
      throw new Error("CRON_SECRET is missing. Add it as a Cloudflare Worker secret.");
    }

    let pollCount = 0;
    let consecutiveFailures = 0;
    let finalResult = null;
    let stopReason = "time_window_elapsed";

    // GET /api/whatsapp-agent long-polls for up to 25 seconds and returns sooner
    // when an update arrives. This loop removes the usual two-minute cron gap.
    // The deadline guard gives the last upstream request time to finish.
    while (
      Date.now() + REQUEST_DEADLINE_BUFFER_MS < stopAt &&
      pollCount < MAX_POLLS_PER_RUN
    ) {
      finalResult = await runPoll(env, controller.scheduledTime);
      state.lastPoll = finalResult;
      pollCount += 1;

      if (finalResult.ok) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += 1;
        console.error(JSON.stringify({
          event: "jarvis_poll_failed",
          checkedAt: finalResult.checkedAt,
          error: finalResult.error || null,
          httpStatus: finalResult.httpStatus || null,
          consecutiveFailures: consecutiveFailures,
        }));
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          stopReason = "repeated_poll_failures";
          break;
        }
        await delay(RETRY_DELAY_MS);
      }

      if (Date.now() - lastSavedAt >= STATE_SAVE_INTERVAL_MS) {
        await saveDashboardState(env, state);
        lastSavedAt = Date.now();
      }
    }

    if (pollCount >= MAX_POLLS_PER_RUN) stopReason = "poll_safety_cap_reached";
    const finalSaved = await saveDashboardState(env, state);
    console.log(JSON.stringify({
      event: "jarvis_long_poll_cycle_finished",
      startedAt: cronStart.startedAt,
      finishedAt: new Date().toISOString(),
      pollCount: pollCount,
      stopReason: stopReason,
      finalPollOk: finalResult ? finalResult.ok : false,
      stateSaved: finalSaved,
    }));

    if (!finalSaved) {
      throw new Error("Jarvis polling ran, but Cloudflare KV could not save the dashboard status.");
    }
    if (stopReason === "repeated_poll_failures" || (finalResult && !finalResult.ok)) {
      throw new Error("Jarvis polling stopped after repeated failures. Check Worker logs and dashboard status.");
    }
  },
};
