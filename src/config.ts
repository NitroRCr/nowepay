import { z } from "zod";
import { isDecimal } from "./money.ts";

const decimal = z.string().refine(isDecimal, "must be a non-negative decimal string, e.g. \"7\" or \"7.2\"");
// Accept YAML numbers too (rate: 7) and coerce to string.
const decimalLike = z.union([z.number().nonnegative(), z.string()]).transform(String).pipe(decimal);
const idLike = z.union([z.number(), z.string()]).transform(String).pipe(z.string().min(1));

const channelBase = {
  id: z.string().regex(/^[A-Za-z0-9_-]+$/, "id may only contain letters, digits, _ and -"),
  /** epay `type` values (as configured in new-api PayMethods) routed to this channel. */
  types: z.array(z.string().min(1)).min(1),
  /** upstreamMoney = money * rate */
  rate: decimalLike.default("1"),
  /** Fractional digits of the upstream amount. */
  precision: z.number().int().min(0).max(8).default(2),
};

const nowpaymentsChannel = z.object({
  ...channelBase,
  kind: z.literal("nowpayments"),
  apiKey: z.string().min(1),
  ipnSecret: z.string().min(1),
  priceCurrency: z.string().min(1).default("usd"),
  baseUrl: z.url().default("https://api.nowpayments.io"),
  /** Optional fixed crypto currency for the invoice; omit to let the payer choose. */
  payCurrency: z.string().optional(),
});

const epayChannel = z.object({
  ...channelBase,
  kind: z.literal("epay"),
  baseUrl: z.url(),
  /** Path of the submit endpoint on the upstream. */
  submitPath: z.string().default("/submit.php"),
  pid: idLike,
  key: z.string().min(1),
  /** Map downstream type -> upstream type. Unmapped types are passed through. */
  typeMap: z.record(z.string(), z.string()).default({}),
});

export const configSchema = z
  .object({
    server: z.object({
      port: z.number().int().positive().default(3000),
      host: z.string().default("0.0.0.0"),
      /** Public base URL of this gateway, used to build upstream callback URLs. */
      publicUrl: z.url().transform((u) => u.replace(/\/+$/, "")),
      /** Allow http publicUrl (local dev only). */
      allowInsecure: z.boolean().default(false),
    }),
    database: z.object({ path: z.string().default("/data/nowepay.sqlite") }).default({ path: "/data/nowepay.sqlite" }),
    notify: z
      .object({
        /** Retry delays (seconds) for downstream notifications. */
        retryDelays: z.array(z.number().int().positive()).default([15, 60, 300, 900, 1800, 3600, 7200, 21600]),
        timeoutMs: z.number().int().positive().default(10_000),
      })
      .default({ retryDelays: [15, 60, 300, 900, 1800, 3600, 7200, 21600], timeoutMs: 10_000 }),
    merchants: z.array(z.object({ pid: idLike, key: z.string().min(1) })).min(1),
    channels: z.array(z.discriminatedUnion("kind", [nowpaymentsChannel, epayChannel])).min(1),
  })
  .superRefine((cfg, ctx) => {
    if (!cfg.server.allowInsecure && !cfg.server.publicUrl.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["server", "publicUrl"], message: "must be https (set allowInsecure for dev)" });
    }
    const seenIds = new Set<string>();
    const seenTypes = new Map<string, string>();
    cfg.channels.forEach((ch, i) => {
      if (seenIds.has(ch.id)) ctx.addIssue({ code: "custom", path: ["channels", i, "id"], message: `duplicate id ${ch.id}` });
      seenIds.add(ch.id);
      for (const t of ch.types) {
        const prev = seenTypes.get(t);
        if (prev) ctx.addIssue({ code: "custom", path: ["channels", i, "types"], message: `type "${t}" already routed to ${prev}` });
        seenTypes.set(t, ch.id);
      }
    });
    const pids = new Set<string>();
    cfg.merchants.forEach((m, i) => {
      if (pids.has(m.pid)) ctx.addIssue({ code: "custom", path: ["merchants", i, "pid"], message: `duplicate pid ${m.pid}` });
      pids.add(m.pid);
    });
  });

export type Config = z.infer<typeof configSchema>;
export type ChannelConfig = Config["channels"][number];
export type NowpaymentsChannelConfig = Extract<ChannelConfig, { kind: "nowpayments" }>;
export type EpayChannelConfig = Extract<ChannelConfig, { kind: "epay" }>;

/** Replace ${VAR} / ${VAR:-default} with environment values. */
export function expandEnv(text: string, env: Record<string, string | undefined> = process.env): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, def?: string) => {
    const v = env[name];
    if (v !== undefined && v !== "") return v;
    if (def !== undefined) return def;
    throw new Error(`environment variable ${name} is not set`);
  });
}

/** Expand env vars in every string value of a parsed document (comments and keys are untouched). */
function expandDeep(value: unknown, env?: Record<string, string | undefined>): unknown {
  if (typeof value === "string") return expandEnv(value, env);
  if (Array.isArray(value)) return value.map((v) => expandDeep(v, env));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandDeep(v, env)]));
  }
  return value;
}

export function parseConfig(yamlText: string, env?: Record<string, string | undefined>): Config {
  const raw = expandDeep(Bun.YAML.parse(yamlText), env);
  const res = configSchema.safeParse(raw);
  if (!res.success) throw new Error(`invalid config:\n${z.prettifyError(res.error)}`);
  return res.data;
}

export async function loadConfig(path = process.env.CONFIG_PATH ?? "config.yaml"): Promise<Config> {
  return parseConfig(await Bun.file(path).text());
}
