# Relay issuer service

A Relay network's issuer: the one party that turns real money into ledger credits and back. It is to a Relay network what a payment processor is to a shop. Relay itself never holds anyone's money.

- **Adding funds.** A customer pays in Stripe's embedded card form inside the app (Apple Pay and Google Pay where the device and domain allow), so card data never touches Relay. Stripe signs a webhook; the service writes an `IssuerGrant` with the payment's id as its reference, once; the customer's app collects it. Checkout uses this for a balance that's short: pay the difference, and the order is placed.
- **Saved cards.** The card is saved to the customer's Stripe customer record, so the next payment is one tap (`/saved-card/charge`), granted at once. The app's auto top-up uses the same call. At most 6 saved-card charges per customer per day.
- **Reconciliation.** Every 5 minutes the service checks Stripe's payments from the last 7 days and grants any whose webhook never arrived. Grants are idempotent by reference, so this is always safe.
- **Payout accounts.** A store or driver sets one up on Stripe Connect Express, where Stripe does the identity checks and holds the bank details.
  - They first prove they hold their agent key by signing the service's one-time nonce. The signature comes from the ledger zome's `sign_issuer_link`, which signs only that message.
  - So nobody can point someone else's payouts at their own bank.
- **Cashing out.** The service sweeps the cash-outs it's been asked to pay (`get_cash_out_requests`, resuming from a cursor) and decides each one:
  - **Payout account ready:** it pays the owner less the published fee, as a Stripe transfer keyed by the cash-out (so it's never paid twice), and records `Paid` with the transfer's id.
  - **No account, but card payments:** it refunds the amount less the fee to the owner's recent card payments, newest first (within Stripe's 180-day window), and records `Paid` with the refund ids. That's how a customer gets unspent funds back.
  - **Neither:** it records `Declined` with a link to set up a payout account, and the funds go back automatically.

- **Recovered accounts.** When someone recovers their account after losing their phone (docs/RECOVERY.md), the service reissues the old key's balance to the new key. It does so once, after the old key has been unused for `RECOVERY_WAIT_DAYS` (published as `recovery_wait_days`), keyed `recovery:<old key>`. A second recovery of the same account is left for review. A recovered key's own cash-outs are declined. A key that handed its account over is paid as usual.

Every request that touches someone's money (`/topups`, `/saved-card`, `/saved-card/charge`, `/payout-account`) carries the agent's signature over the service's one-time nonce for that purpose (`IssuerRequest`: `TopUp`, `SavedCard` or `PayoutAccount`), so a signature for one can't be replayed as another.

## Card risk

A chargeback after the credits are spent is the issuer's loss, so the service limits its exposure (`src/risk.ts`, `src/payouts.ts`):

- **Top-up limits that grow with trust.** A new account can add a little a day and a week, more after a few orders and a week, and much more after a month of ordering (`TOPUP_TIERS`). The account's age and orders are read from the network, across every key it's had. Every card form opened and saved-card charge counts against the limit, paid or not.
- **Verified first payments.** A card's first payment asks its bank to confirm the cardholder (3-D Secure), which moves a fraud chargeback's loss to the bank.
- **Card testing.** One address can open only so many card forms an hour (`TOPUPS_PER_IP_PER_HOUR`).
- **Flooding.** The one thing anyone can ask for unsigned, a nonce, is limited per address (`NONCES_PER_IP_PER_HOUR`); expired nonces are cleared as new ones are issued, and an account holds only a few unused at once.
- **Disputes freeze.** A chargeback (`charge.dispute.created`) freezes the account: no top-ups, and its cash-outs are held. It's unfrozen if the issuer wins. A lost dispute stays frozen for a person to look at.
- **Card money goes back to cards.** A cash-out refunds the person's recent card payments first; only what's left, their earnings, goes to their bank. So a stolen card's money can't come out as a bank transfer.
- **New accounts' bank payouts wait** until the account is `PAYOUT_HOLD_DAYS` old.
- **Large recoveries** above `RECOVERY_REVIEW_ABOVE_CENTS` are left for a person.

