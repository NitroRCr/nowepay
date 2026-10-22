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

/** The exact string that gets hashed (without the key), for diagnostics. */
export function signString(params: Params): string {
  return Object.keys(params)
    .filter((k) => k !== "sign" && k !== "sign_type" && params[k] !== "" && params[k] !== undefined)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
}

/** Non-reversible fingerprint of a secret: length + sha256 prefix. */
export function keyFingerprint(key: string): string {
  return `len=${key.length} sha256=${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 12)}`;
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

/**
 * Query params injected by analytics/ad tooling (e.g. gtag cross-domain linker adds `_gl`
 * to form actions). They are never part of an epay request and would break the signature.
 */
const TRACKING_PARAM = /^(_gl|_ga|_gac.*|utm_.+|gclid|gbraid|wbraid|dclid|fbclid|msclkid|yclid|ttclid|twclid|li_fat_id|mc_cid|mc_eid)$/i;

function queryParams(req: Request): Params {
  const out: Params = {};
  new URL(req.url).searchParams.forEach((v, k) => {
    if (!TRACKING_PARAM.test(k)) out[k] = v;
  });
  return out;
}

/**
 * Read epay params.
 * - POST: body only. The query string is ignored because browsers/analytics may append
 *   junk to the form action (e.g. `?_gl=`), which would break the signature.
 *   Falls back to the query if the body is empty (some upstreams POST with query params).
 * - GET: query string, minus known tracking params.
 */
export async function readParams(req: Request): Promise<Params> {
  if (req.method !== "POST") return queryParams(req);

  const out: Params = {};
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    for (const [k, v] of Object.entries(body)) if (v != null) out[k] = String(v);
  } else if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    form.forEach((v, k) => {
      if (typeof v === "string") out[k] = v;
    });
  } else {
    // urlencoded (or missing content-type): parse the raw body ourselves; req.formData()
    // is unreliable for some body sources in Bun and returns an empty result.
    new URLSearchParams(await req.text()).forEach((v, k) => (out[k] = v));
  }
  return Object.keys(out).length > 0 ? out : queryParams(req);
}
