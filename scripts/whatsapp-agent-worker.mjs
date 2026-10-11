/**
 * Always-on listener for WhatsApp Agent Platform.
 *
 * The platform delivers inbound messages through GET /updates long polling rather
 * than a public webhook. This worker continuously calls the protected Vercel route;
 * the route holds one 25-second WhatsApp long poll, safely processes updates, and
 * returns only after that batch is accounted for.
 */
const DEFAULT_AGENT_URL = "https://z-agent-zeta.vercel.app";
const AGENT_URL = (process.env.AGENT_URL || DEFAULT_AGENT_URL).replace(/\/+$/, "");
const CRON_SECRET = process.env.CRON_SECRET;

const REQUEST_TIMEOUT_MS = 125_000;
const MIN_REQUEST_INTERVAL_MS = 4_100; // stay below the provider's 15-polls/minute limit
const MAX_BACKOFF_MS = 30_000;

if (!CRON_SECRET) {
  console.error("[Jarvis worker] Missing required environment variable: CRON_SECRET");
  process.exit(1);
}

let stopping = false;
let activeController = null;

function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[Jarvis worker] Received ${signal}; stopping cleanly.`);
  activeController?.abort();
}

process.once("SIGTERM", () => stop("SIGTERM"));
process.once("SIGINT", () => stop("SIGINT"));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

let consecutiveFailures = 0;

while (!stopping) {
  const startedAt = Date.now();
  let delayAfterRequest = MIN_REQUEST_INTERVAL_MS;

  try {
    activeController = new AbortController();
    const watchdog = setTimeout(() => activeController?.abort(), REQUEST_TIMEOUT_MS);
    watchdog.unref?.();

    let response;
    let responseText;
    try {
      response = await fetch(`${AGENT_URL}/api/whatsapp-agent`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${CRON_SECRET}`,
          Accept: "application/json",
        },
        cache: "no-store",
        redirect: "error",
        signal: activeController.signal,
      });
      responseText = await response.text();
    } finally {
      clearTimeout(watchdog);
      activeController = null;
    }

    if (stopping) break;
    if (!response.ok) {
      throw new Error(`poll endpoint returned HTTP ${response.status}`);
    }

    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      throw new Error("poll endpoint returned invalid JSON");
    }

    if (result?.ok !== true) {
      consecutiveFailures += 1;
      const providerErrors = Array.isArray(result?.errors)
        ? result.errors.filter((value) => typeof value === "string").slice(0, 3).join("; ")
        : typeof result?.error === "string"
          ? result.error
          : "no error details";
      console.error("[Jarvis worker] Poll reported failure:", providerErrors);
      const backoff = Math.min(2_000 * (2 ** Math.min(consecutiveFailures - 1, 4)), MAX_BACKOFF_MS);
      delayAfterRequest = Math.max(delayAfterRequest, backoff);
    } else {
      consecutiveFailures = 0;
      console.log(
        `[Jarvis worker] Poll OK; received=${asCount(result.received)}, handled=${asCount(result.handled)}, skipped=${asCount(result.skipped)}`
      );
    }
  } catch (error) {
    activeController = null;
    if (stopping) break;

    consecutiveFailures += 1;
    const message = error instanceof Error ? error.message : "unknown connection error";
    console.error("[Jarvis worker] Poll request failed:", message);
    const backoff = Math.min(2_000 * (2 ** Math.min(consecutiveFailures - 1, 4)), MAX_BACKOFF_MS);
    delayAfterRequest = Math.max(delayAfterRequest, backoff);
  }

  if (!stopping) {
    const elapsed = Date.now() - startedAt;
    await sleep(Math.max(0, delayAfterRequest - elapsed));
  }
}

console.log("[Jarvis worker] Stopped.");
