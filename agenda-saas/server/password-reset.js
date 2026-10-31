import { randomBytes } from "node:crypto";
import { one, transaction, audit } from "./db.js";
import { digest, hashPassword } from "./security.js";
import { logger } from "./logger.js";
import { sendMail, passwordResetMessage, mailerConfigured } from "./mailer.js";

export const RESET_TTL_MINUTES = () =>
  Number(process.env.RESET_TOKEN_TTL_MINUTES || 30);
/** Contas técnicas (login desabilitado) nunca recebem link de redefinição. */
const hasRealPassword = (hash) =>
  typeof hash === "string" && !hash.startsWith("!");

const baseOrigin = () =>
  (process.env.APP_ORIGIN || "http://localhost:3000").replace(/\/+$/, "");

export const resetLink = (rawToken) => `${baseOrigin()}/redefinir#${rawToken}`;

/**
 * Pedido de redefinição.
 *
 * Responde sempre igual — exista ou não a conta — para não permitir descobrir
 * quem tem cadastro. O token fica guardado só como hash, vale uma vez e expira.
 */
export async function requestPasswordReset(db, emailAddress) {
  const user = await one(
    db,
    `SELECT u.id, u.name, u.email, u.password_hash, m.tenant_id
       FROM users u LEFT JOIN memberships m ON m.user_id = u.id
      WHERE u.email=$1
      ORDER BY m.tenant_id NULLS LAST
      LIMIT 1`,
    [String(emailAddress).trim().toLowerCase()],
  );
  if (!user || !hasRealPassword(user.password_hash)) {
    logger.info("password_reset.ignored", {
      reason: user ? "login_disabled" : "unknown_email",
    });
    return { sent: false, reason: "ignored" };
  }

  const raw = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES() * 60_000);
  await transaction(db, async (tx) => {
    // Um link válido por vez: pedir de novo invalida o anterior.
    await tx.query(
      "UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL",
      [user.id],
    );
    await tx.query(
      "INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
      [digest(raw), user.id, expiresAt],
    );
    await audit(
      tx,
      user.tenant_id,
      { type: "anonymous" },
      "account.password_reset_requested",
      user.id,
      {},
    );
  });

  const link = resetLink(raw);
  const delivery = await sendMail({
    to: user.email,
    ...passwordResetMessage({
      name: user.name,
      link,
      minutes: RESET_TTL_MINUTES(),
    }),
  });
  if (!delivery.delivered && !mailerConfigured()) {
    // Desenvolvimento sem SMTP: o link vai para o terminal para não travar o fluxo.
    logger.warn("password_reset.link", { link });
    if (process.env.NODE_ENV !== "production")
      console.log(`\nLink de redefinição: ${link}\n`);
  }
  return { sent: delivery.delivered, reason: delivery.reason };
}

export class ResetError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.status = 400;
    this.expose = true;
  }
}

/**
 * Consome o token e troca a senha. Marca o token como usado na mesma transação
 * em que a senha muda, e derruba todas as sessões abertas daquela conta.
 */
export async function confirmPasswordReset(db, rawToken, newPassword) {
  const hash = digest(String(rawToken || ""));
  return transaction(db, async (tx) => {
    const row = await one(
      tx,
      "SELECT token_hash, user_id, expires_at, used_at FROM password_resets WHERE token_hash=$1 FOR UPDATE",
      [hash],
    );
    if (!row)
      throw new ResetError(
        "Este link de redefinição não é válido.",
        "RESET_INVALID",
      );
    if (row.used_at)
      throw new ResetError(
        "Este link já foi utilizado. Peça um novo.",
        "RESET_USED",
      );
    if (new Date(row.expires_at).getTime() <= Date.now())
      throw new ResetError("Este link expirou. Peça um novo.", "RESET_EXPIRED");

    const user = await one(
      tx,
      `SELECT u.id, m.tenant_id FROM users u LEFT JOIN memberships m ON m.user_id = u.id
        WHERE u.id=$1 ORDER BY m.tenant_id NULLS LAST LIMIT 1 FOR UPDATE OF u`,
      [row.user_id],
    );
    if (!user)
      throw new ResetError(
        "Este link de redefinição não é válido.",
        "RESET_INVALID",
      );

    const passwordHash = await hashPassword(newPassword);
    await tx.query("UPDATE users SET password_hash=$2 WHERE id=$1", [
      row.user_id,
      passwordHash,
    ]);
    await tx.query(
      "UPDATE password_resets SET used_at=now() WHERE token_hash=$1",
      [hash],
    );
    await tx.query(
      "UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL",
      [row.user_id],
    );
    const sessions = await tx.query("DELETE FROM sessions WHERE user_id=$1", [
      row.user_id,
    ]);
    await audit(
      tx,
      user.tenant_id,
      { type: "user", userId: row.user_id },
      "account.password_reset_completed",
      row.user_id,
      {},
    );
    logger.info("password_reset.completed", {
      sessionsRevoked: sessions.affectedRows ?? 0,
    });
    return { userId: row.user_id, sessionsRevoked: sessions.affectedRows ?? 0 };
  });
}

/** Valida o token sem consumir, para a tela mostrar erro antes do formulário. */
export async function inspectResetToken(db, rawToken) {
  const row = await one(
    db,
    `SELECT pr.used_at, pr.expires_at, u.email
       FROM password_resets pr JOIN users u ON u.id = pr.user_id
      WHERE pr.token_hash=$1`,
    [digest(String(rawToken || ""))],
  );
  if (!row) return { valid: false, reason: "not_found" };
  if (row.used_at) return { valid: false, reason: "used" };
  if (new Date(row.expires_at).getTime() <= Date.now())
    return { valid: false, reason: "expired" };
  const [user, domain] = String(row.email).split("@");
  return {
    valid: true,
    email: `${user.slice(0, 2)}${"*".repeat(Math.max(1, Math.min(6, user.length - 2)))}@${domain}`,
    expiresAt: row.expires_at,
  };
}
