/** Minimal Binance spot klines fetcher (public API, paginated at 1000 bars/call). */

export interface Candle {
  t: number; // open time ms
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}

const BINANCE_API = process.env.BINANCE_API_URL ?? "https://api.binance.com";

/** Map a HIP-4 underlying ("BTC") to the Binance spot symbol. */
export function binanceSymbol(underlying: string): string {
  return `${underlying.toUpperCase()}USDT`;
}

type RawKline = [number, string, string, string, string, string, ...unknown[]];

export async function binanceKlines(
  symbol: string,
  interval: string,
  startMs: number,
  endMs: number,
): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `${BINANCE_API}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`binance klines ${symbol} ${interval} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const rows = (await res.json()) as RawKline[];
    if (rows.length === 0) break;
    for (const r of rows) out.push({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] });
    const lastOpen = rows[rows.length - 1]![0];
    if (lastOpen <= cursor) break; // safety against stalling
    cursor = lastOpen + 1;
    if (rows.length < 1000) break;
  }
  return out;
}
