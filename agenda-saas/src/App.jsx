import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
} from "react";
import {
  Routes,
  Route,
  NavLink,
  Navigate,
  useNavigate,
  Link,
  useParams,
  useLocation,
} from "react-router-dom";
import {
  ArrowUpRight,
  ArrowRight,
  ArrowLeft,
  CalendarDays,
  LayoutDashboard,
  Users,
  MessageCircle,
  Settings,
  LogOut,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Plus,
  Clock3,
  Check,
  X,
  CheckCheck,
  CircleCheck,
  CircleAlert,
  ShieldCheck,
  Link as LinkIcon,
  Copy,
  ExternalLink,
  Sparkles,
  Bell,
  Search,
  SlidersHorizontal,
  MoreHorizontal,
  Send,
  LockKeyhole,
  Mail,
  Eye,
  EyeOff,
  Menu,
  Stethoscope,
  CalendarCheck2,
  RefreshCw,
  CircleHelp,
  LoaderCircle,
  Flower2,
  CheckCircle2,
  Trash2,
  Ban,
  List,
  Grid2X2,
  Inbox,
  Activity,
  Globe,
  HeartHandshake,
} from "lucide-react";
import {
  api,
  apiProbe,
  API_OFFLINE_MESSAGE,
  setCsrf,
  dateLabel,
  timeLabel,
  dayKey,
  todayKey,
  addDays,
  money,
  statusNames,
  kindNames,
} from "./api.js";

const AuthContext = createContext(null);
const ToastContext = createContext(null);
const useAuth = () => useContext(AuthContext);
const useToast = () => useContext(ToastContext);
export function Brand({ light = false }) {
  return (
    <Link to="/" className={`brand ${light ? "brand-light" : ""}`}>
      <span className="brand-symbol">
        <Flower2 size={29} strokeWidth={1.8} />
      </span>
      <span>
        aurora<span className="brand-sub">AGENDA INTELIGENTE</span>
      </span>
    </Link>
  );
}
export function Badge({ status, children }) {
  return (
    <span className={`badge badge-${status}`}>
      <span className="status-dot" />
      {children || statusNames[status] || status}
    </span>
  );
}
export function Empty({ icon: Icon = CalendarDays, title, children }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon size={27} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading-state">
      <LoaderCircle className="spin" size={25} />
      <span>Organizando sua agenda…</span>
    </div>
  );
}
export function ErrorBox({ error }) {
  return error ? (
    <div className="notice notice-error" role="alert">
      <CircleAlert size={18} />
      <span>{typeof error === "string" ? error : error.message}</span>
    </div>
  ) : null;
}
function Modal({ title, subtitle, children, onClose, wide = false }) {
  const dialog = useRef(null),
    close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement,
      overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () =>
      [
        ...dialog.current.querySelectorAll(
          'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
        ),
      ].filter((el) => el.getClientRects().length);
    (
      dialog.current.querySelector('input:not([type="checkbox"]),textarea') ||
      focusable()[0]
    )?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
      }
      if (e.key === "Tab") {
        const items = focusable(),
          first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Fechar">
            <X size={20} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
function useResource(path) {
  const [data, setData] = useState(null),
    [error, setError] = useState(null),
    [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    api(path)
      .then((d) => {
        if (live) setData(d);
      })
      .catch((e) => {
        if (live) setError(e);
      });
    return () => {
      live = false;
    };
  }, [path, version]);
  return { data, error, reload, setData };
}

/** Aviso permanente quando o endereço publicado não tem API por trás. */
function ApiOfflineBanner({ reason }) {
  return (
    <div className="api-offline" role="alert">
      <CircleAlert size={18} />
      <div>
        <strong>
          A API deste sistema não está respondendo neste endereço.
        </strong>
        <p>
          {reason} Criar conta, entrar e agendar dependem do servidor Node.js
          com PostgreSQL — publicar apenas a pasta <code>dist/</code> em um
          serviço estático (Netlify, Vercel sem funções, GitHub Pages) serve as
          telas, mas não processa nada.
        </p>
        <p className="api-offline-hint">
          Caminho mais rápido: publique com o blueprint <code>render.yaml</code>{" "}
          incluído no pacote. Guia completo em <code>DEPLOY.md</code>.
        </p>
      </div>
    </div>
  );
}

