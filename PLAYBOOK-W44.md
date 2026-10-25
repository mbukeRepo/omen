# Week 44 playbook — Oct 26 – Nov 1, 2026

Calculated moves for the FOMC/BoJ week on HIP-4 daily binaries (BTC/ETH 1d, 06:00 UTC
settlement). Built on TRADING.md's measurements: market ≈ fair value ±1.6–2.8pp, every
taker strategy loses the spread+trend, edge lives only in event dislocations, post-
confirmation favorites, and the maker seat. All times UTC. All sizes assume **bankroll
B = 1,000 USDC** — scale every dollar figure linearly for a different B.

## 0. GO / NO-GO (decide Monday)

Current live state: master `0xe68f…720D`, agent key approved, **spot USDC ≈ 0** → the
week starts PAPER unless funded. To go live by Wednesday:

- [ ] Mon: `hip4 deposit 1000` from the master on Arbitrum (needs USDC + ETH gas there)
- [ ] Mon: `hip4 move 1000 spot` → `hip4 whoami` shows spot ≈ 1000
- [ ] Mon: one 5-USDC round-trip (`buy` 10 @ ~0.50 IOC, `sell` back) to prove the agent path
- [ ] Confirm dates: PCE (BEA — Thu 29th vs Fri 30th), MSFT/GOOGL earnings (Tue vs Wed)
- NO-GO → run the identical playbook in paper; it still produces the tick history and the tally.

## 1. Risk budget (hard numbers, B = 1,000)

| Limit | Value | Rationale |
|---|---|---|
| Per-trade premium, setup A | **$20–25** (2–2.5%) | ≈ quarter-Kelly at the 5pp trigger (Kelly f* = 9.1%, see §2) |
| Per-trade premium, setup B | **$30** (3%) | ~fair-odds trade: size for variance, not edge |
| Concurrent positions | **3** | `--max-open 3` |
| Daily realized-loss halt | **−$30** | `--max-loss 30`; halts new entries, not exits |
| Week drawdown halt | **−$80** (8%) | stop live, finish week in paper, re-read the tally |
| Book-impact cap | ≤ ⅓ of top-of-book size | top of dailies is $10–70; our order IS the impact |

Unit of risk = **full premium** (tokens go to 0; stops don't protect a gap — the paper
week's 12 stops cost −$58.66 vs the 2 unstopped resolutions' −$35.14, and still lost).

## 2. The arithmetic behind the triggers

**Setup A (dislocation snipe).** Buy at ask `a` when live fair `p` ≥ a + 5pp.
EV per $1 premium = p/a − 1. Kelly f* = (p·b − (1−p))/b with b = (1−a)/a.

| p (fair) | a (ask) | EV/premium | Kelly | quarter-Kelly × $1k |
|---|---|---|---|---|
| 0.50 | 0.45 (−5pp) | **+11.1%** | 9.1% | **$23** |
| 0.50 | 0.42 (−8pp) | +19.0% | 13.8% | $35 |
| 0.70 | 0.65 (−5pp) | +7.7% | 14.3% | $36 |

Net of ~2pp half-spread the 5pp trigger clears ≈ +7% per trade. Below 5pp the spread
eats the edge — that's why the trigger is 5, not 3.

**Setup B (post-confirmation favorite).** Entry 0.75–0.83 is ≈ fair odds (+20–33% at
settlement). The calculated part is the exit: on a strike recross the token salvages
~0.45–0.55, capping the loss at ≈ −40% of premium (−$12 on $30) instead of −100%,
while the win keeps +25%. That asymmetry, not prediction, is the trade.

**ATM sensitivity (why blackouts exist).** Measured 28pp per 1% of spot at 19h to
expiry; scaling ≈ √(19/T):

| Time to expiry | YES move per 1% spot |
|---|---|
| 19h | 28pp (measured) | 12h | ~35pp | 6h | ~50pp | 3h | ~70pp | 1h | ~120pp |

At ≤3h an ATM token is pure gamma — only setup A (already-happened dislocation) or an
established ≥0.80 favorite may exist there.

## 3. Event timetable (UTC)

