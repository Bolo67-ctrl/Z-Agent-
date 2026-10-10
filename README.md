# Z-Agent

A personal AI agent built by **Bolo67-ctrl**.

## Vision
Z-Agent turns natural-language requests into useful work: reasoning, planning, tool use, coding, research, file work, and multi-step tasks.

## Stack
- Next.js
- TypeScript
- React
- Vercel AI SDK with the Google Gemini API
- Supabase

## Roadmap
- [x] V0 app foundation
- [ ] V1 streaming chat + agent loop
- [ ] Tool calling
- [x] Web research
- [ ] File access
- [ ] GitHub workspace tools
- [ ] Persistent memory
- [ ] Background tasks
- [ ] Vercel deployment
- [x] Initial WhatsApp Agent Platform polling/reply scaffold

## WhatsApp Agent Platform

An initial text-only integration scaffold is available in `app/api/whatsapp-agent/route.ts`. Setup instructions and known limitations are documented in [docs/whatsapp-agent.md](docs/whatsapp-agent.md).

The integration is not ready to be considered production-ready until the live API response shape and acknowledgement/idempotency requirements are verified, environment variables are configured, and a deployed test succeeds.

## Safety
Z-Agent should be highly capable while respecting authorization, privacy, and safety boundaries. Keep all API keys in server-side environment variables; never commit credentials.
