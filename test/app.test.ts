import { beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { nowpaymentsSignature } from "../src/channels/nowpayments.ts";
import { parseConfig, type Config } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { signParams, verifyEpay } from "../src/epay/sign.ts";
import { Notifier } from "../src/notifier.ts";

const config: Config = parseConfig(`
server: { publicUrl: "https://gw.example.com" }
merchants: [{ pid: "1001", key: "newapi-key" }]
notify: { retryDelays: [1, 1] }
channels:
  - id: crypto
    kind: nowpayments
    types: [crypto]
    apiKey: np-key
    ipnSecret: ipn-secret
  - id: wx
    kind: epay
    types: [wxpay, alipay]
    rate: 7
    baseUrl: "https://up.example.com"
    pid: "88"
    key: up-key
    typeMap: { alipay: ali }
`);

type Call = { url: string; init?: RequestInit };
let store: Store;
let calls: Call[];
let downstreamReply: string;
let kicks: number;

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = input.toString();
  calls.push({ url, init });
  if (url.includes("/v1/invoice")) {
    return Response.json({ id: "inv_1", invoice_url: "https://nowpayments.io/payment/?iid=inv_1" });
  }
  return new Response(downstreamReply);
}) as typeof fetch;

function app() {
  return createApp({ config, store, notifier: { kick: () => void kicks++ }, fetchImpl: fakeFetch });
}

function submitReq(over: Record<string, string> = {}, key = "newapi-key"): Request {
  const params = signParams(
    {
      pid: "1001",
      type: "wxpay",
      out_trade_no: "USR1NOabc",
      notify_url: "https://newapi.example.com/api/user/epay/notify",
      return_url: "https://newapi.example.com/console/log",
      name: "TUC10",
      money: "10.00",
      device: "pc",
      ...over,
    },
    key,
  );
  return new Request("https://gw.example.com/submit.php", { method: "POST", body: new URLSearchParams(params) });
}

/** Extract hidden inputs from the auto-submit form. */
function formFields(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/name="([^"]+)" value="([^"]*)"/g)) out[m[1]!] = m[2]!.replaceAll("&amp;", "&");
  return out;
}

beforeEach(() => {
  store = new Store(":memory:");
  calls = [];
  downstreamReply = "success";
  kicks = 0;
});

