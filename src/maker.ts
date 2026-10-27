import { appendFileSync } from "node:fs";
import {
  NO,
  YES,
  describeOutcome,
  encodeCoin,
  priceBinaryFields,
  sideName,
  type HyperliquidInfo,
  type Side,
} from "./hyperliquid.js";
import { digitalProb } from "./fairvalue.js";
import { resolveSlug, type SlugSpec } from "./watch.js";

/*
 * Paper market maker for HIP-4 outcome tokens (playcard C1 rehearsal).
 *
 * Rests post-only quotes on BOTH books of a price binary around the live
 * digital fair value: YES bid/ask at fair ∓/± half, NO bid/ask at (1-fair)
 * ∓/± half. A quote that would cross the touch is withheld (Alo semantics).
 *
 * Fill model (we only see book snapshots, never the tape):
 *  - FILL (conservative): the NEXT tick's opposite touch crosses our resting
 *    price (best ask <= our bid / best bid >= our ask). Certainly a fill.
 *  - TOUCH (optimistic): the next tick's mid reaches our price. Upper bound.
 * Conservative fills drive inventory and PnL; touches are reported alongside
 * so the result is a measured range, not one flattering number.
 *
 * Adverse selection: every fill records the fair value and mid at fill time
 * and is marked out at +5 minutes — capture (edge at fill) vs markout (what
 * the market did to us next) is the whole maker question.
 *
 * Live-constraint note: selling YES live requires holding YES. The paper
 * rehearsal allows signed inventory (short YES ≈ long NO economically) but
 * caps |net| premium; a live maker would bootstrap by minting both sides.
 */

export interface MakerOptions {
  /** Half-spread around fair, in probability points (0-1), e.g. 0.02. */
  half: number;
  /** Premium per quote, USDC. */
  usdPerQuote: number;
  /** Max |net YES-equivalent| inventory premium, USDC. */
  capUsd: number;
  tickSecs: number;
  /** Stop quoting and flatten this many hours before expiry. */
  flattenHours: number;
  /** Re-fetch vol this often. */
  volRefreshMins: number;
  indices: number[];
  slugs: SlugSpec[];
  patterns: string[];
  /** JSONL file for fills and summaries; null disables. */
  recordPath: string | null;
}

export interface MakerDeps {
  info: Pick<HyperliquidInfo, "allMids" | "l2Book" | "outcomeMeta" | "oraclePrices">;
  vol: (underlying: string) => Promise<number>;
  notify: (text: string) => void;
  now?: () => number;
}

interface Quote {
  coin: string;
  outcome: number;
  side: Side; // token book the quote rests on
  isBid: boolean;
  px: number;
  sz: number;
  fairAtQuote: number; // fair value of THIS token when quoted
  placedAt: number;
}

export interface MakerFill {
  t: number;
  coin: string;
  outcome: number;
  side: Side;
  isBid: boolean; // true = we bought
  px: number;
  sz: number;
  fair: number; // fair value of this token at fill
  mid: number; // token mid at fill
  kind: "fill" | "flatten" | "settle";
  markout5m?: number; // (mid_{+5m} - px) * dir, per token
}

interface MarketState {
  outcome: number;
  label: string;
  fields: { underlying: string; threshold: number; expiryMs: number };
  invYes: number; // tokens held (+) — signed, shorts allowed on paper
  invNo: number;
  flattened: boolean;
}

const r4 = (x: number) => Number(x.toFixed(4));

export class Maker {
  private markets = new Map<number, MarketState>();
  private quotes = new Map<string, Quote[]>(); // coin -> resting quotes (max 1 bid + 1 ask)
  private vols = new Map<string, { sigma: number; at: number }>();
  private volPending = new Set<string>();
  private spots: Record<string, number> = {};
  private pendingMarkouts: MakerFill[] = [];
  private lastMetaFetch = 0;
  private lastHeartbeat: number;
  private readonly now: () => number;

