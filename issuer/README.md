# Relay issuer service

A Relay network's issuer: the one party that turns real money into ledger credits and back. It is to a Relay network what a payment processor is to a shop. Relay itself never holds anyone's money.

- **Adding funds.** A customer pays on Stripe Checkout, so card data never touches Relay. Stripe signs a webhook; the service writes an `IssuerGrant` with the payment's id as its reference, once; the customer's app collects it.
- **Payout accounts.** A store or driver sets one up on Stripe Connect Express, where Stripe does the identity checks and holds the bank details.
  - They first prove they hold their agent key by signing the service's one-time nonce. The signature comes from the ledger zome's `sign_issuer_link`, which signs only that message.
  - So nobody can point someone else's payouts at their own bank.
- **Cashing out.** The service sweeps the cash-outs it's been asked to pay (`get_cash_out_requests`, resuming from a cursor) and decides each one:
  - **Payout account ready:** it pays the owner less the published fee, as a Stripe transfer keyed by the cash-out (so it's never paid twice), and records `Paid` with the transfer's id.
  - **No account ready:** it records `Declined` with a link to set one up, and the funds go back automatically.

## Fees

Adding funds is free: a customer pays exactly what they add. The issuer recovers its costs from its **cash-out fee**, published in its profile and shown in the Wallet before anyone confirms:
- **Stripe's costs:** 2.9% + 30¢ on each card payment in, and 0.25% + 25¢ on each payout, plus $2 a month for each account paid that month.
- **Default fee:** 3.25% + 55¢, which covers both the card and the payout costs over a cycle.
- **Tuning:** set it with `PAYOUT_FEE_BASIS_POINTS` and `PAYOUT_FEE_CENTS`.

## Running it (test mode)

1. **Stripe account.** Create a free Stripe account. Test mode costs nothing. In the dashboard, turn on **Connect** (Express accounts).
2. **Dev network.** `npm run dev:reset` in `web/` sets one up with an issuer identity (`dev-issuer`).
3. **Configuration.** In this folder:
   - `cp .env.example .env` and fill in `STRIPE_SECRET_KEY` (a `sk_test_` key).
   - Run `stripe listen --events checkout.session.completed --forward-to localhost:8890/webhooks/stripe` ([Stripe CLI](https://docs.stripe.com/stripe-cli)) and put the `whsec_` secret it prints in `STRIPE_WEBHOOK_SECRET`.
4. **Start.** `npm install && npm start`. The service publishes the issuer's terms, including its address, and the Wallet shows **Add funds** and **Payout account**.
5. **Try it:**
   - **Add funds:** use Stripe's test card `4242 4242 4242 4242`.
   - **Payout account:** finish Stripe's test onboarding, then cash out from the Wallet.

`.env` and the database are ignored by git. Never put keys in code, chat or commits. The service refuses a live key unless `ALLOW_LIVE_STRIPE=1`.

## Tests

`npm test` runs the service's rules with Stripe and the ledger faked:
- a payment is granted once;
- a cash-out is paid once, less the fee, or declined;
- an account is linked only on its owner's signature.

The Rust side and the cross-language signature are covered by `tests/tryorama/src/cash-out.test.ts`.

## Before real money

- **Legal review** of money transmission and prepaid access for the issuer's setup: see `CARD_PAYMENTS.md`. Payouts through Stripe Connect run under Stripe's licences.
- **A conductor of the issuer's own**, always on, whose agent key is on the network's issuer roster (`deploy/properties.json`).
- **Hosting:** the service behind https (`PUBLIC_URL`), with its database backed up.
- **Stripe Radar** and a cap on top-ups for new accounts, against card fraud. A chargeback after credits are spent is the issuer's loss.
