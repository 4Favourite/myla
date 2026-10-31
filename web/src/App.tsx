import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { configError, supabase } from './lib/supabase'
import {
  isNative,
  listenForDelivery,
  openExactAlarmSettings,
  requestNotifications,
  scheduleTest,
  syncPhone,
} from './native'
import type { PhoneStatus } from './native'
import './App.css'

// Shown at the bottom of the page so you can tell which version you are looking at.
const WEB_VERSION = '6b'

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
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function formatDue(iso: string): string {
  return new Date(iso).toLocaleString([], {
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
      const parsed = new Date(newDue)
      const year = parsed.getFullYear()
      if (Number.isNaN(parsed.getTime()) || year < 2000 || year > 2100) {
        setError('That due date does not look right. Check that the year has four digits, or clear the date.')
        return
      }
      dueAt = parsed.toISOString()
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
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const startOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
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
  }, [tasks])

  const todayLabel = new Date().toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })

  return (
    <main className="shell">
      <header className="head">
        <div>
          <h1>{greeting()}</h1>
          <p className="muted">{todayLabel}</p>
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

      {isNative && (
        <PhoneSetup
          version={activityVersion}
          onChange={() => setActivityVersion((v) => v + 1)}
        />
      )}

      <Reminders version={activityVersion} />

      <Chat
        onActivity={() => {
          setActivityVersion((v) => v + 1)
          void load()
        }}
      />

      <Activity version={activityVersion} />

      <Memory version={activityVersion} />

      <Settings />

      <p className="muted small updated">
        {loadedAt
          ? `Last loaded ${loadedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })}. `
          : ''}
        <button className="link" onClick={() => void load()}>
          Refresh
        </button>
      </p>
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
  const [chats, setChats] = useState<ChatSummary[]>([])
  const [showChats, setShowChats] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const voiceRef = useRef<VoiceSession | null>(null)
  const voiceSupported = getRecognitionCtor() !== null
  const speechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window
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

  // The list of voices this device offers (it can fill in a moment after loading).
  useEffect(() => {
    if (!speechSupported) return
    const load = () => setVoices(window.speechSynthesis.getVoices())
    load()
    window.speechSynthesis.addEventListener('voiceschanged', load)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load)
  }, [speechSupported])

  function stopSpeaking() {
    if (speechSupported) window.speechSynthesis.cancel()
    setSpeaking(false)
  }

  function speak(text: string) {
    if (!speechSupported || !speakReplies) return
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    const chosen = voices.find((v) => v.name === voiceName) ?? preferredVoice(voices)
    if (chosen) {
      utterance.voice = chosen
      utterance.lang = chosen.lang
    }
    utterance.onstart = () => setSpeaking(true)
    utterance.onend = () => setSpeaking(false)
    utterance.onerror = () => setSpeaking(false)
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
    const said = session.text.trim()
    if (session.cancelled || session.failed) return
    if (said) void sendText(said, 'voice')
    else setError('I did not hear anything. Tap the mic and try again.')
  }

  // Done (or a long enough pause) stops listening and sends what was heard.
  function stopListening() {
    const session = voiceRef.current
    if (!session) return
    session.done = true
    if (session.recognition) session.recognition.stop()
    else finishListening()
  }

  function cancelListening() {
    const session = voiceRef.current
    if (!session) return
    session.cancelled = true
    stopListening()
  }

  function runRecognition(session: VoiceSession) {
    const Ctor = getRecognitionCtor()
    if (!Ctor) return
    const recognition = new Ctor()
    recognition.lang = navigator.language || 'en-US'
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
    if (!getRecognitionCtor() || sending) return
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
    }
    voiceRef.current = session
    setError(null)
    setHeard('')
    setListening(true)
    // Allow a little longer before the first words.
    armSilenceTimer(session, pauseMs > 0 ? Math.max(pauseMs, 6000) : 0)
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
        body: { message: text, conversation_id: conversationId, client: localClientTime(), input_mode: mode },
      })
      if (invokeError) {
        // Put the message back so nothing is lost, and say what went wrong.
        setMessages((current) => current.filter((m) => m.id !== pendingId))
        setDraft(text)
        setError(await describeFunctionError(invokeError))
        return
      }
      const result = data as {
        reply?: string
        conversation_id?: string
        actions?: ChatAction[]
        confirmations?: Confirmation[]
        version?: string
      } | null
      if (!result?.reply) {
        setMessages((current) => current.filter((m) => m.id !== pendingId))
        setDraft(text)
        setError('Myla did not send a reply.')
        return
      }
      const replyText = result.reply
      speak(replyText)
      if (result.version) setFunctionVersion(result.version)
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

  return (
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
                      {new Date(c.created_at).toLocaleString([], {
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
              {speakReplies && voices.length > 0 && (
                <select
                  aria-label="Voice"
                  value={voiceName || preferredVoice(voices)?.name || ''}
                  onChange={(e) => {
                    setVoiceName(e.target.value)
                    writeSetting('myla.voice', e.target.value)
                  }}
                >
                  {voices.map((v) => (
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
            ? 'Voice input usually sends your audio to your browser maker’s speech service. Voices vary by device.'
            : 'Voice input is not available in this browser or app yet.'}
        </p>
      </div>
      <p className="muted small">
        Website version {WEB_VERSION} · Chat function version {functionVersion ?? 'not used yet'}
      </p>
    </section>
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
                  {new Date(r.created_at).toLocaleString([], {
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

  if (items.length === 0 && !error) return null

  return (
    <section className="section">
      <h2>Reminders</h2>
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
function Settings() {
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
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
      .select('timezone, morning_summary_time, quiet_hours_start, quiet_hours_end, nudge_daily_cap, switches')
      .maybeSingle()
    if (loadError) {
      setError(`Could not load settings: ${loadError.message}`)
      return
    }
    if (data) {
      setTimezone(data.timezone ?? 'UTC')
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
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="section">
      <h2>Settings</h2>
      <p className="muted small">
        Saved for later. Nothing uses these yet: they apply once your phone delivers reminders and
        summaries.
      </p>
      <form className="card settings" onSubmit={save}>
        <label>
          Timezone
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
    void listenForDelivery(() => onChangeRef.current()).then((fn) => {
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
            <span>
              Last synced: {status.syncedAt ? status.syncedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true }) : 'not yet'}
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
