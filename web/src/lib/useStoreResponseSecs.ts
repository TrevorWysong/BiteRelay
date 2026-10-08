import { getStoreResponseSecs } from "../holochain/zomes/dispatch";
import { useResource } from "./useResource";

/// How long a store has to accept an order (the DNA's setting) -- read once;
/// it can't change without a new DNA.
export function useStoreResponseSecs(): number | undefined {
  return useResource("store-response-secs", getStoreResponseSecs).data;
}
