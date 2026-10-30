# Payment rails: cards and HoloFuel, a plan

How customers can pay, and stores and drivers can get paid out, by card **and** by HoloFuel in a HandShake network with no company in the middle. Research and a proposed design to build from. This complements `CARD_PAYMENTS.md`, which covers the card rail in depth.

This is not legal or tax advice. Card money, crypto assets and exchanging between them each carry their own regulation, which counsel should review per country before launch.

## Short answer

**Yes, both are possible, side by side.** HandShake's ledger doesn't move cards or tokens. It moves *credits* in the network's currency, and those enter only through **issuers** on the network's roster (`IssuerGrant`). A payment rail is simply an issuer that:
- turns a payment on that rail into credits (a top-up);
- turns credits back into a payment on that rail (a cash-out).

A card issuer and a HoloFuel issuer are two rows on the same roster. Orders, escrow, collateral and every rule in this app work the same whichever way the money came in.

## What exists today

- **HandShake**
  - Every balance is its owner's own signed ledger. Credits enter by `IssuerGrant` from an issuer on the network's roster, and the customer collects them with a `Deposit`.
  - Each network names its currency (`currency` in the DNA properties, USD by default) and is prepaid (`credit_limit_cents` 0).
  - There is no cash-out yet: `CARD_PAYMENTS.md` plans a `Redeem` entry.
