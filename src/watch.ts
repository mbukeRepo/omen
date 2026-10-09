import { Telegram } from "./telegram.js";
import {
  HyperliquidInfo,
  NO,
  YES,
  decodeCoin,
  describeOutcome,
  encodeCoin,
  outcomeExpiryMs,
  parseDescription,
  sideName,
  type HlOutcome,
  type OutcomeMeta,
  type Side,
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
  expiryMs: number | null;
  url: string | null;
  start: number; // YES mid at session start (for heartbeat digests)
  baseline: number; // YES mid at last alert — alerts measure moves from here
  last: number;
  // NO has its own book and mid (not exactly 1 - YES); tracked for display,
  // but alerts trigger on YES only — a NO trigger would mirror every alert.
  startNo: number;
  baselineNo: number;
  lastNo: number;
}

const META_REFRESH_MS = 10 * 60_000;

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "expires 2026-10-10T06:00 UTC (in 17h 10m)", or null when unknown. */
function expiryLine(expiryMs: number | null): string | null {
  if (!expiryMs) return null;
  const stamp = `${new Date(expiryMs).toISOString().slice(0, 16)} UTC`;
  const ms = expiryMs - Date.now();
  if (ms <= 0) return `expires ${stamp} (settling)`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const left = h >= 48 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m`;
  return `expires ${stamp} (in ${left})`;
}

/** Rebuild the app.hyperliquid.xyz trade URL for daily price binaries; null for other market types. */
export function marketUrl(o: HlOutcome): string | null {
  const d = parseDescription(o.description);
  const isTemplate = o.name === "template:binaryPrice" || o.name === "template:binaryPriceExternal";
  const isClass = d.class === "priceBinary";
  if (!isTemplate && !isClass) return null;
  const underlying = (isTemplate ? d.perp : d.underlying) ?? "";
  const threshold = (isTemplate ? d.threshold : d.targetPrice) ?? "";
  const time = (isTemplate ? d.time : d.expiry) ?? "";
  const m = time.match(/^\d{4}(\d{2})(\d{2})-(\d{4})$/);
  if (!underlying || !threshold || !m) return null;
  const mon = MONTH_NAMES[Number(m[1]) - 1];
  return `https://app.hyperliquid.xyz/trade/${underlying.toLowerCase()}-above-${threshold.replace(/\D/g, "")}-yes-${mon}-${m[2]}-${m[3]}`;
}

function describeMove(from: number, to: number): string {
  const pp = (to - from) * 100;
  const pct = from > 0 ? ((to - from) / from) * 100 : Number.POSITIVE_INFINITY;
  const sign = pp >= 0 ? "+" : "";
  return `${sign}${pp.toFixed(2)}pp, ${sign}${pct.toFixed(1)}%`;
}

interface Position {
  outcome: number;
  side: Side;
  sz: number;
  /** Average entry price from the clearinghouse cost basis, when reported. */
  entryPx: number | null;
}

export class Watcher {
  private readonly tracked = new Map<number, Tracked>();
  private readonly tg: Telegram | null;
  private meta: OutcomeMeta = { outcomes: [], questions: [] };
  private lastMetaFetch = 0;
  private lastHeartbeat = Date.now();
  /** Held outcome tokens by balance coin ("+N"); only populated when opts.user is set. */
  private positions = new Map<string, Position>();

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

  private track(outcome: number, mid: number, noMid: number = 1 - mid): Tracked {
    const o = this.meta.outcomes.find((x) => x.outcome === outcome);
    const t: Tracked = {
      outcome,
      label: o ? describeOutcome(o, this.meta.questions) : `outcome ${outcome}`,
      expiryMs: o ? outcomeExpiryMs(o, this.meta.questions) : null,
      url: o ? marketUrl(o) : null,
      start: mid,
      baseline: mid,
      last: mid,
      startNo: noMid,
      baselineNo: noMid,
      lastNo: noMid,
    };
    this.tracked.set(outcome, t);
    return t;
  }

  /** Live top of both books, e.g. "YES bid 0.5800 x 220 | ask 0.5900 x 64". */
  private async topOfBook(outcome: number): Promise<string[]> {
    const fmt = (l?: { px: number; sz: number }) => (l ? `${l.px.toFixed(4)} x ${l.sz}` : "—");
    const side = async (s: Side) => {
      try {
        const b = await this.info.l2Book(encodeCoin(outcome, s));
        return `${sideName(s)} bid ${fmt(b.bids[0])} | ask ${fmt(b.asks[0])}`;
      } catch {
        return null;
      }
    };
    const [yes, no] = await Promise.all([side(YES), side(NO)]);
    return [yes, no].filter((x): x is string => x !== null);
  }

