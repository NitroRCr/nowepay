// Exact decimal arithmetic on strings via bigint, to avoid float rounding on money.

const DECIMAL_RE = /^\d+(\.\d+)?$/;

interface Dec {
  value: bigint; // scaled integer
  scale: number; // number of fractional digits
}

function parse(input: string): Dec {
  const s = input.trim();
  if (!DECIMAL_RE.test(s)) throw new Error(`invalid decimal: ${JSON.stringify(input)}`);
  const [int = "0", frac = ""] = s.split(".");
  return { value: BigInt(int + frac), scale: frac.length };
}

export function isDecimal(input: string): boolean {
  return DECIMAL_RE.test(input.trim());
}

/** Multiply two non-negative decimals and round half-up to `precision` fractional digits. */
export function mulRound(a: string, b: string, precision: number): string {
  const x = parse(a);
  const y = parse(b);
  const product = x.value * y.value;
  const scale = x.scale + y.scale;
  let scaled: bigint;
  if (scale <= precision) {
    scaled = product * 10n ** BigInt(precision - scale);
  } else {
    const div = 10n ** BigInt(scale - precision);
    scaled = product / div;
    if ((product % div) * 2n >= div) scaled += 1n;
  }
  return format(scaled, precision);
}

/** Normalize a decimal string to fixed `precision` (round half-up). */
export function normalize(a: string, precision: number): string {
  return mulRound(a, "1", precision);
}

/** Compare two decimals numerically. */
export function compare(a: string, b: string): -1 | 0 | 1 {
  const x = parse(a);
  const y = parse(b);
  const scale = Math.max(x.scale, y.scale);
  const xv = x.value * 10n ** BigInt(scale - x.scale);
  const yv = y.value * 10n ** BigInt(scale - y.scale);
  return xv === yv ? 0 : xv < yv ? -1 : 1;
}

function format(scaled: bigint, precision: number): string {
  if (precision === 0) return scaled.toString();
  const s = scaled.toString().padStart(precision + 1, "0");
  return `${s.slice(0, -precision)}.${s.slice(-precision)}`;
}
