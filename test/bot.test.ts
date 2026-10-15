import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot, paperExecutor, type BotOptions } from "../src/bot.js";
import { FileStore } from "../src/store.js";
import type { Book, OutcomeMeta } from "../src/hyperliquid.js";

const T0 = Date.UTC(2026, 9, 12, 6, 0);
const meta: OutcomeMeta = {
  outcomes: [
    {
      outcome: 7,
      name: "x",
      description: "class:priceBinary|underlying:ETH|targetPrice:2564.1|expiry:20261013-0600|period:1d",
      sideSpecs: [],
    },
  ],
  questions: [],
};

/** A market whose YES token trades at `mid` with a 1-tick spread; NO mirrors it. */
async function harness(over: Partial<BotOptions> = {}) {
  let now = T0;
  let yes: number | null = 0.5;
  let spot = 2564.1;
  const sent: string[] = [];
  const book = (mid: number): Book => ({
    bids: [{ px: mid - 0.005, sz: 1000 }],
    asks: [{ px: mid + 0.005, sz: 1000 }],
    ts: now,
  });
  const statePath = join(mkdtempSync(join(tmpdir(), "hip4-bot-")), "state.json");
  const bot = await Bot.create(
    {
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
      gate: "kronos",
      minEdge: 0,
      snipeEdge: null,
      recordTicks: false,
      indices: [7],
      slugs: [],
      patterns: [],
      ...over,
    },
    {
      info: {
        outcomeMeta: async () => meta,
        allMids: async (): Promise<Record<string, string>> =>
          yes === null ? {} : { "#70": String(yes), "#71": String(1 - yes) },
        l2Book: async (coin: string) => book(coin === "#70" ? yes! : 1 - yes!),
        oraclePrices: async () => ({ ETH: spot }),
      },
      executor: paperExecutor(),
      // Gate inputs are injected via setModel / setVol; these never resolve.
      forecast: () => new Promise<number>(() => {}),
      vol: () => new Promise<number>(() => {}),
      store: new FileStore(statePath, null),
      notify: (t) => sent.push(t),
      now: () => now,
    },
  );
  return {
    bot,
    sent,
    statePath,
    setYes: (v: number | null) => (yes = v),
    setSpot: (v: number) => (spot = v),
    advance: (mins: number) => (now += mins * 60_000),
  };
}

test("buys a model-approved dip and sells it at +5%", async () => {
  const h = await harness();
  h.bot.setModel(7, 0.6);
  await h.bot.tick(); // YES 0.50 sets the rolling high
  h.setYes(0.47); // -6% from the high
  h.advance(1);
  await h.bot.tick();
  assert.equal(h.bot.state.positions.length, 1);
  const pos = h.bot.state.positions[0]!;
  assert.equal(pos.side, 0);
  assert.ok(Math.abs(pos.entryPx - 0.475) < 1e-9, "fills at the ask");
  assert.equal(pos.sz, Math.floor(20 / 0.475));

  h.setYes(0.5); // bid 0.495: +4.2%, not yet
  h.advance(1);
  await h.bot.tick();
  assert.equal(h.bot.state.positions.length, 1);

  h.setYes(0.505); // bid 0.50: +5.3%, take profit
  h.advance(1);
  await h.bot.tick();
  assert.equal(h.bot.state.positions.length, 0);
  const trade = h.bot.state.closed[0]!;
  assert.equal(trade.reason, "take");
  assert.ok(trade.pnl > 0);
  assert.match(h.sent.at(-1)!, /SELL .* \(take\)|💰/);
});

test("the model gate vetoes a dip it doesn't value", async () => {
  const h = await harness();
  h.bot.setModel(7, 0.3); // model thinks YES is worth 0.30, below the 0.475 ask
  await h.bot.tick();
  h.setYes(0.47);
  h.advance(1);
  await h.bot.tick();
  assert.equal(h.bot.state.positions.length, 0);
});

test("a NO dip (YES spike) buys NO when the model agrees", async () => {
  const h = await harness();
  h.bot.setModel(7, 0.4); // P(NO) = 0.6
  await h.bot.tick(); // NO = 0.50
  h.setYes(0.53); // NO 0.47: -6%
  h.advance(1);
  await h.bot.tick();
  assert.equal(h.bot.state.positions[0]?.side, 1);
});

test("no entries without a fresh model value", async () => {
  const h = await harness();
  await h.bot.tick();
  h.setYes(0.47);
  h.advance(1);
  await h.bot.tick();
  assert.equal(h.bot.state.positions.length, 0);
});

test("--no-model trades the raw dip", async () => {
  const h = await harness({ gate: "none" });
  await h.bot.tick();
  h.setYes(0.47);
  h.advance(1);
  await h.bot.tick();
  assert.equal(h.bot.state.positions.length, 1);
});

