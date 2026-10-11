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
  priceBinaryFields,
  sideName,
  type OutcomeMeta,
  type Side,
} from "./hyperliquid.js";

const cfg = loadConfig();
const info = new HyperliquidInfo(cfg.hlApiUrl);

/**
 * Exchange client for trading actions. Prefers the approved agent key (signs
 * orders, applies to the master account, cannot withdraw); falls back to the
 * master signer itself. `master: true` forces the master signer — required for
 * account-level actions (approveAgent, deposits, transfers, sub-accounts).
 */
async function exchangeClient(opts: { master?: boolean } = {}): Promise<{ exchange: ExchangeClient; address: string; kind: string }> {
  const transport = new HttpTransport({ isTestnet: cfg.testnet });
  if (!opts.master && cfg.agentPrivateKey) {
    const { privateKeyToAccount } = await import("viem/accounts");
    const agent = privateKeyToAccount(cfg.agentPrivateKey);
    const address = cfg.masterAddress ?? agent.address;
    return { exchange: new ExchangeClient({ transport, wallet: agent }), address, kind: "agent" };
  }
  const { account, kind } = await resolveSigner(cfg);
  return { exchange: new ExchangeClient({ transport, wallet: account }), address: account.address, kind };
}

/** The account whose state info commands read: master when configured, else the signer. */
async function signerAddress(): Promise<string> {
  if (cfg.masterAddress) return cfg.masterAddress;
  const { account } = await resolveSigner(cfg);
  return account.address;
}

/** Append env vars to .env, refusing to overwrite existing non-empty values. */
async function saveEnv(pairs: Record<string, string>): Promise<void> {
  const { readFile, writeFile } = await import("node:fs/promises");
  const envPath = new URL("../.env", import.meta.url).pathname;
  const existing = await readFile(envPath, "utf8").catch(() => "");
  for (const key of Object.keys(pairs)) {
    if (new RegExp(`^\\s*${key}\\s*=\\s*\\S`, "m").test(existing)) {
      throw new Error(`.env already has ${key} — refusing to overwrite it`);
    }
  }
  const lines = Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join("\n");
  await writeFile(envPath, `${existing}${existing.endsWith("\n") || existing === "" ? "" : "\n"}${lines}\n`);
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
    const address = await signerAddress();
    const signerKind = cfg.agentPrivateKey ? "agent key for orders" : (await resolveSigner(cfg)).kind;
    console.log(`account: ${address} (${signerKind})${cfg.testnet ? " [testnet]" : ""}`);
    const [balances, perpValue] = await Promise.all([info.spotBalances(address), info.perpAccountValue(address)]);
    const usdc = balances.find((b) => b.coin === "USDC");
    console.log(`spot USDC:  total=${usdc?.total ?? "0"} hold=${usdc?.hold ?? "0"}  (HIP-4 trades from here)`);
    console.log(`perps USDC: ${perpValue}  (deposits land here; \`hip4 move <amt> spot\` to trade HIP-4)`);
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
    await saveEnv({ WALLET_PRIVATE_KEY: privateKey });
    console.log("private key: saved to .env as WALLET_PRIVATE_KEY (not printed)");
  });

program
  .command("deposit")
  .description("Deposit USDC to Hyperliquid: sends native USDC on Arbitrum to the Bridge2 contract (min 5)")
  .argument("<usdc>", "amount of USDC", Number)
  .action(async (usdc: number) => {
    const { depositToBridge, MIN_DEPOSIT_USDC } = await import("./funds.js");
    void MIN_DEPOSIT_USDC;
    // The bridge credits the sender, so this must be the master signer, never the agent.
    const { account, kind } = await resolveSigner(cfg);
    console.log(`depositing ${usdc} USDC from ${account.address} (${kind})${cfg.testnet ? " [testnet]" : ""}`);
    const { hash } = await depositToBridge(cfg, account, usdc);
    console.log(`bridge transfer sent: ${hash}`);
    console.log("credited to the sending address on Hyperliquid in <1 min; lands in the PERPS balance —");
    console.log(`run \`hip4 move ${usdc} spot\` to make it tradable on HIP-4 markets`);
  });

