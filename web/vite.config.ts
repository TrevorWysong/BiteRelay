import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // Relative asset paths, so a runtime can serve the build from wherever it
  // unpacks it (a `.webhapp` -- see DEPLOYMENT.md).
  base: './',
  define: {
    // Whether this build carries the dev host's identity code (Admin API,
    // passkeys) -- see src/holochain/host.ts. A literal, so production
    // builds drop that code entirely.
    __DEV_HOST__: JSON.stringify(mode === 'development' || process.env.VITE_RELAY_DEV_HOST === 'true'),
  },
}))
