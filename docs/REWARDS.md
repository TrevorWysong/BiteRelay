# Rewards

Each store can run its own rewards program: points for what customers spend, rewards they buy with them, status levels, boosts, birthdays and expiry. It's the store's program, not the platform's, and it runs without a server. Each customer's points live on their own chain, and every rule below is enforced by every peer's validation.

## What a store can set

| Setting | Range |
|---|---|
| Name, what points are called, tagline, card colour (six) | |
| Points per dollar of food | 1 to 100 |
| Smallest order that earns, cap per order | Optional |
| Welcome bonus, on a member's first earning order | Up to 100,000 |
| Item boosts: an item earning faster | Up to 20 items, 1.01× to 10× |
| Happy hours: days and a time window earning faster | Up to 7, 1.01× to 5×, in the store's time zone (daylight saving included) |
| Rewards: a free item, a percent off an item, an amount off, a percent off the order | Up to 24, each with a cost and the level it needs |
| Status levels, by points earned in a calendar year, kept through the next year | Up to 4, each earning 1× to 3× and at least as fast as the one below |
| Birthday points, once a year in a member's birthday month | Up to 100,000 |
| Expiry, after so many days without an order | Off, or 30 to 1,095 days |
| Most a member can hold | Off, or at least the dearest reward's cost |

The program is versioned: changing it writes a new version. Each order cites the version it was placed under, which fixes what it earns and what its reward costs. The store's app refuses an order that cites a replaced version (unless it just raced the change), the same way it refuses an order priced from an old menu.

## How points move

Points are entries on the member's own chain, one running line per store (`PointsEntry`, in `rewards_types`). Each entry carries the state it leaves them in and points at their previous entry at that store. That state is their balance, both years' earnings, lifetime earnings, order count, and first and last earning times. Validation walks their chain to check nothing was skipped. It then recomputes the state with the same pure functions the app uses (`rewards_types::points`), so nobody can state their own balance, tier or expiry.

- **Earn.** Cites the member's own order at that store, placed under an active program version, and the store's settlement of it (`ItemSettlement`, which only the store can write, once).
  - Points come from the food paid, after discounts and the refund, without tax, split across the lines. Bonus items earn faster, then a happy hour by when the order was placed, then the member's tier, then the per-order cap, then the welcome bonus on their first order.
  - Each order earns once. The earning is dated by the store's settlement.
- **Redeem.** Spends exactly a reward's cost at an active program version, if the member has the points and the level.
  - The order that uses it cites it, and its total must take exactly that reward off, priced like a promo with no requirement.
  - A reward replaces any promo code, and doesn't apply to goodie bags.
  - Each redemption pays for one order. Every order is on its customer's own chain, so validation walks back to the redemption and refuses a second.
- **Gift.** Collects a store's `PointsGrant`, once. Only the store's owner writes grants, from their own chain, so grants cost only the store. Stores use them for:
  - goodwill points;
  - birthdays;
  - points back for an order whose food the store gave back (`Restore`, sent automatically by the store's app when it waives the food).
- **Unspend.** Takes back a redemption that no order used, once its window (`REDEMPTION_WINDOW_SECS`, an hour) has passed: a checkout that failed after spending, say.
  - It can be proven, not just assumed: an order may cite a redemption only within an hour of it, from the customer's own chain.
  - So once the hour is past, a walk back to the redemption sees every order that ever could.
  - The app runs this automatically.

## Time can't be faked

People choose their own entries' timestamps, so no rule depends on one where faking it would pay:

- **Earning** is dated by the store's settlement, not the customer. That decides expiry and which year counts toward their tier.
- **Happy hours** use the order's own time. The store accepts an order only within minutes of when it's dated, so the order can't be backdated into a happy hour.
- **A redemption** must be followed by its order within the hour, and the store's acceptance pins that order to the real time. A redemption backdated to slip past an expiry buys nothing.
- **Gifts** don't count as activity, so a grant can't keep points from expiring.
- **Birthdays** are granted by the store's own app in the member's month, once a year, and only to members who first earned there at least 30 days before. The member sets their birth month once, ever (`BirthMonth`), and only the month is shared. A customer can't claim a birthday themselves: they could cite an older, more generous program version, and nothing could stop that.

## Abuse considered

| Attempt | What stops it |
|---|---|
| Stating a balance, skipping an entry, starting the line over | Validation recomputes every entry from the member's previous one, and refuses a gap |
| Earning twice on one order, or on someone else's | One earning per order, by its own customer, checked on their chain |
| Earning on a made-up or self-written settlement | Only the order's store can write its settlement, once (`dispatch_integrity`) |
| Spending more than they have, or a reward above their level | Validation recomputes the redemption against their state |
| One redemption paying for two orders | Both orders are on the customer's chain; the second is refused |
| A discount without a redemption, or a bigger one than the reward | The order's total is recomputed, with the redemption's reward or none |
| Citing an old, more generous program version | Validation can't tell it's old, so the store's app refuses to accept the order |
| Getting points back for an order that used them | Only the store returns points for an order, as a grant; `Unspend` is refused while any order cites the redemption |
| Granting points for someone else's store | Only the store's owner may grant |
| Fake accounts farming welcome or birthday points | A welcome needs a settled, paid order that earns on its own. Birthdays need 30 days of membership, once a year. Points are only good at that store, for its food, so farming costs the store and nobody else |
| A store and a customer colluding | They can only give away the store's own food |
| Faking a store's members or redemptions | Every rewards link is written by the author of the record it points to, under the store that record is about. A birth month linked to a store many times is still celebrated once a year |

## What's left

- **Refunds won on appeal.** The arbiter's award is paid after settlement, so an order earns on what the store settled. Points from a refund won on appeal stay with the customer.
- **A lost store key.** When an issuer refunds a lost store's food (docs/RECOVERY.md), the points spent on that order don't come back, because only the store can return them.
- **Branched orders.** A store whose order history branches still decides from what its app sees. That's the same as the rest of settlement.

## Where it lives

- `dnas/handshake/zomes/rewards/types`: the program, entries and grants; `points.rs`, the rules (unit-tested); `earn.rs`, what an order earns.
- `dnas/handshake/zomes/rewards/integrity`: validation.
- `dnas/handshake/zomes/rewards/coordinator`: saving programs, cards, earning, redeeming, grants, birthdays, reclaiming unspent redemptions, stats.
- `dnas/handshake/zomes/dispatch/integrity/src/checks.rs`: an order's rewards and reward pricing (`check_rewards`).
- `dnas/handshake/zomes/dispatch/coordinator/src/pricing.rs`: joining a program at checkout, and the store's current-version check (`ensure_current_program`); `settlement.rs`, the sweep that earns and returns points.
- `web/src/lib/rewards/rewards.ts`: the same rules, for previews (`web/test/rewards.test.ts` runs the Rust cases).
- `web/src/routes/customer/Rewards.tsx`: the wallet, each card, the store page's strip. `web/src/routes/merchant/Rewards.tsx`: the program builder. `web/src/components/rewards/`: the card, the tiles, the levels.
- Tests: `tests/tryorama/src/rewards.test.ts` (every forgery above, on real conductors), `web/e2e/rewards.spec.ts`.
