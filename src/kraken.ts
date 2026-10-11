import type { Candle } from "./binance.js";

/**
 * Minimal Kraken OHLC fetcher (public API). Kraken serves at most the last
 * ~720 bars per interval with no deeper pagination — at 4h that is 120 days,
 * enough for the default forecast windows.
 */

const KRAKEN_API = process.env.KRAKEN_API_URL ?? "https://api.kraken.com";

const KRAKEN_INTERVAL: Record<string, number> = { "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440 };

/** Kraken calls BTC "XBT". */
function krakenPair(underlying: string): string {
  const u = underlying.toUpperCase();
  return `${u === "BTC" ? "XBT" : u}USD`;
}

type RawRow = [number, string, string, string, string, string, string, number]; // t(s),o,h,l,c,vwap,vol,count

export async function krakenOhlc(underlying: string, interval: string, startMs: number, endMs: number): Promise<Candle[]> {
  const iv = KRAKEN_INTERVAL[interval];
  if (!iv) throw new Error(`kraken does not support interval "${interval}"`);
  const url = `${KRAKEN_API}/0/public/OHLC?pair=${krakenPair(underlying)}&interval=${iv}&since=${Math.floor(startMs / 1000)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`kraken ohlc ${underlying} failed: ${res.status}`);
  const body = (await res.json()) as { error: string[]; result?: Record<string, RawRow[] | number> };
  if (body.error?.length) throw new Error(`kraken ohlc ${underlying} failed: ${body.error.join("; ")}`);
  const rows = Object.values(body.result ?? {}).find(Array.isArray) as RawRow[] | undefined;
  if (!rows) throw new Error(`kraken ohlc ${underlying}: empty response`);
  return rows
    .map((r) => ({ t: r[0] * 1000, o: r[1], h: r[2], l: r[3], c: r[4], v: r[6] }))
    .filter((c) => c.t >= startMs && c.t < endMs)
    .sort((a, b) => a.t - b.t);
}
