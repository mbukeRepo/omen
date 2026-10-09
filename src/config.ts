import "dotenv/config";

export interface Config {
  /** Hyperliquid REST API base (no trailing slash). */
  hlApiUrl: string;
  /** HyperEVM JSON-RPC endpoint, for direct HyperCore reads via precompiles. */
  evmRpcUrl: string;
  /** Arbitrum JSON-RPC for bridge deposits; null = chain default. */
  arbRpcUrl: string | null;
  testnet: boolean;
  /** Approved agent (API wallet) key: signs orders, cannot withdraw. */
  agentPrivateKey: `0x${string}` | null;
  /** The master account the agent trades for; info queries use this address. */
  masterAddress: `0x${string}` | null;
  turnkey: {
    apiBaseUrl: string;
    apiPublicKey: string;
    apiPrivateKey: string;
    organizationId: string;
    /** Wallet account address (0x…) or Turnkey private key id to sign with. */
    signWith: string;
  } | null;
  /** Which signer to use; "auto" prefers Turnkey when configured, else local. */
  signerMode: "auto" | "turnkey" | "local";
  /** Local viem wallet: raw private key, or mnemonic + HD account index. */
  localWallet: {
    privateKey: `0x${string}` | null;
    mnemonic: string | null;
    accountIndex: number;
  };
  /** Telegram channel notifications (optional; `watch` degrades to console-only). */
  telegram: { token: string; chatId: string } | null;
  /** Default watchlist for `watch`: outcome indices and/or name patterns. */
  watchWhitelist: string[];
}

export function loadConfig(): Config {
  const testnet = process.env.HL_TESTNET === "true";
  const hlApiUrl =
    process.env.HL_API_URL ??
    (testnet ? "https://api.hyperliquid-testnet.xyz" : "https://api.hyperliquid.xyz");

  const tk = {
    apiBaseUrl: process.env.TURNKEY_API_BASE_URL ?? "https://api.turnkey.com",
    apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY ?? "",
    apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY ?? "",
    organizationId: process.env.TURNKEY_ORGANIZATION_ID ?? "",
    signWith: process.env.TURNKEY_SIGN_WITH ?? "",
  };
  const turnkeyConfigured =
    tk.apiPublicKey !== "" && tk.apiPrivateKey !== "" && tk.organizationId !== "" && tk.signWith !== "";

  // WALLET_PRIVATE_KEY is the canonical name; HL_PRIVATE_KEY kept for back-compat.
  const rawKey = process.env.WALLET_PRIVATE_KEY ?? process.env.HL_PRIVATE_KEY;
  const mnemonic = process.env.WALLET_MNEMONIC?.trim();

  const signerEnv = process.env.SIGNER;
  if (signerEnv !== undefined && signerEnv !== "turnkey" && signerEnv !== "local") {
    throw new Error(`SIGNER must be "turnkey" or "local", got "${signerEnv}"`);
  }

  const tgToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const tgChatId = process.env.TELEGRAM_CHAT_ID ?? "";

  return {
    hlApiUrl,
    evmRpcUrl:
      process.env.HL_EVM_RPC_URL ??
      (testnet ? "https://rpc.hyperliquid-testnet.xyz/evm" : "https://rpc.hyperliquid.xyz/evm"),
    arbRpcUrl: process.env.ARBITRUM_RPC_URL ?? null,
    testnet,
    agentPrivateKey: process.env.AGENT_PRIVATE_KEY?.startsWith("0x")
      ? (process.env.AGENT_PRIVATE_KEY as `0x${string}`)
      : null,
    masterAddress: process.env.MASTER_ADDRESS?.startsWith("0x")
      ? (process.env.MASTER_ADDRESS as `0x${string}`)
      : null,
    turnkey: turnkeyConfigured ? tk : null,
    signerMode: signerEnv ?? "auto",
    localWallet: {
      privateKey: rawKey && rawKey.startsWith("0x") ? (rawKey as `0x${string}`) : null,
      mnemonic: mnemonic || null,
      accountIndex: Number(process.env.WALLET_ACCOUNT_INDEX ?? "0"),
    },
    telegram: tgToken !== "" && tgChatId !== "" ? { token: tgToken, chatId: tgChatId } : null,
    watchWhitelist: (process.env.WATCH_WHITELIST ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  };
}
