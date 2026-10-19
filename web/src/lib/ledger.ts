// How the ledger reads, wherever money is shown.
import type { HoldPurpose, LedgerEntry, Portion } from "../holochain/types";
import { t } from "../i18n";

/// What each part of an order's held money is for.
export function portionLabel(portion: Portion): string {
  return t(`ledger.portion.${portion}`);
}

function purposeKey(purpose: HoldPurpose) {
  if (purpose === "Food") return "ledger.hold.food" as const;
  if ("DriverPay" in purpose) return "ledger.hold.driverPay" as const;
  if ("Subsidy" in purpose) return "ledger.hold.subsidy" as const;
  return "ledger.hold.collateral" as const;
}

/// One ledger entry, in words: what it was, and whether it brought money in
/// or set it aside.
export function describeLedgerEntry(entry: LedgerEntry): { label: string; direction: "in" | "out" | "none" } {
  const kind = entry.kind;
  if ("Deposit" in kind) return { label: t("ledger.deposit"), direction: "in" };
  if ("Hold" in kind) return { label: t(purposeKey(kind.Hold.purpose)), direction: "out" };
  if ("Collect" in kind) return { label: t("ledger.collected", { portion: portionLabel(kind.Collect.portion) }), direction: "in" };
  if ("Waive" in kind) return { label: t("ledger.waived", { portion: portionLabel(kind.Waive.portion) }), direction: "none" };
  if ("Forfeit" in kind) return { label: t("ledger.forfeit"), direction: "none" };
  if ("Stake" in kind) return { label: t("ledger.stake"), direction: "out" };
  if ("Redeem" in kind) return { label: t("ledger.redeem"), direction: "out" };
  if ("Reclaim" in kind) return { label: t("ledger.reclaim"), direction: "in" };
  if ("HandOver" in kind) return { label: t("ledger.handOver"), direction: "out" };
  if ("Inherit" in kind) return { label: t("ledger.inherit"), direction: "in" };
  return { label: t("ledger.unstake"), direction: "in" };
}
