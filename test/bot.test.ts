import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot, paperExecutor, type BotOptions } from "../src/bot.js";
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
function harness(over: Partial<BotOptions> = {}) {
  let now = T0;
  let yes: number | null = 0.5;
  const sent: string[] = [];
  const book = (mid: number): Book => ({
    bids: [{ px: mid - 0.005, sz: 1000 }],
    asks: [{ px: mid + 0.005, sz: 1000 }],
    ts: now,
  });
  const bot = new Bot(
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
      useModel: true,
      minEdge: 0,
      statePath: join(mkdtempSync(join(tmpdir(), "hip4-bot-")), "state.json"),
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
      },
      executor: paperExecutor(),
      forecast: () => new Promise<number>(() => {}), // model values are injected via setModel
      notify: (t) => sent.push(t),
      now: () => now,
    },
  );
  return {
    bot,
    sent,
    setYes: (v: number | null) => (yes = v),
    advance: (mins: number) => (now += mins * 60_000),
  };
}

test("buys a model-approved dip and sells it at +5%", async () => {
  const h = harness();
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
  const h = harness();
  h.bot.setModel(7, 0.3); // model thinks YES is worth 0.30, below the 0.475 ask
  await h.bot.tick();
  h.setYes(0.47);
  h.advance(1);
  await h.bot.tick();
  assert.equal(h.bot.state.positions.length, 0);
});

test("a NO dip (YES spike) buys NO when the model agrees", async () => {
  const h = harness();
  h.bot.setModel(7, 0.4); // P(NO) = 0.6
  await h.bot.tick(); // NO = 0.50
  h.setYes(0.53); // NO 0.47: -6%
  h.advance(1);
  await h.bot.tick();
  assert.equal(h.bot.state.positions[0]?.side, 1);
});

test("no entries without a fresh model value", async () => {
  const h = harness();
  await h.bot.tick();
  h.setYes(0.47);
  h.advance(1);
  await h.bot.tick();
  assert.equal(h.bot.state.positions.length, 0);
});

test("--no-model trades the raw dip", async () => {
  const h = harness({ useModel: false });
  await h.bot.tick();
  h.setYes(0.47);
  h.advance(1);
  await h.bot.tick();
  assert.equal(h.bot.state.positions.length, 1);
});

test("a dip older than the window no longer counts", async () => {
  const h = harness();
  h.bot.setModel(7, 0.6);
  await h.bot.tick(); // high 0.50
  h.advance(61); // the 0.50 print leaves the 60m window
  h.setYes(0.47);
  await h.bot.tick();
  assert.equal(h.bot.state.positions.length, 0);
});

test("open positions settle at 1/0 when the market resolves", async () => {
  const h2 = harness({ useModel: false, takePct: 500 }); // take profit out of reach: hold to resolution
  await h2.bot.tick();
  h2.setYes(0.47);
  h2.advance(1);
  await h2.bot.tick();
  h2.setYes(0.98);
  h2.advance(1);
  await h2.bot.tick(); // last mid 0.98
  h2.setYes(null); // market stops quoting
  h2.advance(1);
  await h2.bot.tick();
  const t = h2.bot.state.closed[0]!;
  assert.equal(t.reason, "resolved");
  assert.equal(t.exitPx, 1);
});

test("stop-loss exits and the max-loss breaker halts new entries", async () => {
  const h = harness({ useModel: false, stopPct: 10, maxLossUsd: 1 });
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

test("state persists to disk and a paper state refuses to load in live mode", async () => {
  const h = harness({ useModel: false });
  await h.bot.tick();
  h.setYes(0.47);
  h.advance(1);
  await h.bot.tick();
  const path = (h.bot as any).opts.statePath as string;
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(saved.mode, "paper");
  assert.equal(saved.positions.length, 1);
  assert.throws(
    () =>
      new Bot((h.bot as any).opts, {
        info: {} as any,
        executor: { mode: "live", buy: async () => ({}) as any, sell: async () => ({}) as any },
        forecast: async () => 0.5,
        notify: () => {},
      }),
    /holds paper state/,
  );
});
