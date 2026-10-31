import { logger } from "./logger.js";

/**
 * Envio de e-mail transacional.
 *
 * Configuração por `SMTP_URL` (ex.: smtps://usuario:senha@smtp.exemplo.com:465).
 * Sem SMTP configurado o sistema continua funcionando: em desenvolvimento o
 * link aparece no log e no terminal; em produção o pedido é registrado como
 * "não enviado" e a API responde igual (sem revelar se o e-mail existe).
 */
const from = () =>
  process.env.MAIL_FROM || "Aurora Agenda <nao-responda@localhost>";
export const mailerConfigured = () => Boolean(process.env.SMTP_URL);

let transport;
async function getTransport() {
  if (transport !== undefined) return transport;
  if (!mailerConfigured()) {
    transport = null;
    return transport;
  }
  const { default: nodemailer } = await import("nodemailer");
  transport = nodemailer.createTransport(process.env.SMTP_URL, {
    connectionTimeout: Number(process.env.SMTP_TIMEOUT_MS || 10_000),
    greetingTimeout: Number(process.env.SMTP_TIMEOUT_MS || 10_000),
    socketTimeout: Number(process.env.SMTP_TIMEOUT_MS || 15_000),
  });
  return transport;
}

/** Só para testes: descarta o transporte memoizado. */
export function resetMailer() {
  transport = undefined;
}

export async function sendMail({ to, subject, text, html }) {
  const mail = await getTransport();
  if (!mail) {
    logger.warn("mail.not_configured", { reason: "SMTP_URL ausente" });
    return { delivered: false, reason: "not_configured" };
  }
  try {
    const info = await mail.sendMail({ from: from(), to, subject, text, html });
    logger.info("mail.sent", { messageId: info.messageId, to: maskEmail(to) });
    return { delivered: true, messageId: info.messageId };
  } catch (error) {
    // Falha de e-mail nunca derruba nem expõe detalhe do provedor ao cliente.
    logger.error("mail.failed", {
      code: error?.code || error?.name || "unknown",
      to: maskEmail(to),
    });
    return { delivered: false, reason: "smtp_error" };
  }
}

export const maskEmail = (value = "") => {
  const [user, domain] = String(value).split("@");
  if (!domain) return "***";
  const visible = user.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(1, Math.min(6, user.length - 2)))}@${domain}`;
};

export function passwordResetMessage({ name, link, minutes }) {
  const firstName =
    String(name || "")
      .trim()
      .split(/\s+/)[0] || "olá";
  const subject = "Redefinir sua senha — Aurora Agenda";
  const text = [
    `Olá, ${firstName}.`,
    "",
    "Recebemos um pedido para redefinir a senha da sua conta na Aurora Agenda.",
    `Abra este link para criar uma nova senha (vale por ${minutes} minutos e só pode ser usado uma vez):`,
    "",
    link,
    "",
    "Se não foi você, ignore esta mensagem: sua senha continua a mesma.",
  ].join("\n");
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;padding:24px;background:#f4f7f6;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#12201d">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #dde6e3;border-radius:14px;padding:28px">
    <p style="margin:0 0 16px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#167d72">Aurora Agenda</p>
    <h1 style="margin:0 0 12px;font-size:20px">Redefinir sua senha</h1>
    <p style="margin:0 0 8px">Olá, ${escapeHtml(firstName)}.</p>
    <p style="margin:0 0 20px">Recebemos um pedido para redefinir a senha da sua conta. O link vale por <strong>${minutes} minutos</strong> e funciona <strong>uma única vez</strong>.</p>
    <p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#167d72;color:#fff;text-decoration:none;padding:13px 22px;border-radius:10px;font-weight:600">Criar nova senha</a></p>
    <p style="margin:0 0 8px;font-size:13px;color:#4d5f5a">Se o botão não abrir, copie o endereço:<br><span style="word-break:break-all">${escapeHtml(link)}</span></p>
    <p style="margin:16px 0 0;font-size:13px;color:#4d5f5a">Se não foi você, ignore esta mensagem: sua senha continua a mesma.</p>
  </div>
</body></html>`;
  return { subject, text, html };
}

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
