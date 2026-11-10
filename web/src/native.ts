import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'
import { SpeechRecognition } from '@capgo/capacitor-speech-recognition'
import { TextToSpeech } from '@capacitor-community/text-to-speech'
import { supabase } from './lib/supabase'

// Everything here only runs inside the Android app. In a normal browser the
// dashboard never calls any of it.
export const isNative = Capacitor.isNativePlatform()

const DEVICE_KEY = 'myla.deviceId'
const CHANNEL_ID = 'reminders'
const TEST_ID = 2147483000
const SUMMARY_TEST_ID = 2147483001
const SUMMARY_BASE_ID = 2147000000 // 7 ids from here are the daily morning summary alerts
const SUMMARY_DAYS = 7

function isReserved(id: number): boolean {
  return id === TEST_ID || id === SUMMARY_TEST_ID || (id >= SUMMARY_BASE_ID && id < SUMMARY_BASE_ID + SUMMARY_DAYS)
}

export type PhoneStatus = {
  notifications: 'granted' | 'denied' | 'not asked'
  exactAlarms: 'granted' | 'denied' | 'unknown'
  scheduledHere: number
  confirmed: number
  syncedAt: Date | null
  problem: string | null
  summary: string
}

// Android needs whole-number notification ids, so each reminder gets a stable one.
export function notificationId(uuid: string): number {
  let hash = 0
  for (let i = 0; i < uuid.length; i++) {
    hash = (hash * 31 + uuid.charCodeAt(i)) | 0
  }
  return hash === 0 || isReserved(hash) ? 1 : hash
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
  const status: PhoneStatus = { ...permissions, scheduledHere: 0, confirmed: 0, syncedAt: null, problem: null, summary: '' }
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

  const stale = pending.filter((n) => !isReserved(n.id) && !wanted.has(n.id))
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
  try {
    status.summary = await syncMorningSummary()
  } catch (caught) {
    status.summary = `Could not schedule: ${caught instanceof Error ? caught.message : 'unknown error'}`
  }
  status.syncedAt = new Date()
  return status
}

// ---------------------------------------------------------------------------
// The daily morning summary alert. It only says the summary is ready; tapping it
// opens Myla and asks for a fresh summary, so it never shows out-of-date numbers.
// ---------------------------------------------------------------------------

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

function zoneOffsetMinutes(ms: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000)
}

function zonedTimeToUtc(y: number, m: number, d: number, hh: number, mm: number, zone: string): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm)
  let utc = guess - zoneOffsetMinutes(guess, zone) * 60000
  utc = guess - zoneOffsetMinutes(utc, zone) * 60000
  return utc
}

function zoneYmd(ms: number, zone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return { y: get('year'), m: get('month'), d: get('day') }
}

function twelveHour(hh: number, mm: number): string {
  return `${hh % 12 === 0 ? 12 : hh % 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`
}

// Makes the phone's morning summary alerts match Settings (time, timezone, switch).
// Returns a plain sentence describing exactly what is scheduled.
export async function syncMorningSummary(): Promise<string> {
  const { data, error } = await supabase
    .from('settings')
    .select('timezone, display_name, morning_summary_time, switches')
    .maybeSingle()
  if (error) throw new Error(`Could not read Settings: ${error.message}`)

  const pending = (await LocalNotifications.getPending()).notifications
  const old = pending.filter((n) => n.id >= SUMMARY_BASE_ID && n.id < SUMMARY_BASE_ID + SUMMARY_DAYS)
  if (old.length > 0) await LocalNotifications.cancel({ notifications: old.map((n) => ({ id: n.id })) })

  const time = typeof data?.morning_summary_time === 'string' ? data.morning_summary_time : ''
  const switches = (data?.switches ?? {}) as Record<string, unknown>
  if (!time) return 'Off: set a morning summary time in Settings.'
  if (switches.morning_summary === false) return 'Off: the Morning summary switch in Settings is off.'

  const zone =
    typeof data?.timezone === 'string' && validZone(data.timezone)
      ? data.timezone
      : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const [hh, mm] = time.split(':').map(Number)
  const name = typeof data?.display_name === 'string' ? data.display_name.trim() : ''

  const now = Date.now()
  const today = zoneYmd(now, zone)
  const notifications = []
  for (let i = 0; i < SUMMARY_DAYS + 1 && notifications.length < SUMMARY_DAYS; i++) {
    const at = zonedTimeToUtc(today.y, today.m, today.d + i, hh, mm, zone)
    if (at > now + 15000) {
      notifications.push({
        id: SUMMARY_BASE_ID + notifications.length,
        title: name ? `Good morning, ${name}` : 'Good morning',
        body: 'Your morning summary is ready. Tap to see your day.',
        channelId: CHANNEL_ID,
        extra: { type: 'summary' },
        schedule: { at: new Date(at), allowWhileIdle: true },
      })
    }
  }
  await LocalNotifications.schedule({ notifications })

  const after = (await LocalNotifications.getPending()).notifications.filter(
    (n) => n.id >= SUMMARY_BASE_ID && n.id < SUMMARY_BASE_ID + SUMMARY_DAYS,
  )
  if (after.length === 0) throw new Error('The phone did not accept the alerts.')
  return `Every day at ${twelveHour(hh, mm)} (${zone}), scheduled for the next ${after.length} days.`
}

