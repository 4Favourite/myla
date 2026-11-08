// Timezone maths shared by the dashboard and the Android reminder code.

export function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

// How far ahead of UTC a timezone is at a moment, in minutes.
export function zoneOffsetMinutes(ms: number, zone: string): number {
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

// The real (UTC) moment when a wall clock in the zone reads y-m-d hh:mm.
export function zonedTimeToUtc(y: number, m: number, d: number, hh: number, mm: number, zone: string): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm)
  let utc = guess - zoneOffsetMinutes(guess, zone) * 60000
  utc = guess - zoneOffsetMinutes(utc, zone) * 60000 // the offset can differ at that moment (daylight saving)
  return utc
}

// The calendar date it is in the zone at a moment.
export function zoneYmd(ms: number, zone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return { y: get('year'), m: get('month'), d: get('day') }
}
