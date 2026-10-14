// The service's own records, in SQLite (Node's built-in driver): payments
// already turned into grants, each person's payout account, link nonces,
// and how far its sweep of cash-outs has got. The ledger is the record of
// money; this is only what the service needs to act exactly once.
import { DatabaseSync } from "node:sqlite";

export interface PayoutAccount {
  agent: string;
  account: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS granted_payments (payment TEXT PRIMARY KEY, agent TEXT NOT NULL, amount INTEGER NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS payout_accounts (agent TEXT PRIMARY KEY, account TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS link_nonces (nonce TEXT PRIMARY KEY, agent TEXT NOT NULL, issued_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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

  issueNonce(nonce: string, agent: string): void {
    this.db.prepare("INSERT INTO link_nonces (nonce, agent, issued_at) VALUES (?, ?, ?)").run(nonce, agent, Date.now());
  }

  /// Takes a nonce issued to `agent` within `maxAgeMs` -- once.
  takeNonce(nonce: string, agent: string, maxAgeMs: number): boolean {
    const row = this.db.prepare("SELECT agent, issued_at FROM link_nonces WHERE nonce = ?").get(nonce) as { agent: string; issued_at: number } | undefined;
    this.db.prepare("DELETE FROM link_nonces WHERE nonce = ? OR issued_at < ?").run(nonce, Date.now() - maxAgeMs);
    return !!row && row.agent === agent && Date.now() - row.issued_at <= maxAgeMs;
  }

  get(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}
