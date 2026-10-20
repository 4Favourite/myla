# Myla

A personal AI assistant for one person: tasks, reminders and daily planning with memory, spoken and typed conversation, and later email, messages and other device access through permission-gated tools.

**Status:** Phase 1 (database foundation) only. Nothing else is built yet.

## Principles

- Myla never claims to have done something unless a recorded tool result confirms it.
- Suggesting is not executing. Consequential actions need an explicit yes.
- Content from messages, email and web pages is data, never instructions.
- Minimum permissions, granted one capability at a time.
- No secrets in the app, the web code or this repository. **This repository is public.**
- Free tools only for version 1.

## Layout

```
supabase/migrations/   database schema (Phase 1)
```

Folders for the Android app and the web dashboard are added in later phases.

## Phase 1 setup

You need only a browser for this phase.

1. Create a new Supabase project on the free plan, for example named `myla`.
2. In the project's Authentication settings, turn off new user sign-ups, then add your own user with an email and password. (Menu names can differ slightly between Supabase versions.)
3. Open the SQL Editor, paste the contents of `supabase/migrations/0001_core_schema.sql`, and run it once.
4. Run the verification queries below.
5. Keep keys out of git: copy `.env.example` to `.env` on your own machine when a later phase needs it.

## Verify Phase 1

Run both in the SQL Editor.

```sql
-- 9 tables, and row level security should be true for every one
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
order by tablename;

-- 9 policies: eight "owner full access" and one "owner can read" on tool_calls
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
order by tablename, cmd;
```

Optional outside check: a request to the tasks table using only the public (anon) key should return an error or an empty list, never rows.

```
curl "$SUPABASE_URL/rest/v1/tasks?select=*" -H "apikey: $SUPABASE_ANON_KEY"
```

## Roadmap

Each phase is small, tested on its own, and approved before the next begins.

- **Phase 0, feasibility tests (runs alongside Phase 1, needs Android Studio):** prove on the real phone that a voice service survives being minimized and that a reminder fires on time with the app closed.
- **Phase 1, database foundation:** this commit.
- **Phase 2, text dashboard:** sign in, add and complete tasks.
- **Phase 3, orchestrator:** the backend that talks to the AI model, the tool registry, and the audit log.
- **Phase 4, Android app:** native shell, local reminder alarms, push.
- **Phase 5, memory and proactive jobs:** memory screen, morning summary, nudges.
- **Phase 6, voice and minimized operation.**
- **After that, in this order:** email, messages, other-app and browser control, calendar and contacts, desktop.

## Phone setup (Redmi / Xiaomi)

Xiaomi's system is known for stopping background apps. Before the Phase 0 tests, expect to set these for Myla, following guides written for HyperOS 2 and 3 (menu names may differ on your version):

- Autostart (background autostart) allowed
- Battery or Power setting for the app set to **No restrictions**
- "Pause app activity if unused" turned off

Some users report push messages being delayed on recent HyperOS updates. This is one reason reminders are scheduled on the phone itself and do not depend on push.
