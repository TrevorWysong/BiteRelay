# Security

Relay has no server to enforce anything. Every rule that matters is in the DNA's validation, which every peer runs on everything it stores. This page covers who we defend against, what validation guarantees and how, and what it can't.

## Threat model

Assume every peer may run a modified app, and a modified conductor that skips validating its own writes. Code that runs only on the author's own conductor (any coordinator zome) protects only honest users. A rule protects the network only if it lives in integrity validation.

Identities are free: anyone can make a new key at any moment. Nothing may depend on an identity having something to lose, unless it has visibly put that thing at stake (money in escrow).

Peers choose their own action timestamps. Holochain only requires each agent's timestamps to increase along their own chain. A timestamp is the author's claim, so no rule may let a later timestamp win over someone else's action.

## What validation guarantees, and how

**Every op of every action.** Holochain validates each action as several ops, each at a different authority: the record, the entry, an update registered at its original, a link at its base, and agent activity. Every integrity zome routes all of these through the same rules (`relay_integrity_support::classify`). Otherwise a rule would hold at one authority and not at the others.

**Only an entry's author changes it.** Every update checks the author of the version it replaces, and keeps identity fields fixed: a store's owner, a menu item's store, a bid's bidder, a credential's driver. Entries that orders, payments or reviews refer to can't be deleted.

**Money is held in escrow, and a balance is its owner's own arithmetic** (`ledger_integrity`, `dispatch_types::settlement`).
- Every ledger entry is on its owner's chain, carries the balance it leaves, and points at their previous entry. Validation walks the chain to check that no entry is skipped and the sum holds.
- Money enters only from an issuer on the DNA's roster. No balance can go below the network's credit limit.
- Each step of an order holds what its author owes, in the same commit, and the step's update must cite the hold:
  - the customer's food when the store accepts;
  - the driver's pay when the customer accepts a bid;
  - the store's fee share when it starts preparing;
  - the driver's collateral (the food's value) when they pick it up.
- Each party decides each part of a hold once: they collect it on the decision that entitles them, or (as its recipient) waive it back. Validation checks their own chain for a second decision.
- Before pickup, a cancellation settles what the canceller owes. After it, every payment cites one of the store's two decisions about the order: its outcome (delivered, or not) or its settlement of the food. The store can write each only once per order, so no two payments can rest on contradictory decisions (see "Who decides" below).

**Order history.** An entry's current version is the tip of its longest branch of updates, never the latest timestamp (`relay_coordinator_support::resolve_latest`). Money doesn't depend on which branch wins, because each party settles from the exact versions it cites.

**Reputation is summed from evidence, never from summaries.**
- Each review's link carries its rating and order, and validation checks both against the review.
- A rating counts one vote per customer per order.
- No checkpoint someone else wrote is trusted, because nobody can verify it's complete.
- Only an order's own customer, store or driver records events about it, and every event cites what it rests on: the order version it records (a completion, a cancellation, a claim) or the store's decision. Validation checks the event against that record: a completion only from a completed version, a cancellation only against whoever cancelled.
- A driver's completed delivery and every outcome event (an order that never arrived, a claim that it hadn't, forfeited collateral) are recorded only by the store, citing its decision. Forfeited collateral must be exactly the bid's.