program
  .command("move")
  .description("Move USDC between your perps and spot balances (HIP-4 trades spot USDC)")
  .argument("<usdc>", "amount of USDC", Number)
  .argument("<to>", "spot | perp")
  .action(async (usdc: number, to: string) => {
    if (!(usdc > 0)) throw new Error(`amount must be > 0, got ${usdc}`);
    if (to !== "spot" && to !== "perp") throw new Error(`destination must be "spot" or "perp", got "${to}"`);
    const { exchange, address, kind } = await exchangeClient({ master: true });
    console.log(`moving ${usdc} USDC to ${to} for ${address} (${kind})`);
    await exchange.usdClassTransfer({ amount: String(usdc), toPerp: to === "perp" });
    console.log("done");
  });

const agent = program.command("agent").description("Agent (API) wallets: sign orders for the master account, cannot withdraw");
agent
  .command("approve")
  .description("Generate an agent wallet, approve it with the master signer, and save it to .env")
  .option("--name <name>", "agent name (1-16 chars)", "hip4")
  .action(async (opts: { name: string }) => {
    const { exchange, address, kind } = await exchangeClient({ master: true });
    const { privateKey, address: agentAddress } = newLocalWallet();
    console.log(`approving agent ${agentAddress} ("${opts.name}") for master ${address} (${kind})`);
    await exchange.approveAgent({ agentAddress: agentAddress as `0x${string}`, agentName: opts.name });
    await saveEnv({ AGENT_PRIVATE_KEY: privateKey, MASTER_ADDRESS: address });
    console.log("approved — AGENT_PRIVATE_KEY and MASTER_ADDRESS saved to .env (key not printed)");
    console.log("orders now sign with the agent key; funds and withdrawals stay with the master");
  });

const account = program.command("account").description("Sub-accounts under the master account");
account
  .command("create")
  .description("Create a named sub-account")
  .argument("<name>", "sub-account name")
  .action(async (name: string) => {
    const { exchange, address, kind } = await exchangeClient({ master: true });
    console.log(`creating sub-account "${name}" under ${address} (${kind})`);
    const res = await exchange.createSubAccount({ name });
    console.log(JSON.stringify(res.response, null, 2));
  });
account
  .command("list")
  .description("List sub-accounts with balances")
  .action(async () => {
    const address = await signerAddress();
    const subs = await info.subAccounts(address);
    if (subs.length === 0) {
      console.log("no sub-accounts");
      return;
    }
    console.table(
      subs.map((s) => ({
        name: s.name,
        address: s.subAccountUser,
        perpUsd: s.clearinghouseState?.marginSummary?.accountValue ?? "?",
        spotUsdc: s.spotState?.balances?.find((b) => b.coin === "USDC")?.total ?? "0",
      })),
    );
  });
