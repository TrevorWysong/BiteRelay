// How the ledger reads, wherever money is shown.
import type { HoldPurpose, LedgerEntry, Portion } from "../holochain/types";

/// What each part of an order's held money is for.
export const PORTION_LABEL: Record<Portion, string> = {
  Food: "Food",
  Fee: "Delivery fee",
  Tip: "Tip",
  Collateral: "Driver's collateral",
};

function purposeLabel(purpose: HoldPurpose): string {
  if (purpose === "Food") return "the food";
  if ("DriverPay" in purpose) return "the driver's fee and tip";
  if ("Subsidy" in purpose) return "your share of the delivery fee";
  return "your collateral";
}

/// One ledger entry, in words: what it was, and whether it brought money in
/// or set it aside.
export function describeLedgerEntry(entry: LedgerEntry): { label: string; direction: "in" | "out" | "none" } {
  const kind = entry.kind;
  if ("Deposit" in kind) return { label: "Funds added", direction: "in" };
  if ("Hold" in kind) return { label: `Set aside for ${purposeLabel(kind.Hold.purpose)}`, direction: "out" };
  if ("Collect" in kind) return { label: `Collected: ${PORTION_LABEL[kind.Collect.portion].toLowerCase()}`, direction: "in" };
  return { label: `Returned to the payer: ${PORTION_LABEL[kind.Waive.portion].toLowerCase()}`, direction: "none" };
}
