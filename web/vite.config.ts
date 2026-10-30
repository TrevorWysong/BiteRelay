import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// What a production build may load, and from where. Everything a store,
// driver or customer publishes is shown in this app -- names, photos,
// notes -- so the browser itself refuses anything but this app's own code,
// inline images, the conductor's local websocket, and OpenStreetMap's tiles
// and geocoder (src/components/LiveMap.tsx, src/lib/places/geocoding.ts). Even if a
// published entry ever slipped past validation, it couldn't load a tracking
// pixel or a script. Build-only: Vite's dev server needs inline scripts.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // Leaflet and the UI's animations set inline style attributes.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.tile.openstreetmap.org",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:* https://nominatim.openstreetmap.org",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

function contentSecurityPolicy(): Plugin {
  return {
    name: 'handshake-content-security-policy',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`),
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), contentSecurityPolicy()],
  // Relative asset paths, so a runtime can serve the build from wherever it
  // unpacks it (a `.webhapp` -- see docs/DEPLOYMENT.md).
  base: './',
  define: {
    // Whether this build carries the dev host's identity code (Admin API,
    // passkeys) -- see src/holochain/host.ts. A literal, so production
    // builds drop that code entirely.
    __DEV_HOST__: JSON.stringify(mode === 'development' || process.env.VITE_HANDSHAKE_DEV_HOST === 'true'),
  },
}))