export async function scheduleSummaryTest(): Promise<void> {
  await ensureChannel()
  await LocalNotifications.schedule({
    notifications: [
      {
        id: SUMMARY_TEST_ID,
        title: 'Good morning',
        body: 'Your morning summary is ready. Tap to see your day.',
        channelId: CHANNEL_ID,
        extra: { type: 'summary' },
        schedule: { at: new Date(Date.now() + 60000), allowWhileIdle: true },
      },
    ],
  })
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
export async function listenForDelivery(onChange: () => void, onSummaryTap: () => void): Promise<() => void> {
  const handle = async (extra: unknown) => {
    if ((extra as { type?: unknown } | undefined)?.type === 'summary') return
    const id = (extra as { reminderId?: unknown } | undefined)?.reminderId
    if (typeof id === 'string' && (await markDelivered(id, localStorage.getItem(DEVICE_KEY)))) onChange()
  }
  const received = await LocalNotifications.addListener('localNotificationReceived', (n) => {
    void handle(n.extra)
  })
  const tapped = await LocalNotifications.addListener('localNotificationActionPerformed', (event) => {
    if ((event.notification.extra as { type?: unknown } | undefined)?.type === 'summary') {
      onSummaryTap()
      return
    }
    void handle(event.notification.extra)
  })
  return () => {
    void received.remove()
    void tapped.remove()
  }
}

// ---------------------------------------------------------------------------
// Voice input inside the Android app. The app's built-in browser engine has no
// speech recognition, so this uses the phone's own recognizer through a plugin.
// ---------------------------------------------------------------------------

// Words the phone's recognizer should prefer when it offers several guesses
// (for example "Myla" over "my love", and the name you asked Myla to call you).
let vocabulary: string[] = ['myla']

export function setSpeechVocabulary(words: string[]) {
  vocabulary = ['myla', ...words.map((w) => w.trim().toLowerCase()).filter((w) => w.length > 2)]
}

function pickBest(matches: string[]): string {
  const known = matches.find((m) => vocabulary.some((w) => m.toLowerCase().includes(w)))
  return known ?? matches[0] ?? ''
}

export async function nativeSpeechReady(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const status = await SpeechRecognition.available()
    if (!status.available) {
      return { ok: false, reason: 'Speech recognition is not available on this phone.' }
    }
    let permission = await SpeechRecognition.checkPermissions()
    if (permission.speechRecognition !== 'granted') {
      permission = await SpeechRecognition.requestPermissions()
    }
    if (permission.speechRecognition !== 'granted') {
      return { ok: false, reason: 'The microphone is not allowed. Allow it for Myla in the phone settings (Apps, Myla, Permissions).' }
    }
    return { ok: true }
  } catch (caught) {
    return { ok: false, reason: caught instanceof Error ? caught.message : 'Could not start speech recognition.' }
  }
}

// Listens for one stretch of speech (the phone ends it at a short pause).
// onPartial gets the live text, onEnded gets the last text heard.
export async function startNativeSegment(
  handlers: {
    onPartial: (text: string) => void
    onEnded: (lastText: string) => void
    onError: (message: string) => void
  },
  language: string,
): Promise<void> {
  let last = ''
  let finished = false
  const handles: { remove: () => Promise<void> }[] = []
  const cleanup = () => {
    for (const handle of handles) void handle.remove()
  }
  handles.push(
    await SpeechRecognition.addListener('partialResults', (event) => {
      const text = pickBest(event.matches ?? [])
      if (text) {
        last = text
        handlers.onPartial(text)
      }
    }),
  )
  handles.push(
    await SpeechRecognition.addListener('listeningState', (event) => {
      if (event.status === 'stopped' && !finished) {
        finished = true
        cleanup()
        handlers.onEnded(last)
      }
    }),
  )
  try {
    await SpeechRecognition.start({ language, maxResults: 5, partialResults: true, popup: false })
  } catch (caught) {
    if (!finished) {
      finished = true
      cleanup()
      handlers.onError(caught instanceof Error ? caught.message : 'Could not start listening.')
    }
  }
}

export async function stopNativeListening(): Promise<void> {
  try {
    await SpeechRecognition.stop()
  } catch {
    // already stopped
  }
}

// ---------------------------------------------------------------------------
// Spoken replies inside the Android app, using the phone's own text-to-speech.
// (The app's built-in browser engine cannot speak.)
// ---------------------------------------------------------------------------

export type NativeVoice = { index: number; name: string; lang: string }

export async function nativeVoices(): Promise<NativeVoice[]> {
  try {
    const result = await TextToSpeech.getSupportedVoices()
    return result.voices.map((v, index) => ({ index, name: v.name, lang: v.lang }))
  } catch {
    return []
  }
}

// Resolves when Myla has finished speaking (or the speech was stopped).
export async function nativeSpeak(text: string, lang: string, voiceIndex?: number): Promise<void> {
  await TextToSpeech.speak({
    text,
    lang,
    rate: 1.0,
    pitch: 1.0,
    volume: 1.0,
    ...(voiceIndex !== undefined ? { voice: voiceIndex } : {}),
  })
}

export async function nativeStopSpeaking(): Promise<void> {
  try {
    await TextToSpeech.stop()
  } catch {
    // nothing was speaking
  }
}