**Content.**
- Images must be inline PNG, JPEG, WebP or GIF, within the network's `max_image_bytes`. Never a link, which would tell a server who viewed what, and never an SVG, which can carry script.
- Every free-text field, list and sealed field has a size limit (`relay_integrity_support::limits`, shared with the app's forms). A sealed photo is stored as chunks the conductor can seal, bounded in number and size.
- Every link indexes a record. Anchors are computed hashes, never trees of links, so nobody can clutter one with links to nothing. A history day is indexed only by an order's customer, for the day the order was placed.

**Orders cite the terms they were placed under.** Each delivery names the store version it was placed against (`catalog_version`). Validation checks the order's fee split is that version's, and its public drop-off area (a geohash cell of fixed size) lies within that version's delivery radius.
- The production UI ships a Content-Security-Policy that allows only its own code, inline images, the local conductor and OpenStreetMap.

**Signals.** `recv_remote_signal` checks who actually sent a signal against the order it's about. Anything it tells the user is read from the order, not from the payload. A signal that doesn't check out is dropped.

**Store acceptance.** Validation can't tell an old price or a deactivated promo from a current one, because it sees records as they were. The store's own conductor checks both against its own chain before accepting, and only the store can accept.

**Handoffs** (`attestation::legs`, `dispatch::pin`, `dispatch_integrity::delivery`).
- Each delivery has two handoff codes: the customer's (committed when the order is placed) and the store's (committed when it accepts). The order publishes only `sha256(pin || salt)`; each code is sealed to its owner. Without the salt, nobody can test guesses against the commitment.
- The giver proves a handoff in one of three ways. The driver scans their code, which validation checks against the commitment. The giver confirms it in their own app (a `ReceiptAttestation`, signed on their chain). Or the driver types the digits read out, and the giver's own conductor checks them and confirms. That conductor counts wrong codes privately and stops answering after `max_code_attempts` (five by default).
- Validation refuses a pickup without the store's proof, and a delivery without the customer's. A completed delivery can't be claimed undelivered.
- Leaving an order at the door is the customer's choice, recorded on the order with their acceptance of the risk; validation refuses it otherwise. A drop-off left at the door completes the delivery. A store can set a limit (`leave_at_door_max_cents`) above which it won't accept such orders.
- A handoff's location and photo are sealed between its two parties.
- Drivers publish no presence: they find work by reading the open orders around them.

**Who decides** (`dispatch_types::issues`, `dispatch::issues`, `dispatch::never_arrived`).
- There is no referee. Proof settles almost every order. Where it can't, the store decides, because it has nothing to gain either way: it's paid for the food by the customer if the order arrived, or by the driver's collateral if it didn't.
- A customer can claim an order never arrived once it's picked up and until it's delivered. Validation refuses a claim from a customer who cancelled the order on another branch of its history: they'd be owed the driver's fee back after already conceding it.
- The store's outcome (`OrderOutcome`) is *delivered*, citing the order completed on proof, or *not delivered*, citing the customer's claim. Validation allows one per order (a walk of the store's chain back to the order's placement), only by its store, and never *not delivered* from a store that cancelled the order.
- On *not delivered*, the customer reclaims the food, the fee and the tip, the store its share of the fee, and the store takes the driver's collateral. On *delivered*, the driver collects their pay and their collateral back. The ledger checks each collection against the decision it cites.
- Until the store decides, a driver who turns up late can still complete the delivery with proof. The store's app decides an unanswered claim after `claim_grace_secs` (30 minutes by default), or the store decides sooner.

**Missing and wrong items.**
- Only the order's customer reports, only items on the order, and never more units than were ordered. Only the store answers each report, and only once. Evidence is sealed to the store.
- The store's settlement (`ItemSettlement`) names the refund. Validation allows one per order, only by its store, citing that the customer has the order: its delivered outcome, or their own update collecting a pickup. The refund can't exceed what the cited reports are worth of what the customer paid: each unit at its price, scaled by any promo, never more than ordered (`claimed_value`).
- The store's app settles once the customer's report window (`report_window_secs`, 2 hours by default) has run. It refunds what the store accepted or never answered, and gives any late report up to `answer_grace_secs` (30 minutes by default) for an answer. The store has the final say, as it would if you ordered from it directly.

## 2026-10 audit: findings and fixes

| Finding | Severity | Fix |
| --- | --- | --- |
| Anyone could overwrite any store's details or menu items, through the app's own `update_menu_item` | Critical | Updates check the original's author and keep the owner and store fixed |
| Balance, rating and reputation checkpoints were self-asserted. One review let its author set a store's rating to anything; anyone could set their own balance | Critical | Checkpoints removed: balances are chain arithmetic, ratings are sums of validated link tags |
| Validation ran only at the entry's authority, so other authorities accepted anything a modified conductor published | Critical | Every op type goes through the same rules |
| Payment was optional and came after the food. Free identities meant free food, and the driver's collateral went to the customer, so a customer and driver working together could rob a store | Critical | Escrow, as above. Collateral goes to the store if the order never arrived |
| "Latest version" meant latest timestamp, which the writer chooses | High | Longest branch wins; money is independent of branches |
| Anyone could withdraw another driver's bid, or update another driver's beacon | High | Original-author checks |
| A payer could leave a debit out of their own balance | High | Balances are walked from the chain, not summed from links |
| Arbitrators could write payments and forfeits of any size, any number of times | High | Arbitrators removed: only an order's payers and payees write its money entries, each on one decision |
| Spoofed chat, location and order-status signals | Medium | Sender checked; notifications read from the order |
| Anyone could attach vehicle details to any driver, and drivers could mark themselves verified | Medium | Only the driver, and `verified` is reserved |
| Images could be remote URLs (tracking pixels) or unbounded blobs; no CSP | Medium | Inline raster only, size cap, CSP |
| Deactivated promo codes stayed redeemable | Medium | The store's acceptance checks the promo on its own chain |
| Strangers could record reputation events about any order | Medium | Only an order's parties; outcome events only its store, citing its decision |
| Reputation events weren't checked against the orders they described: a party could record a completion that never happened, or forfeited collateral of any amount | Medium | Every event cites its order version or the store's decision, and is checked against it |
| A delivery's radius was checked only by the customer's app, so a modified client could order from any distance, and choose its own fee split | Medium | Orders cite their store version; validation checks the radius and split against it |
| Loyalty counted only completions the customer wrote, so deliveries (completed by the driver) never counted | Low | A loyalty proof is any completed version of the customer's own order |
| Anchors accepted links to path nodes from anyone, so a peer could fill a store or history anchor with links to nothing | Low | Every link targets a record; history days are indexed by the order's customer |
| Lists and sealed fields had no size limit | Low | Limits on order lines, template items, and every sealed field |
| A photo sealed in one box exceeded what the conductor can seal, so real handoff and issue photos failed | High (availability) | Photos are sealed in chunks (`SealedChunks`) |

The tests in `tests/tryorama/src/security-regressions.test.ts` and `ledger-rules.test.ts` replay these attacks.

## What remains

- **The store decides disputed deliveries.** A store could side with a customer against a driver who did deliver, by deciding an order never arrived. It gains nothing (it's paid for the food either way), and the decision is public and recorded against the driver, but the network can't overturn it. A driver is fully protected by completing the delivery with the customer's code or confirmation before the claim is decided.
- **The store's app keeps the report window on its own clock.** A store that settles early, before reports come in, or declines reports unfairly, answers to its reviews; the refund can never exceed what's reported.
- **Left at the door is the customer's risk.** A drop-off left there completes the delivery; a dishonest driver could photograph the wrong door. The photo and location are sealed to the customer, and stores can limit which orders may be left.
- **Who orders from whom** is visible to anyone reading an order's public fields, as is a customer's ~1 km drop-off area. A driver's reads of the open-order lists for an area are seen by the peers that store those lists. See DEVELOPMENT.md, "Personal data".
- **Reviews from colluding identities.** A store can buy from itself with a second identity and review itself. It costs real money (the food is paid for), but it isn't detected.
- **Timestamps** still decide store response windows, scheduled orders and promo expiry. An author can backdate within their own chain's history. The store's acceptance check bounds the promo case.
