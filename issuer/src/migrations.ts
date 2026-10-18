// Carrying balances to the next version of the network (MIGRATION.md).
// Validation on one network can't read another, so the money crosses
// through the issuer, which runs on both: an account moving on records the
// move and closes its chain on the previous network -- Holochain, and the
// ledger's own rules, accept nothing more from it there -- and the issuer
// credits what its ledger held at the close to its key here. Once per
// account: the grant is keyed `migration:<account>`, and this service
// records each.
import { agentId, type IssuerLedger } from "./ledger.ts";
import type { Store } from "./store.ts";

const CURSOR = "migration_cursor";

/// One sweep of `previous`'s migration requests to `current`'s network.
/// Returns how many accounts it credited.
export async function migrationSweep(store: Store, previous: IssuerLedger, current: IssuerLedger, log: (message: string) => void = () => {}): Promise<number> {
  const here = Buffer.from(await current.network());
  let after = store.get(CURSOR) === null ? null : Number(store.get(CURSOR));
  let credited = 0;
  for (;;) {
    const page = await previous.migrationRequests(after);
    let settled = true;
    for (const request of page.requests) {
      const account = agentId(request.account);
      // Moves to some other network aren't this issuer's to carry here.
      if (!Buffer.from(request.network).equals(here) || store.migrated(account)) continue;
      // Not closed yet (or not seen to be): look again next sweep, from here.
      if (!request.close) {
        settled = false;
        continue;
      }
      const standing = await previous.standingAt(request.account, request.close);
      const amount = standing.handed_over ? 0 : Math.max(0, standing.balance);
      if (amount > 0) await current.issueGrant(request.successor, amount, `migration:${account}`);
      store.recordMigration(account, agentId(request.successor), amount);
      credited++;
      log(`carried ${amount} from ${account} to ${agentId(request.successor)} on the new network`);
    }
    // Only past what's all settled: an unclosed one is looked at again.
    if (settled && page.cursor !== null) store.set(CURSOR, String(page.cursor));
    if (!settled || !page.more) return credited;
    after = page.cursor;
  }
}
