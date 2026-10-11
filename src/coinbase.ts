import type { Candle } from "./binance.js";
import { aggregate } from "./candles.js";

/**
 * Minimal Coinbase Exchange candles fetcher (public API, 300 bars/page).
 * Coinbase has no native 4h granularity, so 4h is aggregated from 1h bars.
 */

const COINBASE_API = process.env.COINBASE_API_URL ?? "https://api.exchange.coinbase.com";

const GRANULARITY: Record<string, number> = { "5m": 300, "15m": 900, "1h": 3600, "1d": 86400 };

type RawRow = [number, number, number, number, number, number]; // time(s), low, high, open, close, volume

async function fetchRange(product: string, granularity: number, startMs: number, endMs: number): Promise<Candle[]> {
  const out: Candle[] = [];
  const spanMs = granularity * 1000;
  let cursor = startMs;
  while (cursor < endMs) {
    const chunkEnd = Math.min(cursor + spanMs * 300, endMs);
    const url = `${COINBASE_API}/products/${product}/candles?granularity=${granularity}&start=${new Date(cursor).toISOString()}&end=${new Date(chunkEnd).toISOString()}`;
    const res = await fetch(url, { headers: { "User-Agent": "hip4-cli" } });
    if (!res.ok) throw new Error(`coinbase candles ${product} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const rows = (await res.json()) as RawRow[]; // newest first
    for (const r of rows) {
      const t = r[0] * 1000;
      if (t >= startMs && t < endMs) out.push({ t, o: String(r[3]), h: String(r[2]), l: String(r[1]), c: String(r[4]), v: String(r[5]) });
    }
    cursor = chunkEnd;
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

export async function coinbaseCandles(product: string, interval: string, startMs: number, endMs: number): Promise<Candle[]> {
  if (interval === "4h") {
    const hourly = await fetchRange(product, 3600, Math.floor(startMs / 14_400_000) * 14_400_000, endMs);
    return aggregate(hourly, 14_400_000);
  }
  const g = GRANULARITY[interval];
  if (!g) throw new Error(`coinbase does not support interval "${interval}"`);
  return fetchRange(product, g, startMs, endMs);
}
