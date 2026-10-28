-- Myla core schema (Phase 1)
--
-- Single-user design: every row belongs to one signed-in user, and Row Level
-- Security (RLS) stops anyone else from reading or changing it.
-- Run this once, on a fresh Supabase project, in the SQL Editor.
--
-- Tables: devices, settings, tasks, reminders, memory_items, attention_signals,
--         conversations, messages, tool_calls (the audit log)

-- ---------------------------------------------------------------------------
-- Helper: keep updated_at current
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- devices: the phone now, the PC later. Used to route device tools.
-- ---------------------------------------------------------------------------
create table public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  platform text not null default 'android' check (platform in ('android', 'desktop')),
  push_token text,
  granted_permissions jsonb not null default '{}'::jsonb,
  registered_at timestamptz not null default now(),
  last_seen_at timestamptz
);

-- ---------------------------------------------------------------------------
-- settings: one row per user. Quiet hours, summary time, nudge cap, switches.
-- Timezone starts as UTC on purpose; you set your own.
-- ---------------------------------------------------------------------------
create table public.settings (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  timezone text not null default 'UTC',
  quiet_hours_start time,
  quiet_hours_end time,
  morning_summary_time time,
  nudge_daily_cap integer not null default 5 check (nudge_daily_cap >= 0),
  switches jsonb not null default
    '{"reminders": true, "morning_summary": true, "overdue_nudges": true, "suggestions": true}'::jsonb,
  updated_at timestamptz not null default now()
);

create trigger settings_set_updated_at
  before update on public.settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- tasks: the source of truth for "what do I have to do today?"
-- ---------------------------------------------------------------------------
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null check (length(trim(title)) > 0),
  notes text,
  due_at timestamptz,
  project text,
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index tasks_user_status_due_idx on public.tasks (user_id, status, due_at);

create trigger tasks_set_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- reminders: the server keeps the canonical copy; the phone schedules a local
-- alarm for each one and reports delivery back, so "did it go off?" has a
-- truthful answer.
-- ---------------------------------------------------------------------------
create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  task_id uuid references public.tasks (id) on delete set null,
  title text not null check (length(trim(title)) > 0),
  remind_at timestamptz not null,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'delivered', 'missed', 'cancelled')),
  delivered_at timestamptz,
  delivered_on_device uuid references public.devices (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index reminders_user_status_time_idx on public.reminders (user_id, status, remind_at);

create trigger reminders_set_updated_at
  before update on public.reminders
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- memory_items: only what you stated, or suggestions you approved.
-- 'pending' rows are suggestions waiting for your yes (personal details).
-- ---------------------------------------------------------------------------
create table public.memory_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  content text not null check (length(trim(content)) > 0),
  kind text not null default 'fact'
    check (kind in ('fact', 'project', 'commitment', 'preference', 'personal')),
  source text not null default 'stated' check (source in ('stated', 'approved_suggestion')),
  status text not null default 'active' check (status in ('active', 'pending')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index memory_items_user_status_idx on public.memory_items (user_id, status);

create trigger memory_items_set_updated_at
  before update on public.memory_items
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- attention_signals: what you acted on or dismissed. Visible and deletable.
-- They only become rules after you approve a suggestion.
-- ---------------------------------------------------------------------------
create table public.attention_signals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  source text not null,
  item_ref text,
  action text not null check (action in ('acted', 'dismissed', 'opened', 'ignored')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index attention_signals_user_time_idx on public.attention_signals (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- conversations and messages: one thread shared by text and voice, and by
-- every device.
-- ---------------------------------------------------------------------------
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool', 'system')),
  content text not null,
  input_mode text not null default 'text' check (input_mode in ('text', 'voice')),
  created_at timestamptz not null default now()
);

create index messages_conversation_time_idx on public.messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- tool_calls: the audit log. Written only by the backend (service role), so
-- the app can read it but never edit it.
-- Tier: 1 read low risk, 2 read sensitive, 3 act reversible,
--       4 act consequential, 5 never automatic.
-- ---------------------------------------------------------------------------
create table public.tool_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  tool_name text not null,
  tier smallint not null check (tier between 1 and 5),
  executor text not null check (executor in ('server', 'device')),
  device_id uuid references public.devices (id) on delete set null,
  input_summary text,
  result_summary text,
  status text not null default 'pending'
    check (status in ('pending', 'awaiting_confirmation', 'succeeded', 'failed', 'cancelled')),
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create index tool_calls_user_time_idx on public.tool_calls (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security: a signed-in user sees and changes only their own rows.
-- ---------------------------------------------------------------------------
alter table public.devices enable row level security;
alter table public.settings enable row level security;
alter table public.tasks enable row level security;
alter table public.reminders enable row level security;
alter table public.memory_items enable row level security;
alter table public.attention_signals enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.tool_calls enable row level security;

create policy "owner full access" on public.devices
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "owner full access" on public.settings
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "owner full access" on public.tasks
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "owner full access" on public.reminders
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "owner full access" on public.memory_items
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "owner full access" on public.attention_signals
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "owner full access" on public.conversations
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "owner full access" on public.messages
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- The audit log is read-only for the app.
create policy "owner can read" on public.tool_calls
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Grants. Signed-out visitors get nothing. Signed-in users get what the
-- policies above then narrow down. The backend (service role) gets everything.
-- Explicit grants are included because Supabase has been moving to require
-- them for the Data API; they are harmless if already present.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;

grant select, insert, update, delete on
  public.devices,
  public.settings,
  public.tasks,
  public.reminders,
  public.memory_items,
  public.attention_signals,
  public.conversations,
  public.messages
to authenticated;

grant select on public.tool_calls to authenticated;

grant all on all tables in schema public to service_role;
