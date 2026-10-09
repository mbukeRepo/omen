/**
 * Minimal Hyperliquid info client + HIP-4 outcome-market encoding.
 *
 * HIP-4 conventions:
 *  - book coin for (outcome, side):     "#(10*outcome + side)"   side: 0=YES 1=NO
 *  - balance coin for held tokens:      "+(10*outcome + side)"
 *  - asset id in signed order actions:  100_000_000 + 10*outcome + side
 *  - prices are probabilities in (0, 1)
 */

export const YES = 0;
export const NO = 1;
export type Side = 0 | 1;

export function encodeCoin(outcome: number, side: Side): string {
  return `#${10 * outcome + side}`;
}

export function encodeAssetId(outcome: number, side: Side): number {
  return 100_000_000 + 10 * outcome + side;
}

export function decodeCoin(coin: string): { outcome: number; side: Side } {
  const n = Number(coin.replace(/^[#+]/, ""));
  return { outcome: Math.floor(n / 10), side: (n % 10) as Side };
}

export function sideName(side: Side): "YES" | "NO" {
  return side === YES ? "YES" : "NO";
}

export function parseSide(s: string): Side {
  const v = s.trim().toLowerCase();
  if (v === "yes" || v === "y" || v === "0") return YES;
  if (v === "no" || v === "n" || v === "1") return NO;
  throw new Error(`side must be "yes" or "no", got "${s}"`);
}

export interface HlOutcome {
  outcome: number;
  name: string;
  description: string;
  sideSpecs: { name: string }[];
}

export interface HlQuestion {
  question: number;
  name: string;
  description: string;
  fallbackOutcome: number;
  namedOutcomes: number[];
  settledNamedOutcomes: number[];
}

export interface OutcomeMeta {
  outcomes: HlOutcome[];
  questions: HlQuestion[];
}

/** Parse pipe-delimited description, e.g. "class:priceBinary|underlying:BTC|...". */
export function parseDescription(desc: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of desc.split("|")) {
    const i = part.indexOf(":");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/** Parse HL expiry format YYYYMMDD-HHMM as UTC ms, or null. */
export function parseHlTime(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!m) return null;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
}

export function outcomeExpiryMs(o: HlOutcome, questions: HlQuestion[]): number | null {
  const d = parseDescription(o.description);
  const own =
    parseHlTime(d.expiry) ?? parseHlTime(d.time) ?? parseHlTime(d.resolutionDeadline) ?? parseHlTime(d.listingDeadline);
  if (own != null) return own;
  const q = questions.find((qq) => qq.namedOutcomes.includes(o.outcome) || qq.fallbackOutcome === o.outcome);
  if (!q) return null;
  const qd = parseDescription(q.description);
  return (
    parseHlTime(qd.scheduledDecision) ??
    parseHlTime(qd.decisionDeadline) ??
    parseHlTime(qd.resolutionDeadline) ??
    parseHlTime(qd.startTime)
  );
}

/** Human-readable one-liner for an outcome. */
export function describeOutcome(o: HlOutcome, questions: HlQuestion[]): string {
  const d = parseDescription(o.description);
  const q = questions.find((qq) => qq.namedOutcomes.includes(o.outcome) || qq.fallbackOutcome === o.outcome);
  switch (true) {
    case o.description.startsWith("class:priceBinary"):
      return `${d.underlying} >= ${d.targetPrice} at ${d.expiry} (${d.period ?? "?"})`;
    case o.name === "template:binaryPrice":
      return `${d.perp} >= ${d.threshold} at ${d.time} (${d.priceDescription ?? ""})`;
    case o.name === "template:priceTouch":
      return `${d.perp} touches ${d.target} by ${d.time}`;
    case o.name.startsWith("template:policyRate"): {
      const kind = o.name.replace("template:policyRate", "");
      const qd = q ? parseDescription(q.description) : {};
      return `${qd.institution ?? "Policy rate"} ${kind} (${qd.decisionLabel ?? "?"}, decides ${qd.scheduledDecision ?? "?"})`;
    }
    case o.name.startsWith("template:sports"): {
      const parts = [d.competition, d.participantA, d.participantB, d.participant, d.total, d.spread]
        .filter(Boolean)
        .join(" ");
      return `${o.name.replace("template:", "")}: ${parts}`;
    }
    case o.name.startsWith("template:companyIpo"):
      return `IPO ${d.company ?? o.description} ${d.marketCapThresholdB ? `mcap >= $${d.marketCapThresholdB}B` : "confirmed"}${d.listingDeadline ? ` by ${d.listingDeadline}` : ""}`;
    default:
      return `${o.name}: ${o.description}`.slice(0, 120);
  }
}

interface RawLevel {
  px: string;
  sz: string;
  n: number;
}

export interface BookLevel {
  px: number;
  sz: number;
}

export interface Book {
  bids: BookLevel[];
  asks: BookLevel[];
  ts: number;
}

export interface SpotBalance {
  coin: string;
  total: string;
  hold: string;
  /** Cost basis in USDC; avg entry = entryNtl / total. */
  entryNtl?: string;
}

export interface OpenOrder {
  coin: string;
  oid: number;
  side: "B" | "A";
  limitPx: string;
  sz: string;
  timestamp: number;
}

export class HyperliquidInfo {
  constructor(private readonly apiUrl: string) {}

  private async info<T>(body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.apiUrl}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`HL info ${String(body.type)} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  async outcomeMeta(): Promise<OutcomeMeta> {
    const meta = await this.info<OutcomeMeta>({ type: "outcomeMeta" });
    return { outcomes: meta.outcomes ?? [], questions: meta.questions ?? [] };
  }

  /** All mids; HIP-4 coins appear as '#N' keys with probability-space prices. */
  async allMids(): Promise<Record<string, string>> {
    return this.info<Record<string, string>>({ type: "allMids" });
  }

  async l2Book(coin: string): Promise<Book> {
    const raw = await this.info<{ levels: [RawLevel[], RawLevel[]]; time: number }>({ type: "l2Book", coin });
    const toSide = (lvls: RawLevel[]) => lvls.map((l) => ({ px: Number(l.px), sz: Number(l.sz) }));
    return { bids: toSide(raw.levels?.[0] ?? []), asks: toSide(raw.levels?.[1] ?? []), ts: raw.time ?? Date.now() };
  }

  async spotBalances(user: string): Promise<SpotBalance[]> {
    const res = await this.info<{ balances: SpotBalance[] }>({
      type: "spotClearinghouseState",
      user,
    });
    return res.balances ?? [];
  }

  async openOrders(user: string): Promise<OpenOrder[]> {
    return this.info<OpenOrder[]>({ type: "frontendOpenOrders", user });
  }
}
