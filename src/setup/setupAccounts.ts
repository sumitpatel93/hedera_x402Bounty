import {
  AccountBalanceQuery,
  AccountCreateTransaction,
  AccountId,
  Hbar,
  PrivateKey,
  TokenAssociateTransaction,
  TokenId,
  TransactionId,
} from "@hiero-ledger/sdk";
import { config } from "../config.js";
import { ariaClient } from "../hedera/client.js";
import { updateEnvFile } from "./envFile.js";

const NEW_ACCOUNT_FUNDING = new Hbar(15);
const MIN_ARIA_BALANCE = new Hbar(40);

async function createFundedAccount(label: string): Promise<{ accountId: string; privateKey: PrivateKey }> {
  const client = ariaClient();
  const privateKey = PrivateKey.generateED25519();

  const tx = await new AccountCreateTransaction()
    .setKeyWithoutAlias(privateKey.publicKey)
    .setInitialBalance(NEW_ACCOUNT_FUNDING)
    .execute(client);

  const receipt = await tx.getReceipt(client);
  const accountId = receipt.accountId;
  if (!accountId) throw new Error(`${label} account creation did not return an account id`);

  console.log(`Created ${label} account ${accountId.toString()} (funded with ${NEW_ACCOUNT_FUNDING.toString()})`);
  return { accountId: accountId.toString(), privateKey };
}

async function associateUsdc(accountId: string, key: PrivateKey | null, operatorClient: ReturnType<typeof ariaClient>) {
  const tx = new TokenAssociateTransaction()
    .setAccountId(AccountId.fromString(accountId))
    .setTokenIds([TokenId.fromString(config.usdcTokenId)])
    .setTransactionId(TransactionId.generate(AccountId.fromString(accountId)))
    .freezeWith(operatorClient);

  const signed = key ? await tx.sign(key) : tx;
  const executed = await signed.execute(operatorClient);
  const receipt = await executed.getReceipt(operatorClient);
  console.log(`Associated ${accountId} with USDC (${config.usdcTokenId}): ${receipt.status.toString()}`);
}

async function main() {
  const ariaAccountId = AccountId.fromString(config.aria.accountId);
  const client = ariaClient();

  const balance = await new AccountBalanceQuery().setAccountId(ariaAccountId).execute(client);
  console.log(`ARIA (${ariaAccountId.toString()}) balance: ${balance.hbars.toString()}`);
  if (balance.hbars.toTinybars().lt(MIN_ARIA_BALANCE.toTinybars())) {
    console.error(
      `ARIA needs at least ${MIN_ARIA_BALANCE.toString()} to fund the Issuer + Employee accounts. ` +
        `Top it up from the Hedera Portal faucet and re-run.`,
    );
    process.exit(1);
  }

  const issuer = await createFundedAccount("Issuer");
  const employee = await createFundedAccount("Employee");

  await associateUsdc(employee.accountId, employee.privateKey, client);
  await associateUsdc(config.aria.accountId, null, ariaClient());

  updateEnvFile({
    ISSUER_ACCOUNT_ID: issuer.accountId,
    ISSUER_PRIVATE_KEY: issuer.privateKey.toStringDer(),
    EMPLOYEE_ACCOUNT_ID: employee.accountId,
    EMPLOYEE_PRIVATE_KEY: employee.privateKey.toStringDer(),
  });

  console.log("\nWrote ISSUER_* and EMPLOYEE_* credentials to .env");
  console.log(`\nNext: fund ARIA (${config.aria.accountId}) with Testnet USDC from the Circle faucet`);
  console.log("(https://faucet.circle.com, select Hedera Testnet), then run `npm run setup:identity`.");

  client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
