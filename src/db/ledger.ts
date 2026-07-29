import Database from "better-sqlite3";
import { resolve } from "path";

const db = new Database(resolve(process.cwd(), "aria.sqlite"));

db.exec(`
  CREATE TABLE IF NOT EXISTS reimbursements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_did TEXT NOT NULL,
    year_month TEXT NOT NULL,
    amount_usd REAL NOT NULL,
    description TEXT,
    credential_id TEXT,
    transaction_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reimbursements_employee_month
    ON reimbursements (employee_did, year_month);
`);

function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

export function getMonthSpendUsd(employeeDid: string, yearMonth = currentYearMonth()): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(amount_usd), 0) AS total FROM reimbursements WHERE employee_did = ? AND year_month = ?`)
    .get(employeeDid, yearMonth) as { total: number };
  return row.total;
}

export interface SpendCheckResult {
  allowed: boolean;
  currentSpendUsd: number;
  requestedUsd: number;
  limitUsd: number;
  remainingUsd: number;
}

export function checkSpendLimit(employeeDid: string, requestedUsd: number, limitUsd: number): SpendCheckResult {
  const currentSpendUsd = getMonthSpendUsd(employeeDid);
  const remainingUsd = limitUsd - currentSpendUsd;
  return {
    allowed: requestedUsd <= remainingUsd,
    currentSpendUsd,
    requestedUsd,
    limitUsd,
    remainingUsd,
  };
}

export function recordReimbursement(params: {
  employeeDid: string;
  amountUsd: number;
  description: string;
  credentialId: string;
  transactionId: string;
}): void {
  db.prepare(
    `INSERT INTO reimbursements (employee_did, year_month, amount_usd, description, credential_id, transaction_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.employeeDid,
    currentYearMonth(),
    params.amountUsd,
    params.description,
    params.credentialId,
    params.transactionId,
    new Date().toISOString(),
  );
}
