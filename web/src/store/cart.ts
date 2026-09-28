import { create } from "zustand";
import type { ActionHash } from "../holochain/types";
import { bytesToHex } from "../holochain/decode";

export interface CartLine {
  itemRef: ActionHash;
  name: string;
  priceCents: number;
  quantity: number;
}

interface CartState {
  catalogRef: ActionHash | null;
  merchant: Uint8Array | null;
  merchantName: string | null;
  lines: CartLine[];

  addItem: (catalogRef: ActionHash, merchant: Uint8Array, merchantName: string, itemRef: ActionHash, name: string, priceCents: number) => void;
  removeLine: (itemRefHex: string) => void;
  setQuantity: (itemRefHex: string, quantity: number) => void;
  clear: () => void;
  total: () => number;
}

export const useCart = create<CartState>((set, get) => ({
  catalogRef: null,
  merchant: null,
  merchantName: null,
  lines: [],

  addItem: (catalogRef, merchant, merchantName, itemRef, name, priceCents) => {
    const state = get();
    // Switching restaurants clears the cart -- same rule every real
    // delivery app enforces, since one order can only reference one
    // catalog_ref/merchant on the backend.
    const sameCatalog = state.catalogRef && bytesToHex(state.catalogRef) === bytesToHex(catalogRef);
    const lines = sameCatalog ? [...state.lines] : [];
    const key = bytesToHex(itemRef);
    const existing = lines.find((l) => bytesToHex(l.itemRef) === key);
    if (existing) {
      existing.quantity += 1;
    } else {
      lines.push({ itemRef, name, priceCents, quantity: 1 });
    }
    set({ catalogRef, merchant, merchantName, lines });
  },

  removeLine: (itemRefHex) => set({ lines: get().lines.filter((l) => bytesToHex(l.itemRef) !== itemRefHex) }),

  setQuantity: (itemRefHex, quantity) => {
    if (quantity <= 0) {
      get().removeLine(itemRefHex);
      return;
    }
    set({ lines: get().lines.map((l) => (bytesToHex(l.itemRef) === itemRefHex ? { ...l, quantity } : l)) });
  },

  clear: () => set({ catalogRef: null, merchant: null, merchantName: null, lines: [] }),

  total: () => get().lines.reduce((sum, l) => sum + l.priceCents * l.quantity, 0),
}));
