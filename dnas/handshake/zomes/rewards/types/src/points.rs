//! A member's points at a store, step by step: the one set of rules the
//! app writes entries with and validation checks them by. Pure functions
//! of the program, the member's state and what happened, so every validator
//! reaches the same answer.
//!
//! When something happened (`at`) is never just an author's say-so where it
//! could earn them anything (docs/REWARDS.md):
//!
//! - an earning happens when the *store* settled the order (its
//!   `ItemSettlement`'s time), so points can't be dated into a happy hour or
//!   out of an expiry;
//! - a redemption is the member's own entry, but the order it pays for must
//!   follow it within `REDEMPTION_WINDOW_SECS`, and the store accepts an
//!   order only within minutes of when it's dated -- so a redemption dated
//!   early, to dodge an expiry, buys nothing;
//! - a gift is collected no earlier than the store granted it.

use crate::{RewardsProgram, MAX_POINTS};
use chrono::{Datelike, Timelike};
use hdi::prelude::*;

/// Where a member stands at a store after an entry.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq)]
pub struct PointsState {
    /// What they can spend.
    pub balance: u64,
    /// The calendar year (the program's local time) the counts below are for.
    pub year: i32,
    /// Points earned in `year`, and in the year before -- what their tier
    /// rests on. Grants don't count.
    pub earned_this_year: u64,
    pub earned_last_year: u64,
    /// Every point they've earned here.
    pub lifetime_earned: u64,
    /// How many orders have earned.
    pub orders: u32,
    /// When their first and latest earning orders were settled.
    pub first_earned_at: Option<Timestamp>,
    pub last_earned_at: Option<Timestamp>,
}

/// What happened, as the rules need it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    /// An order settled at `at`, earning `base` before the member's tier,
    /// the order cap and any welcome (`order_points`).
    Earn { at: Timestamp, base: u64 },
    /// A reward costing `cost`, which needs tier `min_tier`, bought at `at`.
    Spend { at: Timestamp, cost: u64, min_tier: u8 },
    /// A store's grant, collected at `at`.
    Credit { at: Timestamp, points: u64 },
}

impl Event {
    fn at(&self) -> Timestamp {
        match self {
            Event::Earn { at, .. } | Event::Spend { at, .. } | Event::Credit { at, .. } => *at,
        }
    }
}

/// A moment in a program's local time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalTime {
    pub year: i32,
    /// 1 to 12.
    pub month: u8,
    /// 0 (Monday) to 6 (Sunday).
    pub weekday: u8,
    /// Minutes after midnight.
    pub minute: u16,
}

/// `at` in `time_zone` (an IANA zone; an unknown one reads as UTC).
pub fn local_time(at: Timestamp, time_zone: &str) -> LocalTime {
    let tz: chrono_tz::Tz = time_zone.parse().unwrap_or(chrono_tz::Tz::UTC);
    let local = chrono::DateTime::from_timestamp_micros(at.as_micros()).unwrap_or_default().with_timezone(&tz);
    LocalTime {
        year: local.year(),
        month: local.month() as u8,
        weekday: local.weekday().num_days_from_monday() as u8,
        minute: (local.hour() * 60 + local.minute()) as u16,
    }
}

/// The tier `state` puts a member in: 0 for the base, `n` for the program's
/// `n`th tier -- the highest whose threshold either year's earning reached.
pub fn tier_of(program: &RewardsProgram, state: &PointsState) -> u8 {
    let earned = state.earned_this_year.max(state.earned_last_year);
    program.tiers.iter().take_while(|t| earned >= t.threshold).count() as u8
}

/// What tier `tier` earns at, in percent.
pub fn tier_percent(program: &RewardsProgram, tier: u8) -> u16 {
    match tier {
        0 => 100,
        n => program.tiers.get(usize::from(n) - 1).map_or(100, |t| t.percent),
    }
}

/// When a member's points expire, from `state`: `None` if they never do.
pub fn expires_at(program: &RewardsProgram, state: &PointsState) -> Option<Timestamp> {
    let days = program.expiry_days?;
    let last = state.last_earned_at?;
    Some(Timestamp::from_micros(last.as_micros().saturating_add(i64::from(days) * 86_400_000_000)))
}

