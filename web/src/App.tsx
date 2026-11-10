import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { createPortal } from 'react-dom'
import { configError, supabase } from './lib/supabase'
import { isValidZone, zonedTimeToUtc, zoneYmd } from './time'
import {
  isNative,
  listenForDelivery,
  nativeSpeak,
  nativeSpeechReady,
  nativeStopSpeaking,
  nativeVoices,
  openExactAlarmSettings,
  requestNotifications,
  scheduleSummaryTest,
  scheduleTest,
  setSpeechVocabulary,
  startNativeSegment,
  stopNativeListening,
  syncPhone,
} from './native'
import type { NativeVoice, PhoneStatus } from './native'
import './App.css'

// Shown at the bottom of the page so you can tell which version you are looking at.
const WEB_VERSION = '8b'

// Speech recognition often mishears the name Myla ("my love", "Mila"...). Fix the
// common slips when they come right after a greeting or at the very start.
function fixHeard(text: string): string {
  const slips = 'my love|my la|my luh|my lah|mi la|mila|milla|miley|mylah|mayla|maila|malia|myler|my lover'
  return text
    .replace(new RegExp(`\\b(hello|hi|hey|ok|okay|thanks|thank you|please|good morning|good afternoon|good evening)[,\\s]+(${slips})\\b`, 'gi'), '$1, Myla')
    .replace(new RegExp(`^(${slips})\\b`, 'i'), 'Myla')
}

// Tapping the morning summary alert opens Chat and asks for a fresh summary.
let summaryRequested = false

function requestSummary() {
  summaryRequested = true
  window.dispatchEvent(new Event('myla:summary'))
}

function takeSummaryRequest(): boolean {
  const was = summaryRequested
  summaryRequested = false
  return was
}

// Times in the app follow the timezone chosen in Settings, not the phone's clock.
let appZone = ''
const deviceZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
})()

function setAppZone(zone: string) {
  appZone = zone && isValidZone(zone) ? zone : ''
}

function activeZone(): string {
  return appZone || deviceZone
}

function tzOpt(): { timeZone: string } {
  return { timeZone: activeZone() }
}

// The same moment, shown on this device's own clock.
function formatDevice(iso: string): string {
  return new Intl.DateTimeFormat([], {
    timeZone: deviceZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso))
}

type Tab = 'today' | 'chat' | 'email' | 'reminders' | 'memory' | 'more'

const TABS: { id: Tab; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'chat', label: 'Chat' },
  { id: 'email', label: 'Email' },
  { id: 'reminders', label: 'Reminders' },
  { id: 'memory', label: 'Memory' },
  { id: 'more', label: 'More' },
]

function TabIcon({ tab }: { tab: Tab }) {
  const common = {
    viewBox: '0 0 24 24',
    width: 22,
    height: 22,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  if (tab === 'today') {
    return (
      <svg {...common}>
        <path d="M3 11l9-8 9 8" />
        <path d="M5 10v10h14V10" />
      </svg>
    )
  }
  if (tab === 'chat') {
    return (
      <svg {...common}>
        <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
      </svg>
    )
  }
  if (tab === 'email') {
    return (
      <svg {...common}>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M3 7l9 6 9-6" />
      </svg>
    )
  }
  if (tab === 'reminders') {
    return (
      <svg {...common}>
        <path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" />
        <path d="M13.7 20a2 2 0 0 1-3.4 0" />
      </svg>
    )
  }
  if (tab === 'memory') {
    return (
      <svg {...common}>
        <path d="M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4z" />
        <path d="M4 16a4 4 0 0 1 4-4h12" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </svg>
  )
}

type Task = {
  id: string
  title: string
  notes: string | null
  due_at: string | null
  status: 'open' | 'done' | 'cancelled'
  created_at: string
  completed_at: string | null
}

function greeting(): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { ...tzOpt(), hour: 'numeric', hourCycle: 'h23' }).format(new Date()),
  )
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function formatDue(iso: string): string {
  return new Date(iso).toLocaleString([], { ...tzOpt(),
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function dueTime(task: Task): number {
  return task.due_at ? new Date(task.due_at).getTime() : 0
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    if (configError) return
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setChecking(false)
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
    })
    return () => listener.subscription.unsubscribe()
  }, [])

  if (configError) {
    return (
      <main className="center">
        <p className="error" role="alert">
          {configError}
        </p>
      </main>
    )
  }

  if (checking) {
    return (
      <main className="center">
        <p className="muted">Loading…</p>
      </main>
    )
  }

  return session ? <Dashboard email={session.user.email ?? ''} /> : <SignIn />
}

function SignIn() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
    if (signInError) setError(signInError.message)
    setBusy(false)
  }

  return (
    <main className="center">
      <form className="card signin" onSubmit={handleSubmit}>
        <h1>Myla</h1>
        <p className="muted">Sign in to see your day.</p>
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}

