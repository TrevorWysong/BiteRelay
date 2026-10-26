// The offers this device has sent as a driver -- by hand or by auto-bid --
// so an order's card shows the offer and can withdraw it, instead of
// offering to bid again. The device is the one that made them, so it's
// where they're known; kept across reloads, for as long as an order can
// still be taking offers.
import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface SentBid {
  /// The bid's action, hex.
  bid: string;
  feeCents: number;
  etaMinutes: number;
  /// When it was sent, in milliseconds.
  sentAt: number;
}

/// How long an offer is remembered: past this, its order has long been
/// matched or ended.
const KEEP_MS = 24 * 60 * 60 * 1000;

interface SentBidsState {
  /// By `${driver hex}:${order hex}`.
  sent: Record<string, SentBid>;
  record: (driverHex: string, orderHex: string, bid: SentBid) => void;
  forget: (driverHex: string, orderHex: string) => void;
  /// Forgets a bid that's no longer an open offer (its customer's app
  /// released it).
  forgetBid: (bidHex: string) => void;
}

export const useSentBids = create<SentBidsState>()(
  persist(
    (set) => ({
      sent: {},
      record: (driverHex, orderHex, bid) =>
        set((state) => {
          const fresh = Object.fromEntries(Object.entries(state.sent).filter(([, b]) => b.sentAt > Date.now() - KEEP_MS));
          return { sent: { ...fresh, [`${driverHex}:${orderHex}`]: bid } };
        }),
      forget: (driverHex, orderHex) =>
        set((state) => {
          const { [`${driverHex}:${orderHex}`]: _gone, ...rest } = state.sent;
          return { sent: rest };
        }),
      forgetBid: (bidHex) => set((state) => ({ sent: Object.fromEntries(Object.entries(state.sent).filter(([, b]) => b.bid !== bidHex)) })),
    }),
    { name: "relay.sent-bids.v1" },
  ),
);