  private async fetchPositions(): Promise<Map<string, Position>> {
    const out = new Map<string, Position>();
    const balances = await this.info.spotBalances(this.opts.user!);
    for (const b of balances) {
      if (!b.coin.startsWith("+")) continue;
      const sz = Number(b.total);
      if (!(sz > 0)) continue;
      const { outcome, side } = decodeCoin(b.coin);
      const entryNtl = b.entryNtl !== undefined ? Number(b.entryNtl) : NaN;
      out.set(b.coin, { outcome, side, sz, entryPx: Number.isFinite(entryNtl) ? entryNtl / sz : null });
    }
    return out;
  }

  private describePosition(p: Position, currentMid?: number): string {
    let s = `${p.sz} ${sideName(p.side)}`;
    if (p.entryPx !== null) s += ` @ avg ${p.entryPx.toFixed(4)}`;
    if (currentMid !== undefined) {
      s += ` | now ${currentMid.toFixed(4)}`;
      if (p.entryPx !== null) {
        const pnl = (currentMid - p.entryPx) * p.sz;
        s += ` | uPnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDC`;
      }
    }
    return s;
  }

  /** "position: 100 YES @ avg 0.5500 | now 0.6200 | uPnL +7.00 USDC" lines for a market we hold. */
  private positionLines(outcome: number): string[] {
    const t = this.tracked.get(outcome);
    const lines: string[] = [];
    for (const p of this.positions.values()) {
      if (p.outcome !== outcome) continue;
      const mid = p.side === YES ? t?.last : t?.lastNo;
      lines.push(`position: ${this.describePosition(p, mid)}`);
    }
    return lines;
  }

  /** Diff held positions against the last poll; announce opens, size changes, and closes. */
  private async checkPositions(mids: Record<string, string>): Promise<void> {
    const next = await this.fetchPositions();
    for (const [coin, p] of next) {
      // A position in a market we weren't watching yet pulls that market into the watch set.
      if (!this.tracked.has(p.outcome)) {
        const raw = mids[encodeCoin(p.outcome, YES)];
        if (raw !== undefined) {
          const rawNo = mids[encodeCoin(p.outcome, NO)];
          this.track(p.outcome, Number(raw), rawNo !== undefined ? Number(rawNo) : undefined);
        }
      }
      const t = this.tracked.get(p.outcome);
      const label = t ? `${t.label}  [#${p.outcome}]` : `#${p.outcome}`;
      const mid = p.side === YES ? t?.last : t?.lastNo;
      const prev = this.positions.get(coin);
      if (!prev) {
        this.notify(`📥 position opened: ${label}\n${this.describePosition(p, mid)}`);
      } else if (Math.abs(p.sz - prev.sz) > 1e-9) {
        const verb = p.sz > prev.sz ? "increased" : "reduced";
        this.notify(`${p.sz > prev.sz ? "📥" : "📤"} position ${verb}: ${label}\n${prev.sz} → ${this.describePosition(p, mid)}`);
      }
    }
    for (const [coin, prev] of this.positions) {
      if (next.has(coin)) continue;
      const t = this.tracked.get(prev.outcome);
      const label = t ? `${t.label}  [#${prev.outcome}]` : `#${prev.outcome}`;
      this.notify(`📤 position closed: ${label}\nwas ${this.describePosition(prev)}`);
    }
    this.positions = next;
  }

  /** Full detail block for one market, used by startup, alerts and heartbeats. */
  private async detailBlock(t: Tracked, headline: string): Promise<string> {
    const lines = [headline, ...(await this.topOfBook(t.outcome)), ...this.positionLines(t.outcome)];
    if (t.last !== t.start) {
      lines.push(`session: YES ${t.start.toFixed(4)} → ${t.last.toFixed(4)} (${describeMove(t.start, t.last)})`);
    }
    const exp = expiryLine(t.expiryMs);
    if (exp) lines.push(exp);
    if (t.url) lines.push(t.url);
    return lines.join("\n");
  }

  private async refreshMeta(): Promise<void> {
    this.meta = await this.info.outcomeMeta();
    this.lastMetaFetch = Date.now();
  }

