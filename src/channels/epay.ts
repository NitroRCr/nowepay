import type { EpayChannelConfig } from "../config.ts";
import type { Order } from "../db.ts";
import { readParams, signParams, verifyEpay } from "../epay/sign.ts";
import { autoSubmitForm } from "../html.ts";
import { notifyPath, type Channel, type ChannelContext, type PaymentResult, type NotifyResult } from "./types.ts";

/** Third-party epay-compatible upstream (e.g. WeChat Pay / Alipay aggregators). */
export class EpayChannel implements Channel {
  constructor(readonly config: EpayChannelConfig) {}

  upstreamType(type: string): string {
    return this.config.typeMap[type] ?? type;
  }

  async createPayment(order: Order, ctx: ChannelContext): Promise<PaymentResult> {
    const params = signParams(
      {
        pid: this.config.pid,
        type: this.upstreamType(order.type),
        out_trade_no: order.id,
        notify_url: ctx.publicUrl + notifyPath(this.config),
        // Send the payer straight back to new-api after paying.
        return_url: order.return_url,
        name: order.name,
        money: order.upstream_money,
        device: ctx.extra.device ?? "",
      },
      this.config.key,
    );
    const action = new URL(this.config.submitPath, this.config.baseUrl).toString();
    return { response: autoSubmitForm(action, params) };
  }

  async parseNotify(req: Request): Promise<NotifyResult> {
    const p = await readParams(req);
    if (!verifyEpay(p, this.config.key)) return { kind: "invalid", reason: "bad signature" };
    if (p.pid !== undefined && p.pid !== this.config.pid) return { kind: "invalid", reason: "pid mismatch" };
    const orderId = p.out_trade_no;
    if (!orderId) return { kind: "invalid", reason: "missing out_trade_no" };
    if (p.trade_status !== "TRADE_SUCCESS") {
      return { kind: "ignored", orderId, reason: `trade_status=${p.trade_status ?? ""}` };
    }
    if (!p.money) return { kind: "invalid", reason: "missing money" };
    return { kind: "paid", orderId, upstreamRef: p.trade_no ?? null, paidMoney: p.money };
  }

  ackResponse(): Response {
    return new Response("success", { headers: { "content-type": "text/plain" } });
  }
}