  // tallies
  cash = 0;
  fills: MakerFill[] = [];
  touches = 0; // optimistic fills we did NOT count
  quotesPosted = 0;
  quotesWithheld = 0; // would have crossed (Alo reject)

  constructor(
    private readonly opts: MakerOptions,
    private readonly deps: MakerDeps,
  ) {
    this.now = deps.now ?? Date.now;
    this.lastHeartbeat = this.now();
  }

  private log(msg: string): void {
    console.log(`${new Date(this.now()).toISOString().slice(11, 19)} ${msg}`);
  }

  private record(row: unknown): void {
    if (!this.opts.recordPath) return;
    try {
      appendFileSync(this.opts.recordPath, `${JSON.stringify(row)}\n`);
    } catch {
      /* recording must never kill quoting */
    }
  }

  // ---------- markets, vol, fair ----------

  async refreshMarkets(): Promise<void> {
    const meta = await this.deps.info.outcomeMeta();
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
    for (const outcome of wanted) {
      if (this.markets.has(outcome)) continue;
      const o = meta.outcomes.find((x) => x.outcome === outcome);
      if (!o) continue;
      const fields = priceBinaryFields(o);
      if (!fields) {
        this.log(`#${outcome} is not a price binary — fair value can't price it, skipping`);
        continue;
      }
      if (fields.expiryMs <= this.now()) continue;
      this.markets.set(outcome, {
        outcome,
        label: describeOutcome(o, meta.questions),
        fields,
        invYes: 0,
        invNo: 0,
        flattened: false,
      });
    }
  }

  private scheduleVols(): void {
    const staleMs = this.opts.volRefreshMins * 60_000;
    for (const m of this.markets.values()) {
      const u = m.fields.underlying;
      const cached = this.vols.get(u);
      if ((cached && this.now() - cached.at <= staleMs) || this.volPending.has(u)) continue;
      this.volPending.add(u);
      this.deps
        .vol(u)
        .then((sigma) => {
          this.vols.set(u, { sigma, at: this.now() });
          this.log(`vol ${u}: ${(sigma * 100).toFixed(3)}% per hour`);
        })
        .catch((err) => this.log(`vol ${u} failed: ${String(err).slice(0, 150)}`))
        .finally(() => this.volPending.delete(u));
    }
  }

  /** Fair P(YES), or null while spot/vol aren't fresh. */
  fairYes(m: MarketState): number | null {
    const spot = this.spots[m.fields.underlying.toUpperCase()];
    const v = this.vols.get(m.fields.underlying);
    if (spot === undefined || !v || this.now() - v.at > 2 * this.opts.volRefreshMins * 60_000) return null;
    return digitalProb(spot, m.fields.threshold, v.sigma, (m.fields.expiryMs - this.now()) / 3_600_000);
  }

  // ---------- inventory ----------

  /** Net YES-equivalent tokens (long YES and short NO both bullish). */
  private netYesEq(m: MarketState): number {
    return m.invYes - m.invNo;
  }

  private applyFill(m: MarketState, f: MakerFill): void {
    const q = f.isBid ? f.sz : -f.sz;
    if (f.side === YES) m.invYes += q;
    else m.invNo += q;
    this.cash -= q * f.px;
    this.fills.push(f);
    this.pendingMarkouts.push(f);
    this.record({ type: "fill", ...f });
  }

  /** Mark inventory at current mids; total PnL = cash + inventory value. */
  markToMarket(mids: Record<string, string>): number {
    let inv = 0;
    for (const m of this.markets.values()) {
      const yesMid = Number(mids[encodeCoin(m.outcome, YES)] ?? NaN);
      const noMid = Number(mids[encodeCoin(m.outcome, NO)] ?? NaN);
      if (Number.isFinite(yesMid)) inv += m.invYes * yesMid;
      if (Number.isFinite(noMid)) inv += m.invNo * noMid;
    }
    return this.cash + inv;
  }

  // ---------- the tick ----------

