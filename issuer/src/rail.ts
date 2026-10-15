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

/// A card saved for someone, as they'd recognise it.
export interface SavedCard {
  brand: string;
  last4: string;
}

/// Paying with a saved card: done, or the bank wants the person to confirm
/// it themselves (3-D Secure), which only the card form can do.
export type SavedCardCharge = { paid: CompletedPayment } | { needsConfirmation: true };

export interface PaymentRail {
  /// A customer record for `agent` at the processor -- `existing` if it has
  /// one -- where their saved cards live.
  customer(agent: string, existing: string | null): Promise<string>;
  /// A card form, embedded in the app, to pay `amount` for `agent` -- its
  /// client secret. The card is saved to `customer` for next time.
  embeddedTopUp(agent: string, customer: string, amount: number): Promise<string>;
  /// The completed payment a webhook reports, if that's what it is -- or
  /// `null` for any other event. Throws if the webhook isn't genuine.
  completedPayment(body: Buffer, signature: string): Promise<CompletedPayment | null>;
  /// Payments for agents completed since `since` (ms since the epoch) --
  /// what reconciliation checks every grant was made for.
  paymentsSince(since: number): Promise<CompletedPayment[]>;
  /// The card saved to `customer`, if there is one.
  savedCard(customer: string): Promise<SavedCard | null>;
  /// Charges `customer`'s saved card `amount` for `agent`, once per
  /// `idempotencyKey`.
  chargeSavedCard(agent: string, customer: string, amount: number, idempotencyKey: string): Promise<SavedCardCharge>;
  /// Refunds `amount` to `customer`'s recent card payments, newest first,
  /// once per `idempotencyKey` -- the refunds' reference, or `null` if their
  /// payments can't cover it.
  refund(customer: string, amount: number, idempotencyKey: string): Promise<string | null>;
  /// A payout account for `agent` -- `existing` if it has one -- and where
  /// to send them to set it up.
  payoutAccountLink(agent: string, existing: string | null): Promise<{ account: string; url: string }>;
  /// Whether `account` can be paid yet (its owner finished setting it up).
  canPay(account: string): Promise<boolean>;
  /// Pays `amount` to `account`, once per `idempotencyKey` -- its reference.
  pay(account: string, amount: number, idempotencyKey: string): Promise<string>;
}