function Dashboard({ email }: { email: string }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [loadedAt, setLoadedAt] = useState<Date | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [newDue, setNewDue] = useState('')
  const [saving, setSaving] = useState(false)
  const [activityVersion, setActivityVersion] = useState(0)
  const [tab, setTab] = useState<Tab>('today')
  const [displayName, setDisplayName] = useState('')
  const [zoneTick, setZoneTick] = useState(0)

  // The morning summary alert was tapped: show the Chat tab (Chat then asks for the summary).
  useEffect(() => {
    const showChat = () => setTab('chat')
    if (summaryRequested) showChat()
    window.addEventListener('myla:summary', showChat)
    return () => window.removeEventListener('myla:summary', showChat)
  }, [])

  // What you asked Myla to call you (a setting).
  const loadName = useCallback(async () => {
    const { data } = await supabase.from('settings').select('display_name, timezone').maybeSingle()
    setDisplayName(typeof data?.display_name === 'string' ? data.display_name : '')
    if (isNative && typeof data?.display_name === 'string') setSpeechVocabulary(data.display_name.split(/\s+/))
    setAppZone(typeof data?.timezone === 'string' ? data.timezone : '')
    setZoneTick((t) => t + 1)
  }, [])

  useEffect(() => {
    void loadName()
  }, [loadName])

  // Always reads from the database, so what you see is what is stored.
  const load = useCallback(async () => {
    const { data, error: loadError } = await supabase
      .from('tasks')
      .select('id, title, notes, due_at, status, created_at, completed_at')
      .in('status', ['open', 'done'])
      .order('created_at', { ascending: false })
      .limit(500)
    if (loadError) {
      setError(`Could not load tasks: ${loadError.message}`)
    } else {
      setError(null)
      setTasks((data ?? []) as Task[])
      setLoadedAt(new Date())
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function addTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const title = newTitle.trim()
    if (!title) return

    // Check the date first. A mistyped year (for example five digits) used to
    // break saving and leave the button stuck on "Saving...".
    let dueAt: string | null = null
    if (newDue) {
      const [datePart, timePart] = newDue.split('T')
      const [y, m, d] = (datePart ?? '').split('-').map(Number)
      const [hh, mm] = (timePart ?? '').split(':').map(Number)
      const valid = [y, m, d, hh, mm].every((n) => Number.isFinite(n)) && y >= 2000 && y <= 2100
      if (!valid) {
        setError('That due date does not look right. Check that the year has four digits, or clear the date.')
        return
      }
      // The time you type is in the Settings timezone, whatever this device's clock says.
      dueAt = new Date(zonedTimeToUtc(y, m, d, hh, mm, activeZone())).toISOString()
    }

    setSaving(true)
    try {
      const { error: insertError } = await supabase.from('tasks').insert({ title, due_at: dueAt })
      if (insertError) {
        setError(`Could not save the task: ${insertError.message}`)
      } else {
        setNewTitle('')
        setNewDue('')
        await load()
      }
    } catch (caught) {
      setError(`Could not save the task: ${caught instanceof Error ? caught.message : 'unknown error'}`)
    } finally {
      setSaving(false)
    }
  }

  async function toggleTask(task: Task) {
    const done = task.status !== 'done'
    const { data, error: updateError } = await supabase
      .from('tasks')
      .update({
        status: done ? 'done' : 'open',
        completed_at: done ? new Date().toISOString() : null,
      })
      .eq('id', task.id)
      .select('id')
    if (updateError) {
      setError(`Could not update the task: ${updateError.message}`)
    } else if (!data || data.length === 0) {
      setError('The change was not saved. Nothing was updated.')
    } else {
      await load()
    }
  }

  async function deleteTask(task: Task) {
    if (!window.confirm(`Delete "${task.title}"? This cannot be undone.`)) return
    const { data, error: deleteError } = await supabase
      .from('tasks')
      .delete()
      .eq('id', task.id)
      .select('id')
    if (deleteError) {
      setError(`Could not delete the task: ${deleteError.message}`)
    } else if (!data || data.length === 0) {
      setError('The task was not deleted. Nothing was removed.')
    } else {
      await load()
    }
  }

  const groups = useMemo(() => {
    const zone = activeZone()
    const { y, m, d } = zoneYmd(Date.now(), zone)
    const startOfToday = new Date(zonedTimeToUtc(y, m, d, 0, 0, zone))
    const startOfTomorrow = new Date(zonedTimeToUtc(y, m, d + 1, 0, 0, zone))
    const open = tasks.filter((t) => t.status === 'open')
    const byDue = (a: Task, b: Task) => dueTime(a) - dueTime(b)
    return {
      overdue: open.filter((t) => t.due_at && new Date(t.due_at) < startOfToday).sort(byDue),
      today: open
        .filter(
          (t) => t.due_at && new Date(t.due_at) >= startOfToday && new Date(t.due_at) < startOfTomorrow,
        )
        .sort(byDue),
      upcoming: open.filter((t) => t.due_at && new Date(t.due_at) >= startOfTomorrow).sort(byDue),
      undated: open.filter((t) => !t.due_at),
      done: tasks
        .filter((t) => t.status === 'done')
        .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''))
        .slice(0, 10),
    }
  }, [tasks, zoneTick])

  const todayLabel = new Date().toLocaleDateString([], { ...tzOpt(),
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })

  const openCount = groups.overdue.length + groups.today.length + groups.upcoming.length + groups.undated.length

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="hero-date">{todayLabel}</p>
          <h1>
            {greeting()}
            {displayName ? `, ${displayName}` : ''}
          </h1>
          {deviceZone !== activeZone() && (
            <p className="hero-note">
              Times follow your Settings timezone ({activeZone()}). This device is set to {deviceZone}.
            </p>
          )}
        </div>
        <div className="head-actions">
          <span className="muted small">{email}</span>
          <button className="btn ghost small" onClick={() => void supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </header>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div hidden={tab !== 'today'}>
        <div className="tiles">
          <div className="tile tile-warn">
            <span className="tile-number">{groups.overdue.length}</span>
            <span className="tile-label">Overdue</span>
          </div>
          <div className="tile">
            <span className="tile-number">{groups.today.length}</span>
            <span className="tile-label">Due today</span>
          </div>
          <div className="tile">
            <span className="tile-number">{openCount}</span>
            <span className="tile-label">Open tasks</span>
          </div>
        </div>

        <form className="card add" onSubmit={addTask}>
          <input
            aria-label="New task"
            placeholder="Add a task…"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <input
            aria-label="Due date and time (optional)"
            type="datetime-local"
            min="2000-01-01T00:00"
            max="2100-12-31T23:59"
            value={newDue}
            onChange={(e) => setNewDue(e.target.value)}
          />
          <p className="muted small">Due times are in {activeZone()} time.</p>
          <button className="btn" type="submit" disabled={saving || !newTitle.trim()}>
            {saving ? 'Saving…' : 'Add'}
          </button>
        </form>

        {loading ? (
          <p className="muted">Loading your tasks…</p>
        ) : (
          <>
            <Section title="Overdue" tasks={groups.overdue} overdue onToggle={toggleTask} onDelete={deleteTask} />
            <Section
              title="Today"
              tasks={groups.today}
              emptyText="Nothing is due today."
              onToggle={toggleTask}
              onDelete={deleteTask}
            />
            <Section title="Upcoming" tasks={groups.upcoming} onToggle={toggleTask} onDelete={deleteTask} />
            <Section title="No date" tasks={groups.undated} onToggle={toggleTask} onDelete={deleteTask} />
            <Section title="Done recently" tasks={groups.done} onToggle={toggleTask} onDelete={deleteTask} />
          </>
        )}

        <p className="muted small updated">
          {loadedAt
            ? `Last loaded ${loadedAt.toLocaleTimeString([], { ...tzOpt(), hour: 'numeric', minute: '2-digit', hour12: true })}. `
            : ''}
          <button className="link" onClick={() => void load()}>
            Refresh
          </button>
        </p>
      </div>

      <div hidden={tab !== 'chat'}>
        <Chat
          onActivity={() => {
            setActivityVersion((v) => v + 1)
            void load()
          }}
        />
      </div>

      <div hidden={tab !== 'email'}>
        <Email onTaskAdded={() => void load()} />
      </div>

      <div hidden={tab !== 'reminders'}>
        {isNative && (
          <PhoneSetup version={activityVersion} onChange={() => setActivityVersion((v) => v + 1)} />
        )}
        <Reminders version={activityVersion} />
      </div>

      <div hidden={tab !== 'memory'}>
        <Memory version={activityVersion} />
      </div>

      <div hidden={tab !== 'more'}>
        <Settings
          onSaved={() => {
            void loadName()
            setActivityVersion((v) => v + 1)
          }}
        />
        <Activity version={activityVersion} />
      </div>

      <button
        className="fab"
        onClick={() => window.dispatchEvent(new Event('myla:voice-open'))}
        aria-label="Talk to Myla"
      >
        <MylaMark size={54} />
      </button>

      <nav className="tabbar" aria-label="Main">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={t.id === tab ? 'tab current' : 'tab'}
            onClick={() => setTab(t.id)}
            aria-current={t.id === tab ? 'page' : undefined}
          >
            <TabIcon tab={t.id} />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </main>
  )
}

type SectionProps = {
  title: string
  tasks: Task[]
  emptyText?: string
  overdue?: boolean
  onToggle: (task: Task) => void
  onDelete: (task: Task) => void
}

