import { Telegram } from "./telegram.js";
import {
  HyperliquidInfo,
  YES,
  decodeCoin,
  describeOutcome,
  encodeCoin,
  outcomeExpiryMs,
  type OutcomeMeta,
} from "./hyperliquid.js";

export interface WatchOptions {
  intervalSecs: number;
  /** Alert threshold; relative % of YES mid, or probability percentage points with asPoints. */
  delta: number;
  asPoints: boolean;
  /** Watch the whole live universe and auto-add new listings. */
  all: boolean;
  /** Watch the outcomes this address holds tokens in. */
  user: string | null;
  /** Periodic digest to the channel; 0 disables. */
  heartbeatMins: number;
  telegram: { token: string; chatId: string } | null;
}

interface Tracked {
  outcome: number;
  label: string;
  expiry: string | null;
  start: number; // YES mid at session start (for heartbeat digests)
  baseline: number; // YES mid at last alert — alerts measure moves from here
  last: number;
}

const META_REFRESH_MS = 10 * 60_000;

function fmtExpiry(ms: number | null): string | null {
  return ms ? `${new Date(ms).toISOString().slice(0, 16)} UTC` : null;
}

function describeMove(from: number, to: number): string {
  const pp = (to - from) * 100;
  const pct = from > 0 ? ((to - from) / from) * 100 : Number.POSITIVE_INFINITY;
  const sign = pp >= 0 ? "+" : "";
  return `${sign}${pp.toFixed(2)}pp, ${sign}${pct.toFixed(1)}%`;
}

export class Watcher {
  private readonly tracked = new Map<number, Tracked>();
  private readonly tg: Telegram | null;
  private meta: OutcomeMeta = { outcomes: [], questions: [] };
  private lastMetaFetch = 0;
  private lastHeartbeat = Date.now();

  constructor(
    private readonly info: HyperliquidInfo,
    private readonly opts: WatchOptions,
  ) {
    this.tg = opts.telegram ? new Telegram(opts.telegram.token, opts.telegram.chatId) : null;
    if (!this.tg) console.warn("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — alerts go to console only");
  }

  /** Send to the channel (if configured) and always echo to the console. */
  private notify(text: string): void {
    console.log(`\n${text}`);
    this.tg?.send(text);
  }

  private thresholdLabel(): string {
    return this.opts.asPoints ? `${this.opts.delta}pp` : `${this.opts.delta}%`;
  }

  /** Resolve which outcome indices to watch. */
  private async resolveWatchSet(explicit: number[]): Promise<number[]> {
    if (explicit.length > 0) return explicit;
    if (this.opts.user) {
      const balances = await this.info.spotBalances(this.opts.user);
      const outcomes = new Set<number>();
      for (const b of balances) {
        if (b.coin.startsWith("+") && Number(b.total) > 0) outcomes.add(decodeCoin(b.coin).outcome);
      }
      if (outcomes.size === 0) throw new Error(`${this.opts.user} holds no outcome tokens — nothing to watch`);
      return [...outcomes];
    }
    if (this.opts.all) {
      const mids = await this.info.allMids();
      return this.meta.outcomes
        .filter((o) => mids[encodeCoin(o.outcome, YES)] !== undefined)
        .map((o) => o.outcome);
    }
    throw new Error("give outcome indices, or use --all / --user <address> / --positions");
  }

  private track(outcome: number, mid: number): Tracked {
    const o = this.meta.outcomes.find((x) => x.outcome === outcome);
    const t: Tracked = {
      outcome,
      label: o ? describeOutcome(o, this.meta.questions) : `outcome ${outcome}`,
      expiry: fmtExpiry(o ? outcomeExpiryMs(o, this.meta.questions) : null),
      start: mid,
      baseline: mid,
      last: mid,
    };
    this.tracked.set(outcome, t);
    return t;
  }

  private async refreshMeta(): Promise<void> {
    this.meta = await this.info.outcomeMeta();
    this.lastMetaFetch = Date.now();
  }

