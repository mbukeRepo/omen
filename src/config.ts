import "dotenv/config";

export interface Config {
  /** Hyperliquid REST API base (no trailing slash). */
  hlApiUrl: string;
  testnet: boolean;
  turnkey: {
    apiBaseUrl: string;
    apiPublicKey: string;
    apiPrivateKey: string;
    organizationId: string;
    /** Wallet account address (0x…) or Turnkey private key id to sign with. */
    signWith: string;
  } | null;
  /** Dev-only fallback signer; used when Turnkey is not configured. */
  rawPrivateKey: `0x${string}` | null;
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

  const rawKey = process.env.HL_PRIVATE_KEY;

  const tgToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const tgChatId = process.env.TELEGRAM_CHAT_ID ?? "";

  return {
    hlApiUrl,
    testnet,
    turnkey: turnkeyConfigured ? tk : null,
    rawPrivateKey: rawKey && rawKey.startsWith("0x") ? (rawKey as `0x${string}`) : null,
    telegram: tgToken !== "" && tgChatId !== "" ? { token: tgToken, chatId: tgChatId } : null,
    watchWhitelist: (process.env.WATCH_WHITELIST ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  };
}
