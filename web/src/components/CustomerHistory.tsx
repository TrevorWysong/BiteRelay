// A customer's record, where drivers and stores decide whether to take
// their order: how many times they've said an order never arrived when its
// store found it had. Public -- each was recorded by that order's store,
// citing its decision.
import { ShieldAlert } from "lucide-react";
import { getReputationSummary } from "../holochain/zomes/reputation";
import { bytesToHex } from "../holochain/decode";
import { useResource } from "../lib/useResource";
import { POLL } from "../lib/poll";
import { useT } from "../i18n";

export function CustomerHistory({ customer }: { customer: Uint8Array }) {
  const t = useT();
  const { data: summary } = useResource(`customer-history:${bytesToHex(customer)}`, () => getReputationSummary({ Customer: customer }), { pollMs: POLL.slow });
  const contested = summary?.dispute_resolved_against_count ?? 0;
  if (!contested) return null;
  return (
    <p className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
      <ShieldAlert size={12} />
      {t("history.contested", { count: contested })}
    </p>
  );
}
