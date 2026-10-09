import { createPublicClient, http } from "viem";
import { HyperliquidInfo, encodeAssetId, encodeCoin, YES, NO } from "./hyperliquid.js";

/**
 * Direct HyperCore reads through HyperEVM read-precompiles (eth_call).
 * Precompiles return HyperCore state as of EVM block construction — no REST
 * info API on the hot path. They take raw abi-encoded arguments (no function
 * selector), and expose top-of-book only; full L2 depth exists only via the API.
 */
const BBO = "0x000000000000000000000000000000000000080e" as const;

export interface Bbo {
  bid: number | null;
  ask: number | null;
}

export class HyperliquidRpc {
  private readonly client: ReturnType<typeof createPublicClient>;

  constructor(rpcUrl: string) {
    // batch:true coalesces concurrent calls into one JSON-RPC batch round trip.
    this.client = createPublicClient({ transport: http(rpcUrl, { batch: true }) });
  }

  /**
   * Raw best bid/offer for a core asset id — for HIP-4 outcome tokens that is
   * 100_000_000 + 10*outcome + side (see encodeAssetId). Unscaled units.
   */
  async bboRaw(assetId: number): Promise<{ bid: bigint; ask: bigint }> {
    const data = `0x${assetId.toString(16).padStart(64, "0")}` as `0x${string}`;
    const res = await this.client.call({ to: BBO, data });
    const hex = res.data?.slice(2) ?? "";
    if (hex.length < 128) throw new Error(`bbo precompile returned no data for asset ${assetId}`);
    return { bid: BigInt("0x" + hex.slice(0, 64)), ask: BigInt("0x" + hex.slice(64, 128)) };
  }
}

/**
 * Calibrated BBO reader for one outcome market. Outcome-token precompile price
 * units are undocumented, so the power-of-ten divisor is derived once by
 * comparing a raw precompile mid against a REST book mid.
 */
export class OutcomeBboReader {
  private divisor: number | null = null;

  constructor(
    private readonly rpc: HyperliquidRpc,
    private readonly info: HyperliquidInfo,
    private readonly outcome: number,
  ) {}

  private async calibrate(rawYes: { bid: bigint; ask: bigint }): Promise<void> {
    if (rawYes.bid === 0n || rawYes.ask === 0n) return; // one-sided book — retry next read
    const book = await this.info.l2Book(encodeCoin(this.outcome, YES));
    const bid = book.bids[0]?.px;
    const ask = book.asks[0]?.px;
    if (bid === undefined || ask === undefined) return;
    const restMid = (bid + ask) / 2;
    const rawMid = Number(rawYes.bid + rawYes.ask) / 2;
    if (restMid > 0) this.divisor = 10 ** Math.round(Math.log10(rawMid / restMid));
  }

  /** Scaled YES and NO best bid/offer, probability space. */
  async read(): Promise<{ yes: Bbo; no: Bbo; divisor: number } | null> {
    const [rawYes, rawNo] = await Promise.all([
      this.rpc.bboRaw(encodeAssetId(this.outcome, YES)),
      this.rpc.bboRaw(encodeAssetId(this.outcome, NO)),
    ]);
    if (this.divisor === null) await this.calibrate(rawYes);
    if (this.divisor === null) return null;
    const px = (v: bigint) => (v > 0n ? Number(v) / this.divisor! : null);
    return {
      yes: { bid: px(rawYes.bid), ask: px(rawYes.ask) },
      no: { bid: px(rawNo.bid), ask: px(rawNo.ask) },
      divisor: this.divisor,
    };
  }
}