export default function App() {
  const [auth, setAuth] = useState(undefined),
    [toast, setToast] = useState(null),
    [authError, setAuthError] = useState(null),
    [apiStatus, setApiStatus] = useState(null);
  const notify = useCallback(
    (message, type = "success") => setToast({ message, type, id: Date.now() }),
    [],
  );
  const refreshAuth = useCallback(async () => {
    try {
      const d = await api("/me");
      setCsrf(d.csrf);
      setAuth(d);
      return d;
    } catch (e) {
      setCsrf("");
      setAuth(null);
      if (e.status !== 401) setAuthError(e);
      return null;
    }
  }, []);
  useEffect(() => {
    refreshAuth();
  }, [refreshAuth]);
  useEffect(() => {
    let live = true;
    apiProbe().then((result) => {
      if (live && !result.ok)
        setApiStatus(result.reason || API_OFFLINE_MESSAGE);
    });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  const value = { auth, setAuth, refreshAuth };
  return (
    <AuthContext.Provider value={value}>
      <ToastContext.Provider value={notify}>
        {(apiStatus || authError?.code === "API_UNAVAILABLE") && (
          <ApiOfflineBanner reason={apiStatus || authError.message} />
        )}
        <Routes>
          <Route path="/entrar" element={<Login />} />
          <Route path="/criar-conta" element={<Login register />} />
          <Route path="/agendar/:slug" element={<PublicBooking />} />
          <Route path="/acompanhar" element={<ClientLookup />} />
          <Route path="/convite" element={<AcceptInvite />} />
          <Route path="/privacidade" element={<Privacy />} />
          <Route
            path="/*"
            element={
              auth === undefined ? (
                <Loading />
              ) : auth ? (
                <Workspace />
              ) : (
                <Navigate to="/entrar" replace />
              )
            }
          />
        </Routes>
        {toast && (
          <div className={`toast toast-${toast.type}`} role="status">
            <CheckCircle2 size={19} />
            {toast.message}
            <button onClick={() => setToast(null)} aria-label="Fechar aviso">
              <X size={16} />
            </button>
          </div>
        )}
      </ToastContext.Provider>
    </AuthContext.Provider>
  );
}
function Login({ register = false }) {
  const config = useResource("/config");
  const { auth, refreshAuth } = useAuth(),
    navigate = useNavigate();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null),
    [show, setShow] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    try {
      await api(register ? "/auth/register" : "/auth/login", {
        method: "POST",
        body: register
          ? {
              workspace: f.get("workspace"),
              name: f.get("name"),
              email: f.get("email"),
              password: f.get("password"),
              privacy: true,
            }
          : { email: f.get("email"), password: f.get("password") },
      });
      await refreshAuth();
      navigate("/");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function demo(persona) {
    setBusy(true);
    setError(null);
    try {
      await api("/auth/demo", { method: "POST", body: { persona } });
      await refreshAuth();
      navigate("/");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  if (auth) return <Navigate to="/" replace />;
  return (
    <div className="auth-page">
      <aside className="auth-story">
        <Brand light />
        <div className="auth-story-content">
          <span className="eyebrow">MENOS GESTÃO. MAIS PRESENÇA.</span>
          <h1>
            Seu tempo merece
            <br />
            uma agenda
            <br />
            <em>à altura.</em>
          </h1>
          <p>
            Organize seus atendimentos, confirme pelo WhatsApp e esteja presente
            no que realmente importa.
          </p>
          <div className="auth-illustration">
            <div className="illustration-card">
              <span className="mini-icon">
                <CalendarCheck2 size={24} />
              </span>
              <div>
                <strong>Tudo no seu tempo</strong>
                <span>Agenda organizada. Mente tranquila.</span>
              </div>
              <CheckCircle2 size={22} />
            </div>
            <div className="illustration-message">
              <MessageCircle size={20} />
              <span>Seu próximo atendimento já está confirmado.</span>
              <span className="message-time">
                09:41 <CheckCheck size={14} />
              </span>
            </div>
          </div>
        </div>
        <div className="auth-footer">
          <ShieldCheck size={17} /> Dados separados por clínica. Cuidado em cada
          detalhe.
        </div>
      </aside>
      <main className="auth-main">
        <div className="auth-form-wrap">
          <Brand />
          <span className="eyebrow">
            {register ? "COMECE UMA NOVA ROTINA" : "BEM-VINDO DE VOLTA"}
          </span>
          <h2>
            {register
              ? "Um novo espaço para cuidar."
              : "Sua agenda sente sua falta."}
          </h2>
          <p className="muted">
            {register
              ? "Crie o espaço da sua clínica em poucos passos."
              : "Entre para acompanhar seus próximos atendimentos."}
          </p>
          <ErrorBox error={error} />
          <form onSubmit={submit} className="stack-form">
            {register && (
              <>
                <label>
                  Nome da clínica
                  <input
                    name="workspace"
                    required
                    minLength={2}
                    maxLength={100}
                    placeholder="Como sua clínica se chama?"
                    autoComplete="organization"
                  />
                </label>
                <label>
                  Seu nome
                  <input
                    name="name"
                    required
                    minLength={2}
                    maxLength={100}
                    placeholder="Nome profissional"
                    autoComplete="name"
                  />
                </label>
              </>
            )}
            <label>
              E-mail
              <div className="input-icon">
                <Mail size={17} />
                <input
                  name="email"
                  type="email"
                  required
                  placeholder="voce@suaclinica.com.br"
                  autoComplete="email"
                />
              </div>
            </label>
            <label>
              Senha
              <div className="input-icon">
                <LockKeyhole size={17} />
                <input
                  name="password"
                  type={show ? "text" : "password"}
                  required
                  minLength={register ? 12 : 1}
                  maxLength={128}
                  placeholder={
                    register ? "Pelo menos 12 caracteres" : "Sua senha"
                  }
                  autoComplete={register ? "new-password" : "current-password"}
                />
                <button
                  type="button"
                  onClick={() => setShow(!show)}
                  aria-label={show ? "Ocultar senha" : "Mostrar senha"}
                >
                  {show ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </label>
            {register && (
              <label className="check-label">
                <input type="checkbox" required />
                <span>
                  Li e aceito a{" "}
                  <Link to="/privacidade">política de privacidade</Link>.
                </span>
              </label>
            )}
            <button className="btn btn-primary btn-full" disabled={busy}>
              {busy ? (
                <LoaderCircle className="spin" size={18} />
              ) : (
                <>
                  {register ? "Criar meu espaço" : "Entrar na minha agenda"}
                  <ArrowRight size={18} />
                </>
              )}
            </button>
          </form>
          <p className="auth-switch">
            {register ? "Já tem uma conta?" : "Ainda não tem uma conta?"}{" "}
            <Link to={register ? "/entrar" : "/criar-conta"}>
              {register ? "Entrar" : "Criar conta"}
            </Link>
          </p>
          {config.data?.demo && (
            <div className="demo-box">
              <span className="demo-tag">
                <Sparkles size={14} /> AMBIENTE DE DEMONSTRAÇÃO
              </span>
              <p>
                Explore com dados fictícios. Nenhuma mensagem real será enviada.
              </p>
              <button
                className="btn btn-demo"
                onClick={() => demo("owner")}
                disabled={busy}
              >
                Explorar como administrador
                <ArrowUpRight size={17} />
              </button>
              <div className="demo-links">
                <button onClick={() => demo("professional")} disabled={busy}>
                  Entrar como profissional
                </button>
                <button onClick={() => demo("other")} disabled={busy}>
                  Outra clínica
                </button>
              </div>
            </div>
          )}
        </div>
        <p className="auth-bottom">
          Feito para quem cuida de pessoas. <Flower2 size={15} />
        </p>
      </main>
    </div>
  );
}

function Workspace() {
  const { auth, refreshAuth } = useAuth(),
    navigate = useNavigate(),
    location = useLocation();
  const [mobile, setMobile] = useState(false);
  const { data } = useResource("/appointments?status=pending");
  const pending = data?.appointments?.length || 0;
  useEffect(() => setMobile(false), [location.pathname]);
  async function logout() {
    await api("/auth/logout", { method: "POST", body: {} });
    setCsrf("");
    await refreshAuth();
    navigate("/entrar");
  }
  const nav = [
    ["/", "Visão geral", LayoutDashboard],
    ["/agenda", "Minha agenda", CalendarDays],
    ["/solicitacoes", "Solicitações", Inbox],
    ["/profissionais", "Profissionais", Users],
    ["/servicos", "Serviços", HeartHandshake],
  ];
  return (
    <div className="workspace">
      <aside className={`sidebar ${mobile ? "sidebar-open" : ""}`}>
        <Brand light />
        <button
          className="workspace-switch"
          onClick={() => navigate("/configuracoes")}
        >
          <span className="workspace-avatar">
            {auth.tenant.name.slice(0, 1)}
          </span>
          <span>
            <strong>{auth.tenant.name}</strong>
            <small>
              {auth.role === "owner"
                ? "Espaço administrador"
                : "Espaço profissional"}
            </small>
          </span>
          <ChevronDown size={15} />
        </button>
        <span className="nav-caption">SEU ESPAÇO</span>
        <nav>
          {nav.map(([to, label, Icon]) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                `nav-item ${isActive ? "active" : ""}`
              }
            >
              <Icon size={19} />
              <span>{label}</span>
              {to === "/solicitacoes" && pending > 0 && (
                <b className="nav-count">{pending}</b>
              )}
            </NavLink>
          ))}
        </nav>
        <span className="nav-caption">CONECTE & ORGANIZE</span>
        <nav>
          {auth.role === "owner" && (
            <NavLink
              to="/whatsapp"
              className={({ isActive }) =>
                `nav-item ${isActive ? "active" : ""}`
              }
            >
              <MessageCircle size={19} />
              <span>WhatsApp</span>
              <span className="tiny-dot" />
            </NavLink>
          )}
          <NavLink
            to="/configuracoes"
            className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
          >
            <Settings size={19} />
            <span>Configurações</span>
          </NavLink>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-tip">
            <span className="tip-icon">
              <Sparkles size={20} />
            </span>
            <strong>Mais cuidado, menos tarefas.</strong>
            <p>Sua agenda trabalha por você, do pedido ao lembrete.</p>
            <Link to="/whatsapp">
              Conhecer automações <ArrowUpRight size={14} />
            </Link>
          </div>
          <Link to="/privacidade" className="nav-item">
            <CircleHelp size={18} />
            <span>Privacidade e ajuda</span>
          </Link>
          <div className="profile">
            <span className="avatar">
              {auth.user.name
                .split(" ")
                .map((x) => x[0])
                .slice(0, 2)
                .join("")}
            </span>
            <span>
              <strong>{auth.user.name}</strong>
              <small>
                {auth.role === "owner" ? "Administrador" : "Profissional"}
              </small>
            </span>
            <button
              onClick={logout}
              className="icon-btn"
              aria-label="Sair da conta"
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      {mobile && (
        <div className="sidebar-scrim" onClick={() => setMobile(false)} />
      )}
      <div className="workspace-main">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-btn mobile-menu"
              onClick={() => setMobile(true)}
              aria-label="Abrir menu"
            >
              <Menu size={21} />
            </button>
            <span>Meu espaço</span>
            <ChevronRight size={14} />
            <strong>
              {{
                "/": "Visão geral",
                "/agenda": "Minha agenda",
                "/solicitacoes": "Solicitações",
                "/profissionais": "Profissionais",
                "/servicos": "Serviços",
                "/whatsapp": "WhatsApp",
                "/configuracoes": "Configurações",
              }[location.pathname] || "Agenda"}
            </strong>
          </div>
          <div className="topbar-actions">
            <span className="secure-label">
              <span className="tiny-dot" />
              Seu espaço protegido
            </span>
            <span className="topbar-divider" />
            <Link className="icon-btn" to="/privacidade" aria-label="Ajuda">
              <CircleHelp size={19} />
            </Link>
            <span className="avatar avatar-small">{auth.user.name[0]}</span>
          </div>
        </header>
        {auth.demo && (
          <div className="demo-banner">
            <Sparkles size={14} />
            <span>
              Você está explorando uma demonstração com dados fictícios.
            </span>
            <span className="demo-banner-right">
              WhatsApp em modo seguro <ShieldCheck size={13} />
            </span>
          </div>
        )}
        <main className="page-content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/agenda" element={<AgendaPage />} />
            <Route path="/solicitacoes" element={<RequestsPage />} />
            <Route
              path="/professionals"
              element={<Navigate to="/profissionais" />}
            />
            <Route path="/profissionais" element={<ProfessionalsPage />} />
            <Route path="/servicos" element={<ServicesPage />} />
            <Route path="/whatsapp" element={<WhatsAppPage />} />
            <Route path="/configuracoes" element={<SettingsPage />} />
            <Route
              path="*"
              element={
                <Empty title="Página não encontrada">
                  Use o menu para voltar à sua agenda.
                </Empty>
              }
            />
          </Routes>
        </main>
        <footer className="app-footer">
          <span>Aurora · Mais tempo para o que importa.</span>
          <span>
            <ShieldCheck size={13} /> Isolamento por clínica · Versão local
          </span>
        </footer>
      </div>
    </div>
  );
}
function PageHeading({ eyebrow, title, description, children }) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      <div className="heading-actions">{children}</div>
    </div>
  );
}
function BookingLink({ className = "btn btn-primary" }) {
  const { auth } = useAuth();
  return (
    <Link
      className={className}
      to={`/agendar/${auth.tenant.slug}`}
      target="_blank"
      rel="noopener"
    >
      <Plus size={17} />
      Novo agendamento
      <ArrowUpRight size={15} />
    </Link>
  );
}
function CopyButton({
  value,
  label = "Copiar link",
  className = "btn btn-secondary",
}) {
  const notify = useToast();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      notify("Link copiado. Compartilhe com seus clientes.");
      setTimeout(() => setCopied(false), 2500);
    } catch {
      notify(
        "Não foi possível copiar. Selecione e copie o link exibido.",
        "error",
      );
    }
  }
  return (
    <button className={className} onClick={copy}>
      {copied ? <Check size={16} /> : <Copy size={16} />}
      <span>{copied ? "Copiado!" : label}</span>
    </button>
  );
}

