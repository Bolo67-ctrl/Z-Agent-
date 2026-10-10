# WhatsApp Agent Platform integration

This integration lets the deployed Z-Agent backend poll a WhatsApp third-party agent and send AI-generated text replies. It is intentionally text-only in this first pass.

## Required Vercel environment variables

- `WHATSAPP_AGENT_API_TOKEN`: the API token shown in WhatsApp under the agent's Chat info > API key. Keep it secret.
- `CRON_SECRET`: a long random secret used to authenticate scheduled requests. The caller sends it as `Authorization: Bearer <CRON_SECRET>`.
- `GEMINI_API_KEY`: the Google Gemini API key used by both website chat and WhatsApp replies. Create it in [Google AI Studio](https://aistudio.google.com/app/apikey).
- `GEMINI_MODEL` (optional): Gemini model ID. Defaults to `gemini-3.8-flash`.
- `SUPABASE_SERVICE_ROLE_KEY`: required only for normal (non-test) WhatsApp polling. Add it as a **server-only sensitive** Vercel variable; never use the publishable key for the poller's database writes.
- `WHATSAPP_NORMAL_MODE_ENABLED`: must be set to the literal `true` before normal replies can run. Leave it unset during Preview safety testing; disabling `WHATSAPP_TEST_MODE` alone will not enable regular replies.

Never commit real credentials to GitHub or expose them in client-side code.

## Deploy and configure

1. Deploy the `whatsapp-agent-platform` branch to Vercel as a Preview, or merge it after reviewing the changes.
2. Apply `supabase/migrations/20261010000000_whatsapp_agent_reliability.sql` to the intended Supabase project (for example, paste it into the Supabase SQL Editor and run it). It creates a polling cursor table, a message-id deduplication table, and a restricted claim function. Message text is not stored.
3. Add `WHATSAPP_AGENT_API_TOKEN`, `CRON_SECRET`, and `GEMINI_API_KEY` to Vercel. Add `SUPABASE_SERVICE_ROLE_KEY` as a sensitive server-only variable for Preview first; never prefix it with `NEXT_PUBLIC_`. Optionally set `GEMINI_MODEL`, then redeploy Preview.
4. Keep `WHATSAPP_TEST_MODE=true` and leave `WHATSAPP_NORMAL_MODE_ENABLED` unset during safety testing. Use the authenticated **Initialize cursor once** action on `/whatsapp-test` to save the provider's current starting offset; this makes one updates request but does not process, mark read, or reply to messages. Confirm its result before continuing. Do not use the poll button for this step.
5. Normal replies require both disabling test mode and separately setting `WHATSAPP_NORMAL_MODE_ENABLED=true`. Do not enable these switches until you've reviewed the bootstrap result and intentionally chosen to start normal traffic handling. There is no scheduled poll configured by these instructions.
5. Only after Preview behavior is verified, configure GitHub Actions with a `CRON_SECRET` secret and a `WHATSAPP_AGENT_URL` variable for that same Preview deployment. The workflow at `.github/workflows/whatsapp-agent-poll.yml` is scheduled every five minutes when installed on the default branch; do not point it at Production until separately reviewed.

The endpoint requires the `Authorization: Bearer <CRON_SECRET>` header. Do not make the route public by removing this check.

## Current limitations

- The endpoint only handles inbound text messages with a `text.body` field.
- It accepts flat and nested `entry[].changes[].value.messages` update payloads and advances a saved `next_offset` cursor.
- Normal mode uses durable message-ID claims to suppress duplicate replies and marks successfully replied-to messages as read. If a send request fails ambiguously, the message is marked `uncertain` and is not automatically resent.
- The first normal-mode poll deliberately bootstraps the cursor and skips the current queue. Review the skipped count before testing normal mode.
- The external send and the database write cannot form one atomic transaction. The guard substantially reduces duplicates, but a hard crash between a successful send and saving its state cannot be guaranteed exactly-once without provider-supported send idempotency.
- GitHub Actions polling every five minutes is not instant and scheduled runs can be delayed.
- AI-generated replies are limited to 4,000 characters.
- Reminder scheduling, persistent WhatsApp conversation history, media, voice transcription, and tool execution are not included yet.

## Privacy

Third-party agent chats are not end-to-end encrypted like ordinary personal WhatsApp chats. Do not send sensitive information to the agent. Keep API tokens in server-side environment variables only.
