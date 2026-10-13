# Jarvis Cloudflare Worker and dashboard

This project keeps the existing Vercel WhatsApp endpoint and Supabase message deduplication. Cloudflare is the scheduled caller and dashboard host; it does not call the WhatsApp API directly.

## What it does

- Runs a Cloudflare Cron Trigger every two minutes (UTC).
- Calls the existing protected Vercel GET endpoint at /api/whatsapp-agent.
- Stores only the latest poll summary in Cloudflare KV for the dashboard. It does not store incoming WhatsApp message text, phone numbers, or message IDs.
- Provides a private dashboard at the Worker URL. The dashboard shows the last poll summary and performs a read-only health check.
- The dashboard refresh button does not run a poll and does not send a WhatsApp message.
- Uses no AI for WhatsApp command replies.

Two-minute polling is a free-tier-friendly compromise: about 720 scheduled runs and KV writes a day. It is not instant messaging; actual response time can be longer if Cloudflare scheduling or the WhatsApp API is delayed.

## Set up Cloudflare

1. In Cloudflare, open Workers & Pages, then go to Storage & Databases / KV. Create a namespace named JARVIS_POLL_STATE.
2. Copy the namespace ID. Replace REPLACE_WITH_YOUR_CLOUDFLARE_KV_NAMESPACE_ID in wrangler.jsonc with that ID, then commit the change to GitHub.
3. Open Workers & Pages and create an application by importing a Git repository. Connect Bolo67-ctrl/Z-Agent-.
4. Set the project root directory to /cloudflare/jarvis-worker. The Worker name in wrangler.jsonc is z-agent to match the existing Cloudflare project. The default deploy command npx wrangler deploy is suitable; the package includes Wrangler.
5. After the Worker is created, open its Settings / Variables and Secrets. Add these as secrets, not plain text variables:
   - CRON_SECRET: the exact same value as CRON_SECRET in Vercel Production.
   - DASHBOARD_TOKEN: create a new, strong, private token used only to sign in to this dashboard.
6. Confirm the Worker is deployed and has the cron trigger shown as */2 * * * *. Open its workers.dev URL to reach the dashboard, then enter DASHBOARD_TOKEN.
7. Wait for a scheduled run and confirm the dashboard shows a successful poll. Do not paste either secret into source control, this chat, or the dashboard URL.

## Prevent two pollers

The current GitHub Actions workflow still contains the old scheduled fallback. Do not leave both pollers active long-term, because the Vercel endpoint uses a shared WhatsApp cursor. First verify at least one Cloudflare scheduled poll is successful. Then open GitHub Actions, select “Poll WhatsApp Agent (Manual Fallback),” and disable that workflow's scheduled runs. Do not disable it before Cloudflare has been verified.

## Troubleshooting

- Unauthorized on the dashboard: make sure the DASHBOARD_TOKEN secret is set in Cloudflare and enter the same token in the dashboard login.
- Health check reports missing configuration: verify CRON_SECRET matches the Vercel Production secret and that Vercel has the Supabase production environment variables and migrations.
- No saved poll: wait for the first scheduled run and inspect the Worker's Cron Triggers / logs in Cloudflare.
- Poll status says normal replies are disabled: verify WHATSAPP_NORMAL_MODE_ENABLED is set to the literal true in Vercel Production.
- Poll storage unavailable: verify the KV namespace ID and POLL_STATE binding in wrangler.jsonc.
- Do not add the WhatsApp API token or Supabase service-role key to Cloudflare. The existing Vercel endpoint owns those credentials.

## Privacy and safety

The Worker only sees a summarized poll response, not the original message contents. The health endpoint is read-only. Both dashboard API routes require the DASHBOARD_TOKEN. The Vercel polling endpoint remains protected by CRON_SECRET.
