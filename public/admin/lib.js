/*
 * Funções puras do painel de admin (sem DOM, sem fetch): números, tempo, rotas por hash,
 * links do Grafana e o que "precisa de você". core.js reexporta tudo daqui; os testes em
 * src/testing/test_admin_kit.js importam este arquivo direto no Node.
 */

/* ── Números, plurais e datas em pt-BR ─────────────────────────── */

const nf = new Intl.NumberFormat("pt-BR");
const nf2 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
const dtf = new Intl.DateTimeFormat("pt-BR", {
	dateStyle: "short",
	timeStyle: "short",
	timeZone: "America/Sao_Paulo"
});

const isNum = (n) => typeof n === "number" && Number.isFinite(n);

/** fmt(18240) → "18.240"; não número → "—" (nunca um 0 que não existe). */
export const fmt = (n) => (isNum(n) ? nf.format(n) : "—");

/** fmt2(1234.567) → "1.234,57" */
export const fmt2 = (n) => (isNum(n) ? nf2.format(n) : "—");

/** plural(2, "instância", "instâncias") → "2 instâncias" */
export const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;

/** dateFmt(ts) → "21/11/2026, 14:05" (horário de Brasília); sem data → "—" */
export function dateFmt(ts) {
	const n = typeof ts === "string" && !/^\d+$/.test(ts) ? Date.parse(ts) : Number(ts);
	if (!ts || !Number.isFinite(n)) return "—";
	return dtf.format(new Date(n));
}

/**
 * Tempo relativo curto: "agora", "há 3 min", "há 46 h", "há 2 d", "em 5 min", "em 3 d".
 * @param {number|string|Date} ts - epoch em ms, ISO ou Date
 * @param {number} [now] - para testes
 */
export function relTime(ts, now = Date.now()) {
	const n =
		ts instanceof Date ? ts.getTime() : typeof ts === "string" ? Date.parse(ts) : Number(ts);
	if (!ts || !Number.isFinite(n)) return "—";
	const diff = Math.round((now - n) / 1000);
	const s = Math.abs(diff);
	if (s < 60) return "agora";
	const m = Math.round(s / 60);
	const hr = Math.round(m / 60);
	const unit = m < 60 ? `${m} min` : hr < 48 ? `${hr} h` : `${Math.round(hr / 24)} d`;
	return diff >= 0 ? `há ${unit}` : `em ${unit}`;
}

/* ── HTTP ─────────────────────────────────────────────────────── */

/** Motivo de uma falha HTTP, por escrito, para o usuário. */
export function httpReason(status) {
	if (status === 0) return "sem conexão com o servidor";
	if (status === 400) return "dados inválidos";
	if (status === 401) return "sessão expirada, entre de novo";
	if (status === 403) return "sem permissão (ou pedido de outro site recusado)";
	if (status === 404) return "não encontrado";
	if (status === 409) return "não dá para fazer isso agora (estado mudou ou recurso desligado)";
	if (status === 415) return "formato do pedido não aceito";
	if (status === 429) return "muitos pedidos seguidos, tente em 1 min";
	if (status >= 500) return `erro no servidor (${status})`;
	return `HTTP ${status}`;
}

/* ── Rotas por hash: #/<área>/<seg1>/<seg2>?a=1 ──────────────────── */

/**
 * parseHash("#/banco/jogador/42?aba=extrato")
 *   → { areaId: "banco", segs: ["jogador", "42"], params: URLSearchParams("aba=extrato") }
 * Segmentos vêm decodificados; vazio → areaId "".
 */
