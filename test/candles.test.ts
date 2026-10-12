import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, weightedMedian } from "../src/candles.js";

test("weighted median follows Hyperliquid's oracle weighting", () => {
  // Binance (3) alone can't outvote OKX (2) + Bybit (2) + four 1-weight venues.
  const pts = [
    { value: 100, weight: 3 },
    { value: 101, weight: 2 },
    { value: 101, weight: 2 },
    { value: 102, weight: 1 },
    { value: 102, weight: 1 },
    { value: 102, weight: 1 },
    { value: 102, weight: 1 },
  ];
  assert.equal(weightedMedian(pts), 101);
  assert.equal(weightedMedian([{ value: 5, weight: 1 }]), 5);
});

const H = 3_600_000;
const bar = (t: number, o: number, h: number, l: number, c: number, v: number) => ({
  t,
  o: String(o),
  h: String(h),
  l: String(l),
  c: String(c),
  v: String(v),
});

test("1h bars aggregate into UTC-aligned 4h OHLCV", () => {
  const hourly = [
    bar(0, 10, 12, 9, 11, 1),
    bar(H, 11, 15, 10, 14, 2),
    bar(2 * H, 14, 14, 8, 9, 3),
    bar(3 * H, 9, 10, 7, 10, 4),
    bar(4 * H, 10, 11, 10, 11, 5),
  ];
  const out = aggregate(hourly, 4 * H);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { t: 0, o: "10", h: "15", l: "7", c: "10", v: "10" });
  assert.deepEqual(out[1], { t: 4 * H, o: "10", h: "11", l: "10", c: "11", v: "5" });
});
