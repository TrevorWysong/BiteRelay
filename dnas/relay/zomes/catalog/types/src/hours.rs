//! When a store takes orders: a weekly schedule in the store's own time
//! zone. Pure arithmetic on a local weekday and minute -- converting an
//! instant to the store's local time is the coordinator's job (it has the
//! time-zone database; integrity zomes don't need it). Mirrored for the app
//! in `web/src/lib/storeHours.ts`, with shared test cases.

use serde::{Deserialize, Serialize};

pub const MINUTES_PER_DAY: u16 = 24 * 60;
/// Enough for split shifts every day of the week.
pub const MAX_OPENING_PERIODS: usize = 28;

/// One period a store is open: from `opens` to `closes` on `weekday`
/// (0 = Sunday), in minutes after local midnight. A `closes` at or before
/// `opens` runs past midnight into the next day -- 18:00 to 02:00 is
/// `opens: 1080, closes: 120`.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpeningPeriod {
    pub weekday: u8,
    pub opens: u16,
    pub closes: u16,
}

impl OpeningPeriod {
    /// Why this period is malformed, if it is.
    pub fn problem(&self) -> Option<&'static str> {
        if self.weekday > 6 {
            Some("an opening period's weekday must be 0 (Sunday) to 6")
        } else if self.opens >= MINUTES_PER_DAY || self.closes >= MINUTES_PER_DAY {
            Some("an opening period's times must be minutes after midnight, under 1440")
        } else if self.opens == self.closes {
            Some("an opening period must have some length")
        } else {
            None
        }
    }

    fn overnight(&self) -> bool {
        self.closes <= self.opens
    }
}

/// Whether a store with `schedule` is open at `minute` (after local
/// midnight) on local `weekday`. An empty schedule means no set hours: open
/// whenever the store has ordering switched on.
pub fn open_at(schedule: &[OpeningPeriod], weekday: u8, minute: u16) -> bool {
    if schedule.is_empty() {
        return true;
    }
    let yesterday = (weekday + 6) % 7;
    schedule.iter().any(|period| {
        if period.weekday == weekday {
            minute >= period.opens && (period.overnight() || minute < period.closes)
        } else {
            // Yesterday's overnight period, still running this morning.
            period.weekday == yesterday && period.overnight() && minute < period.closes
        }
    })
}

/// The next time the store opens after `minute` on `weekday`, as (days
/// ahead, minute of that day) -- for "opens at 8:00 tomorrow". `None` for a
/// schedule with no periods at all.
pub fn next_opening(schedule: &[OpeningPeriod], weekday: u8, minute: u16) -> Option<(u8, u16)> {
    (0..=7u8)
        .flat_map(|ahead| {
            let day = (weekday + ahead) % 7;
            let mut opens: Vec<u16> = schedule.iter().filter(|p| p.weekday == day).map(|p| p.opens).collect();
            opens.sort_unstable();
            opens.into_iter().map(move |opens| (ahead, opens))
        })
        .find(|&(ahead, opens)| ahead > 0 || opens > minute)
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn period(weekday: u8, opens: u16, closes: u16) -> OpeningPeriod {
        OpeningPeriod { weekday, opens, closes }
    }
    const H: u16 = 60;

    #[test]
    fn no_schedule_means_no_set_hours() {
        assert!(open_at(&[], 3, 2 * H));
        assert_eq!(next_opening(&[], 3, 0), None);
    }

    #[test]
    fn a_daytime_period_is_open_from_opening_up_to_closing() {
        let schedule = [period(1, 8 * H, 22 * H)];
        assert!(!open_at(&schedule, 1, 8 * H - 1));
        assert!(open_at(&schedule, 1, 8 * H));
        assert!(open_at(&schedule, 1, 22 * H - 1));
        assert!(!open_at(&schedule, 1, 22 * H), "closing time itself is closed");
        assert!(!open_at(&schedule, 2, 12 * H), "only on its own weekday");
    }

    #[test]
    fn an_overnight_period_runs_into_the_next_morning() {
        // Saturday 18:00 to Sunday 02:00.
        let schedule = [period(6, 18 * H, 2 * H)];
        assert!(open_at(&schedule, 6, 23 * H));
        assert!(open_at(&schedule, 0, H), "Sunday 01:00 is still Saturday night");
        assert!(!open_at(&schedule, 0, 2 * H));
        assert!(!open_at(&schedule, 6, 17 * H));
    }

    #[test]
    fn split_shifts_close_between_them() {
        let schedule = [period(2, 11 * H, 14 * H), period(2, 17 * H, 22 * H)];
        assert!(open_at(&schedule, 2, 12 * H));
        assert!(!open_at(&schedule, 2, 15 * H));
        assert!(open_at(&schedule, 2, 18 * H));
    }

    #[test]
    fn next_opening_finds_later_today_or_a_later_day() {
        let schedule = [period(2, 11 * H, 14 * H), period(2, 17 * H, 22 * H), period(4, 9 * H, 17 * H)];
        assert_eq!(next_opening(&schedule, 2, 15 * H), Some((0, 17 * H)), "the evening shift");
        assert_eq!(next_opening(&schedule, 2, 23 * H), Some((2, 9 * H)), "Thursday morning");
        assert_eq!(next_opening(&schedule, 4, 10 * H), Some((5, 11 * H)), "next Tuesday");
    }

    #[test]
    fn malformed_periods_are_named() {
        assert!(period(7, 0, 60).problem().is_some());
        assert!(period(1, 1440, 60).problem().is_some());
        assert!(period(1, 60, 60).problem().is_some());
        assert!(period(1, 18 * H, 2 * H).problem().is_none(), "overnight is fine");
    }
}
