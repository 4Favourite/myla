-- Phase 8e: email rules can match a word or phrase, not only a sender.
-- Run once in the Supabase SQL Editor. Safe to run twice.
alter table public.attention_rules
  add column if not exists match_type text not null default 'sender'
  check (match_type in ('sender', 'keyword'));
