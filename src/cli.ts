#!/usr/bin/env node
import { Command } from "commander";
import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import { loadConfig } from "./config.js";
import { newLocalWallet, resolveSigner } from "./wallet.js";
import { Watcher, parseMarketSlug, resolveSlug, type SlugSpec } from "./watch.js";
import { HyperliquidRpc, OutcomeBboReader } from "./rpc.js";
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

async function exchangeClient(): Promise<{ exchange: ExchangeClient; address: string; kind: string }> {
  const { account, kind } = await resolveSigner(cfg);
  const transport = new HttpTransport({ isTestnet: cfg.testnet });
  return { exchange: new ExchangeClient({ transport, wallet: account }), address: account.address, kind };
}

/** Signer address without constructing the exchange client (info-only commands). */
async function signerAddress(): Promise<string> {
  const { account } = await resolveSigner(cfg);
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

  const { exchange, address, kind } = await exchangeClient();
  console.log(`signer: ${address} (${kind})`);

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
    const { account, kind } = await resolveSigner(cfg);
    console.log(`address: ${account.address} (${kind})${cfg.testnet ? " [testnet]" : ""}`);
    const balances = await info.spotBalances(account.address);
    const usdc = balances.find((b) => b.coin === "USDC");
    console.log(`USDC: total=${usdc?.total ?? "0"} hold=${usdc?.hold ?? "0"}`);
  });

program
  .command("wallet")
  .description("Local wallet utilities")
  .command("new")
  .description("Generate a new local wallet (hot-wallet grade — use Turnkey for real funds)")
  .option("--save", "write WALLET_PRIVATE_KEY to .env (refuses to overwrite an existing one)")
  .action(async (opts: { save?: boolean }) => {
    const { privateKey, address } = newLocalWallet();
    console.log(`address:     ${address}`);
    if (!opts.save) {
      console.log(`private key: ${privateKey}`);
      console.log("store it safely; pass --save to write it to .env instead of printing");
      return;
    }
    const { readFile, writeFile } = await import("node:fs/promises");
    const envPath = new URL("../.env", import.meta.url).pathname;
    const existing = await readFile(envPath, "utf8").catch(() => "");
    if (/^\s*WALLET_PRIVATE_KEY\s*=\s*0x/m.test(existing)) {
      throw new Error(".env already has a WALLET_PRIVATE_KEY — refusing to overwrite it");
    }
    await writeFile(envPath, `${existing}${existing.endsWith("\n") || existing === "" ? "" : "\n"}WALLET_PRIVATE_KEY=${privateKey}\n`);
    console.log("private key: saved to .env as WALLET_PRIVATE_KEY (not printed)");
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

/** Resolve a market argument — outcome index or app.hyperliquid.xyz trade URL/slug. */
async function resolveMarket(market: string): Promise<{ outcome: number; label: string }> {
  const meta = await info.outcomeMeta();
  if (/^\d+$/.test(market)) {
    const outcome = Number.parseInt(market, 10);
    return { outcome, label: await labelFor(meta, outcome) };
  }
  const slug = parseMarketSlug(market);
  if (!slug) throw new Error(`"${market}" is neither an outcome index nor a trade URL/slug`);
  const outcome = resolveSlug(meta, slug);
  if (outcome === null) throw new Error(`no live outcome matches "${market}" (expired or not yet listed?)`);
  return { outcome, label: await labelFor(meta, outcome) };
}

program
  .command("book")
  .description("Read YES/NO order books — via the info API, or directly from HyperCore with --rpc")
  .argument("<market>", "outcome index (from `hip4 markets`) or app.hyperliquid.xyz trade URL")
  .option("-d, --depth <n>", "levels per side (API mode)", "5")
  .option("-f, --follow", "keep polling and log top-of-book changes")
  .option("-i, --interval <secs>", "poll interval with --follow", "5")
  .option("--rpc", "read best bid/offer from the HyperEVM bbo precompile (HyperCore state, prices only)")
  .option("--jsonl <file>", "append each snapshot as a JSON line to this file")
  .action(async (market: string, opts: { depth: string; follow?: boolean; interval: string; rpc?: boolean; jsonl?: string }) => {
    const depth = Number(opts.depth);
    const intervalMs = Math.max(1, Number(opts.interval)) * 1000;
    const { outcome, label } = await resolveMarket(market);
    console.log(`${label}  [#${outcome}]${opts.rpc ? `  (rpc: ${cfg.evmRpcUrl})` : ""}`);

    const bboReader = opts.rpc ? new OutcomeBboReader(new HyperliquidRpc(cfg.evmRpcUrl), info, outcome) : null;
    const jsonl = opts.jsonl
      ? await import("node:fs").then((fs) => fs.createWriteStream(opts.jsonl!, { flags: "a" }))
      : null;
    const logSnapshot = (snap: unknown) => jsonl?.write(`${JSON.stringify(snap)}\n`);
    const fmtPx = (v: number | null | undefined) => (v !== null && v !== undefined ? v.toFixed(4) : "—");

    /** One read; returns a change-detection key and prints/logs. */
    const readOnce = async (prevKey: string | null): Promise<string> => {
      const ts = new Date().toISOString();
      if (bboReader) {
        const bbo = await bboReader.read();
        if (!bbo) {
          console.log(`${ts.slice(11, 19)} calibrating price scale (book one-sided?) — retrying`);
          return prevKey ?? "";
        }
        const line =
          `YES ${fmtPx(bbo.yes.bid)}/${fmtPx(bbo.yes.ask)} | NO ${fmtPx(bbo.no.bid)}/${fmtPx(bbo.no.ask)}`;
        if (line !== prevKey) console.log(`${ts.slice(11, 19)} [rpc] ${line}`);
        logSnapshot({ ts, outcome, src: "rpc", ...bbo });
        return line;
      }
      const [yes, no] = await Promise.all([
        info.l2Book(encodeCoin(outcome, YES)),
        info.l2Book(encodeCoin(outcome, NO)),
      ]);
      logSnapshot({ ts, outcome, src: "api", yes, no });
      if (!opts.follow) {
        const sides: [Side, typeof yes][] = [
          [YES, yes],
          [NO, no],
        ];
        for (const [side, book] of sides) {
          console.log(`\n${sideName(side)} (${encodeCoin(outcome, side)})`);
          const fmt = (l: { px: number; sz: number }) => `${l.px.toFixed(4)} x ${l.sz}`;
          console.log(`  asks: ${book.asks.slice(0, depth).map(fmt).join("  ") || "(empty)"}`);
          console.log(`  bids: ${book.bids.slice(0, depth).map(fmt).join("  ") || "(empty)"}`);
        }
        return "";
      }
      const tob = (b: typeof yes) =>
        `${fmtPx(b.bids[0]?.px)} x ${b.bids[0]?.sz ?? 0} / ${fmtPx(b.asks[0]?.px)} x ${b.asks[0]?.sz ?? 0}`;
      const line = `YES ${tob(yes)} | NO ${tob(no)}`;
      if (line !== prevKey) console.log(`${ts.slice(11, 19)} ${line}`);
      return line;
    };

    let key = await readOnce(null);
    if (!opts.follow && !bboReader) return;
    if (!opts.follow) return;
    for (;;) {
      await new Promise((r) => setTimeout(r, intervalMs));
      try {
        key = await readOnce(key);
      } catch (err) {
        console.warn(`read failed, retrying: ${String(err).slice(0, 150)}`);
      }
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
        const sz = Number(b.total);
        const entryNtl = b.entryNtl !== undefined ? Number(b.entryNtl) : NaN;
        const entryPx = Number.isFinite(entryNtl) && sz > 0 ? entryNtl / sz : null;
        const upnl = entryPx !== null && mid !== undefined ? (Number(mid) - entryPx) * sz : null;
        return {
          coin: b.coin,
          token: sideName(side),
          sz: b.total,
          hold: b.hold,
          entry: entryPx !== null ? entryPx.toFixed(4) : "?",
          mid: mid ?? "?",
          uPnL: upnl !== null ? `${upnl >= 0 ? "+" : ""}${upnl.toFixed(2)}` : "?",
          market: (await labelFor(meta, outcome)).slice(0, 60),
        };
      }),
    );
    console.table(rows);
  });

