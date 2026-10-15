#!/usr/bin/env node
import { Command } from "commander";
import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import { loadConfig } from "./config.js";
import { newLocalWallet, resolveSigner } from "./wallet.js";
import { Watcher, parseMarketSlug, resolveSlug, type SlugSpec } from "./watch.js";
import { HyperliquidRpc, OutcomeBboReader } from "./rpc.js";
import { KRONOS_MODELS, kronosForecast, planForecast, type ForecastOptions } from "./forecast.js";
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
  // dotenv/config loads .env from the working directory, so save it there too.
  const envPath = `${process.cwd()}/.env`;
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
  .description("List open limit orders — the signer's, or any address's with --user; --tg posts to Telegram")
  .option("--user <address>", "read this address instead of the signing wallet")
  .option("--tg", "also post the result to the Telegram channel")
  .action(async (opts: { user?: string; tg?: boolean }) => {
    const address = opts.user ?? (await signerAddress());
    const [orders, meta, mids] = await Promise.all([info.openOrders(address), info.outcomeMeta(), info.allMids()]);
    const hip4 = orders.filter((o) => o.coin.startsWith("#"));
    const other = orders.length - hip4.length;
    const { marketUrl: urlFor } = await import("./watch.js");

    const blocks = hip4.map((o) => {
      const { outcome, side } = decodeCoin(o.coin);
      const m = meta.outcomes.find((x) => x.outcome === outcome);
      const label = m ? describeOutcome(m, meta.questions) : `outcome ${outcome}`;
      const exp = m ? outcomeExpiryMs(m, meta.questions) : null;
      const mid = mids[o.coin];
      const notional = Number(o.limitPx) * Number(o.sz);
      return [
        `• ${o.side === "B" ? "BUY" : "SELL"} ${o.sz} ${sideName(side)} @ ${o.limitPx} — ${label}  [#${outcome}]`,
        `  notional ${notional.toFixed(2)} USDC | mid now ${mid ?? "—"} | oid ${o.oid} | placed ${new Date(o.timestamp).toISOString().slice(5, 16)}Z`,
        ...(exp ? [`  expires ${new Date(exp).toISOString().slice(0, 16)} UTC`] : []),
        ...(m && urlFor(m) ? [`  ${urlFor(m)}`] : []),
      ].join("\n");
    });
    const text = [
      `📋 open HIP-4 orders for ${address}: ${hip4.length}${other > 0 ? ` (+${other} non-HIP-4 orders not shown)` : ""}`,
      ...blocks,
    ].join("\n\n");
    console.log(text);
    if (opts.tg) {
      if (!cfg.telegram) throw new Error("--tg needs TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID in .env");
      const { Telegram } = await import("./telegram.js");
      const tg = new Telegram(cfg.telegram.token, cfg.telegram.chatId);
      tg.send(text);
      await tg.flush();
      console.log("\n(sent to Telegram)");
    }
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
  .description("Show held outcome tokens — the signer's, or any address's with --user; --tg posts to Telegram")
  .option("--user <address>", "read this address instead of the signing wallet")
  .option("--tg", "also post the result to the Telegram channel")
  .action(async (opts: { user?: string; tg?: boolean }) => {
    const address = opts.user ?? (await signerAddress());
    const [balances, meta, mids] = await Promise.all([
      info.spotBalances(address),
      info.outcomeMeta(),
      info.allMids(),
    ]);
    const { marketUrl: urlFor } = await import("./watch.js");
    const held = balances.filter((b) => b.coin.startsWith("+") && Number(b.total) > 0);
    const usdc = balances.find((b) => b.coin === "USDC");

    let totalUpnl = 0;
    const blocks = held.map((b) => {
      const { outcome, side } = decodeCoin(b.coin);
      const m = meta.outcomes.find((x) => x.outcome === outcome);
      const label = m ? describeOutcome(m, meta.questions) : `outcome ${outcome}`;
      const exp = m ? outcomeExpiryMs(m, meta.questions) : null;
      const mid = mids[encodeCoin(outcome, side)];
      const sz = Number(b.total);
      const entryNtl = b.entryNtl !== undefined ? Number(b.entryNtl) : NaN;
      const entryPx = Number.isFinite(entryNtl) && sz > 0 ? entryNtl / sz : null;
      const upnl = entryPx !== null && mid !== undefined ? (Number(mid) - entryPx) * sz : null;
      if (upnl !== null) totalUpnl += upnl;
      return [
        `• ${b.total} ${sideName(side)} — ${label}  [#${outcome}]`,
        `  avg entry ${entryPx !== null ? entryPx.toFixed(4) : "?"} | mid now ${mid ?? "—"} | uPnL ${upnl !== null ? `${upnl >= 0 ? "+" : ""}${upnl.toFixed(2)} USDC` : "?"}${Number(b.hold) > 0 ? ` | ${b.hold} on hold (resting orders)` : ""}`,
        ...(exp ? [`  expires ${new Date(exp).toISOString().slice(0, 16)} UTC`] : []),
        ...(m && urlFor(m) ? [`  ${urlFor(m)}`] : []),
      ].join("\n");
    });
    const text = [
      `💼 HIP-4 positions for ${address}: ${held.length}` +
        ` | spot USDC ${usdc?.total ?? "0"}${held.length ? ` | total uPnL ${totalUpnl >= 0 ? "+" : ""}${totalUpnl.toFixed(2)} USDC` : ""}`,
      ...blocks,
    ].join("\n\n");
    console.log(text);
    if (opts.tg) {
      if (!cfg.telegram) throw new Error("--tg needs TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID in .env");
      const { Telegram } = await import("./telegram.js");
      const tg = new Telegram(cfg.telegram.token, cfg.telegram.chatId);
      tg.send(text);
      await tg.flush();
      console.log("\n(sent to Telegram)");
    }
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
  .command("forecast")
  .description("Kronos model probability for a price-binary market vs the market's own YES mid")
  .argument("<market>", "outcome index or app.hyperliquid.xyz trade URL (price binaries only)")
  .option("-n, --paths <n>", "independent forecast paths to sample", "30")
  .option("--temp <t>", "sampling temperature", "1.0")
  .option("--days <n>", "history window in days", "90")
  .option("--model <m>", "mini | small | base (mini has 4x the context)", "small")
  .option("--source <s>", "candle source: oracle (HL oracle-weighted median) | binance | okx | bybit | kraken | kucoin | gate | mexc | coinbase | hl", "binance")
  .action(async (market: string, opts: { paths: string; temp: string; days: string; model: string; source: string }) => {
    const fopts: ForecastOptions = {
      paths: Number(opts.paths),
      temperature: Number(opts.temp),
      days: Number(opts.days),
      model: opts.model,
      source: opts.source,
    };

    const { outcome, label } = await resolveMarket(market);
    const meta = await info.outcomeMeta();
    const o = meta.outcomes.find((x) => x.outcome === outcome);
    const fields = o ? priceBinaryFields(o) : null;
    if (!fields) throw new Error(`#${outcome} is not a price binary — forecast only supports "X >= K at T" markets`);
    const toExpiry = fields.expiryMs - Date.now();
    if (toExpiry <= 0) throw new Error(`#${outcome} already expired`);
    const plan = planForecast(fopts, toExpiry);

    console.log(`${label}  [#${outcome}]`);
    console.log(
      `underlying ${fields.underlying}, strike ${fields.threshold}, expires in ${(toExpiry / 3_600_000).toFixed(1)}h`,
    );
    console.log(
      `history: ${fopts.days}d of ${plan.interval} bars from ${fopts.source} (${plan.lookback} bars, Kronos-${fopts.model}) → predict ${plan.predLen} bars x ${fopts.paths} paths`,
    );
    console.log("running Kronos (first run downloads model weights)…");
    const out = await kronosForecast(info, fields, fopts);

    // Fair value from the same source: current price (the forming 1h candle's
    // close) and 7-day hourly realized vol.
    const { fetchCandles } = await import("./candles.js");
    const { digitalProb, realizedVol } = await import("./fairvalue.js");
    const now = Date.now();
    const hourly = await fetchCandles(fopts.source, info, fields.underlying, "1h", now - 170 * 3_600_000, now);
    const spotNow = Number(hourly.at(-1)!.c);
    const sigma = realizedVol(hourly.slice(0, -1).map((c) => Number(c.c)));
    const fair = digitalProb(spotNow, fields.threshold, sigma, (fields.expiryMs - now) / 3_600_000);

    const mids = await info.allMids();
    const yesMid = Number(mids[encodeCoin(outcome, YES)] ?? NaN);
    const edge = out.probAbove - yesMid;

    console.log(`\nspot now ${spotNow} (${fopts.source}) vs strike ${fields.threshold} (${(((spotNow - fields.threshold) / fields.threshold) * 100).toFixed(2)}%)`);
    console.log(`Kronos final close q10 ${out.finalClose.q10.toFixed(2)} / q50 ${out.finalClose.q50.toFixed(2)} / q90 ${out.finalClose.q90.toFixed(2)} (${out.device})`);
    console.log(`fair value P(YES): ${fair.toFixed(3)}  (vol ${(sigma * 100).toFixed(3)}%/h)`);
    console.log(`Kronos P(YES):     ${out.probAbove.toFixed(3)}`);
    console.log(`market YES mid:    ${Number.isFinite(yesMid) ? yesMid.toFixed(3) : "?"}`);
    if (Number.isFinite(yesMid)) {
      const side = edge > 0 ? "YES looks cheap" : "NO looks cheap";
      console.log(`Kronos edge: ${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}pp → ${Math.abs(edge) < 0.05 ? "no clear edge" : side}`);
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
  .option("--source <s>", "oracle | binance | okx | bybit | kraken | kucoin | gate | mexc | coinbase | hl", "binance")
  .option("--offsets <list>", "strike offsets vs spot, %", "-1,-0.5,0,0.5,1")
  .option("--method <m>", "kronos | digital (vol-based fair value) | both", "kronos")
  .option("--vol-bars <n>", "realized-vol window for the digital model, in 4h bars", "42")
  .action(async (underlying: string, opts: { trials: string; paths: string; model: string; source: string; offsets: string; method: string; volBars: string }) => {
    const variant = KRONOS_MODELS[opts.model];
    if (!variant) throw new Error(`--model must be mini, small or base, got "${opts.model}"`);
    if (!["kronos", "digital", "both"].includes(opts.method)) throw new Error(`--method must be kronos, digital or both`);
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

    const { fetchCandles } = await import("./candles.js");
    const raw = await fetchCandles(opts.source, info, underlying, interval, fromMs, now);
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

    const { printScore, scoreProbabilities } = await import("./scoring.js");
    if (opts.method !== "kronos") {
      const { digitalProb, realizedVol } = await import("./fairvalue.js");
      const volBars = Number(opts.volBars);
      const rows = trials.flatMap((tr) => {
        const closes = candles.slice(Math.max(0, tr.end - volBars - 1), tr.end).map((c) => Number(c.c));
        const sigma = realizedVol(closes);
        const spot = Number(candles[tr.end - 1]!.c);
        const settle = Number(candles[tr.outcome]!.c);
        return tr.strikes.map((k) => ({ prob: digitalProb(spot, k, sigma, predLen), y: settle >= k ? 1 : 0 }));
      });
      printScore(scoreProbabilities(rows), `digital fair value (${volBars}-bar realized vol), ${trials.length} days`);
      if (opts.method === "digital") return;
    }

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
      results: { prob: number; y: number }[];
    };
    printScore(scoreProbabilities(out.results), `Kronos-${opts.model} (${out.device}), ${out.trials} days`);
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
  .command("bot")
  .description("Real-time bot: buy outcome tokens that dip below their rolling high when the gate values them above the ask, sell on +take%. Paper by default")
  .argument("[markets...]", "outcome indices, trade URLs or name patterns (falls back to WATCH_WHITELIST)")
  .option("--dip <pct>", "buy when a token trades this % below its rolling high", "5")
  .option("--take <pct>", "sell when the bid reaches this % above entry", "5")
  .option("--stop <pct>", "optional stop-loss % below entry")
  .option("--window <mins>", "rolling-high window in minutes", "60")
  .option("--tick <secs>", "price check interval in seconds", "5")
  .option("--model-refresh <mins>", "re-run Kronos per market this often", "60")
  .option("--usd <n>", "USDC per trade", "20")
  .option("--max-open <n>", "max simultaneous positions", "3")
  .option("--max-loss <usd>", "stop opening trades after this realized loss (default 3x --usd)")
  .option("--min-hours <h>", "no new entries this close to expiry", "2")
  .option("--edge <pp>", "model must exceed the ask by this many probability points", "0")
  .option("--snipe <pp>", "also buy any side whose ask sits this many points below the live gate value (stale-quote catcher)")
  .option("--gate <g>", "fair (live digital fair value) | kronos | none", "fair")
  .option("--record <file>", "append every tick's token prices, spots and gate values (JSONL)", "bot-ticks.jsonl")
  .option("--no-record", "don't record ticks")
  .option("--kronos <m>", "Kronos variant for the gate: mini | small | base", "small")
  .option("--source <s>", "candle source for the gate (oracle = Hyperliquid's oracle-weighted venue median)", "oracle")
  .option("--live", "send real orders (default: paper fills against the live order book)")
  .option("--state <file>", "state file (default bot-state-paper.json / bot-state-live.json)")
  .action(
    async (
      markets: string[],
      opts: {
        dip: string; take: string; stop?: string; window: string; tick: string; modelRefresh: string; usd: string;
        maxOpen: string; maxLoss?: string; minHours: string; edge: string; snipe?: string; gate: string; record: string | false; kronos: string;
        source: string; live?: boolean; state?: string;
      },
    ) => {
      const { Bot, liveExecutor, paperExecutor } = await import("./bot.js");
      const { Telegram } = await import("./telegram.js");
      const num = (v: string, name: string, min = 0) => {
        const n = Number(v);
        if (!(n > min)) throw new Error(`--${name} must be > ${min}, got "${v}"`);
        return n;
      };
      const usd = num(opts.usd, "usd");
      if (opts.live && usd < 10) throw new Error("--usd must be at least 10 in live mode (Hyperliquid minimum order value)");
      if (!KRONOS_MODELS[opts.kronos]) throw new Error(`--kronos must be mini, small or base, got "${opts.kronos}"`);
      if (!["fair", "kronos", "none"].includes(opts.gate)) throw new Error(`--gate must be fair, kronos or none, got "${opts.gate}"`);

      const entries = markets.length > 0 ? markets : cfg.watchWhitelist;
      const { indices, slugs, patterns } = classifyWatchEntries(entries);

      let executor;
      if (opts.live) {
        const { exchange, address, kind } = await exchangeClient();
        console.log(`LIVE MODE — real orders from ${address} (${kind})`);
        executor = liveExecutor(exchange);
      } else {
        executor = paperExecutor();
      }

      const tg = cfg.telegram ? new Telegram(cfg.telegram.token, cfg.telegram.chatId) : null;
      const fopts: ForecastOptions = { paths: 50, temperature: 1, days: 90, model: opts.kronos, source: opts.source };
      const { openStore } = await import("./store.js");
      const store = await openStore(cfg.databaseUrl, {
        statePath: opts.state ?? `bot-state-${opts.live ? "live" : "paper"}.json`,
        ticksPath: opts.record === false ? null : opts.record,
      });
      const bot = await Bot.create(
        {
          dipPct: num(opts.dip, "dip"),
          takePct: num(opts.take, "take"),
          stopPct: opts.stop !== undefined ? num(opts.stop, "stop") : null,
          windowMins: num(opts.window, "window"),
          tickSecs: num(opts.tick, "tick", 1),
          modelRefreshMins: num(opts.modelRefresh, "model-refresh"),
          usdPerTrade: usd,
          maxOpen: num(opts.maxOpen, "max-open"),
          maxLossUsd: opts.maxLoss !== undefined ? num(opts.maxLoss, "max-loss") : usd * 3,
          minHoursToExpiry: Number(opts.minHours),
          gate: opts.gate as "fair" | "kronos" | "none",
          minEdge: Number(opts.edge) / 100,
          snipeEdge: opts.snipe !== undefined ? num(opts.snipe, "snipe") / 100 : null,
          recordTicks: opts.record !== false,
          indices,
          slugs,
          patterns,
        },
        {
          info,
          executor,
          forecast: (fields) => kronosForecast(info, fields, fopts).then((r) => r.probAbove),
          // Hourly realized vol over the last 7 days of 1h candles from the gate's source.
          vol: async (underlying) => {
            const { fetchCandles } = await import("./candles.js");
            const { realizedVol } = await import("./fairvalue.js");
            const now = Date.now();
            const candles = await fetchCandles(opts.source, info, underlying, "1h", now - 170 * 3_600_000, now);
            const closes = candles.slice(0, -1).map((c) => Number(c.c));
            if (closes.length < 48) throw new Error(`only ${closes.length} 1h candles for ${underlying}`);
            return realizedVol(closes);
          },
          store,
          notify: (text) => {
            console.log(`\n${text}`);
            tg?.send(text);
          },
        },
      );

      const ac = new AbortController();
      const stop = async () => {
        ac.abort();
        const open = bot.state.positions.length;
        const msg = `🤖 bot stopped — ${open} open position${open === 1 ? "" : "s"} left as-is, realized ${bot.realizedPnl().toFixed(2)} USDC`;
        console.log(`\n${msg}`);
        tg?.send(msg);
        await Promise.allSettled([tg?.flush(), store.end()]);
        process.exit(0);
      };
      process.on("SIGINT", () => void stop());
      process.on("SIGTERM", () => void stop());
      await bot.run(ac.signal);
    },
  );

program
  .command("report")
  .description("Bot performance from its store: open positions, closed trades, PnL by exit reason")
  .option("--live", "report the live bot (default: paper)")
  .option("--state <file>", "file store to read when DATABASE_URL is unset")
  .option("--since <t>", "only positions opened since: 5h / 90m / ISO time")
  .action(async (opts: { live?: boolean; state?: string; since?: string }) => {
    const { openStore, PgStore } = await import("./store.js");
    const mode = opts.live ? "live" : "paper";
    const store = await openStore(cfg.databaseUrl, { statePath: opts.state ?? `bot-state-${mode}.json`, ticksPath: null });
    try {
      const s = await store.load(mode);
      if (opts.since) {
        const since = parseSince(opts.since);
        s.positions = s.positions.filter((p) => p.openedAt >= since);
        s.closed = s.closed.filter((t) => t.openedAt >= since);
      }
      console.log(`${mode} bot — ${store.description}${opts.since ? ` — positions opened since ${opts.since}` : ""}`);
      const mids = await info.allMids();
      if (s.positions.length) {
        console.log("\nopen positions:");
        console.table(
          s.positions.map((p) => {
            const mid = Number(mids[encodeCoin(p.outcome, p.side)] ?? NaN);
            return {
              market: `${p.label.slice(0, 40)} [#${p.outcome}]`,
              side: sideName(p.side),
              sz: p.sz,
              entry: p.entryPx.toFixed(4),
              now: Number.isFinite(mid) ? mid.toFixed(4) : "resolved?",
              uPnL: Number.isFinite(mid) ? ((mid - p.entryPx) * p.sz).toFixed(2) : "?",
              opened: new Date(p.openedAt).toISOString().slice(5, 16),
            };
          }),
        );
      }
      if (s.closed.length) {
        console.log("\nclosed trades:");
        console.table(
          s.closed.map((t) => ({
            market: `${t.label.slice(0, 40)} [#${t.outcome}]`,
            side: sideName(t.side),
            sz: t.sz,
            entry: t.entryPx.toFixed(4),
            exit: t.exitPx.toFixed(4),
            reason: t.reason,
            pnl: t.pnl.toFixed(2),
            closed: new Date(t.closedAt).toISOString().slice(5, 16),
          })),
        );
        const by = new Map<string, { n: number; pnl: number }>();
        for (const t of s.closed) {
          const b = by.get(t.reason) ?? { n: 0, pnl: 0 };
          b.n++;
          b.pnl += t.pnl;
          by.set(t.reason, b);
        }
        const wins = s.closed.filter((t) => t.pnl > 0).length;
        const total = s.closed.reduce((a, t) => a + t.pnl, 0);
        console.log(
          `\n${s.closed.length} trades, ${wins} winners (${((wins / s.closed.length) * 100).toFixed(0)}%), realized ${total.toFixed(2)} USDC`,
        );
        console.log([...by].map(([r, b]) => `  ${r}: ${b.n} trades, ${b.pnl.toFixed(2)} USDC`).join("\n"));
      }
      if (!s.positions.length && !s.closed.length) console.log("no positions or trades yet");
      if (store instanceof PgStore) {
        const { rows } = await store.query<{ ticks: string; first: Date | null; last: Date | null }>(
          "SELECT count(DISTINCT ts) AS ticks, min(ts) AS first, max(ts) AS last FROM token_ticks",
        );
        const r = rows[0]!;
        if (r.first) console.log(`\nrecorded ${r.ticks} ticks from ${r.first.toISOString().slice(0, 16)} to ${r.last!.toISOString().slice(0, 16)}`);
      }
    } finally {
      await store.end();
    }
  });

/** "5h", "90m", "2d" ago, or an ISO timestamp. */
function parseSince(v: string): number {
  const rel = v.match(/^(\d+(?:\.\d+)?)([mhd])$/);
  if (rel) return Date.now() - Number(rel[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as "m" | "h" | "d"];
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new Error(`can't parse time "${v}" (use e.g. 5h, 90m or an ISO timestamp)`);
  return t;
}

program
  .command("sim")
  .description("Replay recorded ticks from Postgres through the bot's logic for a grid of strategy variants")
  .option("--since <t>", "window start: 5h / 90m / ISO time", "5h")
  .option("--until <t>", "window end (default now)")
  .option("--gates <list>", "gates to compare", "fair,none")
  .option("--dips <list>", "dip thresholds % to compare", "3,5,8")
  .option("--takes <list>", "take-profit % to compare", "3,5,8")
  .option("--stop <pct>", "stop-loss % (default none)")
  .option("--window <mins>", "rolling-high window", "60")
  .option("--usd <n>", "USDC per trade", "20")
  .option("--source <s>", "candle source for the fair gate's vol", "oracle")
  .action(
    async (opts: {
      since: string; until?: string; gates: string; dips: string; takes: string; stop?: string; window: string; usd: string; source: string;
    }) => {
      if (!cfg.databaseUrl) throw new Error("sim reads recorded ticks from Postgres: set DATABASE_URL");
      const { PgStore } = await import("./store.js");
      const { replay } = await import("./sim.js");
      const { fetchCandles } = await import("./candles.js");
      const { realizedVol } = await import("./fairvalue.js");
      const from = parseSince(opts.since);
      const to = opts.until ? parseSince(opts.until) : Date.now();
      const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

      const pg = await PgStore.connect(cfg.databaseUrl);
      try {
        const tok = await pg.query<{ ts: Date; coin: string; mid: number; bid: number | null; ask: number | null }>(
          "SELECT ts, coin, mid, bid, ask FROM token_ticks WHERE ts >= to_timestamp($1 / 1000.0) AND ts <= to_timestamp($2 / 1000.0) ORDER BY ts",
          [from, to],
        );
        const spots = await pg.query<{ ts: Date; underlying: string; px: number }>(
          "SELECT ts, underlying, px FROM spot_ticks WHERE ts >= to_timestamp($1 / 1000.0) AND ts <= to_timestamp($2 / 1000.0)",
          [from, to],
        );
        const byT = new Map<number, { t: number; tokens: Record<string, { mid: number; bid: number | null; ask: number | null }>; spot: Record<string, number> }>();
        for (const r of tok.rows) {
          const t = r.ts.getTime();
          const row = byT.get(t) ?? { t, tokens: {}, spot: {} };
          row.tokens[r.coin] = { mid: r.mid, bid: r.bid, ask: r.ask };
          byT.set(t, row);
        }
        for (const r of spots.rows) {
          const row = byT.get(r.ts.getTime());
          if (row) row.spot[r.underlying] = r.px;
        }
        const { fillGaps } = await import("./sim.js");
        const ticks = fillGaps([...byT.values()].sort((a, b) => a.t - b.t));
        if (ticks.length < 10) throw new Error(`only ${ticks.length} recorded ticks in that window`);
        const withBook = ticks.filter((t) => Object.values(t.tokens).some((v) => v.bid !== null)).length;
        if (withBook === 0) throw new Error("no ticks in that window carry bid/ask (recorded before top-of-book recording existed)");

        const outcomes = [...new Set(ticks.flatMap((t) => Object.keys(t.tokens).map((c) => Math.floor(Number(c.slice(1)) / 10))))];
        const markets = (
          await pg.query<{ outcome: number; name: string; description: string }>(
            "SELECT outcome, name, description FROM markets WHERE outcome = ANY($1::int[])",
            [outcomes],
          )
        ).rows;
        const missing = outcomes.filter((o) => !markets.some((m) => m.outcome === o));
        if (missing.length) console.warn(`no stored metadata for #${missing.join(", #")} — those markets are skipped`);

        const underlyings = [...new Set(markets.flatMap((m) => {
          const f = priceBinaryFields({ ...m, sideSpecs: [] });
          return f ? [f.underlying] : [];
        }))];
        const vols: Record<string, number> = {};
        for (const u of underlyings) {
          const c = await fetchCandles(opts.source, info, u, "1h", from - 170 * 3_600_000, from);
          vols[u] = realizedVol(c.map((x) => Number(x.c)));
        }

        const hours = (ticks.at(-1)!.t - ticks[0]!.t) / 3_600_000;
        console.log(
          `replaying ${ticks.length} ticks over ${hours.toFixed(1)}h (${new Date(ticks[0]!.t).toISOString().slice(0, 16)} → ${new Date(ticks.at(-1)!.t).toISOString().slice(0, 16)}), ` +
            `${markets.length} markets, vol ${Object.entries(vols).map(([u, v]) => `${u} ${(v * 100).toFixed(3)}%/h`).join(", ")}`,
        );

        const rows = [];
        for (const gate of list(opts.gates)) {
          if (gate !== "fair" && gate !== "none") throw new Error(`sim gates: fair | none, got "${gate}"`);
          for (const dip of list(opts.dips).map(Number)) {
            for (const take of list(opts.takes).map(Number)) {
              const r = await replay(
                ticks,
                markets,
                {
                  dipPct: dip, takePct: take, stopPct: opts.stop ? Number(opts.stop) : null, windowMins: Number(opts.window),
                  tickSecs: 5, modelRefreshMins: 60, usdPerTrade: Number(opts.usd), maxOpen: 3, maxLossUsd: Number(opts.usd) * 3,
                  minHoursToExpiry: 2, gate, minEdge: 0, snipeEdge: null,
                },
                vols,
              );
              rows.push({
                gate, dip, take,
                buys: r.trades + r.state.positions.length,
                closed: r.trades,
                wins: r.wins,
                realized: r.realized,
                "open@bid": r.unrealized,
                total: r.realized + r.unrealized,
              });
            }
          }
        }
        rows.sort((a, b) => b.total - a.total);
        console.table(rows.map((r) => ({ ...r, realized: r.realized.toFixed(2), "open@bid": r["open@bid"].toFixed(2), total: r.total.toFixed(2) })));
        console.log("PnL in USDC per variant; open positions marked at the last bid. Fills at recorded top of book, size unlimited.");
      } finally {
        await pg.end();
      }
    },
  );

const db = program.command("db").description("Postgres storage for the bot (DATABASE_URL)");
db.command("migrate")
  .description("Create the bot tables if they don't exist")
  .action(async () => {
    if (!cfg.databaseUrl) throw new Error("set DATABASE_URL first, e.g. postgres://localhost/hip4");
    const { PgStore } = await import("./store.js");
    const store = await PgStore.connect(cfg.databaseUrl);
    console.log(`schema ready on ${store.description}`);
    await store.end();
  });
db.command("import")
  .description("Copy a file-store bot state (and optional tick JSONL) into Postgres")
  .option("--state <file>", "bot state JSON", "bot-state-paper.json")
  .option("--ticks <file>", "tick JSONL recorded by the file store")
  .action(async (opts: { state: string; ticks?: string }) => {
    if (!cfg.databaseUrl) throw new Error("set DATABASE_URL first, e.g. postgres://localhost/hip4");
    const { FileStore, PgStore } = await import("./store.js");
    const { readFileSync, existsSync } = await import("node:fs");
    const raw = JSON.parse(readFileSync(opts.state, "utf8")) as { mode: "paper" | "live" };
    const state = await new FileStore(opts.state, null).load(raw.mode);
    const pg = await PgStore.connect(cfg.databaseUrl);
    try {
      for (const p of state.positions) await pg.savePosition(state.mode, p);
      for (const t of state.closed) await pg.saveTrade(state.mode, t);
      console.log(`imported ${state.positions.length} open positions and ${state.closed.length} trades (${state.mode})`);
      if (opts.ticks && existsSync(opts.ticks)) {
        let n = 0;
        for (const line of readFileSync(opts.ticks, "utf8").split("\n")) {
          if (!line.trim()) continue;
          const row = JSON.parse(line) as { t: number; tokens: Record<string, number>; spot: Record<string, number>; gate: Record<string, number> };
          await pg.recordTick({ ...row, gateKind: "fair" });
          n++;
        }
        console.log(`imported ${n} ticks`);
      }
    } finally {
      await pg.end();
    }
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