  async tick(): Promise<void> {
    if (this.now() - this.lastMetaFetch > 10 * 60_000) await this.refreshMarkets();
    this.scheduleVols();
    const [mids, spots] = await Promise.all([this.deps.info.allMids(), this.deps.info.oraclePrices()]);
    this.spots = spots;

    // Books for every coin we quote or hold.
    const coins = new Set<string>();
    for (const m of this.markets.values()) {
      coins.add(encodeCoin(m.outcome, YES));
      coins.add(encodeCoin(m.outcome, NO));
    }
    const books = new Map<string, { bid: { px: number; sz: number } | null; ask: { px: number; sz: number } | null }>();
    await Promise.all(
      [...coins].map(async (coin) => {
        try {
          const b = await this.deps.info.l2Book(coin);
          books.set(coin, { bid: b.bids[0] ?? null, ask: b.asks[0] ?? null });
        } catch {
          /* missing book: no fills, no quotes this tick */
        }
      }),
    );

    this.settleExpired(mids);
    this.processFills(books, mids);
    this.resolveMarkouts(mids);
    await this.flattenNearExpiry(books);
    this.requote(books);
    this.heartbeat(mids);
  }

  /** Fills are judged against THIS tick's book for quotes placed on PREVIOUS ticks. */
  private processFills(
    books: Map<string, { bid: { px: number; sz: number } | null; ask: { px: number; sz: number } | null }>,
    mids: Record<string, string>,
  ): void {
    for (const [coin, resting] of this.quotes) {
      const b = books.get(coin);
      if (!b) continue;
      const mid = Number(mids[coin] ?? NaN);
      const keep: Quote[] = [];
      for (const q of resting) {
        const m = this.markets.get(q.outcome);
        if (!m) continue;
        const crossed = q.isBid ? b.ask !== null && b.ask.px <= q.px : b.bid !== null && b.bid.px >= q.px;
        const touched = Number.isFinite(mid) && (q.isBid ? mid <= q.px : mid >= q.px);
        if (crossed) {
          const fair = this.fairYes(m);
          const f: MakerFill = {
            t: this.now(),
            coin,
            outcome: q.outcome,
            side: q.side,
            isBid: q.isBid,
            px: q.px,
            sz: q.sz,
            fair: fair !== null ? r4(q.side === YES ? fair : 1 - fair) : q.fairAtQuote,
            mid: Number.isFinite(mid) ? r4(mid) : q.px,
            kind: "fill",
          };
          this.applyFill(m, f);
          const capture = (q.isBid ? f.fair - q.px : q.px - f.fair) * q.sz;
          this.deps.notify(
            `🧵 maker FILL ${q.isBid ? "bought" : "sold"} ${q.sz} ${sideName(q.side)} @ ${q.px.toFixed(4)} ` +
              `(fair ${f.fair.toFixed(4)}, capture ${capture >= 0 ? "+" : ""}${capture.toFixed(2)}) — ${m.label} [#${m.outcome}]`,
          );
        } else if (touched) {
          this.touches += 1;
          keep.push(q);
        } else {
          keep.push(q);
        }
      }
      this.quotes.set(coin, keep);
    }
  }

  /** +5 minute markout per fill: did the market run us over after filling us? */
  private resolveMarkouts(mids: Record<string, string>): void {
    const due = this.pendingMarkouts.filter((f) => this.now() - f.t >= 5 * 60_000);
    this.pendingMarkouts = this.pendingMarkouts.filter((f) => this.now() - f.t < 5 * 60_000);
    for (const f of due) {
      const mid = Number(mids[f.coin] ?? NaN);
      if (!Number.isFinite(mid)) continue;
      f.markout5m = r4((f.isBid ? mid - f.px : f.px - mid) * 1);
      this.record({ type: "markout", t: this.now(), coin: f.coin, px: f.px, isBid: f.isBid, markout5m: f.markout5m });
    }
  }

