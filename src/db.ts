import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type OrderStatus = "pending" | "paid";
export type NotifyStatus = "none" | "pending" | "done" | "failed";

export interface Order {
  id: string; // gateway trade no (sent to upstream)
  merchant_pid: string;
  out_trade_no: string; // downstream (new-api) trade no
  type: string;
  name: string;
  money: string; // downstream amount, as received
  notify_url: string;
  return_url: string;
  channel_id: string;
  upstream_money: string;
  upstream_ref: string | null; // e.g. NOWPayments invoice id / upstream trade_no
  pay_url: string | null; // cached redirect URL (NOWPayments invoice_url)
  status: OrderStatus;
  notify_status: NotifyStatus;
  notify_attempts: number;
  next_notify_at: number | null;
  last_error: string | null;
  created_at: number;
  paid_at: number | null;
}

export type NewOrder = Pick<
  Order,
  "id" | "merchant_pid" | "out_trade_no" | "type" | "name" | "money" | "notify_url" | "return_url" | "channel_id" | "upstream_money"
>;

export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run(`CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      merchant_pid TEXT NOT NULL,
      out_trade_no TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      money TEXT NOT NULL,
      notify_url TEXT NOT NULL,
      return_url TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      upstream_money TEXT NOT NULL,
      upstream_ref TEXT,
      pay_url TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      notify_status TEXT NOT NULL DEFAULT 'none',
      notify_attempts INTEGER NOT NULL DEFAULT 0,
      next_notify_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      paid_at INTEGER,
      UNIQUE (merchant_pid, out_trade_no)
    )`);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_orders_notify ON orders (notify_status, next_notify_at)");
  }

  insert(o: NewOrder, now = Date.now()): Order {
    this.db
      .query(
        `INSERT INTO orders (id, merchant_pid, out_trade_no, type, name, money, notify_url, return_url, channel_id, upstream_money, created_at)
         VALUES ($id, $merchant_pid, $out_trade_no, $type, $name, $money, $notify_url, $return_url, $channel_id, $upstream_money, $now)`,
      )
      .run({ ...o, now });
    return this.get(o.id)!;
  }

  get(id: string): Order | null {
    return this.db.query<Order, [string]>("SELECT * FROM orders WHERE id = ?").get(id);
  }

  findByOutTradeNo(pid: string, outTradeNo: string): Order | null {
    return this.db
      .query<Order, [string, string]>("SELECT * FROM orders WHERE merchant_pid = ? AND out_trade_no = ?")
      .get(pid, outTradeNo);
  }

  setUpstream(id: string, ref: string | null, payUrl: string | null): void {
    this.db.query("UPDATE orders SET upstream_ref = ?, pay_url = ? WHERE id = ?").run(ref, payUrl, id);
  }

  /**
   * Atomically transition pending -> paid and schedule the downstream notification.
   * Returns true only for the call that performed the transition.
   */
  markPaid(id: string, upstreamRef: string | null, now = Date.now()): boolean {
    const res = this.db
      .query(
        `UPDATE orders SET status = 'paid', paid_at = ?, upstream_ref = COALESCE(?, upstream_ref),
           notify_status = 'pending', next_notify_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(now, upstreamRef, now, id);
    return res.changes === 1;
  }

  dueNotifications(now = Date.now(), limit = 20): Order[] {
    return this.db
      .query<Order, [number, number]>(
        "SELECT * FROM orders WHERE notify_status = 'pending' AND next_notify_at <= ? ORDER BY next_notify_at LIMIT ?",
      )
      .all(now, limit);
  }

  notifyDone(id: string): void {
    this.db
      .query("UPDATE orders SET notify_status = 'done', notify_attempts = notify_attempts + 1, next_notify_at = NULL, last_error = NULL WHERE id = ?")
      .run(id);
  }

  /** Record a failed attempt; `nextAt` null means give up. */
  notifyFailed(id: string, error: string, nextAt: number | null): void {
    this.db
      .query(
        `UPDATE orders SET notify_attempts = notify_attempts + 1, last_error = ?, next_notify_at = ?,
           notify_status = CASE WHEN ? IS NULL THEN 'failed' ELSE 'pending' END
         WHERE id = ?`,
      )
      .run(error.slice(0, 500), nextAt, nextAt, id);
  }

  close(): void {
    this.db.close();
  }
}
