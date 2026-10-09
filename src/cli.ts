#!/usr/bin/env node
import { Command } from "commander";
import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import { loadConfig } from "./config.js";
import { loadAccount } from "./wallet.js";
import { Watcher } from "./watch.js";
import {
  HyperliquidInfo,
  NO,
  YES,
  decodeCoin,
  describeOutcome,
  encodeAssetId,
  encodeCoin,
  outcomeExpiryMs,
  parseSide,
  sideName,
  type OutcomeMeta,
  type Side,
} from "./hyperliquid.js";

const cfg = loadConfig();
const info = new HyperliquidInfo(cfg.hlApiUrl);

async function exchangeClient(): Promise<{ exchange: ExchangeClient; address: string }> {
  const account = await loadAccount(cfg);
  const transport = new HttpTransport({ isTestnet: cfg.testnet });
  return { exchange: new ExchangeClient({ transport, wallet: account }), address: account.address };
}

/** Signer address without constructing the exchange client (info-only commands). */
async function signerAddress(): Promise<string> {
  const account = await loadAccount(cfg);
  return account.address;
}

function validatePx(px: number): string {
  if (!(px > 0 && px < 1)) throw new Error(`price must be a probability in (0, 1), got ${px}`);
  return px.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0");
}

function validateSz(sz: number): string {
  if (!(sz > 0)) throw new Error(`size must be > 0 contracts, got ${sz}`);
  return String(sz);
}

async function labelFor(meta: OutcomeMeta, outcome: number): Promise<string> {
  const o = meta.outcomes.find((x) => x.outcome === outcome);
  return o ? describeOutcome(o, meta.questions) : `outcome ${outcome}`;
}

interface OrderStatus {
  filled?: { oid: number; avgPx: string; totalSz: string };
  resting?: { oid: number };
  error?: string;
}

async function placeOrder(outcome: number, side: Side, isBuy: boolean, px: number, sz: number, tif: "Gtc" | "Ioc" | "Alo") {
  const meta = await info.outcomeMeta();
  const label = await labelFor(meta, outcome);
  const coin = encodeCoin(outcome, side);
  const limitPx = validatePx(px);
  const size = validateSz(sz);

  console.log(`${isBuy ? "BUY" : "SELL"} ${size} ${sideName(side)} @ ${limitPx} (${tif}) on ${coin} — ${label}`);
  if (cfg.testnet) console.log("(testnet)");

  const { exchange, address } = await exchangeClient();
  console.log(`signer: ${address}${cfg.turnkey ? " (turnkey)" : " (raw key)"}`);

  const res = await exchange.order({
    orders: [
      {
        a: encodeAssetId(outcome, side),
        b: isBuy,
        p: limitPx,
        s: size,
        r: false,
        t: { limit: { tif } },
      },
    ],
    grouping: "na",
  });
  const status = res.response?.data?.statuses?.[0] as OrderStatus | undefined;
  if (status?.filled) {
    console.log(`filled ${status.filled.totalSz} @ ${status.filled.avgPx} (oid ${status.filled.oid})`);
  } else if (status?.resting) {
    console.log(`resting on book, oid ${status.resting.oid}`);
  } else if (status?.error) {
    console.error(`rejected: ${status.error}`);
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(res, null, 2));
  }
}

const program = new Command();
program
  .name("hip4")
  .description("CLI for Hyperliquid HIP-4 outcome markets, signing with a Turnkey wallet");

program
  .command("whoami")
  .description("Show the signing address and its USDC spot balance")
  .action(async () => {
    const address = await signerAddress();
    console.log(`address: ${address} ${cfg.turnkey ? "(turnkey)" : "(raw key)"}${cfg.testnet ? " [testnet]" : ""}`);
    const balances = await info.spotBalances(address);
    const usdc = balances.find((b) => b.coin === "USDC");
    console.log(`USDC: total=${usdc?.total ?? "0"} hold=${usdc?.hold ?? "0"}`);
  });

