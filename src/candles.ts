import type { Candle } from "./binance.js";
import type { HyperliquidInfo } from "./hyperliquid.js";

export type { Candle };

export const CANDLE_SOURCES = [
  "oracle",
  "binance",
  "okx",
  "bybit",
  "kraken",
  "kucoin",
  "gate",
  "mexc",
  "coinbase",
  "hl",
] as const;
export type CandleSource = (typeof CANDLE_SOURCES)[number];

/**
 * Hyperliquid's spot oracle: per validator, the weighted median of these venues'
 * spot mids (hyperliquid-docs/hypercore/oracle). Hyperliquid spot itself is
 * excluded for assets whose primary liquidity is elsewhere, like BTC and ETH.
 */
export const ORACLE_WEIGHTS: [string, number][] = [
  ["binance", 3],
  ["okx", 2],
  ["bybit", 2],
  ["kraken", 1],
  ["kucoin", 1],
  ["gate", 1],
  ["mexc", 1],
];

/** Weighted median: the smallest value whose cumulative weight reaches half the total. */
export function weightedMedian(points: { value: number; weight: number }[]): number {
  const sorted = [...points].sort((a, b) => a.value - b.value);
  const half = sorted.reduce((a, p) => a + p.weight, 0) / 2;
  let acc = 0;
  for (const p of sorted) {
    acc += p.weight;
    if (acc >= half) return p.value;
  }
  return sorted[sorted.length - 1]!.value;
}

/**
 * Oracle-style composite candles: each OHLC field is the weighted median across
 * the venues that have that bar; volume is summed. A venue that fails to load is
 * dropped, as long as at least half the total weight remains.
 */
export async function oracleCandles(
  info: HyperliquidInfo,
  underlying: string,
  interval: string,
  fromMs: number,
  toMs: number,
): Promise<Candle[]> {
  const results = await Promise.allSettled(
    ORACLE_WEIGHTS.map(([venue]) => fetchCandles(venue, info, underlying, interval, fromMs, toMs)),
  );
  const loaded: { candles: Map<number, Candle>; weight: number }[] = [];
  const failed: string[] = [];
  results.forEach((r, i) => {
    const [venue, weight] = ORACLE_WEIGHTS[i]!;
    if (r.status === "fulfilled" && r.value.length > 0) loaded.push({ candles: new Map(r.value.map((c) => [c.t, c])), weight });
    else failed.push(venue);
  });
  const total = ORACLE_WEIGHTS.reduce((a, [, w]) => a + w, 0);
  const got = loaded.reduce((a, l) => a + l.weight, 0);
  if (got * 2 < total) throw new Error(`oracle source: only ${got}/${total} venue weight loaded (failed: ${failed.join(", ")})`);
  if (failed.length > 0) console.warn(`oracle source: ${failed.join(", ")} unavailable, using the remaining ${got}/${total} weight`);

  const times = new Set<number>();
  for (const l of loaded) for (const t of l.candles.keys()) times.add(t);
  const out: Candle[] = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    const bars = loaded.flatMap((l) => {
      const c = l.candles.get(t);
      return c ? [{ c, weight: l.weight }] : [];
    });
    // Skip bars too few venues printed (listing gaps, partial outages).
    if (bars.reduce((a, b) => a + b.weight, 0) * 2 < got) continue;
    const med = (k: "o" | "h" | "l" | "c") => String(weightedMedian(bars.map((b) => ({ value: Number(b.c[k]), weight: b.weight }))));
    out.push({ t, o: med("o"), h: med("h"), l: med("l"), c: med("c"), v: String(bars.reduce((a, b) => a + Number(b.c.v), 0)) });
  }
  return out;
}

/** Aggregate fine candles into coarser UTC-aligned bars (e.g. 1h -> 4h for venues without 4h). */
export function aggregate(candles: Candle[], span: number): Candle[] {
  const out: Candle[] = [];
  let bucket: Candle | null = null;
  for (const c of candles) {
    const start = Math.floor(c.t / span) * span;
    if (!bucket || bucket.t !== start) {
      if (bucket) out.push(bucket);
      bucket = { ...c, t: start };
    } else {
      bucket.h = String(Math.max(Number(bucket.h), Number(c.h)));
      bucket.l = String(Math.min(Number(bucket.l), Number(c.l)));
      bucket.c = c.c;
      bucket.v = String(Number(bucket.v) + Number(c.v));
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

export async function fetchCandles(
  source: string,
  info: HyperliquidInfo,
  underlying: string,
  interval: string,
  fromMs: number,
  toMs: number,
): Promise<Candle[]> {
  switch (source) {
    case "oracle":
      return oracleCandles(info, underlying, interval, fromMs, toMs);
    case "kucoin": {
      const { kucoinCandles } = await import("./exchanges.js");
      return kucoinCandles(underlying, interval, fromMs, toMs);
    }
    case "gate": {
      const { gateCandles } = await import("./exchanges.js");
      return gateCandles(underlying, interval, fromMs, toMs);
    }
    case "mexc": {
      const { mexcCandles } = await import("./exchanges.js");
      return mexcCandles(underlying, interval, fromMs, toMs);
    }
    case "binance": {
      const { binanceKlines, binanceSymbol } = await import("./binance.js");
      return binanceKlines(binanceSymbol(underlying), interval, fromMs, toMs);
    }
    case "okx": {
      const { okxCandles, okxInstId } = await import("./okx.js");
      return okxCandles(okxInstId(underlying), interval, fromMs, toMs);
    }
    case "bybit": {
      const { bybitKlines } = await import("./bybit.js");
      return bybitKlines(`${underlying.toUpperCase()}USDT`, interval, fromMs, toMs);
    }
    case "coinbase": {
      const { coinbaseCandles } = await import("./coinbase.js");
      return coinbaseCandles(`${underlying.toUpperCase()}-USD`, interval, fromMs, toMs);
    }
    case "kraken": {
      const { krakenOhlc } = await import("./kraken.js");
      return krakenOhlc(underlying, interval, fromMs, toMs);
    }
    case "hl":
      return info.candles(underlying.toUpperCase(), interval, fromMs, toMs);
    default:
      throw new Error(`--source must be one of ${CANDLE_SOURCES.join(", ")}, got "${source}"`);
  }
}
