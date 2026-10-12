/**
 * Digital-option fair value for "X >= K at T" binaries: under a driftless
 * lognormal model, P(S_T >= K) = Phi(d2) with
 *   d2 = (ln(S/K) - s^2/2) / s,   s = sigma_per_bar * sqrt(bars to expiry).
 * It needs only live spot, the strike, time left and recent realized volatility,
 * so it can be repriced on every tick.
 */

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 via erf; |error| < 1.5e-7). */
export function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf =
    1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Standard deviation of log returns between consecutive closes (per bar). */
export function realizedVol(closes: number[]): number {
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1]! > 0 && closes[i]! > 0) rets.push(Math.log(closes[i]! / closes[i - 1]!));
  }
  if (rets.length < 2) return 0;
  const mean = rets.reduce((a, r) => a + r, 0) / rets.length;
  return Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1));
}

/** P(S_T >= K) for a driftless lognormal with the given per-bar volatility. */
export function digitalProb(spot: number, strike: number, sigmaPerBar: number, barsToExpiry: number): number {
  if (barsToExpiry <= 0 || sigmaPerBar <= 0) return spot >= strike ? 1 : 0;
  const s = sigmaPerBar * Math.sqrt(barsToExpiry);
  return normCdf((Math.log(spot / strike) - (s * s) / 2) / s);
}
