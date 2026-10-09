import { Turnkey } from "@turnkey/sdk-server";
import { createAccount } from "@turnkey/viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem";
import type { Config } from "./config.js";

export type ResolvedSigner = { account: LocalAccount; kind: "turnkey" | "local" };

/**
 * Resolve the signing account.
 *
 * Two signer kinds:
 *  - turnkey: viem account backed by Turnkey — every signature is a Turnkey
 *    SIGN_RAW_PAYLOAD activity under org policy control; no key on this machine.
 *  - local: viem local account from WALLET_PRIVATE_KEY (or legacy HL_PRIVATE_KEY),
 *    or WALLET_MNEMONIC + WALLET_ACCOUNT_INDEX (HD derivation). Hot-wallet grade:
 *    fine for testnet and small balances, no policy layer.
 *
 * SIGNER=turnkey|local forces one; default picks turnkey when configured, else local.
 */
export async function resolveSigner(cfg: Config): Promise<ResolvedSigner> {
  const mode = cfg.signerMode === "auto" ? (cfg.turnkey ? "turnkey" : "local") : cfg.signerMode;

  if (mode === "turnkey") {
    if (!cfg.turnkey) {
      throw new Error(
        "SIGNER=turnkey but Turnkey is not configured: set TURNKEY_API_PUBLIC_KEY / TURNKEY_API_PRIVATE_KEY / TURNKEY_ORGANIZATION_ID / TURNKEY_SIGN_WITH",
      );
    }
    const tk = new Turnkey({
      apiBaseUrl: cfg.turnkey.apiBaseUrl,
      apiPublicKey: cfg.turnkey.apiPublicKey,
      apiPrivateKey: cfg.turnkey.apiPrivateKey,
      defaultOrganizationId: cfg.turnkey.organizationId,
    });
    const account = (await createAccount({
      client: tk.apiClient(),
      organizationId: cfg.turnkey.organizationId,
      signWith: cfg.turnkey.signWith,
    })) as LocalAccount;
    return { account, kind: "turnkey" };
  }

  if (cfg.localWallet.privateKey) {
    return { account: privateKeyToAccount(cfg.localWallet.privateKey), kind: "local" };
  }
  if (cfg.localWallet.mnemonic) {
    return {
      account: mnemonicToAccount(cfg.localWallet.mnemonic, { addressIndex: cfg.localWallet.accountIndex }),
      kind: "local",
    };
  }
  throw new Error(
    "No local wallet configured: set WALLET_PRIVATE_KEY or WALLET_MNEMONIC (or configure Turnkey). `hip4 wallet new` generates one.",
  );
}

/** Back-compat helper used by commands that only need the account. */
export async function loadAccount(cfg: Config): Promise<LocalAccount> {
  return (await resolveSigner(cfg)).account;
}

export function newLocalWallet(): { privateKey: `0x${string}`; address: string } {
  const privateKey = generatePrivateKey();
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}
