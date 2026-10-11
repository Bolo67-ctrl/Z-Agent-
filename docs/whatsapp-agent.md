# Jarvis WhatsApp command bot

Jarvis replies to explicit slash commands. WhatsApp command replies do **not** call Gemini or any AI model, so responses are deterministic and have no AI-generation delay.

## Commands

| Command | Action |
| --- | --- |
| `/help` or `/start` | Show the command list |
| `/ping` | Reply `Pong!` |
| `/time` | Show current UTC date and time |
| `/status` | Show command-bot mode |
| `/about` | Show the bot description |

Commands are case-insensitive. Ordinary text messages are ignored; unknown slash commands receive a short help prompt. Admin actions can be added later with sender allow-lists and permission checks.

## Required production environment

- `WHATSAPP_AGENT_API_TOKEN`: the API token shown in WhatsApp under the agent's Chat info > API key. Keep it secret.
- `CRON_SECRET`: a long random secret used to authenticate the poll endpoint. Callers send it as `Authorization: Bearer <CRON_SECRET>`.
- `NEXT_PUBLIC_SUPABASE_URL`: the Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: server-only service role key for message claims and deduplication. Never expose it in client code or a `NEXT_PUBLIC_` variable.
- `WHATSAPP_NORMAL_MODE_ENABLED`: must be the literal `true` before normal replies can run.
- `WHATSAPP_TEST_MODE`: keep `true` only in Preview testing; leave it unset or `false` for normal Production operation.

**Gemini is not required for WhatsApp command replies.** The website's separate chat feature may still use its own AI configuration.

## Database setup

Apply `supabase/migrations/20261010000000_whatsapp_agent_reliability.sql` to create the polling cursor and deduplication/claim function. The previously applied `20261011000000_whatsapp_conversation_history.sql` added history columns for the earlier AI-chat version; command mode no longer writes conversation text, and the poller clears old stored context text older than 30 days.

## Message receiver and latency

The WhatsApp Agent API used by this integration exposes inbound messages through `GET /updates` long polling. The Vercel endpoint keeps each poll open for up to 25 seconds, then returns and can be called again. When an update arrives while a long poll is waiting, a command can be handled without waiting for an AI model.

The endpoint is protected by `CRON_SECRET`; **do not remove the authorization check**.

- `scripts/whatsapp-agent-worker.mjs` is the continuous-listener program. It needs an always-on Node.js runtime with `AGENT_URL` set to `https://z-agent-zeta.vercel.app` and `CRON_SECRET` set to the same value as Vercel Production.
- The worker is source code only; it is **not currently deployed or running**. Creating an always-on hosted worker may cost money depending on the host and plan.
- `.github/workflows/whatsapp-agent-poll.yml` runs a free GitHub Actions poll every five minutes. GitHub may delay scheduled runs, so this fallback is automatic but not instant. Manual dispatch stays opt-in behind `WHATSAPP_POLLING_ENABLED=true`.
- Do not run multiple pollers concurrently. A single active listener should own the update cursor.

## Reliability and privacy

- Only inbound text messages beginning with `/` are handled in normal command mode.
- Message IDs are claimed in Supabase before processing. A terminal pre-send lock reduces duplicate replies when delivery is ambiguous.
- A first-time poll initializes its update cursor and intentionally skips the already queued messages, rather than answering an unknown backlog.
- The reply send and database write cannot form one atomic transaction. If the messaging provider's send result is ambiguous, the bot blocks an automatic resend to avoid duplicate messages.
- The bot does not use AI to compose WhatsApp command replies and does not save new inbound text/reply text for conversation memory.
- Third-party agent chats are not end-to-end encrypted like ordinary personal WhatsApp chats. Do not send secrets or sensitive data in messages.
