// A way money comes in and goes out -- cards and banks through Stripe
// today; HoloFuel could be another. An interface, so the service's logic
// doesn't depend on any one processor and is tested without one.

/// A completed payment, as its processor reports it.
export interface CompletedPayment {
  /// The processor's id for it -- the grant's reference, so it's granted once.
  payment: string;
  /// Who it's for (an agent id), as the top-up said.
  agent: string;
  amount: number;
}

export interface PaymentRail {
  /// Where to send someone to pay `amount` for `agent`.
  topUpUrl(agent: string, amount: number): Promise<string>;
  /// The completed payment a webhook reports, if that's what it is -- or
  /// `null` for any other event. Throws if the webhook isn't genuine.
  completedPayment(body: Buffer, signature: string): Promise<CompletedPayment | null>;
  /// A payout account for `agent` -- `existing` if it has one -- and where
  /// to send them to set it up.
  payoutAccountLink(agent: string, existing: string | null): Promise<{ account: string; url: string }>;
  /// Whether `account` can be paid yet (its owner finished setting it up).
  canPay(account: string): Promise<boolean>;
  /// Pays `amount` to `account`, once per `idempotencyKey` -- its reference.
  pay(account: string, amount: number, idempotencyKey: string): Promise<string>;
}
