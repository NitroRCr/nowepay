import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { nowpaymentsSignature, sortKeys } from "../src/channels/nowpayments.ts";
import { expandEnv, parseConfig } from "../src/config.ts";
import { epaySign, signParams, verifyEpay } from "../src/epay/sign.ts";
import { compare, mulRound, normalize } from "../src/money.ts";

describe("money", () => {
  test("multiplies exactly and rounds half-up", () => {
    expect(mulRound("10.00", "7", 2)).toBe("70.00");
    expect(mulRound("0.1", "3", 2)).toBe("0.30");
    expect(mulRound("1.15", "7.25", 2)).toBe("8.34"); // 8.3375
    expect(mulRound("1.005", "1", 2)).toBe("1.01");
    expect(mulRound("3", "0.333", 0)).toBe("1");
  });
  test("normalize and compare", () => {
    expect(normalize("70", 2)).toBe("70.00");
    expect(compare("70.00", "70")).toBe(0);
    expect(compare("69.99", "70")).toBe(-1);
  });
  test("rejects invalid input", () => {
    expect(() => mulRound("-1", "1", 2)).toThrow();
    expect(() => mulRound("1e3", "1", 2)).toThrow();
  });
});

describe("epay sign", () => {
  test("matches go-epay algorithm", () => {
    const params = { pid: "1", type: "wxpay", money: "1.00", name: "TUC1", sign: "x", sign_type: "MD5", empty: "" };
    const expected = createHash("md5").update("money=1.00&name=TUC1&pid=1&type=wxpay" + "k").digest("hex");
    expect(epaySign(params, "k")).toBe(expected);
  });
  test("round-trips and detects tampering", () => {
    const signed = signParams({ pid: "1", money: "1.00", out_trade_no: "A" }, "k");
    expect(verifyEpay(signed, "k")).toBe(true);
    expect(verifyEpay({ ...signed, money: "2.00" }, "k")).toBe(false);
    expect(verifyEpay(signed, "other")).toBe(false);
  });
  test("rejects ambiguous separators", () => {
    expect(() => epaySign({ name: "A&B" }, "k")).toThrow();
    expect(() => epaySign({ "a=b": "x" }, "k")).toThrow();
    expect(verifyEpay({ name: "A&B", sign: "x" }, "k")).toBe(false);
  });
});

describe("nowpayments signature", () => {
  test("sorts keys recursively", () => {
    expect(JSON.stringify(sortKeys({ b: 1, a: { d: 1, c: [{ f: 1, e: 2 }] } }))).toBe('{"a":{"c":[{"e":2,"f":1}],"d":1},"b":1}');
    expect(nowpaymentsSignature({ b: 1, a: 2 }, "s")).toBe(nowpaymentsSignature({ a: 2, b: 1 }, "s"));
  });
});

const baseYaml = `
server: { publicUrl: "https://pay.example.com" }
merchants: [{ pid: 1001, key: "\${K}" }]
channels:
  - { id: a, kind: epay, types: [wxpay], rate: 7, baseUrl: "https://up.example.com", pid: 1, key: k }
`;

describe("config", () => {
  test("parses with env expansion and coercion", () => {
    const c = parseConfig(baseYaml, { K: "secret" });
    expect(c.merchants[0]).toEqual({ pid: "1001", key: "secret" });
    expect(c.channels[0]!.rate).toBe("7");
    expect(c.channels[0]!.precision).toBe(2);
  });
  test("ignores ${VAR} in comments", () => {
    expect(() => parseConfig("# uses ${NOT_SET}\n" + baseYaml, { K: "s" })).not.toThrow();
  });
  test("env defaults and missing env", () => {
    expect(expandEnv("${X:-d}", {})).toBe("d");
    expect(() => expandEnv("${X}", {})).toThrow();
  });
  test("rejects duplicate types and http publicUrl", () => {
    const dup = baseYaml + `  - { id: b, kind: epay, types: [wxpay], baseUrl: "https://u.example.com", pid: 2, key: k }\n`;
    expect(() => parseConfig(dup, { K: "s" })).toThrow(/already routed/);
    expect(() => parseConfig(baseYaml.replace("https://pay", "http://pay"), { K: "s" })).toThrow(/https/);
  });
});