/** Classify watchlist entries: outcome index, trade URL/slug, or name pattern. */
function classifyWatchEntries(entries: string[]): { indices: number[]; slugs: SlugSpec[]; patterns: string[] } {
  const indices: number[] = [];
  const slugs: SlugSpec[] = [];
  const patterns: string[] = [];
  for (const e of entries) {
    if (/^\d+$/.test(e)) {
      indices.push(Number.parseInt(e, 10));
      continue;
    }
    const slug = parseMarketSlug(e);
    if (slug) slugs.push(slug);
    else patterns.push(e.toLowerCase());
  }
  return { indices, slugs, patterns };
}

program
  .command("watch")
  .description("Track YES mids and send a Telegram channel alert when a market moves past a threshold")
  .argument(
    "[markets...]",
    "whitelist: outcome indices, app.hyperliquid.xyz trade URLs, or name patterns (falls back to WATCH_WHITELIST env)",
  )
  .option("-d, --delta <pct>", "alert threshold: relative % move of the YES mid since the last alert", "5")
  .option("--pp", "interpret --delta as probability percentage points instead of relative %")
  .option("-i, --interval <secs>", "poll interval in seconds", "30")
  .option("--all", "watch every live outcome market (auto-adds new listings)")
  .option("--positions", "watch the outcomes the signing wallet holds tokens in")
  .option("--user <address>", "watch the outcomes this address holds tokens in")
  .option("--heartbeat <mins>", "periodic digest of watched markets to the channel; 0 disables", "60")
  .action(
    async (
      markets: string[],
      opts: { delta: string; pp?: boolean; interval: string; all?: boolean; positions?: boolean; user?: string; heartbeat: string },
    ) => {
      const delta = Number(opts.delta);
      const intervalSecs = Number(opts.interval);
      if (!(delta > 0)) throw new Error(`--delta must be > 0, got "${opts.delta}"`);
      if (!(intervalSecs >= 2)) throw new Error(`--interval must be >= 2 seconds, got "${opts.interval}"`);
      const entries = markets.length > 0 ? markets : cfg.watchWhitelist;
      if (markets.length === 0 && entries.length > 0) {
        console.log(`using WATCH_WHITELIST: ${entries.join(", ")}`);
      }
      const { indices, slugs, patterns } = classifyWatchEntries(entries);
      const user = opts.user ?? (opts.positions ? await signerAddress() : null);
      const watcher = new Watcher(info, {
        intervalSecs,
        delta,
        asPoints: Boolean(opts.pp),
        all: Boolean(opts.all),
        patterns,
        user,
        heartbeatMins: Number(opts.heartbeat),
        telegram: cfg.telegram,
      });
      await watcher.run(indices, slugs);
    },
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
