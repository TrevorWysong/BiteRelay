// What a cash-out pays out after the issuer's fee -- the same rule as
// `ledger_types::IssuerProfile::payout_after_fees` and the app's
// `lib/money/wallet.ts`, so what the app promised is what's sent.
export interface Fee {
  payoutFeeCents: number;
  payoutFeeBasisPoints: number;
}

export function payoutAfterFees(fee: Fee, amount: number): number {
  const share = Math.floor((amount * fee.payoutFeeBasisPoints) / 10_000);
  return Math.max(0, amount - fee.payoutFeeCents - share);
}
