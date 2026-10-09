import { Turnkey } from "@turnkey/sdk-server";
import { createAccount } from "@turnkey/viem";
import { privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem";
import type { Config } from "./config.js";

/**
 * Resolve the signing account:
 *  - Turnkey-backed viem account when TURNKEY_* env is set (production path;
 *    every signature is a Turnkey SIGN_RAW_PAYLOAD activity under policy control)
 *  - raw HL_PRIVATE_KEY fallback for local development only
 */
export async function loadAccount(cfg: Config): Promise<LocalAccount> {
  if (cfg.turnkey) {
    const tk = new Turnkey({
      apiBaseUrl: cfg.turnkey.apiBaseUrl,
      apiPublicKey: cfg.turnkey.apiPublicKey,
      apiPrivateKey: cfg.turnkey.apiPrivateKey,
      defaultOrganizationId: cfg.turnkey.organizationId,
    });
    return (await createAccount({
      client: tk.apiClient(),
      organizationId: cfg.turnkey.organizationId,
      signWith: cfg.turnkey.signWith,
    })) as LocalAccount;
  }
  if (cfg.rawPrivateKey) {
    return privateKeyToAccount(cfg.rawPrivateKey);
  }
  throw new Error(
    "No signer configured: set TURNKEY_API_PUBLIC_KEY / TURNKEY_API_PRIVATE_KEY / TURNKEY_ORGANIZATION_ID / TURNKEY_SIGN_WITH (or HL_PRIVATE_KEY for dev)",
  );
}
