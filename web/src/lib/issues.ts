// What reported items are worth -- the same rule the network enforces
// (`dispatch_types::claimed_value`), so the refund a customer sees while
// reporting is the refund they get. Each unit at its line's price, scaled by
// what the order actually cost against its undiscounted subtotal, rounded
// down, never more than units ordered or the order's total.
export interface PricedLine {
  itemHex: string;
  unitPrice: number;
  quantity: number;
}

export function claimedValue(lines: PricedLine[], orderTotal: number, claimed: { itemHex: string; quantity: number }[]): number {
  const subtotal = lines.reduce((sum, l) => sum + BigInt(l.unitPrice) * BigInt(l.quantity), 0n);
  if (subtotal === 0n) return 0;
  const claimedSubtotal = lines.reduce((sum, l) => {
    const units = claimed.filter((c) => c.itemHex === l.itemHex).reduce((n, c) => n + c.quantity, 0);
    return sum + BigInt(l.unitPrice) * BigInt(Math.min(units, l.quantity));
  }, 0n);
  const value = Number((claimedSubtotal * BigInt(orderTotal)) / subtotal);
  return Math.min(value, orderTotal);
}