program
  .command("markets")
  .description("List live HIP-4 outcome markets with YES mids")
  .option("--all", "include near-resolved markets (mid <0.02 or >0.98)")
  .action(async (opts: { all?: boolean }) => {
    const [meta, mids] = await Promise.all([info.outcomeMeta(), info.allMids()]);
    const rows = meta.outcomes
      .map((o) => {
        const mid = mids[encodeCoin(o.outcome, YES)];
        const exp = outcomeExpiryMs(o, meta.questions);
        return {
          outcome: o.outcome,
          yesMid: mid !== undefined ? Number(mid) : null,
          expiry: exp ? new Date(exp).toISOString().slice(0, 16) : "?",
          market: describeOutcome(o, meta.questions),
        };
      })
      .filter((r): r is typeof r & { yesMid: number } => r.yesMid !== null)
      .filter((r) => opts.all || (r.yesMid > 0.02 && r.yesMid < 0.98));
    rows.sort((a, b) => a.expiry.localeCompare(b.expiry));
    console.table(rows);
    console.log(`${rows.length} shown / ${meta.outcomes.length} outcomes, ${meta.questions.length} questions`);
  });

program
  .command("book")
  .description("Show YES and NO order books for an outcome")
  .argument("<outcome>", "outcome index (from `hip4 markets`)", (v) => Number.parseInt(v, 10))
  .option("-d, --depth <n>", "levels per side", "5")
  .action(async (outcome: number, opts: { depth: string }) => {
    const depth = Number(opts.depth);
    const meta = await info.outcomeMeta();
    console.log(await labelFor(meta, outcome));
    const sides: Side[] = [YES, NO];
    for (const side of sides) {
      const coin = encodeCoin(outcome, side);
      const book = await info.l2Book(coin);
      console.log(`\n${sideName(side)} (${coin})`);
      const fmt = (l: { px: number; sz: number }) => `${l.px.toFixed(4)} x ${l.sz}`;
      console.log(`  asks: ${book.asks.slice(0, depth).map(fmt).join("  ") || "(empty)"}`);
      console.log(`  bids: ${book.bids.slice(0, depth).map(fmt).join("  ") || "(empty)"}`);
    }
  });

program
  .command("buy")
  .description("Buy outcome tokens (limit order, probability-space price)")
  .argument("<outcome>", "outcome index", (v) => Number.parseInt(v, 10))
  .argument("<side>", "yes | no", parseSide)
  .requiredOption("-p, --px <price>", "limit price in (0,1)", Number)
  .requiredOption("-s, --sz <contracts>", "number of contracts", Number)
  .option("-t, --tif <tif>", "Gtc | Ioc | Alo", "Gtc")
  .action(async (outcome: number, side: Side, opts: { px: number; sz: number; tif: "Gtc" | "Ioc" | "Alo" }) => {
    await placeOrder(outcome, side, true, opts.px, opts.sz, opts.tif);
  });

program
  .command("sell")
  .description("Sell outcome tokens you hold (limit order)")
  .argument("<outcome>", "outcome index", (v) => Number.parseInt(v, 10))
  .argument("<side>", "yes | no", parseSide)
  .requiredOption("-p, --px <price>", "limit price in (0,1)", Number)
  .requiredOption("-s, --sz <contracts>", "number of contracts", Number)
  .option("-t, --tif <tif>", "Gtc | Ioc | Alo", "Gtc")
  .action(async (outcome: number, side: Side, opts: { px: number; sz: number; tif: "Gtc" | "Ioc" | "Alo" }) => {
    await placeOrder(outcome, side, false, opts.px, opts.sz, opts.tif);
  });

