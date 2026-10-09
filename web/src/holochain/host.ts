// How this app reaches its conductor.
//
// In production the app ships inside a Holochain runtime that hosts its UI:
// a desktop or mobile build with the Tauri plugin (tauri-plugin-holochain),
// or a launcher that runs a `.webhapp` (Kangaroo, the Holochain Launcher) --
// see DEPLOYMENT.md. The runtime runs the conductor, installs the hApp for
// its one agent, hands the UI that app, and signs zome calls itself. The UI
// only ever speaks the App API: it never sees the Admin API or a key.
//
// In development the app runs in a browser against the persistent dev
// conductor, provisioning identities through its Admin API so several
// people can share one node (`holochain/admin.ts`). That path exists only
// when `DEV_HOST` is true -- `vite dev`, or a build made with
// VITE_RELAY_DEV_HOST=true for testing -- and is compiled out of every
// other build.
import { isTauriHolochain } from "@holochain/client";

/// Whether this build may provision identities through a conductor's Admin
/// API -- a literal the build defines (vite.config.ts), so production builds
/// drop that code entirely. Check `__DEV_HOST__` itself right before a
/// dynamic import of dev code, so the bundler can see the import is dead.
export const DEV_HOST: boolean = __DEV_HOST__;

/// `launcher`: the production model, above. `dev`: the browser against a
/// dev conductor. `none`: a production build opened outside a launcher,
/// which has no conductor to talk to.
export type Host = "launcher" | "dev" | "none";

/// Whether a Holochain runtime is hosting this UI -- the same two
/// environments `AppWebsocket.connect()` (with no arguments) knows how to
/// use.
const hostedByRuntime = isTauriHolochain() || (typeof window !== "undefined" && "__HC_LAUNCHER_ENV__" in window);

export const HOST: Host = hostedByRuntime ? "launcher" : DEV_HOST ? "dev" : "none";
