# Myla

A personal AI assistant for one person: tasks, reminders and daily planning with memory, spoken and typed conversation, and later email, messages and other device access through permission-gated tools.

**Status:** Phases 1 (database) and 2 (text dashboard) are done and deployed. Phases 3a (chat) and 3b (read-only task tool plus activity log) are done. Phase 3c (task-changing tools, with confirmation for deletes) is done. Phase 4a (reminders saved in the database, with honest delivery status) is done. Phase 5a (memory) is done. Phase 5b (summary on request, settings screen, past chats list, timezone dropdown) is done; Phase 4b (the Android app, using Capacitor) is in progress; scheduled summaries and nudges wait for it.

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
supabase/functions/    backend functions (Phase 3): chat
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

## Phase 3: chat with Myla

The `chat` function (`supabase/functions/chat/index.ts`) checks you are signed in, saves your message, asks the AI model (Groq) for a reply, saves it, and returns it.

From 3b it also has a tool registry. Tools so far: `list_tasks` (tier 1), `add_task`, `update_task` and `complete_task` (tier 3, run immediately and are logged), `delete_task` (tier 4), and the reminder tools `set_reminder`, `list_reminders` and `cancel_reminder`, and the memory tools `remember`, `list_memory` and `forget` (tier 4, confirmed like deletes). Projects and commitments are saved at once; other memory waits for approval in the dashboard's Memory section. Saved memory is added to Myla's instructions as background. A saved reminder is not the same as an alert: until a device (the Android app, Phase 4b) is registered, Myla says plainly that nothing will notify you. Every tool use is written to the `tool_calls` activity log before it runs, using a backend-only key; if the log cannot be written, the tool does not run. Tier 4 actions never run on the AI's say-so: the function holds the request as `awaiting_confirmation`, the dashboard shows a Confirm and Cancel card, and only the user's explicit yes (answered within 10 minutes, once) runs it. The dashboard shows what was actually done under each reply and in a read-only Recent activity panel.

Setup, all in the Supabase dashboard (nothing secret goes in the repo):

1. Add a function secret named `GROQ_API_KEY` (Edge Functions, Secrets). Optionally add `GROQ_MODEL` to change the model without changing code.
2. Create an Edge Function named exactly `chat` and paste in the code from `supabase/functions/chat/index.ts`.
3. Turn off the function's JWT verification setting. The code verifies the signed-in user itself.

## Free AI limits and fallbacks (6c)

Groq's free plan gives each model its own daily and per-minute allowance (for example `openai/gpt-oss-20b`: 8K tokens per minute and 200K per day). When one is used up, the function tries the next model (`GROQ_FALLBACK_MODELS`, default `openai/gpt-oss-120b,llama-3.1-8b-instant`), and if all are used up it says which limit was hit and how long Groq says to wait. The dashboard shows which model answered last. The instructions put the fixed text first and the changing details last, and the history sent is limited, to use fewer tokens.

## Dashboard layout and your name (6c)

The dashboard has a bottom tab bar: Today, Chat, Reminders, Memory and More (Settings and Recent activity). Settings has "What Myla calls you", stored in `settings.display_name` (migration `0002_display_name.sql`), which Myla and the greeting use.

## Voice (6a)

The chat has a voice panel: tap the mic, speak, and tap Done (or stay quiet for your chosen time: 2, 3 or 5 seconds, or only when you tap Done). The browser stops listening at short pauses, so the app keeps listening and joins what you said. It shows a live transcript and animations for listening, thinking and speaking. There is an option to read replies aloud with a voice you choose. Tapping the orb while Myla speaks stops her, and talking over her stops her too. Times are shown in 12-hour format, and Settings uses a 12-hour time picker. It uses the browser's own speech recognition and voices, which are free but vary by device, and the browser usually sends the audio to its maker's speech service. Voice messages are stored with input mode `voice`. Inside the Android app (a WebView) browser speech recognition is not available, so the Talk button is disabled there until a native speech plugin is added.

## Phase 4b: the Android app

The same dashboard runs inside an Android app made with Capacitor. Inside the app, a "This phone" panel asks for notification permission, registers the phone in the `devices` table, and schedules a local alarm for every saved reminder using the plugin `@capacitor/local-notifications`. It reads back what is really scheduled and shows it. A reminder is marked delivered only with evidence (its notification is in the tray, or the app saw it arrive or be tapped).

From the `web` folder (Android Studio is needed for the last two steps):

```
npm install @capacitor/core @capacitor/android @capacitor/local-notifications --legacy-peer-deps
npm install -D @capacitor/cli --legacy-peer-deps
npm run build
npx cap add android
npx cap sync android
npx cap open android
```

Then add these permission lines inside `<manifest>` in `web/android/app/src/main/AndroidManifest.xml` (next to the INTERNET line):

```
<uses-permission android:name="android.permission.USE_EXACT_ALARM" />
<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />
```

After changing the website code, run `npm run build` and `npx cap sync android` again before running the app.

## Roadmap

Each phase is small, tested on its own, and approved before the next begins.

- **Phase 0, feasibility tests (needs Android Studio):** prove on the real phone that a voice service survives being minimized and that a reminder fires on time with the app closed.
- **Phase 1, database foundation:** done.
- **Phase 2, text dashboard:** done.
- **Phase 3, orchestrator:** 3a chat only (done), 3b read-only task tool plus activity log (done), 3c task-changing tools with confirmation (done).
- **Phase 4, reminders and the Android app:** 4a reminders saved in the database with honest delivery status (done); 4b Android shell (Capacitor) with local reminder alarms and device registration (this step).
- **Phase 5, memory and proactive jobs:** 5a memory tools and Memory screen (done); 5b summary on request, new-chat button and a Settings screen (this step), then scheduled summaries and nudges once a device can deliver them.
- **Phase 6, voice and minimized operation.**
- **After that, in this order:** email, messages, other-app and browser control, calendar and contacts, desktop.

## Phone setup (Redmi / Xiaomi)

Xiaomi's system is known for stopping background apps. Before the Phase 0 tests, expect to set these for Myla, following guides written for HyperOS 2 and 3 (menu names may differ on your version):

- Autostart (background autostart) allowed
- Battery or Power setting for the app set to **No restrictions**
- "Pause app activity if unused" turned off

Some users report push messages being delayed on recent HyperOS updates. This is one reason reminders are scheduled on the phone itself and do not depend on push.
