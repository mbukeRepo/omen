#!/usr/bin/env python3
"""Historical validation of the Kronos binary-probability setup.

Reads JSON on stdin:
{
  "candles": [...],            # ascending closed bars
  "trials": [{"end": i, "strikes": [..], "outcome": j}],  # context = candles[:i], outcome bar index j
  "lookback": 512, "predLen": 6, "paths": 50,
  "temperature": 1.0, "topP": 0.9,
  "model": "...", "tokenizer": "...", "maxContext": 512
}
For each trial: sample `paths` independent continuations from candles[end-lookback:end],
P(strike) = fraction of paths whose final close >= strike; outcome y = actual close of
candles[outcome] >= strike. Prints per-trial results + aggregate calibration metrics.
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor", "Kronos"))

import numpy as np
import pandas as pd
import torch

from model import Kronos, KronosTokenizer, KronosPredictor  # noqa: E402

CHUNK = 256


def pick_device() -> str:
    if torch.cuda.is_available():
        return "cuda:0"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def main() -> None:
    req = json.load(sys.stdin)
    candles = req["candles"]
    trials = req["trials"]
    lookback = int(req["lookback"])
    pred_len = int(req["predLen"])
    n_paths = int(req.get("paths", 50))
    temperature = float(req.get("temperature", 1.0))
    top_p = float(req.get("topP", 0.9))
    interval_ms = int(req["intervalMs"])

    closes = np.array([float(c["c"]) for c in candles])
    times = [int(c["t"]) for c in candles]

    def df_for(end: int) -> pd.DataFrame:
        rows = candles[end - lookback : end]
        return pd.DataFrame(
            {
                "open": [float(c["o"]) for c in rows],
                "high": [float(c["h"]) for c in rows],
                "low": [float(c["l"]) for c in rows],
                "close": [float(c["c"]) for c in rows],
                "volume": [float(c["v"]) for c in rows],
            }
        )

    device = pick_device()
    tokenizer = KronosTokenizer.from_pretrained(req.get("tokenizer", "NeoQuasar/Kronos-Tokenizer-base"))
    model = Kronos.from_pretrained(req.get("model", "NeoQuasar/Kronos-small"))
    predictor = KronosPredictor(model, tokenizer, device=device, max_context=int(req.get("maxContext", 512)))

    # One batch entry per (trial, path); each entry samples one independent path.
    entries = [(ti, p) for ti in range(len(trials)) for p in range(n_paths)]
    finals = np.zeros(len(entries))
    for start in range(0, len(entries), CHUNK):
        chunk = entries[start : start + CHUNK]
        dfs, xts, yts = [], [], []
        for ti, _ in chunk:
            end = trials[ti]["end"]
            dfs.append(df_for(end))
            xts.append(pd.Series(pd.to_datetime(times[end - lookback : end], unit="ms")))
            last_t = times[end - 1]
            yts.append(pd.Series(pd.to_datetime([last_t + interval_ms * (k + 1) for k in range(pred_len)], unit="ms")))
        preds = predictor.predict_batch(
            dfs, xts, yts, pred_len=pred_len, T=temperature, top_p=top_p, sample_count=1, verbose=False
        )
        for j, p in enumerate(preds):
            finals[start + j] = float(p["close"].iloc[-1])
        print(f"progress {min(start + CHUNK, len(entries))}/{len(entries)}", file=sys.stderr)

    finals = finals.reshape(len(trials), n_paths)

    results = []
    for ti, tr in enumerate(trials):
        actual = closes[tr["outcome"]]
        spot = closes[tr["end"] - 1]
        for strike in tr["strikes"]:
            prob = float((finals[ti] >= strike).mean())
            y = 1.0 if actual >= strike else 0.0
            results.append(
                {"t": times[tr["end"]], "spot": float(spot), "strike": float(strike), "prob": prob, "y": y}
            )

    probs = np.array([r["prob"] for r in results])
    ys = np.array([r["y"] for r in results])
    brier = float(np.mean((probs - ys) ** 2))
    base_rate = float(ys.mean())
    acc = float(((probs > 0.5) == (ys > 0.5)).mean())

    buckets = []
    for lo in np.arange(0, 1.0, 0.2):
        hi = lo + 0.2
        mask = (probs >= lo) & (probs < hi if hi < 1 else probs <= hi)
        if mask.sum() > 0:
            buckets.append(
                {"bucket": f"{lo:.1f}-{hi:.1f}", "n": int(mask.sum()), "meanProb": float(probs[mask].mean()), "freq": float(ys[mask].mean())}
            )

    print(
        json.dumps(
            {
                "device": device,
                "trials": len(trials),
                "predictions": len(results),
                "paths": n_paths,
                "brier": brier,
                "brierAlways50": 0.25,
                "brierClimatology": float(np.mean((base_rate - ys) ** 2)),
                "accuracy": acc,
                "baseRate": base_rate,
                "calibration": buckets,
                "results": results,
            }
        )
    )


if __name__ == "__main__":
    main()
