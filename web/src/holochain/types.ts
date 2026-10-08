// The app's wire types. Everything that mirrors a Rust type is generated
// (`generated.ts`, by tools/typegen -- run `npm run typegen` after changing
// a Rust type); only client-side shapes are written by hand here.
import type { ActionHash, AgentPubKey, CatalogLocalSignal, DispatchLocalSignal, Profile, Timestamp } from "./generated";

export * from "./generated";

/// Every signal that can arrive on the app websocket, from any zome's
/// `recv_remote_signal`.
export type LocalSignal = DispatchLocalSignal | CatalogLocalSignal;

/// A profile paired with its agent and action -- assembled client-side.
export interface ProfileWithAgent {
  agent: AgentPubKey;
  profile: Profile;
  actionHash: ActionHash;
}

/// A Holochain record as the client sees it -- what callZome returns for an
/// entry; `decodeEntry` pulls the struct out.
export interface HcRecord {
  signed_action: { hashed: { hash: ActionHash; content: { author: AgentPubKey; timestamp: Timestamp } } };
  entry: { Present?: { entry_type: string; entry: Uint8Array | [unknown, Uint8Array] } } | "NotApplicable" | "Hidden" | "NotStored";
}
