import { useCallback, useEffect, useState } from "react";
import { addFavorite, removeFavorite, listFavorites } from "../holochain/zomes/profiles";
import { bytesToHex } from "../holochain/decode";

// Shared by Browse.tsx (checking many restaurant cards against the set at
// once) and MerchantDetail.tsx (checking a single one) -- both used to
// fetch+toggle independently, one keeping a Set and one a lone boolean,
// but it's the same data and the same optimistic-toggle-with-revert logic
// either way. Returning the whole Set works for both: Browse checks
// membership per card, a single-restaurant screen just checks membership
// once for its own hash.
export function useFavorites() {
  const [favoritesHex, setFavoritesHex] = useState<Set<string>>(new Set());

  // Independent of location/catalog -- a personal saved-restaurant list,
  // not scoped to "what's nearby right now" or "which restaurant is open."
  useEffect(() => {
    listFavorites()
      .then((hashes) => setFavoritesHex(new Set(hashes.map(bytesToHex))))
      .catch(() => {});
  }, []);

  const toggleFavorite = useCallback(
    async (hash: Uint8Array) => {
      const hex = bytesToHex(hash);
      const wasFavorited = favoritesHex.has(hex);
      // Optimistic -- a favorite toggle should feel instant, and reverting
      // on the rare failure is cheap (just flips the Set back).
      setFavoritesHex((prev) => {
        const next = new Set(prev);
        if (wasFavorited) next.delete(hex);
        else next.add(hex);
        return next;
      });
      try {
        if (wasFavorited) await removeFavorite(hash);
        else await addFavorite(hash);
      } catch {
        setFavoritesHex((prev) => {
          const next = new Set(prev);
          if (wasFavorited) next.add(hex);
          else next.delete(hex);
          return next;
        });
      }
    },
    [favoritesHex],
  );

  return { favoritesHex, toggleFavorite };
}
