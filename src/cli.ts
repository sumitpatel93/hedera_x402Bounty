import prompts from "prompts";
import { config } from "./config.js";
import { resolveDid } from "./did/did.js";
import { verifyVc } from "./did/vc.js";
import { checkSpendLimit, recordReimbursement } from "./db/ledger.js";
import { startEmployeeServer } from "./x402/employeeServer.js";
import { payInvoiceViaX402 } from "./x402/ariaAgent.js";

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function processExpenseRequest(amountUsd: number, description: string) {
  const employeeDid = config.employee.did;
  const issuerDid = config.issuer.did;
  const credentialId = config.activeVcId;

  if (!employeeDid || !issuerDid || !credentialId) {
    console.error("Missing DID/VC setup. Run `npm run setup:identity` first.");
    process.exit(1);
  }

  section("1. Resolve Employee DID on HCS");
  const resolved = await resolveDid(employeeDid);
  console.log(`DID:              ${employeeDid}`);
  console.log(`HCS topic:        ${resolved.topicId}`);
  console.log(`Document resolved: ${resolved.document ? "yes" : "no"}`);
  console.log(`Deactivated:      ${resolved.deactivated}`);
  if (!resolved.document || resolved.deactivated) {
    console.error("DID resolution failed - aborting payout.");
    process.exit(1);
  }

  section("2. Verify Verifiable Credential (issuer signature + revocation)");
  const vcResult = await verifyVc(employeeDid, credentialId, issuerDid);
  console.log(`Credential id:    ${credentialId}`);
  console.log(`Issuer DID:       ${issuerDid}`);
  console.log(`Valid:            ${vcResult.valid}`);
  if (!vcResult.valid || !vcResult.credential) {
    console.error(`VC invalid (${vcResult.reason}) - aborting payout.`);
    process.exit(1);
  }
  const limitUsd = vcResult.credential.credentialSubject.monthlySpendLimitUsd;
  console.log(`Monthly limit:    $${limitUsd}`);

  section("3. Check spend limit (local SQLite ledger)");
  const spendCheck = checkSpendLimit(employeeDid, amountUsd, limitUsd);
  console.log(`Spent this month: $${spendCheck.currentSpendUsd.toFixed(2)}`);
  console.log(`Requested:        $${spendCheck.requestedUsd.toFixed(2)}`);
  console.log(`Remaining budget: $${spendCheck.remainingUsd.toFixed(2)}`);
  if (!spendCheck.allowed) {
    console.error("Spend limit exceeded - aborting payout.");
    process.exit(1);
  }

  section("4. Execute x402 payment over Hedera (HTS USDC)");
  const payment = await payInvoiceViaX402(amountUsd, description);
  if (!payment.success) {
    console.error(`Payment failed: ${payment.errorReason}`);
    console.error(JSON.stringify(payment.raw, null, 2));
    process.exit(1);
  }
  console.log(`Transaction id:   ${payment.transactionId}`);
  console.log(`HashScan:         ${payment.hashscanUrl}`);

  recordReimbursement({
    employeeDid,
    amountUsd,
    description,
    credentialId,
    transactionId: payment.transactionId!,
  });

  section("Done");
  console.log(`Reimbursed $${amountUsd.toFixed(2)} to ${employeeDid} for "${description}".`);
}

function parseCliArgs(): { amountUsd: number; description: string } | null {
  const args = process.argv.slice(2);
  const amountArg = args.find((a) => a.startsWith("--amount="))?.split("=")[1];
  const descriptionArg = args.find((a) => a.startsWith("--description="))?.split("=")[1];
  if (amountArg == null) return null;
  return { amountUsd: Number(amountArg), description: descriptionArg ?? "Reimbursement" };
}

async function main() {
  console.log("Starting Employee Agent resource server (x402 payee)...");
  const employeeServer = await startEmployeeServer();
  console.log(`Employee Agent listening at ${employeeServer.url}`);

  const cliArgs = parseCliArgs();
  const answers = cliArgs ?? (await prompts([
    { type: "number", name: "amountUsd", message: "Reimbursement amount (USD)", initial: 20 },
    { type: "text", name: "description", message: "Receipt description", initial: "Monthly SaaS subscription" },
  ]));

  if (answers.amountUsd == null) {
    employeeServer.close();
    return;
  }

  try {
    await processExpenseRequest(Number(answers.amountUsd), String(answers.description));
  } finally {
    employeeServer.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
