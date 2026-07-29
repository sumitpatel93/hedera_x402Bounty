import { config, parseHederaPrivateKey } from "../config.js";
import { employeeClient, issuerClient } from "../hedera/client.js";
import { createDid, resolveDid } from "../did/did.js";
import { anchorVc, issueVc, verifyVc } from "../did/vc.js";
import { retry } from "../util/retry.js";
import { updateEnvFile } from "./envFile.js";

async function main() {
  const issuerKey = parseHederaPrivateKey(config.issuer.privateKey);
  const employeeKey = parseHederaPrivateKey(config.employee.privateKey);

  console.log("Anchoring Corporate Issuer DID to a new HCS topic...");
  const issuerDidResult = await createDid(issuerClient(), issuerKey);
  console.log(`  Issuer DID:       ${issuerDidResult.did}`);
  console.log(`  Issuer DID topic: ${issuerDidResult.topicId}`);

  console.log("\nAnchoring Employee DID to a new HCS topic...");
  const employeeDidResult = await createDid(employeeClient(), employeeKey);
  console.log(`  Employee DID:       ${employeeDidResult.did}`);
  console.log(`  Employee DID topic: ${employeeDidResult.topicId}`);

  updateEnvFile({
    ISSUER_DID: issuerDidResult.did,
    ISSUER_DID_TOPIC_ID: issuerDidResult.topicId,
    EMPLOYEE_DID: employeeDidResult.did,
    EMPLOYEE_DID_TOPIC_ID: employeeDidResult.topicId,
  });

  console.log(`\nIssuer signing Verifiable Credential (monthly limit: $${config.monthlyLimitUsd})...`);
  const vc = issueVc(issuerKey, issuerDidResult.did, employeeDidResult.did, {
    role: "Employee",
    monthlySpendLimitUsd: config.monthlyLimitUsd,
  });
  console.log(`  Credential id: ${vc.id}`);

  console.log("Anchoring signed VC onto the Employee's HCS DID topic...");
  await anchorVc(employeeClient(), employeeDidResult.topicId, employeeKey, employeeDidResult.did, vc);

  updateEnvFile({ ACTIVE_VC_ID: vc.id });

  console.log("\nWaiting for mirror node ingestion, then verifying round-trip...");
  const resolved = await retry(() => resolveDid(employeeDidResult.did), {
    isReady: (r) => r.document !== null,
  });
  console.log(`  Resolved employee DID document: ${resolved.document ? "OK" : "MISSING"}`);

  const verification = await retry(() => verifyVc(employeeDidResult.did, vc.id, issuerDidResult.did), {
    isReady: (r) => r.valid || r.reason !== "credential_not_found_on_hcs",
  });
  console.log(`  VC verification: ${verification.valid ? "VALID" : `INVALID (${verification.reason})`}`);

  console.log("\nIdentity setup complete. Run `npm run cli` to simulate a reimbursement request.");

  issuerClient().close();
  employeeClient().close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