program
  .command("orders")
  .description("List open orders for the signing address")
  .action(async () => {
    const address = await signerAddress();
    const [orders, meta] = await Promise.all([info.openOrders(address), info.outcomeMeta()]);
    const hip4 = orders.filter((o) => o.coin.startsWith("#"));
    if (hip4.length === 0) {
      console.log("no open HIP-4 orders");
      return;
    }
    const rows = await Promise.all(
      hip4.map(async (o) => {
        const { outcome, side } = decodeCoin(o.coin);
        return {
          oid: o.oid,
          coin: o.coin,
          dir: o.side === "B" ? "buy" : "sell",
          token: sideName(side),
          px: o.limitPx,
          sz: o.sz,
          market: (await labelFor(meta, outcome)).slice(0, 60),
        };
      }),
    );
    console.table(rows);
  });

program
  .command("cancel")
  .description("Cancel an open order by oid")
  .argument("<outcome>", "outcome index", (v) => Number.parseInt(v, 10))
  .argument("<side>", "yes | no", parseSide)
  .argument("<oid>", "order id (from `hip4 orders`)", (v) => Number.parseInt(v, 10))
  .action(async (outcome: number, side: Side, oid: number) => {
    const { exchange, address } = await exchangeClient();
    console.log(`cancel oid ${oid} on ${encodeCoin(outcome, side)} as ${address}`);
    const res = await exchange.cancel({ cancels: [{ a: encodeAssetId(outcome, side), o: oid }] });
    const status = res.response?.data?.statuses?.[0];
    console.log(status === "success" ? "cancelled" : JSON.stringify(status));
  });

program
  .command("positions")
  .description("Show held outcome tokens (spot balances on '+N' coins)")
  .action(async () => {
    const address = await signerAddress();
    const [balances, meta, mids] = await Promise.all([
      info.spotBalances(address),
      info.outcomeMeta(),
      info.allMids(),
    ]);
    const held = balances.filter((b) => b.coin.startsWith("+") && Number(b.total) > 0);
    if (held.length === 0) {
      console.log("no outcome token positions");
      return;
    }
    const rows = await Promise.all(
      held.map(async (b) => {
        const { outcome, side } = decodeCoin(b.coin);
        const mid = mids[encodeCoin(outcome, side)];
        return {
          coin: b.coin,
          token: sideName(side),
          sz: b.total,
          hold: b.hold,
          mid: mid ?? "?",
          market: (await labelFor(meta, outcome)).slice(0, 60),
        };
      }),
    );
    console.table(rows);
  });

program
  .command("watch")
  .description("Track YES mids and send a Telegram channel alert when a market moves past a threshold")
  .argument("[outcomes...]", "outcome indices to watch (from `hip4 markets`)")
  .option("-d, --delta <pct>", "alert threshold: relative % move of the YES mid since the last alert", "5")
  .option("--pp", "interpret --delta as probability percentage points instead of relative %")
  .option("-i, --interval <secs>", "poll interval in seconds", "30")
  .option("--all", "watch every live outcome market (auto-adds new listings)")
  .option("--positions", "watch the outcomes the signing wallet holds tokens in")
  .option("--user <address>", "watch the outcomes this address holds tokens in")
  .option("--heartbeat <mins>", "periodic digest of watched markets to the channel; 0 disables", "60")
  .action(
    async (
      outcomes: string[],
      opts: { delta: string; pp?: boolean; interval: string; all?: boolean; positions?: boolean; user?: string; heartbeat: string },
    ) => {
      const delta = Number(opts.delta);
      const intervalSecs = Number(opts.interval);
      if (!(delta > 0)) throw new Error(`--delta must be > 0, got "${opts.delta}"`);
      if (!(intervalSecs >= 2)) throw new Error(`--interval must be >= 2 seconds, got "${opts.interval}"`);
      const user = opts.user ?? (opts.positions ? await signerAddress() : null);
      const watcher = new Watcher(info, {
        intervalSecs,
        delta,
        asPoints: Boolean(opts.pp),
        all: Boolean(opts.all),
        user,
        heartbeatMins: Number(opts.heartbeat),
        telegram: cfg.telegram,
      });
      await watcher.run(outcomes.map((o) => Number.parseInt(o, 10)));
    },
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
