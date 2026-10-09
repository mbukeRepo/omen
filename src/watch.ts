import { Telegram } from "./telegram.js";
import {
  HyperliquidInfo,
  YES,
  decodeCoin,
  describeOutcome,
  encodeCoin,
  outcomeExpiryMs,
  parseDescription,
  type HlOutcome,
  type OutcomeMeta,
} from "./hyperliquid.js";

export interface WatchOptions {
  intervalSecs: number;
  /** Alert threshold; relative % of YES mid, or probability percentage points with asPoints. */
  delta: number;
  asPoints: boolean;
  /** Watch the whole live universe and auto-add new listings. */
  all: boolean;
  /** Case-insensitive substrings matched against market labels; new matching listings auto-add. */
  patterns: string[];
  /** Watch the outcomes this address holds tokens in. */
  user: string | null;
  /** Periodic digest to the channel; 0 disables. */
  heartbeatMins: number;
  telegram: { token: string; chatId: string } | null;
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

export interface SlugSpec {
  raw: string;
  underlying: string;
  thresholdDigits: string;
  mmdd: string;
  hhmm: string;
}

/** Parse an app.hyperliquid.xyz trade URL or slug like "btc-above-82334-yes-oct-10-0600"; null if not slug-shaped. */
export function parseMarketSlug(input: string): SlugSpec | null {
  const slug = input.replace(/[/?#]+$/, "").split("/").pop()!.split("?")[0]!.toLowerCase();
  const m = slug.match(/^([a-z0-9]+)-above-(\d+)-(?:yes|no)-([a-z]{3})-(\d{2})-(\d{4})$/);
  const mon = m ? MONTHS[m[3]!] : undefined;
  if (!m || !mon) return null;
  return { raw: input, underlying: m[1]!.toUpperCase(), thresholdDigits: m[2]!, mmdd: mon + m[4]!, hhmm: m[5]! };
}

const digits = (s: string) => s.replace(/\D/g, "");

/** Find the live outcome index a slug refers to, or null. */
export function resolveSlug(meta: OutcomeMeta, spec: SlugSpec): number | null {
  for (const o of meta.outcomes) {
    const d = parseDescription(o.description);
    // Daily price binaries come in two shapes: template:binaryPrice[External]
    // (perp/threshold/time) and class:priceBinary (underlying/targetPrice/expiry).
    const isTemplate = o.name === "template:binaryPrice" || o.name === "template:binaryPriceExternal";
    const isClass = d.class === "priceBinary";
    if (!isTemplate && !isClass) continue;
    const underlying = isTemplate ? d.perp : d.underlying;
    const threshold = isTemplate ? d.threshold : d.targetPrice;
    const time = isTemplate ? d.time : d.expiry;
    if ((underlying ?? "").toUpperCase() !== spec.underlying) continue;
    if (digits(threshold ?? "") !== spec.thresholdDigits) continue;
    if (!(time ?? "").endsWith(`${spec.mmdd}-${spec.hhmm}`)) continue;
    return o.outcome;
  }
  return null;
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

  private matchesPattern(o: HlOutcome): boolean {
    if (this.opts.patterns.length === 0) return false;
    const hay = `${describeOutcome(o, this.meta.questions)} ${o.name} ${o.description}`.toLowerCase();
    return this.opts.patterns.some((p) => hay.includes(p));
  }

  /** Resolve which outcome indices to watch; sources combine. */
  private async resolveWatchSet(explicit: number[], slugs: SlugSpec[]): Promise<number[]> {
    const set = new Set<number>(explicit);
    for (const s of slugs) {
      const outcome = resolveSlug(this.meta, s);
      if (outcome === null) console.warn(`no live outcome matches "${s.raw}" (expired or not yet listed?)`);
      else set.add(outcome);
    }
    for (const o of this.meta.outcomes) {
      if (this.matchesPattern(o)) set.add(o.outcome);
    }
    if (this.opts.user) {
      const balances = await this.info.spotBalances(this.opts.user);
      for (const b of balances) {
        if (b.coin.startsWith("+") && Number(b.total) > 0) set.add(decodeCoin(b.coin).outcome);
      }
    }
    if (this.opts.all) {
      const mids = await this.info.allMids();
      for (const o of this.meta.outcomes) {
        if (mids[encodeCoin(o.outcome, YES)] !== undefined) set.add(o.outcome);
      }
    }
    if (set.size === 0) {
      throw new Error(
        "nothing to watch — give outcome indices / trade URLs / name patterns, set WATCH_WHITELIST, or use --all / --positions / --user",
      );
    }
    return [...set];
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

  /** Auto-add listings that appeared after startup: everything in --all mode, pattern matches otherwise. */
  private addNewListings(mids: Record<string, string>): void {
    for (const o of this.meta.outcomes) {
      if (this.tracked.has(o.outcome)) continue;
      if (!this.opts.all && !this.matchesPattern(o)) continue;
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

  async run(explicit: number[], slugs: SlugSpec[] = []): Promise<void> {
    await this.refreshMeta();
    const outcomes = await this.resolveWatchSet(explicit, slugs);
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
      const autoAdd = this.opts.all || this.opts.patterns.length > 0;
      try {
        if (autoAdd && Date.now() - this.lastMetaFetch > META_REFRESH_MS) await this.refreshMeta();
        const m = await this.info.allMids();
        this.tick(m);
        if (autoAdd) this.addNewListings(m);
        this.heartbeat();
        process.stdout.write(".");
      } catch (err) {
        console.warn(`\npoll failed, retrying: ${String(err).slice(0, 200)}`);
      }
    }
  }
}
