import { spawn } from "node:child_process";
import { fetchCandles } from "./candles.js";
import type { HyperliquidInfo } from "./hyperliquid.js";

export const INTERVALS: [string, number][] = [
  ["5m", 5 * 60_000],
  ["15m", 15 * 60_000],
  ["1h", 3_600_000],
  ["4h", 4 * 3_600_000],
  ["1d", 86_400_000],
];

/** Kronos variants; context length caps how many history bars the model actually sees. */
export const KRONOS_MODELS: Record<string, { model: string; tokenizer: string; ctx: number }> = {
  mini: { model: "NeoQuasar/Kronos-mini", tokenizer: "NeoQuasar/Kronos-Tokenizer-2k", ctx: 2048 },
  small: { model: "NeoQuasar/Kronos-small", tokenizer: "NeoQuasar/Kronos-Tokenizer-base", ctx: 512 },
  base: { model: "NeoQuasar/Kronos-base", tokenizer: "NeoQuasar/Kronos-Tokenizer-base", ctx: 512 },
};

export const KRONOS_DIR = new URL("../kronos", import.meta.url).pathname;

export interface ForecastOptions {
  paths: number;
  temperature: number;
  days: number;
  model: string;
  source: string;
}

export const DEFAULT_FORECAST: ForecastOptions = { paths: 50, temperature: 1, days: 90, model: "small", source: "binance" };

export interface ForecastPlan {
  interval: string;
  intervalMs: number;
  lookback: number;
  predLen: number;
}

/** Pick the bar interval whose bars over the history window fit the model context. */
export function planForecast(opts: ForecastOptions, toExpiryMs: number): ForecastPlan {
  const variant = KRONOS_MODELS[opts.model];
  if (!variant) throw new Error(`model must be mini, small or base, got "${opts.model}"`);
  if (!(opts.days > 0)) throw new Error(`days must be > 0, got ${opts.days}`);
  // 25% overflow tolerated: the predictor keeps only the newest ctx bars anyway.
  const windowMs = opts.days * 86_400_000;
  const [interval, intervalMs] =
    INTERVALS.find(([, ms]) => windowMs / ms <= variant.ctx * 1.25) ?? INTERVALS[INTERVALS.length - 1]!;
  const lookback = Math.min(variant.ctx, Math.floor(windowMs / intervalMs));
  const predLen = Math.max(1, Math.ceil(toExpiryMs / intervalMs));
  if (predLen > 240) {
    throw new Error(`horizon is ${predLen} ${interval} bars — too far out for a stable sample; reduce days or use the mini model`);
  }
  return { interval, intervalMs, lookback, predLen };
}

export interface ForecastResult extends ForecastPlan {
  device: string;
  probAbove: number;
  lastClose: number;
  finalClose: { q10: number; q50: number; q90: number; mean: number };
}

function runPython(script: string, input: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(`${KRONOS_DIR}/venv/bin/python`, [`${KRONOS_DIR}/${script}`], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${script} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`${script} failed to start (run kronos/setup.sh first?): ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${script} exited ${code}: ${stderr.slice(-800)}`));
    });
    child.stdin.end(input);
  });
}

/** Sample Kronos paths to expiry and return P(final close >= threshold). Non-blocking. */
export async function kronosForecast(
  info: HyperliquidInfo,
  fields: { underlying: string; threshold: number; expiryMs: number },
  opts: ForecastOptions,
): Promise<ForecastResult> {
  const now = Date.now();
  const toExpiry = fields.expiryMs - now;
  if (toExpiry <= 0) throw new Error("market already expired");
  const plan = planForecast(opts, toExpiry);
  const variant = KRONOS_MODELS[opts.model]!;

  const raw = await fetchCandles(opts.source, info, fields.underlying, plan.interval, now - plan.intervalMs * (plan.lookback + 2), now);
  // The last candle is still forming; drop it so the model sees only closed bars.
  const closed = raw.slice(0, -1).slice(-plan.lookback);
  if (closed.length < 50) throw new Error(`only ${closed.length} ${plan.interval} candles from ${opts.source} — not enough history`);

  const stdout = await runPython(
    "forecast.py",
    JSON.stringify({
      candles: closed,
      intervalMs: plan.intervalMs,
      predLen: plan.predLen,
      threshold: fields.threshold,
      paths: opts.paths,
      temperature: opts.temperature,
      model: variant.model,
      tokenizer: variant.tokenizer,
      maxContext: variant.ctx,
    }),
    15 * 60_000,
  );
  const out = JSON.parse(stdout.trim().split("\n").pop()!) as Omit<ForecastResult, keyof ForecastPlan>;
  return { ...plan, ...out };
}
