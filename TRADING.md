# Trading BTC outcome markets on Hyperliquid — field guide

Everything below was measured on live HIP-4 markets Oct 10–14, 2026: 28k recorded ticks,
five settled daily binaries, two 60-day backtests, a 28-market week replay, and one
money-losing (paper) bot. Rules of thumb, not gospel; sample sizes are honest but small.

## 1. Know the instrument

- A daily binary ("BTC >= K at 06:00 UTC") is a token that pays 1 USDC or 0. The strike is
  set at spot when it lists, so **every daily starts as a coin flip and usually stays one**.
- Sensitivity is brutal near expiry: at ~19h out, YES moves ~28pp per 1% of spot; the token
  routinely swings ±20–25% intraday. Both profit targets and wipeouts are "normal moves".
- Settlement is the venue oracle price at the exact expiry second — not a candle close, and
  a market can flip in the final hour (Oct 14 settled NO after being above strike 65 min out).
- Books are thin: top-of-book on dailies is $10–70, spreads 1.6–7pp. Ignore any "price" on a
  market whose book is 0.001 bid / 0.999 ask — the 0.50 mid is an artifact, not a market.

## 2. What the data says about edge

- **The market is efficient to the spread.** Average |fair value − mid| ≈ 1.6–2.8pp, which
  equals the spread. There is no standing mispricing to harvest in liquid markets.
- **When price diverges from your model, the market is usually right.** Every "trade toward
  fair value and hold" entry lost (8/8). Divergence = information (momentum, flow), not error.
- **Every taker strategy tested lost:** 54 dip-buy variants, fair-edge holds, buy-and-hold
  either side. What they all paid was the spread plus the trend.
- **The one structurally positive seat is the maker's:** whoever rests both-side quotes earns
  the 1.5–3.5pp that every taker pays. The deepest HIP-4 books (HYPE 1-minute markets,
  $2.5k+ top) are where makers already live.
- **Models:** the digital fair value (spot, strike, time, realized vol — `Φ(d2)`) is
  calibrated in the 0.4–1.0 range (Brier ~0.21 vs 0.25 coin-flip) and is your pricing ruler.
  Kronos is a momentum opinion: calibrated off-strike in backtest, but long-biased in
  trending weeks (26/28 YES calls in a down week) and it lost its big live calls. At the
  money, with hours left, **every model is a coin flip** — the backtests say so directly.

## 3. When to trade (and when not)

Default stance: **flat**. A knife-edge binary plus a spread toll is negative expectancy.
Trade only these three setups:

**A. Event dislocation (seconds-to-minutes after a macro print).**
Scheduled events (CPI, FOMC) move spot ~0.5–1.5% in minutes; thin token books reprice late.
Buy the side whose ask sits ≥5pp below live fair value *after* the move is in hand.
This is the only taker trade where you're faster than the book is wide.

**B. Post-confirmation favorite (hold to settlement).**
30–60 min after an event, direction established, spot ≥0.5% beyond the strike, leading side
at 0.75–0.83: buying it pays +20–33% at settlement at roughly fair odds, paying only spread.
Hard rule: exit if spot recrosses the strike. Never enter this *before* the event.

**C. Passive making.**
Rest Alo (post-only) quotes both sides around fair value on wide-spread markets; rebalance
with spot; cap inventory per side; **flatten everything 2–3h before settlement** — never
carry maker inventory into the pin.

Never: hold a position within 0.3% of the strike into the final 2 hours (unless it's play B
and the token already trades ≥0.8); buy dips in a trending underlying; trade before a
scheduled print; cross the spread without a dislocation reason.

## 4. Risk rules

- Unit of risk = **total loss**. Tokens go to 0; no stop protects a gap to settlement
  (our bot's stops turned one big loss into 20 spread-tolls — worse).
- ≤2–3% of capital per market, ≤3 concurrent, and a hard daily max-loss that halts entries.
- Size to the book: top-of-book is often <$70 on dailies; your order IS the market impact.
- Time your day around 06:00 UTC settlement and the macro calendar (check it first thing);
  the US-open hour (13:30 UTC) runs 2.5× normal vol and *fades* the pre-open move 64% of
  the time; this week's crashes came in off-US hours via liquidation cascades.

## 5. Process

- Paper first, always (`hip4 bot` is paper by default; live needs `--live` and funding).
- Record everything (ticks → Postgres); HL deletes expired markets' data, so your recording
  is the only backtest material that exists.
- Score every forecast against settlement. One result proves nothing; the tally is the asset.
- Tools: `hip4 markets`, `forecast` (fair + Kronos vs market), `book -f`, `watch` (Telegram
  alerts), `bot` (paper trader), `backtest`/`replay`/`sim` (validation), `report` (PnL),
  `positions/orders --user <addr> --tg` (track anyone).