In the Stripe dashboard, also turn on **Radar** rules: block when the CVC or postcode check fails, and review payments Radar scores as elevated risk.

## Fees

Adding funds is free: a customer pays exactly what they add. The issuer recovers its costs from its **cash-out fee**, published in its profile and shown in the Wallet before anyone confirms:
- **Stripe's costs:** 2.9% + 30¢ on each card payment in, and 0.25% + 25¢ on each payout, plus $2 a month for each account paid that month.
- **Default fee:** 3.25% + 55¢, which covers both the card and the payout costs over a cycle.
- **Tuning:** set it with `PAYOUT_FEE_BASIS_POINTS` and `PAYOUT_FEE_CENTS`.

## Running it (test mode)

1. **Stripe account.** Create a free Stripe account. Test mode costs nothing. In the dashboard, turn on **Connect** (Express accounts).
2. **Dev network.** `npm run dev:reset` in `web/` sets one up with an issuer identity (`dev-issuer`).
3. **Configuration.** In this folder:
   - `cp .env.example .env` and fill in `STRIPE_SECRET_KEY` (a `sk_test_` key) and `STRIPE_PUBLISHABLE_KEY` (its `pk_test_` partner, for the embedded card form).
   - Run `stripe listen --events checkout.session.completed,charge.dispute.created,charge.dispute.closed --forward-to localhost:8890/webhooks/stripe` ([Stripe CLI](https://docs.stripe.com/stripe-cli)) and put the `whsec_` secret it prints in `STRIPE_WEBHOOK_SECRET`.
4. **Start.** `npm install && npm start`. The service publishes the issuer's terms, including its address, and the Wallet shows **Add funds** and **Payout account**.
5. **Try it:**
   - **Add funds:** use Stripe's test card `4242 4242 4242 4242`, any future date and any CVC. Never a real card.
   - **Pay at checkout:** with an empty balance, the cart's button reads "Pay $X and place order".
   - **Missed webhook:** stop `stripe listen`, pay, then wait for the next reconciliation (or restart the service).
   - **Payout account:** finish Stripe's test onboarding, then cash out from the Wallet.

`.env` and the database are ignored by git. Never put keys in code, chat or commits. The service refuses a live key unless `ALLOW_LIVE_STRIPE=1`.

## Tests

`npm test` runs the service's rules with Stripe and the ledger faked:
- a payment is granted once, and reconciliation grants only the missing ones;
- saved-card charges: signed, capped a day, granted at once, or sent to the card form when the bank wants confirmation;
- a cash-out refunded to the card when there's no payout account;
- a cash-out is paid once, less the fee, or declined;
- an account is linked only on its owner's signature.

The Rust side and the cross-language signature are covered by `tests/tryorama/src/cash-out.test.ts`.

## Before real money

- **Legal review** of money transmission and prepaid access for the issuer's setup: see `docs/CARD_PAYMENTS.md`. Payouts through Stripe Connect run under Stripe's licences.
- **A conductor of the issuer's own**, always on, whose agent key is on the network's issuer roster (`deploy/properties.json`). `scripts/conductor.mjs` runs it, and `scripts/provision.mjs` makes the key and installs the network's bundle. docs/DEPLOYMENT.md, "Run the network's servers", has the steps and a Docker Compose setup.
- **`APP_ORIGINS`**: the origins the Relay app's requests come from, in its runtime (Kangaroo's or Tauri's). After setting up a payout account, Stripe returns people to this service's own `/payouts/done` page.
- **Hosting:** the service behind https (`PUBLIC_URL`), with its database backed up.
- **Stripe Radar rules** on (see *Card risk*), and the limits tuned to the issuer's appetite for loss.
- **Apple Pay:** register the app's https domain in Stripe (Settings → Payment methods → Apple Pay). It never shows on localhost.
