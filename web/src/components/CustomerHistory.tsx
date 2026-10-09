// A customer's dispute record, where drivers and stores decide whether to
// take their order: how many disputes they've lost. Public -- an
// arbitrator recorded each one -- and what a store's "PIN after a dispute"
// policy reads.
import { ShieldAlert } from "lucide-react";
import { getReputationSummary } from "../holochain/zomes/reputation";
import { bytesToHex } from "../holochain/decode";
import { useResource } from "../lib/useResource";
import { POLL } from "../lib/poll";

export function CustomerHistory({ customer, pinRequired }: { customer: Uint8Array; pinRequired?: boolean }) {
  const { data: summary } = useResource(`customer-history:${bytesToHex(customer)}`, () => getReputationSummary({ Customer: customer }), { pollMs: POLL.slow });
  const lost = summary?.dispute_resolved_against_count ?? 0;
  if (!lost && !pinRequired) return null;
  return (
    <p className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
      <ShieldAlert size={12} />
      {[lost > 0 && `Customer has lost ${lost} dispute${lost === 1 ? "" : "s"}`, pinRequired && "PIN required at the door"].filter(Boolean).join(" · ")}
    </p>
  );
}