  private tick(mids: Record<string, string>): void {
    for (const t of [...this.tracked.values()]) {
      const raw = mids[encodeCoin(t.outcome, YES)];
      if (raw === undefined) {
        this.notify(`🏁 #${t.outcome} ${t.label}\nno longer quoted (resolved or delisted) — last YES ${t.last.toFixed(4)}`);
        this.tracked.delete(t.outcome);
        continue;
      }
      const mid = Number(raw);
      t.last = mid;
      const movedPp = Math.abs(mid - t.baseline) * 100;
      const movedPct = t.baseline > 0 ? (Math.abs(mid - t.baseline) / t.baseline) * 100 : Number.POSITIVE_INFINITY;
      const moved = this.opts.asPoints ? movedPp : movedPct;
      if (moved >= this.opts.delta) {
        const arrow = mid > t.baseline ? "🟢" : "🔴";
        const lines = [
          `${arrow} #${t.outcome} ${t.label}`,
          `YES ${t.baseline.toFixed(4)} → ${mid.toFixed(4)}  (${describeMove(t.baseline, mid)})`,
        ];
        if (t.expiry) lines.push(`expires ${t.expiry}`);
        this.notify(lines.join("\n"));
        t.baseline = mid;
      }
    }
  }

  /** Auto-add listings that appeared after startup (only in --all mode). */
  private addNewListings(mids: Record<string, string>): void {
    for (const o of this.meta.outcomes) {
      if (this.tracked.has(o.outcome)) continue;
      const raw = mids[encodeCoin(o.outcome, YES)];
      if (raw === undefined) continue;
      const t = this.track(o.outcome, Number(raw));
      this.notify(`🆕 #${t.outcome} listed: ${t.label}\nYES ${t.start.toFixed(4)}${t.expiry ? `\nexpires ${t.expiry}` : ""}`);
    }
  }

  private heartbeat(): void {
    if (this.opts.heartbeatMins <= 0) return;
    if (Date.now() - this.lastHeartbeat < this.opts.heartbeatMins * 60_000) return;
    this.lastHeartbeat = Date.now();
    const rows = [...this.tracked.values()]
      .map((t) => ({ t, drift: Math.abs(t.last - t.start) }))
      .sort((a, b) => b.drift - a.drift)
      .slice(0, 20)
      .map(({ t }) => `#${t.outcome} ${t.last.toFixed(4)} (session ${describeMove(t.start, t.last)}) ${t.label.slice(0, 50)}`);
    this.notify(`⏱ hip4 watch — ${this.tracked.size} markets, alert ≥ ${this.thresholdLabel()}\n${rows.join("\n")}`);
  }

  async run(explicit: number[]): Promise<void> {
    await this.refreshMeta();
    const outcomes = await this.resolveWatchSet(explicit);
    const mids = await this.info.allMids();

    for (const outcome of outcomes) {
      const raw = mids[encodeCoin(outcome, YES)];
      if (raw === undefined) {
        console.warn(`#${outcome}: no live YES mid — skipping (resolved or unknown outcome?)`);
        continue;
      }
      const t = this.track(outcome, Number(raw));
      console.log(`watching #${t.outcome} YES ${t.start.toFixed(4)} — ${t.label}`);
    }
    if (this.tracked.size === 0) throw new Error("nothing to watch");

    this.notify(
      `👁 hip4 watch started — ${this.tracked.size} market${this.tracked.size === 1 ? "" : "s"}, ` +
        `alert on moves ≥ ${this.thresholdLabel()}, polling every ${this.opts.intervalSecs}s`,
    );

    const stop = async () => {
      this.notify("🛑 hip4 watch stopped");
      await this.tg?.flush();
      process.exit(0);
    };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());

    for (;;) {
      await new Promise((r) => setTimeout(r, this.opts.intervalSecs * 1000));
      try {
        if (this.opts.all && Date.now() - this.lastMetaFetch > META_REFRESH_MS) await this.refreshMeta();
        const m = await this.info.allMids();
        this.tick(m);
        if (this.opts.all) this.addNewListings(m);
        this.heartbeat();
        process.stdout.write(".");
      } catch (err) {
        console.warn(`\npoll failed, retrying: ${String(err).slice(0, 200)}`);
      }
    }
  }
}
