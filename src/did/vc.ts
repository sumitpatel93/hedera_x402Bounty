import { randomUUID } from "crypto";
import { Client, PrivateKey } from "@hiero-ledger/sdk";
import { publishDidEvent, resolveDid } from "./did.js";

export interface VerifiableCredential {
  "@context": string[];
  id: string;
  type: string[];
  issuer: string;
  issuanceDate: string;
  credentialSubject: {
    id: string;
    role: string;
    monthlySpendLimitUsd: number;
  };
  proof: {
    type: string;
    created: string;
    verificationMethod: string;
    proofPurpose: string;
    signatureValue: string;
  };
}

type UnsignedVc = Omit<VerifiableCredential, "proof">;

function credentialSigningBytes(vc: UnsignedVc): Buffer {
  return Buffer.from(JSON.stringify(vc));
}

export function issueVc(
  issuerKey: PrivateKey,
  issuerDid: string,
  employeeDid: string,
  claims: { role: string; monthlySpendLimitUsd: number },
): VerifiableCredential {
  const unsigned: UnsignedVc = {
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    id: `urn:uuid:${randomUUID()}`,
    type: ["VerifiableCredential", "EmployeeSpendCredential"],
    issuer: issuerDid,
    issuanceDate: new Date().toISOString(),
    credentialSubject: {
      id: employeeDid,
      role: claims.role,
      monthlySpendLimitUsd: claims.monthlySpendLimitUsd,
    },
  };

  const signature = issuerKey.sign(credentialSigningBytes(unsigned));
  return {
    ...unsigned,
    proof: {
      type: "Ed25519Signature2020",
      created: new Date().toISOString(),
      verificationMethod: `${issuerDid}#did-root-key`,
      proofPurpose: "assertionMethod",
      signatureValue: Buffer.from(signature).toString("base64"),
    },
  };
}

/** Anchors an issuer-signed VC onto the *employee's* HCS DID topic. */
export async function anchorVc(
  employeeClient: Client,
  employeeTopicId: string,
  employeeKey: PrivateKey,
  employeeDid: string,
  vc: VerifiableCredential,
): Promise<void> {
  await publishDidEvent(employeeClient, employeeTopicId, employeeKey, "vc-issue", employeeDid, vc);
}

export async function revokeVc(
  employeeClient: Client,
  employeeTopicId: string,
  employeeKey: PrivateKey,
  employeeDid: string,
  credentialId: string,
): Promise<void> {
  await publishDidEvent(employeeClient, employeeTopicId, employeeKey, "vc-revoke", employeeDid, { id: credentialId });
}

export interface VcVerificationResult {
  valid: boolean;
  reason?: string;
  credential?: VerifiableCredential;
}

/**
 * Full trust chain: resolve the employee's DID topic on HCS via the mirror
 * node, locate the VC by id, verify it was actually signed by the Corporate
 * Issuer's key (resolved independently from the Issuer's own DID), and check
 * it hasn't been revoked.
 */
export async function verifyVc(employeeDid: string, credentialId: string, expectedIssuerDid: string): Promise<VcVerificationResult> {
  const employeeResolved = await resolveDid(employeeDid);

  let found: { credential: VerifiableCredential; consensusTimestamp: string } | null = null;
  for (const e of employeeResolved.events) {
    if (e.envelope.operation !== "vc-issue") continue;
    const vc: VerifiableCredential = JSON.parse(Buffer.from(e.envelope.event, "base64").toString("utf8"));
    if (vc.id === credentialId) found = { credential: vc, consensusTimestamp: e.consensusTimestamp };
  }
  if (!found) return { valid: false, reason: "credential_not_found_on_hcs" };

  if (found.credential.issuer !== expectedIssuerDid) return { valid: false, reason: "issuer_mismatch" };
  if (found.credential.credentialSubject.id !== employeeDid) return { valid: false, reason: "subject_mismatch" };

  const issuerResolved = await resolveDid(expectedIssuerDid);
  if (!issuerResolved.document) return { valid: false, reason: "issuer_did_unresolvable" };

  const { proof, ...unsigned } = found.credential;
  const signatureOk = issuerResolved.publicKey.verify(
    credentialSigningBytes(unsigned),
    Buffer.from(proof.signatureValue, "base64"),
  );
  if (!signatureOk) return { valid: false, reason: "invalid_issuer_signature" };

  const revokedLater = employeeResolved.events.some((e) => {
    if (e.envelope.operation !== "vc-revoke") return false;
    const payload = JSON.parse(Buffer.from(e.envelope.event, "base64").toString("utf8"));
    return payload.id === credentialId && e.consensusTimestamp > found!.consensusTimestamp;
  });
  if (revokedLater) return { valid: false, reason: "revoked" };

  return { valid: true, credential: found.credential };
}