function Dashboard() {
  const { auth } = useAuth();
  const { data, error, reload } = useResource("/overview");
  const [selected, setSelected] = useState(null);
  const [day, setDay] = useState(todayKey());
  const appointments = useResource(`/appointments?date=${day}`);
  const firstName = auth.user.name.split(" ")[0];
  const stats = data?.today;
  return (
    <>
      <PageHeading
        eyebrow=" UM ESPAÇO PARA CUIDAR MELHOR"
        title={`Olá, ${firstName}`}
        description="Sua agenda está pronta. Vamos cuidar do seu dia?"
      >
        <span className="date-chip">
          <CalendarDays size={16} />
          {dateLabel(new Date(), {
            weekday: "short",
            day: "numeric",
            month: "long",
          })}
        </span>
        <BookingLink />
      </PageHeading>
      <ErrorBox error={error} />
      <div className="welcome-banner">
        <div>
          <span className="banner-kicker">
            <span className="tiny-dot" /> SUA ROTINA, EM HARMONIA
          </span>
          <h2>
            Você cuida de pessoas.
            <br />A Aurora cuida da agenda.
          </h2>
          <p>
            Pedidos organizados, horários protegidos e uma comunicação mais
            próxima.
          </p>
          <Link to="/solicitacoes">
            Ver solicitações pendentes <ArrowRight size={16} />
          </Link>
        </div>
        <div className="banner-art" aria-hidden="true">
          <div className="art-orbit orbit-one" />
          <div className="art-orbit orbit-two" />
          <div className="art-calendar">
            <div className="art-calendar-top">
              <span>
                {dateLabel(new Date(), {
                  month: "long",
                  day: undefined,
                }).toUpperCase()}
              </span>
              <Flower2 size={18} />
            </div>
            <strong>{dateLabel(new Date(), { month: undefined })}</strong>
            <span>um dia para cuidar</span>
            <div className="art-calendar-dots">
              <i />
              <i />
              <i />
              <i />
              <i />
            </div>
          </div>
          <div className="art-notification">
            <span>
              <Check size={17} />
            </span>
            <div>
              <strong>Horário confirmado</strong>
              <small>Seu cliente já foi avisado.</small>
            </div>
          </div>
          <div className="art-spark">
            <Sparkles size={27} />
          </div>
        </div>
      </div>
      <div className="stats-grid">
        {[
          [
            CalendarCheck2,
            "Atendimentos hoje",
            stats?.total,
            "Sua agenda do dia",
            "green",
          ],
          [
            "Clock3",
            "Aguardando resposta",
            stats?.pending,
            "Precisam da sua confirmação",
            "amber",
          ],
          [
            "CircleCheck",
            "Confirmados hoje",
            stats?.confirmed,
            "Tudo pronto para receber",
            "purple",
          ],
          [
            "CheckCheck",
            "Concluídos hoje",
            stats?.completed,
            "Mais um ciclo de cuidado",
            "blue",
          ],
        ].map(([Icon, label, value, sub, color]) => (
          <div className="stat-card" key={label}>
            <div className="stat-top">
              <span>{label}</span>
              <span className={`stat-icon ${color}`}>
                <Icon size={19} />
              </span>
            </div>
            <strong className="stat-number">{value ?? "—"}</strong>
            <span className="stat-sub">
              {label === "Aguardando resposta" && value > 0 && (
                <span className="tiny-dot amber-dot" />
              )}
              {sub}
            </span>
          </div>
        ))}
      </div>
      <div className="dashboard-grid">
        <section className="panel schedule-panel">
          <div className="panel-header">
            <div>
              <h2>
                Sua agenda{" "}
                <span className="soft-tag">
                  {appointments.data?.appointments?.filter(
                    (a) => a.status !== "cancelled",
                  ).length || 0}{" "}
                  atendimentos
                </span>
              </h2>
              <p>Um olhar para os próximos encontros.</p>
            </div>
            <Link to="/agenda" className="text-link">
              Agenda completa
              <ArrowUpRight size={15} />
            </Link>
          </div>
          <div className="week-strip">
            <button
              className="icon-btn"
              onClick={() => setDay(addDays(day, -1))}
              aria-label="Dia anterior"
            >
              <ChevronLeft size={17} />
            </button>
            {Array.from({ length: 7 }, (_, i) => addDays(day, i - 3)).map(
              (d) => (
                <button
                  key={d}
                  className={`week-day ${d === day ? "selected" : ""} ${d === todayKey() ? "today" : ""}`}
                  onClick={() => setDay(d)}
                >
                  <span>
                    {dateLabel(d + "T12:00:00", {
                      weekday: "short",
                      day: undefined,
                      month: undefined,
                    }).replace(".", "")}
                  </span>
                  <strong>{Number(d.slice(-2))}</strong>
                  <i />
                </button>
              ),
            )}
            <button
              className="icon-btn"
              onClick={() => setDay(addDays(day, 1))}
              aria-label="Próximo dia"
            >
              <ChevronRight size={17} />
            </button>
          </div>
          <div className="schedule-date">
            <span>
              {dateLabel(day + "T12:00:00", { weekday: "long", month: "long" })}
            </span>
            <button
              onClick={() => setDay(todayKey())}
              className="small-text-button"
            >
              Hoje
            </button>
          </div>
          <div className="timeline">
            {appointments.error ? (
              <ErrorBox error={appointments.error} />
            ) : !appointments.data ? (
              <Loading />
            ) : appointments.data.appointments.filter(
                (a) => a.status !== "cancelled",
              ).length === 0 ? (
              <Empty title="Um respiro na agenda">
                Não há atendimentos neste dia. Compartilhe sua agenda para
                receber novos pedidos.
              </Empty>
            ) : (
              appointments.data.appointments
                .filter((a) => a.status !== "cancelled")
                .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))
                .map((a) => (
                  <button
                    className="timeline-row"
                    key={a.id}
                    onClick={() => setSelected(a)}
                  >
                    <div className="timeline-time">
                      <strong>{timeLabel(a.startsAt)}</strong>
                      <span>{timeLabel(a.endsAt)}</span>
                    </div>
                    <div className="timeline-track">
                      <i style={{ background: a.color || "#217a70" }} />
                    </div>
                    <div className="timeline-info">
                      <strong>{a.clientName}</strong>
                      <span>
                        {a.service} <i>·</i> {a.professional}
                      </span>
                    </div>
                    <Badge status={a.status} />
                    <ChevronRight size={16} />
                  </button>
                ))
            )}
          </div>
        </section>
        <div className="dashboard-right">
          <PendingPreview onSelect={setSelected} />
          <section className="panel automation-card">
            <div className="automation-heading">
              <span className="whatsapp-icon">
                <MessageCircle size={22} />
              </span>
              <span className="soft-tag">AUTOMAÇÃO</span>
            </div>
            <h2>
              Um lembrete faz
              <br />a diferença.
            </h2>
            <p>Confirmações e lembretes no WhatsApp, no tempo certo.</p>
            <div className="automation-steps">
              <span>
                <Check size={14} />
                Ao confirmar
              </span>
              <span>
                <Clock3 size={14} />1 dia antes
              </span>
              <span>
                <Bell size={14} />2 horas antes
              </span>
            </div>
            <Link to="/whatsapp" className="text-link">
              Configurar WhatsApp
              <ArrowRight size={16} />
            </Link>
          </section>
        </div>
      </div>
      <div className="bottom-note">
        <ShieldCheck size={17} />
        <span>
          <strong>Seu horário, protegido.</strong> Solicitações pendentes já
          bloqueiam a agenda até você confirmar ou cancelar.
        </span>
      </div>
      {selected && (
        <AppointmentModal
          appointment={selected}
          onClose={() => setSelected(null)}
          onChanged={() => {
            reload();
            appointments.reload();
          }}
        />
      )}
    </>
  );
}
function PendingPreview({ onSelect }) {
  const { data, reload } = useResource("/appointments?status=pending");
  const items = data?.appointments?.slice(0, 3) || [];
  return (
    <section className="panel pending-preview">
      <div className="panel-header">
        <h2>
          Precisam de você{" "}
          <span className="count-pill">{data?.appointments?.length || 0}</span>
        </h2>
        <span className="amber-icon">
          <Clock3 size={18} />
        </span>
      </div>
      <p className="panel-description">Um retorno seu e tudo fica certo.</p>
      {items.length ? (
        items.map((a) => (
          <button
            key={a.id}
            className="pending-mini"
            onClick={() => onSelect(a)}
          >
            <span className="avatar avatar-soft">
              {a.clientName
                .split(" ")
                .map((x) => x[0])
                .slice(0, 2)
                .join("")}
            </span>
            <span>
              <strong>{a.clientName}</strong>
              <small>
                {dateLabel(a.startsAt)} às {timeLabel(a.startsAt)}
              </small>
            </span>
            <ChevronRight size={16} />
          </button>
        ))
      ) : (
        <Empty icon={CheckCheck} title="Tudo em dia">
          Nenhuma solicitação aguardando resposta.
        </Empty>
      )}
      <Link to="/solicitacoes" className="pending-all">
        Ver todas as solicitações
        <ArrowRight size={15} />
      </Link>
    </section>
  );
}

function AgendaPage() {
  const [day, setDay] = useState(todayKey()),
    [view, setView] = useState("week"),
    [professional, setProfessional] = useState(""),
    [selected, setSelected] = useState(null);
  const start = addDays(
    day,
    -((new Date(day + "T12:00:00Z").getUTCDay() + 6) % 7),
  );
  const end = view === "week" ? addDays(start, 6) : day;
  const { data, error, reload } = useResource(
    `/appointments?from=${view === "week" ? start : day}`,
  );
  const pros = useResource("/professionals");
  const items = (data?.appointments || []).filter(
    (a) =>
      localRange(a, start, end) &&
      (!professional || a.professionalId === professional),
  );
  function localRange(a, from, to) {
    const d = dayKey(a.startsAt);
    return d >= from && d <= to;
  }
  return (
    <>
      <PageHeading
        eyebrow="CADA ENCONTRO IMPORTA"
        title="Minha agenda"
        description="Todos os seus horários, com espaço para o que importa."
      >
        <BookingLink />
      </PageHeading>
      <section className="panel calendar-panel">
        <div className="calendar-toolbar">
          <div className="calendar-navigation">
            <button
              className="icon-btn bordered"
              onClick={() => setDay(addDays(day, view === "week" ? -7 : -1))}
              aria-label="Período anterior"
            >
              <ChevronLeft size={18} />
            </button>
            <button
              className="icon-btn bordered"
              onClick={() => setDay(addDays(day, view === "week" ? 7 : 1))}
              aria-label="Próximo período"
            >
              <ChevronRight size={18} />
            </button>
            <h2>
              {dateLabel(start + "T12:00:00", {
                month: "long",
                year: "numeric",
                day: undefined,
              })}
            </h2>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setDay(todayKey())}
            >
              Hoje
            </button>
          </div>
          <div className="toolbar-filters">
            <select
              aria-label="Filtrar profissional"
              value={professional}
              onChange={(e) => setProfessional(e.target.value)}
            >
              <option value="">Todos os profissionais</option>
              {pros.data?.professionals?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <div className="segmented">
              <button
                className={view === "week" ? "active" : ""}
                onClick={() => setView("week")}
              >
                <Grid2X2 size={15} />
                Semana
              </button>
              <button
                className={view === "day" ? "active" : ""}
                onClick={() => setView("day")}
              >
                <List size={15} />
                Dia
              </button>
            </div>
            <input
              className="date-input"
              aria-label="Escolher data"
              type="date"
              value={day}
              onChange={(e) => e.target.value && setDay(e.target.value)}
            />
          </div>
        </div>
        <ErrorBox error={error} />
        {view === "week" ? (
          <div className="calendar-scroll">
            <div className="calendar-week" style={{ "--days": 7 }}>
              {Array.from({ length: 7 }, (_, i) => addDays(start, i)).map(
                (d) => (
                  <div
                    className={`calendar-column ${d === todayKey() ? "is-today" : ""}`}
                    key={d}
                  >
                    <div className="calendar-day-head">
                      <span>
                        {dateLabel(d + "T12:00:00", {
                          weekday: "short",
                          day: undefined,
                          month: undefined,
                        }).replace(".", "")}
                      </span>
                      <strong>{Number(d.slice(-2))}</strong>
                    </div>
                    <div className="calendar-events">
                      {items
                        .filter(
                          (a) =>
                            dayKey(a.startsAt) === d &&
                            a.status !== "cancelled",
                        )
                        .sort(
                          (a, b) => new Date(a.startsAt) - new Date(b.startsAt),
                        )
                        .map((a) => (
                          <button
                            key={a.id}
                            className={`calendar-event event-${a.status}`}
                            style={{ "--event-color": a.color }}
                            onClick={() => setSelected(a)}
                          >
                            <span>
                              {timeLabel(a.startsAt)} – {timeLabel(a.endsAt)}
                            </span>
                            <strong>{a.clientName}</strong>
                            <small>
                              {a.professional.split(" ")[0]} · {a.service}
                            </small>
                            <span className="event-status">
                              {a.status === "pending"
                                ? "Aguardando resposta"
                                : statusNames[a.status]}
                            </span>
                          </button>
                        ))}
                      {!items.some(
                        (a) =>
                          dayKey(a.startsAt) === d && a.status !== "cancelled",
                      ) && (
                        <span className="calendar-free">Sem atendimentos</span>
                      )}
                    </div>
                  </div>
                ),
              )}
            </div>
          </div>
        ) : (
          <div className="day-list">
            {items.length ? (
              items
                .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))
                .map((a) => (
                  <button
                    className="day-list-row"
                    key={a.id}
                    onClick={() => setSelected(a)}
                  >
                    <strong>{timeLabel(a.startsAt)}</strong>
                    <span
                      className="professional-dot"
                      style={{ background: a.color }}
                    />
                    <div>
                      <strong>{a.clientName}</strong>
                      <span>
                        {a.service} · {a.professional}
                      </span>
                    </div>
                    <Badge status={a.status} />
                    <ChevronRight size={17} />
                  </button>
                ))
            ) : (
              <Empty title="Agenda livre neste dia">
                Que tal compartilhar seu link de agendamento?
              </Empty>
            )}
          </div>
        )}
        <div className="calendar-legend">
          <span>
            <i className="legend-dot amber-dot" />
            Aguardando resposta
          </span>
          <span>
            <i className="legend-dot green-dot" />
            Confirmado
          </span>
          <span>
            <i className="legend-dot gray-dot" />
            Concluído
          </span>
          <span>
            <LockKeyhole size={13} />
            Pedidos pendentes bloqueiam o horário
          </span>
        </div>
      </section>
      {selected && (
        <AppointmentModal
          appointment={selected}
          onClose={() => setSelected(null)}
          onChanged={reload}
        />
      )}
    </>
  );
}

