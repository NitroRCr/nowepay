import type { Config } from "./config.ts";
import type { Order, Store } from "./db.ts";
import { signParams } from "./epay/sign.ts";
import { log } from "./log.ts";

/** Build the signed epay callback for the downstream merchant (new-api). */
export function buildDownstreamNotify(order: Order, merchantKey: string): URL {
  const params = signParams(
    {
      pid: order.merchant_pid,
      trade_no: order.id,
      out_trade_no: order.out_trade_no,
      type: order.type, // original downstream type, new-api writes it back to the order
      name: order.name,
      money: order.money, // original downstream amount (USD), not the converted one
      trade_status: "TRADE_SUCCESS",
    },
    merchantKey,
  );
  const url = new URL(order.notify_url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}

/**
 * Delivers paid-order notifications to the downstream with persistent retries.
 * State lives in SQLite, so pending deliveries survive restarts.
 */
export class Notifier {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: Store,
    private readonly config: Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  start(intervalMs = 5_000): void {
    this.timer ??= setInterval(() => void this.runOnce(), intervalMs);
    void this.runOnce();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Trigger a delivery pass soon (e.g. right after an order is paid). */
  kick(): void {
    queueMicrotask(() => void this.runOnce());
  }

  async runOnce(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const order of this.store.dueNotifications(now)) await this.deliver(order);
    } catch (err) {
      log.error("notifier pass failed", { err });
    } finally {
      this.running = false;
    }
  }

  private async deliver(order: Order): Promise<void> {
    const merchant = this.config.merchants.find((m) => m.pid === order.merchant_pid);
    if (!merchant) {
      this.store.notifyFailed(order.id, "merchant no longer configured", null);
      log.error("downstream notify dropped: unknown merchant", { order: order.id, pid: order.merchant_pid });
      return;
    }
    let error: string;
    try {
      const res = await this.fetchImpl(buildDownstreamNotify(order, merchant.key), {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(this.config.notify.timeoutMs),
      });
      const body = (await res.text()).trim();
      if (res.ok && body.toLowerCase() === "success") {
        this.store.notifyDone(order.id);
        log.info("downstream notified", { order: order.id, out_trade_no: order.out_trade_no, attempts: order.notify_attempts + 1 });
        return;
      }
      error = `HTTP ${res.status}: ${body.slice(0, 200)}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const delays = this.config.notify.retryDelays;
    const delay = delays[order.notify_attempts];
    const nextAt = delay === undefined ? null : Date.now() + delay * 1000;
    this.store.notifyFailed(order.id, error, nextAt);
    (nextAt ? log.warn : log.error)(nextAt ? "downstream notify failed, will retry" : "downstream notify failed, giving up", {
      order: order.id,
      out_trade_no: order.out_trade_no,
      attempt: order.notify_attempts + 1,
      error,
    });
  }
}
