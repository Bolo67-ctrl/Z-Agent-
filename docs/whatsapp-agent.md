# WhatsApp Agent Platform integration

This integration lets the deployed Z-Agent backend poll a WhatsApp third-party agent and send AI-generated text replies. It is intentionally text-only in this first pass.

## Required Vercel environment variables

- `WHATSAPP_AGENT_API_TOKEN`: the API token shown in WhatsApp under the agent's Chat info > API key. Keep it secret.
- `CRON_SECRET`: a long random secret used to authenticate scheduled requests. The caller sends it as `Authorization: Bearer <CRON_SECRET>`.
- `GEMINI_API_KEY`: the Google Gemini API key used by both website chat and WhatsApp replies. Create it in [Google AI Studio](https://aistudio.google.com/app/apikey).
- `GEMINI_MODEL` (optional): Gemini model ID. Defaults to `gemini-3.8-flash`.

Never commit real credentials to GitHub or expose them in client-side code.

## Deploy and configure

1. Deploy the `whatsapp-agent-platform` branch to Vercel as a Preview, or merge it after reviewing the changes.
2. Add `WHATSAPP_AGENT_API_TOKEN`, `CRON_SECRET`, and `GEMINI_API_KEY` to the Vercel project settings. Optionally set `GEMINI_MODEL`, then redeploy the Preview/Production deployment.
3. In GitHub repository Settings > Secrets and variables > Actions, add a repository secret named `CRON_SECRET` with the same value used in Vercel. Add a repository variable named `WHATSAPP_AGENT_URL` containing the deployed base URL (no trailing slash), for example the Vercel Production URL after the integration is merged and deployed.
4. The workflow at `.github/workflows/whatsapp-agent-poll.yml` polls every five minutes on the default branch and can also be started manually from Actions. GitHub scheduled workflows run from the default branch; the workflow must be merged into the default branch for scheduled polling to run automatically.
5. Send a simple text message in the Jarvis agent chat and inspect the Vercel function logs and GitHub Actions run logs.

The endpoint requires the `Authorization: Bearer <CRON_SECRET>` header. Do not make the route public by removing this check.

## Current limitations

- The endpoint only handles inbound text messages with a `text.body` field.
- It assumes the documented updates response contains a `messages` array (or an `updates` array of message-like objects). Confirm the live response shape against the current WhatsApp developer manual before relying on it.
- It does not yet implement message acknowledgement/status updates or durable idempotency. Verify the API's delivery/acknowledgement semantics before production use, otherwise retries could produce duplicate replies.
- GitHub Actions polling every five minutes is not instant and scheduled runs can be delayed.
- AI-generated replies are limited to 4,000 characters.
- Reminder scheduling, persistent WhatsApp conversation history, media, voice transcription, and tool execution are not included yet.

## Privacy

Third-party agent chats are not end-to-end encrypted like ordinary personal WhatsApp chats. Do not send sensitive information to the agent. Keep API tokens in server-side environment variables only.
