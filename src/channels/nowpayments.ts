import { createHmac } from "node:crypto";
import type { NowpaymentsChannelConfig } from "../config.ts";
import type { Order } from "../db.ts";
import { safeEqual } from "../epay/sign.ts";
import { errorPage } from "../html.ts";
import { log } from "../log.ts";
import { notifyPath, type Channel, type ChannelContext, type PaymentResult, type NotifyResult } from "./types.ts";

interface InvoiceResponse {
  id?: string | number;
  invoice_url?: string;
}

/** Recursively sort object keys, as required by the NOWPayments IPN signature. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, sortKeys(obj[k])]),
    );
  }
  return value;
}

export function nowpaymentsSignature(payload: unknown, secret: string): string {
  return createHmac("sha512", secret).update(JSON.stringify(sortKeys(payload))).digest("hex");
}

/**
 * NOWPayments hosted invoice. The payer picks a coin on the invoice page;
 * only `finished` IPNs are treated as paid.
 */
export class NowpaymentsChannel implements Channel {
  constructor(
    readonly config: NowpaymentsChannelConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async createPayment(order: Order, ctx: ChannelContext): Promise<PaymentResult> {
    // Reuse an invoice already created for this order (e.g. user hit submit twice).
    if (order.pay_url) return { response: Response.redirect(order.pay_url, 302) };

    const body: Record<string, unknown> = {
      price_amount: Number(order.upstream_money),
      price_currency: this.config.priceCurrency,
      order_id: order.id,
      order_description: order.name,
      ipn_callback_url: ctx.publicUrl + notifyPath(this.config),
      success_url: order.return_url,
      cancel_url: order.return_url,
    };
    if (this.config.payCurrency) body.pay_currency = this.config.payCurrency;

    let res: Response;
    try {
      res = await this.fetchImpl(new URL("/v1/invoice", this.config.baseUrl), {
        method: "POST",
        headers: { "x-api-key": this.config.apiKey, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      log.error("nowpayments invoice request failed", { order: order.id, err });
      return { response: errorPage("支付通道暂时不可用，请稍后重试", 502) };
    }
    const text = await res.text();
    let data: InvoiceResponse = {};
    try {
      data = JSON.parse(text) as InvoiceResponse;
    } catch {
      /* handled below */
    }
    if (!res.ok || !data.invoice_url) {
      log.error("nowpayments invoice creation failed", { order: order.id, status: res.status, body: text.slice(0, 500) });
      return { response: errorPage("创建支付订单失败，请稍后重试", 502) };
    }
    return {
      response: Response.redirect(data.invoice_url, 302),
      upstreamRef: data.id != null ? String(data.id) : null,
      payUrl: data.invoice_url,
    };
  }

  async parseNotify(req: Request): Promise<NotifyResult> {
    const sig = req.headers.get("x-nowpayments-sig");
    const raw = await req.text();
    if (!sig) return { kind: "invalid", reason: "missing x-nowpayments-sig" };
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { kind: "invalid", reason: "body is not JSON" };
    }
    if (!payload || typeof payload !== "object") return { kind: "invalid", reason: "body is not an object" };
    if (!safeEqual(sig.toLowerCase(), nowpaymentsSignature(payload, this.config.ipnSecret))) {
      return { kind: "invalid", reason: "bad signature" };
    }

    const orderId = payload.order_id != null ? String(payload.order_id) : null;
    if (!orderId) return { kind: "invalid", reason: "missing order_id" };
    const status = String(payload.payment_status ?? "");
    if (status !== "finished") return { kind: "ignored", orderId, reason: `payment_status=${status}` };

    const currency = String(payload.price_currency ?? "").toLowerCase();
    if (currency !== this.config.priceCurrency.toLowerCase()) {
      return { kind: "invalid", reason: `price_currency mismatch: ${currency}` };
    }
    if (payload.price_amount == null) return { kind: "invalid", reason: "missing price_amount" };
    const ref = payload.payment_id ?? payload.invoice_id;
    return { kind: "paid", orderId, upstreamRef: ref != null ? String(ref) : null, paidMoney: String(payload.price_amount) };
  }

  ackResponse(): Response {
    return new Response("ok", { headers: { "content-type": "text/plain" } });
  }
}