/// `state` as of `at`: a new year moves this year's earning to last year's
/// (or clears both, after a year without an entry), and points left too
/// long without an order expire. A moment earlier than the year it already
/// counts is counted in that year.
pub fn roll(program: &RewardsProgram, state: &PointsState, at: Timestamp) -> PointsState {
    let mut next = state.clone();
    let year = local_time(at, &program.time_zone).year;
    if year > next.year {
        next.earned_last_year = if year == next.year + 1 { next.earned_this_year } else { 0 };
        next.earned_this_year = 0;
        next.year = year;
    }
    if expires_at(program, &next).is_some_and(|expiry| at > expiry) {
        next.balance = 0;
    }
    next
}

/// The state after `event`, and how many points it moved -- or why it can't
/// happen. `prior` is the member's state before (`None` for their first
/// entry at this store).
pub fn step(program: &RewardsProgram, prior: Option<&PointsState>, event: Event) -> Result<(PointsState, u64), &'static str> {
    let at = event.at();
    let start = match prior {
        Some(state) => state.clone(),
        None => PointsState { year: local_time(at, &program.time_zone).year, ..PointsState::default() },
    };
    let mut state = roll(program, &start, at);
    let cap = program.cap();
    match event {
        Event::Earn { base, .. } => {
            // Only an order that earns on its own -- above the program's
            // minimum, not refunded away -- earns a welcome too.
            if base == 0 {
                return Err("that order earns nothing");
            }
            let rate = u128::from(tier_percent(program, tier_of(program, &state)));
            let mut earned = (u128::from(base) * rate / 100).min(u128::from(MAX_POINTS)) as u64;
            if let Some(max) = program.earn.max_per_order {
                earned = earned.min(u64::from(max));
            }
            if state.orders == 0 {
                earned += u64::from(program.earn.welcome_bonus);
            }
            if earned == 0 {
                return Err("that order earns nothing");
            }
            state.balance = (state.balance + earned).min(cap);
            state.earned_this_year = (state.earned_this_year + earned).min(MAX_POINTS);
            state.lifetime_earned = (state.lifetime_earned + earned).min(MAX_POINTS);
            state.orders = state.orders.saturating_add(1);
            state.first_earned_at.get_or_insert(at);
            state.last_earned_at = Some(state.last_earned_at.map_or(at, |last| last.max(at)));
            Ok((state, earned))
        }
        Event::Spend { cost, min_tier, .. } => {
            if tier_of(program, &state) < min_tier {
                return Err("that reward needs a higher tier");
            }
            if cost == 0 || state.balance < cost {
                return Err("not enough points for that reward");
            }
            state.balance -= cost;
            Ok((state, cost))
        }
        Event::Credit { points, .. } => {
            if points == 0 {
                return Err("a grant gives something");
            }
            state.balance = (state.balance + points).min(cap);
            Ok((state, points))
        }
    }
}