export function parseHash(hash) {
	const raw = String(hash || "").replace(/^#\/?/, "");
	const qi = raw.indexOf("?");
	const pathPart = qi >= 0 ? raw.slice(0, qi) : raw;
	const query = qi >= 0 ? raw.slice(qi + 1) : "";
	const parts = pathPart
		.split("/")
		.filter(Boolean)
		.map((p) => {
			try {
				return decodeURIComponent(p);
			} catch {
				return p;
			}
		});
	return { areaId: parts[0] || "", segs: parts.slice(1), params: new URLSearchParams(query) };
}

/**
 * Monta um hash interno. buildHash("banco", ["jogador", "5511 9"], { aba: "x" })
 *   → "#/banco/jogador/5511%209?aba=x"
 */
export function buildHash(areaId, segs = [], params = null) {
	const path = [areaId, ...segs].map((s) => encodeURIComponent(String(s))).join("/");
	const qs = params ? new URLSearchParams(params).toString() : "";
	return `#/${path}${qs ? `?${qs}` : ""}`;
}

/* ── Links do Grafana ──────────────────────────────────────────── */

/**
 * Acrescenta parâmetros a uma URL (de painel do Grafana, por exemplo). Valores em lista
 * viram parâmetros repetidos (var-moedas=a&var-moedas=b); null/undefined são ignorados.
 * @param {string|null} url
 * @param {Object<string, string|number|Array<string|number>>} [params]
 * @returns {string|null}
 */
export function withParams(url, params = {}) {
	if (!url) return null;
	const u = new URL(url);
	for (const [k, v] of Object.entries(params || {})) {
		if (v === undefined || v === null) continue;
		for (const one of Array.isArray(v) ? v : [v]) u.searchParams.append(k, String(one));
	}
	return u.toString();
}

/* ── Estados derivados ─────────────────────────────────────────── */

export const SERVICE_NAMES = {
	whatsgoapi: "WhatsGo API",
	imagine: "Imagine",
	llm: "LLM",
	whisper: "Whisper (STT)",
	kokorotts: "Kokoro TTS",
	f5tts: "F5 TTS",
	sdwebui: "SD WebUI",
	nudenet: "NudeNet"
};

/**
 * "ok" | "backup" | "down" | "unknown". "backup" (na reserva): o principal não respondeu e um
 * reserva atende; "sem dado" é diferente de "fora".
 */
export function serviceKind(value) {
	const status = typeof value === "object" && value ? value.status : value;
	if (status === "up" || status === "online" || status === "ok") return "ok";
	if (status === "backup") return "backup";
	if (status === "down" || status === "offline") return "down";
	return "unknown";
}

/**
 * Serviços de /api/services/status para contar e listar, numa regra só (menu, Visão geral,
 * "Precisa de você" e Provedores): o F5 TTS com o mesmo estado do Kokoro TTS é o mesmo
 * serviço (o checkServices testa um endereço só) e conta uma vez.
 * @param {Object|null} services
 * @returns {Array<[string, any]>} pares [chave, valor]
 */
export function serviceEntries(services) {
	if (!services || typeof services !== "object") return [];
	const same =
		"kokorotts" in services &&
		JSON.stringify(services.f5tts) === JSON.stringify(services.kokorotts);
	return Object.entries(services).filter(([k]) => !(k === "f5tts" && same));
}

/** Palavra de cada serviceKind (para lâmpada/pílula). */
export const SERVICE_KIND_WORD = {
	ok: "no ar",
	backup: "na reserva",
	down: "fora do ar",
	unknown: "sem dado"
};

/** Evento em andamento (ScheduledEventService marca "ativo"; o horário confirma). */
export function isEventActive(e, now = Date.now()) {
	if (!e) return false;
	if (e.status === "ativo" || e.status === "active" || e.status === "running") return true;
	return isNum(e.startTime) && isNum(e.endTime) && e.startTime <= now && now < e.endTime;
}

/** Evento ainda por começar. */
export function isEventUpcoming(e, now = Date.now()) {
	if (!e) return false;
	if (isNum(e.startTime)) return e.startTime > now;
	return e.status === "proximo" || e.status === "normal";
}

/**
 * Falhas de LLM só pedem atenção com amostra mínima e taxa alta: um 1 em 3 de madrugada
 * não acende o âmbar.
 */
export const LLM_FAIL_MIN_REQUESTS = 20;
export const LLM_FAIL_RATE = 0.1;
export function llmFailing(s) {
	if (!s || !s.total_requests || s.total_requests < LLM_FAIL_MIN_REQUESTS) return false;
	return s.total_failures / s.total_requests > LLM_FAIL_RATE;
}

export const TIMEFRAMES = [
	{ id: "1h", label: "1 h", ms: 60 * 60 * 1000 },
	{ id: "24h", label: "24 h", ms: 24 * 60 * 60 * 1000 },
	{ id: "7d", label: "7 d", ms: 7 * 24 * 60 * 60 * 1000 },
	{ id: "30d", label: "30 d", ms: 30 * 24 * 60 * 60 * 1000 }
];

export const ECON_SOURCE_NAMES = {
	zinthos: "Zinthos",
	petalitas: "Petalitas",
	runas: "Runas",
	"zinthos.players": "Zinthos por jogador",
	"petalitas.players": "Petalitas por jogador",
	"runas.players": "Runas por jogador"
};

/**
 * Situação da carga da economia a partir de GET /api/economy/admin/status (mesma regra do
 * cartão do /banco/admin: atraso acima de intervalo + 2 h).
 * @param {Object|null} st
 * @returns {{ state: "ok"|"attention"|"down"|"off", word: string, detail?: string,
 *   failing: Array<{name: string, source: string, error: string}>,
 *   late: Array<{name: string, source: string, hours: number}>, paused: boolean, everyHours: number|null, running: boolean,
 *   available: boolean }}
 */
export function econHealth(st) {
	const out = {
		state: "off",
		word: "sem dado",
		failing: [],
		late: [],
		paused: false,
		everyHours: null,
		running: false,
		available: false
	};
	if (!st) return out;
	if (!st.enabled) {
		return { ...out, word: "desligada", detail: "ECONOMY_ANALYTICS_ENABLED diferente de true" };
	}
	if (!st.worker) return { ...out, word: "parada", detail: "a carga não roda neste processo" };
	const sch = st.schedule || {};
	const now = st.now || Date.now();
	const limit = (sch.everyHours || 1) * 3600000 + 2 * 3600000;
	const main = (st.loads || []).filter((l) => (st.sources || []).includes(l.source));
	const name = (src) => ECON_SOURCE_NAMES[src] || src;
	out.available = true;
	out.paused = !!sch.paused;
	out.everyHours = sch.everyHours || null;
	out.running = !!st.running;
	for (const l of main) {
		if (!l.lastOk)
			out.failing.push({ name: name(l.source), source: l.source, error: l.lastError || "erro" });
		else if (!l.okTo || now - l.okTo > limit) {
			out.late.push({
				name: name(l.source),
				source: l.source,
				hours: l.okTo ? Math.round((now - l.okTo) / 3600000) : null
			});
		}
	}
	// Ordem única (a área Carga usa a mesma): com erro > atrasada > pausada > sem carga ainda >
	// rodando agora / em dia. A pausa é escolha de quem administra; não esconde falha nem atraso.
	if (out.failing.length) Object.assign(out, { state: "down", word: "com erro" });
	else if (out.late.length) Object.assign(out, { state: "attention", word: "atrasada" });
	else if (out.paused) Object.assign(out, { state: "off", word: "pausada" });
	else if (!main.length)
		Object.assign(out, {
			state: out.running ? "ok" : "off",
			word: out.running ? "rodando agora" : "sem carga ainda"
		});
	else Object.assign(out, { state: "ok", word: out.running ? "rodando agora" : "em dia" });
	return out;
}

/** Moeda de uma fonte da carga ("runas.players" → "runas"), ou null. */
const sourceCoin = (src) => {
	const c = String(src || "").split(".")[0];
	return ["zinthos", "petalitas", "runas"].includes(c) ? c : null;
};

/**
 * Parâmetros do painel da economia no Grafana para uma fonte: a aba e a moeda dela
 * (var-moedas, a variável do painel desde a v4; antes era var-moeda).
 */
export function econGrafana(source, dtab) {
	const coin = sourceCoin(source);
	return { dtab, "var-moedas": coin || undefined };
}

/**
 * Lista do "Precisa de você" a partir das leituras do painel. Cada item:
 * { state: "down"|"attention"|"off", title, detail?, href (rota interna), where (nome da área),
 *   external?: { href, label } (atalho para outro painel) }.
 * Só "down" e "attention" contam como "precisam de você"; "off" (sem dado, pausado) aparece
 * no fim, sem contar.
 * @param {{ bots?: Array, services?: Object, llm?: Object, econ?: Object, possible?: Array,
 *   grafana?: (name: string, params?: Object) => string|null, now?: number }} d
 */
export function deriveNeeds(d = {}) {
	const needs = [];
	const now = d.now || Date.now();
	const grafana = typeof d.grafana === "function" ? d.grafana : () => null;

	const bots = Array.isArray(d.bots) ? d.bots.filter((b) => b && b.enabled !== false) : [];
	for (const b of bots.filter((x) => !x.connected)) {
		needs.push({
			state: b.isLive ? "attention" : "down",
			title: `${b.nomeExibir || b.nome || b.id} ${b.isLive ? "desconectada" : "parada"}`,
			detail: `Última mensagem ${relTime(b.lastMessageReceived, now)}`,
			href: b.nome ? buildHash("instancias", [b.nome]) : "#/instancias",
			where: "Instâncias"
		});
	}

	const services = serviceEntries(d.services);
	const svcName = ([k]) => SERVICE_NAMES[k] || k;
	const svcDown = services.filter(([, v]) => serviceKind(v) === "down");
	const svcBackup = services.filter(([, v]) => serviceKind(v) === "backup");
	const svcUnknown = services.filter(([, v]) => serviceKind(v) === "unknown");
	// Mais de 3 serviços fora viram uma linha só (no celular, 8 linhas iguais empurram o resto).
	if (svcDown.length > 3) {
		needs.push({
			state: "down",
			title: `${svcDown.length} de ${services.length} serviços fora do ar`,
			detail: svcDown.map(svcName).join(", "),
			href: "#/provedores",
			where: "Provedores"
		});
	} else {
		for (const entry of svcDown) {
			needs.push({
				state: "down",
				title: `${svcName(entry)} fora do ar`,
				href: "#/provedores",
				where: "Provedores"
			});
		}
	}

	for (const entry of svcBackup) {
		needs.push({
			state: "attention",
			title: `${svcName(entry)} na reserva`,
			detail: "O principal não respondeu; um reserva está atendendo",
			href: "#/provedores",
			where: "Provedores"
		});
	}

	if (llmFailing(d.llm)) {
		needs.push({
			state: "attention",
			title: "IA com muitas falhas",
			detail: `${plural(d.llm.total_failures, "falha", "falhas")} em ${plural(d.llm.total_requests, "requisição", "requisições")} nas últimas 24 h`,
			href: "#/provedores/uso",
			where: "Uso de IA",
			external: { href: grafana("llm"), label: "Uso de LLM" }
		});
	}

	const econ = econHealth(d.econ);
	for (const f of econ.failing) {
		needs.push({
			state: "down",
			title: `Carga da economia: ${f.name} falhou`,
			detail: f.error,
			href: "#/carga",
			where: "Carga",
			external: { href: grafana("economia", econGrafana(f.source, "diagnstico")), label: "Grafana" }
		});
	}
	for (const l of econ.late) {
		needs.push({
			state: "attention",
			title:
				l.hours === null ? `${l.name} sem carga ainda` : `${l.name} com ${l.hours} h de atraso`,
			detail: "Os gráficos da economia estão parados nessa moeda",
			href: "#/carga",
			where: "Carga",
			external: { href: grafana("economia", econGrafana(l.source, "diagnstico")), label: "Grafana" }
		});
	}

	const possible = Array.isArray(d.possible) ? d.possible.length : 0;
	if (possible) {
		needs.push({
			state: "attention",
			title: `${plural(possible, "possível mudança", "possíveis mudanças")} da economia para decidir`,
			detail: "O painel marcou mudanças de balanceamento sem anotação",
			href: "#/carga",
			where: "Carga",
			external: { href: grafana("economia", { dtab: "mudanas" }), label: "Grafana" }
		});
	}

	if (svcUnknown.length) {
		needs.push({
			state: "off",
			title:
				svcUnknown.length === 1
					? `${svcName(svcUnknown[0])}: sem dado`
					: `${svcUnknown.length} serviços sem dado`,
			detail: svcUnknown.length > 1 ? svcUnknown.map(svcName).join(", ") : null,
			href: "#/provedores",
			where: "Provedores"
		});
	}
	if (econ.available && econ.paused) {
		needs.push({
			state: "off",
			title: "Carga da economia pausada",
			detail: "Nada roda sozinho até retomar",
			href: "#/carga",
			where: "Carga"
		});
	}
	return needs;
}

/** Quantos itens realmente pedem ação (down/attention). */
export const countActionable = (needs) =>
	(needs || []).filter((n) => n.state === "down" || n.state === "attention").length;
