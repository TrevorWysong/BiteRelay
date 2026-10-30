import { useCallback } from "react";
import { addFavorite, removeFavorite, listFavorites } from "../../holochain/zomes/profiles";
import { bytesToHex } from "../../holochain/decode";
import { myAgentPubKey } from "../../holochain/client";
import { useResource } from "./useResource";

// Shared by Browse.tsx (checking many restaurant cards against the set at
// once) and MerchantDetail.tsx (checking a single one) -- both used to
// fetch+toggle independently, one keeping a Set and one a lone boolean,
// but it's the same data and the same optimistic-toggle-with-revert logic
// either way. Returning the whole Set works for both: Browse checks
// membership per card, a single-restaurant screen just checks membership
// once for its own hash.
const EMPTY = new Set<string>();

export function useFavorites() {
  // Independent of location/catalog -- a personal saved-restaurant list,
  // not scoped to "what's nearby right now" or "which restaurant is open."
  const { data, mutate } = useResource(`favorites:${bytesToHex(myAgentPubKey())}`, () =>
    listFavorites()
      .then((hashes) => new Set(hashes.map(bytesToHex)))
      .catch(() => new Set<string>()),
  );
  const favoritesHex = data ?? EMPTY;

  const toggleFavorite = useCallback(
    async (hash: Uint8Array) => {
      const hex = bytesToHex(hash);
      const wasFavorited = favoritesHex.has(hex);
      // Optimistic -- a favorite toggle should feel instant, and reverting
      // on the rare failure is cheap (just flips the Set back).
      mutate((prev) => {
        const next = new Set(prev ?? EMPTY);
        if (wasFavorited) next.delete(hex);
        else next.add(hex);
        return next;
      });
      try {
        if (wasFavorited) await removeFavorite(hash);
        else await addFavorite(hash);
      } catch {
        mutate((prev) => {
          const next = new Set(prev ?? EMPTY);
          if (wasFavorited) next.add(hex);
          else next.delete(hex);
          return next;
        });
      }
    },
    [favoritesHex, mutate],
  );

  return { favoritesHex, toggleFavorite };
}
