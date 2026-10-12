import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { ExchangeClient } from "@nktkas/hyperliquid";
import {
  NO,
  YES,
  describeOutcome,
  encodeAssetId,
  encodeCoin,
  priceBinaryFields,
  sideName,
  type Book,
  type BookLevel,
  type HyperliquidInfo,
  type OutcomeMeta,
  type Side,
} from "./hyperliquid.js";
import { marketUrl, resolveSlug, type SlugSpec } from "./watch.js";

/*
 * Real-time dip-buy / take-profit bot for HIP-4 outcome tokens.
 *
 * Every tick (seconds): read all mids in one call, track each YES/NO token's
 * rolling high over the window, and buy a token whose mid has fallen dipPct
 * below that high, but only if Kronos values the token at or above the ask
 * (the model gate). Open positions are sold as soon as the bid reaches
 * entry * (1 + takePct), or on the optional stop. Unsold tokens settle at 1/0
 * when the market resolves. Kronos refreshes in the background so model runs
 * never stall the price loop.
 */

export interface Fill {
  filledSz: number;
  avgPx: number;
  oid: string | null;
  error?: string;
}

export interface Executor {
  mode: "paper" | "live";
  buy(outcome: number, side: Side, limitPx: number, sz: number, book: Book): Promise<Fill>;
  sell(outcome: number, side: Side, limitPx: number, sz: number, book: Book): Promise<Fill>;
}

function walk(levels: BookLevel[], sz: number, ok: (px: number) => boolean): Fill {
  let left = sz;
  let cost = 0;
  for (const l of levels) {
    if (!ok(l.px) || left <= 0) break;
    const take = Math.min(left, l.sz);
    cost += take * l.px;
    left -= take;
  }
  const filled = sz - left;
  return filled > 0 ? { filledSz: filled, avgPx: cost / filled, oid: `paper-${Date.now()}` } : { filledSz: 0, avgPx: 0, oid: null, error: "no liquidity at limit" };
}

/** Simulated IOC fills against the live order book snapshot. */
export function paperExecutor(): Executor {
  return {
    mode: "paper",
    buy: async (_o, _s, limitPx, sz, book) => walk(book.asks, sz, (px) => px <= limitPx),
    sell: async (_o, _s, limitPx, sz, book) => walk(book.bids, sz, (px) => px >= limitPx),
  };
}

/** Hyperliquid prices allow 5 significant figures. */
const fmtPx = (px: number) => String(Number(px.toPrecision(5)));

/** Real IOC limit orders through the exchange client (agent or master signer). */
export function liveExecutor(exchange: ExchangeClient): Executor {
  const send = async (outcome: number, side: Side, isBuy: boolean, limitPx: number, sz: number): Promise<Fill> => {
    try {
      const res = await exchange.order({
        orders: [{ a: encodeAssetId(outcome, side), b: isBuy, p: fmtPx(limitPx), s: String(sz), r: false, t: { limit: { tif: "Ioc" } } }],
        grouping: "na",
      });
      const st = res.response?.data?.statuses?.[0] as
        | { filled?: { oid: number; avgPx: string; totalSz: string }; error?: string }
        | undefined;
      if (st?.filled) return { filledSz: Number(st.filled.totalSz), avgPx: Number(st.filled.avgPx), oid: String(st.filled.oid) };
      return { filledSz: 0, avgPx: 0, oid: null, error: st?.error ?? "IOC expired unfilled" };
    } catch (err) {
      return { filledSz: 0, avgPx: 0, oid: null, error: String(err).slice(0, 300) };
    }
  };
  return {
    mode: "live",
    buy: (o, s, px, sz) => send(o, s, true, px, sz),
    sell: (o, s, px, sz) => send(o, s, false, px, sz),
  };
}

export interface BotOptions {
  dipPct: number;
  takePct: number;
  stopPct: number | null;
  windowMins: number;
  tickSecs: number;
  modelRefreshMins: number;
  usdPerTrade: number;
  maxOpen: number;
  maxLossUsd: number;
  minHoursToExpiry: number;
  useModel: boolean;
  /** Model probability must exceed the ask by at least this (probability points, 0-1). */
  minEdge: number;
  statePath: string;
  indices: number[];
  slugs: SlugSpec[];
  patterns: string[];
}

