// The rules this network runs by -- its DNA's settings (currency, time
// windows, limits), read once while connecting: they can't change without a
// new DNA. Every screen that quotes or applies one reads it from here, so
// none is typed into the app, and a network that changes a setting changes
// what every screen says.
import { create } from "zustand";
import { getNetworkTerms } from "../holochain/zomes/dispatch";
import type { NetworkTerms } from "../holochain/types";

interface NetworkState {
  terms: NetworkTerms | null;
  /// Reads the terms from the conductor -- part of connecting (`session`).
  load: () => Promise<void>;
}

export const useNetwork = create<NetworkState>((set) => ({
  terms: null,
  load: async () => set({ terms: await getNetworkTerms() }),
}));

/// The network's terms, for a screen behind `RequireSession` -- connecting
/// loads them before anything there renders.
export function useTerms(): NetworkTerms {
  return requireTerms(useNetwork((s) => s.terms));
}

/// The same, outside React (formatting, image checks).
export function currentTerms(): NetworkTerms {
  return requireTerms(useNetwork.getState().terms);
}

function requireTerms(terms: NetworkTerms | null): NetworkTerms {
  if (!terms) throw new Error("the network's terms are read while connecting -- this ran before that");
  return terms;
}
