/// <reference types="vite/client" />

/// See vite.config.ts.
declare const __DEV_HOST__: boolean;

interface ImportMetaEnv {
  /// The dev conductor's admin address (see lib/network/devNode.ts).
  readonly VITE_RELAY_ADMIN_URL?: string;
  /// "true" to keep the dev identity flow in a production build -- for
  /// testing a build against the dev conductor only (see holochain/host.ts).
  readonly VITE_RELAY_DEV_HOST?: string;
}
