// The relay's one table, in SQLite (Node's built-in driver): each device it
// can wake -- how (its channel and address there) and the hash of the
// secret that lets the device change or forget its own row. Nothing about
// who the device belongs to, and nothing about any wake.
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type Channel = "webpush" | "apns" | "fcm";

export interface Device {
  id: string;
  channel: Channel;
  /// Where the channel reaches it: a Web Push subscription (JSON), an APNs
  /// device token, or an FCM registration token.
  address: string;
}

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      channel TEXT NOT NULL,
      address TEXT NOT NULL,
      registered_at INTEGER NOT NULL
    )`);
  }

  /// A new device, and the secret only it will hold.
  register(channel: Channel, address: string): { id: string; secret: string } {
    const id = randomBytes(16).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    this.db.prepare("INSERT INTO devices (id, secret_hash, channel, address, registered_at) VALUES (?, ?, ?, ?, ?)").run(id, hash(secret), channel, address, Date.now());
    return { id, secret };
  }

  /// The device, if `secret` is its own.
  authenticate(id: string, secret: string): Device | null {
    const row = this.db.prepare("SELECT id, channel, address, secret_hash FROM devices WHERE id = ?").get(id) as (Device & { secret_hash: string }) | undefined;
    if (!row || row.secret_hash !== hash(secret)) return null;
    return { id: row.id, channel: row.channel, address: row.address };
  }

  device(id: string): Device | null {
    const row = this.db.prepare("SELECT id, channel, address FROM devices WHERE id = ?").get(id) as Device | undefined;
    return row ?? null;
  }

  /// Gone: the device asked, or its channel said it no longer exists. Every
  /// token it handed out stops working.
  forget(id: string) {
    this.db.prepare("DELETE FROM devices WHERE id = ?").run(id);
  }
}
