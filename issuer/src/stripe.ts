// Cards and banks through Stripe: an embedded card form for adding funds
// (card data never touches Relay; Apple Pay and Google Pay appear where the
// device and domain support them), saved cards for one-tap top-ups, refunds
// back to those cards, Connect Express for payout accounts -- Stripe does
// the identity checks and holds the bank details -- and transfers from the
// issuer's balance to those accounts for cash-outs.
import Stripe from "stripe";
import type { CompletedPayment, PaymentRail, SavedCardCharge } from "./rail.ts";

/// Stripe refunds a card payment for 180 days; a little inside that.
const REFUND_WINDOW_MS = 170 * 24 * 60 * 60 * 1000;

export function stripeRail(secretKey: string, webhookSecret: string, appUrl: string): PaymentRail {
  const stripe = new Stripe(secretKey);

  /// A succeeded PaymentIntent made for an agent, as a completed payment.
  const completed = (intent: Stripe.PaymentIntent): CompletedPayment | null =>
    intent.status === "succeeded" && intent.metadata?.agent && intent.amount_received > 0 ? { payment: intent.id, agent: intent.metadata.agent, amount: intent.amount_received } : null;

  return {
    async customer(agent, existing) {
      if (existing) return existing;
      return (await stripe.customers.create({ metadata: { agent } })).id;
    },

    async embeddedTopUp(agent, customer, amount) {
      const session = await stripe.checkout.sessions.create({
        ui_mode: "embedded",
        mode: "payment",
        customer,
        line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: amount, product_data: { name: "Relay balance" } } }],
        metadata: { agent },
        // The agent travels with the payment itself, so reconciliation finds
        // it; the card is kept for the next top-up.
        payment_intent_data: { metadata: { agent }, setup_future_usage: "off_session" },
        redirect_on_completion: "never",
      });
      if (!session.client_secret) throw new Error("Stripe didn't return a card form");
      return session.client_secret;
    },

    async completedPayment(body, signature): Promise<CompletedPayment | null> {
      const event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
      if (event.type !== "checkout.session.completed") return null;
      const session = event.data.object;
      // Only money that's actually in: a delayed method settles later.
      if (session.payment_status !== "paid" || !session.amount_total || !session.metadata?.agent) return null;
      const payment = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
      if (!payment) return null;
      return { payment, agent: session.metadata.agent, amount: session.amount_total };
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
          { amount, currency: "usd", customer, payment_method: data[0].id, off_session: true, confirm: true, metadata: { agent } },
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

    async refund(customer, amount, idempotencyKey) {
      // Its recent card payments with something left to refund, newest first.
      const since = Math.floor((Date.now() - REFUND_WINDOW_MS) / 1000);
      const charges: Stripe.Charge[] = [];
      for await (const charge of stripe.charges.list({ customer, created: { gte: since }, limit: 100 })) {
        if (charge.paid && !charge.refunded && charge.amount > charge.amount_refunded) charges.push(charge);
      }
      charges.sort((a, b) => b.created - a.created);
      if (charges.reduce((sum, c) => sum + c.amount - c.amount_refunded, 0) < amount) return null;
      const refunds: string[] = [];
      let left = amount;
      for (const charge of charges) {
        if (left === 0) break;
        const part = Math.min(left, charge.amount - charge.amount_refunded);
        const refund = await stripe.refunds.create({ charge: charge.id, amount: part }, { idempotencyKey: `${idempotencyKey}-${charge.id}` });
        refunds.push(refund.id);
        left -= part;
      }
      return refunds.join(",");
    },

    async payoutAccountLink(agent, existing) {
      const account = existing ?? (await stripe.accounts.create({ type: "express", metadata: { agent }, capabilities: { transfers: { requested: true } } })).id;
      const link = await stripe.accountLinks.create({ account, type: "account_onboarding", refresh_url: `${appUrl}/#/wallet`, return_url: `${appUrl}/#/wallet?payouts=1` });
      return { account, url: link.url };
    },

    async canPay(account) {
      const details = await stripe.accounts.retrieve(account);
      return details.capabilities?.transfers === "active" && details.payouts_enabled === true;
    },

    async pay(account, amount, idempotencyKey) {
      const transfer = await stripe.transfers.create({ amount, currency: "usd", destination: account }, { idempotencyKey });
      return transfer.id;
    },
  };
}