  private async tick(mids: Record<string, string>): Promise<void> {
    for (const t of [...this.tracked.values()]) {
      const raw = mids[encodeCoin(t.outcome, YES)];
      if (raw === undefined) {
        this.notify(
          [
            `🏁 ${t.label}  [#${t.outcome}]`,
            `no longer quoted — resolved or delisted`,
            `last YES ${t.last.toFixed(4)} | NO ${t.lastNo.toFixed(4)}`,
            `session: YES ${t.start.toFixed(4)} → ${t.last.toFixed(4)} (${describeMove(t.start, t.last)})`,
            ...(t.url ? [t.url] : []),
          ].join("\n"),
        );
        this.tracked.delete(t.outcome);
        continue;
      }
      const mid = Number(raw);
      const rawNo = mids[encodeCoin(t.outcome, NO)];
      const noMid = rawNo !== undefined ? Number(rawNo) : 1 - mid;
      const prevBaseline = t.baseline;
      const prevBaselineNo = t.baselineNo;
      t.last = mid;
      t.lastNo = noMid;
      const movedPp = Math.abs(mid - prevBaseline) * 100;
      const movedPct = prevBaseline > 0 ? (Math.abs(mid - prevBaseline) / prevBaseline) * 100 : Number.POSITIVE_INFINITY;
      const moved = this.opts.asPoints ? movedPp : movedPct;
      if (moved >= this.opts.delta) {
        const arrow = mid > prevBaseline ? "🟢" : "🔴";
        this.notify(
          await this.detailBlock(
            t,
            [
              `${arrow} ${t.label}  [#${t.outcome}]`,
              `YES ${prevBaseline.toFixed(4)} → ${mid.toFixed(4)}  (${describeMove(prevBaseline, mid)})`,
              `NO  ${prevBaselineNo.toFixed(4)} → ${noMid.toFixed(4)}  (${describeMove(prevBaselineNo, noMid)})`,
            ].join("\n"),
          ),
        );
        t.baseline = mid;
        t.baselineNo = noMid;
      }
    }
  }

  /** Auto-add listings that appeared after startup: everything in --all mode, pattern matches otherwise. */
  private async addNewListings(mids: Record<string, string>): Promise<void> {
    for (const o of this.meta.outcomes) {
      if (this.tracked.has(o.outcome)) continue;
      if (!this.opts.all && !this.matchesPattern(o)) continue;
      const raw = mids[encodeCoin(o.outcome, YES)];
      if (raw === undefined) continue;
      const rawNo = mids[encodeCoin(o.outcome, NO)];
      const t = this.track(o.outcome, Number(raw), rawNo !== undefined ? Number(rawNo) : undefined);
      this.notify(
        await this.detailBlock(t, `🆕 listed: ${t.label}  [#${t.outcome}]\nYES ${t.start.toFixed(4)} | NO ${t.startNo.toFixed(4)}`),
      );
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
      .map(({ t }) => {
        const exp = expiryLine(t.expiryMs);
        return [
          `• ${t.label}  [#${t.outcome}]`,
          `  YES ${t.last.toFixed(4)} | NO ${t.lastNo.toFixed(4)}`,
          `  session: YES ${t.start.toFixed(4)} → ${t.last.toFixed(4)} (${describeMove(t.start, t.last)})`,
          ...this.positionLines(t.outcome).map((l) => `  ${l}`),
          ...(exp ? [`  ${exp}`] : []),
        ].join("\n");
      });
    this.notify(
      `⏱ hip4 watch — ${this.tracked.size} market${this.tracked.size === 1 ? "" : "s"}, alert ≥ ${this.thresholdLabel()}\n\n${rows.join("\n\n")}`,
    );
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
      const rawNo = mids[encodeCoin(outcome, NO)];
      const t = this.track(outcome, Number(raw), rawNo !== undefined ? Number(rawNo) : undefined);
      console.log(`watching #${t.outcome} YES ${t.start.toFixed(4)} / NO ${t.startNo.toFixed(4)} — ${t.label}`);
    }
    if (this.tracked.size === 0) throw new Error("nothing to watch");

    // Baseline the held positions before the loop so startup shows them
    // as holdings rather than as "position opened" alerts.
    if (this.opts.user) this.positions = await this.fetchPositions();

    const header =
      `👁 hip4 watch started — ${this.tracked.size} market${this.tracked.size === 1 ? "" : "s"}, ` +
      `alert on moves ≥ ${this.thresholdLabel()}, polling every ${this.opts.intervalSecs}s`;
    // Full per-market details for small watchlists; headline-only beyond that.
    const detailed = [...this.tracked.values()].slice(0, 10);
    const blocks = await Promise.all(
      detailed.map((t) => this.detailBlock(t, `• ${t.label}  [#${t.outcome}]\nYES ${t.start.toFixed(4)} | NO ${t.startNo.toFixed(4)}`)),
    );
    const overflow = this.tracked.size - detailed.length;
    this.notify([header, ...blocks, ...(overflow > 0 ? [`…and ${overflow} more`] : [])].join("\n\n"));

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
        await this.tick(m);
        if (this.opts.user) await this.checkPositions(m);
        if (autoAdd) await this.addNewListings(m);
        this.heartbeat();
        process.stdout.write(".");
      } catch (err) {
        console.warn(`\npoll failed, retrying: ${String(err).slice(0, 200)}`);
      }
    }
  }
}
