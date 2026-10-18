// The next version of the network (MIGRATION.md): when an issuer announces
// one, apps offer to move people's accounts there.
import type { AgentPubKey } from "../holochain/types";
import { listIssuers } from "../holochain/zomes/ledger";

/// The next version of the network, as an issuer announces it, and the
/// issuer that carries balances there -- `null` until there is one.
export async function nextNetwork(): Promise<{ network: Uint8Array; issuer: AgentPubKey } | null> {
  const announced = (await listIssuers()).find((i) => i.profile?.next_network);
  return announced ? { network: announced.profile!.next_network!, issuer: announced.issuer } : null;
}
