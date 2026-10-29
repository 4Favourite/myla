import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { configError, supabase } from './lib/supabase'
import './App.css'

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

      <Chat onActivity={() => setActivityVersion((v) => v + 1)} />

      <Activity version={activityVersion} />

      <p className="muted small updated">
        {loadedAt
          ? `Last loaded ${loadedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. `
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

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  actions?: ChatAction[]
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
  const listRef = useRef<HTMLDivElement>(null)

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

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    const pendingId = `pending-${Date.now()}`
    setMessages((current) => [...current, { id: pendingId, role: 'user', content: text }])
    setDraft('')
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('chat', {
        body: { message: text, conversation_id: conversationId, client: localClientTime() },
      })
      if (invokeError) {
        // Put the message back so nothing is lost, and say what went wrong.
        setMessages((current) => current.filter((m) => m.id !== pendingId))
        setDraft(text)
        setError(await describeFunctionError(invokeError))
        return
      }
      const result = data as { reply?: string; conversation_id?: string; actions?: ChatAction[] } | null
      if (!result?.reply) {
        setMessages((current) => current.filter((m) => m.id !== pendingId))
        setDraft(text)
        setError('Myla did not send a reply.')
        return
      }
      const replyText = result.reply
      if (result.conversation_id) setConversationId(result.conversation_id)
      setMessages((current) => [
        ...current,
        { id: `reply-${Date.now()}`, role: 'assistant', content: replyText, actions: result.actions },
      ])
    } catch (caught) {
      setMessages((current) => current.filter((m) => m.id !== pendingId))
      setDraft(text)
      setError(caught instanceof Error ? caught.message : 'Something went wrong.')
    } finally {
      setSending(false)
      onActivity()
    }
  }

  return (
    <section className="section">
      <h2>Talk to Myla</h2>
      <p className="muted small">Myla can chat and read your task list. She cannot add or change tasks yet.</p>
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
                        {a.status === 'succeeded' ? '✓' : '✕'} {a.label}
                        {a.summary ? ` (${a.summary})` : ''}
                      </span>
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
      </div>
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
