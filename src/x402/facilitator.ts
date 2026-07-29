import { PrivateKey } from "@hiero-ledger/sdk";
import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/server";
import type { SupportedResponse } from "@x402/core/types";
import { ExactHederaScheme as ExactHederaFacilitatorScheme } from "@x402/hedera/exact/facilitator";
import {
  createHederaClient,
  createHederaPreflightTransfer,
  createHederaSignAndSubmitTransaction,
  createHederaVerifyPayerSignature,
  toFacilitatorHederaSigner,
} from "@x402/hedera";
import { caipNetwork } from "../config.js";

/**
 * A self-hosted, in-process x402 facilitator. The employee's resource server
 * settles its own incoming payments: it verifies the payer's signature and
 * on-chain preflight via the public Hedera mirror node, then submits the
 * transfer using its own key as fee payer (a trivial network fee).
 */
export function buildLocalFacilitator(feePayerAccountId: string, feePayerKey: PrivateKey): FacilitatorClient {
  const signer = toFacilitatorHederaSigner({
    getAddresses: () => [feePayerAccountId],
    signAndSubmitTransaction: createHederaSignAndSubmitTransaction((network) => createHederaClient(network), feePayerKey),
    verifyPayerSignature: createHederaVerifyPayerSignature(),
    preflightTransfer: createHederaPreflightTransfer(),
  });

  const facilitator = new x402Facilitator().register(caipNetwork, new ExactHederaFacilitatorScheme(signer));

  return {
    verify: (paymentPayload, paymentRequirements) => facilitator.verify(paymentPayload, paymentRequirements),
    settle: (paymentPayload, paymentRequirements) => facilitator.settle(paymentPayload, paymentRequirements),
    getSupported: async () => facilitator.getSupported() as unknown as SupportedResponse,
  };
}
