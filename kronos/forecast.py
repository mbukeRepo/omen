#!/usr/bin/env python3
"""Kronos probability forecast for a HIP-4 price binary.

Reads a JSON request on stdin, samples N independent forecast paths with
Kronos (github.com/shiyu-coder/Kronos, vendored in ./vendor/Kronos), and
prints a JSON result: P(final close >= threshold) plus path quantiles.

Request: {
  "candles": [{"t": ms, "o": .., "h": .., "l": .., "c": .., "v": ..}, ...],
  "intervalMs": 900000,
  "predLen": 76,            # bars from the last candle to expiry
  "threshold": 82994.0,
  "paths": 30,              # independent sampled paths
  "temperature": 1.0,
  "topP": 0.9,
  "model": "NeoQuasar/Kronos-small",
  "tokenizer": "NeoQuasar/Kronos-Tokenizer-base"
}
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor", "Kronos"))

import numpy as np
import pandas as pd
import torch

from model import Kronos, KronosTokenizer, KronosPredictor  # noqa: E402  (vendored)


def pick_device() -> str:
    if torch.cuda.is_available():
        return "cuda:0"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def main() -> None:
    req = json.load(sys.stdin)
    candles = req["candles"]
    interval_ms = int(req["intervalMs"])
    pred_len = int(req["predLen"])
    threshold = float(req["threshold"])
    n_paths = int(req.get("paths", 30))
    temperature = float(req.get("temperature", 1.0))
    top_p = float(req.get("topP", 0.9))

    df = pd.DataFrame(
        {
            "open": [float(c["o"]) for c in candles],
            "high": [float(c["h"]) for c in candles],
            "low": [float(c["l"]) for c in candles],
            "close": [float(c["c"]) for c in candles],
            "volume": [float(c["v"]) for c in candles],
        }
    )
    x_ts = pd.Series(pd.to_datetime([c["t"] for c in candles], unit="ms"))
    last_t = int(candles[-1]["t"])
    y_ts = pd.Series(pd.to_datetime([last_t + interval_ms * (i + 1) for i in range(pred_len)], unit="ms"))

    device = pick_device()
    tokenizer = KronosTokenizer.from_pretrained(req.get("tokenizer", "NeoQuasar/Kronos-Tokenizer-base"))
    model = Kronos.from_pretrained(req.get("model", "NeoQuasar/Kronos-small"))
    predictor = KronosPredictor(model, tokenizer, device=device, max_context=int(req.get("maxContext", 512)))

    # sample_count=1 per batch entry -> each result is one independent path,
    # which is what turns the forecast into a probability estimate.
    preds = predictor.predict_batch(
        [df] * n_paths,
        [x_ts] * n_paths,
        [y_ts] * n_paths,
        pred_len=pred_len,
        T=temperature,
        top_p=top_p,
        sample_count=1,
        verbose=False,
    )
    finals = np.array([float(p["close"].iloc[-1]) for p in preds])

    out = {
        "device": device,
        "paths": n_paths,
        "lastClose": float(df["close"].iloc[-1]),
        "threshold": threshold,
        "probAbove": float((finals >= threshold).mean()),
        "finalClose": {
            "q10": float(np.quantile(finals, 0.10)),
            "q50": float(np.quantile(finals, 0.50)),
            "q90": float(np.quantile(finals, 0.90)),
            "mean": float(finals.mean()),
        },
    }
    print(json.dumps(out))


if __name__ == "__main__":
    main()
