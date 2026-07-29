import { x402Client } from "@x402/core/client";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createClientHederaSigner, ExactHederaScheme as ExactHederaClientScheme } from "@x402/hedera";
import { caipNetwork, config, hashscanTxUrl, parseHederaPrivateKey } from "../config.js";

export interface PayInvoiceResult {
  success: boolean;
  transactionId?: string;
  hashscanUrl?: string;
  errorReason?: string;
  raw?: unknown;
}

/**
 * ARIA acts as the x402 *client* here (the flow is inverted from a typical
 * paywall): it hits the employee's /receive-payment endpoint, receives a 402
 * with Hedera USDC payment requirements, and automatically pays it.
 */
export async function payInvoiceViaX402(amountUsd: number, description: string): Promise<PayInvoiceResult> {
  const ariaKey = parseHederaPrivateKey(config.aria.privateKey);
  const signer = createClientHederaSigner(config.aria.accountId, ariaKey);
  const client = new x402Client().register(caipNetwork, new ExactHederaClientScheme(signer));
  const fetchWithPay = wrapFetchWithPayment(fetch, client);

  const res = await fetchWithPay(`${config.employeeServerUrl}/receive-payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amountUsd, description }),
  });

  // Despite the "X-PAYMENT-RESPONSE" name used elsewhere in x402 docs/examples,
  // @x402/core's Express server actually sets the header as "PAYMENT-RESPONSE" (no X- prefix).
  const paymentResponseHeader = res.headers.get("PAYMENT-RESPONSE");
  const settlement = paymentResponseHeader ? decodePaymentResponseHeader(paymentResponseHeader) : undefined;

  if (!res.ok || !settlement || !settlement.success) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text();
    }
    return {
      success: false,
      errorReason: settlement?.errorReason ?? `http_${res.status}`,
      raw: { body, settlement },
    };
  }

  const body = await res.json();
  return {
    success: true,
    transactionId: settlement.transaction,
    hashscanUrl: hashscanTxUrl(settlement.transaction),
    raw: { body, settlement },
  };
}
