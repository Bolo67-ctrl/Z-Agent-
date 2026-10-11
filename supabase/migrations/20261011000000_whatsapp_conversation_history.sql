-- Keep recent WhatsApp turns so Jarvis can understand follow-up messages.
-- The existing idempotency row remains the source of truth for delivery status.
alter table public.whatsapp_agent_messages
  add column if not exists inbound_text text,
  add column if not exists reply_text text;

comment on column public.whatsapp_agent_messages.inbound_text is
  'Inbound user text for conversational context; cleared by the poller after 30 days.';
comment on column public.whatsapp_agent_messages.reply_text is
  'Jarvis reply text for conversational context; cleared by the poller after 30 days.';

create index if not exists whatsapp_agent_messages_conversation_context_idx
  on public.whatsapp_agent_messages (sender, created_at desc)
  where status = 'sent' and inbound_text is not null and reply_text is not null;
