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

/// What a processor's signed event means to the issuer -- `null` for one it
/// doesn't act on.
export type RailEvent =
  | { kind: "paid"; payment: CompletedPayment }
  /// A cardholder disputed a payment (a chargeback): `payment` is its id.
  | { kind: "disputed"; payment: string; amount: number }
  /// A dispute was settled: `won` if the issuer keeps the money.
  | { kind: "dispute closed"; payment: string; won: boolean }
  | null;

/// Refunds made for one cash-out.
export interface Refunded {
  reference: string;
  amount: number;
}

export interface PaymentRail {
  /// A customer record for `agent` at the processor -- `existing` if it has
  /// one -- where their saved cards live.
  customer(agent: string, existing: string | null): Promise<string>;
  /// A card form, embedded in the app, to pay `amount` for `agent` -- its
  /// client secret. The card is saved to `customer` for next time. With
  /// `verify`, the card's bank is asked to confirm the cardholder (3-D
  /// Secure), which moves a fraud chargeback's loss to the bank.
  embeddedTopUp(agent: string, customer: string, amount: number, options: { verify: boolean }): Promise<string>;
  /// What a webhook reports. Throws if the webhook isn't genuine.
  event(body: Buffer, signature: string): Promise<RailEvent>;
  /// Payments for agents completed since `since` (ms since the epoch) --
  /// what reconciliation checks every grant was made for.
  paymentsSince(since: number): Promise<CompletedPayment[]>;
  /// The card saved to `customer`, if there is one.
  savedCard(customer: string): Promise<SavedCard | null>;
  /// Charges `customer`'s saved card `amount` for `agent`, once per
  /// `idempotencyKey`.
  chargeSavedCard(agent: string, customer: string, amount: number, idempotencyKey: string): Promise<SavedCardCharge>;
  /// How much `customer`'s recent card payments could take back for the
  /// cash-out `idempotencyKey` -- counting what it already refunded.
  refundable(customer: string, idempotencyKey: string): Promise<number>;
  /// Refunds up to `amount` to `customer`'s recent card payments, newest
  /// first, for the cash-out `idempotencyKey` -- safe to repeat: what it
  /// refunded before counts. `null` if nothing could be.
  refund(customer: string, amount: number, idempotencyKey: string): Promise<Refunded | null>;
  /// A payout account for `agent` -- `existing` if it has one -- and where
  /// to send them to set it up.
  payoutAccountLink(agent: string, existing: string | null): Promise<{ account: string; url: string }>;
  /// Whether `account` can be paid yet (its owner finished setting it up).
  canPay(account: string): Promise<boolean>;
  /// Pays `amount` to `account`, once per `idempotencyKey` -- its reference.
  pay(account: string, amount: number, idempotencyKey: string): Promise<string>;
}
