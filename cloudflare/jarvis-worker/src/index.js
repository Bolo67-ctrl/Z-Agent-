const DEFAULT_AGENT_URL = "https://z-agent-zeta.vercel.app";
const LAST_POLL_KEY = "last-poll-v1";

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

async function readResponse(response) {
  const raw = await response.text();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function saveLastPoll(env, result) {
  try {
    result.stateSaved = true;
    await env.POLL_STATE.put(LAST_POLL_KEY, JSON.stringify(result), {
      expirationTtl: 60 * 60 * 24 * 7,
    });
    return true;
  } catch (error) {
    result.stateSaved = false;
    console.error("Could not save the poll result to KV.", error);
    return false;
  }
}

async function runPoll(env, trigger, scheduledTime) {
  const startedAt = new Date().toISOString();
  let result;

  if (!env.CRON_SECRET) {
    result = {
      trigger,
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
        signal: AbortSignal.timeout(40000),
      });
      const body = await readResponse(response);

      result = {
        trigger,
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
        trigger,
        checkedAt: startedAt,
        ok: false,
        error: "Could not reach the Vercel poll endpoint or the request timed out.",
      };
    }
  }

  if (scheduledTime) result.scheduledTime = new Date(scheduledTime).toISOString();

  result.stateSaved = await saveLastPoll(env, result);
  console.log(JSON.stringify({
    trigger: result.trigger,
    checkedAt: result.checkedAt,
    ok: result.ok,
    httpStatus: result.httpStatus || null,
    received: result.received || 0,
    handled: result.handled || 0,
    stateSaved: result.stateSaved,
  }));

  return result;
}

async function readAgentHealth(env) {
  if (!env.CRON_SECRET) {
    return {
      ok: false,
      message: "CRON_SECRET is not configured in Cloudflare.",
    };
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
  let lastPoll = null;
  let storageReady = true;

  try {
    lastPoll = await env.POLL_STATE.get(LAST_POLL_KEY, "json");
  } catch (error) {
    storageReady = false;
  }

  const health = await readAgentHealth(env);

  return json({
    ok: true,
    scheduler: {
      cron: "*/2 * * * *",
      intervalMinutes: 2,
      timezone: "UTC",
      note: "Cloudflare runs this schedule without your Chromebook being on. Reply time is not guaranteed to be instant.",
    },
    storageReady,
    lastPoll: lastPoll || null,
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
    const result = await runPoll(env, "scheduled", controller.scheduledTime);
    if (!result.ok || !result.stateSaved) {
      console.error("Jarvis scheduled poll did not complete cleanly.");
    }
  },
};
