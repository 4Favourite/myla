import { useCallback, useEffect, useMemo, useState } from 'react'
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
    setSaving(true)
    const { error: insertError } = await supabase.from('tasks').insert({
      title,
      due_at: newDue ? new Date(newDue).toISOString() : null,
    })
    if (insertError) {
      setError(`Could not save the task: ${insertError.message}`)
    } else {
      setNewTitle('')
      setNewDue('')
      await load()
    }
    setSaving(false)
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
