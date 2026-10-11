import type { Candle } from "./binance.js";
import type { HyperliquidInfo } from "./hyperliquid.js";

export type { Candle };

export const CANDLE_SOURCES = ["binance", "okx", "bybit", "coinbase", "kraken", "hl"] as const;
export type CandleSource = (typeof CANDLE_SOURCES)[number];

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