  /** T-flattenHours: pull quotes and close inventory at the touch (taker, honest cost). */
  private async flattenNearExpiry(
    books: Map<string, { bid: { px: number; sz: number } | null; ask: { px: number; sz: number } | null }>,
  ): Promise<void> {
    for (const m of this.markets.values()) {
      if (m.flattened) continue;
      const hoursLeft = (m.fields.expiryMs - this.now()) / 3_600_000;
      if (hoursLeft > this.opts.flattenHours) continue;
      m.flattened = true;
      this.quotes.set(encodeCoin(m.outcome, YES), []);
      this.quotes.set(encodeCoin(m.outcome, NO), []);
      for (const side of [YES, NO] as Side[]) {
        const inv = side === YES ? m.invYes : m.invNo;
        if (inv === 0) continue;
        const coin = encodeCoin(m.outcome, side);
        const b = books.get(coin);
        const px = inv > 0 ? b?.bid?.px : b?.ask?.px;
        if (px === undefined || px === null) {
          this.log(`${coin} flatten: no touch to close ${inv} — will settle at expiry`);
          continue;
        }
        const fair = this.fairYes(m);
        this.applyFill(m, {
          t: this.now(),
          coin,
          outcome: m.outcome,
          side,
          isBid: inv < 0,
          px,
          sz: Math.abs(inv),
          fair: fair !== null ? r4(side === YES ? fair : 1 - fair) : px,
          mid: px,
          kind: "flatten",
        });
        this.deps.notify(`🧵 maker FLATTEN ${inv > 0 ? "sold" : "bought"} ${Math.abs(inv)} ${sideName(side)} @ ${px.toFixed(4)} (T-${hoursLeft.toFixed(1)}h) — ${m.label}`);
      }
    }
  }

  /** Residual inventory in an expired market settles at 1/0 off spot vs strike. */
  private settleExpired(mids: Record<string, string>): void {
    for (const [outcome, m] of [...this.markets]) {
      if (this.now() < m.fields.expiryMs) continue;
      const spot = this.spots[m.fields.underlying.toUpperCase()];
      const yesPays = spot !== undefined ? (spot >= m.fields.threshold ? 1 : 0) : Number(mids[encodeCoin(outcome, YES)] ?? 0.5) >= 0.5 ? 1 : 0;
      for (const side of [YES, NO] as Side[]) {
        const inv = side === YES ? m.invYes : m.invNo;
        if (inv === 0) continue;
        const px = side === YES ? yesPays : 1 - yesPays;
        this.applyFill(m, { t: this.now(), coin: encodeCoin(outcome, side), outcome, side, isBid: inv < 0, px, sz: Math.abs(inv), fair: px, mid: px, kind: "settle" });
        this.deps.notify(`🧵 maker SETTLE ${inv} ${sideName(side)} at ${px} — ${m.label}`);
      }
      this.markets.delete(outcome);
      this.quotes.delete(encodeCoin(outcome, YES));
      this.quotes.delete(encodeCoin(outcome, NO));
    }
  }

