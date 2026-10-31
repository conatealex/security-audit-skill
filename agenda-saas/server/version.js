import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Versão exibida em /api/ready e nos logs.
 * Ordem: APP_VERSION → package.json ao lado do servidor → package.json do
 * diretório de trabalho (bundle serverless) → "unknown".
 */
function readPackageVersion(candidate) {
  try {
    return JSON.parse(readFileSync(candidate, "utf8")).version || null;
  } catch {
    return null;
  }
}

function resolveVersion() {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  const candidates = [];
  try {
    candidates.push(new URL("../package.json", import.meta.url));
  } catch {
    // bundle sem import.meta
  }
  candidates.push(path.join(process.cwd(), "package.json"));
  for (const candidate of candidates) {
    const version = readPackageVersion(candidate);
    if (version) return version;
  }
  return "unknown";
}

export const APP_VERSION = resolveVersion();
