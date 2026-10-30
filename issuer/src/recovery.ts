// Reissuing recovered accounts. When someone loses their device and
// recovers their account on a new one (their recovery phrase, or their
// guardians -- see docs/RECOVERY.md), the network can't move their old key's
// balance: nothing peer-to-peer can prove a lost key is gone, or that a
// phrase was used once. The issuer -- which holds the money behind it --
// reissues it instead:
//
//   - once per account, to one new key: a second recovery of the same
//     account is contested, and left to a person to sort out;
//   - only after the old key has been quiet for the waiting period, since
//     the issuer first saw the request: any activity on it (the phone was
//     found, or someone else has it) starts the wait again;
//   - for what the old key's ledger holds at that point -- never more;
//   - only while the recovery stands: if the person (who still had their
//     device after all) replaced the plan it rested on, it's void.
//
// What the old key holds stays on its chain, frozen in practice: stores
// won't take its orders and this service won't cash it out.
import { agentId, agentKey, type IssuerLedger } from "./ledger.ts";
import type { Store } from "./store.ts";

const CURSOR = "reissue_cursor";
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/// One sweep: new requests recorded, and every waiting recovery that's
/// ready reissued. Returns how many were reissued.
/// `reviewAboveCents`: a balance larger than this is left for a person to
/// approve -- a large reissue is a large loss if the recovery wasn't theirs.
export async function reissueSweep(store: Store, ledger: IssuerLedger, waitMs: number, reviewAboveCents: number, log: (message: string) => void = () => {}): Promise<number> {
  // Recorded first, durably: the cursor moves only past what's recorded.
  let after = store.get(CURSOR) === null ? null : Number(store.get(CURSOR));
  for (;;) {
    const page = await ledger.reissueRequests(after);
    for (const request of page.requests) store.trackRecovery(hex(request.succession), agentId(request.predecessor), agentId(request.successor));
    if (page.cursor !== null) store.set(CURSOR, String(page.cursor));
    after = page.cursor;
    if (!page.more) break;
  }

  let reissued = 0;
  for (const recovery of store.waitingRecoveries()) {
    const predecessor = agentKey(recovery.predecessor);
    if (store.reissued(recovery.predecessor)) {
      store.settleRecovery(recovery.succession, "contested");
      log(`recovery of ${recovery.predecessor} by ${recovery.successor}: already reissued to another key -- left for review`);
      continue;
    }
    const successions = await ledger.successionsOf(predecessor);
    if (!successions.some((s) => hex(s.succession) === recovery.succession)) {
      // Its plan was replaced: whoever recovered with it no longer counts.
      store.settleRecovery(recovery.succession, "void");
      log(`recovery of ${recovery.predecessor} by ${recovery.successor}: its plan was replaced -- void`);
      continue;
    }
    if (new Set(successions.map((s) => agentId(s.successor))).size > 1) {
      store.settleRecovery(recovery.succession, "contested");
      log(`recovery of ${recovery.predecessor}: recovered onto more than one key -- left for review`);
      continue;
    }
    const latest = await ledger.latestActionOf(predecessor);
    if (!latest) continue;
    if (recovery.head !== hex(latest)) {
      // New activity (or the first look): the wait starts now.
      store.sawRecoveryHead(recovery.succession, hex(latest), Date.now());
      continue;
    }
    if (Date.now() - recovery.quietSince < waitMs) continue;
    const standing = await ledger.standingAt(predecessor, latest);
    const amount = Math.max(0, standing.balance);
    if (amount > reviewAboveCents) {
      store.settleRecovery(recovery.succession, "review", amount);
      log(`recovery of ${recovery.predecessor}: ${amount} is more than reissued without review -- left for a person`);
      continue;
    }
    if (amount > 0) {
      // Keyed by the account: asked again (a lost answer), it grants once.
      await ledger.issueGrant(agentKey(recovery.successor), amount, `recovery:${recovery.predecessor}`);
      reissued++;
      log(`reissued ${amount} from recovered ${recovery.predecessor} to ${recovery.successor}`);
    }
    store.settleRecovery(recovery.succession, amount > 0 ? "reissued" : "nothing", amount);
  }
  return reissued;
}
