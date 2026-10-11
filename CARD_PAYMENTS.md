# Card payments: a plan

How customers pay with a card, and how stores and drivers get money out, in an app with no company in the middle. Research and a proposed design to build from. This is not legal advice: money transmission and prepaid rules vary by state and country, and a payments lawyer should review the design before launch.

## Where Relay is today

- **Ledger.** Every balance is the arithmetic of its owner's signed ledger chain (`ledger_integrity`). Money moves only by validated holds, collects and waives on orders.
- **Money in.** Money enters only through an `IssuerGrant`, written by an agent on the network's issuer roster (`issuers` in the DNA properties). The grant carries the issuer's own reference, which is unique, and its recipient collects it with a `Deposit`.
- **Money out.** There is none. Nothing turns a balance back into money in a bank account, so a store or driver can earn but can't withdraw.
- **Credit limit.** Packaging requires a credit limit of 0, so all spending is prepaid.

That issuer model is the right foundation: card payments are an issuer's job, and the ledger never has to know a card exists.

## How the big apps do it

DoorDash and Uber Eats run a single merchant account. The customer is charged per order and the platform splits the money:
- the restaurant is paid by its payout schedule;
- the driver is paid through Stripe Connect payouts (DoorDash's driver payouts and tax forms run through Stripe Express).

The platform holds the money in between, so it carries the licences, the chargebacks and the tax reporting.

Stripe Connect is built for exactly this split:
- "separate charges and transfers" lets one charge be divided between a restaurant and a driver, with the platform keeping a fee ([Stripe docs](https://docs.stripe.com/connect/separate-charges-and-transfers));
- Connect covers payouts under Stripe's money transmitter licences in the US and e-money licences in the EU, and handles identity checks (KYC) for the people being paid ([Stripe Connect](https://stripe.com/connect/payouts)).

## Options

| Option | How it works | Fits Relay? |
|---|---|---|
| **A. Issuer-backed prepaid credits** (recommended) | Customers top up by card with an issuer; the issuer grants credits on the ledger; stores and drivers redeem credits for bank payouts through the issuer | Yes: the ledger stays peer-to-peer; only top-ups and payouts touch a payment company |
| B. Per-order card charges | A platform charges each order by card and splits it with Connect | No: puts a company in the middle of every order, which is exactly what Relay removes, and makes that company the marketplace facilitator and payment intermediary |
| C. Stablecoin rails (e.g. USDC) | Balances are tokens; on- and off-ramps by exchanges | Possible later: no chargebacks and global reach, but needs a wallet and ramps per user and has its own regulation; out of scope for a card-first launch |

## Recommended design: issuer-backed credits

### Money in (top-up)
1. In the app, the customer picks an amount and pays on **Stripe Checkout**, Stripe's hosted page, or Stripe Elements, whose card fields are Stripe-hosted iframes. Card data never touches Relay's code, which keeps the PCI burden at the lowest level, SAQ A ([PCI with Stripe](https://cside.com/blog/can-you-use-stripe-for-pci-dss)).
2. Stripe sends a webhook to the **issuer service**: a small server owned by the issuer, with its own Holochain conductor and an agent key on the roster.
3. The issuer writes an `IssuerGrant` to the customer's agent key, with the Stripe payment id as `reference`. Validation already makes each grant unique and collectable once.
4. The customer's app collects the grant (`Deposit`) and the balance is spendable.

### Money out (redemption)
This is new on the ledger.
1. A store or driver onboards once to **Stripe Connect Express**, which does the KYC and holds their bank details. The issuer stores the mapping from agent key to connected account.
2. They write a `Redeem { issuer, amount }` ledger entry. It debits their balance by `amount`, payable to that issuer, and validation checks the balance covers it. The credits leave circulation once, on their own chain.
3. The issuer service sees the redemption, either via a link under the issuer, or a signal and a sweep. It pays out through Connect, citing the redemption, and records `RedemptionPaid { redemption, payout_ref }` on its own chain for the audit trail.
4. Validation guarantees a redemption is spent once. The issuer's honesty about paying out is backed by:
   - its public records;
   - the roster: a network can drop an issuer by shipping a new DNA version.

### Rules and limits

- **Settlement before spending.** Grant only on a succeeded charge (`payment_intent.succeeded`), never on authorization.
- **Chargebacks.** A card dispute can arrive after the credits are spent, and the ledger can't claw them back. The issuer absorbs that loss, the way a gift-card seller does. Mitigations:
  - Stripe Radar;
  - a per-account cap on top-ups in the first days;
  - a short hold before a fresh account's first top-up is spendable;
  - 3-D Secure, which shifts liability for fraud disputes to the card issuer.
- **Closed loop.** Credits are spendable only inside the network. Under FinCEN's rules, closed-loop prepaid access up to $2,000 per person per day is exempt from the prepaid access regulations ([Perkins Coie on the FinCEN rule](https://perkinscoie.com/en/news-insights/fincen-issues-final-rule-regarding-prepaid-access.html)). The issuer should cap top-ups below that.
- **Paying out to others is money transmission.** Turning one user's card money into another user's bank payout generally needs a state money transmitter licence. Running payouts through Stripe Connect, under Stripe's licences, is the standard way platforms avoid needing their own. Confirm this with counsel for the issuer's setup.
- **Fees.** Card top-ups cost the issuer about 2.9% + 30¢, and payouts may cost a small fee.
  - Choose who bears them: a top-up fee shown to the customer, or a redemption fee.
  - Either way, publish it in the network terms. Relay itself takes nothing.
- **Several issuers.** The roster allows more than one issuer, so communities can compete or co-operate. A redemption names its issuer. Credits are fungible across issuers, so an issuer redeems whatever it's presented. Settling between issuers is an off-ledger agreement, so start with a single issuer.

## What to build

1. **Ledger.** A `Redeem` kind and the issuer's `RedemptionPaid` record, with validation:
   - the redeemer owns the balance;
   - the named issuer is on the roster;
   - an amount bound;
   - spent once.
   Also a link that indexes redemptions under their issuer.
2. **Issuer service** (Node or Rust, outside the hApp):
   - Stripe Checkout sessions and webhooks, writing grants;
   - Connect onboarding links, and a payout worker for redemptions;
   - an idempotency store keyed by Stripe ids.
3. **App:**
   - **Add funds:** opens the issuer's hosted checkout.
   - **Cash out:** for stores and drivers, with first-time Connect onboarding.
   - **History:** balance and payout status from the ledger.
4. **Network terms:** issuer contact, top-up and payout fees, daily caps.
5. **Before launch:** legal review of money transmission and prepaid access, Stripe's platform agreement, and the dispute policy.

## Open questions for you

- **Issuer:** who runs it: you, a co-op, or a partner already licensed?
- **Fees:** who pays card fees, the customer at top-up or the store and driver at cash-out?
- **Countries:** which ones at launch? This decides Connect's account types and the licensing.
