import { Bot, paperExecutor, type BotOptions } from "./bot.js";
import { MemoryStore, type BotState, type MarketMeta } from "./store.js";
import type { Book, OutcomeMeta } from "./hyperliquid.js";

/** One recorded moment: token prices with top of book, plus oracle spots. */
export interface RecordedTick {
  t: number;
  tokens: Record<string, { mid: number; bid: number | null; ask: number | null }>;
  spot: Record<string, number>;
}

/**
 * Carry each token's last values across ticks where it wasn't recorded, as
 * long as it shows up again later: a recording gap is not a resolution. After
 * a token's final appearance it stays absent, so real resolutions replay.
 */
export function fillGaps(ticks: RecordedTick[]): RecordedTick[] {
  const lastSeen = new Map<string, number>();
  for (const t of ticks) for (const coin of Object.keys(t.tokens)) lastSeen.set(coin, t.t);
  const prev: RecordedTick["tokens"] = {};
  let prevSpot: Record<string, number> = {};
  return ticks.map((t) => {
    const tokens = { ...t.tokens };
    for (const [coin, v] of Object.entries(prev)) {
      if (tokens[coin] === undefined && lastSeen.get(coin)! > t.t) tokens[coin] = v;
    }
    Object.assign(prev, tokens);
    const spot = { ...prevSpot, ...t.spot };
    prevSpot = spot;
    return { t: t.t, tokens, spot };
  });
}

export type SimOptions = Omit<BotOptions, "recordTicks" | "indices" | "slugs" | "patterns" | "gate"> & {
  gate: "fair" | "none";
};

export interface SimResult {
  state: BotState;
  realized: number;
  /** Open positions marked at the last recorded bid: what selling now would fetch. */
  unrealized: number;
  trades: number;
  wins: number;
}

/**
 * Replay recorded ticks through the bot's own logic with a simulated clock.
 * Fills happen at the recorded best ask (buys) and bid (sells) with unlimited
 * size, so results are optimistic for sizes larger than the top level.
 */
export async function replay(
  ticks: RecordedTick[],
  markets: MarketMeta[],
  opts: SimOptions,
  vols: Record<string, number>,
): Promise<SimResult> {
  if (ticks.length === 0) throw new Error("no ticks to replay");
  let i = 0;
  const cur = () => ticks[i]!;
  const meta: OutcomeMeta = {
    outcomes: markets.map((m) => ({ outcome: m.outcome, name: m.name, description: m.description, sideSpecs: [] })),
    questions: [],
  };
  const store = new MemoryStore();
  const bot = await Bot.create(
    { ...opts, recordTicks: false, indices: markets.map((m) => m.outcome), slugs: [], patterns: [] },
    {
      info: {
        outcomeMeta: async () => meta,
        allMids: async () => Object.fromEntries(Object.entries(cur().tokens).map(([c, v]) => [c, String(v.mid)])),
        l2Book: async (coin): Promise<Book> => {
          const tok = cur().tokens[coin];
          return {
            bids: tok?.bid != null ? [{ px: tok.bid, sz: 1e9 }] : [],
            asks: tok?.ask != null ? [{ px: tok.ask, sz: 1e9 }] : [],
            ts: cur().t,
          };
        },
        oraclePrices: async () => Object.fromEntries(Object.entries(cur().spot).map(([u, px]) => [u.toUpperCase(), px])),
      },
      executor: paperExecutor(),
      forecast: () => Promise.reject(new Error("kronos gate is not replayable")),
      vol: async (u) => {
        const v = vols[u];
        if (v === undefined) throw new Error(`no vol for ${u}`);
        return v;
      },
      store,
      notify: () => {},
      now: () => cur().t,
    },
  );
  // Silence the bot's per-event console lines during replays.
  const log = console.log;
  console.log = () => {};
  try {
    for (i = 0; i < ticks.length; i++) {
      await bot.tick();
      // Let background vol fetches resolve before the next tick.
      await new Promise((r) => setImmediate(r));
    }
  } finally {
    console.log = log;
  }
  i = ticks.length - 1;
  const last = cur();
  const unrealized = bot.state.positions.reduce((a, p) => {
    const tok = last.tokens[`#${10 * p.outcome + p.side}`];
    const mark = tok?.bid ?? tok?.mid ?? p.entryPx;
    return a + (mark - p.entryPx) * p.sz;
  }, 0);
  return {
    state: bot.state,
    realized: bot.realizedPnl(),
    unrealized,
    trades: bot.state.closed.length,
    wins: bot.state.closed.filter((t) => t.pnl > 0).length,
  };
}