test("a dip older than the window no longer counts", async () => {
  const h = await harness();
  h.bot.setModel(7, 0.6);
  await h.bot.tick(); // high 0.50
  h.advance(61); // the 0.50 print leaves the 60m window
  h.setYes(0.47);
  await h.bot.tick();
  assert.equal(h.bot.state.positions.length, 0);
});

test("open positions settle at 1/0 when the market resolves", async () => {
  const h2 = await harness({ gate: "none", takePct: 500 }); // take profit out of reach: hold to resolution
  await h2.bot.tick();
  h2.setYes(0.47);
  h2.advance(1);
  await h2.bot.tick();
  h2.setYes(0.98);
  h2.advance(1);
  await h2.bot.tick(); // last mid 0.98
  h2.setYes(null); // quote missing before expiry: a data gap, keep holding
  h2.advance(1);
  await h2.bot.tick();
  assert.equal(h2.bot.state.positions.length, 1, "no settlement before expiry");
  h2.advance(24 * 60); // past the 06:00 expiry, still no quote: resolved
  await h2.bot.tick();
  const t = h2.bot.state.closed[0]!;
  assert.equal(t.reason, "resolved");
  assert.equal(t.exitPx, 1);
});

test("stop-loss exits and the max-loss breaker halts new entries", async () => {
  const h = await harness({ gate: "none", stopPct: 10, maxLossUsd: 1 });
  await h.bot.tick();
  h.setYes(0.47);
  h.advance(1);
  await h.bot.tick(); // buy at 0.475
  h.setYes(0.42); // bid 0.415: -12.6%
  h.advance(1);
  await h.bot.tick();
  assert.equal(h.bot.state.closed[0]?.reason, "stop");
  assert.ok(h.bot.realizedPnl() < -1);
  assert.ok(h.sent.some((t) => t.includes("max loss")));

  h.advance(120); // past the cooldown, new dip
  h.setYes(0.5);
  await h.bot.tick();
  h.setYes(0.45);
  h.advance(1);
  await h.bot.tick();
  assert.equal(h.bot.state.positions.length, 0, "halted bot opens nothing");
});

test("state persists through the file store and a paper state refuses to load in live mode", async () => {
  const h = await harness({ gate: "none" });
  await h.bot.tick();
  h.setYes(0.47);
  h.advance(1);
  await h.bot.tick();
  const saved = JSON.parse(readFileSync(h.statePath, "utf8"));
  assert.equal(saved.mode, "paper");
  assert.equal(saved.positions.length, 1);
  assert.ok(saved.positions[0].id, "positions carry ids");
  await assert.rejects(new FileStore(h.statePath, null).load("live"), /holds paper state/);
});

test("fair gate buys a dip that spot doesn't justify (overreaction)", async () => {
  const h = await harness({ gate: "fair" });
  h.bot.setVol("ETH", 0.005); // 0.5% per hour
  await h.bot.tick(); // spot at the strike, 24h left: fair YES ≈ 0.495
  h.setYes(0.43); // token dumps, spot unchanged
  h.advance(1);
  await h.bot.tick();
  assert.equal(h.bot.state.positions.length, 1);
  assert.ok(h.bot.state.positions[0]!.modelP! > 0.48);
});

test("fair gate skips a dip that is just the market following spot", async () => {
  const h = await harness({ gate: "fair" });
  h.bot.setVol("ETH", 0.005);
  await h.bot.tick();
  h.setSpot(2512.8); // spot -2%: fair YES ≈ 0.20
  h.setYes(0.43);
  h.advance(1);
  await h.bot.tick();
  assert.equal(h.bot.state.positions.length, 0);
});

test("fair gate waits for a volatility estimate", async () => {
  const h = await harness({ gate: "fair" });
  await h.bot.tick();
  h.setYes(0.43);
  h.advance(1);
  await h.bot.tick();
  assert.equal(h.bot.state.positions.length, 0);
});

test("snipe mode buys a stale quote below the gate value, no dip required", async () => {
  const h = await harness({ gate: "fair", snipeEdge: 0.05 });
  h.bot.setVol("ETH", 0.005);
  h.setSpot(2620); // spot jumped: fair YES ≈ 0.93, but the book still quotes 0.50
  await h.bot.tick();
  assert.equal(h.bot.state.positions.length, 1);
  assert.equal(h.bot.state.positions[0]!.side, 0);
  assert.match(h.sent.at(-1)!, /SNIPE/);
});

test("snipe stays quiet when quotes track fair value", async () => {
  const h = await harness({ gate: "fair", snipeEdge: 0.05 });
  h.bot.setVol("ETH", 0.005);
  await h.bot.tick(); // spot at strike, fair ≈ 0.49, mid 0.50 — no gap
  assert.equal(h.bot.state.positions.length, 0);
});
