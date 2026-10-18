import { useNetwork } from "../store/network";

const formatters = new Map<string, Intl.NumberFormat>();

/// The network's currency formatter -- `null` before connecting. The
/// currency is the network's own setting; everything about how it's written
/// (its symbol, how many minor units make one) is the currency's.
function currencyFormat(): Intl.NumberFormat | null {
  const currency = useNetwork.getState().terms?.currency;
  if (!currency) return null;
  let formatter = formatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat(undefined, { style: "currency", currency });
    formatters.set(currency, formatter);
  }
  return formatter;
}

/// How many minor units (cents, for USD) make one of the currency's units.
function minorUnitsPerUnit(): number {
  return 10 ** (currencyFormat()?.resolvedOptions().maximumFractionDigits ?? 2);
}

/// An amount given in minor units -- as every amount in Relay is -- written
/// in the network's currency: "$12.50".
export function formatCents(minorUnits: number): string {
  const formatter = currencyFormat();
  return formatter ? formatter.format(minorUnits / minorUnitsPerUnit()) : (minorUnits / minorUnitsPerUnit()).toFixed(2);
}

/// A typed amount ("12.5") in minor units (1250) -- what a money field
/// sends.
export function toMinorUnits(amount: number): number {
  return Math.round(amount * minorUnitsPerUnit());
}

/// Minor units as a typed amount -- what a money field shows.
export function fromMinorUnits(minorUnits: number): number {
  return minorUnits / minorUnitsPerUnit();
}

/// The currency's symbol, for a money field's prefix: "$".
export function currencySymbol(): string {
  return currencyFormat()?.formatToParts(0).find((part) => part.type === "currency")?.value ?? "";
}

/// Composes `MerchantCatalog`'s own split address fields (street/city/
/// state/zip -- see that type's own doc comment for why they're split
/// rather than one flat string) into a single display line, shared by
/// merchant/Catalog.tsx's own view and customer/MerchantDetail.tsx so both
/// read an address the same way. Returns "" (not any placeholder text) if
/// every field is blank, so callers can just do `address && <span>...`.
export function formatCatalogAddress(catalog: { address_street: string; address_city: string; address_state: string; address_zip: string }): string {
  const stateZip = [catalog.address_state, catalog.address_zip].filter(Boolean).join(" ");
  return [catalog.address_street, catalog.address_city, stateZip].filter(Boolean).join(", ");
}

export function formatEta(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return `${minutes} min`;
}

export function timeAgo(microseconds: number): string {
  const ms = microseconds / 1000;
  const deltaS = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (deltaS < 60) return "just now";
  if (deltaS < 3600) return `${Math.round(deltaS / 60)}m ago`;
  if (deltaS < 86400) return `${Math.round(deltaS / 3600)}h ago`;
  return `${Math.round(deltaS / 86400)}d ago`;
}

export function shortAgentId(agent: Uint8Array): string {
  const hex = Array.from(agent.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join("");
  return `#${hex}`;
}

/// A Holochain timestamp (microseconds) as a time of day: "6:42 PM".
/// A deadline that may be a day off, with its weekday: "Fri 6:42 PM".
export function formatDeadline(microseconds: number): string {
  return new Date(microseconds / 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/// A day, in the viewer's locale: "12 Mar 2027".
export function formatDate(microseconds: number): string {
  return new Date(microseconds / 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function formatClockTime(microseconds: number): string {
  return new Date(microseconds / 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/// Places whose road distances are in miles.
const MILES_REGIONS = new Set(["US", "GB", "LR", "MM"]);

/// A distance as people where this device is read it: "1.2 km", or in
/// miles where roads are signed in miles. `locale` for tests.
export function formatDistance(km: number, locale: string = typeof navigator === "undefined" ? "en-US" : navigator.language): string {
  let region: string | undefined;
  try {
    region = new Intl.Locale(locale).maximize().region;
  } catch {
    region = undefined;
  }
  const miles = !!region && MILES_REGIONS.has(region);
  const value = miles ? km * 0.621371 : km;
  const unit = miles ? "mi" : "km";
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value)} ${unit}`;
}
