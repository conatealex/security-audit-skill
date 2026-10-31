let csrf = "";

/** Mensagem única para quando o endereço publicado não tem API por trás. */
export const API_OFFLINE_MESSAGE =
  "Esta página está publicada apenas como site estático: não existe servidor de API neste endereço. " +
  "Publique o projeto com Node.js e PostgreSQL (veja DEPLOY.md) ou aponte /api para um servidor real.";

export function setCsrf(value) {
  csrf = value || "";
}

const offline = (status) =>
  Object.assign(new Error(API_OFFLINE_MESSAGE), {
    status: status || 0,
    code: "API_UNAVAILABLE",
  });

export async function api(path, options = {}) {
  const { body, method = "GET", ...rest } = options;
  let response;
  try {
    response = await fetch("/api" + path, {
      method,
      credentials: "same-origin",
      ...rest,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        ...rest.headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    // Rede indisponível, DNS errado ou offline: não é erro de validação.
    throw Object.assign(offline(0), { network: true });
  }

  const type = response.headers.get("content-type") || "";
  // Hospedagem estática devolve HTML (a página) ou 404 na rota /api — sem JSON,
  // não há servidor. Antes isso aparecia como "Não foi possível conectar".
  if (!type.toLowerCase().includes("application/json"))
    throw offline(response.status);

  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Object.assign(
      new Error(
        data.error?.message || "Não foi possível conectar. Tente novamente.",
      ),
      { status: response.status, code: data.error?.code },
    );
  return data;
}

/** Sonda usada na abertura do painel para avisar cedo que a API não responde. */
export async function apiProbe() {
  try {
    const response = await fetch("/api/health", {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    });
    const type = response.headers.get("content-type") || "";
    if (!response.ok || !type.toLowerCase().includes("application/json"))
      return { ok: false, reason: API_OFFLINE_MESSAGE };
    const data = await response.json().catch(() => ({}));
    return data?.ok
      ? { ok: true, data }
      : { ok: false, reason: API_OFFLINE_MESSAGE };
  } catch {
    return { ok: false, reason: API_OFFLINE_MESSAGE, network: true };
  }
}

export const dateLabel = (value, options = {}) =>
  new Date(value).toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "short",
    ...options,
  });
export const timeLabel = (value) =>
  new Date(value).toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  });
export const dayKey = (value) =>
  new Date(value).toLocaleDateString("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
export const todayKey = () => dayKey(new Date());
export const addDays = (day, n) => {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const money = (cents) =>
  (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
export const statusNames = {
  pending: "Aguardando resposta",
  confirmed: "Confirmado",
  cancelled: "Cancelado",
  completed: "Concluído",
  queued: "Na fila",
  processing: "Enviando",
  sent: "Enviada à Meta",
  failed: "Rejeitada",
  skipped: "Não enviada",
  unknown: "Entrega não confirmada",
  dead: "Descartada após tentativas",
};
export const kindNames = {
  confirmation: "Confirmação",
  reminder_24h: "Lembrete · 1 dia antes",
  reminder_2h: "Lembrete · 2 horas antes",
  cancellation: "Cancelamento",
};
