//! The protocol's size limits, in one place: what validation enforces, what
//! the coordinators check first, and -- exported to TypeScript by
//! `tools/typegen` -- what the app's forms allow. Changing one changes it
//! everywhere, and for every peer (it's part of the DNA).
//!
//! Text limits are in characters; byte limits bound what a field can make
//! every peer store. Network policy a network may tune (time windows, image
//! size, delivery radius) lives in `relay_governance` instead.

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

/// Lines on one order -- distinct items.
pub const MAX_ORDER_LINES: usize = 100;
/// Units a recurring order places each time.
pub const MAX_TEMPLATE_ITEMS: usize = 500;
/// Opening periods in a store's week: split shifts every day.
pub const MAX_OPENING_PERIODS: usize = 28;
/// Dietary tags a store's menu sums to.
pub const MAX_DIETARY_TAGS: usize = 32;

/// The most sealed in one box, in bytes: a larger value is sealed in chunks
/// of this (`SealedChunks`). The conductor refuses a sealing request over
/// 8,192 bytes *including its framing* (~230 bytes), so a chunk leaves
/// room for that.
pub const SEAL_CHUNK_BYTES: usize = 7_168;
/// What sealing adds to each box: its authentication tag.
pub const SEAL_TAG_BYTES: usize = 16;
/// A small sealed field -- a note, a name, an address, a phone number, a
/// handoff code -- is one box: at most a chunk, sealed
/// (`SEAL_CHUNK_BYTES + SEAL_TAG_BYTES`).
pub const MAX_SEALED_BYTES: usize = 7_184;
const _: () = assert!(MAX_SEALED_BYTES == SEAL_CHUNK_BYTES + SEAL_TAG_BYTES);
/// What a sealed field holding an image may add, beyond the image itself:
/// a note, and its encoding.
pub const SEALED_IMAGE_OVERHEAD_BYTES: usize = 4_096;
