# hip4-cli

CLI for trading [Hyperliquid HIP-4 outcome markets](https://hyperliquid.gitbook.io/hyperliquid-docs) with a
[Turnkey](https://www.turnkey.com/) wallet as the signer. Orders are signed by a Turnkey-backed
viem account, so every trade is a Turnkey signing activity governed by your org's policies —
no raw private key on the machine running the CLI.

## Setup

```sh
npm install
cp .env.example .env   # fill in Turnkey credentials
```

| Variable | Meaning |
| --- | --- |
| `TURNKEY_API_PUBLIC_KEY` / `TURNKEY_API_PRIVATE_KEY` | API key pair of the Turnkey user the CLI acts as |
| `TURNKEY_ORGANIZATION_ID` | Org (or sub-org) that owns the wallet |
| `TURNKEY_SIGN_WITH` | Wallet account address (`0x…`) or private key id to sign with |
| `HL_TESTNET` | `true` to target Hyperliquid testnet |
| `SIGNER` | `turnkey` or `local`; unset = auto (Turnkey when configured, else local) |
| `WALLET_PRIVATE_KEY` | Local viem signer (alias: `HL_PRIVATE_KEY`) |
| `WALLET_MNEMONIC` / `WALLET_ACCOUNT_INDEX` | Local HD wallet alternative to a raw key |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Channel alerts for `watch` (bot must be a channel admin; chat id is `@name` or `-100…`) |

## Signers

Two interchangeable signer kinds back every trading command:

- **Turnkey** (default when configured): a viem account backed by Turnkey — every
  signature is a policy-controlled Turnkey activity, no key on this machine.
- **Local** (`SIGNER=local`, or auto when Turnkey is unset): a plain viem local account
  from `WALLET_PRIVATE_KEY` or an HD `WALLET_MNEMONIC`. Hot-wallet grade — handy for
  testnet and small experiments. `hip4 wallet new` generates one
  (`--save` writes it straight to `.env` without printing it).

## Funding & accounts

Getting from zero to trading HIP-4:

```sh
hip4 wallet new --save          # 1. a wallet (or configure Turnkey)
hip4 deposit 20                 # 2. send native USDC on Arbitrum to Bridge2 (min 5; needs USDC + ETH gas
                                #    on the SAME address — the bridge credits the sender)
hip4 move 20 spot               # 3. deposits land in perps; HIP-4 trades spot USDC
hip4 agent approve              # 4. (recommended) approve an agent/API wallet: it signs orders for the
                                #    master but can never withdraw; saved to .env, used automatically
hip4 buy 42 yes -p 0.55 -s 10   # 5. trade — resting GTC limit order by default
```

Sub-accounts for strategy isolation: `hip4 account create <name>`, `hip4 account list`,
`hip4 account fund <address> <usdc> [--withdraw]` (perps balance; `move` handles spot).

The agent split mirrors the app's "Enable Trading" signature and pairs well with Turnkey:
the Turnkey master holds funds behind org policies, while the lightweight agent key signs
the order flow. Deposits and account-level actions always use the master signer.

## Commands

```sh
npm run hip4 -- whoami                      # account + signer kind + spot/perps USDC
npm run hip4 -- wallet new [--save]         # generate a local wallet
npm run hip4 -- deposit 20                  # Arbitrum USDC -> Hyperliquid bridge
npm run hip4 -- move 20 spot                # perps <-> spot USDC
npm run hip4 -- agent approve               # approve an API wallet for order signing
npm run hip4 -- account create alpha        # sub-accounts
npm run hip4 -- markets                     # list live outcome markets with YES mids
npm run hip4 -- markets --all               # include near-resolved markets
npm run hip4 -- book 42                     # YES/NO books for outcome 42 (index or trade URL)
npm run hip4 -- book 42 --rpc               # best bid/offer direct from HyperCore via HyperEVM precompile
npm run hip4 -- book 42 -f -i 3             # follow: log top-of-book changes every 3s
npm run hip4 -- book 42 -f --jsonl book.jsonl   # also append full snapshots as JSON lines
npm run hip4 -- buy 42 yes -p 0.55 -s 100   # buy 100 YES @ 0.55 (GTC)
npm run hip4 -- buy 42 no -p 0.50 -s 50 -t Ioc
npm run hip4 -- sell 42 yes -p 0.70 -s 100
npm run hip4 -- orders                      # open orders
npm run hip4 -- cancel 42 yes 123456789     # cancel by oid
npm run hip4 -- positions                   # held outcome tokens
```

### Watch + Telegram alerts

```sh
npm run hip4 -- watch                       # watch the WATCH_WHITELIST from .env
npm run hip4 -- watch 10095 10097           # watch specific outcomes
npm run hip4 -- watch https://app.hyperliquid.xyz/trade/btc-above-82334-yes-oct-10-0600
npm run hip4 -- watch "BTC >="              # name pattern; auto-adds new matching listings
npm run hip4 -- watch --positions           # watch markets the signing wallet holds
npm run hip4 -- watch --user 0xabc…         # watch markets an address holds
npm run hip4 -- watch --all -d 10           # whole universe, alert on ≥10% moves
npm run hip4 -- watch 10095 -d 3 --pp -i 10 # ≥3 probability points, poll every 10s
```

Whitelist entries (CLI args, or `WATCH_WHITELIST` comma-separated in `.env` when run bare)
can be outcome indices, `app.hyperliquid.xyz/trade/...` URLs, or case-insensitive name
patterns. Pattern entries re-match every 10 minutes, so recurring markets (hourly BTC
binaries, weekly sports) keep getting picked up as they list; URL/index entries pin one
specific market.

### Position monitoring

With `--positions` (the signing wallet) or `--user <address>`, the watcher also polls the
wallet's outcome-token holdings every tick and notifies on: 📥 position opened or increased,
📤 reduced or closed — with size, average entry (from the clearinghouse cost basis), current
mid and unrealized PnL. Markets you take a position in are pulled into the watch set
automatically, and every alert/heartbeat for a held market carries a
`position: 100 YES @ avg 0.5500 | now 0.6200 | uPnL +7.00 USDC` line. The one-shot
`hip4 positions` table shows the same entry/uPnL columns.

`watch` polls YES mids and posts to the Telegram channel whenever a market moves at
least `--delta` since the **last alert** (the baseline resets each time it fires, so a
slow drift alerts once per threshold-worth of movement, not every tick). `--delta` is a
relative % of the YES mid by default; pass `--pp` to use absolute probability percentage
points instead — better for markets near 0 or 1, where relative % gets twitchy. It also
notifies when a watched market stops quoting (resolved/delisted), when `--all` picks up a
new listing, and sends an hourly digest (`--heartbeat 0` to disable). Without Telegram
env vars it still runs, logging alerts to the console.

Prices are probabilities in `(0, 1)`; sizes are contracts (each pays 1 USDC if it settles in
your favor).

### Order-book reads: API vs --rpc

Default `book` reads full L2 depth from the info API (HyperCore via REST). With `--rpc`
it instead calls the HyperEVM `bbo` read-precompile (`0x…080e`) with the outcome's asset
id — HyperCore state read directly on-chain, no REST on the hot path. Precompiles expose
top-of-book prices only (no sizes, no depth), and the outcome-token price scale is
undocumented, so the divisor is calibrated once against a single REST read. Set
`HL_EVM_RPC_URL` to use your own node; defaults to the public
`rpc.hyperliquid.xyz/evm`.

## HIP-4 encoding notes

- Order-book coin for `(outcome, side)` is `#(10*outcome + side)` where side `0 = YES`, `1 = NO`.
- Held tokens show up in spot balances as `+(10*outcome + side)`.
- The asset id in signed order actions is `100_000_000 + 10*outcome + side`.

## Build

```sh
npm run typecheck
npm run build        # emits dist/, exposes the `hip4` bin
```