function RequestsPage() {
  const [filter, setFilter] = useState("pending"),
    [search, setSearch] = useState(""),
    [selected, setSelected] = useState(null);
  const { data, error, reload } = useResource("/appointments?status=" + filter);
  const items = (data?.appointments || []).filter((a) =>
    (a.clientName + " " + a.professional)
      .toLocaleLowerCase("pt-BR")
      .includes(search.toLocaleLowerCase("pt-BR")),
  );
  return (
    <>
      <PageHeading
        eyebrow="UMA RESPOSTA ABRE ESPAÇO"
        title="Solicitações"
        description="Confirme ou cancele. O horário fica protegido até a sua resposta."
      >
        <BookingLink />
      </PageHeading>
      <div className="notice notice-info">
        <ShieldCheck size={19} />
        <span>
          <strong>Nenhum conflito, nenhuma dúvida.</strong> O bloqueio acontece
          no banco de dados, inclusive quando duas pessoas tentam o mesmo
          horário.
        </span>
      </div>
      <section className="panel">
        <div className="table-toolbar">
          <div className="tabs">
            {[
              ["pending", "Aguardando"],
              ["confirmed", "Confirmados"],
              ["completed", "Concluídos"],
              ["cancelled", "Cancelados"],
              ["all", "Todos"],
            ].map(([v, l]) => (
              <button
                key={v}
                className={filter === v ? "active" : ""}
                onClick={() => setFilter(v)}
              >
                {l}
              </button>
            ))}
          </div>
          <div className="search-input">
            <Search size={16} />
            <input
              aria-label="Buscar cliente"
              placeholder="Buscar cliente…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        <ErrorBox error={error} />
        {!data ? (
          <Loading />
        ) : items.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>Data e horário</th>
                  <th>Profissional</th>
                  <th>Situação</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items
                  .sort((a, b) =>
                    filter === "pending"
                      ? new Date(a.startsAt) - new Date(b.startsAt)
                      : new Date(b.startsAt) - new Date(a.startsAt),
                  )
                  .map((a) => (
                    <tr key={a.id}>
                      <td>
                        <div className="table-person">
                          <span className="avatar avatar-soft">
                            {a.clientName
                              .split(" ")
                              .map((x) => x[0])
                              .slice(0, 2)
                              .join("")}
                          </span>
                          <span>
                            <strong>{a.clientName}</strong>
                            <small>{a.service}</small>
                          </span>
                        </div>
                      </td>
                      <td>
                        <strong>
                          {dateLabel(a.startsAt, {
                            month: "short",
                            year: "numeric",
                          })}
                        </strong>
                        <small>
                          {timeLabel(a.startsAt)} – {timeLabel(a.endsAt)}
                        </small>
                      </td>
                      <td>{a.professional}</td>
                      <td>
                        <Badge status={a.status} />
                      </td>
                      <td>
                        <button
                          className={`btn btn-sm ${a.status === "pending" ? "btn-primary" : "btn-secondary"}`}
                          onClick={() => setSelected(a)}
                        >
                          {a.status === "pending" ? "Responder" : "Detalhes"}
                          <ChevronRight size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            icon={Inbox}
            title={search ? "Nenhum resultado" : "Nenhuma solicitação por aqui"}
          >
            {search
              ? "Tente buscar por outro nome."
              : "Novos pedidos aparecerão aqui assim que um cliente escolher um horário."}
          </Empty>
        )}
      </section>
      {selected && (
        <AppointmentModal
          appointment={selected}
          onClose={() => setSelected(null)}
          onChanged={reload}
        />
      )}
    </>
  );
}

function AppointmentModal({ appointment: a, onClose, onChanged }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null),
    [cancel, setCancel] = useState(false),
    [reason, setReason] = useState("");
  const notify = useToast();
  async function action(action) {
    setBusy(true);
    setError(null);
    try {
      await api(`/appointments/${a.id}/decision`, {
        method: "POST",
        body: { action, reason },
      });
      notify(
        {
          confirm:
            "Horário confirmado. As mensagens autorizadas entraram na fila.",
          cancel:
            "Agendamento cancelado. O horário foi liberado e os lembretes pendentes foram retirados.",
          complete: "Atendimento concluído. Obrigado por cuidar!",
        }[action],
      );
      onChanged();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Detalhes do agendamento"
      subtitle="Cada atendimento, com a atenção que merece."
      onClose={onClose}
    >
      <div className="appointment-person">
        <span className="avatar avatar-large">
          {a.clientName
            .split(" ")
            .map((x) => x[0])
            .slice(0, 2)
            .join("")}
        </span>
        <div>
          <h3>{a.clientName}</h3>
          <span>{a.phoneMasked || a.phone}</span>
        </div>
        <Badge status={a.status} />
      </div>
      <div className="appointment-details">
        <div>
          <CalendarDays size={18} />
          <span>
            <small>Data</small>
            <strong>
              {dateLabel(a.startsAt, {
                weekday: "long",
                month: "long",
                year: "numeric",
              })}
            </strong>
          </span>
        </div>
        <div>
          <Clock3 size={18} />
          <span>
            <small>Horário · São Paulo</small>
            <strong>
              {timeLabel(a.startsAt)} às {timeLabel(a.endsAt)}
            </strong>
          </span>
        </div>
        <div>
          <Stethoscope size={18} />
          <span>
            <small>Profissional</small>
            <strong>{a.professional}</strong>
          </span>
        </div>
        <div>
          <HeartHandshake size={18} />
          <span>
            <small>Serviço</small>
            <strong>{a.service}</strong>
          </span>
        </div>
      </div>
      {a.notes && (
        <div className="notes-box">
          <small>Observações do cliente</small>
          <p>{a.notes}</p>
        </div>
      )}
      <div className="notice notice-soft">
        <MessageCircle size={18} />
        <span>
          {a.whatsappOptIn
            ? "Cliente autorizou mensagens sobre este atendimento."
            : "Cliente não autorizou WhatsApp. Faça contato pelos canais já combinados."}
        </span>
      </div>
      {a.whatsappOptIn && ["pending", "confirmed"].includes(a.status) && (
        <RevokeMessaging
          id={a.id}
          onDone={() => {
            onChanged();
            onClose();
          }}
        />
      )}
      {a.status === "pending" && (
        <div className="notice notice-warning">
          <LockKeyhole size={17} />
          <span>Este horário está bloqueado aguardando sua resposta.</span>
        </div>
      )}
      {cancel && (
        <div className="cancel-form">
          <label>
            Motivo do cancelamento (opcional)
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={300}
              placeholder="Ajude o cliente a entender a mudança."
            />
          </label>
          <p>
            Ao cancelar, o horário volta a ficar disponível. Mensagens já
            entregues não podem ser recolhidas.
          </p>
        </div>
      )}
      <ErrorBox error={error} />
      <div className="modal-actions">
        {a.status === "pending" ? (
          cancel ? (
            <>
              <button
                className="btn btn-secondary"
                onClick={() => setCancel(false)}
                disabled={busy}
              >
                Voltar
              </button>
              <button
                className="btn btn-danger"
                onClick={() => action("cancel")}
                disabled={busy}
              >
                Confirmar cancelamento
              </button>
            </>
          ) : (
            <>
              <button
                className="btn btn-secondary"
                onClick={() => setCancel(true)}
                disabled={busy}
              >
                <X size={16} />
                Cancelar pedido
              </button>
              <button
                className="btn btn-primary"
                onClick={() => action("confirm")}
                disabled={busy}
              >
                <Check size={17} />
                Confirmar horário
              </button>
            </>
          )
        ) : a.status === "confirmed" ? (
          <>
            <button
              className="btn btn-secondary"
              onClick={() => setCancel(!cancel)}
              disabled={busy}
            >
              Cancelar atendimento
            </button>
            <button
              className="btn btn-primary"
              onClick={() => action(cancel ? "cancel" : "complete")}
              disabled={busy}
            >
              {cancel ? "Confirmar cancelamento" : "Marcar como concluído"}
              <CheckCheck size={17} />
            </button>
          </>
        ) : (
          <button className="btn btn-secondary" onClick={onClose}>
            Fechar detalhes
          </button>
        )}
      </div>
    </Modal>
  );
}

function RevokeMessaging({ id, onDone }) {
  const [busy, setBusy] = useState(false),
    notify = useToast();
  return (
    <button
      className="text-link revoke-button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api(`/appointments/${id}/messaging-consent`, {
            method: "POST",
            body: { optIn: false },
          });
          notify(
            "Autorização registrada como revogada. Mensagens pendentes retiradas da fila.",
          );
          onDone();
        } catch (e) {
          notify(e.message, "error");
        } finally {
          setBusy(false);
        }
      }}
    >
      <Ban size={14} />
      Registrar pedido para não receber mensagens
    </button>
  );
}
function AcceptInvite() {
  const { refreshAuth } = useAuth(),
    navigate = useNavigate();
  const hash = window.location.hash.slice(1);
  const [invite, setInvite] = useState(null),
    [error, setError] = useState(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (hash)
      api("/invitations/inspect", {
        method: "POST",
        body: { accessToken: hash },
      })
        .then((d) => setInvite(d.invite))
        .catch(setError);
  }, [hash]);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    try {
      await api("/invitations/accept", {
        method: "POST",
        body: {
          accessToken: hash,
          email: f.get("email"),
          password: f.get("password"),
          privacy: true,
        },
      });
      await refreshAuth();
      navigate("/");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="public-page">
      <header className="public-header">
        <Brand />
        <span>
          <ShieldCheck size={16} />
          Convite individual
        </span>
      </header>
      <main className="lookup-wrap">
        <span className="eyebrow">UM NOVO ESPAÇO PARA CUIDAR</span>
        <h1>Você foi convidado.</h1>
        <ErrorBox error={error} />
        {!hash ? (
          <ErrorBox error="Abra o link completo enviado pelo administrador." />
        ) : !invite && !error ? (
          <Loading />
        ) : (
          invite && (
            <section className="panel lookup-card">
              <h2>{invite.name}</h2>
              <p>
                {invite.tenant} · {invite.specialty}
              </p>
              <form className="stack-form invite-form" onSubmit={submit}>
                <label>
                  Seu e-mail
                  <input
                    name="email"
                    type="email"
                    required
                    autoComplete="email"
                  />
                </label>
                <label>
                  Crie uma senha
                  <input
                    name="password"
                    type="password"
                    required
                    minLength={12}
                    maxLength={128}
                    autoComplete="new-password"
                  />
                  <small>
                    Use pelo menos 12 caracteres, de preferência uma frase longa
                    e única.
                  </small>
                </label>
                <label className="check-label">
                  <input type="checkbox" required />
                  <span>
                    Li e aceito o{" "}
                    <Link to="/privacidade">aviso de privacidade</Link>.
                  </span>
                </label>
                <button className="btn btn-primary" disabled={busy}>
                  Criar meu acesso
                  <ArrowRight size={17} />
                </button>
              </form>
            </section>
          )
        )}
      </main>
    </div>
  );
}