export interface OpenPosition {
  outcome: number;
  side: Side;
  label: string;
  sz: number;
  entryPx: number;
  openedAt: number;
  modelP: number | null;
}

export interface ClosedTrade extends OpenPosition {
  exitPx: number;
  closedAt: number;
  reason: "take" | "stop" | "resolved";
  pnl: number;
}

export interface BotState {
  mode: "paper" | "live";
  positions: OpenPosition[];
  closed: ClosedTrade[];
}

interface Market {
  outcome: number;
  label: string;
  url: string | null;
  fields: { underlying: string; threshold: number; expiryMs: number } | null;
}

export interface BotDeps {
  info: Pick<HyperliquidInfo, "allMids" | "l2Book" | "outcomeMeta">;
  executor: Executor;
  /** Model P(YES) for a price binary; called in the background. */
  forecast: (fields: { underlying: string; threshold: number; expiryMs: number }) => Promise<number>;
  notify: (text: string) => void;
  now?: () => number;
}

const META_REFRESH_MS = 10 * 60_000;
const HEARTBEAT_MS = 60 * 60_000;

export class Bot {
  readonly state: BotState;
  private markets = new Map<number, Market>();
  private history = new Map<string, { t: number; mid: number }[]>();
  private lastMid = new Map<string, number>();
  private model = new Map<number, { pYes: number; at: number }>();
  private modelQueue: number[] = [];
  private modelBusy = false;
  private lastExit = new Map<string, number>();
  private lastSkip = new Map<string, string>();
  private lastMetaFetch = 0;
  private lastHeartbeat: number;
  private halted = false;
  private readonly now: () => number;

  constructor(
    private readonly opts: BotOptions,
    private readonly deps: BotDeps,
  ) {
    this.now = deps.now ?? Date.now;
    this.lastHeartbeat = this.now();
    this.state = this.loadState();
  }

  private loadState(): BotState {
    if (existsSync(this.opts.statePath)) {
      const s = JSON.parse(readFileSync(this.opts.statePath, "utf8")) as BotState;
      if (s.mode !== this.deps.executor.mode) {
        throw new Error(`${this.opts.statePath} holds ${s.mode} state but the bot is running ${this.deps.executor.mode} — use a different --state file`);
      }
      return s;
    }
    return { mode: this.deps.executor.mode, positions: [], closed: [] };
  }

