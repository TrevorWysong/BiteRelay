// Cards and banks through Stripe: Checkout for adding funds (card data
// never touches Relay), Connect Express for payout accounts -- Stripe does
// the identity checks and holds the bank details -- and transfers from the
// issuer's balance to those accounts for cash-outs.
import Stripe from "stripe";
import type { CompletedPayment, PaymentRail } from "./rail.ts";

export function stripeRail(secretKey: string, webhookSecret: string, appUrl: string): PaymentRail {
  const stripe = new Stripe(secretKey);
  return {
    async topUpUrl(agent, amount) {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: amount, product_data: { name: "Relay balance" } } }],
        // Read back from the webhook; the agent is who the grant goes to.
        metadata: { agent },
        payment_intent_data: { metadata: { agent } },
        success_url: `${appUrl}/#/wallet?added=1`,
        cancel_url: `${appUrl}/#/wallet`,
      });
      if (!session.url) throw new Error("Stripe didn't return a checkout page");
      return session.url;
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
