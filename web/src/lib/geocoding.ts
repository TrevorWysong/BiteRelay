import type { GeoPoint } from "../holochain/types";

// Free address search/reverse-lookup via Nominatim, OpenStreetMap's own
// geocoding service -- the sibling API to the raster tiles `LiveMap.tsx`
// already pulls from the same org, no API key or vendor account either.
// Same "default to shared free infra now" tradeoff this project already
// makes for its bootstrap/relay servers (architecture plan §12): the
// public instance isn't guaranteed production capacity, but a single
// user's own debounced, one-at-a-time search box is light, individual
// usage, not the bulk/systematic querying its usage policy warns against.
const BASE_URL = "https://nominatim.openstreetmap.org";

interface NominatimAddress {
  house_number?: string;
  road?: string;
  city?: string;
  town?: string;
  village?: string;
  hamlet?: string;
  suburb?: string;
  county?: string;
  state?: string;
  postcode?: string;
  country?: string;
  country_code?: string;
}

interface NominatimRow {
  display_name: string;
  lat: string;
  lon: string;
  address?: NominatimAddress;
}

// Nominatim's raw `display_name` joins every OSM address component with a
// comma, including between the house number and street ("7321, Central
// Avenue, ...") -- technically correct per OSM's own data model, but reads
// oddly to anyone expecting a normal mailing address, and drags in clutter
// (county, a hyper-local hamlet/suburb name) nobody needs for ordering food.
// Composing a label from the structured `address` fields (available via
// `addressdetails=1`) instead gives something that actually reads like an
// address: "7321 Central Avenue, Saint Petersburg, Florida 33710".
//
// Split out as its own shape (not just a formatted label) so a selected
// result can prefill every one of `MerchantCatalog`'s own split address
// fields (street/city/state/zip) at once -- see `AddressSearch`'s
// `onSelectComponents` prop, which is what actually hands this to a caller.
export interface AddressComponents {
  street: string;
  city: string;
  state: string;
  zip: string;
}

function addressComponents(address: NominatimAddress | undefined): AddressComponents {
  if (!address) return { street: "", city: "", state: "", zip: "" };
  return {
    street: [address.house_number, address.road].filter(Boolean).join(" "),
    city: address.city ?? address.town ?? address.village ?? address.hamlet ?? address.suburb ?? address.county ?? "",
    state: address.state ?? "",
    zip: address.postcode ?? "",
  };
}

function formatAddress(components: AddressComponents, address: NominatimAddress | undefined, fallback: string): string {
  const stateZip = [components.state, components.zip].filter(Boolean).join(" ");
  const parts = [components.street, components.city, stateZip].filter(Boolean);
  if (address?.country_code && address.country_code.toLowerCase() !== "us" && address.country) {
    parts.push(address.country);
  }
  return parts.length > 0 ? parts.join(", ") : fallback;
}

export interface GeocodeResult {
  label: string;
  point: GeoPoint;
  components: AddressComponents;
}

export async function searchAddress(query: string, signal: AbortSignal): Promise<GeocodeResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const url = `${BASE_URL}/search?format=jsonv2&addressdetails=1&limit=5&q=${encodeURIComponent(trimmed)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Address search failed (${res.status})`);
  const rows: NominatimRow[] = await res.json();
  return rows.map((row) => {
    const components = addressComponents(row.address);
    return { label: formatAddress(components, row.address, row.display_name), point: { lat: Number(row.lat), lon: Number(row.lon) }, components };
  });
}

// Returns the structured components alongside the formatted label (not
// just the label) -- a caller showing "32 Anawan St" as a compact
// display with "Taunton, MA 02780" as subtext (the DoorDash-style address
// pill/switcher) needs the pieces separately, not just the one flattened
// string.
export async function reverseGeocode(point: GeoPoint, signal: AbortSignal): Promise<{ label: string; components: AddressComponents } | null> {
  const url = `${BASE_URL}/reverse?format=jsonv2&addressdetails=1&lat=${point.lat}&lon=${point.lon}`;
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  const row: Partial<NominatimRow> = await res.json();
  if (!row.display_name) return null;
  const components = addressComponents(row.address);
  return { label: formatAddress(components, row.address, row.display_name), components };
}
