import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'
import { supabase } from './lib/supabase'

// Everything here only runs inside the Android app. In a normal browser the
// dashboard never calls any of it.
export const isNative = Capacitor.isNativePlatform()

const DEVICE_KEY = 'myla.deviceId'
const CHANNEL_ID = 'reminders'
const TEST_ID = 2147483000

export type PhoneStatus = {
  notifications: 'granted' | 'denied' | 'not asked'
  exactAlarms: 'granted' | 'denied' | 'unknown'
  scheduledHere: number
  confirmed: number
  syncedAt: Date | null
  problem: string | null
}

// Android needs whole-number notification ids, so each reminder gets a stable one.
export function notificationId(uuid: string): number {
  let hash = 0
  for (let i = 0; i < uuid.length; i++) {
    hash = (hash * 31 + uuid.charCodeAt(i)) | 0
  }
  return hash === 0 || hash === TEST_ID ? 1 : hash
}

async function readPermissions(): Promise<Pick<PhoneStatus, 'notifications' | 'exactAlarms'>> {
  const permission = await LocalNotifications.checkPermissions()
  const notifications =
    permission.display === 'granted' ? 'granted' : permission.display === 'denied' ? 'denied' : 'not asked'
  let exactAlarms: PhoneStatus['exactAlarms'] = 'unknown'
  try {
    const exact = (await LocalNotifications.checkExactNotificationSetting()) as unknown as Record<string, string>
    exactAlarms = exact.exact_alarm === 'granted' ? 'granted' : 'denied'
  } catch {
    // some Android versions have no such setting
  }
  return { notifications, exactAlarms }
}

export async function requestNotifications(): Promise<void> {
  await LocalNotifications.requestPermissions()
}

export async function openExactAlarmSettings(): Promise<void> {
  await LocalNotifications.changeExactNotificationSetting()
}

async function ensureChannel(): Promise<void> {
  await LocalNotifications.createChannel({
    id: CHANNEL_ID,
    name: 'Reminders',
    description: 'Reminders you set with Myla',
    importance: 5,
    visibility: 1,
    vibration: true,
  })
}

// Tell the database this phone exists, so Myla knows alerts are possible.
async function registerDevice(permissions: Record<string, string>): Promise<string> {
  const stored = localStorage.getItem(DEVICE_KEY)
  const patch = { last_seen_at: new Date().toISOString(), granted_permissions: permissions }
  if (stored) {
    const { data, error } = await supabase.from('devices').update(patch).eq('id', stored).select('id')
    if (!error && data && data.length > 0) return stored
  }
  const { data, error } = await supabase
    .from('devices')
    .insert({ name: 'Android phone', platform: 'android', ...patch })
    .select('id')
    .single()
  if (error || !data) throw new Error(`Could not register this phone: ${error?.message ?? 'unknown error'}`)
  localStorage.setItem(DEVICE_KEY, data.id as string)
  return data.id as string
}

async function markDelivered(reminderId: string, deviceId: string | null): Promise<boolean> {
  const { data, error } = await supabase
    .from('reminders')
    .update({ status: 'delivered', delivered_at: new Date().toISOString(), delivered_on_device: deviceId })
    .eq('id', reminderId)
    .eq('status', 'scheduled')
    .select('id')
  return !error && !!data && data.length > 0
}

// A reminder counts as delivered only with evidence: its notification is showing
// in the notification tray, or the app saw it arrive or be tapped.
async function confirmDelivered(deviceId: string): Promise<number> {
  const shown = (await LocalNotifications.getDeliveredNotifications()).notifications
  const shownIds = new Set(shown.map((n) => n.id))
  if (shownIds.size === 0) return 0
  const { data, error } = await supabase
    .from('reminders')
    .select('id')
    .eq('status', 'scheduled')
    .lte('remind_at', new Date().toISOString())
    .limit(100)
  if (error || !data) return 0
  let count = 0
  for (const row of data) {
    if (shownIds.has(notificationId(row.id as string)) && (await markDelivered(row.id as string, deviceId))) count++
  }
  return count
}

// Makes this phone's alarms match the saved reminders, then reports what is
// really scheduled (read back from the phone, not assumed).
export async function syncPhone(): Promise<PhoneStatus> {
  const permissions = await readPermissions()
  const status: PhoneStatus = { ...permissions, scheduledHere: 0, confirmed: 0, syncedAt: null, problem: null }
  if (permissions.notifications !== 'granted') return status

  await ensureChannel()
  const deviceId = await registerDevice({
    notifications: permissions.notifications,
    exact_alarms: permissions.exactAlarms,
  })
  status.confirmed = await confirmDelivered(deviceId)

  const { data, error } = await supabase
    .from('reminders')
    .select('id, title, remind_at')
    .eq('status', 'scheduled')
    .gt('remind_at', new Date().toISOString())
    .order('remind_at', { ascending: true })
    .limit(60)
  if (error) throw new Error(`Could not read your reminders: ${error.message}`)
  const rows = data ?? []

  const wanted = new Set(rows.map((r) => notificationId(r.id as string)))
  const pending = (await LocalNotifications.getPending()).notifications
  const pendingIds = new Set(pending.map((n) => n.id))

  const stale = pending.filter((n) => n.id !== TEST_ID && !wanted.has(n.id))
  if (stale.length > 0) {
    await LocalNotifications.cancel({ notifications: stale.map((n) => ({ id: n.id })) })
  }

  const missing = rows.filter((r) => !pendingIds.has(notificationId(r.id as string)))
  if (missing.length > 0) {
    await LocalNotifications.schedule({
      notifications: missing.map((r) => ({
        id: notificationId(r.id as string),
        title: 'Reminder',
        body: r.title as string,
        channelId: CHANNEL_ID,
        extra: { reminderId: r.id },
        schedule: { at: new Date(r.remind_at as string), allowWhileIdle: true },
      })),
    })
  }

  const after = (await LocalNotifications.getPending()).notifications
  status.scheduledHere = after.filter((n) => wanted.has(n.id)).length
  if (status.scheduledHere < rows.length) {
    status.problem = `Only ${status.scheduledHere} of ${rows.length} reminders could be scheduled on this phone.`
  }
  status.syncedAt = new Date()
  return status
}

export async function scheduleTest(): Promise<void> {
  await ensureChannel()
  await LocalNotifications.schedule({
    notifications: [
      {
        id: TEST_ID,
        title: 'Myla test',
        body: 'If you can see this, alerts work on this phone.',
        channelId: CHANNEL_ID,
        schedule: { at: new Date(Date.now() + 60000), allowWhileIdle: true },
      },
    ],
  })
}

// Notices when a reminder arrives or is tapped while the app is open or reopened.
export async function listenForDelivery(onChange: () => void): Promise<() => void> {
  const handle = async (extra: unknown) => {
    const id = (extra as { reminderId?: unknown } | undefined)?.reminderId
    if (typeof id === 'string' && (await markDelivered(id, localStorage.getItem(DEVICE_KEY)))) onChange()
  }
  const received = await LocalNotifications.addListener('localNotificationReceived', (n) => {
    void handle(n.extra)
  })
  const tapped = await LocalNotifications.addListener('localNotificationActionPerformed', (event) => {
    void handle(event.notification.extra)
  })
  return () => {
    void received.remove()
    void tapped.remove()
  }
}