  /** Replace quotes at fair ± half with post-only semantics and inventory caps. */
  private requote(
    books: Map<string, { bid: { px: number; sz: number } | null; ask: { px: number; sz: number } | null }>,
  ): void {
    for (const m of this.markets.values()) {
      if (m.flattened) continue;
      const fair = this.fairYes(m);
      if (fair === null || fair < 0.03 || fair > 0.97) {
        this.quotes.set(encodeCoin(m.outcome, YES), []);
        this.quotes.set(encodeCoin(m.outcome, NO), []);
        continue;
      }
      const capTokens = this.opts.capUsd / 0.5;
      const net = this.netYesEq(m);
      for (const side of [YES, NO] as Side[]) {
        const coin = encodeCoin(m.outcome, side);
        const b = books.get(coin);
        if (!b) {
          this.quotes.set(coin, []);
          continue;
        }
        const f = side === YES ? fair : 1 - fair;
        const next: Quote[] = [];
        for (const isBid of [true, false]) {
          // A YES bid and a NO ask both add YES-equivalent exposure.
          const addsYesEq = (side === YES) === isBid;
          if (addsYesEq && net >= capTokens) continue;
          if (!addsYesEq && net <= -capTokens) continue;
          const px = r4(isBid ? f - this.opts.half : f + this.opts.half);
          if (px <= 0.001 || px >= 0.999) continue;
          // Post-only: a quote that would cross the current touch is rejected.
          const crosses = isBid ? b.ask !== null && px >= b.ask.px : b.bid !== null && px <= b.bid.px;
          if (crosses) {
            this.quotesWithheld += 1;
            continue;
          }
          const sz = Math.max(1, Math.floor(this.opts.usdPerQuote / Math.max(px, 0.02)));
          next.push({ coin, outcome: m.outcome, side, isBid, px, sz, fairAtQuote: r4(f), placedAt: this.now() });
          this.quotesPosted += 1;
        }
        this.quotes.set(coin, next);
      }
    }
  }

  // ---------- reporting ----------

  stats(mids: Record<string, string>): string {
    const real = this.fills.filter((f) => f.kind === "fill");
    const capture = real.reduce((a, f) => a + (f.isBid ? f.fair - f.px : f.px - f.fair) * f.sz, 0);
    const marked = this.fills.filter((f) => f.markout5m !== undefined);
    const avgMarkout = marked.length ? marked.reduce((a, f) => a + f.markout5m!, 0) / marked.length : NaN;
    const pnl = this.markToMarket(mids);
    const lines = [
      `🧵 maker [paper] — PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDC (cash ${this.cash.toFixed(2)} + inventory)`,
      `fills ${real.length} conservative (+${this.touches} optimistic touches not counted) | quotes ${this.quotesPosted} posted, ${this.quotesWithheld} withheld (would cross)`,
      `spread captured ${capture >= 0 ? "+" : ""}${capture.toFixed(2)} USDC | avg 5m markout ${Number.isFinite(avgMarkout) ? (avgMarkout >= 0 ? "+" : "") + avgMarkout.toFixed(4) : "n/a"}/token over ${marked.length} fills`,
    ];
    for (const m of this.markets.values()) {
      const fair = this.fairYes(m);
      lines.push(
        `• #${m.outcome} inv YES ${m.invYes} NO ${m.invNo} | fair ${fair !== null ? fair.toFixed(4) : "…"} mid ${mids[encodeCoin(m.outcome, YES)] ?? "—"} — ${m.label.slice(0, 50)}`,
      );
    }
    return lines.join("\n");
  }

  private heartbeat(mids: Record<string, string>): void {
    if (this.now() - this.lastHeartbeat < 60 * 60_000) return;
    this.lastHeartbeat = this.now();
    const s = this.stats(mids);
    this.deps.notify(s);
    this.record({ type: "summary", t: this.now(), text: s });
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.refreshMarkets();
    if (this.markets.size === 0) throw new Error("no price-binary markets to quote — give indices, URLs or patterns");
    this.deps.notify(
      [
        `🧵 maker [paper] started — ${this.markets.size} market(s), quoting fair ± ${(this.opts.half * 100).toFixed(1)}pp both books`,
        `${this.opts.usdPerQuote} USDC/quote, cap ${this.opts.capUsd} USDC net, flatten T-${this.opts.flattenHours}h, tick ${this.opts.tickSecs}s`,
        `fill = next-tick touch crosses the quote (conservative); mid-touches reported separately`,
        ...[...this.markets.values()].map((m) => `• #${m.outcome} ${m.label}`),
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
    const mids = await this.deps.info.allMids().catch(() => ({}) as Record<string, string>);
    const final = this.stats(mids);
    this.deps.notify(`🧵 maker stopped\n${final}`);
    this.record({ type: "final", t: this.now(), text: final });
  }
}
