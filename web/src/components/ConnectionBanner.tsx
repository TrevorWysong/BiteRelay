// The connection to the app's node, when it isn't plain sailing: getting a
// new one ("Reconnecting"), or out of attempts ("Can't reach your node",
// with Retry). Screens keep what they last showed meanwhile; their reads
// refresh once it's back.
import { useState, useSyncExternalStore } from "react";
import { RefreshCw, WifiOff } from "lucide-react";
import { connectionState, retryConnection } from "../holochain/client";

export function ConnectionBanner() {
  const state = useSyncExternalStore(connectionState.subscribe, connectionState.get);
  const [retrying, setRetrying] = useState(false);
  if (state === "connected") return null;

  async function retry() {
    setRetrying(true);
    await retryConnection().catch(() => {});
    setRetrying(false);
  }

  return (
    <div role="status" className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold ${state === "lost" ? "bg-red-600 text-white" : "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100"}`}>
      {state === "lost" ? <WifiOff size={14} /> : <RefreshCw size={14} className="animate-spin" />}
      <span className="flex-1">{state === "lost" ? "Can't reach your node." : "Reconnecting to your node..."}</span>
      {state === "lost" && (
        <button onClick={retry} disabled={retrying} className="rounded-full bg-white/20 px-3 py-1 disabled:opacity-60">
          {retrying ? "Retrying..." : "Retry"}
        </button>
      )}
    </div>
  );
}
