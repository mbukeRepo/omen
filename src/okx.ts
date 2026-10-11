import type { Candle } from "./binance.js";

/** Minimal OKX spot history-candles fetcher (public API, newest-first pages of 100). */

const OKX_API = process.env.OKX_API_URL ?? "https://www.okx.com";

/** Our interval strings -> OKX bar strings (UTC-anchored daily). */
const OKX_BAR: Record<string, string> = { "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1Dutc" };

export function okxInstId(underlying: string): string {
  return `${underlying.toUpperCase()}-USDT`;
}

type RawRow = [string, string, string, string, string, string, ...unknown[]]; // ts,o,h,l,c,vol,...

export async function okxCandles(
  instId: string,
  interval: string,
  startMs: number,
  endMs: number,
): Promise<Candle[]> {
  const bar = OKX_BAR[interval];
  if (!bar) throw new Error(`okx does not support interval "${interval}"`);
  const out: Candle[] = [];
  let after = endMs; // "after" pages backwards: returns rows strictly older than it
  for (let i = 0; i < 60; i++) {
    const url = `${OKX_API}/api/v5/market/history-candles?instId=${instId}&bar=${bar}&after=${after}&limit=100`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`okx candles ${instId} ${bar} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { code: string; msg: string; data: RawRow[] };
    if (body.code !== "0") throw new Error(`okx candles ${instId} ${bar} failed: ${body.code} ${body.msg}`);
    const rows = body.data;
    if (rows.length === 0) break;
    for (const r of rows) {
      const t = Number(r[0]);
      if (t >= startMs && t < endMs) out.push({ t, o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] });
    }
    const oldest = Number(rows[rows.length - 1]![0]);
    if (oldest <= startMs) break;
    after = oldest;
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}
