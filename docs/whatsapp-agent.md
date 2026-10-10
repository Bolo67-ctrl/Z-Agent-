# WhatsApp Agent Platform integration

This integration lets the deployed Z-Agent backend poll a WhatsApp third-party agent and send AI-generated text replies. It is intentionally text-only in this first pass.

## Required Vercel environment variables

- `WHATSAPP_AGENT_API_TOKEN`: the API token shown in WhatsApp under the agent's Chat info > API key. Keep it secret.
- `CRON_SECRET`: a long random secret used by Vercel Cron to authenticate scheduled requests. Vercel sends it as `Authorization: Bearer <CRON_SECRET>`.
- `AI_GATEWAY_API_KEY`: the Vercel AI Gateway key used by the existing Z-Agent model configuration.

Never commit real credentials to GitHub or expose them in client-side code.

## Deploy and configure

1. Deploy the `whatsapp-agent-platform` branch to Vercel, or merge it after reviewing the changes.
2. Add the three environment variables above to the Vercel project settings, then redeploy.
3. Ensure Vercel Cron is available for the project plan. The included `vercel.json` schedules `/api/whatsapp-agent` once per minute.
4. Send a simple text message in the Jarvis agent chat and inspect the Vercel function logs for the cron invocation.

The endpoint requires Vercel Cron's `Authorization: Bearer <CRON_SECRET>` header, supplied when `CRON_SECRET` is configured. Do not make the route public by removing this check.

## Current limitations

- The endpoint only handles inbound text messages with a `text.body` field.
- It assumes the documented updates response contains a `messages` array (or an `updates` array of message-like objects). Confirm the live response shape against the current WhatsApp developer manual before relying on it.
- It does not yet implement message acknowledgement/status updates or durable idempotency. Verify the API's delivery/acknowledgement semantics before production use, otherwise retries could produce duplicate replies.
- Polling once a minute means replies are not instant.
- AI-generated replies are limited to 4,000 characters.
- Reminder scheduling, persistent WhatsApp conversation history, media, voice transcription, and tool execution are not included yet.

## Privacy

Third-party agent chats are not end-to-end encrypted like ordinary personal WhatsApp chats. Do not send sensitive information to the agent. Keep API tokens in server-side environment variables only.
