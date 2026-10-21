import type { ChannelConfig } from "../config.ts";
import type { Order } from "../db.ts";

export interface ChannelContext {
  /** Public base URL of the gateway (no trailing slash). */
  publicUrl: string;
  /** Extra downstream params that may be forwarded (e.g. device). */
  extra: Record<string, string>;
}

export type NotifyResult =
  /** Callback verified and indicates success; `paidMoney` is checked against the order. */
  | { kind: "paid"; orderId: string; upstreamRef: string | null; paidMoney: string }
  /** Verified but not a success event (pending, partially paid, ...). */
  | { kind: "ignored"; orderId: string | null; reason: string }
  /** Signature or payload invalid. */
  | { kind: "invalid"; reason: string };

export interface PaymentResult {
  response: Response;
  /** Upstream identifiers to persist (e.g. invoice id and hosted URL). */
  upstreamRef?: string | null;
  payUrl?: string | null;
}

export interface Channel {
  readonly config: ChannelConfig;
  /** Create the upstream payment and return the response for the payer's browser. */
  createPayment(order: Order, ctx: ChannelContext): Promise<PaymentResult>;
  /** Parse and verify an upstream callback. */
  parseNotify(req: Request): Promise<NotifyResult>;
  /** Response the upstream expects once a callback has been handled. */
  ackResponse(): Response;
}

export function notifyPath(cfg: ChannelConfig): string {
  return `/notify/${cfg.kind}/${cfg.id}`;
}
