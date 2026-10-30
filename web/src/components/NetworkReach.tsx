import { CloudCheck, CloudUpload } from "lucide-react";
import { getNetworkReach } from "../holochain/zomes/dispatch";
import { bytesToHex } from "../holochain/decode";
import { useResource } from "../lib/hooks/useResource";
import type { ActionHash } from "../holochain/types";
import { useT } from "../i18n";

/// How often to look again while peers are still confirming -- it's a read
/// of this node's own receipts, so cheap.
const UNTIL_CONFIRMED_MS = 5_000;

/// Whether something this person wrote has reached the network yet: on
/// their device only, confirmed by some peers, or by as many as Holochain
/// asks for. A write succeeds on the device at once; this is how they know
/// others can see it -- worth knowing on a phone that's just lost signal.
/// Shows nothing for what someone else wrote.
export function NetworkReach({ action }: { action: ActionHash }) {
  const t = useT();
  const hex = bytesToHex(action);
  const { data: reach } = useResource(`reach:${hex}`, () => getNetworkReach(action), { pollMs: UNTIL_CONFIRMED_MS });
  if (!reach) return null;
  const Icon = reach.peers > 0 ? CloudCheck : CloudUpload;
  const text = reach.complete ? t("reach.confirmed") : reach.peers > 0 ? t("reach.peers", { count: reach.peers }) : t("reach.deviceOnly");
  return (
    <p className="mt-3 flex items-center gap-1.5 border-t border-ink-100 dark:border-ink-800 pt-3 text-xs text-ink-500">
      <Icon size={13} className={reach.peers > 0 ? "text-handshake-600" : "text-ink-400"} />
      {text}
    </p>
  );
}
