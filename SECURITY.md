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
- Each part of a hold is decided once, by its recipient. They collect it with proof (the customer's receipt, a ruling applied to the order, or a cancellation that entitles them), or waive it back. Validation checks their own chain for a second decision.
- A payer gets money back only by that waiver or by a ruling, and never after giving their receipt. A collection made on the strength of a receipt is refused if the payer was already refunded. Both checks read the payer's own chain.
- Arbitrators write no money entries. Their rulings are only evidence.

**Order history.** An entry's current version is the tip of its longest branch of updates, never the latest timestamp (`relay_coordinator_support::resolve_latest`). Money doesn't depend on which branch wins, because each party settles from the exact versions it cites.

**Reputation is summed from evidence, never from summaries.**
- Each review's link carries its rating and order, and validation checks both against the review.
- A rating counts one vote per customer per order.
- No checkpoint someone else wrote is trusted, because nobody can verify it's complete.
- Only an order's own customer, store or driver records events about it, and only an arbitrator records a ruling's outcome.

**Content.**
- Images must be inline PNG, JPEG, WebP or GIF, at most 300 KB. Never a link, which would tell a server who viewed what, and never an SVG, which can carry script.
- Every free-text field has a length limit.
- The production UI ships a Content-Security-Policy that allows only its own code, inline images, the local conductor and OpenStreetMap.

**Signals.** `recv_remote_signal` checks who actually sent a signal against the order it's about. Anything it tells the user is read from the order, not from the payload. A signal that doesn't check out is dropped.

**Store acceptance.** Validation can't tell an old price or a deactivated promo from a current one, because it sees records as they were. The store's own conductor checks both against its own chain before accepting, and only the store can accept.

**"It never arrived" claims** (`dispatch::pin`, `dispatch::arbitration`).
- Every delivery has a 6-digit PIN. The order publishes only `sha256(pin || salt)`; the PIN and salt are sealed to the customer and to each arbitrator. Without the salt, nobody (the driver included) can test guesses against the commitment.
- A store chooses when drivers must collect it at the door: never, after the customer has lost a dispute (the default), or always. Validation refuses a drop-off without it where it's required. Drivers see the requirement, and the customer's record, before bidding.
- The customer is told the moment the driver records the drop-off, and has a window (`confirm_window_secs`, a day by default; an hour when the PIN was collected) to confirm or report a problem. Their money stays held either way.
- After the window, the driver's conductor raises the delivery as `NotConfirmed`, sharing its sealed photo and location with the arbitrators. An arbitrator's conductor rules the clear cases on its own: a matching PIN, a customer whose sealed PIN doesn't match their own commitment, or an unconfirmed drop-off with the driver's photo that the customer never disputed. Everything else waits for a person, with the evidence and the customer's record in front of them.
- A handoff's location and photo are sealed between its two parties, and reach arbitrators only when a party shares them.
- Drivers publish no presence: they find work by reading the open orders around them.

## 2026-10 audit: findings and fixes

| Finding | Severity | Fix |
| --- | --- | --- |
| Anyone could overwrite any store's details or menu items, through the app's own `update_menu_item` | Critical | Updates check the original's author and keep the owner and store fixed |
| Balance, rating and reputation checkpoints were self-asserted. One review let its author set a store's rating to anything; anyone could set their own balance | Critical | Checkpoints removed: balances are chain arithmetic, ratings are sums of validated link tags |
| Validation ran only at the entry's authority, so other authorities accepted anything a modified conductor published | Critical | Every op type goes through the same rules |
| Payment was optional and came after the food. Free identities meant free food, and the driver's collateral went to the customer, so a customer and driver working together could rob a store | Critical | Escrow, as above. Collateral goes to the store if a ruling finds the food never arrived |
| "Latest version" meant latest timestamp, which the writer chooses | High | Longest branch wins; money is independent of branches |
| Anyone could withdraw another driver's bid, or update another driver's beacon | High | Original-author checks |
| A payer could leave a debit out of their own balance | High | Balances are walked from the chain, not summed from links |
| Arbitrators could write payments and forfeits of any size, any number of times | High | Arbitrators write no money entries |
| Spoofed chat, location and order-status signals | Medium | Sender checked; notifications read from the order |
| Anyone could attach vehicle details to any driver, and drivers could mark themselves verified | Medium | Only the driver, and `verified` is reserved |
| Images could be remote URLs (tracking pixels) or unbounded blobs; no CSP | Medium | Inline raster only, size cap, CSP |
| Deactivated promo codes stayed redeemable | Medium | The store's acceptance checks the promo on its own chain |
| Strangers could record reputation events about any order | Medium | Only an order's parties, and an arbitrator for rulings |

The tests in `tests/tryorama/src/security-regressions.test.ts` and `ledger-rules.test.ts` replay these attacks.

## What remains

- **Arbitrators are trusted.** One arbitrator decides a dispute, and two contradictory rulings on one order could pay out twice. The roster is fixed in the DNA and is the network's deliberate trust anchor.
- **Without a PIN, a photo is the driver's word.** A driver could photograph the wrong door, or record the drop-off early. The customer is told at once and can dispute within the window; an undisputed, photographed drop-off is ruled for the provider. Stores that don't require the PIN carry this risk, as a sender does for a parcel left without a signature.
- **Who orders from whom** is visible to anyone reading an order's public fields, as is a customer's ~1 km drop-off area. A driver's reads of the open-order lists for an area are seen by the peers that store those lists. See DEVELOPMENT.md, "Personal data".
- **Reviews from colluding identities.** A store can buy from itself with a second identity and review itself. It costs real money (the food is paid for), but it isn't detected.
- **Timestamps** still decide store response windows, scheduled orders and promo expiry. An author can backdate within their own chain's history. The store's acceptance check bounds the promo case.
