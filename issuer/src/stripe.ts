// Cards and banks through Stripe: an embedded card form for adding funds
// (card data never touches Relay; Apple Pay and Google Pay appear where the
// device and domain support them), saved cards for one-tap top-ups, refunds
// back to those cards, Connect Express for payout accounts -- Stripe does
// the identity checks and holds the bank details -- and transfers from the
// issuer's balance to those accounts for cash-outs.
import Stripe from "stripe";
import type { CompletedPayment, PaymentRail, RailEvent, Refunded, SavedCardCharge } from "./rail.ts";

/// Stripe refunds a card payment for 180 days; a little inside that.
const REFUND_WINDOW_MS = 170 * 24 * 60 * 60 * 1000;

/// `currency`: the network's (an ISO 4217 code), which every amount is in.
/// `publicUrl`: this service's own address, where Stripe sends people back
/// after setting up a payout account (the app itself isn't a website).
export function stripeRail(secretKey: string, webhookSecret: string, publicUrl: string, currency: string): PaymentRail {
  const stripe = new Stripe(secretKey);
  currency = currency.toLowerCase();

  /// The customer's recent card payments, newest first, with their refunds.
  async function recentCharges(customer: string): Promise<Stripe.Charge[]> {
    const since = Math.floor((Date.now() - REFUND_WINDOW_MS) / 1000);
    const charges: Stripe.Charge[] = [];
    for await (const charge of stripe.charges.list({ customer, created: { gte: since }, limit: 100, expand: ["data.refunds"] })) {
      if (charge.paid && !charge.disputed) charges.push(charge);
    }
    return charges.sort((a, b) => b.created - a.created);
  }

  /// The refunds already made for one cash-out, tagged with its key.
  const refundsFor = (charges: Stripe.Charge[], key: string) => charges.flatMap((c) => c.refunds?.data ?? []).filter((r) => r.metadata?.cash_out === key && r.status !== "failed" && r.status !== "canceled");

  /// A succeeded PaymentIntent made for an agent, as a completed payment.
  const completed = (intent: Stripe.PaymentIntent): CompletedPayment | null =>
    intent.status === "succeeded" && intent.metadata?.agent && intent.amount_received > 0 ? { payment: intent.id, agent: intent.metadata.agent, amount: intent.amount_received } : null;

  return {
    async customer(agent, existing) {
      if (existing) return existing;
      return (await stripe.customers.create({ metadata: { agent } })).id;
    },

    async embeddedTopUp(agent, customer, amount, { verify }) {
      const session = await stripe.checkout.sessions.create({
        ui_mode: "embedded",
        mode: "payment",
        customer,
        line_items: [{ quantity: 1, price_data: { currency, unit_amount: amount, product_data: { name: "Relay balance" } } }],
        metadata: { agent },
        // The agent travels with the payment itself, so reconciliation finds
        // it; the card is kept for the next top-up.
        payment_intent_data: { metadata: { agent }, setup_future_usage: "off_session" },
        // The billing address is one more thing Radar checks a card against.
        billing_address_collection: "auto",
        ...(verify && { payment_method_options: { card: { request_three_d_secure: "any" } } }),
        redirect_on_completion: "never",
      });
      if (!session.client_secret) throw new Error("Stripe didn't return a card form");
      return session.client_secret;
    },

    async event(body, signature): Promise<RailEvent> {
      const event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
      const intentOf = (intent: string | { id: string } | null | undefined) => (typeof intent === "string" ? intent : intent?.id);
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          // Only money that's actually in: a delayed method settles later.
          const payment = intentOf(session.payment_intent);
          if (session.payment_status !== "paid" || !session.amount_total || !session.metadata?.agent || !payment) return null;
          return { kind: "paid", payment: { payment, agent: session.metadata.agent, amount: session.amount_total } };
        }
        case "charge.dispute.created": {
          const payment = intentOf(event.data.object.payment_intent);
          return payment ? { kind: "disputed", payment, amount: event.data.object.amount } : null;
        }
        case "charge.dispute.closed": {
          const payment = intentOf(event.data.object.payment_intent);
          const { status } = event.data.object;
          return payment ? { kind: "dispute closed", payment, won: status === "won" || status === "warning_closed" } : null;
        }
        default:
          return null;
      }
    },

    async paymentsSince(since) {
      const payments: CompletedPayment[] = [];
      for await (const intent of stripe.paymentIntents.list({ created: { gte: Math.floor(since / 1000) }, limit: 100 })) {
        const payment = completed(intent);
        if (payment) payments.push(payment);
      }
      return payments;
    },

    async savedCard(customer) {
      const { data } = await stripe.paymentMethods.list({ customer, type: "card", limit: 1 });
      const card = data[0]?.card;
      return card ? { brand: card.brand, last4: card.last4 } : null;
    },

    async chargeSavedCard(agent, customer, amount, idempotencyKey): Promise<SavedCardCharge> {
      const { data } = await stripe.paymentMethods.list({ customer, type: "card", limit: 1 });
      if (!data[0]) throw new Error("No card is saved yet.");
      try {
        const intent = await stripe.paymentIntents.create(
          { amount, currency, customer, payment_method: data[0].id, off_session: true, confirm: true, metadata: { agent } },
          { idempotencyKey },
        );
        const paid = completed(intent);
        return paid ? { paid } : { needsConfirmation: true };
      } catch (err) {
        // The bank wants the cardholder to confirm it themselves.
        if (err instanceof Stripe.errors.StripeCardError && err.code === "authentication_required") return { needsConfirmation: true };
        throw err;
      }
    },

    async refundable(customer, key) {
      const charges = await recentCharges(customer);
      const open = charges.reduce((sum, c) => sum + c.amount - c.amount_refunded, 0);
      return open + refundsFor(charges, key).reduce((sum, r) => sum + r.amount, 0);
    },

    async refund(customer, amount, key): Promise<Refunded | null> {
      const charges = await recentCharges(customer);
      // What an earlier, interrupted try already refunded counts: never twice.
      const earlier = refundsFor(charges, key);
      const done = earlier.reduce((sum, r) => sum + r.amount, 0);
      const refunds = earlier.map((r) => r.id);
      let left = Math.max(0, amount - done);
      for (const charge of charges) {
        if (left === 0) break;
        const part = Math.min(left, charge.amount - charge.amount_refunded);
        if (part <= 0) continue;
        // Keyed by what was done before this try, so a repeat of this very
        // try is the same request, and a later one a new one.
        const refund = await stripe.refunds.create({ charge: charge.id, amount: part, metadata: { cash_out: key } }, { idempotencyKey: `${key}-${charge.id}-${done}` });
        refunds.push(refund.id);
        left -= part;
      }
      const refunded = Math.min(amount, done) + (Math.max(0, amount - done) - left);
      return refunded > 0 ? { reference: refunds.join(","), amount: refunded } : null;
    },

    async payoutAccountLink(agent, existing) {
      const account = existing ?? (await stripe.accounts.create({ type: "express", metadata: { agent }, capabilities: { transfers: { requested: true } } })).id;
      const link = await stripe.accountLinks.create({ account, type: "account_onboarding", refresh_url: `${publicUrl}/payouts/expired`, return_url: `${publicUrl}/payouts/done` });
      return { account, url: link.url };
    },

    async canPay(account) {
      const details = await stripe.accounts.retrieve(account);
      return details.capabilities?.transfers === "active" && details.payouts_enabled === true;
    },

    async pay(account, amount, idempotencyKey) {
      const transfer = await stripe.transfers.create({ amount, currency, destination: account }, { idempotencyKey });
      return transfer.id;
    },
  };
}
