export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
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
