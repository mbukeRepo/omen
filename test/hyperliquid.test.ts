import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NO,
  YES,
  decodeCoin,
  encodeAssetId,
  encodeCoin,
  outcomeExpiryMs,
  parseDescription,
  parseHlTime,
  parseSide,
  priceBinaryFields,
  type HlOutcome,
} from "../src/hyperliquid.js";

const btcDaily: HlOutcome = {
  outcome: 10997,
  name: "x",
  description: "class:priceBinary|underlying:BTC|targetPrice:82994|expiry:20261012-0600|period:1d",
  sideSpecs: [],
};

test("coin and asset id encoding round-trips", () => {
  assert.equal(encodeCoin(10177, YES), "#101770");
  assert.equal(encodeCoin(10177, NO), "#101771");
  assert.equal(encodeAssetId(10177, NO), 100_101_771);
  assert.deepEqual(decodeCoin("#101771"), { outcome: 10177, side: NO });
  assert.deepEqual(decodeCoin("+101770"), { outcome: 10177, side: YES });
});

test("parseSide accepts yes/no aliases and rejects junk", () => {
  assert.equal(parseSide("YES"), YES);
  assert.equal(parseSide("n"), NO);
  assert.equal(parseSide("1"), NO);
  assert.throws(() => parseSide("maybe"));
});

test("parseDescription splits pipe-delimited fields, keeping colons in values", () => {
  assert.deepEqual(parseDescription("a:1|b:x:y|junk"), { a: "1", b: "x:y" });
});

test("parseHlTime parses YYYYMMDD-HHMM as UTC", () => {
  assert.equal(parseHlTime("20261012-0600"), Date.UTC(2026, 9, 12, 6, 0));
  assert.equal(parseHlTime("not-a-time"), null);
  assert.equal(parseHlTime(undefined), null);
});

test("expiry and price-binary fields come from the description", () => {
  assert.equal(outcomeExpiryMs(btcDaily, []), Date.UTC(2026, 9, 12, 6, 0));
  assert.deepEqual(priceBinaryFields(btcDaily), {
    underlying: "BTC",
    threshold: 82994,
    expiryMs: Date.UTC(2026, 9, 12, 6, 0),
  });
  assert.equal(priceBinaryFields({ ...btcDaily, description: "class:sports|team:X" }), null);
});

test("template-shaped binaries are recognised too", () => {
  const tpl: HlOutcome = {
    outcome: 1,
    name: "template:binaryPrice",
    description: "perp:ETH|threshold:2502.8|time:20261011-0600",
    sideSpecs: [],
  };
  assert.deepEqual(priceBinaryFields(tpl), {
    underlying: "ETH",
    threshold: 2502.8,
    expiryMs: Date.UTC(2026, 9, 11, 6, 0),
  });
});
