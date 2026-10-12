import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Side } from "./hyperliquid.js";

export type Mode = "paper" | "live";

export interface OpenPosition {
  id: string;
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
  mode: Mode;
  positions: OpenPosition[];
  closed: ClosedTrade[];
}

export interface TickRow {
  t: number;
  /** Token mids by book coin, e.g. "#113820". */
  tokens: Record<string, number>;
  /** Oracle spot by underlying. */
  spot: Record<string, number>;
  /** Gate P(YES) by outcome index. */
  gate: Record<string, number>;
  gateKind: string;
}

/**
 * Persistence for the bot. Writes are upserts keyed by position id: opening
 * writes an open row, a full exit turns that row into a closed trade, and a
 * partial exit writes a new closed-trade row and updates the open row's size.
 */
export interface BotStore {
  readonly description: string;
  load(mode: Mode): Promise<BotState>;
  savePosition(mode: Mode, pos: OpenPosition): Promise<void>;
  saveTrade(mode: Mode, trade: ClosedTrade): Promise<void>;
  recordTick(row: TickRow): Promise<void>;
  end(): Promise<void>;
}

// ---------- files (fallback when no DATABASE_URL) ----------

export class FileStore implements BotStore {
  private state: BotState | null = null;

  constructor(
    private readonly statePath: string,
    private readonly ticksPath: string | null,
  ) {}

  get description(): string {
    return `${this.statePath}${this.ticksPath ? ` + ${this.ticksPath}` : ""}`;
  }

  async load(mode: Mode): Promise<BotState> {
    if (existsSync(this.statePath)) {
      const s = JSON.parse(readFileSync(this.statePath, "utf8")) as BotState;
      if (s.mode !== mode) {
        throw new Error(`${this.statePath} holds ${s.mode} state but the bot is running ${mode} — use a different --state file`);
      }
      // Files written before positions had ids.
      for (const p of [...s.positions, ...s.closed]) p.id ??= randomUUID();
      this.state = s;
    } else {
      this.state = { mode, positions: [], closed: [] };
    }
    return structuredClone(this.state);
  }

  private write(): void {
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.statePath);
  }

  async savePosition(_mode: Mode, pos: OpenPosition): Promise<void> {
    const s = this.state!;
    s.positions = [...s.positions.filter((p) => p.id !== pos.id), { ...pos }];
    this.write();
  }

  async saveTrade(_mode: Mode, trade: ClosedTrade): Promise<void> {
    const s = this.state!;
    s.positions = s.positions.filter((p) => p.id !== trade.id);
    s.closed = [...s.closed.filter((t) => t.id !== trade.id), { ...trade }];
    this.write();
  }

  async recordTick(row: TickRow): Promise<void> {
    if (!this.ticksPath) return;
    appendFileSync(this.ticksPath, `${JSON.stringify({ t: row.t, tokens: row.tokens, spot: row.spot, gate: row.gate })}\n`);
  }

  async end(): Promise<void> {}
}

// ---------- postgres ----------

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_positions (
  id          uuid PRIMARY KEY,
  mode        text NOT NULL CHECK (mode IN ('paper', 'live')),
  outcome     integer NOT NULL,
  side        smallint NOT NULL CHECK (side IN (0, 1)),
  label       text NOT NULL,
  sz          double precision NOT NULL CHECK (sz > 0),
  entry_px    double precision NOT NULL,
  opened_at   timestamptz NOT NULL,
  model_p     double precision,
  status      text NOT NULL CHECK (status IN ('open', 'closed')),
  exit_px     double precision,
  closed_at   timestamptz,
  reason      text CHECK (reason IN ('take', 'stop', 'resolved')),
  pnl         double precision
);
CREATE INDEX IF NOT EXISTS bot_positions_mode_status ON bot_positions (mode, status);

CREATE TABLE IF NOT EXISTS token_ticks (
  ts    timestamptz NOT NULL,
  coin  text NOT NULL,
  mid   double precision NOT NULL
);
CREATE INDEX IF NOT EXISTS token_ticks_coin_ts ON token_ticks (coin, ts);

CREATE TABLE IF NOT EXISTS spot_ticks (
  ts          timestamptz NOT NULL,
  underlying  text NOT NULL,
  px          double precision NOT NULL
);
CREATE INDEX IF NOT EXISTS spot_ticks_underlying_ts ON spot_ticks (underlying, ts);

