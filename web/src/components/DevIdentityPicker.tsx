import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, UserRound } from "lucide-react";
import { encodeHashToBase64 } from "@holochain/client";
import { identityLabel } from "../lib/devNode";
import { useResource } from "../lib/useResource";
import { describeError } from "../lib/errors";
import { Spinner } from "./ui";

/// Dev-only: sign in as any identity already on the node -- most usefully
/// the people `npm run seed` creates (a merchant with two stores, a
/// driver, customers), so testing a flow from each side takes one click
/// instead of a fresh onboarding per role. The list is only read once the
/// picker is opened.
export function DevIdentityPicker({
  adminUrl,
  onPick,
  disabled,
  label = "Use an existing identity on this node (dev)",
}: {
  adminUrl: string;
  onPick: (installedAppId: string, agentPubKey: Uint8Array) => void;
  disabled: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  // The Admin API code loads only when the picker is opened (and only exists
  // in dev builds -- see holochain/host.ts).
  const { data: identities, error } = useResource(open && adminUrl ? `node-identities:${adminUrl}` : null, async () => {
    if (!__DEV_HOST__) return [];
    return (await import("../holochain/admin")).listNodeIdentities(adminUrl);
  });

  return (
    <div className="mt-4 rounded-xl border border-dashed border-ink-200 dark:border-ink-700">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between px-3 py-2.5 text-left text-xs font-semibold text-ink-500">
        <span>{label}</span>
        <motion.span animate={{ rotate: open ? 180 : 0 }}>
          <ChevronDown size={14} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden border-t border-dashed border-ink-200 dark:border-ink-700">
            {error !== undefined ? (
              <p className="px-3 py-2.5 text-xs text-red-600">Couldn't reach {adminUrl}: {describeError(error)}. Is `npm run dev:conductor` running?</p>
            ) : identities === undefined ? (
              <div className="flex justify-center py-3">
                <Spinner className="h-4 w-4" />
              </div>
            ) : identities.length === 0 ? (
              <p className="px-3 py-2.5 text-xs text-ink-400">No identities yet. Run `npm run seed` to create a demo world.</p>
            ) : (
              identities.map((identity) => {
                const keyB64 = encodeHashToBase64(identity.agentPubKey);
                return (
                  <button
                    key={identity.installedAppId}
                    disabled={disabled}
                    onClick={() => onPick(identity.installedAppId, identity.agentPubKey)}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-ink-50 disabled:opacity-40 dark:hover:bg-ink-800/60"
                  >
                    <UserRound size={14} className="shrink-0 text-ink-400" />
                    <span className="flex-1 font-medium text-ink-800 dark:text-ink-100">{identityLabel(identity.installedAppId, keyB64)}</span>
                    <span className="font-mono text-[10px] text-ink-300">{keyB64.slice(0, 10)}…</span>
                  </button>
                );
              })
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