| Day | Time | Event | Posture |
|---|---|---|---|
| Mon 26 | — | quiet | flat; fund; confirm dates; record |
| Tue 27 | ~20:30 | MSFT/GOOGL earnings (unconfirmed day) | observe; snipe-only ≥5pp |
| **Wed 28** | **18:00 / 18:30** | **FOMC + presser** | main trade: playcards A1 + B1 |
| Thu 29 | 12:30 / 13:15 / 13:30 | GDP + ECB + US open (fade stat: 64%) | no taker entries 12:00–14:30; maker paper |
| Thu 29 | ~20:30 | AMZN (+AAPL/META?) earnings | observe; snipe-only |
| **Fri 30** | **~02:30–03:00 / 06:30** | **BoJ decision / presser** | playcard A2; **carry blackout 02:00–06:00** |
| Fri 30 | 12:30 | PCE (if not Thu) | snipe-only, settles Sat 06:00 |
| Sat 31 | — | BTC monthly close | flat into it |

## 4. Playcards

### A1 — FOMC snipe (Wed 17:45–19:30)
- **Arm 17:45:** `hip4 bot "(1d)" --snipe 4 --edge 2 --tick 2 --usd 20 --max-open 3 --max-loss 30 --min-hours 2`
  (paper unless §0 complete; snipe 4pp here because event vol makes fair move faster than books)
- **Standing orders cancelled by 17:30.** No position near strike at 18:00. No entries 17:30–18:00.
- Mechanical response to the print (15-min realized move, not the headline):
  - |Δspot| < 0.3% → stand down; dislocations won't exceed the spread
  - Δspot ≥ +0.5% → snipe stale YES asks ≥4pp under live fair; mirror NO on ≤ −0.5%
  - spot crosses K twice within 30 min → stand down entirely (whipsaw/pin)
- Exit: bot takes +5%; manual flatten anything left by 19:30 unless it qualifies for B1.
- Max event risk: 3 × $20 premium + $30 daily halt already counts it.

### B1 — FOMC post-confirmation hold (Wed 19:00–19:30 entry)
Enter ONLY if all five, checked at 19:00:
1. ≥30 min since the presser started, direction one-way since
2. spot ≥ 0.5% beyond the Wednesday daily's strike (≥ K·1.005 or ≤ K·0.995)
3. favorite ask ∈ **0.75–0.83** and within 2pp of `hip4 forecast` fair
4. top-of-book ≥ 3× our size
5. no second print pending before settlement
- **Entry:** `hip4 buy <outcome> <side> -p <ask+0.01> -s <⌊30/ask⌋> -t Ioc` ($30 premium)
- **Exit:** settlement; mandatory abort the moment spot recrosses K (expect ~−$12);
  no stop otherwise. Expected payoff: +$6–9 (+20–30%) vs capped −$12 ≈ 60/40 at fair odds.

### A2 — BoJ snipe (Fri 02:00–04:00)
- Same bot line as A1 but `--usd 10` (half size: 3–4h to expiry, §2 sensitivity ~60–70pp/1%)
- **No setup B after BoJ** — min-hours rule; whatever is sniped exits on +take or by 05:00.
- **Blackout:** nothing held near strike Fri 02:00–06:00 that isn't a ≥0.80 favorite from Thursday.

### C1 — maker rehearsal (Mon–Thu, paper only this week)
If `--make` gets built Mon/Tue: rest Alo pairs at fair ±2pp, $15/side, inventory cap
$45/side, requote on 0.3% spot move, flatten T−3h. Target: measure fill rate + adverse
selection through Thu's 12:30–14:30 stack. No live making until a full paper week scores.

## 5. Daily ops (every day)

- 06:05 — roll the whitelist to the new dailies; check `hip4 report`; score yesterday's calls
- 06:10 — `hip4 forecast` both dailies; note |fair − mid| (>3pp on a liquid book = data error until proven otherwise)
- 13:30 — US open hour: no fresh taker entries; expect the pre-open move to fade (64%)
- 20:00 — earnings nights: watch only; snipe trigger stays ≥5pp
- T−2h before any settlement — flatten everything except a ≥0.80 B-position
- Continuous — bot recording ticks to Postgres (`--record` on; HL deletes expired-market data)

## 6. Kill criteria (mechanical, no discretion)

- Daily realized ≤ −$30 → no new entries until next 06:00 roll
- Week realized ≤ −$80 → live OFF, paper only, post-mortem against the tick record
- Two consecutive A-trades filled >2pp worse than trigger → halve `--usd`, widen snipe to 6pp
- Fair-vs-settlement Brier for the week > 0.25 → the model is broken that regime; A-trades off
- Any un-alerted bot crash > 10 min → flatten all, restart, investigate before re-arming

## 7. What we do NOT do this week

No pre-print positions. No dip-buying a trending underlying (54/54 variants lost). No
"market is wrong" holds (8/8 lost). No stops on B (the recross abort is the stop). No
earnings-night B-holds. No live making. No trade on a 0.001/0.999 book.
