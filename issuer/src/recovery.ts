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
//
// Then, for `WATCH_DAYS`, what the old key was *owed* and never collected
// -- a store's payment for food in flight, a driver's pay, a refund --
// reissued a part at a time as each comes due (`reissueOwed`). Each part is
// money a lost key can't collect, so reissuing it is safe only while the
// key stays lost: the moment it acts again (found, or someone else has it),
// the watch stops and the recovery is left for a person. That check runs
// before each grant, against the head the balance was reissued at, and the
// zome reads what's owed as of that same head -- so a part the old key
// collected is never also reissued.
//
// The same watch grants what the old key would have given *back* and never
// did -- a refund on an order its store called off, a driver's pay on one
// cancelled -- to the payer it was owed to, in the part's place
// (`HeldPart`). The network itself keeps the payer from being paid twice:
// they collect such a grant instead of the part, on their own chain, and
// whichever comes first rules the other out. The part's reference is shared
// with what's reissued to the new key, so each part goes one way, once.
import { agentId, agentKey, type HeldPart, type IssuerLedger } from "./ledger.ts";
import type { Store } from "./store.ts";

const CURSOR = "reissue_cursor";
/// How long after its balance a recovery is watched for what the old key
/// was owed: longer than any order takes to settle.
export const WATCH_DAYS = 30;
/// How far back the old key's orders are read for it.
const OWED_DAYS = 60;
const DAY_MS = 86_400_000;
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
  return reissued + (await reissueOwed(store, ledger, reviewAboveCents, log));
}

/// What recovered accounts' old keys were owed and never collected,
/// reissued to their new keys a part at a time -- and what they'd have
/// given back, granted to its payers in its place. Returns how many parts
/// it granted.
async function reissueOwed(store: Store, ledger: IssuerLedger, reviewAboveCents: number, log: (message: string) => void): Promise<number> {
  let granted = 0;
  for (const recovery of store.watchedRecoveries(Date.now() - WATCH_DAYS * DAY_MS)) {
    if (!recovery.head) continue;
    const predecessor = agentKey(recovery.predecessor);
    // Still the one recovery, onto the one key the balance went to.
    const successions = await ledger.successionsOf(predecessor);
    if (!successions.some((s) => hex(s.succession) === recovery.succession)) {
      store.stopWatching(recovery.succession, "void");
      log(`recovery of ${recovery.predecessor}: its plan was replaced after its balance was settled -- no more is reissued`);
      continue;
    }
    if (new Set(successions.map((s) => agentId(s.successor))).size > 1) {
      store.stopWatching(recovery.succession, "contested");
      log(`recovery of ${recovery.predecessor}: recovered onto another key since -- left for review`);
      continue;
    }
    // Each part: what the old key was owed, to the new key; or what it
    // would have given back, to its payer in the part's place.
    let parts: { reference: string; portion: string; amount: number; to: string; inPlaceOf?: HeldPart }[];
    try {
      const head = Buffer.from(recovery.head, "hex");
      const [owed, unreturned] = await Promise.all([ledger.uncollectedBy(predecessor, head, OWED_DAYS), ledger.unreturnedBy(predecessor, head, OWED_DAYS)]);
      const reference = (hold: Uint8Array, portion: string) => `recovery:${recovery.predecessor}:${hex(hold)}:${portion}`;
      parts = [
        ...owed.map((p) => ({ reference: reference(p.hold, p.portion), portion: p.portion, amount: p.amount, to: recovery.successor })),
        ...unreturned.map((p) => ({ reference: reference(p.hold, p.portion), portion: p.portion, amount: p.amount, to: agentId(p.payer), inPlaceOf: { hold: p.hold, portion: p.portion, succession: new Uint8Array(Buffer.from(recovery.succession, "hex")) } })),
      ];
    } catch (err) {
      // Its history couldn't be read in full (not here yet, or too long to
      // check): nothing's reissued on a partial read. Tried again next sweep.
      log(`recovery of ${recovery.predecessor}: what it was owed couldn't be read (${err instanceof Error ? err.message : err})`);
      continue;
    }
    for (const part of parts) {
      // A part read both ways is one whose order says two things: neither.
      if (parts.filter((p) => p.reference === part.reference).length > 1) continue;
      const seen = store.recoveryPart(part.reference);
      if (seen?.status === "review") continue;
      // Granted already, to someone else: never again, to anyone else.
      if (seen && (seen.to ?? recovery.successor) !== part.to) continue;
      // Right before any grant: the old key still hasn't acted since the
      // head everything here was read at. If it has, it may have collected
      // (or given back) this very part.
      const latest = await ledger.latestActionOf(predecessor);
      if (!latest || hex(latest) !== recovery.head) {
        store.stopWatching(recovery.succession, "contested");
        log(`recovery of ${recovery.predecessor}: the old key acted after its balance was reissued -- left for review`);
        break;
      }
      if (seen === null) {
        // Once a part is left for a person, so is the rest: they look at
        // the account as a whole before any more of it moves.
        if (store.recoveryUnderReview(recovery.succession)) continue;
        // Everything granted for the account counts toward review, so it
        // can't be slipped through in small parts.
        const total = (recovery.amount ?? 0) + store.recoveryPartsGranted(recovery.succession) + part.amount;
        if (total > reviewAboveCents) {
          store.recordRecoveryPart(part.reference, recovery.succession, part.amount, "review", part.to);
          log(`recovery of ${recovery.predecessor}: ${part.amount} on an order would bring it to ${total} -- left for a person`);
          continue;
        }
        store.recordRecoveryPart(part.reference, recovery.succession, part.amount, "granted", part.to);
      }
      // Granted (or recorded, then interrupted): granting again is a no-op
      // by its reference, so a grant that didn't go through is retried.
      await ledger.issueGrant(agentKey(part.to), part.amount, part.reference, part.inPlaceOf);
      if (seen === null) {
        granted++;
        log(part.inPlaceOf ? `granted ${part.amount} that recovered ${recovery.predecessor} would have given back (${part.portion}) to ${part.to}` : `reissued ${part.amount} owed to recovered ${recovery.predecessor} (${part.portion}) to ${recovery.successor}`);
      }
    }
  }
  return granted;
}
