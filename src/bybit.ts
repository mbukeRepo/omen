import type { Candle } from "./binance.js";

/** Minimal Bybit spot kline fetcher (public v5 API, newest-first pages of 1000). */

const BYBIT_API = process.env.BYBIT_API_URL ?? "https://api.bybit.com";

const BYBIT_INTERVAL: Record<string, string> = { "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D" };

type RawRow = [string, string, string, string, string, string, string]; // start,o,h,l,c,vol,turnover

export async function bybitKlines(symbol: string, interval: string, startMs: number, endMs: number): Promise<Candle[]> {
  const iv = BYBIT_INTERVAL[interval];
  if (!iv) throw new Error(`bybit does not support interval "${interval}"`);
  const out: Candle[] = [];
  let end = endMs;
  for (let i = 0; i < 40; i++) {
    const url = `${BYBIT_API}/v5/market/kline?category=spot&symbol=${symbol}&interval=${iv}&start=${startMs}&end=${end}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`bybit kline ${symbol} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { retCode: number; retMsg: string; result?: { list?: RawRow[] } };
    if (body.retCode !== 0) throw new Error(`bybit kline ${symbol} failed: ${body.retCode} ${body.retMsg}`);
    const rows = body.result?.list ?? []; // newest first
    if (rows.length === 0) break;
    for (const r of rows) {
      const t = Number(r[0]);
      if (t >= startMs && t < endMs) out.push({ t, o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] });
    }
    const oldest = Number(rows[rows.length - 1]![0]);
    if (oldest <= startMs || rows.length < 1000) break;
    end = oldest - 1;
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}