describe("submit", () => {
  test("rejects bad signature and unknown type", async () => {
    expect((await app().fetch(submitReq({}, "wrong"))).status).toBe(400);
    expect((await app().fetch(submitReq({ type: "unknown" }))).status).toBe(400);
  });

  test("epay upstream: converts money, re-signs with upstream key, maps type", async () => {
    const res = await app().fetch(submitReq({ type: "alipay" }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('action="https://up.example.com/submit.php"');
    const f = formFields(html);
    expect(f.pid).toBe("88");
    expect(f.type).toBe("ali");
    expect(f.money).toBe("70.00");
    expect(f.notify_url).toBe("https://gw.example.com/notify/epay/wx");
    expect(verifyEpay(f, "up-key")).toBe(true);
    const order = store.get(f.out_trade_no!)!;
    expect(order.out_trade_no).toBe("USR1NOabc");
    expect(order.upstream_money).toBe("70.00");
  });

  test("nowpayments: creates invoice and redirects; repeated submit reuses it", async () => {
    const a = app();
    const res = await a.fetch(submitReq({ type: "crypto" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://nowpayments.io/payment/?iid=inv_1");
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body).toMatchObject({ price_amount: 10, price_currency: "usd", ipn_callback_url: "https://gw.example.com/notify/nowpayments/crypto" });
    expect(new Headers(calls[0]!.init!.headers).get("x-api-key")).toBe("np-key");

    const again = await a.fetch(submitReq({ type: "crypto" }));
    expect(again.status).toBe(302);
    expect(calls.length).toBe(1);
  });

  test("ignores injected query params like ?_gl= on POST and GET", async () => {
    const post = submitReq();
    const withGl = new Request("https://gw.example.com/submit.php?_gl=1*abc*_ga*MTIz", { method: "POST", body: await post.text(), headers: post.headers });
    expect((await app().fetch(withGl)).status).toBe(200);

    const params = new URLSearchParams(await submitReq({ out_trade_no: "G1" }).text());
    const get = new Request(`https://gw.example.com/submit.php?${params}&_gl=1*x&utm_source=y`);
    expect((await app().fetch(get)).status).toBe(200);
  });

  test("conflicting reuse of out_trade_no is rejected", async () => {
    const a = app();
    await a.fetch(submitReq());
    expect((await a.fetch(submitReq({ money: "20.00" }))).status).toBe(400);
  });
});

async function createEpayOrder() {
  const html = await (await app().fetch(submitReq())).text();
  return store.get(formFields(html).out_trade_no!)!;
}

function epayNotify(over: Record<string, string>, key = "up-key"): Request {
  const p = signParams({ pid: "88", trade_no: "UP1", type: "wxpay", name: "TUC10", trade_status: "TRADE_SUCCESS", ...over }, key);
  return new Request(`https://gw.example.com/notify/epay/wx?${new URLSearchParams(p)}`);
}

describe("epay notify", () => {
  test("marks paid once and acks with success", async () => {
    const order = await createEpayOrder();
    const res = await app().fetch(epayNotify({ out_trade_no: order.id, money: "70.00" }));
    expect(await res.text()).toBe("success");
    expect(store.get(order.id)!.status).toBe("paid");
    expect(store.get(order.id)!.upstream_ref).toBe("UP1");
    await app().fetch(epayNotify({ out_trade_no: order.id, money: "70.00" }));
    expect(kicks).toBe(1);
  });

  test("rejects amount mismatch, bad signature, and wrong channel", async () => {
    const order = await createEpayOrder();
    expect((await app().fetch(epayNotify({ out_trade_no: order.id, money: "10.00" }))).status).toBe(400);
    expect((await app().fetch(epayNotify({ out_trade_no: order.id, money: "70.00" }, "bad"))).status).toBe(400);
    const wrong = new Request("https://gw.example.com/notify/nowpayments/wx", { method: "POST", body: "{}" });
    expect((await app().fetch(wrong)).status).toBe(404);
    expect(store.get(order.id)!.status).toBe("pending");
  });
});

function ipn(payload: Record<string, unknown>, secret = "ipn-secret"): Request {
  return new Request("https://gw.example.com/notify/nowpayments/crypto", {
    method: "POST",
    headers: { "content-type": "application/json", "x-nowpayments-sig": nowpaymentsSignature(payload, secret) },
    body: JSON.stringify(payload),
  });
}

describe("nowpayments notify", () => {
  test("only finished with matching amount counts", async () => {
    const res = await app().fetch(submitReq({ type: "crypto", out_trade_no: "N1" }));
    expect(res.status).toBe(302);
    const order = store.findByOutTradeNo("1001", "N1")!;
    expect(order.upstream_ref).toBe("inv_1");
    const base = { payment_id: 5, order_id: order.id, price_amount: 10, price_currency: "usd" };

    expect((await app().fetch(ipn({ ...base, payment_status: "partially_paid" }))).status).toBe(200);
    expect(store.get(order.id)!.status).toBe("pending");
    expect((await app().fetch(ipn({ ...base, payment_status: "finished" }, "wrong")))).toHaveProperty("status", 400);
    expect((await app().fetch(ipn({ ...base, price_amount: 9, payment_status: "finished" }))).status).toBe(400);

    expect((await app().fetch(ipn({ ...base, payment_status: "finished" }))).status).toBe(200);
    expect(store.get(order.id)!.status).toBe("paid");
    expect(store.get(order.id)!.upstream_ref).toBe("5");
  });
});

describe("notifier", () => {
  test("sends original money/type signed with merchant key, retries until success", async () => {
    const order = await createEpayOrder();
    await app().fetch(epayNotify({ out_trade_no: order.id, money: "70.00" }));
    const notifier = new Notifier(store, config, fakeFetch);
    calls = [];

    downstreamReply = "fail";
    await notifier.runOnce();
    let o = store.get(order.id)!;
    expect(o.notify_status).toBe("pending");
    expect(o.notify_attempts).toBe(1);

    const u = new URL(calls[0]!.url);
    expect(u.origin + u.pathname).toBe("https://newapi.example.com/api/user/epay/notify");
    const p = Object.fromEntries(u.searchParams);
    expect(p).toMatchObject({ pid: "1001", out_trade_no: "USR1NOabc", money: "10.00", type: "wxpay", trade_status: "TRADE_SUCCESS" });
    expect(verifyEpay(p, "newapi-key")).toBe(true);

    downstreamReply = "success";
    await notifier.runOnce(Date.now() + 2_000);
    o = store.get(order.id)!;
    expect(o.notify_status).toBe("done");
    expect(o.notify_attempts).toBe(2);
  });

  test("gives up after configured retries", async () => {
    const order = await createEpayOrder();
    await app().fetch(epayNotify({ out_trade_no: order.id, money: "70.00" }));
    const notifier = new Notifier(store, config, fakeFetch);
    downstreamReply = "nope";
    for (let i = 0; i < 4; i++) await notifier.runOnce(Date.now() + (i + 1) * 5_000);
    const o = store.get(order.id)!;
    expect(o.notify_status).toBe("failed");
    expect(o.notify_attempts).toBe(3);
  });
});