/// What an order earns before the member's tier: each line's share of the
/// food paid (`eligible`, in cents), at the program's rate, faster for a
/// bonus item, then for a happy hour the order was placed in. Nothing below
/// the program's minimum. `lines` are each line's item and total before
/// any discount.
pub fn order_points(program: &RewardsProgram, lines: &[(ActionHash, u64)], eligible: u64, placed_at: Timestamp) -> u64 {
    if eligible == 0 || eligible < program.earn.min_order_cents {
        return 0;
    }
    let subtotal: u128 = lines.iter().map(|(_, total)| u128::from(*total)).sum();
    if subtotal == 0 {
        return 0;
    }
    let rate = u128::from(program.earn.points_per_dollar);
    // In hundredths of a point, so shares round once, at the end.
    let mut scaled: u128 = 0;
    for (item, total) in lines {
        let share = u128::from(*total) * u128::from(eligible) / subtotal;
        let percent = program.earn.item_bonuses.iter().find(|b| &b.item_ref == item).map_or(100, |b| b.percent);
        scaled += share * rate * u128::from(percent) / 100;
    }
    let local = local_time(placed_at, &program.time_zone);
    let happy = program
        .earn
        .happy_hours
        .iter()
        .filter(|h| h.days & (1 << local.weekday) != 0 && local.minute >= h.start_minute && local.minute < h.end_minute)
        .map(|h| h.percent)
        .max()
        .unwrap_or(100);
    (scaled * u128::from(happy) / 100 / 100).min(u128::from(MAX_POINTS)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{HappyHour, ItemBonus, Tier};

    fn hash(n: u8) -> ActionHash {
        ActionHash::from_raw_36(vec![n; 36])
    }
    /// 2026-06-15 (a Monday) at `hour`:00 in New York (UTC-4 in June).
    fn june(hour: i64) -> Timestamp {
        Timestamp::from_micros((1_781_496_000 + hour * 3600) * 1_000_000)
    }
    fn days_after(at: Timestamp, days: i64) -> Timestamp {
        Timestamp::from_micros(at.as_micros() + days * 86_400_000_000)
    }
    fn program() -> RewardsProgram {
        crate::tests::program()
    }

    #[test]
    fn local_time_follows_the_zone() {
        let t = local_time(june(12), "America/New_York");
        assert_eq!((t.year, t.month, t.weekday, t.minute), (2026, 6, 0, 12 * 60));
        assert_eq!(local_time(june(12), "Nowhere/Atall").minute, 16 * 60, "an unknown zone is UTC");
    }

    #[test]
    fn an_order_earns_its_food_at_the_rate() {
        let p = program();
        let soup = (hash(9), 1_000);
        assert_eq!(order_points(&p, std::slice::from_ref(&soup), 1_000, june(12)), 100, "$10 at 10 a dollar");
        assert_eq!(order_points(&p, std::slice::from_ref(&soup), 999, june(12)), 99, "rounded down");
        assert_eq!(order_points(&p, std::slice::from_ref(&soup), 0, june(12)), 0, "nothing paid, nothing earned");
        let mut min = p.clone();
        min.earn.min_order_cents = 1_500;
        assert_eq!(order_points(&min, &[soup], 1_000, june(12)), 0, "below the minimum");
    }

    #[test]
    fn bonus_items_and_happy_hours_earn_faster() {
        let mut p = program();
        p.earn.item_bonuses = vec![ItemBonus { item_ref: hash(9), percent: 300 }];
        let lines = [(hash(9), 500), (hash(8), 500)];
        // Paid $8 of a $10 subtotal: each line's share is $4.
        assert_eq!(order_points(&p, &lines, 800, june(12)), 40 * 3 + 40);
        p.earn.happy_hours = vec![HappyHour { days: 1, start_minute: 11 * 60, end_minute: 14 * 60, percent: 200 }, HappyHour { days: 1, start_minute: 12 * 60, end_minute: 13 * 60, percent: 150 }];
        assert_eq!(order_points(&p, &lines, 800, june(12)), (40 * 3 + 40) * 2, "the best hour that applies");
        assert_eq!(order_points(&p, &lines, 800, june(14)), 40 * 3 + 40, "an hour ends where it says");
        assert_eq!(order_points(&p, &lines, 800, days_after(june(12), 1)), 40 * 3 + 40, "only on its days");
    }

    #[test]
    fn earning_adds_the_welcome_once_and_respects_the_caps() {
        let mut p = program();
        p.earn.welcome_bonus = 50;
        p.earn.max_per_order = Some(200);
        p.max_balance = Some(300);
        let (first, earned) = step(&p, None, Event::Earn { at: june(12), base: 500 }).unwrap();
        assert_eq!(earned, 250, "capped at 200, then the welcome");
        assert_eq!((first.balance, first.orders, first.earned_this_year), (250, 1, 250));
        let (second, earned) = step(&p, Some(&first), Event::Earn { at: june(13), base: 100 }).unwrap();
        assert_eq!(earned, 100, "no second welcome");
        assert_eq!(second.balance, 300, "never more than the most a member holds");
        assert_eq!(second.lifetime_earned, 350, "though what was earned is counted");
        assert!(step(&p, Some(&second), Event::Earn { at: june(14), base: 0 }).is_err(), "an order earning nothing isn't written");
        assert!(step(&p, None, Event::Earn { at: june(14), base: 0 }).is_err(), "nor welcomed");
    }

    #[test]
    fn spending_needs_the_points_and_the_tier() {
        let mut p = program();
        p.tiers = vec![Tier { name: "Gold".into(), threshold: 1_000, percent: 150, perk: String::new() }];
        let (s, _) = step(&p, None, Event::Earn { at: june(12), base: 400 }).unwrap();
        assert!(step(&p, Some(&s), Event::Spend { at: june(13), cost: 401, min_tier: 0 }).is_err());
        assert!(step(&p, Some(&s), Event::Spend { at: june(13), cost: 100, min_tier: 1 }).is_err(), "Gold only");
        let (after, spent) = step(&p, Some(&s), Event::Spend { at: june(13), cost: 400, min_tier: 0 }).unwrap();
        assert_eq!((after.balance, spent), (0, 400));
        assert_eq!(after.earned_this_year, 400, "spending doesn't take status away");
    }

    #[test]
    fn a_tier_earns_faster_and_lasts_through_the_next_year() {
        let mut p = program();
        p.tiers = vec![Tier { name: "Gold".into(), threshold: 1_000, percent: 150, perk: String::new() }];
        let (s, _) = step(&p, None, Event::Earn { at: june(12), base: 1_000 }).unwrap();
        assert_eq!(tier_of(&p, &s), 1);
        let (s, earned) = step(&p, Some(&s), Event::Earn { at: june(13), base: 100 }).unwrap();
        assert_eq!(earned, 150, "Gold earns 1.5x");
        let next_year = days_after(june(12), 365);
        let (s, _) = step(&p, Some(&s), Event::Earn { at: next_year, base: 10 }).unwrap();
        assert_eq!((s.year, s.earned_last_year, tier_of(&p, &s)), (2027, 1_150, 1), "kept through the next year");
        let (s, _) = step(&p, Some(&s), Event::Earn { at: days_after(june(12), 365 * 3), base: 10 }).unwrap();
        assert_eq!((s.earned_last_year, tier_of(&p, &s)), (0, 0), "a year without earning clears it");
    }

    #[test]
    fn points_expire_after_the_days_without_an_order() {
        let mut p = program();
        p.expiry_days = Some(90);
        let (s, _) = step(&p, None, Event::Earn { at: june(12), base: 500 }).unwrap();
        assert!(step(&p, Some(&s), Event::Spend { at: days_after(june(12), 89), cost: 500, min_tier: 0 }).is_ok());
        assert!(step(&p, Some(&s), Event::Spend { at: days_after(june(12), 91), cost: 1, min_tier: 0 }).is_err(), "expired");
        let (fresh, _) = step(&p, Some(&s), Event::Earn { at: days_after(june(12), 91), base: 100 }).unwrap();
        assert_eq!(fresh.balance, 100, "an order after the expiry starts again from nothing");
        // A grant doesn't keep them alive.
        let (gifted, _) = step(&p, Some(&s), Event::Credit { at: days_after(june(12), 60), points: 10 }).unwrap();
        assert!(step(&p, Some(&gifted), Event::Spend { at: days_after(june(12), 91), cost: 1, min_tier: 0 }).is_err());
        // An order settled earlier than one already counted doesn't expire anything.
        let (late, _) = step(&p, Some(&s), Event::Earn { at: days_after(june(12), -1), base: 100 }).unwrap();
        assert_eq!((late.balance, late.last_earned_at), (600, Some(june(12))));
    }

    #[test]
    fn grants_respect_the_cap_but_not_the_tier() {
        let mut p = program();
        p.max_balance = Some(150);
        p.tiers = vec![Tier { name: "Gold".into(), threshold: 100, percent: 150, perk: String::new() }];
        let (s, _) = step(&p, None, Event::Credit { at: june(12), points: 500 }).unwrap();
        assert_eq!((s.balance, s.earned_this_year, tier_of(&p, &s)), (150, 0, 0));
        assert!(step(&p, Some(&s), Event::Credit { at: june(12), points: 0 }).is_err());
    }
}