- **HoloFuel**
  - Holo's **mutual-credit** currency, backed by hosting capacity: hosts earn it and apps spend it, so supply grows and shrinks with real activity rather than a fixed schedule ([Holo: HoloFuel](https://holo.host/holo-fuel/)).
  - It's built by **Unyt**, a Holochain Foundation company. Its "payment rails" software is peer-to-peer, multi-currency and can bridge to blockchains ([Holochain blog](https://blog.holochain.org/ongoing-delivery-demonstrating-whats-next/), [Holochain strategic update](https://blog.holochain.org/finding-our-edge-a-strategic-update/)).
  - HOT (the 2018 token) converts 1:1 to HoloFuel. Unyt ran a technical migration test in April 2026, and Holo planned the migration for 1 November 2026, with final participation terms still pending in September ([The Block](https://www.theblock.co/price/248502/holo-hot-usd), [Holo blog](https://blog.holo.host/i/ha2gtr4RkYV/json/)).
- **What I couldn't confirm:** public developer documentation for Unyt's integration APIs. So the HoloFuel half below names *what* the integration needs, and confirming the *how* with Unyt is the first step.

## Status: HoloFuel on hold

**Decided 2026-10-11:** build cards (and bank transfer) first. HoloFuel waits until it has launched and Unyt has published how apps integrate with it; then it's worth a short exploratory build. Nothing in the cards-first work blocks it: `Redeem` and the issuer service are shared by both payment methods.

**Look into it when** any of these happens:
- HoloFuel launches for third-party apps, after the HOT migration;
- Unyt publishes developer documentation or an integration example;
- someone at Unyt can answer the questions under "What to ask Unyt".

**What to ask Unyt:**
1. **Checking payments:** can a HandShake conductor read and check a HoloFuel payment directly, by calling Unyt's app on the same conductor? If so, adding funds in HoloFuel needs no trusted issuer, the one way to make the money as decentralized as the rest of HandShake.
2. **HandShake's money as a Unyt currency:** could HandShake's dollar credits be a currency in Unyt, convertible to HoloFuel, instead of our own ledger plus an issuer?
3. **Linking identities:** how a HoloFuel payment names a HandShake account (a payment note, or a signed link between the two keys).
4. **Value:** whether HoloFuel has a reference rate, and how closely it tracks hosting costs.
5. **Legal:** whether Unyt or Holo handles identity checks and exchange to dollars.
6. **Availability:** when third-party apps can use it, and at what cost.

## Findings, October 2026

A look at where HoloFuel and Unyt actually stand, to decide whether to wait for them before building the card rail. **Decision: don't wait.** The Stripe issuer service is built (`issuer/`), and HoloFuel joins later as a second issuer, with no ledger changes.

- **HoloFuel isn't live yet.** The HOT→HoloFuel live migration starts by 1 November 2026 (a "worst-case" date), with a swap window of at least six months. The technical migration test with Unyt ran from April to May 2026 on Sepolia. ([Holo blog](https://holo.host/blog/hot-to-holofuel-technical-migration-test-ha2gtr4RkYV/), [HoloFuel overview](https://holofuel.best/))
- **It's a hosting currency, with no fiat path.** Holo describes HoloFuel as an accounting unit for hosting, not a tradeable asset, and hosting is settled in USD/EUR today. Holo Ltd "does not currently offer token exchange, conversion, or redemption services"; any conversion would be a licensed third party's. Drivers can't turn it into rent money without an exchanger. ([holo.host/currency](https://holo.host/currency/))
- **Unyt has no integration surface for another hApp yet.**
  - Unyt is an open-source (Apache-2.0) desktop app, the `unyt-sandbox`, that communities fork or run as a Moss tool.
  - There are no published SDK or API docs, no cross-DNA interface, and no Holochain version guarantees; custom setups go through Discord.
  - Its roadmap covers EVM bridging, KYC/AML hooks and "stablecoin-backed remittances", but not card or bank rails. ([docs](https://unyt.co/docs/), [sandbox](https://github.com/unytco/unyt-sandbox), [FAQ](https://unyt.co/faq/), [roadmap](https://unyt.co/blog/unyt-2025-and-2026%3A-revolutionary-p2p-payment-rails/))
- **Compliance stays with each network.** Unyt's FAQ says a deployment's configuration "will need to be designed to comply with the regulatory requirements" of its jurisdictions.

When to revisit: once live migration has begun *and* Unyt publishes integration docs. The questions to ask Unyt are below.

## Why mutual credit matters

HoloFuel is mutual credit, not a fixed-supply token: credit is created when someone spends it and settled when they deliver value back, and it's backed by hosting capacity. That changes the picture:
- **Steadier value.** It's meant to track hosting costs, not swing with speculation, though it isn't pegged to the dollar.
- **Lighter tax burden.** If its value holds, spending it gives about zero gain each time. It might also be treated like barter-exchange units rather than property. That's unsettled, so ask a tax adviser.
- **The same kind of system as HandShake's ledger.** Each person keeps their own signed ledger, and `credit_limit_cents` lets a balance go below zero: that's mutual credit, which is why networks default to prepaid. Connecting the two is a closer fit than bridging to a blockchain.
- **Credit for trusted drivers, later.** Mutual credit sets limits by contribution. Drivers with long, clean records could post collateral partly on credit, which makes driving cheaper to start.

Unchanged: customers and drivers pay rent and groceries in dollars, so a swap between HoloFuel and dollars is still needed, along with its legal questions.

## Options for HoloFuel

| Option | How it works | Trade-offs |
|---|---|---|
| **A. HoloFuel as a top-up and cash-out rail** (recommended) | A HoloFuel issuer accepts HoloFuel and grants the network's currency (e.g. USD credits) at a published rate; cash-outs pay HoloFuel back the same way | Prices stay in one familiar unit, and every rule here is unchanged. The issuer carries the exchange-rate risk between HoloFuel and the network's currency, and states its rate and spread |
| B. Orders priced in USD, settled in HoloFuel per order | Each hold converts at the rate when it's placed | Exchange-rate risk while money is held, and collateral valued in one unit but held in another. Complex, and every rule's arithmetic would need a rate |
| C. A HoloFuel-native network | A network whose currency *is* HoloFuel (`currency: "HF"`), with a HoloFuel issuer | No conversion at all; suits communities already living in HoloFuel. Menu prices are in HoloFuel, which most customers can't relate to a meal's cost |

**Recommendation:** A for mainstream networks, where HoloFuel is one way to pay among others. C stays available, with no code changes, for HoloFuel-first communities.

## Card rail, in brief

Covered in `CARD_PAYMENTS.md`:
- **Top-up:** the customer pays on Stripe's hosted checkout, so card data never touches HandShake (PCI SAQ A). The card issuer's service grants credits on a confirmed payment.
- **Cash-out:** stores and drivers cash out through Stripe Connect, under Stripe's licences.
- **Chargebacks:** the issuer bears them, with fraud tools and top-up limits.

## Recommended design: several rails, one ledger

### Issuers
- **Roster:** the network's roster already allows several issuers. Each declares its rail in the network terms (new optional `issuer_terms`): name, rail (`card`, `holofuel`, ...), contact, fees, and for HoloFuel its current rate and spread, which the app shows before a top-up.
- **Unit:** credits from any issuer are the same unit and freely spent together. A balance doesn't track which issuer funded it, which keeps privacy and simplicity.

### Money in (HoloFuel)
1. The customer chooses "Add funds with HoloFuel" and sees the issuer's rate, e.g. "1,000 HF = $9.70".
2. Their HoloFuel app (Unyt) pays the issuer's HoloFuel account, with their HandShake agent key in the payment's reference or note. That needs confirming with Unyt; the alternative is a one-time signed link between their HandShake key and their HoloFuel identity.
3. The **HoloFuel issuer service** (a conductor running both HandShake and Unyt) sees the incoming payment and writes an `IssuerGrant` to that HandShake key at the quoted rate. The reference is the HoloFuel transaction id, unique and collectable once, as for cards.
4. The customer's app collects it.

Unlike a card, a HoloFuel payment can't be charged back. Mutual credit settles between parties, so the card rail's chargeback risk doesn't apply.

### Money out (HoloFuel)
1. A store or driver writes a `Redeem { issuer, amount }` naming the HoloFuel issuer. This is the same entry `CARD_PAYMENTS.md` adds, so it's shared across rails.
2. The issuer pays the equivalent HoloFuel to their HoloFuel identity, and records `RedemptionPaid { redemption, payout_ref }` with the HoloFuel transaction id.
3. Validation guarantees each redemption is spent once. The issuer's payout is backed by its public record and its place on the roster.

### Between issuers
Credits are fungible. If customers top up by card and drivers cash out in HoloFuel, the card issuer holds dollars and the HoloFuel issuer owes HoloFuel. Issuers settle with each other off-ledger:
- **For launch:** run **one operator with both rails**, so there's nothing to settle.
- **With several operators:** each issuer publishes its outstanding credits (grants less redemptions, both readable from the ledger) and its reserves, so anyone can check it's solvent.

### What changes in HandShake
1. **Ledger:** `Redeem` and `RedemptionPaid` (shared with the card plan), with validation:
   - the redeemer owns the balance;
   - the issuer is on the roster;
   - spent once.
2. **Governance:** `issuer_terms` alongside `issuers`, read by the app (rail, fees, rate source).
3. **Issuer service:** one codebase with pluggable rails (Stripe, Unyt), each watching its rail and writing grants and payouts. An idempotency store keyed by each rail's transaction id.
4. **App:**
   - **Add funds and Cash out:** list each issuer's rails, rate and fees.
   - **HoloFuel:** a deep link or QR into the HoloFuel app with the payment pre-filled.
   - **History:** shows each top-up's and payout's rail.
5. **Policies:** each rail's terms, and that HoloFuel conversions use the issuer's published rate.

## Regulation to check
- **Cards:** see `CARD_PAYMENTS.md`: money transmission (payouts through Stripe Connect's licences) and PCI. Also check FinCEN's closed-loop prepaid access rules, which exempt closed-loop prepaid access of up to $2,000 per person per day from some obligations; HandShake credits are spendable only inside the network.
- **HoloFuel exchange:** exchanging a crypto asset for dollar-denominated credits, and back, can make the issuer a *virtual currency exchanger* or money transmitter under FinCEN's guidance and state law. Option C (a HoloFuel-native network with no conversion) avoids exchange entirely.
- **Tax:** receiving crypto assets as payment is income at its fair market value when received. Brokers of digital assets have new reporting duties (Form 1099-DA) for recent tax years. Whether a HoloFuel issuer counts as a broker needs advice. `TAX_REPORTING.md`'s statements would show each payout's rail and value.

## What to build
1. **Cards first:** the `Redeem` ledger work and the Stripe issuer service, per `CARD_PAYMENTS.md`. Most customers need cards.
2. **Generalize the issuer service:** `issuer_terms` in governance, and multi-rail Add funds and Cash out screens.
3. **HoloFuel (on hold):** a short exploratory build once it launches and Unyt's integration is public (see "Status"); then a HoloFuel payment plugin and a pilot.
4. **Several issuers:** published reserves and outstanding credits.

## Open questions for you
- **Operator:** will one operator run both payment methods at launch? Recommended; nothing to settle between issuers.
- **HoloFuel model:** decide once it launches (see "Status").
