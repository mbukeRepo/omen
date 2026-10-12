import { test } from "node:test";
import assert from "node:assert/strict";
import { fillGaps, replay, type RecordedTick, type SimOptions } from "../src/sim.js";

const T0 = Date.UTC(2026, 9, 12, 7, 0);
const markets = [
  {
    outcome: 7,
    name: "x",
    description: "class:priceBinary|underlying:ETH|targetPrice:2564.1|expiry:20261013-0600|period:1d",
  },
];
const opts: SimOptions = {
  dipPct: 5,
  takePct: 5,
  stopPct: null,
  windowMins: 60,
  tickSecs: 5,
  modelRefreshMins: 60,
  usdPerTrade: 20,
  maxOpen: 3,
  maxLossUsd: 60,
  minHoursToExpiry: 2,
  gate: "fair",
  minEdge: 0,
};

/** A minute-by-minute path of YES mids (1-tick spread) and ETH spots. */
function path(points: [yes: number, spot: number][]): RecordedTick[] {
  return points.map(([yes, spot], i) => ({
    t: T0 + i * 60_000,
    tokens: {
      "#70": { mid: yes, bid: yes - 0.005, ask: yes + 0.005 },
      "#71": { mid: 1 - yes, bid: 1 - yes - 0.005, ask: 1 - yes + 0.005 },
    },
    spot: { ETH: spot },
  }));
}

const flat = 2564.1;

test("overreaction: the token dumps with spot flat and recovers — the fair gate buys and profits", async () => {
  const ticks = path([[0.5, flat], [0.5, flat], [0.44, flat], [0.44, flat], [0.48, flat], [0.5, flat], [0.5, flat]]);
  const r = await replay(ticks, markets, opts, { ETH: 0.005 });
  assert.equal(r.trades, 1);
  assert.ok(r.realized > 0, `realized ${r.realized}`);
});

test("repricing: spot drops 2% and the token follows — fair skips, the ungated bot buys and loses", async () => {
  const down = 2512.8;
  const ticks = path([[0.5, flat], [0.5, flat], [0.3, down], [0.28, down], [0.27, down], [0.27, down]]);
  const fair = await replay(ticks, markets, opts, { ETH: 0.005 });
  assert.equal(fair.trades + fair.state.positions.length, 0, "fair gate stays out");
  const none = await replay(ticks, markets, { ...opts, gate: "none" }, { ETH: 0.005 });
  assert.equal(none.state.positions.length, 1, "ungated bot buys the dip");
  assert.ok(none.unrealized < 0, `unrealized ${none.unrealized}`);
});

test("replays are deterministic", async () => {
  const ticks = path([[0.5, flat], [0.44, flat], [0.5, flat]]);
  const a = await replay(ticks, markets, opts, { ETH: 0.005 });
  const b = await replay(ticks, markets, opts, { ETH: 0.005 });
  assert.equal(a.realized, b.realized);
  assert.equal(a.trades, b.trades);
});

test("fillGaps bridges recording gaps but keeps a token's final disappearance", () => {
  const tok = (mid: number) => ({ mid, bid: mid - 0.005, ask: mid + 0.005 });
  const filled = fillGaps([
    { t: 1, tokens: { "#70": tok(0.5), "#80": tok(0.9) }, spot: { ETH: 1 } },
    { t: 2, tokens: { "#80": tok(0.91) }, spot: {} }, // #70 missing mid-window
    { t: 3, tokens: { "#70": tok(0.52) }, spot: { ETH: 2 } }, // #80 gone for good
  ]);
  assert.equal(filled[1]!.tokens["#70"]!.mid, 0.5, "gap filled from the previous tick");
  assert.equal(filled[1]!.spot.ETH, 1, "spot carried forward");
  assert.equal(filled[2]!.tokens["#80"], undefined, "final disappearance kept");
});
