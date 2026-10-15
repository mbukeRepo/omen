# BTC Reaction Patterns Around US PPI Releases (esp. PPI the Day After a Hot CPI)

Research date: 2026-10-15, ahead of the 12:30 UTC PPI release. Context: September CPI (released 2026-10-14) came in hot — headline 3.7% YoY vs ~3.6% expected (up from 3.4%), core 2.6% — and BTC fell ~2.3% to ~$81,000–81,850 with ~$1B in liquidations.

## Q1. Typical BTC move in the first 30–60 min after PPI vs after CPI; how often PPI reverses the initial move

### Takeaway
There is solid measured evidence for CPI (Block Scholes event-study: CPI surprises explain up to ~80% of BTC's first-hour return in 2026, with the effect concentrated in the first hour), but **no formal event study of PPI was found**. Anecdotally, large PPI surprises in 2025–2026 produced same-day BTC moves of roughly -2.5% to -3%, i.e., same order of magnitude as a big CPI day, but there are no measured 30–60 min PPI statistics or reversal-frequency stats.

### Cited Findings
**CPI (measured, Block Scholes event study, July 2026):**
- Full sample since 2020: CPI surprises explain 25% of BTC's first-hour return; a 1pp upside surprise maps to roughly a -5.5% move over the next hour (so a typical 0.1pp surprise ≈ -0.55%) — [Block Scholes](https://www.blockscholes.com/institutional-research/is-bitcoin-showing-greater-sensitivity-to-us-cpi-releases-again)
- Peak sensitivity window (Dec 2021–Nov 2023, 24-release rolling): R² = 52%, 1-hour β = -13% per pp of surprise; with CPI surprise std dev of 0.16pp, a typical upside surprise mapped to about a -1.3% BTC move in the first hour — [Block Scholes](https://www.blockscholes.com/institutional-research/is-bitcoin-showing-greater-sensitivity-to-us-cpi-releases-again)
- 2026: on a 12-release rolling window the 1-hour R² has climbed to nearly 80% (above the 2022–23 peak), but per-surprise magnitudes are smaller than 2022–23; the effect is **concentrated at the 1-hour horizon, not 4–24 hours** — [Block Scholes](https://www.blockscholes.com/institutional-research/is-bitcoin-showing-greater-sensitivity-to-us-cpi-releases-again)
- Same study: BTC's sensitivity to NFP surprises has decayed to near zero in 2026 (vs R² ~59–60% at the mid-2024 peak); the article **does not analyze PPI at all** — [Block Scholes](https://www.blockscholes.com/institutional-research/is-bitcoin-showing-greater-sensitivity-to-us-cpi-releases-again)
- Example of a clean CPI reaction: June-2026 CPI (released 14 Jul 2026) was a 0.3pp downside surprise (3.5% vs 3.8% consensus); BTC rose toward $65K and closed +2.9% — [Block Scholes](https://www.blockscholes.com/institutional-research/is-bitcoin-showing-greater-sensitivity-to-us-cpi-releases-again)

**PPI (anecdotal reaction sizes, 2023–2026):**
- 14 Aug 2025 (July PPI +0.9% MoM vs +0.2% expected, hottest since May 2022; core also +0.9% vs +0.2%; YoY 3.3% vs 2.5% forecast): "crypto prices quickly slide" — BTC fell below $119K from the prior day's >$124K all-time high, -2.9% on the day to ~$118K; ETH -2.9%, SOL -2.4%, XRP -5.7%; Sept cut odds slipped ~100%→96% and 50bp-cut odds went to 0 — [Yahoo Finance/Decrypt](https://finance.yahoo.com/news/bitcoin-ethereum-fall-ppi-shock-190003159.html); [FXStreet](https://www.fxstreet.com/cryptocurrencies/news/crypto-prices-quickly-slide-after-troubling-us-ppi-report-202508141319); [Blockhead](https://www.blockhead.co/2025/08/15/hot-ppi-print-pauses-cryptos-rally-but-demand-still-absorbs-supply/)
- 27 Feb 2026 (Jan PPI headline +0.5% vs +0.3%; core +0.8% vs +0.3%): BTC slid into the Wall Street open, daily downside ~2.5–3% on Bitstamp; gold made highs; March Fed cut odds fell below 4% — [Cointelegraph](https://cointelegraph.com/news/bitcoin-threatens-new-breakdown-us-ppi-gold-1-month-high)
- 14 May 2026 (April PPI +0.5% MoM vs +0.3% expected): BTC broke below $80,000, extending a selloff to a third day (print came the day after a hot CPI) — [search-surfaced syndicated coverage, low-quality mirrors](https://cointelegraph.com/news/key-btc-price-levels-bitcoin-58k-sticky-us-ppi); treat levels as approximate
- 14 Mar 2024 (Feb PPI +0.6% MoM vs +0.3% expected, retail sales recovering): BTC fell only ~0.94% on the day — the mixed PPI/retail picture muted the reaction — [Pintu/Coingape](https://pintu.co.id/en/news/76299-inflasi-ppi-as-februari-bitcoin-anjlok)
- 18 Jan 2023 (soft PPI 6.2% vs 6.8% YoY + big retail sales miss): BTC spiked to $21,646 on Bitstamp pre-open, then pulled back to ~$21,400 within the hour ("spike then fade") — [Cointelegraph](https://cointelegraph.com/markets/bitcoin-sees-new-4-month-high-as-us-ppi-retail-data-posts-big-misses)

**CPI-day whipsaw anecdotes (for comparison):**
- 12 Mar 2024 CPI (hot-ish, day after ATH just under $73K): BTC moved up and down a few hundred dollars, dipped -0.5%, then recovered all losses back to $72K — [CryptoPotato](https://cryptopotato.com/bitcoin-faces-minor-volatility-at-72k-as-february-us-cpi-numbers-came-out/)
- 11 Sep 2024 CPI: BTC dropped on the print, then the dip proved short-lived and BTC recovered to close above $57,000 the same day — [CCN](https://www.ccn.com/analysis/crypto/bitcoin-btc-price-recovers-cpi-data/)
- 10 Nov 2022 soft CPI: BTC surged $1,000 in five minutes before the Wall Street open — [Cointelegraph](https://cointelegraph.com/markets/bitcoin-price-gains-1k-in-minutes-as-cpi-data-deals-dxy-fresh-2-dip)
- April 2024 CPI day: BTC fell to a low of $67,475 after the release, then returned to ~$69,862 (full intraday round trip) — [search-surfaced summary](https://cryptopotato.com/bitcoin-faces-minor-volatility-at-72k-as-february-us-cpi-numbers-came-out/) (secondary; exact source page not independently verified)

### Inferences
- A large PPI surprise (≥3–4x the consensus MoM number, like Aug 2025's 0.9 vs 0.2) is capable of a CPI-sized move (-2.5% to -3% day move), but a modest beat (0.5–0.6 vs 0.3) more typically yields -1% to -3% depending on regime and positioning, with the smallest reactions when offsetting data (retail sales) prints simultaneously.
- The Block Scholes finding that the CPI effect is concentrated in the first hour and does not extend to 4–24h horizons implies the informational edge decays fast — for binary/event trades, the first 60 minutes is where the direction signal lives; after that, flows (equity open at 13:30 UTC, ETF flows) dominate.
- CPI-day history shows full intraday reversals are common when the surprise is small (Mar 2024, Sep 2024, Apr 2024); by analogy, a small PPI beat/miss today is more likely to whipsaw than to trend.

### Gaps
- No published backtest or event study quantifying BTC's average 30–60 min move after PPI specifically (Kaiko, K33, Glassnode, CoinMetrics searches returned nothing PPI-specific). The Block Scholes study explicitly excludes PPI.
- No measured statistic on "how often PPI reverses the initial move" — only anecdotes above.
- A 2022 Kaiko note (via CNBC) on hourly BTC returns (3–5% spikes during the credit crisis, reverting to 1–2%) is regime context only, not PPI-specific — [CNBC](https://www.cnbc.com/2022/10/10/bitcoin-falls-to-start-the-week-as-investors-look-ahead-to-inflation-data.html)

## Q2. PPI landing within a day or two of a CPI surprise: confirmation vs contradiction cases

### Takeaway
Concrete cases exist in both directions. **Confirmation** (hot CPI then hot PPI, May 2026) produced continuation — a third straight down day and a break of support. **Contradiction** (cool-CPI rally to ATH, then shock-hot PPI, Aug 2025) produced a sharp but contained giveback (~-2.9%, i.e., the breakout premium, not a crash) because the Fed-cut base case survived. The second print tends to be traded as a referendum on the rate path set up by the first.

### Cited Findings
**Contradiction case — Aug 2025 (CPI-driven rally → hot PPI next day):**
- BTC set an all-time high above $124,000 on Wed 13 Aug 2025, then fell 2.9% to ~$118,000 on Thu 14 Aug after July PPI printed +0.9% MoM vs +0.2% expected (largest monthly rise since May 2022) — [Yahoo Finance/Decrypt](https://finance.yahoo.com/news/bitcoin-ethereum-fall-ppi-shock-190003159.html); [APA](https://en.apa.az/cryptocurrency/bitcoin-price-today-falls-to-119k-from-record-high-as-hot-us-ppi-weighs-475154)
- The move was transmitted via rate expectations: Sept 25bp-cut odds slipped only from ~100% to ~96%, and jumbo (50bp) cut odds went from 5.7% to 0% — the cut itself stayed priced, which capped the damage — [Yahoo Finance](https://finance.yahoo.com/news/bitcoin-ethereum-fall-ppi-shock-190003159.html); [FXStreet](https://www.fxstreet.com/cryptocurrencies/news/crypto-prices-quickly-slide-after-troubling-us-ppi-report-202508141319)
- Blockhead's post-mortem framed it as "hot PPI print pauses crypto's rally, but demand still absorbs supply" — the rally paused rather than reversed trend — [Blockhead](https://www.blockhead.co/2025/08/15/hot-ppi-print-pauses-cryptos-rally-but-demand-still-absorbs-supply/)
- Caveat: sources confirm the Wednesday ATH but do not explicitly attribute it to the Aug 12 CPI print; the cool-CPI-rally framing is plausible but was not verifiable from the coverage found.

**Confirmation case — May 2026 (hot CPI May 13 → hot PPI May 14):**
- 13 May 2026: hot CPI knocked BTC to ~$80,500 ("reignites rate-hike concerns") — [syndicated coverage, low-quality mirrors; treat as approximate](https://cointelegraph.com/news/key-btc-price-levels-bitcoin-58k-sticky-us-ppi)
- 14 May 2026: April PPI +0.5% MoM vs +0.3% expected → BTC broke below $80,000, "extending selloff to a third day"; risk-off was broad across equities and crypto — [syndicated coverage](https://www.mexc.com/news/596567) (mirrors of the same article; original outlet not identified)

**Confirmation case — Feb 2026 (inflation re-acceleration regime):**
- 27 Feb 2026: Jan PPI (headline +0.5% vs +0.3%, core +0.8% vs +0.3%) hit a market already down ~17% month-to-date; BTC slid another ~2.5–3% into the Wall St open while gold broke higher and March cut odds fell below 4% — same-direction macro confirmation extended the existing trend — [Cointelegraph](https://cointelegraph.com/news/bitcoin-threatens-new-breakdown-us-ppi-gold-1-month-high)

**Both-soft case — Jan 2023:**
- 18 Jan 2023: PPI 6.2% vs 6.8% expected + retail sales -1.1% vs -0.8% (both dovish) a week after a soft CPI → BTC spiked to a new 4-month high at $21,646, then faded ~1% within the hour — [Cointelegraph](https://cointelegraph.com/markets/bitcoin-sees-new-4-month-high-as-us-ppi-retail-data-posts-big-misses)

### Inferences
- When PPI **confirms** a hot CPI from the prior day, continuation has been the pattern (May 2026, Feb 2026): the market treats it as second-source validation of the rate-path repricing and extends the move, including breaking the prior day's support.
- When PPI **contradicts** the prior move, the reaction size scales with how much of the Fed path actually changes: Aug 2025's enormous PPI beat only moved cut odds 100→96%, and BTC gave back ~3% (roughly the pre-print rally) rather than trending down.
- Applied to 2026-10-15: BTC already fell ~2.3% on yesterday's hot CPI and markets price ~20% odds of an October hike. A hot PPI today is a confirmation setup (continuation risk toward/below the $80K support Glassnode flags); a soft PPI contradicts a one-day-old move with hike-tail pricing attached, which historically produces a sharp relief bounce (the contradicting print has more convexity because it removes a freshly-priced tail).

### Gaps
- The classic Feb 2024 sequence (hot CPI Feb 13, 2024 → hot PPI Feb 16, 2024) could not be verified from sources found; searches returned nothing usable on BTC's Feb 16, 2024 reaction. Do not rely on recalled numbers for that episode.
- No systematic study of "second print after a CPI surprise" for any asset class was found — all evidence above is case-based.

## Q3. Sell-the-news / buy-the-rumor around second-tier inflation prints after a sharp pre-print move

### Takeaway
No measured statistics exist; the anecdotal record consistently shows that when BTC moves sharply *into* an inflation print, the print's confirming move is faded within hours — spikes to new highs on good data get sold at the US equity open, and pre-print pumps get reversed.

### Cited Findings
- July 2025 CPI day: BTC briefly reached ~$112,000 on a cooler-than-expected CPI print, then **reversed at the US market open** — [MEXC syndication of Cointelegraph-based report](https://www.mexc.com/news/141911) (anecdote, secondary source)
- Oct 2025 (shutdown-delayed CPI): BTC "reverses 3.5% pump ahead of CPI," falling back to ~$107–108K before the release — pre-positioning unwound before the data even landed — [CryptoNews via TradingView](https://tr.tradingview.com/news/cryptonews%3A086ac72f7094b%3A0-btc-reverses-3-5-pump-ahead-of-cpi-will-inflation-data-trigger-a-crypto-comeback) (anecdote)
- 18 Jan 2023: soft PPI + soft retail → instant spike to $21,646 followed by a fade to ~$21,400; Material Indicators flagged "declining volume... momentum is fading" into the move — [Cointelegraph](https://cointelegraph.com/markets/bitcoin-sees-new-4-month-high-as-us-ppi-retail-data-posts-big-misses) (anecdote)
- Aug 2023: CryptoQuant data showed BTC exchange reserves rising ~1,500 BTC into a CPI release — read as traders positioning to "react swiftly" (i.e., to sell) around the print — [The Block](https://www.theblock.co/news/markets/2023-08-09-bitcoin-retreats-back-below-30000-ahead-of-us-cpi-release-243964) (positioning evidence, not outcome evidence)
- 14 Aug 2025 is itself the mirror-image case: the sharp pre-print rally (ATH Wednesday) left the market long into PPI, and the hot print triggered an outsized -2.9% unwind for what was nominally a second-tier release — [Yahoo Finance](https://finance.yahoo.com/news/bitcoin-ethereum-fall-ppi-shock-190003159.html)

### Inferences
- The repeated pattern: sharp pre-print move → initial post-print move in the "expected" direction → fade at/after the 13:30 UTC US equity open. The US open is the recurring reversal timestamp across 2023–2025 anecdotes.
- After yesterday's -2.3% CPI drop and $1B of liquidations, positioning into today's PPI is already flushed short-term — which historically dampens downside follow-through on a confirming print and amplifies the bounce on a contradicting one (consistent with the day-after bounce stats in Q4).

### Gaps
- No quantitative study of buy-the-rumor/sell-the-news behavior specific to PPI or any second-tier inflation print was found (searched K33, Kaiko, The Block, Blockworks). K33's "sell-the-news" commentary found in search related to the Jan 2025 inauguration, not inflation prints — [CoinDesk K33 tag](https://www.coindesk.com/tag/k33-research/1)

## Q4. Day-after-crash behavior: next 24h after a >2% single-day macro-print drop

### Takeaway
No published statistic exists for the exact condition (">2% single-day BTC drop on a macro print"). The closest evidence: hour-scale BTC returns show statistically significant mean reversion (peer-reviewed), and small-sample crash studies find a positive median next-day return (+2.8% after -10% days) but a ~92% probability the crash low gets revisited within 30 days.

### Cited Findings
- Peer-reviewed (Ledger journal, "On the Intraday Behavior of Bitcoin"): significant **negative first-order autocorrelation** of BTC returns at 1h/2h/4h frequencies — systematic mean reversion — and **larger moves produce stronger percentage reversals** — [Ledger](https://ledger.pitt.edu/ojs/ledger/article/view/213)
- Vendor backtest (n=13, close-to-close drops ≤ -10%): median next-day return +2.8%, mean +3.7%; BUT BTC traded below the crash-day low at least once within 30 days in 92% of cases (12/13) — [Algocrat Telegram](https://t.me/s/algocrat/151) (commercial vendor, tiny sample — anecdotal grade)
- FXStreet (2019, n=13 bullish sessions with ≥20% range): next day averaged -1.14%, closing lower 61.5% of the time — direction-symmetric evidence that outsized days mean-revert — [FXStreet](https://www.fxstreet.com/amp/cryptocurrencies/news/bitcoin-do-volatile-bullish-sessions-lead-to-further-gains-201906270815) (tiny sample)
- Longer horizon: after a 15% two-week drawdown, median return is as weak as -6.7% at the 3-month mark, improving by 6 months — [Schaeffer's Research, Dec 2025](https://www.schaeffersresearch.com/content/bgs/2025/12/09/how-bitcoin-historically-handles-major-fumbles)
- Relevant precedent for today: 11 Sep 2024 — BTC dropped on CPI, recovered the same day to close above $57K — [CCN](https://www.ccn.com/analysis/crypto/bitcoin-btc-price-recovers-cpi-data/); Feb 2026 — BTC fell near $60K early in the month, then recovered above $70K after cooler inflation data later in the month — [Bitcoin Magazine](https://bitcoinmagazine.com/?p=50510)
- Today's starting state: BTC ~$81,000–81,850 (-2.3%), ~$1B liquidations, $261.5M US spot-ETF outflows on 14 Oct 2026; Glassnode flags $80,000 as key support — [cryptonews.net](https://cryptonews.net/news/bitcoin/33594034/); [Analytics Insight](https://www.analyticsinsight.net/price-analysis/crypto-prices-today-bitcoin-slips-near-usd-81150-as-hot-us-cpi-sparks-usd-1b-liquidations); [Investing.com](https://www.investing.com/news/cryptocurrency-news/bitcoin-slides-below-81k-as-hot-us-cpi-spurs-rate-hike-bets-4950559); [Mitrade/Glassnode](https://www.mitrade.com/au/insights/news/live-news/article-3-2163971-20261015)
- Macro backdrop: markets were pricing roughly a 20% chance of a Fed **hike** at the Oct 27–28, 2026 FOMC as of early October; BTC had already fallen 7.9% to a low of $80,347 by Oct 8 before stabilizing ~$83,800 — [Bitrue preview](https://www.bitrue.com/blog/us-cpi-october) (pre-release preview; forward-looking claims are speculation)

### Inferences
- Combining the hour-scale mean-reversion result with the small-sample crash data: the base case after a -2–3% macro-print day is a modest next-24h bounce *if no new catalyst confirms the shock* — but today there IS a scheduled catalyst (PPI), which dominates the statistical drift either way.
- The 92%-retest finding (even if low-grade) argues against treating any post-PPI bounce as trend reversal; it supports fading bounces back toward the CPI-day low rather than chasing them.

### Gaps
- No published study conditions next-day returns on "the drop was caused by a macro print" — all available stats pool crash causes. The >2%-drop threshold specifically is unstudied; the only thresholds found were -10% daily and -15%/two-week.

## Q5. Retail sales released simultaneously with PPI: which dominates the first reaction

### Takeaway
No study was found; case evidence says that when the two prints agree, the move is clean and sizable, and when they conflict, the reaction is muted or whipsaws in the first hour. In the one clean BTC-specific conflict case found (14 Mar 2024: hot PPI + firm retail sales), BTC moved under 1%.

### Cited Findings
- 14 Mar 2024: Feb PPI +0.6% MoM vs +0.3% expected, alongside recovering retail sales — "mixed picture of the US economy" — BTC fell only ~0.94% — [Pintu/Coingape](https://pintu.co.id/en/news/76299-inflasi-ppi-as-februari-bitcoin-anjlok)
- 18 Jan 2023: both prints missed dovishly (PPI 6.2 vs 6.8; retail -1.1% vs -0.8%, core -1.1% vs -0.4%) → clean BTC spike to a 4-month high — [Cointelegraph](https://cointelegraph.com/markets/bitcoin-sees-new-4-month-high-as-us-ppi-retail-data-posts-big-misses)
- Equities precedents (no BTC): both-beat → futures popped ([Benzinga](https://www.benzinga.com/node/1165919)); both soft with stagflation read → stocks modestly lower, yields also weighing ([Nasdaq](https://www.nasdaq.com/articles/stocks-lower-on-bearish-ppi-and-retail-sales-reports)); conflicting prints → "volatile trading in the first two hours," lower first hour then recovery ([Mortgage News Daily](https://amp.mortgagenewsdaily.com/article/91972)); one December case saw an initial "bad is good" retail-sales reaction that markets quickly reversed ([Mortgage News Daily](https://amp.mortgagenewsdaily.com/article/91972))

### Inferences
- In a regime where the active question is the Fed's rate path on inflation (as now, with hike odds being priced), the inflation component (PPI) should dominate the first reaction; retail sales matters more when growth/recession is the active question. This is inference from the mechanism, not a measured result.
- Conflicting simultaneous prints are a whipsaw setup: expect a smaller, noisier first 30 minutes and a higher probability the initial direction is wrong — size down or wait for the equity open.

### Gaps
- No quantitative study found ranking PPI vs retail sales by first-reaction dominance for any asset.
- Could not confirm from sources whether September retail sales is actually co-scheduled with today's (2026-10-15) PPI release — verify against the Census/BLS calendar before trading the open; the playbook branch above only applies if both print at 12:30 UTC.

## Source quality notes
- Measured statistics: only Block Scholes (CPI/NFP betas and R²) and the Ledger journal paper (intraday mean reversion). Everything else is journalistic case reporting or vendor anecdote and is labeled as such.
- Several 2026 search results come from syndicated mirror sites of uncertain provenance (mexc.com news mirrors, university-domain scraper pages); figures from those are marked "approximate" and should not be treated as precise.
- Kaiko, K33, Glassnode, and CoinMetrics searches produced no PPI-specific quantitative notes; the absence itself is informative — desks treat PPI as second-tier and have not published reaction-size stats for it.
