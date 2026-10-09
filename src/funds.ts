import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http, parseUnits } from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";
import type { LocalAccount } from "viem";
import type { Config } from "./config.js";

/**
 * USDC deposits to Hyperliquid via the Bridge2 contract on Arbitrum.
 * The bridge credits the SENDING address, so the transfer must come from the
 * trading account itself (master signer — never the agent key). Addresses from
 * hyperliquid-docs/for-developers/api/bridge2; minimum 5 USDC, smaller amounts
 * are lost forever.
 */
const BRIDGE = {
  mainnet: {
    chain: arbitrum,
    bridge: "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7" as `0x${string}`,
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as `0x${string}`,
  },
  testnet: {
    chain: arbitrumSepolia,
    bridge: "0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89" as `0x${string}`,
    usdc: "0x1baAbB04529D43a73232B713C0FE471f7c7334d5" as `0x${string}`,
  },
};

export const MIN_DEPOSIT_USDC = 5;

export async function depositToBridge(
  cfg: Config,
  account: LocalAccount,
  amountUsdc: number,
): Promise<{ hash: string; from: string }> {
  if (!(amountUsdc >= MIN_DEPOSIT_USDC)) {
    throw new Error(`minimum deposit is ${MIN_DEPOSIT_USDC} USDC — smaller amounts are not credited and are lost`);
  }
  const net = cfg.testnet ? BRIDGE.testnet : BRIDGE.mainnet;
  const rpcUrl = cfg.arbRpcUrl ?? net.chain.rpcUrls.default.http[0];
  const publicClient = createPublicClient({ chain: net.chain, transport: http(rpcUrl) });
  const amount = parseUnits(amountUsdc.toString(), 6);

  const [usdcBalance, ethBalance] = await Promise.all([
    publicClient.readContract({ address: net.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    publicClient.getBalance({ address: account.address }),
  ]);
  if (usdcBalance < amount) {
    throw new Error(
      `insufficient USDC on ${net.chain.name}: have ${formatUnits(usdcBalance, 6)}, need ${amountUsdc} ` +
        `(native USDC ${net.usdc} — bridged USDC.e is a different token and is not credited)`,
    );
  }
  if (ethBalance === 0n) {
    throw new Error(`no ETH for gas on ${net.chain.name} at ${account.address}`);
  }

  const wallet = createWalletClient({ account, chain: net.chain, transport: http(rpcUrl) });
  const hash = await wallet.writeContract({
    address: net.usdc,
    abi: erc20Abi,
    functionName: "transfer",
    args: [net.bridge, amount],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash, from: account.address };
}
