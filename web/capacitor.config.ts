import type { CapacitorConfig } from '@capacitor/cli'

// Wraps the built website (the dist folder) in an Android app.
const config: CapacitorConfig = {
  appId: 'app.myla.assistant',
  appName: 'Myla',
  webDir: 'dist',
}

export default config
