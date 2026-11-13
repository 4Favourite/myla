-- Phase 8d: what matters to you in your email.
-- Rules are only ever created after you approve a suggestion (or by you).
-- Run once in the Supabase SQL Editor. Safe to run twice.
create table if not exists public.attention_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  source text not null default 'gmail',
  sender text not null check (length(trim(sender)) > 0),
  kind text not null check (kind in ('important', 'quiet')),
  -- 'rejected' remembers that you said no, so the same suggestion is not repeated
  status text not null default 'active' check (status in ('active', 'rejected')),
  reason text,
  created_at timestamptz not null default now(),
  unique (user_id, source, sender, kind)
);

alter table public.attention_rules enable row level security;

drop policy if exists "owner full access" on public.attention_rules;
create policy "owner full access" on public.attention_rules
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.attention_rules to authenticated;
grant all on public.attention_rules to service_role;
