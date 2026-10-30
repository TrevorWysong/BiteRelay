//! Reading a list of links that grows for good -- a busy store's reviews,
//! an arbiter's docket -- a page at a time, newest first.

use hdk::prelude::*;

/// The first window a page reads back over; each further one is four times
/// as long, so even years of history take a handful of reads.
const FIRST_WINDOW_MICROS: i64 = 24 * 60 * 60 * 1_000_000;

/// Up to `size` of `query`'s links, newest first, from `query.before` back
/// -- and where the next page starts, if one does.
///
/// Read in widening windows of time (`LinkQuery::after` with `before`),
/// which the links' authorities filter where they're held: a page costs
/// about the links it shows, not every link older than its cursor. The
/// first window usually fills the page; when it doesn't, `count_links`
/// tells whether older ones remain.
pub fn newest_first_page(query: LinkQuery, size: usize) -> ExternResult<(Vec<Link>, Option<Timestamp>)> {
    let mut links: Vec<Link> = Vec::new();
    // The first window is open above: a link dated a little ahead by its
    // author's clock still shows on the first page.
    let mut upper = query.before;
    let mut from = upper.map_or(sys_time()?.as_micros(), |before| before.as_micros());
    let mut span = FIRST_WINDOW_MICROS;
    let mut total: Option<usize> = None;
    loop {
        from = from.saturating_sub(span).max(0);
        let mut window = query.clone();
        window.before = upper;
        window.after = Some(Timestamp::from_micros(from));
        links.extend(get_links(window, GetStrategy::default())?);
        if links.len() > size || from == 0 {
            break;
        }
        // Short of a page: how many there are in all, asked once.
        let all = match total {
            Some(all) => all,
            None => *total.insert(count_links(query.clone())?),
        };
        if links.len() >= all {
            break;
        }
        upper = Some(Timestamp::from_micros(from - 1));
        span = span.saturating_mul(4);
    }
    links.sort_by_key(|link| std::cmp::Reverse(link.timestamp));
    // `before` is inclusive: the next page starts a microsecond past this
    // one's last link.
    let next_before = (links.len() > size).then(|| Timestamp::from_micros(links[size - 1].timestamp.as_micros() - 1));
    links.truncate(size);
    Ok((links, next_before))
}
