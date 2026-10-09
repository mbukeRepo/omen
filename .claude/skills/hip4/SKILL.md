---
name: hip4
description: Drive the hip4 CLI for Hyperliquid HIP-4 outcome (prediction) markets — list markets, read order books (REST or on-chain via HyperEVM precompile), place/cancel limit orders, check balances and positions with PnL, deposit USDC via the Arbitrum bridge, move funds between perps and spot, approve agent wallets, manage sub-accounts, and run the Telegram market watcher. Use this skill whenever the task touches Hyperliquid outcome markets, HIP-4, prediction/binary markets on Hyperliquid, YES/NO tokens, the hip4 command, this repo's trading or watching functionality, or funding a Hyperliquid account — even if the user doesn't name the CLI explicitly.
---

# hip4 — Hyperliquid HIP-4 outcome markets CLI

TypeScript CLI in this repo for trading Hyperliquid HIP-4 outcome markets. Run every
command from the repo root as:

```sh
mkdir -p .tmp && TMPDIR=$PWD/.tmp npx tsx src/cli.ts <command>   # the default temp dir is not writable in sandboxes
```

`npm run hip4 -- <command>` is equivalent. Config comes from `.env` (see `.env.example`).

## Safety rules (read first)

- **Never place orders, deposit, move funds, approve agents, or transfer between accounts
  unless the user explicitly asked for that action in this conversation.** Read-only
  commands (markets, book, whoami, orders, positions, account list, watch) are always safe.
- Echo the exact market, side, price, and size back in your summary after trading.
- Prices are **probabilities in (0, 1)** — e.g. `0.55`, never `55`. Sizes are contracts
  (each pays 1 USDC if it settles in the holder's favor).
- Deposits below 5 USDC are **lost forever** (the CLI blocks them; don't work around it).
- HIP-4 trades **spot** USDC. Bridge deposits land in **perps** — `move` them first.

## Identify a market

Markets are indexed by an **outcome number**. Three ways to reference one:

- outcome index, from `markets` (e.g. `10177`)
- trade URL, e.g. `https://app.hyperliquid.xyz/trade/btc-above-82334-yes-oct-10-0600`
  (works for `book` and `watch`)
- name pattern for `watch` (e.g. `"BTC >="`), case-insensitive substring

```sh
hip4 markets            # live markets with YES mids + expiry (--all includes near-resolved)
hip4 book 10177         # full YES/NO depth via the info API (also accepts a trade URL)
hip4 book 10177 --rpc   # best bid/offer read directly from HyperCore via HyperEVM precompile
hip4 book 10177 -f -i 3 --jsonl book.jsonl   # follow top-of-book changes, log snapshots
```

## Trading (requires a configured signer)

```sh
hip4 buy 10177 yes -p 0.55 -s 100           # resting GTC limit by default
hip4 buy 10177 no  -p 0.40 -s 50 -t Ioc     # -t Gtc|Ioc|Alo
hip4 sell 10177 yes -p 0.70 -s 100
hip4 orders                                  # open orders with oids
hip4 cancel 10177 yes 123456789              # cancel by outcome, side, oid
hip4 positions                               # held tokens: size, avg entry, mid, uPnL
hip4 whoami                                  # account, signer kind, spot + perps USDC
```

"Tradable USDC" for HIP-4 = the **spot** line of `whoami`. `book` prints asks and bids
best-first as `price x size`; `positions` is a table with avg entry and uPnL columns.

Signers (resolved automatically; `whoami` shows which is active):
- **Turnkey** when `TURNKEY_*` env is set — signatures are policy-controlled activities.
- **Local** viem wallet from `WALLET_PRIVATE_KEY` or `WALLET_MNEMONIC`; generate with
  `hip4 wallet new --save` (writes the key to `.env` without printing it).
- **Agent** key (`AGENT_PRIVATE_KEY`) is preferred for orders when present: it signs
  trades for the master account but cannot withdraw.
- `SIGNER=turnkey|local` in `.env` forces a choice.

## Funding (all sign with the master, never the agent)

```sh
hip4 deposit 20        # native USDC on Arbitrum -> Bridge2; credits the SENDER, so the
                       # USDC + ETH gas must sit on the master address itself (min 5)
hip4 move 20 spot      # perps -> spot (deposits land in perps; HIP-4 needs spot)
hip4 agent approve     # create+approve an API wallet for order signing, saved to .env
hip4 account create alpha           # sub-accounts for strategy isolation
hip4 account list
hip4 account fund 0x... 50          # perps USDC into a sub-account (--withdraw to pull back)
```

## Watching + Telegram alerts

```sh
hip4 watch                          # markets from WATCH_WHITELIST in .env
hip4 watch 10177 "BTC >=" -d 5      # indices / URLs / name patterns, alert on >=5% moves
hip4 watch 10177 -d 3 --pp -i 10    # threshold in probability points, poll every 10s
hip4 watch --positions              # markets the wallet holds + position open/close/uPnL alerts
hip4 watch --all -d 10              # whole universe, auto-adds new listings
```

Alerts go to the Telegram channel when `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are set
(console-only otherwise). Messages carry YES/NO mids, top-of-book, session performance,
expiry countdown, trade URL, and position uPnL. Pattern entries re-match every 10 min so
recurring listings (hourly BTC binaries) keep getting picked up. It's a long-running
foreground process — run it in the background (`nohup ... > watch.log 2>&1 &`) and check
`watch.log`.

## HIP-4 encoding (for debugging raw data)

- Book coin for (outcome, side): `#(10*outcome + side)`, side 0=YES 1=NO
- Held tokens in spot balances: `+(10*outcome + side)`
- Asset id in signed actions: `100_000_000 + 10*outcome + side`
- NO has its own book; its mid is close to, but not exactly, `1 - YES`.

## Troubleshooting

- `EACCES ... /var/folders/...`: prefix with `TMPDIR=$PWD/.tmp`.
- Order rejected / no signer: check `whoami`; trading needs Turnkey, a local key, or an agent key in `.env`.
- "no live outcome matches" for a URL: the market expired or isn't listed yet — `hip4 markets` to find the current listing.
- Zero spot USDC but funds deposited: they're in perps — `hip4 move <amt> spot`.
- Full command/flag detail: `npx tsx src/cli.ts <command> --help`, or read `README.md`.
