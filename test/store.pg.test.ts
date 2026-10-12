import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PgStore, type OpenPosition } from "../src/store.js";

const base = process.env.TEST_DATABASE_URL;
const skip = base ? false : "set TEST_DATABASE_URL to run the Postgres store tests";

// Each run gets its own schema so tests never touch real bot data.
const schema = `hip4_test_${randomUUID().slice(0, 8)}`;
let admin: pg.Pool;
let store: PgStore;

before(async () => {
  if (!base) return;
  admin = new pg.Pool({ connectionString: base });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schema}`);
  store = await PgStore.connect(url.toString());
});

after(async () => {
  if (!base) return;
  await store.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

const pos = (over: Partial<OpenPosition> = {}): OpenPosition => ({
  id: randomUUID(),
  outcome: 11383,
  side: 1,
  label: "ETH >= 2564.1 at 20261013-0600 (1d)",
  sz: 40,
  entryPx: 0.42,
  openedAt: Date.UTC(2026, 9, 12, 7, 0),
  modelP: 0.56,
  ...over,
});

test("open, partial exit, full close round-trip through Postgres", { skip }, async () => {
  const p = pos();
  await store.savePosition("paper", p);
  let s = await store.load("paper");
  assert.equal(s.positions.length, 1);
  assert.deepEqual(s.positions[0], p);

  // Partial exit: 15 sold as their own trade, 25 stay open on the original row.
  const partId = randomUUID();
  await store.saveTrade("paper", { ...p, id: partId, sz: 15, exitPx: 0.45, closedAt: p.openedAt + 60_000, reason: "take", pnl: 0.45 });
  await store.savePosition("paper", { ...p, sz: 25 });
  s = await store.load("paper");
  assert.equal(s.positions[0]!.sz, 25);
  assert.equal(s.closed.length, 1);

  // Full exit turns the open row into a closed trade.
  await store.saveTrade("paper", { ...p, sz: 25, exitPx: 1, closedAt: p.openedAt + 120_000, reason: "resolved", pnl: 14.5 });
  s = await store.load("paper");
  assert.equal(s.positions.length, 0);
  assert.equal(s.closed.length, 2);
  assert.deepEqual(s.closed.map((t) => t.reason).sort(), ["resolved", "take"]);
  assert.equal(s.closed.find((t) => t.reason === "resolved")!.pnl, 14.5);
});

test("paper and live state are kept apart", { skip }, async () => {
  await store.savePosition("live", pos({ outcome: 1 }));
  const live = await store.load("live");
  const paper = await store.load("paper");
  assert.equal(live.positions.length, 1);
  assert.ok(paper.positions.every((p) => p.outcome !== 1));
});

test("ticks land in the token, spot and gate tables", { skip }, async () => {
  const t = Date.UTC(2026, 9, 12, 7, 18);
  await store.recordTick({
    t,
    tokens: { "#113820": 0.54686, "#113821": 0.45314 },
    spot: { BTC: 84182 },
    gate: { "11382": 0.5558 },
    gateKind: "fair",
    books: { "#113820": { bid: 0.54, ask: 0.55 } },
  });
  const tokens = await store.query<{ coin: string; mid: number; bid: number | null; ask: number | null; ts: Date }>(
    "SELECT coin, mid, bid, ask, ts FROM token_ticks ORDER BY coin",
  );
  assert.deepEqual(tokens.rows.map((r) => [r.coin, r.mid, r.bid, r.ask]), [
    ["#113820", 0.54686, 0.54, 0.55],
    ["#113821", 0.45314, null, null],
  ]);
  assert.equal(tokens.rows[0]!.ts.getTime(), t);
  const spot = await store.query<{ underlying: string; px: number }>("SELECT underlying, px FROM spot_ticks");
  assert.deepEqual(spot.rows, [{ underlying: "BTC", px: 84182 }]);
  const gate = await store.query<{ outcome: number; gate: string; p_yes: number }>("SELECT outcome, gate, p_yes FROM gate_ticks");
  assert.deepEqual(gate.rows, [{ outcome: 11382, gate: "fair", p_yes: 0.5558 }]);
});

test("connecting twice is safe (schema creation is idempotent)", { skip }, async () => {
  const url = new URL(base!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const again = await PgStore.connect(url.toString());
  await again.end();
});

test("market metadata is kept once per outcome", { skip }, async () => {
  const m = { outcome: 11382, name: "x", description: "class:priceBinary|underlying:BTC|targetPrice:83988|expiry:20261013-0600|period:1d" };
  await store.saveMarkets([m]);
  await store.saveMarkets([{ ...m, description: "changed" }]);
  const { rows } = await store.query<{ description: string }>("SELECT description FROM markets WHERE outcome = 11382");
  assert.deepEqual(rows, [{ description: m.description }]);
});
