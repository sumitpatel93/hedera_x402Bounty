import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

const ENV_PATH = resolve(process.cwd(), ".env");

export function updateEnvFile(updates: Record<string, string>): void {
  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const lines = existing.split("\n");
  const seen = new Set<string>();

  const newLines = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match) return line;
    const key = match[1];
    if (key in updates) {
      seen.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) newLines.push(`${key}=${value}`);
  }

  writeFileSync(ENV_PATH, newLines.join("\n"));
  for (const key of Object.keys(updates)) {
    process.env[key] = updates[key];
  }
}
