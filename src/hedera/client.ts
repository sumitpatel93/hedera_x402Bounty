import { Client, AccountId } from "@hiero-ledger/sdk";
import { config, parseHederaPrivateKey } from "../config.js";

export function makeClient(accountId: string, privateKeyRaw: string): Client {
  const client = config.network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(AccountId.fromString(accountId), parseHederaPrivateKey(privateKeyRaw));
  return client;
}

export function ariaClient(): Client {
  return makeClient(config.aria.accountId, config.aria.privateKey);
}

export function issuerClient(): Client {
  return makeClient(config.issuer.accountId, config.issuer.privateKey);
}

export function employeeClient(): Client {
  return makeClient(config.employee.accountId, config.employee.privateKey);
}
