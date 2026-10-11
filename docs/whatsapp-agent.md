# WhatsApp Agent Platform integration

This integration lets the deployed Z-Agent backend poll a WhatsApp third-party agent and send AI-generated text replies. It is intentionally text-only in this first pass.

## Required Vercel environment variables

- `WHATSAPP_AGENT_API_TOKEN`: the API token shown in WhatsApp under the agent's Chat info > API key. Keep it secret.
- `CRON_SECRET`: a long random secret used to authenticate scheduled requests. The caller sends it as `Authorization: Bearer <CRON_SECRET>`.
- `GEMINI_API_KEY`: the Google Gemini API key used by both website chat and WhatsApp replies. Create it in [Google AI Studio](https://aistudio.google.com/app/apikey).
- `GEMINI_MODEL` (optional): Gemini model ID. Defaults to `gemini-3.8-flash`.
- `SUPABASE_SERVICE_ROLE_KEY`: required for both the deduplicated Preview test and normal WhatsApp polling. Add it as a **server-only sensitive** Vercel variable; never use the publishable key for database writes.
- `WHATSAPP_NORMAL_MODE_ENABLED`: must be set to the literal `true` before normal replies can run. Leave it unset during Preview safety testing; disabling `WHATSAPP_TEST_MODE` alone will not enable regular replies.

Vercel environment variable names are case-sensitive. The code reads the exact uppercase names above; similarly named lowercase variables are not aliases. Production must remain disabled until its required uppercase server-side variables are configured and reviewed. Do not copy Preview secrets into Production without an explicit decision.

Never commit real credentials to GitHub or expose them in client-side code.

## Deploy and configure

1. Deploy the `whatsapp-agent-platform` branch to Vercel as a Preview, or merge it after reviewing the changes.
2. Apply `supabase/migrations/20261010000000_whatsapp_agent_reliability.sql` and then `supabase/migrations/20261011000000_whatsapp_conversation_history.sql` to the intended Supabase project (for example, paste each file into the Supabase SQL Editor and run them). The first creates the polling cursor, deduplication table, and restricted claim function. The second adds inbound/reply text fields to support conversational memory.
3. Add `WHATSAPP_AGENT_API_TOKEN`, `CRON_SECRET`, and `GEMINI_API_KEY` to Vercel. Add `SUPABASE_SERVICE_ROLE_KEY` as a sensitive server-only variable for Preview first; never prefix it with `NEXT_PUBLIC_`. Optionally set `GEMINI_MODEL`, then redeploy Preview.
4. Keep `WHATSAPP_TEST_MODE=true` and leave `WHATSAPP_NORMAL_MODE_ENABLED` unset during safety testing. Use the authenticated **Initialize cursor once** action on `/whatsapp-test`. The page uses a fresh one-time test phrase; the earlier phrase is intentionally retired. It reads retained updates using offset/next_offset metadata only and advances until the current buffer is empty, without inspecting message contents, processing messages, marking them read, or replying. If the buffer is empty, it waits up to 25 seconds for a new update to establish a starting cursor; send a harmless message to Jarvis while it waits. If it returns HTTP 409 stating that no update arrived, the cursor remains unchanged and may be safely retried once. Do not use the poll button for this step.
5. Normal replies require both disabling test mode and separately setting `WHATSAPP_NORMAL_MODE_ENABLED=true`. Do not enable these switches until you've reviewed the bootstrap result and intentionally chosen to start normal traffic handling. There is no scheduled poll configured by these instructions.
6. Configure GitHub Actions with a `CRON_SECRET` repository secret matching Vercel's Production value and set the repository variable `WHATSAPP_POLLING_ENABLED=true` to permit manual runs. Scheduled runs poll the stable Production domain every five minutes (GitHub can delay scheduled events); manual runs remain gated unless the opt-in variable is set. The workflow uses `https://z-agent-zeta.vercel.app` directly so it does not hit a protected deployment-specific preview URL.

The endpoint requires the `Authorization: Bearer <CRON_SECRET>` header. Do not make the route public by removing this check.

## Current limitations

- The endpoint only handles inbound text messages with a `text.body` field.
- It accepts flat and nested `entry[].changes[].value.messages` update payloads and advances a saved `next_offset` cursor.
- Both test and normal modes use durable message-ID claims and a pre-send terminal lock to suppress duplicate replies; successfully replied-to messages are marked as read. If a send request fails ambiguously, the message is marked `uncertain` and is not automatically resent.
- The first normal-mode poll deliberately bootstraps the cursor and skips the current queue. Review the skipped count before testing normal mode.
- With the conversation-history migration installed, the last eight successful turns from the same sender are supplied to Gemini for follow-up context. Saved inbound and reply text is cleared after 30 days on subsequent polls; message IDs and delivery statuses remain for deduplication. Without the migration, replies still work but each message is treated independently.
- The external send and database write cannot form one atomic transaction. To prefer no duplicates over automatic recovery, the poller commits a terminal `uncertain` state before attempting each send. If sending or the later `sent` update is ambiguous, that message is never automatically resent; a crash after the lock but before the actual send can therefore result in a missed reply. True exactly-once delivery requires provider-supported send idempotency.
- GitHub Actions polling every five minutes is not instant and scheduled runs can be delayed.
- AI-generated replies are limited to 4,000 characters.
- Reminder scheduling, media, voice transcription, and tool execution are not included yet.

## Privacy

Third-party agent chats are not end-to-end encrypted like ordinary personal WhatsApp chats. The conversational-history migration stores message and reply text in the private Supabase table for continuity; the poller clears that text after 30 days on subsequent polls. Do not send sensitive information to the agent. Keep API tokens in server-side environment variables only.
