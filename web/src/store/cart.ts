import { create } from "zustand";
import type { ActionHash, OrderItem, SelectionInput } from "../holochain/types";
import { bytesToHex } from "../holochain/decode";
import { selectionsKey } from "../lib/choices";

export interface CartLine {
  itemRef: ActionHash;
  name: string;
  /// The item's own price -- what an item promo takes off.
  basePriceCents: number;
  /// One unit with its choices.
  priceCents: number;
  quantity: number;
  /// What was chosen, as the order sends it -- empty for an item without
  /// choices.
  selections: SelectionInput[];
  /// The choices as the customer reads them: "Large", "Oat milk".
  choiceLabels: string[];
}

/// A line's identity: its item and its choices. The same item with other
/// choices is another line.
export function lineKey(line: Pick<CartLine, "itemRef" | "selections">): string {
  return `${bytesToHex(line.itemRef)}|${selectionsKey(line.selections)}`;
}

/// The cart as an order's items -- one per line, with its quantity and
/// choices.
export function cartItems(lines: CartLine[]): OrderItem[] {
  return lines.map((line) => ({ item_ref: line.itemRef, quantity: line.quantity, selections: line.selections }));
}

interface CartState {
  catalogRef: ActionHash | null;
  merchant: Uint8Array | null;
  merchantName: string | null;
  lines: CartLine[];

  /// Adds `line` (its `quantity` units) -- to the line with the same item
  /// and choices if there is one.
  addLine: (catalogRef: ActionHash, merchant: Uint8Array, merchantName: string, line: CartLine) => void;
  /// Puts `line` in place of the line keyed `key` -- editing its choices.
  replaceLine: (key: string, line: CartLine) => void;
  removeLine: (key: string) => void;
  setQuantity: (key: string, quantity: number) => void;
  /// Replaces the cart wholesale -- used by "reorder" to repopulate from a
  /// past order in one shot.
  setCart: (catalogRef: ActionHash, merchant: Uint8Array, merchantName: string, lines: CartLine[]) => void;
  clear: () => void;
  total: () => number;
}

/// `lines` with `line` merged in: its units added to the line with the same
/// key, or appended.
function merged(lines: CartLine[], line: CartLine): CartLine[] {
  const key = lineKey(line);
  return lines.some((l) => lineKey(l) === key) ? lines.map((l) => (lineKey(l) === key ? { ...l, quantity: l.quantity + line.quantity } : l)) : [...lines, line];
}

export const useCart = create<CartState>((set, get) => ({
  catalogRef: null,
  merchant: null,
  merchantName: null,
  lines: [],

  addLine: (catalogRef, merchant, merchantName, line) => {
    const state = get();
    // Switching restaurants clears the cart -- same rule every real
    // delivery app enforces, since one order can only reference one
    // catalog_ref/merchant on the backend.
    const sameCatalog = state.catalogRef && bytesToHex(state.catalogRef) === bytesToHex(catalogRef);
    set({ catalogRef, merchant, merchantName, lines: merged(sameCatalog ? state.lines : [], line) });
  },

  replaceLine: (key, line) => set({ lines: merged(get().lines.filter((l) => lineKey(l) !== key), line) }),

  removeLine: (key) => set({ lines: get().lines.filter((l) => lineKey(l) !== key) }),

  setQuantity: (key, quantity) => {
    if (quantity <= 0) {
      get().removeLine(key);
      return;
    }
    set({ lines: get().lines.map((l) => (lineKey(l) === key ? { ...l, quantity } : l)) });
  },

  setCart: (catalogRef, merchant, merchantName, lines) => set({ catalogRef, merchant, merchantName, lines: lines.reduce(merged, [] as CartLine[]) }),

  clear: () => set({ catalogRef: null, merchant: null, merchantName: null, lines: [] }),

  total: () => get().lines.reduce((sum, l) => sum + l.priceCents * l.quantity, 0),
}));
