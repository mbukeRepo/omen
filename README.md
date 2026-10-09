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
| `HL_PRIVATE_KEY` | Dev-only fallback signer when Turnkey vars are unset |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Channel alerts for `watch` (bot must be a channel admin; chat id is `@name` or `-100…`) |

## Commands

```sh
npm run hip4 -- whoami                      # signer address + USDC balance
npm run hip4 -- markets                     # list live outcome markets with YES mids
npm run hip4 -- markets --all               # include near-resolved markets
npm run hip4 -- book 42                     # YES/NO books for outcome 42
npm run hip4 -- buy 42 yes -p 0.55 -s 100   # buy 100 YES @ 0.55 (GTC)
npm run hip4 -- buy 42 no -p 0.50 -s 50 -t Ioc
npm run hip4 -- sell 42 yes -p 0.70 -s 100
npm run hip4 -- orders                      # open orders
npm run hip4 -- cancel 42 yes 123456789     # cancel by oid
npm run hip4 -- positions                   # held outcome tokens
```

### Watch + Telegram alerts

```sh
npm run hip4 -- watch 10095 10097           # watch specific outcomes
npm run hip4 -- watch --positions           # watch markets the signing wallet holds
npm run hip4 -- watch --user 0xabc…         # watch markets an address holds
npm run hip4 -- watch --all -d 10           # whole universe, alert on ≥10% moves
npm run hip4 -- watch 10095 -d 3 --pp -i 10 # ≥3 probability points, poll every 10s
```

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

## HIP-4 encoding notes

- Order-book coin for `(outcome, side)` is `#(10*outcome + side)` where side `0 = YES`, `1 = NO`.
- Held tokens show up in spot balances as `+(10*outcome + side)`.
- The asset id in signed order actions is `100_000_000 + 10*outcome + side`.

## Build

```sh
npm run typecheck
npm run build        # emits dist/, exposes the `hip4` bin
```
