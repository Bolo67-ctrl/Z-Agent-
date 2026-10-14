# Jarvis Cloudflare Worker and dashboard

This project keeps the existing Vercel WhatsApp endpoint and Supabase message deduplication. Cloudflare is the scheduled caller and dashboard host; it does not call the WhatsApp API directly.

## What it does

- A Cron Trigger starts every 15 minutes (UTC).
- Each invocation makes sequential long-poll requests for about 14 minutes, then leaves a safety gap before the next scheduled run.
- Each long poll waits up to 25 seconds for a WhatsApp update and calls the existing protected Vercel GET endpoint at /api/whatsapp-agent.
- The listener stops after 42 outbound poll calls per run to stay below Cloudflare Free's 50 external-subrequest limit.
- It stores only a short poll summary in Cloudflare KV. It does not store incoming WhatsApp message text, phone numbers, or message IDs.
- The private dashboard shows poll results and read-only connection health. Refreshing the dashboard does not send messages or start another poller.
- WhatsApp command replies use no AI.

This free-plan compromise should make command replies prompt while the long-poll loop is active. A short gap between cycles, Cron scheduling delays, WhatsApp API delays, or errors may still occur. It is not a guarantee of instant delivery.

## Set up Cloudflare

1. In Cloudflare, create or confirm the KV namespace named JARVIS_POLL_STATE.
2. Confirm its namespace ID in wrangler.jsonc.
3. The GitHub repository Bolo67-ctrl/Z-Agent- should use root directory /cloudflare/jarvis-worker. The Worker name is z-agent. Leave the build command empty and keep the deploy command as npx wrangler deploy.
4. In Worker Settings / Variables and Secrets, add the following as secrets, not plain text variables:
   - CRON_SECRET: the exact same value as CRON_SECRET in Vercel Production.
   - DASHBOARD_TOKEN: a strong private token used only to sign in to this dashboard.
5. Confirm the Worker cron trigger is */15 * * * *. Open the workers.dev URL and enter DASHBOARD_TOKEN.
6. Check the Worker logs for jarvis_long_poll_cycle_started and jarvis_long_poll_cycle_finished. Dashboard state is written every 2.5 minutes and at the end of each cycle. Do not paste secrets into source control, this chat, or the dashboard URL.

## Prevent two pollers

Cloudflare is the primary scheduled poller. The GitHub Actions fallback is manual-only and requires the repository variable WHATSAPP_POLLING_ENABLED=true before it can run. Do not enable that fallback while Cloudflare is polling, because the Vercel endpoint uses a shared WhatsApp cursor.

## Troubleshooting

- Unauthorized on the dashboard: ensure DASHBOARD_TOKEN exists as a Cloudflare Worker Secret and enter the same current token in the dashboard login.
- Health check reports missing configuration: verify CRON_SECRET matches Vercel Production and Vercel has the Supabase production environment variables and migrations.
- No saved poll: inspect Cron Trigger events and Worker logs; the cycle writes a heartbeat at start and poll state every 2.5 minutes.
- Poll status says normal replies are disabled: verify WHATSAPP_NORMAL_MODE_ENABLED is the literal true in Vercel Production.
- Poll storage unavailable: verify the POLL_STATE binding and namespace ID in wrangler.jsonc.
- Do not add the WhatsApp API token or Supabase service-role key to Cloudflare. The existing Vercel endpoint owns those credentials.

## Privacy and safety

The Worker only sees summarized poll results, not original message contents. The health endpoint is read-only. Dashboard API access requires DASHBOARD_TOKEN. The Vercel polling endpoint remains protected by CRON_SECRET.
