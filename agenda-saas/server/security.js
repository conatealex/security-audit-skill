import {
  randomBytes,
  createHash,
  scrypt as scryptCb,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { one, httpError } from "./db.js";
const scrypt = promisify(scryptCb);
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export const safeEqual = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$32768$${salt}$${key.toString("hex")}`;
}
export async function verifyPassword(password, stored) {
  const [scheme, n, salt, hex] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hex) return false;
  const expected = Buffer.from(hex, "hex");
  const actual = await scrypt(password, salt, 64, {
    N: Number(n),
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
let masterKey;
export async function getMasterKey() {
  if (masterKey) return masterKey;
  if (process.env.DATA_ENCRYPTION_KEY) {
    const key = Buffer.from(process.env.DATA_ENCRYPTION_KEY, "base64");
    if (key.length !== 32)
      throw new Error("DATA_ENCRYPTION_KEY deve conter 32 bytes em base64.");
    masterKey = key;
  } else {
    if (process.env.NODE_ENV === "production")
      throw new Error("DATA_ENCRYPTION_KEY é obrigatória em produção.");
    const file = path.resolve(
      process.env.LOCAL_KEY_PATH || "./data/.encryption-key",
    );
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      masterKey = await readFile(file);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      const key = randomBytes(32);
      try {
        await writeFile(file, key, { flag: "wx", mode: 0o600 });
        masterKey = key;
      } catch (writeError) {
        if (writeError.code !== "EEXIST") throw writeError;
        masterKey = await readFile(file);
      }
    }
    if (masterKey.length !== 32) throw new Error("Chave local inválida.");
  }
  return masterKey;
}
export async function encryptSecret(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await getMasterKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((x) => x.toString("base64url"))
    .join(".");
}
export async function decryptSecret(value) {
  const [iv, tag, data] = value
    .split(".")
    .map((x) => Buffer.from(x, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", await getMasterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8",
  );
}
export function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((x) => {
        const i = x.indexOf("=");
        return i < 0 ? ["", ""] : [x.slice(0, i).trim(), x.slice(i + 1).trim()];
      })
      .filter(([k]) => k),
  );
}
export async function authenticate(db, req, res, next) {
  try {
    const sessionToken = parseCookies(req.headers.cookie)[
      process.env.NODE_ENV === "production"
        ? "__Host-aurora_session"
        : "aurora_session"
    ];
    if (!sessionToken || sessionToken.length > 100)
      throw httpError(
        401,
        "Entre na sua conta para continuar.",
        "UNAUTHENTICATED",
      );
    const session = await one(
      db,
      `SELECT s.user_id,s.csrf_token,s.expires_at,u.name,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1`,
      [digest(sessionToken)],
    );
    if (!session || new Date(session.expires_at).getTime() <= Date.now())
      throw httpError(
        401,
        "Sua sessão expirou. Entre novamente.",
        "UNAUTHENTICATED",
      );
    const membership = await one(
      db,
      `SELECT m.tenant_id,m.role,t.name tenant_name,t.slug,t.timezone,p.id professional_id FROM memberships m JOIN tenants t ON t.id=m.tenant_id LEFT JOIN professionals p ON p.user_id=m.user_id AND p.tenant_id=m.tenant_id WHERE m.user_id=$1 ORDER BY t.created_at LIMIT 1`,
      [session.user_id],
    );
    if (!membership)
      throw httpError(403, "Conta sem espaço de trabalho.", "NO_MEMBERSHIP");
    req.auth = {
      ...membership,
      userId: session.user_id,
      name: session.name,
      email: session.email,
      csrf: session.csrf_token,
      type: "user",
    };
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !safeEqual(req.get("x-csrf-token"), session.csrf_token)
    )
      throw httpError(
        403,
        "Token de proteção ausente. Atualize a página.",
        "CSRF_INVALID",
      );
    next();
  } catch (e) {
    next(e);
  }
}
export function ownerOnly(req, res, next) {
  if (req.auth.role !== "owner")
    return next(
      httpError(
        403,
        "Apenas o administrador pode alterar esta configuração.",
        "FORBIDDEN",
      ),
    );
  next();
}
export function sameOrigin(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin");
  const fetchSite = req.get("sec-fetch-site");
  if (fetchSite === "cross-site")
    return next(httpError(403, "Origem não permitida.", "ORIGIN_INVALID"));
  if (origin) {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      return next(httpError(403, "Origem inválida.", "ORIGIN_INVALID"));
    }
    const allowed = process.env.APP_ORIGIN
      ? new URL(process.env.APP_ORIGIN).host
      : req.get("host");
    if (host !== allowed)
      return next(httpError(403, "Origem não permitida.", "ORIGIN_INVALID"));
  }
  next();
}
// DB-backed limit: correct for this single-process local edition; use shared storage when scaling.
export function dbRateLimit(
  db,
  namespace,
  max,
  windowMs,
  keyFn = (req) => req.ip,
) {
  return async (req, res, next) => {
    try {
      const raw = `${namespace}:${keyFn(req)}`;
      const key = digest(raw);
      const now = Date.now();
      const row = await one(
        db,
        `INSERT INTO rate_buckets(key,count,resets_at) VALUES($1,1,$2)
        ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_buckets.resets_at <= $3 THEN 1 ELSE rate_buckets.count+1 END,
        resets_at=CASE WHEN rate_buckets.resets_at <= $3 THEN $2 ELSE rate_buckets.resets_at END RETURNING count,resets_at`,
        [key, new Date(now + windowMs), new Date(now)],
      );
      if (row.count > max) {
        res.set(
          "Retry-After",
          String(
            Math.max(
              1,
              Math.ceil((new Date(row.resets_at).getTime() - now) / 1000),
            ),
          ),
        );
        throw httpError(
          429,
          "Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.",
          "RATE_LIMITED",
        );
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}
