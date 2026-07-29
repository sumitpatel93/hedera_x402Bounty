import express, { Request, Response } from "express";
import { paymentMiddlewareFromConfig } from "@x402/express";
import { HEDERA_TESTNET_USDC } from "@x402/hedera";
import { ExactHederaScheme as ExactHederaServerScheme } from "@x402/hedera/exact/server";
import { caipNetwork, config, parseHederaPrivateKey } from "../config.js";
import { buildLocalFacilitator } from "./facilitator.js";

const USDC_DECIMALS = 6;

export interface EmployeeServerHandle {
  url: string;
  close: () => void;
}

/**
 * The Employee Agent's resource server. ARIA (the x402 client) POSTs an
 * invoice here; the route is protected by x402 payment middleware, so the
 * first hit returns 402 with Hedera USDC payment requirements, and only a
 * correctly paid retry reaches the handler below.
 */
export async function startEmployeeServer(): Promise<EmployeeServerHandle> {
  const app = express();
  app.use(express.json());

  const facilitator = buildLocalFacilitator(config.employee.accountId, parseHederaPrivateKey(config.employee.privateKey));

  app.use(
    paymentMiddlewareFromConfig(
      {
        "/receive-payment": {
          description: "ARIA expense reimbursement payout",
          accepts: {
            scheme: "exact",
            payTo: config.employee.accountId,
            network: caipNetwork,
            maxTimeoutSeconds: 120,
            price: (context) => {
              const body = (context.adapter.getBody?.() ?? {}) as { amountUsd?: number };
              const amountUsd = Number(body.amountUsd ?? 0);
              const amount = Math.round(amountUsd * 10 ** USDC_DECIMALS).toString();
              return { asset: HEDERA_TESTNET_USDC, amount };
            },
          },
        },
      },
      facilitator,
      [{ network: caipNetwork, server: new ExactHederaServerScheme() }],
    ),
  );

  app.post("/receive-payment", (req: Request, res: Response) => {
    res.json({
      status: "paid",
      amountUsd: req.body.amountUsd,
      description: req.body.description,
      employeeAccountId: config.employee.accountId,
    });
  });

  return new Promise((resolvePromise) => {
    const server = app.listen(config.employeeServerPort, () => {
      resolvePromise({
        url: `http://localhost:${config.employeeServerPort}`,
        close: () => server.close(),
      });
    });
  });
}
