import { createHash, timingSafeEqual } from "node:crypto";

export type Params = Record<string, string>;

/**
 * Build the epay MD5 sign: drop empty values, `sign`, `sign_type`; sort keys;
 * join as k=v&k=v (raw, no URL encoding); append merchant key; md5 hex.
 * Rejects values containing '&' since they make the string ambiguous.
 */
export function epaySign(params: Params, key: string): string {
  const keys = Object.keys(params)
    .filter((k) => k !== "sign" && k !== "sign_type" && params[k] !== "" && params[k] !== undefined)
    .sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = params[k]!;
    if (k === "" || /[&=]/.test(k)) throw new Error(`invalid param name: ${k}`);
    if (v.includes("&")) throw new Error(`param ${k} contains '&'`);
    parts.push(`${k}=${v}`);
  }
  return createHash("md5").update(parts.join("&") + key, "utf8").digest("hex");
}

export function signParams(params: Params, key: string): Params {
  const out: Params = {};
  for (const [k, v] of Object.entries(params)) if (v !== "") out[k] = v;
  out.sign = epaySign(out, key);
  out.sign_type = "MD5";
  return out;
}

export function verifyEpay(params: Params, key: string): boolean {
  const given = params.sign;
  if (!given) return false;
  let expected: string;
  try {
    expected = epaySign(params, key);
  } catch {
    return false;
  }
  return safeEqual(given.toLowerCase(), expected);
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Read params from query string and (for POST) form/JSON body. Body wins. */
export async function readParams(req: Request): Promise<Params> {
  const out: Params = {};
  new URL(req.url).searchParams.forEach((v, k) => (out[k] = v));
  if (req.method === "POST") {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      for (const [k, v] of Object.entries(body)) if (v != null) out[k] = String(v);
    } else if (ct.includes("form")) {
      const form = await req.formData();
      form.forEach((v, k) => {
        if (typeof v === "string") out[k] = v;
      });
    }
  }
  return out;
}
