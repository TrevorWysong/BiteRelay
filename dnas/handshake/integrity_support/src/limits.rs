//! The protocol's size limits, in one place: what validation enforces, what
//! the coordinators check first, and -- exported to TypeScript by
//! `tools/typegen` -- what the app's forms allow. Changing one changes it
//! everywhere, and for every peer (it's part of the DNA).
//!
//! Text limits are in characters; byte limits bound what a field can make
//! every peer store. Network policy a network may tune (time windows, image
//! size, delivery radius) lives in `handshake_governance` instead.

/// A name or title: a store's, a menu item's, a goodie bag's.
pub const MAX_NAME_CHARS: usize = 100;
/// A short label: a cuisine, a menu category, a person's display name.
pub const MAX_LABEL_CHARS: usize = 60;
/// A long description: a store's, an item's, a bag's, a review.
pub const MAX_DESCRIPTION_CHARS: usize = 2_000;
/// A note: a profile's bio, a report of missing items, a chat message, a
/// kitchen or drop-off note.
pub const MAX_NOTE_CHARS: usize = 1_000;
pub const MAX_PHONE_CHARS: usize = 30;
pub const MAX_STREET_CHARS: usize = 200;
/// A city or a state.
pub const MAX_PLACE_CHARS: usize = 100;
pub const MAX_POSTAL_CODE_CHARS: usize = 20;
pub const MAX_VEHICLE_CHARS: usize = 100;
pub const MAX_LICENSE_PLATE_CHARS: usize = 20;
pub const MAX_PROMO_CODE_CHARS: usize = 40;
/// An issuer's reference for a grant (its payment's id).
pub const MAX_REFERENCE_CHARS: usize = 100;
/// An IANA time zone name.
pub const MAX_TIME_ZONE_CHARS: usize = 64;

/// Digits in a handoff code -- what a giver reads out, and a driver types.
pub const HANDOFF_CODE_DIGITS: u32 = 6;

/// The most any single amount may be -- a price, fee, tip, minimum or grant
/// -- in minor units of the network's currency. Far past any real order, and
/// small enough that no total of an order's amounts can overflow: 100 lines
/// of 1,000 units at this price is 10^17, well inside a u64.
pub const MAX_AMOUNT: u64 = 1_000_000_000_000;
/// The most units of one item on one line, or in one promo's terms.
pub const MAX_LINE_QUANTITY: u32 = 1_000;
const _: () = assert!((MAX_ORDER_LINES as u64) * (MAX_LINE_QUANTITY as u64) * MAX_AMOUNT * 100 < u64::MAX);

/// Lines on one order -- an item with its choices.
pub const MAX_ORDER_LINES: usize = 100;

/// Choice groups on one menu item ("Size", "Milk", "Extras").
pub const MAX_ITEM_GROUPS: usize = 10;
/// Options in one choice group.
pub const MAX_GROUP_OPTIONS: usize = 30;
/// The most of one option a customer may choose ("extra shot" x 3).
pub const MAX_OPTION_QUANTITY: u32 = 10;
/// Options chosen on one order line, nested ones included -- what bounds
/// the choice groups validation reads to price it.
pub const MAX_LINE_CHOICES: usize = 50;
/// Options chosen on one order, across its lines -- with `MAX_LINE_CHOICES`
/// and each version read once, what bounds the reading validating an order
/// with choices takes.
pub const MAX_ORDER_CHOICES: usize = 300;
/// How deep choices nest: an item's own groups are level 1; an option may
/// open a group at the next level ("Side: Fries" then "Size: Large"), up to
/// this many.
pub const MAX_CHOICE_DEPTH: usize = 3;
/// Units a recurring order places each time.
pub const MAX_TEMPLATE_ITEMS: usize = 500;
/// Opening periods in a store's week: split shifts every day.
pub const MAX_OPENING_PERIODS: usize = 28;
/// Dietary tags a store's menu sums to.
pub const MAX_DIETARY_TAGS: usize = 32;

/// The most sealed in one box of a `SealedChunks`, in bytes. The keystore
/// carries each request and reply in a frame of at most 8 KiB, with bytes
/// written as a list of numbers -- up to two bytes each -- so a chunk, once
/// sealed, must fit in under half a frame with room for its framing.
pub const SEAL_CHUNK_BYTES: usize = 3_584;
/// What sealing adds to each box: its authentication tag.
pub const SEAL_TAG_BYTES: usize = 16;
const _: () = assert!(2 * (SEAL_CHUNK_BYTES + SEAL_TAG_BYTES) + 512 <= 8 * 1024);
/// A small sealed field -- a note, a name, an address, a phone number, a
/// handoff code -- is one box. No honest box is larger than the keystore's
/// 8 KiB frame.
pub const MAX_SEALED_BYTES: usize = 8_192;
/// The most bytes a note can take as UTF-8: four per character, at worst.
pub const MAX_NOTE_BYTES: usize = 4_000;
const _: () = assert!(MAX_NOTE_BYTES == 4 * MAX_NOTE_CHARS);
/// What a sealed field holding an image may add, beyond the image itself:
/// a note, and its encoding.
pub const SEALED_IMAGE_OVERHEAD_BYTES: usize = 4_096;

/// The most guardians a recovery plan may name.
pub const MAX_GUARDIANS: usize = 7;
/// The most a migration's parcel may hold, before sealing.
pub const MAX_PARCEL_BYTES: usize = 65_536;
