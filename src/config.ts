import "dotenv/config";
import { PrivateKey } from "@hiero-ledger/sdk";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/**
 * ECDSA keys from the Hedera Portal are handed out as 0x-prefixed hex.
 * Freshly generated Ed25519 keys in this project are stored DER-encoded.
 */
export function parseHederaPrivateKey(raw: string): PrivateKey {
  const trimmed = raw.trim();
  if (trimmed.startsWith("0x")) {
    return PrivateKey.fromStringECDSA(trimmed.slice(2));
  }
  return PrivateKey.fromString(trimmed);
}

export const config = {
  network: process.env.HEDERA_NETWORK ?? "testnet",
  mirrorNodeUrl: process.env.MIRROR_NODE_URL ?? "https://testnet.mirrornode.hedera.com",
  usdcTokenId: process.env.USDC_TOKEN_ID ?? "0.0.429274",

  aria: {
    accountId: required("ARIA_ACCOUNT_ID"),
    privateKey: required("ARIA_PRIVATE_KEY"),
  },

  get issuer() {
    return {
      accountId: required("ISSUER_ACCOUNT_ID"),
      privateKey: required("ISSUER_PRIVATE_KEY"),
      did: optional("ISSUER_DID"),
      didTopicId: optional("ISSUER_DID_TOPIC_ID"),
    };
  },

  get employee() {
    return {
      accountId: required("EMPLOYEE_ACCOUNT_ID"),
      privateKey: required("EMPLOYEE_PRIVATE_KEY"),
      did: optional("EMPLOYEE_DID"),
      didTopicId: optional("EMPLOYEE_DID_TOPIC_ID"),
    };
  },

  monthlyLimitUsd: Number(process.env.EMPLOYEE_MONTHLY_LIMIT_USD ?? "150"),
  activeVcId: optional("ACTIVE_VC_ID"),

  employeeServerPort: Number(process.env.EMPLOYEE_SERVER_PORT ?? "4000"),
  employeeServerUrl: process.env.EMPLOYEE_SERVER_URL ?? "http://localhost:4000",
};

export const caipNetwork = config.network === "mainnet" ? "hedera:mainnet" : "hedera:testnet";

export function hashscanTxUrl(transactionId: string): string {
  // HashScan expects the raw Hedera transaction id (account@seconds.nanos) verbatim.
  return `https://hashscan.io/${config.network}/transaction/${transactionId}`;
}

export function hashscanAccountUrl(accountId: string): string {
  return `https://hashscan.io/${config.network}/account/${accountId}`;
}
