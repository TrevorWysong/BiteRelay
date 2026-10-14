// Linking a payout account to an agent: they sign the service's one-time
// nonce with their agent key (the ledger zome's `sign_issuer_link`, which
// signs only this message), and the service checks the signature -- so
// nobody can point someone else's payouts at their own bank.
// Node only: the integration tests import this too, to check the zome's
// signatures against it.
import { createPublicKey, randomBytes, verify } from "node:crypto";

/// A 39-byte Holochain agent key.
type AgentPubKey = Uint8Array;

const LABEL = Buffer.from("relay-issuer-link:v1:");
/// DER prefix of an Ed25519 public key (SubjectPublicKeyInfo), before its 32 bytes.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function newNonce(): string {
  return randomBytes(24).toString("base64url");
}

/// What the agent signs -- `ledger_types::issuer_link_message`.
export function linkMessage(issuer: AgentPubKey, nonce: string): Buffer {
  return Buffer.concat([LABEL, Buffer.from(issuer), Buffer.from(":"), Buffer.from(nonce)]);
}

/// Whether `signature` is `agent`'s over the link message for `issuer` and
/// `nonce`. An agent key is 39 bytes: a 3-byte prefix, the 32-byte Ed25519
/// key, and 4 bytes of location.
export function verifyLink(agent: AgentPubKey, issuer: AgentPubKey, nonce: string, signature: Uint8Array): boolean {
  if (agent.length !== 39 || signature.length !== 64) return false;
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(agent.subarray(3, 35))]), format: "der", type: "spki" });
  return verify(null, linkMessage(issuer, nonce), key, Buffer.from(signature));
}