account
  .command("fund")
  .description("Transfer perps USDC into (or out of, with --withdraw) a sub-account")
  .argument("<address>", "sub-account address (from `hip4 account list`)")
  .argument("<usdc>", "amount of USDC", Number)
  .option("--withdraw", "pull funds from the sub-account back to the master")
  .action(async (subAddress: string, usdc: number, opts: { withdraw?: boolean }) => {
    if (!(usdc > 0)) throw new Error(`amount must be > 0, got ${usdc}`);
    const { exchange, address, kind } = await exchangeClient({ master: true });
    console.log(`${opts.withdraw ? "withdrawing" : "depositing"} ${usdc} USDC ${opts.withdraw ? "from" : "to"} ${subAddress} (master ${address}, ${kind})`);
    await exchange.subAccountTransfer({
      subAccountUser: subAddress as `0x${string}`,
      isDeposit: !opts.withdraw,
      usd: Math.round(usdc * 1e6),
    });
    console.log("done — note this moves PERPS balance; use `hip4 move` (with the sub-account suffix) for spot");
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

const INTERVALS: [string, number][] = [
  ["5m", 5 * 60_000],
  ["15m", 15 * 60_000],
  ["1h", 3_600_000],
  ["4h", 4 * 3_600_000],
  ["1d", 86_400_000],
];

/** Kronos variants; context length caps how many history bars the model actually sees. */
const KRONOS_MODELS: Record<string, { model: string; tokenizer: string; ctx: number }> = {
  mini: { model: "NeoQuasar/Kronos-mini", tokenizer: "NeoQuasar/Kronos-Tokenizer-2k", ctx: 2048 },
  small: { model: "NeoQuasar/Kronos-small", tokenizer: "NeoQuasar/Kronos-Tokenizer-base", ctx: 512 },
  base: { model: "NeoQuasar/Kronos-base", tokenizer: "NeoQuasar/Kronos-Tokenizer-base", ctx: 512 },
};

program
  .command("forecast")
  .description("Kronos model probability for a price-binary market vs the market's own YES mid")
  .argument("<market>", "outcome index or app.hyperliquid.xyz trade URL (price binaries only)")
  .option("-n, --paths <n>", "independent forecast paths to sample", "30")
  .option("--temp <t>", "sampling temperature", "1.0")
  .option("--days <n>", "history window in days", "90")
  .option("--model <m>", "mini | small | base (mini has 4x the context)", "small")
  .option("--source <s>", "candle source: binance | okx | hl", "binance")
  .action(async (market: string, opts: { paths: string; temp: string; days: string; model: string; source: string }) => {
    const variant = KRONOS_MODELS[opts.model];
    if (!variant) throw new Error(`--model must be mini, small or base, got "${opts.model}"`);
    const days = Number(opts.days);
    if (!(days > 0)) throw new Error(`--days must be > 0, got "${opts.days}"`);

    const { outcome, label } = await resolveMarket(market);
    const meta = await info.outcomeMeta();
    const o = meta.outcomes.find((x) => x.outcome === outcome);
    const fields = o ? priceBinaryFields(o) : null;
    if (!fields) throw new Error(`#${outcome} is not a price binary — forecast only supports "X >= K at T" markets`);

    const now = Date.now();
    const toExpiry = fields.expiryMs - now;
    if (toExpiry <= 0) throw new Error(`#${outcome} already expired`);

    // Finest interval whose bar count over the history window roughly fits the model
    // context (25% overflow allowed — the predictor keeps the newest ctx bars anyway).
    const windowMs = days * 86_400_000;
    const [interval, intervalMs] =
      INTERVALS.find(([, ms]) => windowMs / ms <= variant.ctx * 1.25) ?? INTERVALS[INTERVALS.length - 1]!;
    const lookback = Math.min(variant.ctx, Math.floor(windowMs / intervalMs));
    const predLen = Math.max(1, Math.ceil(toExpiry / intervalMs));
    if (predLen > 240) {
      throw new Error(`horizon is ${predLen} ${interval} bars — too far out for a stable sample; reduce --days or use --model mini`);
    }

    console.log(`${label}  [#${outcome}]`);
    console.log(
      `underlying ${fields.underlying}, strike ${fields.threshold}, expires in ${(toExpiry / 3_600_000).toFixed(1)}h`,
    );
    console.log(
      `history: ${days}d of ${interval} bars from ${opts.source} (${lookback} bars, Kronos-${opts.model}) → predict ${predLen} bars x ${opts.paths} paths`,
    );

    let raw: { t: number; o: string; h: string; l: string; c: string; v: string }[];
    const fromMs = now - intervalMs * (lookback + 2);
    if (opts.source === "binance") {
      const { binanceKlines, binanceSymbol } = await import("./binance.js");
      raw = await binanceKlines(binanceSymbol(fields.underlying), interval, fromMs, now);
    } else if (opts.source === "okx") {
      const { okxCandles, okxInstId } = await import("./okx.js");
      raw = await okxCandles(okxInstId(fields.underlying), interval, fromMs, now);
    } else if (opts.source === "hl") {
      raw = await info.candles(fields.underlying, interval, fromMs, now);
    } else {
      throw new Error(`--source must be binance, okx or hl, got "${opts.source}"`);
    }
    // Last candle is still forming; drop it so the model sees only closed bars.
    const closed = raw.slice(0, -1).slice(-lookback);
    if (closed.length < 50) throw new Error(`only ${closed.length} ${interval} candles from ${opts.source} — not enough history`);

    const { spawnSync } = await import("node:child_process");
    const kronosDir = new URL("../kronos", import.meta.url).pathname;
    const python = `${kronosDir}/venv/bin/python`;
    console.log("running Kronos (first run downloads model weights)…");
    const res = spawnSync(python, [`${kronosDir}/forecast.py`], {
      input: JSON.stringify({
        candles: closed,
        intervalMs,
        predLen,
        threshold: fields.threshold,
        paths: Number(opts.paths),
        temperature: Number(opts.temp),
        model: variant.model,
        tokenizer: variant.tokenizer,
        maxContext: variant.ctx,
      }),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15 * 60_000,
    });
    if (res.error || res.status !== 0) {
      throw new Error(
        `forecast sidecar failed (run kronos/setup.sh first?): ${res.error?.message ?? ""}\n${(res.stderr ?? "").slice(-800)}`,
      );
    }
    const out = JSON.parse(res.stdout.trim().split("\n").pop()!) as {
      device: string;
      probAbove: number;
      lastClose: number;
      finalClose: { q10: number; q50: number; q90: number; mean: number };
    };

    const mids = await info.allMids();
    const yesMid = Number(mids[encodeCoin(outcome, YES)] ?? NaN);
    const edge = out.probAbove - yesMid;

    console.log(`\nspot now ${out.lastClose} | model final close q10 ${out.finalClose.q10.toFixed(0)} / q50 ${out.finalClose.q50.toFixed(0)} / q90 ${out.finalClose.q90.toFixed(0)} (${out.device})`);
    console.log(`model P(YES):  ${out.probAbove.toFixed(3)}`);
    console.log(`market YES mid: ${Number.isFinite(yesMid) ? yesMid.toFixed(3) : "?"}`);
    if (Number.isFinite(yesMid)) {
      const side = edge > 0 ? "YES looks cheap" : "NO looks cheap";
      console.log(`edge: ${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}pp → ${Math.abs(edge) < 0.05 ? "no clear edge" : side}`);
    }
    console.log("(model estimate, not advice — small samples are noisy; close-vs-mark settlement differs)");
  });

program
  .command("backtest")
  .description("Validate Kronos probabilities on historical data: daily 24h binaries at strikes around spot")
  .argument("[underlying]", "coin, e.g. BTC or ETH", "BTC")
  .option("--trials <n>", "number of historical days to test", "60")
  .option("-n, --paths <n>", "sampled paths per trial", "50")
  .option("--model <m>", "mini | small | base", "mini")
  .option("--source <s>", "binance | okx | hl", "binance")
  .option("--offsets <list>", "strike offsets vs spot, %", "-1,-0.5,0,0.5,1")
  .action(async (underlying: string, opts: { trials: string; paths: string; model: string; source: string; offsets: string }) => {
    const variant = KRONOS_MODELS[opts.model];
    if (!variant) throw new Error(`--model must be mini, small or base, got "${opts.model}"`);
    const nTrials = Number(opts.trials);
    const offsets = opts.offsets.split(",").map((s) => Number(s) / 100);
    const interval = "4h";
    const intervalMs = 4 * 3_600_000;
    const predLen = 6; // 24h horizon
    const lookback = Math.min(variant.ctx, 512);

    const now = Date.now();
    const needBars = lookback + nTrials * predLen + predLen + 4;
    const fromMs = now - intervalMs * needBars;
    console.log(`backtest ${underlying}: ${nTrials} daily trials x ${offsets.length} strikes, ${opts.paths} paths, Kronos-${opts.model}, ${opts.source} ${interval} bars`);

    let raw: { t: number; o: string; h: string; l: string; c: string; v: string }[];
    if (opts.source === "binance") {
      const { binanceKlines, binanceSymbol } = await import("./binance.js");
      raw = await binanceKlines(binanceSymbol(underlying), interval, fromMs, now);
    } else if (opts.source === "okx") {
      const { okxCandles, okxInstId } = await import("./okx.js");
      raw = await okxCandles(okxInstId(underlying), interval, fromMs, now);
    } else {
      raw = await info.candles(underlying.toUpperCase(), interval, fromMs, now);
    }
    const candles = raw.slice(0, -1); // drop forming bar
    console.log(`${candles.length} closed bars fetched`);

    // Trials anchored at 00:00 UTC bars: context ends there, outcome = close 24h later.
    const trials: { end: number; strikes: number[]; outcome: number }[] = [];
    for (let i = candles.length - 1; i >= lookback && trials.length < nTrials; i--) {
      if (candles[i]!.t % 86_400_000 !== 0) continue;
      if (i + predLen - 1 >= candles.length) continue;
      const spot = Number(candles[i - 1]!.c);
      trials.push({ end: i, strikes: offsets.map((o) => spot * (1 + o)), outcome: i + predLen - 1 });
    }
    trials.reverse();
    if (trials.length < 10) throw new Error(`only ${trials.length} usable trials — not enough history from ${opts.source}`);
    console.log(`${trials.length} trials, running (model load + ${trials.length * Number(opts.paths)} sampled paths)…`);

    const { spawnSync } = await import("node:child_process");
    const kronosDir = new URL("../kronos", import.meta.url).pathname;
    const res = spawnSync(`${kronosDir}/venv/bin/python`, [`${kronosDir}/backtest.py`], {
      input: JSON.stringify({
        candles,
        trials,
        lookback,
        predLen,
        intervalMs,
        paths: Number(opts.paths),
        model: variant.model,
        tokenizer: variant.tokenizer,
        maxContext: variant.ctx,
      }),
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      timeout: 60 * 60_000,
      stdio: ["pipe", "pipe", "inherit"],
    });
    if (res.error || res.status !== 0) throw new Error(`backtest sidecar failed: ${res.error?.message ?? res.status}`);
    const out = JSON.parse(res.stdout.trim().split("\n").pop()!) as {
      device: string;
      trials: number;
      predictions: number;
      brier: number;
      brierAlways50: number;
      brierClimatology: number;
      accuracy: number;
      baseRate: number;
      calibration: { bucket: string; n: number; meanProb: number; freq: number }[];
    };

    console.log(`\n${out.predictions} predictions over ${out.trials} days (${out.device})`);
    console.log(`Brier score:        ${out.brier.toFixed(4)}  (lower is better)`);
    console.log(`  always-50% ref:   ${out.brierAlways50.toFixed(4)}`);
    console.log(`  climatology ref:  ${out.brierClimatology.toFixed(4)}  (base rate ${out.baseRate.toFixed(3)})`);
    console.log(`Accuracy @0.5:      ${(out.accuracy * 100).toFixed(1)}%`);
    console.log(`\nCalibration (model says → actually happens):`);
    console.table(out.calibration.map((b) => ({ "model says": b.bucket, n: b.n, "mean prob": b.meanProb.toFixed(3), "actual freq": b.freq.toFixed(3) })));
  });

program
  .command("replay")
  .description("Replay last week's HL daily binaries (reconstructed 06:00 UTC listings) and score the model")
  .option("--days <n>", "days back to replay", "7")
  .option("-n, --paths <n>", "sampled paths per market", "50")
  .option("--model <m>", "mini | small | base", "mini")
  .option("--underlyings <list>", "comma-separated coins", "BTC,ETH,SOL,HYPE")
  .action(async (opts: { days: string; paths: string; model: string; underlyings: string }) => {
    const variant = KRONOS_MODELS[opts.model];
    if (!variant) throw new Error(`--model must be mini, small or base, got "${opts.model}"`);
    const days = Number(opts.days);
    const hourMs = 3_600_000;
    const predLen = 24;
    const now = Date.now();
    const { spawnSync } = await import("node:child_process");
    const kronosDir = new URL("../kronos", import.meta.url).pathname;

    interface Row {
      coin: string;
      listed: string;
      strike: number;
      prob: number;
      settle: number;
      y: number;
    }
    const rows: Row[] = [];

    for (const coin of opts.underlyings.split(",").map((s) => s.trim().toUpperCase())) {
      const fromMs = now - hourMs * (variant.ctx + (days + 2) * 24);
      const raw = await info.candles(coin, "1h", fromMs, now);
      const candles = raw.slice(0, -1);
      const idxByT = new Map(candles.map((c, i) => [c.t, i]));

      const trials: { end: number; strikes: number[]; outcome: number }[] = [];
      for (let d = days; d >= 1; d--) {
        const listMs = Math.floor((now - d * 86_400_000) / 86_400_000) * 86_400_000 + 6 * hourMs;
        const expiryMs = listMs + 86_400_000;
        if (expiryMs > now) continue;
        const end = idxByT.get(listMs);
        const outcome = idxByT.get(expiryMs - hourMs);
        if (end === undefined || outcome === undefined || outcome !== end + predLen - 1) continue;
        trials.push({ end, strikes: [Number(candles[end - 1]!.c)], outcome });
      }
      if (trials.length === 0) {
        console.warn(`${coin}: no usable trials (not enough HL candle history)`);
        continue;
      }
      const lookback = Math.min(variant.ctx, Math.min(...trials.map((t) => t.end)));
      console.log(`${coin}: ${trials.length} markets, lookback ${lookback} 1h bars, ${opts.paths} paths…`);

      const res = spawnSync(`${kronosDir}/venv/bin/python`, [`${kronosDir}/backtest.py`], {
        input: JSON.stringify({
          candles,
          trials,
          lookback,
          predLen,
          intervalMs: hourMs,
          paths: Number(opts.paths),
          model: variant.model,
          tokenizer: variant.tokenizer,
          maxContext: variant.ctx,
        }),
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        timeout: 60 * 60_000,
        stdio: ["pipe", "pipe", "inherit"],
      });
      if (res.error || res.status !== 0) throw new Error(`replay sidecar failed for ${coin}: ${res.error?.message ?? res.status}`);
      const out = JSON.parse(res.stdout.trim().split("\n").pop()!) as {
        results: { t: number; spot: number; strike: number; prob: number; y: number }[];
      };
      for (const [i, r] of out.results.entries()) {
        const settle = Number(candles[trials[i]!.outcome]!.c);
        rows.push({ coin, listed: new Date(r.t).toISOString().slice(5, 10), strike: r.strike, prob: r.prob, settle, y: r.y });
      }
    }

    if (rows.length === 0) throw new Error("no markets replayed");
    console.log(`\nreconstructed HL daily binaries, model as-of listing (Kronos-${opts.model}, HL 1h candles):`);
    console.table(
      rows.map((r) => ({
        market: `${r.coin} >= ${r.strike} (${r.listed})`,
        "model P(YES)": r.prob.toFixed(2),
        settle: r.settle,
        resolved: r.y ? "YES" : "NO",
        hit: (r.prob > 0.5) === (r.y > 0.5) ? "✓" : "✗",
      })),
    );
    const brier = rows.reduce((a, r) => a + (r.prob - r.y) ** 2, 0) / rows.length;
    const acc = rows.filter((r) => (r.prob > 0.5) === (r.y > 0.5)).length / rows.length;
    const yesRate = rows.reduce((a, r) => a + r.y, 0) / rows.length;
    console.log(`\n${rows.length} markets | Brier ${brier.toFixed(4)} (always-50% = 0.25) | accuracy ${(acc * 100).toFixed(0)}% | YES base rate ${yesRate.toFixed(2)}`);
  });

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