CREATE TABLE IF NOT EXISTS gate_ticks (
  ts       timestamptz NOT NULL,
  outcome  integer NOT NULL,
  gate     text NOT NULL,
  p_yes    double precision NOT NULL
);
CREATE INDEX IF NOT EXISTS gate_ticks_outcome_ts ON gate_ticks (outcome, ts);
`;

type Pool = import("pg").Pool;

interface PositionRow {
  id: string;
  outcome: number;
  side: number;
  label: string;
  sz: number;
  entry_px: number;
  opened_at: Date;
  model_p: number | null;
  status: "open" | "closed";
  exit_px: number | null;
  closed_at: Date | null;
  reason: ClosedTrade["reason"] | null;
  pnl: number | null;
}

export class PgStore implements BotStore {
  private constructor(
    private readonly pool: Pool,
    readonly description: string,
  ) {}

  /** Connect and create the schema if needed (idempotent). */
  static async connect(url: string): Promise<PgStore> {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: url, max: 4 });
    await pool.query(SCHEMA);
    const u = new URL(url);
    return new PgStore(pool, `postgres ${u.host}${u.pathname}`);
  }

  async load(mode: Mode): Promise<BotState> {
    const { rows } = await this.pool.query<PositionRow>(
      "SELECT * FROM bot_positions WHERE mode = $1 ORDER BY opened_at, closed_at NULLS LAST",
      [mode],
    );
    const base = (r: PositionRow): OpenPosition => ({
      id: r.id,
      outcome: r.outcome,
      side: r.side as Side,
      label: r.label,
      sz: r.sz,
      entryPx: r.entry_px,
      openedAt: r.opened_at.getTime(),
      modelP: r.model_p,
    });
    return {
      mode,
      positions: rows.filter((r) => r.status === "open").map(base),
      closed: rows
        .filter((r) => r.status === "closed")
        .map((r) => ({ ...base(r), exitPx: r.exit_px!, closedAt: r.closed_at!.getTime(), reason: r.reason!, pnl: r.pnl! })),
    };
  }

  private upsert(mode: Mode, p: OpenPosition, closed: Omit<ClosedTrade, keyof OpenPosition> | null) {
    return this.pool.query(
      `INSERT INTO bot_positions
         (id, mode, outcome, side, label, sz, entry_px, opened_at, model_p, status, exit_px, closed_at, reason, pnl)
       VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0), $9, $10, $11, to_timestamp($12 / 1000.0), $13, $14)
       ON CONFLICT (id) DO UPDATE SET
         sz = EXCLUDED.sz, status = EXCLUDED.status, exit_px = EXCLUDED.exit_px,
         closed_at = EXCLUDED.closed_at, reason = EXCLUDED.reason, pnl = EXCLUDED.pnl`,
      [
        p.id, mode, p.outcome, p.side, p.label, p.sz, p.entryPx, p.openedAt, p.modelP,
        closed ? "closed" : "open",
        closed?.exitPx ?? null, closed?.closedAt ?? null, closed?.reason ?? null, closed?.pnl ?? null,
      ],
    );
  }

  async savePosition(mode: Mode, pos: OpenPosition): Promise<void> {
    await this.upsert(mode, pos, null);
  }

  async saveTrade(mode: Mode, t: ClosedTrade): Promise<void> {
    await this.upsert(mode, t, { exitPx: t.exitPx, closedAt: t.closedAt, reason: t.reason, pnl: t.pnl });
  }

  async recordTick(row: TickRow): Promise<void> {
    const ts = row.t;
    const coins = Object.keys(row.tokens);
    const unders = Object.keys(row.spot);
    const outs = Object.keys(row.gate);
    await Promise.all([
      coins.length &&
        this.pool.query(
          "INSERT INTO token_ticks (ts, coin, mid) SELECT to_timestamp($1 / 1000.0), unnest($2::text[]), unnest($3::float8[])",
          [ts, coins, coins.map((c) => row.tokens[c])],
        ),
      unders.length &&
        this.pool.query(
          "INSERT INTO spot_ticks (ts, underlying, px) SELECT to_timestamp($1 / 1000.0), unnest($2::text[]), unnest($3::float8[])",
          [ts, unders, unders.map((u) => row.spot[u])],
        ),
      outs.length &&
        this.pool.query(
          "INSERT INTO gate_ticks (ts, outcome, gate, p_yes) SELECT to_timestamp($1 / 1000.0), unnest($2::int[]), $3, unnest($4::float8[])",
          [ts, outs.map(Number), row.gateKind, outs.map((o) => row.gate[o])],
        ),
    ]);
  }

  /** Raw access for reports and imports. */
  query<R extends object>(sql: string, params: unknown[] = []): Promise<{ rows: R[] }> {
    return this.pool.query<R>(sql, params as never[]);
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

/** Postgres when a database URL is configured, otherwise the JSON/JSONL files. */
export async function openStore(
  databaseUrl: string | null,
  files: { statePath: string; ticksPath: string | null },
): Promise<BotStore> {
  return databaseUrl ? PgStore.connect(databaseUrl) : new FileStore(files.statePath, files.ticksPath);
}