function ProfessionalsPage() {
  const { auth } = useAuth();
  const { data, error, reload } = useResource("/professionals");
  const [adding, setAdding] = useState(false),
    [editing, setEditing] = useState(null),
    [blocking, setBlocking] = useState(null),
    [inviting, setInviting] = useState(null),
    [inviteLink, setInviteLink] = useState(null);
  return (
    <>
      <PageHeading
        eyebrow="CUIDADO QUE SE COMPARTILHA"
        title="Profissionais"
        description="Uma agenda para cada pessoa. Um só espaço para sua clínica."
      >
        {auth.role === "owner" && (
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            <Plus size={17} />
            Adicionar profissional
          </button>
        )}
      </PageHeading>
      <ErrorBox error={error} />
      <div className="professionals-grid">
        {data?.professionals?.map((p) => (
          <section className="panel professional-card" key={p.id}>
            <div className="professional-top">
              <span
                className="avatar avatar-large"
                style={{ background: p.color + "20", color: p.color }}
              >
                {p.name
                  .split(" ")
                  .map((x) => x[0])
                  .slice(0, 2)
                  .join("")}
              </span>
              <span
                className={`badge ${p.active ? "badge-confirmed" : "badge-cancelled"}`}
              >
                <span className="status-dot" />
                {p.active ? "Recebendo pedidos" : "Agenda pausada"}
              </span>
            </div>
            <h2>{p.name}</h2>
            <p>{p.specialty}</p>
            <div className="professional-meta">
              <CalendarDays size={16} />
              Agenda individual
              <ShieldCheck size={16} />
              Dados protegidos
            </div>
            {auth.role === "owner" && (
              <div className="professional-actions">
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setEditing(p)}
                >
                  <Clock3 size={15} />
                  Horários
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setBlocking(p)}
                >
                  <Ban size={15} />
                  Bloquear dia
                </button>
                {!p.user_id && (
                  <button className="text-link" onClick={() => setInviting(p)}>
                    <Mail size={14} />
                    Convidar acesso
                  </button>
                )}
                <button className="text-link" onClick={() => setAdding(p)}>
                  {p.active ? "Pausar" : "Ativar"}
                </button>
              </div>
            )}
          </section>
        ))}
      </div>
      {adding && typeof adding === "object" && (
        <SimpleModal
          title={adding.active ? "Pausar agenda?" : "Ativar agenda?"}
          text={`${adding.active ? "Novos pedidos serão suspensos" : "Novos pedidos serão permitidos"} para ${adding.name}. Agendamentos existentes continuam registrados.`}
          onClose={() => setAdding(null)}
          onSubmit={async () => {
            await api(`/professionals/${adding.id}`, {
              method: "PATCH",
              body: { active: !adding.active },
            });
            reload();
          }}
        />
      )}
      {adding === true && (
        <ProfessionalForm onClose={() => setAdding(false)} onSaved={reload} />
      )}{" "}
      {editing && (
        <HoursModal professional={editing} onClose={() => setEditing(null)} />
      )}{" "}
      {blocking && (
        <BlockDayModal
          professional={blocking}
          onClose={() => setBlocking(null)}
        />
      )}{" "}
      {inviting && (
        <SimpleModal
          title="Convidar profissional"
          text={`Criar um convite individual e sigiloso para ${inviting.name}? Ele poderá acessar apenas os próprios agendamentos. O link vale por 48 horas.`}
          onClose={() => setInviting(null)}
          onSubmit={async () => {
            const r = await api(`/professionals/${inviting.id}/invitation`, {
              method: "POST",
              body: {},
            });
            setInviteLink(window.location.origin + "/convite#" + r.accessToken);
          }}
        />
      )}
      {inviteLink && (
        <Modal
          title="Convite pronto para compartilhar"
          subtitle="Envie somente ao profissional convidado. O link não aparece novamente depois de fechar."
          onClose={() => setInviteLink(null)}
        >
          <div className="notice notice-warning">
            <LockKeyhole size={18} />
            <span>
              Qualquer pessoa com este link poderá criar o acesso deste
              profissional. Ele expira em 48 horas.
            </span>
          </div>
          <div className="share-link">{inviteLink}</div>
          <CopyButton value={inviteLink} label="Copiar convite individual" />
        </Modal>
      )}
    </>
  );
}
function SimpleModal({ title, text, onClose, onSubmit }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  return (
    <Modal title={title} onClose={onClose}>
      <p className="modal-text">{text}</p>
      <ErrorBox error={error} />
      <div className="modal-actions">
        <button className="btn btn-secondary" onClick={onClose}>
          Voltar
        </button>
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onSubmit();
              onClose();
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          Confirmar
          <Check size={16} />
        </button>
      </div>
    </Modal>
  );
}
function ProfessionalForm({ onClose, onSaved }) {
  const [error, setError] = useState(null),
    [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    const f = new FormData(e.currentTarget);
    try {
      await api("/professionals", {
        method: "POST",
        body: {
          name: f.get("name"),
          specialty: f.get("specialty"),
          color: f.get("color"),
        },
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Um novo profissional"
      subtitle="Ele terá uma agenda própria, com horários independentes."
      onClose={onClose}
    >
      <form className="stack-form" onSubmit={submit}>
        <label>
          Nome completo
          <input name="name" required minLength={2} maxLength={100} />
        </label>
        <label>
          Especialidade
          <input
            name="specialty"
            required
            minLength={2}
            maxLength={100}
            placeholder="Ex.: Psicologia"
          />
        </label>
        <label>
          Cor na agenda
          <input name="color" type="color" defaultValue="#217a70" />
        </label>
        <p className="field-hint">
          A agenda começa com atendimento de segunda a sexta, das 09h às 12h e
          das 14h às 18h. Você pode ajustar depois.
        </p>
        <ErrorBox error={error} />
        <button className="btn btn-primary" disabled={busy}>
          Adicionar profissional
          <Plus size={17} />
        </button>
      </form>
    </Modal>
  );
}
function HoursModal({ professional: p, onClose }) {
  const { data, error: loadError } = useResource(
    `/professionals/${p.id}/hours`,
  );
  const [hours, setHours] = useState(null),
    [error, setError] = useState(null),
    [busy, setBusy] = useState(false);
  const notify = useToast();
  useEffect(() => {
    if (data) setHours(data.hours);
  }, [data]);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(`/professionals/${p.id}/hours`, { method: "PUT", body: hours });
      notify(
        "Disponibilidade atualizada. Agendamentos existentes foram preservados.",
      );
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Horários de ${p.name.split(" ")[0]}`}
      subtitle="Defina as faixas de atendimento. Os intervalos são configurados em cada serviço."
      onClose={onClose}
      wide
    >
      <ErrorBox error={loadError || error} />
      {hours === null ? (
        <Loading />
      ) : (
        <>
          <div className="hours-list">
            {[
              "Domingo",
              "Segunda-feira",
              "Terça-feira",
              "Quarta-feira",
              "Quinta-feira",
              "Sexta-feira",
              "Sábado",
            ].map((name, d) => {
              const rows = hours
                .map((h, i) => ({ ...h, index: i }))
                .filter((h) => h.weekday === d);
              return (
                <div className="hours-day" key={d}>
                  <strong>{name}</strong>
                  <div>
                    {rows.length ? (
                      rows.map((h) => (
                        <div className="hours-range" key={h.index}>
                          <input
                            type="time"
                            aria-label={`Início ${name}`}
                            value={h.start}
                            onChange={(e) =>
                              setHours(
                                hours.map((x, i) =>
                                  i === h.index
                                    ? { ...x, start: e.target.value }
                                    : x,
                                ),
                              )
                            }
                          />
                          <span>às</span>
                          <input
                            type="time"
                            aria-label={`Fim ${name}`}
                            value={h.end}
                            onChange={(e) =>
                              setHours(
                                hours.map((x, i) =>
                                  i === h.index
                                    ? { ...x, end: e.target.value }
                                    : x,
                                ),
                              )
                            }
                          />
                          <button
                            className="icon-btn"
                            onClick={() =>
                              setHours(hours.filter((_, i) => i !== h.index))
                            }
                            aria-label={`Remover faixa ${name}`}
                          >
                            <X size={15} />
                          </button>
                        </div>
                      ))
                    ) : (
                      <span className="muted">Sem atendimento</span>
                    )}
                    <button
                      className="text-link"
                      onClick={() =>
                        setHours([
                          ...hours,
                          { weekday: d, start: "09:00", end: "12:00" },
                        ])
                      }
                    >
                      <Plus size={14} />
                      Adicionar faixa
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={onClose}>
              Cancelar
            </button>
            <button className="btn btn-primary" onClick={save} disabled={busy}>
              Salvar disponibilidade
              <Check size={16} />
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
function BlockDayModal({ professional: p, onClose }) {
  const [error, setError] = useState(null),
    [busy, setBusy] = useState(false);
  const notify = useToast();
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    const f = new FormData(e.currentTarget);
    try {
      await api("/time-off", {
        method: "POST",
        body: {
          professionalId: p.id,
          date: f.get("date"),
          reason: f.get("reason"),
        },
      });
      notify("Dia bloqueado. Nenhum horário será oferecido nesta data.");
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Bloquear um dia"
      subtitle={`Pausar a agenda de ${p.name} em uma data específica.`}
      onClose={onClose}
    >
      <form className="stack-form" onSubmit={submit}>
        <label>
          Data
          <input type="date" name="date" min={todayKey()} required />
        </label>
        <label>
          Motivo
          <input
            name="reason"
            required
            minLength={2}
            maxLength={100}
            placeholder="Ex.: feriado, compromisso pessoal"
          />
        </label>
        <ErrorBox error={error} />
        <button className="btn btn-primary" disabled={busy}>
          Bloquear dia
          <Ban size={16} />
        </button>
      </form>
    </Modal>
  );
}

function ServicesPage() {
  const { auth } = useAuth(),
    { data, error, reload } = useResource("/services");
  const [adding, setAdding] = useState(false),
    [busy, setBusy] = useState(false),
    [formError, setFormError] = useState(null);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    const f = new FormData(e.currentTarget);
    try {
      await api("/services", {
        method: "POST",
        body: {
          name: f.get("name"),
          duration: Number(f.get("duration")),
          buffer: Number(f.get("buffer")),
          price: Number(f.get("price")),
        },
      });
      reload();
      setAdding(false);
    } catch (e) {
      setFormError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="TEMPO CERTO PARA CADA ATENDIMENTO"
        title="Serviços"
        description="Duração, intervalo e valor. Sua agenda se adapta ao seu jeito de cuidar."
      >
        {auth.role === "owner" && (
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            <Plus size={17} />
            Novo serviço
          </button>
        )}
      </PageHeading>
      <ErrorBox error={error} />
      <div className="services-grid">
        {data?.services?.map((s) => (
          <section className="panel service-card" key={s.id}>
            <span className="service-icon">
              <HeartHandshake size={25} />
            </span>
            <h2>{s.name}</h2>
            <strong className="service-price">
              {s.price_cents ? money(s.price_cents) : "Sob consulta"}
            </strong>
            <div className="service-details">
              <span>
                <Clock3 size={16} />
                {s.duration_minutes} minutos
              </span>
              <span>
                <RefreshCw size={16} />
                {s.buffer_minutes} min de intervalo
              </span>
            </div>
            <div className="service-footer">
              <ShieldCheck size={15} />O intervalo também bloqueia a agenda
            </div>
          </section>
        ))}
      </div>
      {adding && (
        <Modal
          title="Novo serviço"
          subtitle="O intervalo é reservado junto com o atendimento, evitando encontros apertados."
          onClose={() => setAdding(false)}
        >
          <form className="stack-form" onSubmit={submit}>
            <label>
              Nome do serviço
              <input
                name="name"
                required
                minLength={2}
                maxLength={100}
                placeholder="Ex.: Consulta de acompanhamento"
              />
            </label>
            <div className="form-grid">
              <label>
                Duração (minutos)
                <input
                  name="duration"
                  type="number"
                  min={15}
                  max={240}
                  defaultValue={50}
                  required
                />
              </label>
              <label>
                Intervalo (minutos)
                <input
                  name="buffer"
                  type="number"
                  min={0}
                  max={120}
                  defaultValue={10}
                  required
                />
              </label>
            </div>
            <label>
              Valor (R$)
              <input
                name="price"
                type="number"
                min={0}
                max={100000}
                step="0.01"
                defaultValue={0}
                required
              />
            </label>
            <ErrorBox error={formError} />
            <button className="btn btn-primary" disabled={busy}>
              Criar serviço
              <Plus size={17} />
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}

function WhatsAppPage() {
  const { auth } = useAuth();
  const config = useResource("/whatsapp"),
    messages = useResource("/outbox");
  const [tab, setTab] = useState("connection");
  if (auth.role !== "owner")
    return (
      <>
        <PageHeading
          eyebrow="COMUNICAÇÃO DO SEU ATENDIMENTO"
          title="Meus lembretes"
          description="Acompanhe as mensagens dos seus agendamentos. A conexão é gerenciada pela clínica."
        />
        <MessagingQueue resource={messages} />
      </>
    );
  return (
    <>
      <PageHeading
        eyebrow="PERTO, NO MOMENTO CERTO"
        title="WhatsApp & automações"
        description="Uma comunicação cuidadosa, do primeiro confirme até a hora do encontro."
      >
        <span className="badge badge-confirmed">
          <ShieldCheck size={14} />
          API oficial da Meta
        </span>
      </PageHeading>
      <div className="notice notice-info">
        <ShieldCheck size={20} />
        <span>
          <strong>
            {config.data?.mode === "live"
              ? "Envio real habilitado no servidor."
              : "Modo seguro: nenhum envio real."}
          </strong>{" "}
          {config.data?.mode === "live"
            ? "Mensagens saem somente para contas conectadas e clientes com autorização."
            : "A fila e os horários estão funcionando. A conexão com a Meta é necessária para entregar mensagens."}
        </span>
      </div>
      <div className="page-tabs tabs">
        <button
          className={tab === "connection" ? "active" : ""}
          onClick={() => setTab("connection")}
        >
          <SlidersHorizontal size={16} />
          Conexão e modelos
        </button>
        <button
          className={tab === "queue" ? "active" : ""}
          onClick={() => setTab("queue")}
        >
          <Send size={16} />
          Fila de mensagens
        </button>
      </div>
      {tab === "connection" ? (
        <div className="whatsapp-grid">
          <section className="panel form-panel">
            <div className="panel-header">
              <h2>Conectar sua conta</h2>
              <MessageCircle size={21} />
            </div>
            <ErrorBox error={config.error} />
            {config.data ? (
              <WhatsAppForm
                data={config.data}
                onSaved={() => {
                  config.reload();
                  messages.reload();
                }}
              />
            ) : (
              <Loading />
            )}
          </section>
          <div className="stack-panels">
            <section className="panel journey-panel">
              <span className="eyebrow">UMA JORNADA SEM ESQUECIMENTOS</span>
              <h2>
                O cuidado continua
                <br />
                depois do agendamento.
              </h2>
              <div className="journey-step">
                <span>
                  <Check size={18} />
                </span>
                <div>
                  <strong>Assim que você confirmar</strong>
                  <p>
                    O cliente recebe a confirmação do horário pelo WhatsApp.
                  </p>
                </div>
              </div>
              <div className="journey-step">
                <span>
                  <CalendarDays size={18} />
                </span>
                <div>
                  <strong>1 dia antes</strong>
                  <p>Um lembrete para se organizar com tranquilidade.</p>
                </div>
              </div>
              <div className="journey-step">
                <span>
                  <Bell size={18} />
                </span>
                <div>
                  <strong>2 horas antes</strong>
                  <p>Um último lembrete, pertinho do atendimento.</p>
                </div>
              </div>
              <div className="notice notice-soft">
                <LockKeyhole size={17} />
                <span>
                  Somente dados necessários. Sem motivo clínico nas mensagens.
                </span>
              </div>
            </section>
            <section className="panel template-help">
              <h3>Antes de conectar</h3>
              <ul>
                <li>Conta no Meta Business e número aprovado para a API.</li>
                <li>Token permanente com permissão de envio.</li>
                <li>
                  Modelos de utility aprovados, na ordem correta das variáveis.
                </li>
                <li>Autorização do cliente para receber mensagens.</li>
              </ul>
              <p>
                Consulte o guia <strong>WHATSAPP.md</strong> incluído no projeto
                para configurar modelos e webhook.
              </p>
            </section>
          </div>
        </div>
      ) : (
        <MessagingQueue resource={messages} />
      )}
    </>
  );
}
function MessagingQueue({ resource: messages }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>Fila de mensagens</h2>
          <p>
            Persistente, com proteção contra agendamentos duplicados na fila.
          </p>
        </div>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => messages.reload()}
        >
          <RefreshCw size={15} />
          Atualizar
        </button>
      </div>
      <ErrorBox error={messages.error} />
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Mensagem</th>
              <th>Profissional</th>
              <th>Programada para</th>
              <th>Situação</th>
              <th>Tentativas</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {messages.data?.messages?.map((m) => (
              <tr key={m.id}>
                <td>
                  <strong>{kindNames[m.kind]}</strong>
                  <small>{m.error_code || "Sem conteúdo clínico"}</small>
                </td>
                <td>{m.professional}</td>
                <td>
                  {dateLabel(m.scheduled_at)}
                  <small>{timeLabel(m.scheduled_at)}</small>
                </td>
                <td>
                  <Badge status={m.status} />
                </td>
                <td>{m.attempts}</td>
                <td>
                  {m.status === "failed" && (
                    <RetryMessage id={m.id} onDone={messages.reload} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {messages.data?.messages?.length === 0 && (
        <Empty icon={Send} title="As mensagens aparecem aqui">
          Confirme um pedido com autorização de WhatsApp para iniciar a jornada.
        </Empty>
      )}
      <div className="notice notice-soft">
        <CircleAlert size={17} />
        <span>
          “Enviada à Meta” não significa entregue. Entregas não confirmadas não
          são reenviadas automaticamente: confira o painel da Meta antes de
          agir.
        </span>
      </div>
    </section>
  );
}
function WhatsAppForm({ data, onSaved }) {
  const c = data.config;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null),
    [enabled, setEnabled] = useState(c.enabled || false);
  const notify = useToast();
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    try {
      const body = {
        phoneNumberId: f.get("phoneNumberId").trim(),
        confirmationTemplate: f.get("confirmationTemplate").trim(),
        reminderTemplate: f.get("reminderTemplate").trim(),
        cancellationTemplate: f.get("cancellationTemplate").trim(),
        language: f.get("language"),
        enabled,
      };
      if (f.get("accessToken").trim())
        body.accessToken = f.get("accessToken").trim();
      await api("/whatsapp", { method: "PUT", body });
      notify(
        "Configuração salva com segurança. O token não é exibido novamente.",
      );
      onSaved();
      e.target.elements.accessToken.value = "";
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="stack-form" onSubmit={submit}>
      <label>
        ID do número na Meta
        <input
          name="phoneNumberId"
          inputMode="numeric"
          pattern="[0-9]{5,30}"
          defaultValue={c.phone_number_id || ""}
          placeholder="Ex.: 102345678901234"
          required={enabled}
        />
        <small>É o ID do número, não o telefone com DDD.</small>
      </label>
      <label>
        Token de acesso{" "}
        {c.configured && (
          <span className="configured-label">
            <Check size={12} />
            Já configurado
          </span>
        )}
        <input
          name="accessToken"
          type="password"
          autoComplete="new-password"
          minLength={20}
          maxLength={8192}
          placeholder={
            c.configured
              ? "Deixe vazio para manter o token atual"
              : "Cole o token permanente da Meta"
          }
        />
        <small>Criptografado no servidor. Nunca retornado ao navegador.</small>
      </label>
      <div className="form-section-title">Nomes dos modelos aprovados</div>
      <label>
        Confirmação
        <input
          name="confirmationTemplate"
          defaultValue={c.confirmation_template || "confirmacao_agendamento"}
          pattern="[a-z0-9_]{1,512}"
          required
        />
      </label>
      <label>
        Lembrete (1 dia e 2 horas)
        <input
          name="reminderTemplate"
          defaultValue={c.reminder_template || "lembrete_agendamento"}
          pattern="[a-z0-9_]{1,512}"
          required
        />
      </label>
      <label>
        Cancelamento
        <input
          name="cancellationTemplate"
          defaultValue={c.cancellation_template || "cancelamento_agendamento"}
          pattern="[a-z0-9_]{1,512}"
          required
        />
      </label>
      <label>
        Idioma do modelo
        <input
          name="language"
          defaultValue={c.template_language || "pt_BR"}
          pattern="[a-z]{2}_[A-Z]{2}"
          required
        />
      </label>
      <div className="template-variables">
        <strong>Ordem das variáveis nos três modelos</strong>
        <p>
          {data.templates.variables.map((v, i) => (
            <span key={v}>
              <code>{`{{${i + 1}}}`}</code>
              {v}
            </span>
          ))}
        </p>
      </div>
      <label className="check-label">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>
          Autorizo o envio pela conta conectada, somente a clientes que
          consentiram.
        </span>
      </label>
      <ErrorBox error={error} />
      <button className="btn btn-primary" disabled={busy}>
        {busy ? (
          <LoaderCircle size={17} className="spin" />
        ) : (
          <ShieldCheck size={17} />
        )}
        Salvar configuração
      </button>
    </form>
  );
}
function RetryMessage({ id, onDone }) {
  const [busy, setBusy] = useState(false),
    notify = useToast();
  return (
    <button
      className="text-link"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api(`/outbox/${id}/retry`, { method: "POST", body: {} });
          notify("Mensagem recolocada na fila.");
          onDone();
        } catch (e) {
          notify(e.message, "error");
        } finally {
          setBusy(false);
        }
      }}
    >
      Reenviar
    </button>
  );
}

function SettingsPage() {
  const { auth } = useAuth();
  const audit = useResource("/audit");
  const [tab, setTab] = useState("workspace");
  const link = window.location.origin + "/agendar/" + auth.tenant.slug;
  return (
    <>
      <PageHeading
        eyebrow="DO SEU JEITO, COM SEGURANÇA"
        title="Configurações"
        description="Seu espaço de trabalho, seus limites e sua história."
      />
      <div className="page-tabs tabs">
        <button
          className={tab === "workspace" ? "active" : ""}
          onClick={() => setTab("workspace")}
        >
          Espaço de trabalho
        </button>
        {auth.role === "owner" && (
          <button
            className={tab === "audit" ? "active" : ""}
            onClick={() => setTab("audit")}
          >
            Registro de atividades
          </button>
        )}
        <button
          className={tab === "privacy" ? "active" : ""}
          onClick={() => setTab("privacy")}
        >
          Privacidade
        </button>
      </div>
      {tab === "workspace" ? (
        <div className="settings-grid">
          <section className="panel form-panel">
            <h2>{auth.tenant.name}</h2>
            <p className="muted">Informações desta instalação.</p>
            <div className="settings-info">
              <div>
                <span>Seu perfil</span>
                <strong>
                  {auth.role === "owner"
                    ? "Administrador da clínica"
                    : "Profissional"}
                </strong>
              </div>
              <div>
                <span>Fuso horário</span>
                <strong>America/Sao_Paulo</strong>
              </div>
              <div>
                <span>Antecedência mínima</span>
                <strong>1 hora</strong>
              </div>
              <div>
                <span>Janela de agendamento</span>
                <strong>Próximos 60 dias</strong>
              </div>
              <div>
                <span>Sessão de acesso</span>
                <strong>8 horas · cookie protegido</strong>
              </div>
            </div>
          </section>
          <section className="panel form-panel">
            <span className="service-icon">
              <LinkIcon size={23} />
            </span>
            <h2>Uma agenda sempre à mão</h2>
            <p className="muted">
              Compartilhe este link com seus clientes. Não é necessário criar
              uma conta para solicitar um horário.
            </p>
            <div className="share-link">{link}</div>
            <div className="button-row">
              <CopyButton value={link} />
              <Link
                to={`/agendar/${auth.tenant.slug}`}
                target="_blank"
                className="btn btn-primary"
              >
                Abrir agenda
                <ExternalLink size={15} />
              </Link>
            </div>
            <div className="notice notice-soft">
              <Eye size={17} />
              <span>
                O link público mostra apenas profissionais, serviços e horários
                livres. Nunca mostra dados de outros clientes.
              </span>
            </div>
          </section>
        </div>
      ) : tab === "audit" ? (
        <section className="panel">
          <div className="panel-header">
            <h2>Registro de atividades</h2>
            <ShieldCheck size={20} />
          </div>
          <ErrorBox error={audit.error} />
          <div className="audit-list">
            {audit.data?.events?.map((e) => (
              <div key={e.id}>
                <span className="audit-icon">
                  <Activity size={16} />
                </span>
                <span>
                  <strong>
                    {{
                      "appointment.requested": "Novo pedido de agendamento",
                      "appointment.confirm": "Agendamento confirmado",
                      "appointment.cancel": "Agendamento cancelado",
                      "appointment.complete": "Atendimento concluído",
                      "professional.created": "Profissional adicionado",
                      "professional.updated": "Profissional atualizado",
                      "availability.updated": "Disponibilidade atualizada",
                      "time_off.created": "Dia bloqueado",
                      "service.created": "Serviço criado",
                      "whatsapp.configured":
                        "Configuração de WhatsApp alterada",
                      "whatsapp.retried": "Mensagem recolocada na fila",
                      "workspace.created": "Espaço de trabalho criado",
                    }[e.action] || e.action}
                  </strong>
                  <small>
                    {e.actor_type === "client"
                      ? "Cliente"
                      : e.actor_type === "user"
                        ? "Usuário autenticado"
                        : "Sistema"}{" "}
                    · referência {e.entity_id?.slice(0, 8)}
                  </small>
                </span>
                <time>
                  {dateLabel(e.created_at)} {timeLabel(e.created_at)}
                </time>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <section className="panel privacy-panel">
          <ShieldCheck size={35} />
          <h2>Segurança não é um detalhe.</h2>
          <p>
            Dados isolados por clínica no servidor, senhas com hash, sessões
            protegidas, tokens criptografados e acesso do cliente por link
            individual.
          </p>
          <div className="notice notice-warning">
            <CircleAlert size={19} />
            <span>
              Esta é uma edição local funcional, não uma implantação SaaS de
              produção. Antes de usar dados reais, configure backups
              criptografados, infraestrutura segura, retenção, encarregado e
              revisão jurídica/LGPD.
            </span>
          </div>
          <Link to="/privacidade" className="btn btn-secondary">
            Ler aviso de privacidade
            <ArrowUpRight size={16} />
          </Link>
        </section>
      )}
    </>
  );
}

function PublicBooking() {
  const { slug } = useParams();
  const { data, error } = useResource(`/public/${encodeURIComponent(slug)}`);
  const [step, setStep] = useState(1),
    [professional, setProfessional] = useState(""),
    [service, setService] = useState(""),
    [date, setDate] = useState(addDays(todayKey(), 1)),
    [time, setTime] = useState(""),
    [slots, setSlots] = useState(null),
    [slotError, setSlotError] = useState(null),
    [busy, setBusy] = useState(false),
    [bookingError, setBookingError] = useState(null),
    [result, setResult] = useState(null),
    [key] = useState(() => crypto.randomUUID());
  const notify = useToast();
  useEffect(() => {
    if (data && !professional) {
      setProfessional(data.professionals[0]?.id || "");
      setService(data.services[0]?.id || "");
    }
  }, [data]);
  useEffect(() => {
    if (!professional || !service || !date) return;
    let live = true;
    setSlots(null);
    setSlotError(null);
    setTime("");
    api(
      `/public/${encodeURIComponent(slug)}/slots?professional=${professional}&service=${service}&date=${date}`,
    )
      .then((d) => {
        if (live) setSlots(d.slots);
      })
      .catch((e) => {
        if (live) setSlotError(e);
      });
    return () => {
      live = false;
    };
  }, [slug, professional, service, date]);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setBookingError(null);
    const f = new FormData(e.currentTarget);
    try {
      const r = await api(`/public/${encodeURIComponent(slug)}/appointments`, {
        method: "POST",
        body: {
          professionalId: professional,
          serviceId: service,
          date,
          time,
          name: f.get("name"),
          phone: f.get("phone"),
          notes: f.get("notes"),
          consent: true,
          whatsappOptIn: f.get("whatsappOptIn") === "on",
          idempotencyKey: key,
        },
      });
      setResult(r);
      setStep(4);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setBookingError(e);
      if (e.code === "SLOT_UNAVAILABLE") {
        setTime("");
        try {
          const d = await api(
            `/public/${encodeURIComponent(slug)}/slots?professional=${professional}&service=${service}&date=${date}`,
          );
          setSlots(d.slots);
        } catch {}
      }
    } finally {
      setBusy(false);
    }
  }
  const selectedPro = data?.professionals?.find((p) => p.id === professional),
    selectedService = data?.services?.find((s) => s.id === service);
  const minDate = todayKey();
  return (
    <div className="public-page">
      <header className="public-header">
        <Brand />
        <span>
          <LockKeyhole size={15} />
          Agendamento seguro
        </span>
      </header>
      <main className="booking-wrap">
        <div className="booking-intro">
          <span className="eyebrow">SEU PRÓXIMO PASSO COMEÇA AQUI</span>
          <h1>{data?.tenant?.name || "Sua próxima consulta"}</h1>
          <p>Escolha um horário. Cuide de você no seu tempo.</p>
        </div>
        {error ? (
          <ErrorBox error={error} />
        ) : !data ? (
          <Loading />
        ) : step === 4 ? (
          <section className="panel booking-success">
            <span className="success-icon">
              <CheckCircle2 size={40} />
            </span>
            <span className="eyebrow">PEDIDO RECEBIDO COM CUIDADO</span>
            <h2>Seu horário está pré-reservado.</h2>
            <p>
              O profissional vai analisar seu pedido. Ele continua bloqueado até
              a confirmação ou o cancelamento.
            </p>
            <div className="booking-receipt">
              <strong>{result.appointment.clientName}</strong>
              <span>
                {dateLabel(result.appointment.startsAt, {
                  weekday: "long",
                  month: "long",
                })}{" "}
                às {timeLabel(result.appointment.startsAt)}
              </span>
              <span>
                {result.appointment.professional} · {result.appointment.service}
              </span>
              <Badge status="pending" />
            </div>
            {result.accessToken ? (
              <>
                <p className="field-hint">
                  Guarde seu link individual para acompanhar a resposta. Ele dá
                  acesso apenas a este pedido.
                </p>
                <div className="button-row centered">
                  <CopyButton
                    value={`${window.location.origin}/acompanhar#${result.accessToken}`}
                    label="Copiar link do pedido"
                  />
                  <Link
                    className="btn btn-primary"
                    to={`/acompanhar#${result.accessToken}`}
                  >
                    Acompanhar pedido
                    <ArrowRight size={16} />
                  </Link>
                </div>
              </>
            ) : (
              <p>
                Este pedido já havia sido registrado. Use o link individual
                recebido anteriormente.
              </p>
            )}
            <div className="notice notice-soft">
              <MessageCircle size={18} />
              <span>
                A confirmação será enviada pelo WhatsApp se você autorizou as
                mensagens e a clínica conectou o canal.
              </span>
            </div>
          </section>
        ) : (
          <>
            <div className="booking-steps">
              {["Atendimento", "Data e horário", "Seus dados"].map((s, i) => (
                <div
                  key={s}
                  className={
                    step === i + 1 ? "active" : step > i + 1 ? "done" : ""
                  }
                >
                  <span>{step > i + 1 ? <Check size={15} /> : i + 1}</span>
                  <strong>{s}</strong>
                  {i < 2 && <i />}
                </div>
              ))}
            </div>
            <div className="booking-layout">
              <section className="panel booking-form-panel">
                {step === 1 ? (
                  <>
                    <h2>Como podemos cuidar de você?</h2>
                    <p className="muted">
                      Escolha o profissional e o tipo de atendimento.
                    </p>
                    {!data.professionals.length || !data.services.length ? (
                      <Empty title="Agenda em preparação">
                        A clínica ainda está configurando seus horários. Volte
                        em breve.
                      </Empty>
                    ) : (
                      <div className="stack-form">
                        <label>
                          Profissional
                          <select
                            value={professional}
                            onChange={(e) => setProfessional(e.target.value)}
                          >
                            {data.professionals.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name} · {p.specialty}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="service-options">
                          {data.services.map((s) => (
                            <button
                              key={s.id}
                              className={`service-option ${service === s.id ? "selected" : ""}`}
                              onClick={() => setService(s.id)}
                            >
                              <span className="radio-circle">
                                {service === s.id && <i />}
                              </span>
                              <span>
                                <strong>{s.name}</strong>
                                <small>
                                  {s.duration_minutes} min ·{" "}
                                  {s.price_cents
                                    ? money(s.price_cents)
                                    : "Sob consulta"}
                                </small>
                              </span>
                              {service === s.id && <Check size={18} />}
                            </button>
                          ))}
                        </div>
                        <button
                          className="btn btn-primary btn-full"
                          onClick={() => setStep(2)}
                          disabled={!professional || !service}
                        >
                          Escolher horário
                          <ArrowRight size={17} />
                        </button>
                      </div>
                    )}
                  </>
                ) : step === 2 ? (
                  <>
                    <h2>Encontre o seu melhor horário.</h2>
                    <p className="muted">
                      Horários de {selectedPro?.name} · fuso de São Paulo.
                    </p>
                    <div className="booking-date-nav">
                      <button
                        className="icon-btn bordered"
                        disabled={date <= minDate}
                        onClick={() => setDate(addDays(date, -1))}
                        aria-label="Dia anterior"
                      >
                        <ChevronLeft size={18} />
                      </button>
                      <label className="booking-date-picker">
                        <CalendarDays size={18} />
                        <input
                          aria-label="Data do atendimento"
                          type="date"
                          value={date}
                          min={minDate}
                          max={addDays(todayKey(), 60)}
                          onChange={(e) =>
                            e.target.value && setDate(e.target.value)
                          }
                        />
                      </label>
                      <button
                        className="icon-btn bordered"
                        disabled={date >= addDays(todayKey(), 60)}
                        onClick={() => setDate(addDays(date, 1))}
                        aria-label="Próximo dia"
                      >
                        <ChevronRight size={18} />
                      </button>
                    </div>
                    <h3 className="slot-date-label">
                      {dateLabel(date + "T12:00:00", {
                        weekday: "long",
                        month: "long",
                      })}
                    </h3>
                    <ErrorBox error={slotError} />
                    {slots === null && !slotError ? (
                      <Loading />
                    ) : slots?.length ? (
                      <div className="time-slots">
                        {slots.map((s) => (
                          <button
                            className={time === s.time ? "selected" : ""}
                            key={s.time}
                            onClick={() => setTime(s.time)}
                          >
                            {s.time}
                            {time === s.time && <Check size={14} />}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <Empty title="Sem horários neste dia">
                        Escolha outra data para encontrar um momento disponível.
                      </Empty>
                    )}
                    <div className="notice notice-soft">
                      <Clock3 size={17} />
                      <span>
                        Atendimentos com pelo menos 1 hora de antecedência. O
                        intervalo entre consultas é reservado automaticamente.
                      </span>
                    </div>
                    <div className="modal-actions">
                      <button
                        className="btn btn-secondary"
                        onClick={() => setStep(1)}
                      >
                        <ArrowLeft size={16} />
                        Voltar
                      </button>
                      <button
                        className="btn btn-primary"
                        disabled={!time}
                        onClick={() => setStep(3)}
                      >
                        Continuar
                        <ArrowRight size={16} />
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <h2>Falta pouco para cuidar de você.</h2>
                    <p className="muted">
                      Seus dados serão usados somente para organizar o
                      atendimento.
                    </p>
                    <form className="stack-form" onSubmit={submit}>
                      <label>
                        Nome completo
                        <input
                          name="name"
                          autoComplete="name"
                          required
                          minLength={2}
                          maxLength={100}
                          placeholder="Como você gostaria de ser chamado(a)?"
                        />
                      </label>
                      <label>
                        WhatsApp com DDD
                        <input
                          name="phone"
                          type="tel"
                          autoComplete="tel"
                          required
                          minLength={10}
                          maxLength={25}
                          placeholder="(11) 99999-9999"
                        />
                      </label>
                      <label>
                        Observações práticas{" "}
                        <span className="muted">(opcional)</span>
                        <textarea
                          name="notes"
                          maxLength={300}
                          rows={3}
                          placeholder="Ex.: prefiro atendimento online."
                        />
                        <small>
                          Não inclua diagnósticos, laudos ou informações
                          clínicas sensíveis.
                        </small>
                      </label>
                      <label className="check-label">
                        <input type="checkbox" required name="consent" />
                        <span>
                          Autorizo o uso destes dados para organizar meu
                          atendimento, conforme o{" "}
                          <Link to="/privacidade" target="_blank">
                            aviso de privacidade
                          </Link>
                          .
                        </span>
                      </label>
                      <label className="check-label">
                        <input
                          type="checkbox"
                          name="whatsappOptIn"
                          defaultChecked
                        />
                        <span>
                          Quero receber confirmação e lembretes deste
                          atendimento pelo WhatsApp. Posso pedir para não
                          receber mais mensagens com a clínica.
                        </span>
                      </label>
                      <ErrorBox error={bookingError} />
                      <div className="modal-actions">
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => setStep(2)}
                          disabled={busy}
                        >
                          <ArrowLeft size={16} />
                          Voltar
                        </button>
                        <button className="btn btn-primary" disabled={busy}>
                          {busy ? (
                            <LoaderCircle className="spin" size={17} />
                          ) : (
                            <Check size={17} />
                          )}
                          Solicitar agendamento
                        </button>
                      </div>
                    </form>
                  </>
                )}
              </section>
              <aside className="booking-summary">
                <div className="panel">
                  <span className="summary-icon">
                    <CalendarCheck2 size={27} />
                  </span>
                  <h3>Seu momento de cuidado</h3>
                  <div className="summary-row">
                    <Users size={17} />
                    <span>
                      <small>Profissional</small>
                      <strong>{selectedPro?.name || "A escolher"}</strong>
                    </span>
                  </div>
                  <div className="summary-row">
                    <HeartHandshake size={17} />
                    <span>
                      <small>Atendimento</small>
                      <strong>{selectedService?.name || "A escolher"}</strong>
                    </span>
                  </div>
                  <div className="summary-row">
                    <CalendarDays size={17} />
                    <span>
                      <small>Data e horário</small>
                      <strong>
                        {step >= 2
                          ? `${dateLabel(date + "T12:00:00")} ${time ? "às " + time : ""}`
                          : "A escolher"}
                      </strong>
                    </span>
                  </div>
                  {selectedService && (
                    <div className="summary-price">
                      <span>Valor informado</span>
                      <strong>
                        {selectedService.price_cents
                          ? money(selectedService.price_cents)
                          : "Sob consulta"}
                      </strong>
                    </div>
                  )}
                  <div className="notice notice-soft">
                    <ShieldCheck size={18} />
                    <span>
                      Seu pedido fica pendente até a resposta do profissional. O
                      horário já fica reservado para você.
                    </span>
                  </div>
                </div>
                <p className="booking-support">
                  <LockKeyhole size={14} /> Seus dados não aparecem para outros
                  clientes.
                </p>
              </aside>
            </div>
          </>
        )}
      </main>
      <footer className="public-footer">
        <Flower2 size={17} />
        Com mais presença, por Aurora.<Link to="/privacidade">Privacidade</Link>
      </footer>
    </div>
  );
}
function ClientLookup() {
  const hash = window.location.hash.slice(1);
  const [data, setData] = useState(null),
    [error, setError] = useState(null),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      setData(
        await api("/public/lookup", {
          method: "POST",
          body: { accessToken: hash },
        }),
      );
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }, [hash]);
  useEffect(() => {
    if (hash) load();
  }, [load]);
  return (
    <div className="public-page">
      <header className="public-header">
        <Brand />
        <Link to="/entrar" className="text-link">
          Área do profissional
          <ArrowUpRight size={15} />
        </Link>
      </header>
      <main className="lookup-wrap">
        <span className="eyebrow">SEU ATENDIMENTO, PERTO DE VOCÊ</span>
        <h1>Acompanhe seu pedido.</h1>
        <p className="muted">Este link é individual. Guarde-o com cuidado.</p>
        {!hash ? (
          <ErrorBox error="Abra o link completo recebido ao fazer o pedido." />
        ) : (
          <section className="panel lookup-card">
            <ErrorBox error={error} />
            {busy && !data ? (
              <Loading />
            ) : (
              data && (
                <>
                  <div className="lookup-card-head">
                    <CalendarCheck2 size={27} />
                    <Badge status={data.appointment.status} />
                  </div>
                  <h2>{data.appointment.clientName}</h2>
                  <p>{data.appointment.tenant}</p>
                  <div className="booking-receipt">
                    <strong>
                      {dateLabel(data.appointment.startsAt, {
                        weekday: "long",
                        month: "long",
                      })}
                    </strong>
                    <span>
                      {timeLabel(data.appointment.startsAt)} às{" "}
                      {timeLabel(data.appointment.endsAt)} · São Paulo
                    </span>
                    <span>{data.appointment.professional}</span>
                    <span>{data.appointment.service}</span>
                  </div>
                  <div className="notice notice-info">
                    <Clock3 size={18} />
                    <span>
                      {data.appointment.status === "pending"
                        ? "Seu horário está protegido. Aguardando a resposta do profissional."
                        : data.appointment.status === "confirmed"
                          ? "Tudo certo! Seu atendimento foi confirmado pelo profissional."
                          : data.appointment.status === "cancelled"
                            ? "Este atendimento foi cancelado. Entre em contato com a clínica para escolher outro horário."
                            : "Atendimento concluído. Obrigado pela confiança."}
                    </span>
                  </div>
                  <button
                    className="btn btn-secondary btn-full"
                    onClick={load}
                    disabled={busy}
                  >
                    <RefreshCw size={16} />
                    Atualizar situação
                  </button>
                </>
              )
            )}
          </section>
        )}
      </main>
    </div>
  );
}
function Privacy() {
  return (
    <div className="public-page">
      <header className="public-header">
        <Brand />
        <Link to="/" className="text-link">
          <ArrowLeft size={16} />
          Voltar
        </Link>
      </header>
      <main className="privacy-content panel">
        <span className="eyebrow">TRANSPARÊNCIA TAMBÉM É CUIDADO</span>
        <h1>Privacidade e uso responsável</h1>
        <p>
          Esta aplicação organiza solicitações de atendimento. O controlador dos
          dados é a clínica que compartilha sua agenda, não os visitantes de
          outras clínicas.
        </p>
        <h2>Quais dados são utilizados?</h2>
        <p>
          Nome, telefone, profissional, serviço, data, horário e observações
          práticas fornecidas por você. A autorização de mensagens é registrada
          separadamente. Não inclua diagnósticos, prontuários ou outros dados
          clínicos sensíveis nas observações.
        </p>
        <h2>Com quem são compartilhados?</h2>
        <p>
          Com o profissional responsável e a equipe autorizada da clínica. Se
          você optar por WhatsApp, nome, profissional, data, horário e clínica
          são enviados à Meta para entrega dos modelos de mensagem. Não enviamos
          o motivo clínico.
        </p>
        <h2>Como protegemos o acesso?</h2>
        <p>
          Dados são separados por clínica nas consultas do servidor. O cliente
          acompanha somente o próprio pedido por um link secreto. Telefones não
          são usados como senha. Tokens da Meta são criptografados no servidor.
        </p>
        <h2>Seus direitos e limites desta versão</h2>
        <p>
          Para acessar, corrigir, excluir dados ou revogar a autorização de
          mensagens, contate a clínica responsável. Esta edição local não
          substitui a política de retenção, o contrato com operadores, a análise
          de riscos e as obrigações LGPD da clínica. Não use dados reais antes
          da implantação segura e da definição desses processos.
        </p>
        <h2>Demonstração</h2>
        <p>
          As contas de demonstração usam dados fictícios. O envio real do
          WhatsApp fica desativado por padrão. Nenhuma mensagem é enviada apenas
          por explorar o sistema.
        </p>
        <Link to="/" className="btn btn-primary">
          Entendi
          <Check size={16} />
        </Link>
      </main>
    </div>
  );
}
