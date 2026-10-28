import { createClient } from '@supabase/supabase-js'

// These two values are safe to use in the browser: Row Level Security in the
// database is what protects your data. The service role (secret) key must
// never be used here.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const configError: string | null =
  !url || !key
    ? 'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy web/.env.example to web/.env, fill both in, then restart the dev server.'
    : null

// Placeholders keep the app from crashing before it can show the message above.
export const supabase = createClient(url ?? 'http://localhost', key ?? 'missing')
