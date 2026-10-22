import { randomBytes } from "node:crypto";
import { EpayChannel } from "./channels/epay.ts";
import { NowpaymentsChannel } from "./channels/nowpayments.ts";
import type { Channel } from "./channels/types.ts";
import type { ChannelConfig, Config } from "./config.ts";
import type { Store } from "./db.ts";
import { keyFingerprint, readParams, signString, verifyEpay, type Params } from "./epay/sign.ts";
import { errorPage } from "./html.ts";
import { log } from "./log.ts";
import { compare, isDecimal, mulRound, normalize } from "./money.ts";
import type { Notifier } from "./notifier.ts";

export interface AppDeps {
  config: Config;
  store: Store;
  notifier: Pick<Notifier, "kick">;
  fetchImpl?: typeof fetch;
}

export function createChannel(cfg: ChannelConfig, fetchImpl: typeof fetch = fetch): Channel {
  switch (cfg.kind) {
    case "nowpayments":
      return new NowpaymentsChannel(cfg, fetchImpl);
    case "epay":
      return new EpayChannel(cfg);
  }
}

function newOrderId(): string {
  // Short, alphanumeric: safe for upstream order-id length limits and epay signing.
  return `NE${Date.now().toString(36)}${randomBytes(6).toString("hex")}`.toUpperCase();
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

const text = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain" } });

export function createApp({ config, store, notifier, fetchImpl = fetch }: AppDeps) {
  const channels = new Map<string, Channel>(); // by channel id
  const byType = new Map<string, Channel>(); // by downstream type
  for (const cfg of config.channels) {
    const ch = createChannel(cfg, fetchImpl);
    channels.set(cfg.id, ch);
    for (const t of cfg.types) byType.set(t, ch);
  }
  const merchants = new Map(config.merchants.map((m) => [m.pid, m]));

  async function submit(req: Request): Promise<Response> {
    const p: Params = await readParams(req);
    const merchant = p.pid ? merchants.get(p.pid) : undefined;
    if (!merchant) return errorPage("商户不存在");
    if (!verifyEpay(p, merchant.key)) {
      log.warn("submit signature mismatch", {
        method: req.method,
        content_type: req.headers.get("content-type"),
        query: new URL(req.url).search,
        sign_string: signString(p),
        received_sign: p.sign ?? null,
        merchant_key: keyFingerprint(merchant.key),
      });
      return errorPage("签名校验失败");
    }

    const { type = "", out_trade_no = "", notify_url = "", return_url = "", name = "", money = "" } = p;
    if (!out_trade_no || !name) return errorPage("缺少必要参数");
    if (!isHttpUrl(notify_url) || !isHttpUrl(return_url)) return errorPage("回调地址无效");
    if (!isDecimal(money) || compare(money, "0") <= 0) return errorPage("金额无效");
    const channel = byType.get(type);
    if (!channel) return errorPage(`不支持的支付方式: ${type}`);

    // Idempotency per (pid, out_trade_no): reuse an identical pending order, reject conflicts.
    let order = store.findByOutTradeNo(merchant.pid, out_trade_no);
    if (order) {
      if (order.status !== "pending") return errorPage("订单已支付");
      if (order.type !== type || compare(order.money, money) !== 0 || order.notify_url !== notify_url) {
        return errorPage("订单号重复");
      }
    } else {
      const cfg = channel.config;
      try {
        order = store.insert({
          id: newOrderId(),
          merchant_pid: merchant.pid,
          out_trade_no,
          type,
          name,
          money,
          notify_url,
          return_url,
          channel_id: cfg.id,
          upstream_money: mulRound(money, cfg.rate, cfg.precision),
        });
      } catch (err) {
        log.warn("order insert failed", { out_trade_no, err });
        return errorPage("订单创建失败，请重试", 409);
      }
      if (compare(order.upstream_money, "0") <= 0) return errorPage("换算后金额过低");
    }

    log.info("order submitted", {
      order: order.id,
      out_trade_no,
      type,
      channel: order.channel_id,
      money,
      upstream_money: order.upstream_money,
    });
    const result = await channel.createPayment(order, { publicUrl: config.server.publicUrl, extra: { device: p.device ?? "" } });
    if (result.upstreamRef !== undefined || result.payUrl !== undefined) {
      store.setUpstream(order.id, result.upstreamRef ?? null, result.payUrl ?? null);
    }
    return result.response;
  }

  async function notify(req: Request, kind: string, channelId: string): Promise<Response> {
    const channel = channels.get(channelId);
    if (!channel || channel.config.kind !== kind) return text("not found", 404);

    const result = await channel.parseNotify(req);
    if (result.kind === "invalid") {
      log.warn("upstream notify rejected", { channel: channelId, reason: result.reason });
      return text("fail", 400);
    }
    const order = result.orderId ? store.get(result.orderId) : null;
    if (result.orderId && (!order || order.channel_id !== channelId)) {
      log.warn("upstream notify for unknown order", { channel: channelId, order: result.orderId });
      return text("fail", 404);
    }
    if (result.kind === "ignored") {
      log.info("upstream notify ignored", { channel: channelId, order: result.orderId, reason: result.reason });
      return channel.ackResponse();
    }
    if (!order) return text("fail", 404);

    // new-api does not check the amount on its callback, so it must be enforced here.
    const expected = order.upstream_money;
    const paid = isDecimal(result.paidMoney) ? normalize(result.paidMoney, channel.config.precision) : null;
    if (paid === null || compare(paid, expected) !== 0) {
      log.error("upstream notify amount mismatch", { channel: channelId, order: order.id, expected, paid: result.paidMoney });
      return text("fail", 400);
    }

    if (store.markPaid(order.id, result.upstreamRef)) {
      log.info("order paid", { order: order.id, out_trade_no: order.out_trade_no, channel: channelId, upstream_ref: result.upstreamRef });
      notifier.kick();
    }
    return channel.ackResponse();
  }

  async function fetchHandler(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    const method = req.method;
    try {
      if (pathname === "/healthz" && method === "GET") return text("ok");
      if (pathname === "/submit.php" && (method === "GET" || method === "POST")) return await submit(req);
      const m = /^\/notify\/([a-z]+)\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
      if (m && (method === "GET" || method === "POST")) return await notify(req, m[1]!, m[2]!);
      return text("not found", 404);
    } catch (err) {
      log.error("unhandled error", { path: pathname, err });
      return text("internal error", 500);
    }
  }

  return { fetch: fetchHandler, channels };
}
