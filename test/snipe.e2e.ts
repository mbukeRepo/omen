/**
 * End-to-end snipe rehearsal (slow, ~40s): real bot process against a mock HL
 * API replaying an event sequence. Run with: npm run test:e2e
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";

/**
 * End-to-end snipe rehearsal:
 *   phase 1 (0-8s):   spot at strike, book fair       -> bot must stay flat
 *   phase 2 (8-22s):  oracle jumps +1.4%, book STALE  -> snipe buys YES at the stale ask
 *   phase 3 (22s+):   book reprices, bid above target -> take-profit exit
 */
let t0: number | null = null; // anchored to the bot's first request
const phase = () => (t0 === null || Date.now() - t0 < 6000 ? 1 : Date.now() - t0 < 18000 ? 2 : 3);
const spot = () => (phase() === 1 ? 83000 : 84200);
const yesBook = () => (phase() === 1 ? { bid: 0.49, ask: 0.51 } : phase() === 2 ? { bid: 0.49, ask: 0.51 } : { bid: 0.62, ask: 0.64 });

const OUTCOME = 42;
const meta = {
  outcomes: [{ outcome: OUTCOME, name: "x", description: "class:priceBinary|underlying:BTC|targetPrice:83000|expiry:20261016-0600|period:1d", sideSpecs: [] }],
  questions: [],
};
const now0 = Date.now();
const candles = Array.from({ length: 170 }, (_, i) => {
  const c = i % 2 ? 83050 : 83000;
  return { t: now0 - (170 - i) * 3_600_000, T: 0, o: String(c), h: String(c + 20), l: String(c - 20), c: String(c), v: "100", n: 1 };
});

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const q = JSON.parse(body || "{}");
    t0 ??= Date.now();
    const yb = yesBook();
    const reply = (x: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(x)); };
    switch (q.type) {
      case "outcomeMeta": return reply(meta);
      case "allMids": return reply({ [`#${OUTCOME * 10}`]: String((yb.bid + yb.ask) / 2), [`#${OUTCOME * 10 + 1}`]: String(1 - (yb.bid + yb.ask) / 2) });
      case "l2Book": {
        const yes = q.coin === `#${OUTCOME * 10}`;
        const b = yes ? yb : { bid: 1 - yb.ask, ask: 1 - yb.bid };
        return reply({ levels: [[{ px: String(b.bid), sz: "5000", n: 1 }], [{ px: String(b.ask), sz: "5000", n: 1 }]], time: Date.now() });
      }
      case "metaAndAssetCtxs": return reply([{ universe: [{ name: "BTC" }] }, [{ funding: "0", openInterest: "0", markPx: String(spot()), oraclePx: String(spot()) }]]);
      case "candleSnapshot": return reply(candles);
      default: return reply([]);
    }
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
rmSync(".tmp/e2e-state.json", { force: true });

const bot = spawn("node_modules/.bin/tsx", ["src/cli.ts", "bot", String(OUTCOME), "--gate", "fair", "--snipe", "5", "--tick", "2", "--source", "hl", "--take", "5", "--state", ".tmp/e2e-state.json", "--no-record", "--model-refresh", "1"], {
  env: { ...process.env, HL_API_URL: `http://127.0.0.1:${port}`, DATABASE_URL: "", TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "", TMPDIR: `${process.cwd()}/.tmp` },
  detached: true,
});
let out = "";
bot.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
bot.stderr.on("data", (d) => { out += d; });

// wait until the bot has been through all three phases (t0 set by its first request)
while (t0 === null || Date.now() - t0 < 32000) await new Promise((r) => setTimeout(r, 1000));
try { process.kill(-bot.pid!, "SIGINT"); } catch {}
await new Promise((r) => setTimeout(r, 2500));
try { process.kill(-bot.pid!, "SIGKILL"); } catch {}
server.closeAllConnections?.();
server.close();

const state = JSON.parse(readFileSync(".tmp/e2e-state.json", "utf8"));
const checks: [string, boolean][] = [
  ["bot stayed flat in phase 1 (no BUY before the jump)", !out.slice(0, out.indexOf("SNIPE") === -1 ? out.length : undefined!).split("SNIPE")[0]!.includes("🛒") || out.indexOf("SNIPE") < out.indexOf("🛒") + 200],
  ["snipe fired with SNIPE reason", /SNIPE: fair value (0\.9\d+|1\.000) vs ask 0\.51/.test(out)],
  ["bought YES at the stale 0.51 ask", /BUY \d+ YES @ 0\.51/.test(out)],
  ["take-profit exit after the book repriced", /SELL \d+ YES[\s\S]*\(take\)/.test(out)],
  ["closed trade persisted with positive PnL", state.closed?.length === 1 && state.closed[0].reason === "take" && state.closed[0].pnl > 0],
  ["no open positions left", state.positions?.length === 0],
];
console.log("\n=== e2e verdict:");
let ok = true;
for (const [name, pass] of checks) { console.log(`${pass ? "✓" : "✗"} ${name}`); ok &&= pass; }
if (state.closed?.[0]) console.log(`trade: ${state.closed[0].sz} YES @ ${state.closed[0].entryPx} -> ${state.closed[0].exitPx}, pnl ${state.closed[0].pnl.toFixed(2)} USDC`);
process.exit(ok ? 0 : 1);