function Section({ title, tasks, emptyText, overdue, onToggle, onDelete }: SectionProps) {
  if (tasks.length === 0 && !emptyText) return null
  return (
    <section className="section">
      <h2>{title}</h2>
      {tasks.length === 0 ? (
        <p className="muted">{emptyText}</p>
      ) : (
        <ul className="list">
          {tasks.map((task) => (
            <li key={task.id} className="task">
              <input
                type="checkbox"
                checked={task.status === 'done'}
                onChange={() => onToggle(task)}
                aria-label={`Mark "${task.title}" as ${task.status === 'done' ? 'not done' : 'done'}`}
              />
              <div className="task-body">
                <span className={task.status === 'done' ? 'title done' : 'title'}>{task.title}</span>
                {task.due_at && (
                  <span className={overdue ? 'due overdue' : 'due'}>{formatDue(task.due_at)}</span>
                )}
              </div>
              <button className="btn ghost small" onClick={() => onDelete(task)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

type ChatAction = {
  label: string
  status: string
  summary: string
}

type Confirmation = {
  id: string
  description: string
}

// Myla's mark: a glossy gradient orb with a small sound wave inside.
function MylaMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="mm-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset="0.55" stopColor="#a855f7" />
          <stop offset="1" stopColor="#ec4899" />
        </linearGradient>
        <radialGradient id="mm-h" cx="0.3" cy="0.2" r="0.7">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="32" cy="32" r="30" fill="url(#mm-g)" />
      <circle cx="32" cy="32" r="30" fill="url(#mm-h)" />
      <g stroke="#ffffff" strokeWidth="5" strokeLinecap="round">
        <line x1="17" y1="38" x2="17" y2="26" />
        <line x1="25" y1="44" x2="25" y2="20" />
        <line x1="32" y1="48" x2="32" y2="16" />
        <line x1="39" y1="44" x2="39" y2="20" />
        <line x1="47" y1="38" x2="47" y2="26" />
      </g>
    </svg>
  )
}

// The big animated orb on the voice screen. Its look changes with what Myla is doing.
function OrbStage({ phase }: { phase: string }) {
  const bars = Array.from({ length: 40 }, (_, i) => i)
  return (
    <svg className={`orbstage phase-${phase}`} viewBox="0 0 300 300" aria-hidden="true">
      <defs>
        <linearGradient id="os-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset="0.55" stopColor="#a855f7" />
          <stop offset="1" stopColor="#ec4899" />
        </linearGradient>
        <radialGradient id="os-h" cx="0.3" cy="0.2" r="0.7">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="os-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#a78bfa" stopOpacity="0.55" />
          <stop offset="1" stopColor="#a78bfa" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle className="glow" cx="150" cy="150" r="140" fill="url(#os-glow)" />
      <circle className="ring r1" cx="150" cy="150" r="84" />
      <circle className="ring r2" cx="150" cy="150" r="84" />
      <circle className="ring r3" cx="150" cy="150" r="84" />
      <g className="bars">
        {bars.map((i) => (
          <g key={i} transform={`rotate(${i * 9} 150 150)`}>
            <line className="rb" style={{ animationDelay: `${(i % 8) * -110}ms` }} x1="150" y1="30" x2="150" y2="52" />
          </g>
        ))}
      </g>
      <g transform="translate(86 86) scale(2.1)">
        <circle cx="32" cy="32" r="30" fill="url(#os-g)" />
        <circle cx="32" cy="32" r="30" fill="url(#os-h)" />
        <g stroke="#ffffff" strokeWidth="5" strokeLinecap="round">
          <line x1="17" y1="38" x2="17" y2="26" />
          <line x1="25" y1="44" x2="25" y2="20" />
          <line x1="32" y1="48" x2="32" y2="16" />
          <line x1="39" y1="44" x2="39" y2="20" />
          <line x1="47" y1="38" x2="47" y2="26" />
        </g>
      </g>
    </svg>
  )
}

const DEFAULT_SUGGESTIONS = [
  'What’s on my list today?',
  'Summarize my day',
  'Any important email?',
  'Remind me in an hour',
]

// Voice: the browser's own speech recognition and speech voices. Free, but quality
// varies, and the browser usually sends your audio to its maker's speech service.
type VoiceSession = {
  text: string
  interim: string
  startedAt: number
  done: boolean
  cancelled: boolean
  failed: boolean
  timer: number | null
  recognition: RecognitionLike | null
  nativeActive: boolean
}

type SpeechResultLike = { isFinal: boolean; 0: { transcript: string } }
type SpeechEventLike = { resultIndex: number; results: ArrayLike<SpeechResultLike> }
type RecognitionLike = {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((event: SpeechEventLike) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}
type RecognitionCtor = new () => RecognitionLike

function getRecognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor
    webkitSpeechRecognition?: RecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

function voiceErrorText(code: string): string {
  if (code === 'not-allowed' || code === 'service-not-allowed') {
    return 'The microphone is blocked. Allow it in the site settings, then try again.'
  }
  if (code === 'no-speech') return 'I did not hear anything. Tap Talk and try again.'
  if (code === 'audio-capture') return 'No microphone was found.'
  if (code === 'network') return 'The speech service could not be reached.'
  return `Voice input problem: ${code}`
}

// A best guess at a natural female voice. You can always pick another.
function preferredVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const english = voices.filter((v) => v.lang.toLowerCase().startsWith('en'))
  const pool = english.length > 0 ? english : voices
  return (
    pool.find((v) => /female|zira|samantha|aria|jenny|libby|sonia|hazel|susan|karen|moira|tessa|fiona|victoria/i.test(v.name)) ??
    pool[0]
  )
}

function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeSetting(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // not available: the choice just will not be remembered
  }
}

type ChatSummary = {
  id: string
  title: string | null
  created_at: string
}

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  actions?: ChatAction[]
  confirmations?: Confirmation[]
}

function actionMark(status: string): string {
  if (status === 'succeeded') return '✓'
  if (status === 'awaiting_confirmation') return '…'
  if (status === 'cancelled') return '–'
  return '✕'
}

// The chat function needs the browser's local date, time and offset so that
// "today" means your today.
function localClientTime() {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    local_date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    local_time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    utc_offset_minutes: now.getTimezoneOffset(),
    time_zone: deviceZone,
  }
}

// When the chat function says no, it explains why in a JSON message. Show that.
async function describeFunctionError(err: unknown): Promise<string> {
  if (err && typeof err === 'object' && 'context' in err) {
    const context = (err as { context?: unknown }).context
    if (context instanceof Response) {
      try {
        const body = await context.json()
        if (body && typeof body.error === 'string') return body.error
      } catch {
        // fall through to the generic message
      }
    }
  }
  return err instanceof Error ? err.message : 'Something went wrong.'
}

function Chat({ onActivity }: { onActivity: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [functionVersion, setFunctionVersion] = useState<string | null>(null)
  const [answeredBy, setAnsweredBy] = useState<string | null>(null)
  const [chats, setChats] = useState<ChatSummary[]>([])
  const [showChats, setShowChats] = useState(false)
  const [voiceActive, setVoiceActive] = useState(false)
  const [voicePaused, setVoicePaused] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [showTranscript, setShowTranscript] = useState(false)
  const [awaitingSpeech, setAwaitingSpeech] = useState(false)
  const [soundsOn, setSoundsOn] = useState(() => readSetting('myla.sounds') === '1')
  const voiceActiveRef = useRef(false)
  const voicePausedRef = useRef(false)
  const emptyRoundsRef = useRef(0)
  const voiceStartRef = useRef(0)
  const toggleRef = useRef<() => void>(() => {})
  const openVoiceRef = useRef<() => void>(() => {})
  const listRef = useRef<HTMLDivElement>(null)
  const sendTextRef = useRef<(text: string, mode?: 'text' | 'voice') => Promise<void>>(sendText)
  useEffect(() => {
    sendTextRef.current = sendText
  })
  useEffect(() => {
    const ask = () => {
      if (takeSummaryRequest()) void sendTextRef.current('Give me my morning summary.')
    }
    ask()
    window.addEventListener('myla:summary', ask)
    return () => window.removeEventListener('myla:summary', ask)
  }, [])
  const voiceRef = useRef<VoiceSession | null>(null)
  const voiceSupported = isNative || getRecognitionCtor() !== null
  const speechSupported = isNative || (typeof window !== 'undefined' && 'speechSynthesis' in window)
  const [listening, setListening] = useState(false)
  const [heard, setHeard] = useState('')
  const [speaking, setSpeaking] = useState(false)
  const [pauseMs, setPauseMs] = useState(() => {
    const stored = readSetting('myla.pause')
    const value = stored === null ? 3000 : Number(stored)
    return [0, 2000, 3000, 5000].includes(value) ? value : 3000
  })
  const [speakReplies, setSpeakReplies] = useState(() => readSetting('myla.speak') === '1')
  const [voiceName, setVoiceName] = useState(() => readSetting('myla.voice') ?? '')
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [nativeVoiceList, setNativeVoiceList] = useState<NativeVoice[]>([])
  const [langPref, setLangPref] = useState(() => readSetting('myla.lang') ?? '')

  // The list of past chats, newest first.
  const loadChats = useCallback(async () => {
    const { data, error: chatsError } = await supabase
      .from('conversations')
      .select('id, title, created_at')
      .order('created_at', { ascending: false })
      .limit(30)
    if (chatsError) {
      setError(`Could not load your past chats: ${chatsError.message}`)
    } else {
      setChats((data ?? []) as ChatSummary[])
    }
  }, [])

  useEffect(() => {
    void loadChats()
  }, [loadChats])

  // Open one of the past chats.
  async function openChat(id: string) {
    if (sending) return
    setError(null)
    const { data: rows, error: rowsError } = await supabase
      .from('messages')
      .select('id, role, content')
      .eq('conversation_id', id)
      .in('role', ['user', 'assistant'])
      .order('created_at', { ascending: true })
      .limit(100)
    if (rowsError) {
      setError(`Could not open that chat: ${rowsError.message}`)
      return
    }
    setConversationId(id)
    setMessages((rows ?? []) as ChatMessage[])
    setShowChats(false)
  }

  // Load the latest conversation from the database.
  useEffect(() => {
    let cancelled = false
    async function loadHistory() {
      const { data: convo, error: convoError } = await supabase
        .from('conversations')
        .select('id')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (cancelled) return
      if (convoError) {
        setError(`Could not load the conversation: ${convoError.message}`)
        setReady(true)
        return
      }
      if (convo) {
        const { data: rows, error: rowsError } = await supabase
          .from('messages')
          .select('id, role, content')
          .eq('conversation_id', convo.id)
          .in('role', ['user', 'assistant'])
          .order('created_at', { ascending: true })
          .limit(100)
        if (cancelled) return
        if (rowsError) {
          setError(`Could not load the messages: ${rowsError.message}`)
        } else {
          setConversationId(convo.id as string)
          setMessages((rows ?? []) as ChatMessage[])
        }
      }
      setReady(true)
    }
    void loadHistory()
    return () => {
      cancelled = true
    }
  }, [])

  // Keep the newest message in view inside the chat box (the page does not jump).
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, sending])

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void sendText(draft.trim())
  }

  // The language to listen for. Defaults to Nigerian English when your timezone is Lagos.
  function listenLanguage(): string {
    return langPref || (activeZone() === 'Africa/Lagos' ? 'en-NG' : navigator.language || 'en-US')
  }

  // Inside the Android app the phone's own voices are used.
  useEffect(() => {
    if (!isNative) return
    void nativeVoices().then((list) => setNativeVoiceList(list))
  }, [])

  // The list of voices this device offers (it can fill in a moment after loading).
  useEffect(() => {
    if (!speechSupported || isNative) return
    const load = () => setVoices(window.speechSynthesis.getVoices())
    load()
    window.speechSynthesis.addEventListener('voiceschanged', load)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load)
  }, [speechSupported])

  function stopSpeaking() {
    if (isNative) void nativeStopSpeaking()
    else if (speechSupported) window.speechSynthesis.cancel()
    setSpeaking(false)
    setAwaitingSpeech(false)
  }

  // A soft optional chime, made with the browser's audio (no sound files).
  function playTone(kind: 'listen' | 'ready') {
    if (!soundsOn) return
    try {
      const Ctor =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      const audio = new Ctor()
      const notes = kind === 'listen' ? [660, 880] : [520]
      notes.forEach((frequency, index) => {
        const oscillator = audio.createOscillator()
        const gain = audio.createGain()
        const start = audio.currentTime + index * 0.12
        oscillator.type = 'sine'
        oscillator.frequency.value = frequency
        gain.gain.setValueAtTime(0.0001, start)
        gain.gain.exponentialRampToValueAtTime(0.08, start + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18)
        oscillator.connect(gain)
        gain.connect(audio.destination)
        oscillator.start(start)
        oscillator.stop(start + 0.2)
      })
      window.setTimeout(() => void audio.close(), 700)
    } catch {
      // sound is optional
    }
  }

  // Spoken reply inside the Android app, using the phone's own voice.
  async function speakNative(text: string) {
    const female = nativeVoiceList.find((v) => v.lang.toLowerCase().startsWith('en') && /female/i.test(v.name))
    const english = nativeVoiceList.find((v) => v.lang.toLowerCase().startsWith('en'))
    const chosen = nativeVoiceList.find((v) => v.name === voiceName) ?? female ?? english
    setAwaitingSpeech(true)
    try {
      setSpeaking(true)
      setAwaitingSpeech(false)
      await nativeSpeak(text, chosen?.lang ?? listenLanguage(), chosen?.index)
    } catch (caught) {
      setError(`Could not speak the reply: ${caught instanceof Error ? caught.message : 'unknown error'}`)
    } finally {
      setSpeaking(false)
      setAwaitingSpeech(false)
    }
  }

  function speak(text: string) {
    if (!speechSupported || (!speakReplies && !voiceActiveRef.current)) return
    if (isNative) {
      void speakNative(text)
      return
    }
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    const chosen = voices.find((v) => v.name === voiceName) ?? preferredVoice(voices)
    if (chosen) {
      utterance.voice = chosen
      utterance.lang = chosen.lang
    }
    setAwaitingSpeech(true)
    const fallback = window.setTimeout(() => setAwaitingSpeech(false), 3000)
    utterance.onstart = () => {
      window.clearTimeout(fallback)
      setAwaitingSpeech(false)
      setSpeaking(true)
    }
    utterance.onend = () => {
      window.clearTimeout(fallback)
      setAwaitingSpeech(false)
      setSpeaking(false)
    }
    utterance.onerror = () => {
      window.clearTimeout(fallback)
      setAwaitingSpeech(false)
      setSpeaking(false)
    }
    window.speechSynthesis.speak(utterance)
  }

  // Voice input. The browser stops listening at short pauses, so this keeps
  // listening until you have been quiet for your chosen time (or tap Done).
  function armSilenceTimer(session: VoiceSession, ms: number) {
    if (session.timer !== null) window.clearTimeout(session.timer)
    session.timer = ms > 0 ? window.setTimeout(() => stopListening(), ms) : null
  }

  function finishListening() {
    const session = voiceRef.current
    if (!session) return
    if (session.timer !== null) window.clearTimeout(session.timer)
    voiceRef.current = null
    setListening(false)
    setHeard('')
    if (session.interim) {
      session.text = `${session.text} ${session.interim}`.trim()
      session.interim = ''
    }
    const said = fixHeard(session.text.trim())
    if (session.cancelled) return
    if (session.failed) {
      if (voiceActiveRef.current) pauseVoice()
      return
    }
    if (said) {
      emptyRoundsRef.current = 0
      void sendText(said, 'voice')
    } else if (voiceActiveRef.current) {
      emptyRoundsRef.current += 1
      if (emptyRoundsRef.current >= 2) pauseVoice()
    } else {
      setError('I did not hear anything. Tap the mic and try again.')
    }
  }

  // Done (or a long enough pause) stops listening and sends what was heard.
  function stopListening() {
    const session = voiceRef.current
    if (!session) return
    session.done = true
    if (session.recognition) {
      session.recognition.stop()
    } else if (session.nativeActive) {
      void stopNativeListening()
      // Safety net in case the phone never reports that it stopped.
      window.setTimeout(() => {
        if (voiceRef.current === session) finishListening()
      }, 1500)
    } else {
      finishListening()
    }
  }

  function cancelListening() {
    const session = voiceRef.current
    if (!session) return
    session.cancelled = true
    stopListening()
  }

  // Inside the Android app: the phone's own recognizer, one stretch at a time.
  function runNativeRecognition(session: VoiceSession) {
    session.nativeActive = true
    void startNativeSegment(
      {
        onPartial: (text) => {
          session.interim = text
          setHeard(`${session.text} ${text}`.trim())
          armSilenceTimer(session, pauseMs)
        },
        onEnded: (lastText) => {
          session.nativeActive = false
          if (lastText) session.text = `${session.text} ${lastText}`.trim()
          session.interim = ''
          const tooLong = Date.now() - session.startedAt > 120000
          if (!session.done && !tooLong) {
            runNativeRecognition(session) // the phone stopped at a short pause: keep listening
            return
          }
          finishListening()
        },
        onError: (message) => {
          session.nativeActive = false
          session.failed = true
          session.done = true
          setError(message)
          finishListening()
        },
      },
      listenLanguage(),
    )
  }

  function runRecognition(session: VoiceSession) {
    const Ctor = getRecognitionCtor()
    if (!Ctor) return
    const recognition = new Ctor()
    recognition.lang = listenLanguage()
    recognition.interimResults = true
    recognition.continuous = false
    recognition.onresult = (event) => {
      let interimText = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) session.text = `${session.text} ${result[0].transcript}`.trim()
        else interimText += result[0].transcript
      }
      session.interim = interimText.trim()
      setHeard(`${session.text} ${session.interim}`.trim())
      armSilenceTimer(session, pauseMs)
    }
    recognition.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return
      session.failed = true
      session.done = true
      setError(voiceErrorText(event.error))
    }
    recognition.onend = () => {
      session.recognition = null
      if (session.interim) {
        session.text = `${session.text} ${session.interim}`.trim()
        session.interim = ''
      }
      const tooLong = Date.now() - session.startedAt > 120000
      if (!session.done && !tooLong) {
        runRecognition(session) // the browser stopped at a short pause: keep listening
        return
      }
      finishListening()
    }
    session.recognition = recognition
    try {
      recognition.start()
    } catch {
      session.failed = true
      session.done = true
      setError('Could not start the microphone.')
      finishListening()
    }
  }

  function toggleListening() {
    if (voiceRef.current) {
      stopListening()
      return
    }
    if ((!isNative && !getRecognitionCtor()) || sending) return
    stopSpeaking() // talking over Myla interrupts her
    const session: VoiceSession = {
      text: '',
      interim: '',
      startedAt: Date.now(),
      done: false,
      cancelled: false,
      failed: false,
      timer: null,
      recognition: null,
      nativeActive: false,
    }
    voiceRef.current = session
    setError(null)
    setHeard('')
    setListening(true)
    if (voiceActiveRef.current) playTone('listen')
    // Allow a little longer before the first words.
    armSilenceTimer(session, pauseMs > 0 ? Math.max(pauseMs, 6000) : 0)
    if (isNative) {
      void (async () => {
        const ready = await nativeSpeechReady()
        if (!ready.ok) {
          session.failed = true
          session.done = true
          setError(ready.reason ?? 'Voice is not available.')
          finishListening()
          return
        }
        if (!session.done) runNativeRecognition(session)
      })()
      return
    }
    runRecognition(session)
  }

  // Stop the microphone and the voice if you leave the page.
  useEffect(() => {
    return () => {
      const session = voiceRef.current
      if (session) {
        session.cancelled = true
        session.done = true
        if (session.timer !== null) window.clearTimeout(session.timer)
        session.recognition?.stop()
      }
      if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    }
  }, [])

  // ---- Voice mode: a full-screen, hands-free conversation ----
  function pauseVoice() {
    voicePausedRef.current = true
    setVoicePaused(true)
  }

  function pauseVoiceIfActive() {
    if (voiceActiveRef.current) pauseVoice()
  }

  function openVoiceMode() {
    if (!voiceSupported) {
      setError('Voice is not available here.')
      return
    }
    voiceActiveRef.current = true
    voicePausedRef.current = false
    emptyRoundsRef.current = 0
    voiceStartRef.current = messages.length
    setError(null)
    setVoicePaused(false)
    setVoiceActive(true)
  }

  function closeVoiceMode() {
    voiceActiveRef.current = false
    cancelListening()
    stopSpeaking()
    setVoiceActive(false)
    setVoicePaused(false)
  }

  function togglePause() {
    if (voicePaused) {
      voicePausedRef.current = false
      emptyRoundsRef.current = 0
      setError(null)
      setVoicePaused(false)
    } else {
      pauseVoice()
      cancelListening()
      stopSpeaking()
    }
  }

  // Tapping the orb: continue if paused, interrupt Myla if she is talking, send now if listening.
  function orbTap() {
    if (voicePaused) {
      togglePause()
      return
    }
    if (speaking || awaitingSpeech) {
      stopSpeaking()
      return
    }
    if (listening) stopListening()
  }

  function chooseSuggestion(text: string) {
    if (sending) return
    cancelListening()
    stopSpeaking()
    voicePausedRef.current = false
    setVoicePaused(false)
    void sendText(text, 'text')
  }

  useEffect(() => {
    toggleRef.current = toggleListening
    openVoiceRef.current = openVoiceMode
  })

  // The loop: when nothing is happening, listen again.
  useEffect(() => {
    if (!voiceActive || voicePaused || listening || sending || speaking || awaitingSpeech) return
    const timer = window.setTimeout(() => {
      if (voiceActiveRef.current && !voicePausedRef.current && !voiceRef.current) toggleRef.current()
    }, 600)
    return () => window.clearTimeout(timer)
  }, [voiceActive, voicePaused, listening, sending, speaking, awaitingSpeech])

  // The floating mic button elsewhere in the app opens voice mode.
  useEffect(() => {
    const open = () => openVoiceRef.current()
    window.addEventListener('myla:voice-open', open)
    return () => window.removeEventListener('myla:voice-open', open)
  }, [])

  useEffect(() => {
    if (!voiceActive) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [voiceActive])

  // Start a fresh conversation. The next message creates a new one.
  function startNew() {
    if (sending) return
    setMessages([])
    setConversationId(null)
    setError(null)
    setDraft('')
  }

  async function sendText(text: string, mode: 'text' | 'voice' = 'text') {
    if (!text || sending) return
    stopSpeaking()
    setSending(true)
    setError(null)
    const pendingId = `pending-${Date.now()}`
    setMessages((current) => [...current, { id: pendingId, role: 'user', content: text }])
    setDraft('')
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('chat', {
        body: {
          message: text,
          conversation_id: conversationId,
          client: localClientTime(),
          input_mode: mode,
          spoken: voiceActiveRef.current,
        },
      })
      if (invokeError) {
        // Put the message back so nothing is lost, and say what went wrong.
        setMessages((current) => current.filter((m) => m.id !== pendingId))
        setDraft(text)
        setError(await describeFunctionError(invokeError))
        pauseVoiceIfActive()
        return
      }
      const result = data as {
        reply?: string
        conversation_id?: string
        actions?: ChatAction[]
        confirmations?: Confirmation[]
        version?: string
        model?: string
        suggestions?: string[]
      } | null
      if (!result?.reply) {
        setMessages((current) => current.filter((m) => m.id !== pendingId))
        setDraft(text)
        setError('Myla did not send a reply.')
        pauseVoiceIfActive()
        return
      }
      const replyText = result.reply
      setSuggestions(Array.isArray(result.suggestions) ? result.suggestions : [])
      if (voiceActiveRef.current) playTone('ready')
      speak(replyText)
      if (result.version) setFunctionVersion(result.version)
      if (result.model) setAnsweredBy(result.model)
      if (result.conversation_id) setConversationId(result.conversation_id)
      setMessages((current) => [
        ...current,
        {
          id: `reply-${Date.now()}`,
          role: 'assistant',
          content: replyText,
          actions: result.actions,
          confirmations: result.confirmations,
        },
      ])
    } catch (caught) {
      setMessages((current) => current.filter((m) => m.id !== pendingId))
      setDraft(text)
      setError(caught instanceof Error ? caught.message : 'Something went wrong.')
      pauseVoiceIfActive()
    } finally {
      setSending(false)
      void loadChats()
      onActivity()
    }
  }

  // The user's own yes or no. The AI is not involved in this step.
  async function answerConfirmation(messageId: string, confirmationId: string, decision: 'approve' | 'cancel') {
    if (sending) return
    setSending(true)
    setError(null)
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('chat', {
        body: {
          confirm: { id: confirmationId, decision },
          conversation_id: conversationId,
          client: localClientTime(),
        },
      })
      if (invokeError) {
        setError(await describeFunctionError(invokeError))
        return
      }
      const result = data as { reply?: string; actions?: ChatAction[] } | null
      if (!result?.reply) {
        setError('No result came back. Check Recent activity to see what happened.')
        return
      }
      const replyText = result.reply
      setMessages((current) => [
        ...current.map((m) =>
          m.id === messageId
            ? { ...m, confirmations: (m.confirmations ?? []).filter((c) => c.id !== confirmationId) }
            : m,
        ),
        { id: `result-${Date.now()}`, role: 'assistant', content: replyText, actions: result.actions },
      ])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong.')
    } finally {
      setSending(false)
      void loadChats()
      onActivity()
    }
  }

  const phase = voicePaused
    ? 'paused'
    : listening
      ? 'listening'
      : sending
        ? 'thinking'
        : speaking || awaitingSpeech
          ? 'speaking'
          : 'idle'
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  const caption =
    phase === 'listening'
      ? heard || 'Go ahead, I’m listening…'
      : phase === 'thinking'
        ? (lastUser?.content ?? '')
        : phase === 'paused'
          ? 'Paused. Tap the orb to carry on.'
          : (lastAssistant?.content ?? 'Say something…')
  const statusText =
    phase === 'listening'
      ? 'Listening'
      : phase === 'thinking'
        ? 'Thinking'
        : phase === 'speaking'
          ? 'Speaking'
          : phase === 'paused'
            ? 'Paused'
            : 'Ready'
  const chips = suggestions.length > 0 ? suggestions : DEFAULT_SUGGESTIONS
  const sessionMessages = messages.slice(voiceStartRef.current)

  const voiceScreen = (
    <div className={`voice-screen phase-${phase}`} role="dialog" aria-label="Voice conversation with Myla">
      <div className="vs-top">
        <div className="vs-title">
          <MylaMark size={28} />
          <span>Myla</span>
        </div>
        <span className="vs-status">{statusText}</span>
        <button className="vs-close" onClick={closeVoiceMode} aria-label="End the voice conversation">
          ✕
        </button>
      </div>

      <button
        className="vs-orb"
        onClick={orbTap}
        aria-label={voicePaused ? 'Continue' : speaking ? 'Stop talking' : listening ? 'Send now' : 'Voice orb'}
      >
        <OrbStage phase={phase} />
      </button>

      <p className="vs-caption">{caption}</p>

      {error && (
        <p className="vs-error" role="alert">
          {error}
        </p>
      )}

      {lastAssistant?.confirmations && lastAssistant.confirmations.length > 0 && (
        <div className="vs-confirm">
          {lastAssistant.confirmations.map((c) => (
            <div key={c.id} className="vs-confirm-item">
              <span>{c.description}?</span>
              <button className="vs-chip" disabled={sending} onClick={() => void answerConfirmation(lastAssistant.id, c.id, 'approve')}>
                Confirm
              </button>
              <button className="vs-chip" disabled={sending} onClick={() => void answerConfirmation(lastAssistant.id, c.id, 'cancel')}>
                Cancel
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="vs-chips">
        {chips.map((chip) => (
          <button key={chip} className="vs-chip" disabled={sending} onClick={() => chooseSuggestion(chip)}>
            {chip}
          </button>
        ))}
      </div>

      <div className="vs-controls">
        <button className="vs-btn" onClick={togglePause}>
          {voicePaused ? 'Resume' : 'Pause'}
        </button>
        <button className="vs-btn" onClick={() => setShowTranscript((v) => !v)}>
          {showTranscript ? 'Hide transcript' : 'Transcript'}
        </button>
        <button
          className="vs-btn"
          onClick={() => {
            const next = !soundsOn
            setSoundsOn(next)
            writeSetting('myla.sounds', next ? '1' : '0')
          }}
        >
          Chimes {soundsOn ? 'on' : 'off'}
        </button>
        <button className="vs-btn vs-end" onClick={closeVoiceMode}>
          End
        </button>
      </div>

      {showTranscript && (
        <div className="vs-transcript">
          {sessionMessages.length === 0 ? (
            <p className="vs-line">Nothing said yet. Everything you say here is also saved in your chat.</p>
          ) : (
            sessionMessages.map((m) => (
              <p key={m.id} className={`vs-line ${m.role}`}>
                {m.content}
              </p>
            ))
          )}
        </div>
      )}
    </div>
  )

  return (
    <>
    <section className="section">
      <h2>Talk to Myla</h2>
      <p className="muted small">Myla can read and change your tasks. She asks you before deleting anything.</p>
      <div className="card chat">
        <div className="chat-list" ref={listRef}>
          {!ready ? (
            <p className="muted">Loading…</p>
          ) : messages.length === 0 ? (
            <p className="muted">Say hello to start.</p>
          ) : (
            messages.map((m) => (
              <div key={m.id} className={`bubble ${m.role}`}>
                {m.content}
                {m.actions && m.actions.length > 0 && (
                  <div className="actions">
                    {m.actions.map((a, i) => (
                      <span key={i}>
                        {actionMark(a.status)} {a.label}
                        {a.summary ? ` (${a.summary})` : ''}
                      </span>
                    ))}
                  </div>
                )}
                {m.confirmations && m.confirmations.length > 0 && (
                  <div className="confirm">
                    {m.confirmations.map((c) => (
                      <div key={c.id} className="confirm-item">
                        <span>{c.description}?</span>
                        <button
                          className="btn small"
                          disabled={sending}
                          onClick={() => void answerConfirmation(m.id, c.id, 'approve')}
                        >
                          Confirm
                        </button>
                        <button
                          className="btn ghost small"
                          disabled={sending}
                          onClick={() => void answerConfirmation(m.id, c.id, 'cancel')}
                        >
                          Cancel
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
          {sending && <div className="bubble assistant muted">Myla is thinking…</div>}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="quick">
          <button
            type="button"
            className="btn ghost small"
            disabled={sending}
            onClick={() => void sendText('Give me my morning summary.')}
          >
            Summarize my day
          </button>
          <button type="button" className="btn small" disabled={!voiceSupported} onClick={openVoiceMode}>
            Voice mode
          </button>
          <button type="button" className="btn ghost small" disabled={sending} onClick={startNew}>
            New chat
          </button>
          <button
            type="button"
            className="btn ghost small"
            onClick={() => setShowChats((v) => !v)}
          >
            {showChats ? 'Hide past chats' : `Past chats (${chats.length})`}
          </button>
        </div>
        {showChats && (
          <ul className="list chats">
            {chats.length === 0 ? (
              <li className="muted small">No past chats yet.</li>
            ) : (
              chats.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className={c.id === conversationId ? 'chat-item current' : 'chat-item'}
                    onClick={() => void openChat(c.id)}
                  >
                    <span className="title">{c.title || 'Untitled chat'}</span>
                    <span className="due">
                      {new Date(c.created_at).toLocaleString([], { ...tzOpt(),
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                        hour12: true,
                      })}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
        <div
          className={`voice${listening ? ' is-listening' : ''}${speaking ? ' is-speaking' : ''}${sending && !listening ? ' is-thinking' : ''}`}
        >
          <button
            type="button"
            className="orb"
            disabled={!voiceSupported || (sending && !listening)}
            onClick={speaking ? stopSpeaking : toggleListening}
            aria-label={listening ? 'Finish and send' : speaking ? 'Stop talking' : 'Start talking'}
          >
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0" />
              <path d="M12 18v3" />
            </svg>
          </button>
          <div className="voice-text">
            <span className="voice-status">
              {listening
                ? 'Listening…'
                : sending
                  ? 'Thinking…'
                  : speaking
                    ? 'Speaking…'
                    : voiceSupported
                      ? 'Tap the mic to talk'
                      : 'Voice is not available here yet'}
            </span>
            <span className="voice-heard">
              {listening
                ? heard || 'Say something…'
                : voiceSupported
                  ? pauseMs > 0
                    ? `It sends after ${pauseMs / 1000} seconds of quiet, or tap Done.`
                    : 'Tap Done when you finish speaking.'
                  : ''}
            </span>
          </div>
          {(listening || speaking) && (
            <div className="bars" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
              <span />
            </div>
          )}
          {listening && (
            <div className="voice-actions">
              <button type="button" className="btn small" onClick={stopListening}>
                Done
              </button>
              <button type="button" className="btn ghost small" onClick={cancelListening}>
                Cancel
              </button>
            </div>
          )}
        </div>
        <form className="chat-form" onSubmit={send}>
          <input
            aria-label="Message Myla"
            placeholder="Message Myla…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={sending}
          />
          <button className="btn" type="submit" disabled={sending || !draft.trim()}>
            Send
          </button>
        </form>
        <div className="voice-options">
          <label className="inline">
            I speak
            <select
              value={langPref}
              onChange={(e) => {
                setLangPref(e.target.value)
                writeSetting('myla.lang', e.target.value)
              }}
            >
              <option value="">Automatic ({listenLanguage()})</option>
              <option value="en-NG">English (Nigeria)</option>
              <option value="en-US">English (US)</option>
              <option value="en-GB">English (UK)</option>
            </select>
          </label>
          <label className="inline">
            Wait after I pause
            <select
              value={pauseMs}
              onChange={(e) => {
                const value = Number(e.target.value)
                setPauseMs(value)
                writeSetting('myla.pause', String(value))
              }}
            >
              <option value={2000}>2 seconds</option>
              <option value={3000}>3 seconds</option>
              <option value={5000}>5 seconds</option>
              <option value={0}>Only when I tap Done</option>
            </select>
          </label>
          {speechSupported && (
            <>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={speakReplies}
                  onChange={(e) => {
                    setSpeakReplies(e.target.checked)
                    writeSetting('myla.speak', e.target.checked ? '1' : '0')
                    if (!e.target.checked) stopSpeaking()
                  }}
                />
                Read replies aloud
              </label>
              {speakReplies && (isNative ? nativeVoiceList.length > 0 : voices.length > 0) && (
                <select
                  aria-label="Voice"
                  value={
                    voiceName ||
                    (isNative
                      ? (nativeVoiceList.find((v) => v.lang.toLowerCase().startsWith('en') && /female/i.test(v.name))?.name ??
                        nativeVoiceList.find((v) => v.lang.toLowerCase().startsWith('en'))?.name ??
                        '')
                      : (preferredVoice(voices)?.name ?? ''))
                  }
                  onChange={(e) => {
                    setVoiceName(e.target.value)
                    writeSetting('myla.voice', e.target.value)
                  }}
                >
                  {(isNative
                    ? nativeVoiceList.map((v) => ({ name: v.name, lang: v.lang }))
                    : voices.map((v) => ({ name: v.name, lang: v.lang }))
                  ).map((v) => (
                    <option key={`${v.name}-${v.lang}`} value={v.name}>
                      {v.name} ({v.lang})
                    </option>
                  ))}
                </select>
              )}
            </>
          )}
        </div>
        <p className="muted small">
          {voiceSupported
            ? 'Voice input uses your phone or browser’s own speech service, which may send your audio to its maker. Voices vary by device.'
            : 'Voice input is not available here.'}
        </p>
      </div>
      <p className="muted small">
        Website version {WEB_VERSION} · Chat function version {functionVersion ?? 'not used yet'}
        {answeredBy ? ` · Last answer from ${answeredBy}` : ''}
      </p>
    </section>
    {voiceActive && createPortal(voiceScreen, document.body)}
    </>
  )
}

type ActivityRow = {
  id: string
  tool_name: string
  tier: number
  status: string
  result_summary: string | null
  error: string | null
  created_at: string
}

// Read-only view of the activity log. Only the backend can write to it.
function Activity({ version }: { version: number }) {
  const [rows, setRows] = useState<ActivityRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data, error: loadError } = await supabase
      .from('tool_calls')
      .select('id, tool_name, tier, status, result_summary, error, created_at')
      .order('created_at', { ascending: false })
      .limit(10)
    if (loadError) {
      setError(`Could not load the activity log: ${loadError.message}`)
    } else {
      setError(null)
      setRows((data ?? []) as ActivityRow[])
    }
    setLoaded(true)
  }, [])

  useEffect(() => {
    void load()
  }, [load, version])

  return (
    <section className="section">
      <h2>Recent activity</h2>
      <p className="muted small">
        What Myla actually did, as recorded by the backend. She cannot edit this list.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loaded && rows.length === 0 ? (
        <p className="muted">Nothing yet.</p>
      ) : (
        <ul className="list">
          {rows.map((r) => (
            <li key={r.id} className="task">
              <div className="task-body">
                <span className="title">
                  {r.tool_name} · tier {r.tier} · {r.status}
                </span>
                <span className="due">
                  {new Date(r.created_at).toLocaleString([], { ...tzOpt(),
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: true,
                  })}
                  {r.result_summary ? ` · ${r.result_summary}` : ''}
                  {r.error ? ` · ${r.error}` : ''}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

type Reminder = {
  id: string
  title: string
  remind_at: string
}

// Reminders that are saved and still waiting. Saving a reminder does not mean a
// device will alert you, so this section says plainly when none is set up.
function Reminders({ version }: { version: number }) {
  const [items, setItems] = useState<Reminder[]>([])
  const [hasDevice, setHasDevice] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [remindersResult, devicesResult] = await Promise.all([
      supabase
        .from('reminders')
        .select('id, title, remind_at')
        .eq('status', 'scheduled')
        .order('remind_at', { ascending: true })
        .limit(20),
      supabase.from('devices').select('id', { count: 'exact', head: true }),
    ])
    if (remindersResult.error) {
      setError(`Could not load reminders: ${remindersResult.error.message}`)
    } else {
      setError(null)
      setItems((remindersResult.data ?? []) as Reminder[])
    }
    setHasDevice(devicesResult.error ? null : (devicesResult.count ?? 0) > 0)
  }, [])

  useEffect(() => {
    void load()
  }, [load, version])

  async function cancel(item: Reminder) {
    const { data, error: cancelError } = await supabase
      .from('reminders')
      .update({ status: 'cancelled' })
      .eq('id', item.id)
      .eq('status', 'scheduled')
      .select('id')
    if (cancelError) {
      setError(`Could not cancel the reminder: ${cancelError.message}`)
    } else if (!data || data.length === 0) {
      setError('The reminder was not cancelled. Nothing changed.')
    } else {
      await load()
    }
  }

  return (
    <section className="section">
      <h2>Reminders</h2>
      {items.length === 0 && !error && (
        <p className="muted">No reminders waiting. Ask Myla to remind you of something.</p>
      )}
      {hasDevice === false && (
        <p className="muted small">
          No phone is set up to alert you yet, so these are saved but will not notify you.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ul className="list">
        {items.map((item) => {
          const passed = new Date(item.remind_at).getTime() < Date.now()
          return (
            <li key={item.id} className="task">
              <div className="task-body">
                <span className="title">{item.title}</span>
                <span className={passed ? 'due overdue' : 'due'}>
                  {formatDue(item.remind_at)}
                  {deviceZone !== activeZone() ? ` (${formatDevice(item.remind_at)} on this device)` : ''}
                  {passed ? ' · time passed, delivery not confirmed' : ''}
                </span>
              </div>
              <button className="btn ghost small" onClick={() => void cancel(item)}>
                Cancel
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

type MemoryItem = {
  id: string
  content: string
  kind: string
  status: 'active' | 'pending'
}

// Everything Myla remembers about you. You can add, approve, reject and delete.
// Projects and commitments are saved at once; anything else waits here for your yes.
function Memory({ version }: { version: number }) {
  const [items, setItems] = useState<MemoryItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const { data, error: loadError } = await supabase
      .from('memory_items')
      .select('id, content, kind, status')
      .order('created_at', { ascending: false })
      .limit(100)
    if (loadError) {
      setError(`Could not load memory: ${loadError.message}`)
    } else {
      setError(null)
      setItems((data ?? []) as MemoryItem[])
    }
    setLoaded(true)
  }, [])

  useEffect(() => {
    void load()
  }, [load, version])

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const content = draft.trim()
    if (!content) return
    setSaving(true)
    try {
      const { error: insertError } = await supabase
        .from('memory_items')
        .insert({ content, kind: 'fact', status: 'active', source: 'stated' })
      if (insertError) {
        setError(`Could not save: ${insertError.message}`)
      } else {
        setDraft('')
        await load()
      }
    } finally {
      setSaving(false)
    }
  }

  async function approve(item: MemoryItem) {
    const { data, error: updateError } = await supabase
      .from('memory_items')
      .update({ status: 'active' })
      .eq('id', item.id)
      .eq('status', 'pending')
      .select('id')
    if (updateError) setError(`Could not approve: ${updateError.message}`)
    else if (!data || data.length === 0) setError('Nothing was approved. Nothing changed.')
    else await load()
  }

  async function remove(item: MemoryItem) {
    if (item.status === 'active' && !window.confirm(`Forget "${item.content}"? This cannot be undone.`)) return
    const { data, error: deleteError } = await supabase
      .from('memory_items')
      .delete()
      .eq('id', item.id)
      .select('id')
    if (deleteError) setError(`Could not delete: ${deleteError.message}`)
    else if (!data || data.length === 0) setError('Nothing was deleted. Nothing changed.')
    else await load()
  }

  const pending = items.filter((m) => m.status === 'pending')
  const active = items.filter((m) => m.status === 'active')

  return (
    <section className="section">
      <h2>Memory</h2>
      <p className="muted small">
        What Myla remembers about you. Projects and commitments are saved at once. Anything else waits
        here for your approval.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {pending.length > 0 && (
        <>
          <p className="small">Waiting for your approval</p>
          <ul className="list">
            {pending.map((m) => (
              <li key={m.id} className="task">
                <div className="task-body">
                  <span className="title">{m.content}</span>
                  <span className="due">{m.kind}</span>
                </div>
                <button className="btn small" onClick={() => void approve(m)}>
                  Approve
                </button>
                <button className="btn ghost small" onClick={() => void remove(m)}>
                  Reject
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {loaded && active.length === 0 && pending.length === 0 ? (
        <p className="muted">Nothing saved yet.</p>
      ) : (
        <ul className="list">
          {active.map((m) => (
            <li key={m.id} className="task">
              <div className="task-body">
                <span className="title">{m.content}</span>
                <span className="due">{m.kind}</span>
              </div>
              <button className="btn ghost small" onClick={() => void remove(m)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className="card add" onSubmit={add}>
        <input
          aria-label="Add something for Myla to remember"
          placeholder="Add something for Myla to remember…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="btn" type="submit" disabled={saving || !draft.trim()}>
          {saving ? 'Saving…' : 'Add to memory'}
        </button>
      </form>
    </section>
  )
}

const DEFAULT_SWITCHES: Record<string, boolean> = {
  reminders: true,
  morning_summary: true,
  overdue_nudges: true,
  suggestions: true,
}

const SWITCH_LABELS: Record<string, string> = {
  reminders: 'Reminders',
  morning_summary: 'Morning summary',
  overdue_nudges: 'Overdue nudges',
  suggestions: 'Suggestions',
}

// A 12-hour time picker. The value is kept as 24-hour HH:MM, or empty for "not set".
function TimeSelect({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  if (!value) {
    return (
      <div className="time-select">
        <span className="muted">Not set</span>
        <button type="button" className="btn ghost small" onClick={() => onChange('08:00')}>
          Set a time
        </button>
      </div>
    )
  }
  const [h24, minute] = value.split(':').map(Number)
  const period = h24 >= 12 ? 'PM' : 'AM'
  const hour12 = h24 % 12 === 0 ? 12 : h24 % 12
  const emit = (nextHour: number, nextMinute: number, nextPeriod: string) => {
    const base = nextHour % 12
    const hours = nextPeriod === 'PM' ? base + 12 : base
    onChange(`${String(hours).padStart(2, '0')}:${String(nextMinute).padStart(2, '0')}`)
  }
  return (
    <div className="time-select">
      <select aria-label={`${label} hour`} value={hour12} onChange={(e) => emit(Number(e.target.value), minute, period)}>
        {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      <select aria-label={`${label} minute`} value={minute} onChange={(e) => emit(hour12, Number(e.target.value), period)}>
        {Array.from({ length: 60 }, (_, i) => i).map((n) => (
          <option key={n} value={n}>
            {String(n).padStart(2, '0')}
          </option>
        ))}
      </select>
      <select aria-label={`${label} AM or PM`} value={period} onChange={(e) => emit(hour12, minute, e.target.value)}>
        <option value="AM">AM</option>
        <option value="PM">PM</option>
      </select>
      <button type="button" className="btn ghost small" onClick={() => onChange('')}>
        Clear
      </button>
    </div>
  )
}

// Every timezone this browser knows, plus UTC and whatever is currently saved.
function timezoneOptions(current: string): string[] {
  let zones: string[] = []
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    if (typeof intl.supportedValuesOf === 'function') zones = intl.supportedValuesOf('timeZone')
  } catch {
    // fall back to the short list below
  }
  if (zones.length === 0) {
    zones = ['Africa/Lagos', 'Africa/Nairobi', 'Africa/Johannesburg', 'Europe/London', 'Europe/Madrid',
      'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Dubai', 'Asia/Kolkata',
      'Asia/Singapore', 'Australia/Sydney']
  }
  const all = new Set<string>(['UTC', ...zones])
  if (current) all.add(current)
  return [...all].sort()
}

// Quiet hours, summary time, nudge limit and per-feature switches.
// They are stored now. Nothing uses them yet: they apply once your phone delivers alerts.
function Settings({ onSaved }: { onSaved: () => void }) {
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
  const [displayName, setDisplayName] = useState('')
  const [morning, setMorning] = useState('')
  const [quietStart, setQuietStart] = useState('')
  const [quietEnd, setQuietEnd] = useState('')
  const [cap, setCap] = useState(5)
  const [switches, setSwitches] = useState<Record<string, boolean>>(DEFAULT_SWITCHES)
  const zoneOptions = useMemo(() => timezoneOptions(timezone), [timezone])
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data, error: loadError } = await supabase
      .from('settings')
      .select('timezone, display_name, morning_summary_time, quiet_hours_start, quiet_hours_end, nudge_daily_cap, switches')
      .maybeSingle()
    if (loadError) {
      setError(`Could not load settings: ${loadError.message}`)
      return
    }
    if (data) {
      setTimezone(data.timezone ?? 'UTC')
      setDisplayName(typeof data.display_name === 'string' ? data.display_name : '')
      setMorning((data.morning_summary_time ?? '').slice(0, 5))
      setQuietStart((data.quiet_hours_start ?? '').slice(0, 5))
      setQuietEnd((data.quiet_hours_end ?? '').slice(0, 5))
      setCap(typeof data.nudge_daily_cap === 'number' ? data.nudge_daily_cap : 5)
      setSwitches({ ...DEFAULT_SWITCHES, ...(data.switches ?? {}) })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setNotice(null)
    setError(null)
    try {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone.trim() })
      } catch {
        setError('That timezone name is not recognised. Use a name like Africa/Lagos.')
        return
      }
      const { data: userData, error: userError } = await supabase.auth.getUser()
      if (userError || !userData.user) {
        setError('You are not signed in.')
        return
      }
      const { error: saveError } = await supabase.from('settings').upsert(
        {
          user_id: userData.user.id,
          timezone: timezone.trim() || 'UTC',
          display_name: displayName.trim() || null,
          morning_summary_time: morning || null,
          quiet_hours_start: quietStart || null,
          quiet_hours_end: quietEnd || null,
          nudge_daily_cap: Math.max(0, Math.floor(cap)),
          switches,
        },
        { onConflict: 'user_id' },
      )
      if (saveError) {
        setError(`Could not save settings: ${saveError.message}`)
      } else {
        await load() // show what the database now holds
        setNotice('Saved.')
        onSaved()
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="section">
      <h2>Settings</h2>
      <p className="muted small">
        The morning summary time and switch are used by the Android app: it shows a daily alert, and
        tapping it asks Myla for your summary. Quiet hours and the nudge limit are saved for later and
        do nothing yet.
      </p>
      <form className="card settings" onSubmit={save}>
        <label>
          What Myla calls you
          <input
            value={displayName}
            maxLength={60}
            placeholder="For example: Mr. Favourite"
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>
        <label>
          Timezone (tasks, reminders and times follow this)
          <select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {zoneOptions.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span>Morning summary time</span>
          <TimeSelect label="Morning summary time" value={morning} onChange={setMorning} />
        </div>
        <div className="field">
          <span>Quiet hours start</span>
          <TimeSelect label="Quiet hours start" value={quietStart} onChange={setQuietStart} />
        </div>
        <div className="field">
          <span>Quiet hours end</span>
          <TimeSelect label="Quiet hours end" value={quietEnd} onChange={setQuietEnd} />
        </div>
        <label>
          Most nudges per day
          <input
            type="number"
            min={0}
            max={50}
            value={cap}
            onChange={(e) => setCap(Number(e.target.value))}
          />
        </label>
        <div className="switches">
          {Object.keys(SWITCH_LABELS).map((key) => (
            <label key={key} className="switch">
              <input
                type="checkbox"
                checked={switches[key] ?? true}
                onChange={(e) => setSwitches({ ...switches, [key]: e.target.checked })}
              />
              {SWITCH_LABELS[key]}
            </label>
          ))}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice && <p className="muted small">{notice}</p>}
        <button className="btn" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </form>
    </section>
  )
}

// Only shown inside the Android app. Sets up alerts on this phone and reports
// what is really scheduled, read back from the phone itself.
function PhoneSetup({ version, onChange }: { version: number; onChange: () => void }) {
  const [status, setStatus] = useState<PhoneStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = useCallback(async () => {
    try {
      setStatus(await syncPhone())
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not sync this phone.')
    }
  }, [])

  // Sync on open, whenever reminders change, and when you come back to the app.
  useEffect(() => {
    void run()
  }, [run, version])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void run()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [run])

  // Keep the latest onChange without re-subscribing to phone events every render.
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })

  useEffect(() => {
    let stop: (() => void) | null = null
    let cancelled = false
    void listenForDelivery(() => onChangeRef.current(), requestSummary).then((fn) => {
      if (cancelled) fn()
      else stop = fn
    })
    return () => {
      cancelled = true
      if (stop) stop()
    }
  }, [])

  async function act(action: () => Promise<void>, done: string) {
    setBusy(true)
    setNotice(null)
    try {
      await action()
      setNotice(done)
      await run()
      onChange()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That did not work.')
    } finally {
      setBusy(false)
    }
  }

  const label = (value: string) =>
    value === 'granted' ? 'Allowed' : value === 'denied' ? 'Not allowed' : value === 'not asked' ? 'Not asked yet' : 'Unknown'

  return (
    <section className="section">
      <h2>This phone</h2>
      <div className="card phone">
        {status ? (
          <div className="phone-status">
            <span>Notifications: {label(status.notifications)}</span>
            <span>
              Exact timing: {label(status.exactAlarms)}
              {status.exactAlarms === 'denied' ? ' (alerts may be late)' : ''}
            </span>
            <span>Alerts scheduled on this phone: {status.scheduledHere}</span>
            <span>Morning summary: {status.summary || 'not checked yet'}</span>
            <span>
              Last synced: {status.syncedAt ? status.syncedAt.toLocaleTimeString([], { ...tzOpt(), hour: 'numeric', minute: '2-digit', hour12: true }) : 'not yet'}
            </span>
          </div>
        ) : (
          <p className="muted">Checking this phone…</p>
        )}
        {status?.problem && (
          <p className="error" role="alert">
            {status.problem}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice && <p className="muted small">{notice}</p>}
        <div className="quick">
          {status && status.notifications !== 'granted' && (
            <button className="btn small" disabled={busy} onClick={() => void act(requestNotifications, 'Done. Checking again.')}>
              Allow notifications
            </button>
          )}
          {status?.exactAlarms === 'denied' && (
            <button className="btn small" disabled={busy} onClick={() => void act(openExactAlarmSettings, 'Allow exact alarms there, then come back.')}>
              Allow exact alarms
            </button>
          )}
          <button className="btn ghost small" disabled={busy} onClick={() => void act(async () => {}, 'Synced.')}>
            Sync now
          </button>
          <button
            className="btn ghost small"
            disabled={busy || status?.notifications !== 'granted'}
            onClick={() => void act(scheduleTest, 'Test alert set for one minute from now. Minimise Myla and wait.')}
          >
            Test alert in 1 minute
          </button>
          <button
            className="btn ghost small"
            disabled={busy || status?.notifications !== 'granted'}
            onClick={() =>
              void act(scheduleSummaryTest, 'Summary test set for one minute from now. Minimise Myla, wait, then tap the alert.')
            }
          >
            Test summary alert
          </button>
        </div>
        <p className="muted small">
          On Xiaomi and Redmi phones, allow autostart for Myla and set its battery option to No
          restrictions, or alerts may arrive late. If you restart the phone, open Myla once so it can
          schedule your reminders again.
        </p>
      </div>
    </section>
  )
}

type EmailItem = {
  id: string
  from: string
  subject: string
  snippet: string
  date: string
  category: string
  asks_question: boolean
  mentions_deadline: boolean
}

type EmailCounts = {
  inbox_unread: number | null
  promotions_unread: number | null
  social_unread: number | null
  updates_unread: number | null
  forums_unread: number | null
}

// Read-only look at your Gmail inbox. Nothing is sent, changed or deleted.
// Checking only happens when you press the button, and every check is logged.
function Email({ onTaskAdded }: { onTaskAdded: () => void }) {
  const [scope, setScope] = useState<'attention' | 'all_unread'>('attention')
  const [items, setItems] = useState<EmailItem[]>([])
  const [counts, setCounts] = useState<EmailCounts | null>(null)
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  async function check(nextScope: 'attention' | 'all_unread') {
    setLoading(true)
    setError(null)
    setNotice(null)
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('chat', {
        body: { action: 'email_feed', scope: nextScope, client: localClientTime() },
      })
      if (invokeError) {
        setError(await describeFunctionError(invokeError))
        return
      }
      const result = data as { items?: EmailItem[]; counts?: EmailCounts; checked_at?: string } | null
      if (!result?.items) {
        setError('No email information came back.')
        return
      }
      const { data: rows } = await supabase
        .from('attention_signals')
        .select('item_ref')
        .eq('source', 'gmail')
        .eq('action', 'dismissed')
        .limit(1000)
      setDismissed(new Set((rows ?? []).map((r) => String(r.item_ref))))
      setItems(result.items)
      setCounts(result.counts ?? null)
      setCheckedAt(result.checked_at ? new Date(result.checked_at) : new Date())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong.')
    } finally {
      setLoading(false)
    }
  }

  // What you do with a message is remembered, so Myla can learn what matters to you.
  async function recordSignal(item: EmailItem, action: 'acted' | 'dismissed'): Promise<boolean> {
    const { error: signalError } = await supabase.from('attention_signals').insert({
      source: 'gmail',
      item_ref: item.id,
      action,
      details: {
        from: item.from,
        category: item.category,
        asks_question: item.asks_question,
        mentions_deadline: item.mentions_deadline,
      },
    })
    return !signalError
  }

  async function dismiss(item: EmailItem) {
    if (await recordSignal(item, 'dismissed')) {
      setDismissed((previous) => new Set(previous).add(item.id))
    } else {
      setError('Could not record that. Nothing changed.')
    }
  }

  async function makeTask(item: EmailItem) {
    const { error: taskError } = await supabase.from('tasks').insert({ title: `Reply: ${item.subject}`.slice(0, 200) })
    if (taskError) {
      setError(`Could not add the task: ${taskError.message}`)
      return
    }
    void recordSignal(item, 'acted')
    setNotice('Task added. You can see it on the Today tab.')
    onTaskAdded()
  }

  const visible = items.filter((i) => !dismissed.has(i.id))
  const count = (n: number | null | undefined) => (typeof n === 'number' ? String(n) : 'unknown')

  return (
    <section className="section">
      <h2>Email</h2>
      <p className="muted small">
        Read-only: Myla can look at your inbox but cannot send, change or delete anything. Email text is
        treated as information, never as instructions.
      </p>

      <div className="card email-controls">
        <div className="quick">
          <button
            className={scope === 'attention' ? 'btn small' : 'btn ghost small'}
            onClick={() => setScope('attention')}
            disabled={loading}
          >
            Needs attention
          </button>
          <button
            className={scope === 'all_unread' ? 'btn small' : 'btn ghost small'}
            onClick={() => setScope('all_unread')}
            disabled={loading}
          >
            All unread
          </button>
        </div>
        <button className="btn" onClick={() => void check(scope)} disabled={loading}>
          {loading ? 'Checking…' : 'Check email'}
        </button>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="muted small">{notice}</p>}

      {counts && (
        <p className="muted small">
          Unread in inbox: {count(counts.inbox_unread)} (promotions {count(counts.promotions_unread)}, social{' '}
          {count(counts.social_unread)}, updates {count(counts.updates_unread)}, forums{' '}
          {count(counts.forums_unread)}). Showing {visible.length} of the latest
          {checkedAt
            ? `, checked ${checkedAt.toLocaleTimeString([], { ...tzOpt(), hour: 'numeric', minute: '2-digit', hour12: true })}`
            : ''}
          .
        </p>
      )}

      {checkedAt && visible.length === 0 && !error && <p className="muted">Nothing to show here.</p>}

      <ul className="list">
        {visible.map((item) => (
          <li key={item.id} className="email-item">
            <span className="title">{item.subject}</span>
            <span className="due">
              {item.from}
              {item.date ? ` · ${item.date}` : ''}
            </span>
            <span className="email-snippet">{item.snippet}</span>
            {(item.asks_question || item.mentions_deadline) && (
              <span className="chips">
                {item.asks_question && <span className="chip">Asks a question</span>}
                {item.mentions_deadline && <span className="chip chip-warn">Mentions a deadline</span>}
              </span>
            )}
            <span className="email-actions">
              <a
                className="btn ghost small"
                href={`https://mail.google.com/mail/u/0/#inbox/${item.id}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => void recordSignal(item, 'acted')}
              >
                Open in Gmail
              </a>
              <button className="btn ghost small" onClick={() => void makeTask(item)}>
                Make a task
              </button>
              <button className="btn ghost small" onClick={() => void dismiss(item)}>
                Dismiss
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
