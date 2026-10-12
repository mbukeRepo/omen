import type { Candle } from "./binance.js";

/** KuCoin, Gate and MEXC spot candles — the remaining venues of Hyperliquid's oracle median. */

const KUCOIN_TYPE: Record<string, string> = { "5m": "5min", "15m": "15min", "1h": "1hour", "4h": "4hour", "1d": "1day" };
const MEXC_INTERVAL: Record<string, string> = { "5m": "5m", "15m": "15m", "1h": "60m", "4h": "4h", "1d": "1d" };
const BAR_MS: Record<string, number> = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };

function need<T>(map: Record<string, T>, interval: string, venue: string): T {
  const v = map[interval];
  if (v === undefined) throw new Error(`${venue} does not support interval "${interval}"`);
  return v;
}

async function getJson<T>(url: string, venue: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${venue} candles failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

/** KuCoin: rows are [time(s), open, close, high, low, volume, turnover], newest first, 1500 per call. */
export async function kucoinCandles(underlying: string, interval: string, startMs: number, endMs: number): Promise<Candle[]> {
  const type = need(KUCOIN_TYPE, interval, "kucoin");
  const span = BAR_MS[interval]! * 1500;
  const out: Candle[] = [];
  for (let to = endMs; to > startMs; to -= span) {
    const from = Math.max(startMs, to - span);
    const body = await getJson<{ code: string; msg?: string; data: string[][] }>(
      `https://api.kucoin.com/api/v1/market/candles?type=${type}&symbol=${underlying.toUpperCase()}-USDT&startAt=${Math.floor(from / 1000)}&endAt=${Math.floor(to / 1000)}`,
      "kucoin",
    );
    if (body.code !== "200000") throw new Error(`kucoin candles failed: ${body.code} ${body.msg ?? ""}`);
    for (const r of body.data) {
      out.push({ t: Number(r[0]) * 1000, o: r[1]!, c: r[2]!, h: r[3]!, l: r[4]!, v: r[5]! });
    }
  }
  return dedupe(out, startMs, endMs);
}

/** Gate: rows are [t(s), quote_vol, close, high, low, open, base_vol, closed], ascending, 1000 per call. */
export async function gateCandles(underlying: string, interval: string, startMs: number, endMs: number): Promise<Candle[]> {
  need(BAR_MS, interval, "gate");
  const span = BAR_MS[interval]! * 999;
  const out: Candle[] = [];
  for (let from = startMs; from < endMs; from += span) {
    const to = Math.min(endMs, from + span);
    const rows = await getJson<string[][]>(
      `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${underlying.toUpperCase()}_USDT&interval=${interval}&from=${Math.floor(from / 1000)}&to=${Math.floor(to / 1000)}`,
      "gate",
    );
    for (const r of rows) {
      out.push({ t: Number(r[0]) * 1000, c: r[2]!, h: r[3]!, l: r[4]!, o: r[5]!, v: r[6]! });
    }
  }
  return dedupe(out, startMs, endMs);
}

/** MEXC: Binance-shaped rows, but 1h is spelled "60m". */
export async function mexcCandles(underlying: string, interval: string, startMs: number, endMs: number): Promise<Candle[]> {
  const iv = need(MEXC_INTERVAL, interval, "mexc");
  const out: Candle[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const rows = await getJson<[number, string, string, string, string, string][]>(
      `https://api.mexc.com/api/v3/klines?symbol=${underlying.toUpperCase()}USDT&interval=${iv}&startTime=${cursor}&endTime=${endMs}&limit=500`,
      "mexc",
    );
    if (rows.length === 0) break;
    for (const r of rows) out.push({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] });
    const last = rows[rows.length - 1]![0];
    if (last <= cursor || rows.length < 500) break;
    cursor = last + 1;
  }
  return dedupe(out, startMs, endMs);
}

function dedupe(rows: Candle[], startMs: number, endMs: number): Candle[] {
  const byT = new Map<number, Candle>();
  for (const r of rows) if (r.t >= startMs && r.t < endMs) byT.set(r.t, r);
  return [...byT.values()].sort((a, b) => a.t - b.t);
}
