// The service's own records, in SQLite (Node's built-in driver): payments
// already turned into grants, each person's payout account, link nonces,
// and how far its sweep of cash-outs has got. The ledger is the record of
// money; this is only what the service needs to act exactly once.
import { DatabaseSync } from "node:sqlite";

export interface PayoutAccount {
  agent: string;
  account: string;
}

/// A recovered account this issuer was asked to reissue, and where it's up to.
export interface Recovery {
  succession: string;
  predecessor: string;
  successor: string;
  /// The old key's latest action last seen, as hex.
  head: string | null;
  /// Since when the old key has been seen doing nothing.
  quietSince: number;
  /// `void`: the person replaced the plan it rested on.
  status: "waiting" | "reissued" | "contested" | "nothing" | "void";
  amount: number | null;
}

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS granted_payments (payment TEXT PRIMARY KEY, agent TEXT NOT NULL, amount INTEGER NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS payout_accounts (agent TEXT PRIMARY KEY, account TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS customers (agent TEXT PRIMARY KEY, customer TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS saved_card_charges (agent TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS link_nonces (nonce TEXT PRIMARY KEY, agent TEXT NOT NULL, issued_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recoveries (succession TEXT PRIMARY KEY, predecessor TEXT NOT NULL, successor TEXT NOT NULL, head TEXT, quiet_since INTEGER NOT NULL, status TEXT NOT NULL, amount INTEGER);
    `);
  }

  /// Records a payment as granted -- `false` if it already was, so a
  /// webhook delivered twice grants once.
  claimPayment(payment: string, agent: string, amount: number): boolean {
    const result = this.db.prepare("INSERT OR IGNORE INTO granted_payments (payment, agent, amount, at) VALUES (?, ?, ?, ?)").run(payment, agent, amount, Date.now());
    return result.changes === 1;
  }

  /// Forgets a claim whose grant didn't go through, so a retry can grant it.
  releasePayment(payment: string): void {
    this.db.prepare("DELETE FROM granted_payments WHERE payment = ?").run(payment);
  }

  payoutAccount(agent: string): string | null {
    const row = this.db.prepare("SELECT account FROM payout_accounts WHERE agent = ?").get(agent) as { account: string } | undefined;
    return row?.account ?? null;
  }

  setPayoutAccount(agent: string, account: string): void {
    this.db.prepare("INSERT INTO payout_accounts (agent, account) VALUES (?, ?) ON CONFLICT(agent) DO UPDATE SET account = excluded.account").run(agent, account);
  }

  /// The agent's customer record at the processor, where their saved cards live.
  customer(agent: string): string | null {
    const row = this.db.prepare("SELECT customer FROM customers WHERE agent = ?").get(agent) as { customer: string } | undefined;
    return row?.customer ?? null;
  }

  setCustomer(agent: string, customer: string): void {
    this.db.prepare("INSERT INTO customers (agent, customer) VALUES (?, ?) ON CONFLICT(agent) DO UPDATE SET customer = excluded.customer").run(agent, customer);
  }

  /// Records a saved-card charge for `agent` -- `false`, recording nothing,
  /// if they've had `limit` within `windowMs` already.
  takeSavedCardCharge(agent: string, limit: number, windowMs: number): boolean {
    const since = Date.now() - windowMs;
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM saved_card_charges WHERE agent = ? AND at >= ?").get(agent, since) as { n: number };
    if (row.n >= limit) return false;
    this.db.prepare("INSERT INTO saved_card_charges (agent, at) VALUES (?, ?)").run(agent, Date.now());
    return true;
  }

  issueNonce(nonce: string, agent: string): void {
    this.db.prepare("INSERT INTO link_nonces (nonce, agent, issued_at) VALUES (?, ?, ?)").run(nonce, agent, Date.now());
  }

  /// Takes a nonce issued to `agent` within `maxAgeMs` -- once.
  takeNonce(nonce: string, agent: string, maxAgeMs: number): boolean {
    const row = this.db.prepare("SELECT agent, issued_at FROM link_nonces WHERE nonce = ?").get(nonce) as { agent: string; issued_at: number } | undefined;
    this.db.prepare("DELETE FROM link_nonces WHERE nonce = ? OR issued_at < ?").run(nonce, Date.now() - maxAgeMs);
    return !!row && row.agent === agent && Date.now() - row.issued_at <= maxAgeMs;
  }

  /// Starts watching a recovery this issuer was asked to reissue -- once.
  trackRecovery(succession: string, predecessor: string, successor: string): void {
    this.db.prepare("INSERT OR IGNORE INTO recoveries (succession, predecessor, successor, quiet_since, status) VALUES (?, ?, ?, ?, 'waiting')").run(succession, predecessor, successor, Date.now());
  }

  /// The recoveries still waiting to be reissued.
  waitingRecoveries(): Recovery[] {
    return this.db.prepare("SELECT succession, predecessor, successor, head, quiet_since AS quietSince, status, amount FROM recoveries WHERE status = 'waiting'").all() as unknown as Recovery[];
  }

  /// Whether an account's balance has already been reissued to anyone.
  reissued(predecessor: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM recoveries WHERE predecessor = ? AND status = 'reissued'").get(predecessor);
  }

  /// The old key was seen at `head`, quiet since `quietSince`.
  sawRecoveryHead(succession: string, head: string, quietSince: number): void {
    this.db.prepare("UPDATE recoveries SET head = ?, quiet_since = ? WHERE succession = ?").run(head, quietSince, succession);
  }

  settleRecovery(succession: string, status: Exclude<Recovery["status"], "waiting">, amount: number | null = null): void {
    this.db.prepare("UPDATE recoveries SET status = ?, amount = ? WHERE succession = ?").run(status, amount, succession);
  }

  get(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}
