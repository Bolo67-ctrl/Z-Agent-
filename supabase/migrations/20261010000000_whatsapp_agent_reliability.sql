-- Durable cursor and idempotency records for the WhatsApp Agent poller.
-- Message text is deliberately not stored.

create table if not exists public.whatsapp_agent_poll_state (
  id text primary key check (id = 'default'),
  next_offset bigint null,
  updated_at timestamptz not null default now()
);

insert into public.whatsapp_agent_poll_state (id, next_offset)
values ('default', null)
on conflict (id) do nothing;

create table if not exists public.whatsapp_agent_messages (
  message_id text primary key,
  sender text not null,
  status text not null check (status in ('processing', 'sent', 'failed', 'uncertain')),
  lease_until timestamptz null,
  attempts integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.whatsapp_agent_poll_state enable row level security;
alter table public.whatsapp_agent_messages enable row level security;

revoke all on public.whatsapp_agent_poll_state from public, anon, authenticated;
revoke all on public.whatsapp_agent_messages from public, anon, authenticated;
grant all on public.whatsapp_agent_poll_state to service_role;
grant all on public.whatsapp_agent_messages to service_role;

create or replace function public.claim_whatsapp_agent_message(
  p_message_id text,
  p_sender text,
  p_lease_seconds integer default 300
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_claimed text;
begin
  if p_message_id is null or length(p_message_id) = 0
     or p_sender is null or length(p_sender) = 0 then
    return false;
  end if;

  insert into public.whatsapp_agent_messages (
    message_id, sender, status, lease_until, attempts, created_at, updated_at
  )
  values (
    p_message_id,
    p_sender,
    'processing',
    v_now + make_interval(secs => greatest(coalesce(p_lease_seconds, 300), 60)),
    1,
    v_now,
    v_now
  )
  on conflict (message_id) do nothing;

  if found then
    return true;
  end if;

  update public.whatsapp_agent_messages
  set sender = p_sender,
      status = 'processing',
      lease_until = v_now + make_interval(secs => greatest(coalesce(p_lease_seconds, 300), 60)),
      attempts = attempts + 1,
      updated_at = v_now
  where message_id = p_message_id
    and (
      status = 'failed'
      or (status = 'processing' and lease_until < v_now)
    )
  returning message_id into v_claimed;

  return v_claimed is not null;
end;
$$;

revoke all on function public.claim_whatsapp_agent_message(text, text, integer) from public, anon, authenticated;
grant execute on function public.claim_whatsapp_agent_message(text, text, integer) to service_role;