  private saveState(): void {
    const tmp = `${this.opts.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.opts.statePath);
  }

  private tag(): string {
    return this.deps.executor.mode === "paper" ? "🤖 bot [paper]" : "🤖 bot [LIVE]";
  }

  realizedPnl(): number {
    return this.state.closed.reduce((a, t) => a + t.pnl, 0);
  }

  // ---------- markets ----------

  async refreshMarkets(): Promise<void> {
    const meta: OutcomeMeta = await this.deps.info.outcomeMeta();
    this.lastMetaFetch = this.now();
    const wanted = new Set<number>(this.opts.indices);
    for (const s of this.opts.slugs) {
      const o = resolveSlug(meta, s);
      if (o !== null) wanted.add(o);
    }
    for (const o of meta.outcomes) {
      const hay = `${describeOutcome(o, meta.questions)} ${o.name} ${o.description}`.toLowerCase();
      if (this.opts.patterns.some((p) => hay.includes(p))) wanted.add(o.outcome);
    }
    for (const p of this.state.positions) wanted.add(p.outcome);
    for (const outcome of wanted) {
      if (this.markets.has(outcome)) continue;
      const o = meta.outcomes.find((x) => x.outcome === outcome);
      if (!o) continue;
      const fields = priceBinaryFields(o);
      if (!fields && this.opts.useModel) {
        this.log(`#${outcome} is not a price binary — the model gate can't price it, skipping (use --no-model to trade it)`);
        continue;
      }
      this.markets.set(outcome, { outcome, label: describeOutcome(o, meta.questions), url: marketUrl(o), fields });
    }
    for (const [outcome, m] of this.markets) {
      const expired = m.fields !== null && m.fields.expiryMs < this.now();
      if (expired && !this.state.positions.some((p) => p.outcome === outcome)) {
        this.markets.delete(outcome);
        this.model.delete(outcome);
      }
    }
  }

  marketList(): Market[] {
    return [...this.markets.values()];
  }

  // ---------- model ----------

  private scheduleModels(): void {
    if (!this.opts.useModel) return;
    const staleMs = this.opts.modelRefreshMins * 60_000;
    for (const m of this.markets.values()) {
      if (!m.fields || m.fields.expiryMs <= this.now()) continue;
      const cached = this.model.get(m.outcome);
      if ((!cached || this.now() - cached.at > staleMs) && !this.modelQueue.includes(m.outcome)) this.modelQueue.push(m.outcome);
    }
    void this.drainModels();
  }

  private async drainModels(): Promise<void> {
    if (this.modelBusy) return;
    this.modelBusy = true;
    try {
      while (this.modelQueue.length > 0) {
        const outcome = this.modelQueue.shift()!;
        const m = this.markets.get(outcome);
        if (!m?.fields) continue;
        try {
          const pYes = await this.deps.forecast(m.fields);
          this.model.set(outcome, { pYes, at: this.now() });
          this.log(`model #${outcome} ${m.label}: P(YES) ${pYes.toFixed(3)}`);
        } catch (err) {
          this.log(`model #${outcome} failed: ${String(err).slice(0, 200)}`);
        }
      }
    } finally {
      this.modelBusy = false;
    }
  }

  /** Inject a model value directly (tests, or a precomputed forecast). */
  setModel(outcome: number, pYes: number): void {
    this.model.set(outcome, { pYes, at: this.now() });
  }

  private modelFor(outcome: number): number | null {
    const m = this.model.get(outcome);
    if (!m) return null;
    // A forecast older than twice the refresh interval is stale; don't trade on it.
    if (this.now() - m.at > 2 * this.opts.modelRefreshMins * 60_000) return null;
    return m.pYes;
  }

  // ---------- loop ----------

  private log(msg: string): void {
    console.log(`${new Date(this.now()).toISOString().slice(11, 19)} ${msg}`);
  }

  /** Log a skip reason only when it changes, so the real-time loop doesn't spam. */
  private skip(coin: string, reason: string): void {
    if (this.lastSkip.get(coin) === reason) return;
    this.lastSkip.set(coin, reason);
    this.log(`${coin} ${reason}`);
  }

  private record(coin: string, mid: number): number {
    const now = this.now();
    const h = this.history.get(coin) ?? [];
    h.push({ t: now, mid });
    const cutoff = now - this.opts.windowMins * 60_000;
    while (h.length > 0 && h[0]!.t < cutoff) h.shift();
    this.history.set(coin, h);
    this.lastMid.set(coin, mid);
    return h.reduce((a, x) => Math.max(a, x.mid), 0);
  }

  async tick(): Promise<void> {
    if (this.now() - this.lastMetaFetch > META_REFRESH_MS) await this.refreshMarkets();
    this.scheduleModels();
    const mids = await this.deps.info.allMids();

    const highs = new Map<string, number>();
    for (const m of this.markets.values()) {
      for (const side of [YES, NO] as Side[]) {
        const coin = encodeCoin(m.outcome, side);
        const raw = mids[coin];
        if (raw !== undefined) highs.set(coin, this.record(coin, Number(raw)));
      }
    }

    await this.manageExits(mids);
    await this.lookForEntries(mids, highs);
    this.heartbeat(mids);
  }

  private async manageExits(mids: Record<string, string>): Promise<void> {
    for (const pos of [...this.state.positions]) {
      const coin = encodeCoin(pos.outcome, pos.side);
      if (mids[coin] === undefined) {
        // Market stopped quoting: it resolved. Tokens settle at 1 or 0.
        const settle = (this.lastMid.get(coin) ?? pos.entryPx) >= 0.5 ? 1 : 0;
        this.close(pos, settle, "resolved");
        continue;
      }
      const book = await this.deps.info.l2Book(coin);
      const bid = book.bids[0];
      if (!bid) continue;
      const target = pos.entryPx * (1 + this.opts.takePct / 100);
      const stop = this.opts.stopPct !== null ? pos.entryPx * (1 - this.opts.stopPct / 100) : null;
      const reason = bid.px >= target ? "take" : stop !== null && bid.px <= stop ? "stop" : null;
      if (!reason) continue;
      const fill = await this.deps.executor.sell(pos.outcome, pos.side, bid.px, pos.sz, book);
      if (fill.filledSz <= 0) {
        this.skip(coin, `exit (${reason}) unfilled: ${fill.error ?? "?"}`);
        continue;
      }
      if (fill.filledSz < pos.sz) {
        // Partial exit: book the filled part, keep the rest open.
        const part: OpenPosition = { ...pos, sz: fill.filledSz };
        pos.sz -= fill.filledSz;
        this.close(part, fill.avgPx, reason, false);
        this.saveState();
      } else {
        this.close(pos, fill.avgPx, reason);
      }
    }
  }

  private close(pos: OpenPosition, exitPx: number, reason: ClosedTrade["reason"], remove = true): void {
    const coin = encodeCoin(pos.outcome, pos.side);
    const pnl = (exitPx - pos.entryPx) * pos.sz;
    this.state.closed.push({ ...pos, exitPx, closedAt: this.now(), reason, pnl });
    if (remove) this.state.positions = this.state.positions.filter((p) => p !== pos);
    this.lastExit.set(coin, this.now());
    this.history.delete(coin);
    this.saveState();
    const icon = reason === "take" ? "💰" : reason === "stop" ? "🛑" : "🏁";
    this.deps.notify(
      [
        `${this.tag()} ${icon} SELL ${pos.sz} ${sideName(pos.side)} — ${pos.label}  [#${pos.outcome}]`,
        `entry ${pos.entryPx.toFixed(4)} → exit ${exitPx.toFixed(4)} (${reason}) | PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDC`,
        `realized total ${this.realizedPnl().toFixed(2)} USDC over ${this.state.closed.length} trades`,
      ].join("\n"),
    );
    if (!this.halted && this.realizedPnl() <= -this.opts.maxLossUsd) {
      this.halted = true;
      this.deps.notify(`${this.tag()} ⛔ max loss ${this.opts.maxLossUsd} USDC reached — no new entries; open positions still managed`);
    }
  }

  private async lookForEntries(mids: Record<string, string>, highs: Map<string, number>): Promise<void> {
    if (this.halted) return;
    for (const m of this.markets.values()) {
      if (this.state.positions.length >= this.opts.maxOpen) return;
      if (this.state.positions.some((p) => p.outcome === m.outcome)) continue;
      if (m.fields && (m.fields.expiryMs - this.now()) / 3_600_000 < this.opts.minHoursToExpiry) continue;

      for (const side of [YES, NO] as Side[]) {
        const coin = encodeCoin(m.outcome, side);
        const raw = mids[coin];
        const high = highs.get(coin);
        if (raw === undefined || !high) continue;
        const mid = Number(raw);
        const dropPct = ((high - mid) / high) * 100;
        if (dropPct < this.opts.dipPct) continue;
        const lastExit = this.lastExit.get(coin);
        if (lastExit && this.now() - lastExit < this.opts.windowMins * 60_000) {
          this.skip(coin, "dip ignored: cooling down after a recent exit");
          continue;
        }

        const book = await this.deps.info.l2Book(coin);
        const ask = book.asks[0];
        if (!ask) {
          this.skip(coin, "dip but no asks on the book");
          continue;
        }
        let modelP: number | null = null;
        if (this.opts.useModel) {
          const pYes = this.modelFor(m.outcome);
          if (pYes === null) {
            this.skip(coin, `dip ${dropPct.toFixed(1)}% but no fresh model value yet — waiting`);
            continue;
          }
          modelP = side === YES ? pYes : 1 - pYes;
          if (modelP < ask.px + this.opts.minEdge) {
            this.skip(coin, `dip ${dropPct.toFixed(1)}% vetoed: model ${modelP.toFixed(3)} < ask ${ask.px.toFixed(4)}${this.opts.minEdge ? ` + edge ${this.opts.minEdge}` : ""}`);
            continue;
          }
        }
        const sz = Math.floor(this.opts.usdPerTrade / ask.px);
        if (sz < 1) continue;

        const fill = await this.deps.executor.buy(m.outcome, side, ask.px, sz, book);
        if (fill.filledSz <= 0) {
          this.skip(coin, `buy unfilled: ${fill.error ?? "?"}`);
          continue;
        }
        const pos: OpenPosition = {
          outcome: m.outcome,
          side,
          label: m.label,
          sz: fill.filledSz,
          entryPx: fill.avgPx,
          openedAt: this.now(),
          modelP,
        };
        this.state.positions.push(pos);
        this.history.delete(coin);
        this.saveState();
        this.deps.notify(
          [
            `${this.tag()} 🛒 BUY ${pos.sz} ${sideName(side)} @ ${pos.entryPx.toFixed(4)} — ${m.label}  [#${m.outcome}]`,
            `dipped ${dropPct.toFixed(1)}% from ${high.toFixed(4)} in ${this.opts.windowMins}m${modelP !== null ? ` | model ${modelP.toFixed(3)} vs ask ${ask.px.toFixed(4)}` : ""}`,
            `take profit at ${(pos.entryPx * (1 + this.opts.takePct / 100)).toFixed(4)}${this.opts.stopPct !== null ? ` | stop ${(pos.entryPx * (1 - this.opts.stopPct / 100)).toFixed(4)}` : ""}`,
            ...(m.url ? [m.url] : []),
          ].join("\n"),
        );
        break; // one side per market
      }
    }
  }

  private heartbeat(mids: Record<string, string>): void {
    if (this.now() - this.lastHeartbeat < HEARTBEAT_MS) return;
    this.lastHeartbeat = this.now();
    this.deps.notify(this.summary(mids));
  }

  summary(mids: Record<string, string>): string {
    const lines = [`${this.tag()} ⏱ ${this.markets.size} markets | ${this.state.positions.length} open | realized ${this.realizedPnl().toFixed(2)} USDC (${this.state.closed.length} trades)`];
    for (const p of this.state.positions) {
      const mid = Number(mids[encodeCoin(p.outcome, p.side)] ?? NaN);
      const u = Number.isFinite(mid) ? (mid - p.entryPx) * p.sz : NaN;
      lines.push(`• ${p.sz} ${sideName(p.side)} @ ${p.entryPx.toFixed(4)} now ${Number.isFinite(mid) ? mid.toFixed(4) : "?"} uPnL ${Number.isFinite(u) ? u.toFixed(2) : "?"} — ${p.label}`);
    }
    for (const m of this.markets.values()) {
      const pYes = this.modelFor(m.outcome);
      lines.push(`  #${m.outcome} YES ${mids[encodeCoin(m.outcome, YES)] ?? "—"}${pYes !== null ? ` | model ${pYes.toFixed(3)}` : ""} — ${m.label}`);
    }
    return lines.join("\n");
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.refreshMarkets();
    if (this.markets.size === 0) throw new Error("no markets to trade — give outcome indices, trade URLs or name patterns");
    this.deps.notify(
      [
        `${this.tag()} started — ${this.markets.size} market${this.markets.size === 1 ? "" : "s"}`,
        `buy a token ${this.opts.dipPct}% below its ${this.opts.windowMins}m high${this.opts.useModel ? " if Kronos values it ≥ ask" : ""}; sell at +${this.opts.takePct}%${this.opts.stopPct !== null ? ` / stop -${this.opts.stopPct}%` : ""}`,
        `${this.opts.usdPerTrade} USDC per trade, max ${this.opts.maxOpen} open, max loss ${this.opts.maxLossUsd} USDC, tick ${this.opts.tickSecs}s`,
        ...this.marketList().map((m) => `• #${m.outcome} ${m.label}`),
        ...(this.state.positions.length ? [`resuming ${this.state.positions.length} open position(s) from ${this.opts.statePath}`] : []),
      ].join("\n"),
    );
    while (!signal.aborted) {
      try {
        await this.tick();
      } catch (err) {
        this.log(`tick failed, retrying: ${String(err).slice(0, 200)}`);
      }
      await new Promise((r) => setTimeout(r, this.opts.tickSecs * 1000));
    }
  }
}
