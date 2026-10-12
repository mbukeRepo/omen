import { test } from "node:test";
import assert from "node:assert/strict";
import { HyperliquidInfo, type HlOutcome, type OutcomeMeta } from "../src/hyperliquid.js";
import { Watcher, marketUrl, parseMarketSlug, resolveSlug } from "../src/watch.js";

const eth: HlOutcome = {
  outcome: 10998,
  name: "x",
  description: "class:priceBinary|underlying:ETH|targetPrice:2502.8|expiry:20261012-0600|period:1d",
  sideSpecs: [],
};
const meta: OutcomeMeta = { outcomes: [eth], questions: [] };

test("trade URLs parse to a slug spec; non-slugs return null", () => {
  const spec = parseMarketSlug("https://app.hyperliquid.xyz/trade/eth-above-25028-yes-oct-12-0600");
  assert.deepEqual(spec && { u: spec.underlying, k: spec.thresholdDigits, d: spec.mmdd, h: spec.hhmm }, {
    u: "ETH",
    k: "25028",
    d: "1012",
    h: "0600",
  });
  assert.ok(parseMarketSlug("eth-above-25028-no-oct-12-0600"), "-no- slugs resolve to the same market");
  assert.equal(parseMarketSlug("BTC >="), null);
});

test("slugs resolve to the live outcome by digit-matched strike", () => {
  assert.equal(resolveSlug(meta, parseMarketSlug("eth-above-25028-yes-oct-12-0600")!), 10998);
  assert.equal(resolveSlug(meta, parseMarketSlug("eth-above-25029-yes-oct-12-0600")!), null);
});

test("marketUrl reverses the slug parser", () => {
  assert.equal(marketUrl(eth), "https://app.hyperliquid.xyz/trade/eth-above-25028-yes-oct-12-0600");
});

function quietWatcher(delta: number, asPoints = false) {
  const sent: string[] = [];
  const w = new Watcher(new HyperliquidInfo("http://unused.invalid"), {
    intervalSecs: 30,
    delta,
    asPoints,
    all: false,
    patterns: [],
    user: null,
    heartbeatMins: 0,
    telegram: null,
  }) as any;
  w.notify = (text: string) => sent.push(text);
  w.topOfBook = async () => [];
  w.meta = meta;
  return { w, sent };
}

test("alerts fire past the threshold and reset the baseline", async () => {
  const { w, sent } = quietWatcher(5);
  w.track(10998, 0.5, 0.5);
  await w.tick({ "#109980": "0.52", "#109981": "0.48" }); // +4%: quiet
  assert.equal(sent.length, 0);
  await w.tick({ "#109980": "0.53", "#109981": "0.47" }); // +6%: alert
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /YES 0\.5000 → 0\.5300/);
  await w.tick({ "#109980": "0.55", "#109981": "0.45" }); // +3.8% from new baseline: quiet
  assert.equal(sent.length, 1);
});

test("--pp thresholds measure probability points", async () => {
  const { w, sent } = quietWatcher(3, true);
  w.track(10998, 0.9, 0.1);
  await w.tick({ "#109980": "0.92" }); // +2pp: quiet
  await w.tick({ "#109980": "0.94" }); // +4pp: alert
  assert.equal(sent.length, 1);
});

test("a market that stops quoting posts a resolution notice and is dropped", async () => {
  const { w, sent } = quietWatcher(5);
  w.track(10998, 0.85, 0.15);
  await w.tick({});
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /^🏁/);
  assert.equal(w.tracked.size, 0);
});
