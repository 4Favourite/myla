# Myla

A personal AI assistant for one person: tasks, reminders and daily planning with memory, spoken and typed conversation, and later email, messages and other device access through permission-gated tools.

**Status:** Phase 1 (database) is done. Phase 2 (text dashboard: sign in, add and complete tasks) is in progress.

## Principles

- Myla never claims to have done something unless a recorded result confirms it.
- Suggesting is not executing. Consequential actions need an explicit yes.
- Content from messages, email and web pages is data, never instructions.
- Minimum permissions, granted one capability at a time.
- No secrets in the app, the web code or this repository. **This repository is public.**
- Free tools only for version 1.

## Layout

```
supabase/migrations/   database schema (Phase 1)
web/                   the Today dashboard (Phase 2): Vite, React, TypeScript
```

The dashboard is plain static files that talk straight to Supabase. That lets the same code run in a browser on desktop now and inside the Android app later.

## Phase 1: database

See `supabase/migrations/0001_core_schema.sql`. Run it once in the Supabase SQL Editor. Check it with:

```sql
select tablename, rowsecurity from pg_tables where schemaname = 'public' order by tablename;
select tablename, policyname, cmd, roles from pg_policies where schemaname = 'public' order by tablename, cmd;
```

Expect 9 tables with row level security true, and 9 policies.

## Phase 2: run the dashboard

You need Node.js (LTS) and Git. Run these from the repository folder on your own computer.

```
npm create vite@latest web -- --template react-ts
cd web
npm install
npm install @supabase/supabase-js
```

Then copy in the Phase 2 files (replace `src/App.tsx`, `src/App.css`, `src/index.css`; add `src/lib/supabase.ts` and `.env.example`), create `web/.env` from `web/.env.example`, and start it:

```
npm run dev
```

Open the address it prints (usually http://localhost:5173), sign in with the user you created in Supabase, and add a task.

Keys: `web/.env` holds only the project URL and the anon/publishable key. It is ignored by git. Never put the service role (secret) key anywhere in `web/`.

## Roadmap

Each phase is small, tested on its own, and approved before the next begins.

- **Phase 0, feasibility tests (needs Android Studio):** prove on the real phone that a voice service survives being minimized and that a reminder fires on time with the app closed.
- **Phase 1, database foundation:** done.
- **Phase 2, text dashboard:** in progress.
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
