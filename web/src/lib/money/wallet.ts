// The wallet: money coming in from issuers, and cashing out through them.
// `payoutAfterFees` mirrors `ledger_types::IssuerProfile::payout_after_fees`
// (tested on the same cases), so what the app says arrives is what the
// issuer's terms say it pays.
import type { CashOutStatus, IssuerProfile } from "../../holochain/types";
import { collectGrants, reclaimDeclinedCashOuts } from "../../holochain/zomes/ledger";
import { t } from "../../i18n";

/// What a cash-out of `amount` comes to after `profile`'s fee -- rounded in
/// the earner's favour, never below nothing.
export function payoutAfterFees(profile: Pick<IssuerProfile, "payout_fee_cents" | "payout_fee_basis_points">, amount: number): number {
  const share = Math.floor((amount * profile.payout_fee_basis_points) / 10_000);
  return Math.max(0, amount - profile.payout_fee_cents - share);
}

/// An issuer's fee, in words: "25¢ + 0.25%", "No fee".
export function feeLabel(profile: Pick<IssuerProfile, "payout_fee_cents" | "payout_fee_basis_points">, formatCents: (cents: number) => string): string {
  const parts = [profile.payout_fee_cents > 0 ? formatCents(profile.payout_fee_cents) : null, profile.payout_fee_basis_points > 0 ? `${(profile.payout_fee_basis_points / 100).toFixed(2).replace(/\.?0+$/, "")}%` : null].filter(Boolean);
  return parts.length ? t("wallet.fee", { fee: parts.join(" + ") }) : t("wallet.noFee");
}

/// Where a cash-out stands, for its chip.
export function cashOutStatusLabel(status: CashOutStatus): { label: string; tone: "neutral" | "success" | "warn" } {
  if (status === "Pending") return { label: t("wallet.status.processing"), tone: "neutral" };
  if ("Paid" in status) return { label: t("wallet.status.paid"), tone: "success" };
  if ("Declined" in status) return { label: t("wallet.status.returning"), tone: "warn" };
  return { label: t("wallet.status.returned"), tone: "warn" };
}

/// Takes in whatever's owed to the caller from outside an order: funds an
/// issuer added, and cash-outs it declined. Safe to repeat.
export async function collectIncoming(): Promise<number> {
  const [grants, returned] = await Promise.all([collectGrants(), reclaimDeclinedCashOuts()]);
  return grants + returned;
}
