/*
 * Funções puras da área "Pessoas e grupos" (sem DOM; testadas no Node em
 * src/testing/test_admin_pessoas.js).
 *
 * Fontes dos grupos:
 * - "memória" (RME): GET /api/dossies/groups → perfis de memory_group_profiles
 *   { group_id, title, average_problematic_score, dossiers_count, problematic_reports_count,
 *     vibe_summary, latest_summary, frequent_topics, ... } (antiga /dossies, aba Grupos);
 * - "análises": GET /api/groups-dossier → summaries.db
 *   { id, name, bot_id, total_chars, pending_chars, history: [{ type, summary,
 *     problematic_score, created_at }] } (antiga /groups-dossier).
 */

/** Limite das listas (o mesmo das telas antigas). */
export const LIST_LIMIT = 50;

/**
 * Faixa da nota de risco, como nas telas antigas: ≥ 7 alta, ≥ 4 média, senão baixa.
 * @param {number} score
 * @returns {{ level: "alto"|"médio"|"baixo"|null, kind: "bad"|"att"|"ok"|"" }}
 */
export function riskLevel(score) {
	const n = Number(score);
	if (score === null || score === undefined || score === "" || !Number.isFinite(n)) {
		return { level: null, kind: "" };
	}
	if (n >= 7) return { level: "alto", kind: "bad" };
	if (n >= 4) return { level: "médio", kind: "att" };
	return { level: "baixo", kind: "ok" };
}

/** Nota com uma casa, vírgula decimal ("7,5"); "—" sem número. */
export function scoreText(score) {
	const n = Number(score);
	if (score === null || score === undefined || score === "" || !Number.isFinite(n)) return "—";
	return n.toFixed(1).replace(".", ",");
}

/**
 * Tópicos recorrentes: o perfil guarda JSON em texto; aceita lista pronta. Inválido → [].
 * @param {string|Array|null} raw
 * @returns {string[]}
 */
export function parseTopics(raw) {
	let v = raw;
	if (typeof v === "string") {
		try {
			v = JSON.parse(v);
		} catch {
			return [];
		}
	}
	if (!Array.isArray(v)) return [];
	return v
		.map((t) => (typeof t === "string" ? t : t && t.topic ? t.topic : String(t)))
		.filter(Boolean);
}

/**
 * Maior nota e média de um histórico de análises (como a tela /groups-dossier calculava).
 * @param {Array<{ problematic_score: number }>} history
 * @returns {{ max: number|null, avg: number|null }}
 */
export function historyStats(history) {
	const scores = (history || [])
		.map((h) => Number(h && h.problematic_score))
		.filter(Number.isFinite);
	if (!scores.length) return { max: null, avg: null };
	return {
		max: Math.max(...scores),
		avg: scores.reduce((a, b) => a + b, 0) / scores.length
	};
}

const norm = (s) =>
	String(s ?? "")
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase();

/**
 * Filtra as análises antigas pela busca (a rota não tem busca): nome, id, bot, tipo e resumo.
 * @param {Array} list - resposta de /api/groups-dossier
 * @param {string} q
 */
export function filterAnalyses(list, q) {
	const needle = norm(String(q || "").trim());
	if (!needle) return list || [];
	return (list || []).filter((g) => {
		const hay = [g.name, g.id, g.bot_id, ...(g.history || []).flatMap((h) => [h.type, h.summary])]
			.map(norm)
			.join("\n");
		return hay.includes(needle);
	});
}

/**
 * Junta as duas fontes de grupos pelo id. Cada item:
 * { id, name, bot, profile|null, analyses|null, score (nota média para ordenar), max, avg,
 *   dossiers, reports }
 * Ordem: maior nota primeiro (as duas telas ordenavam assim), empate pelo nome.
 * @param {Array} profiles - /api/dossies/groups
 * @param {Array} analyses - /api/groups-dossier (já filtrada)
 */
export function mergeGroups(profiles, analyses) {
	const byId = new Map();
	const get = (id) => {
		if (!byId.has(id)) byId.set(id, { id, profile: null, analyses: null });
		return byId.get(id);
	};
	for (const p of profiles || []) {
		if (p && p.group_id) get(String(p.group_id)).profile = p;
	}
	for (const a of analyses || []) {
		if (a && a.id) get(String(a.id)).analyses = a;
	}
	const out = [...byId.values()].map((g) => {
		const p = g.profile;
		const a = g.analyses;
		const stats = a ? historyStats(a.history) : { max: null, avg: null };
		const named = (v) => (v && v !== "Grupo Desconhecido" ? v : null);
		const profScore =
			p && Number.isFinite(Number(p.average_problematic_score))
				? Number(p.average_problematic_score)
				: null;
		const avg = a && Number.isFinite(Number(a.avg_score)) ? Number(a.avg_score) : stats.avg;
		const candidates = [profScore, avg].filter((n) => n !== null);
		return {
			id: g.id,
			name: named(p && p.title) || named(a && a.name) || g.id,
			bot: a && a.bot_id && a.bot_id !== "-" ? a.bot_id : null,
			profile: p,
			analyses: a,
			score: candidates.length ? Math.max(...candidates) : null,
			profileScore: profScore,
			max: stats.max,
			avg,
			dossiers: p ? Number(p.dossiers_count) || 0 : null,
			reports: p ? Number(p.problematic_reports_count) || 0 : null,
			analysesCount: a ? (a.history || []).length : null
		};
	});
	out.sort((x, y) => (y.score ?? -1) - (x.score ?? -1) || x.name.localeCompare(y.name, "pt-BR"));
	return out;
}

/**
 * Números (só dígitos) que podem ser a conta da pessoa no RavenaBank: o número do id canônico
 * ("wa_5511…" ou "tg_906652908") e o número/LID/id de cada identidade. O banco usa user_id só
 * com os dígitos do autor (telefone, LID ou o id do Telegram). Ignora os curtos (< 8 dígitos),
 * como o MemoryService.
 * @param {{ canonical_user_id?: string, identities?: Array<{ platform_id?: string, platform?: string }> }} d
 * @returns {string[]}
 */
export function bankCandidates(d) {
	const clean = (raw) =>
		String(raw || "")
			.replace(/@.*$/, "")
			.replace(/\D/g, "");
	const set = new Set();
	const canon = String((d && d.canonical_user_id) || "");
	if (/^(wa|tg)_/.test(canon)) set.add(clean(canon));
	for (const i of (d && d.identities) || []) {
		if (i && i.platform && i.platform !== "whatsapp" && i.platform !== "telegram") continue;
		set.add(clean(i && i.platform_id));
	}
	return [...set].filter((n) => n.length >= 8);
}

/**
 * Da resposta de /api/games/bank/admin/users, a conta cujo userId é exatamente um dos
 * candidatos. A busca do banco também devolve, com updatedAt null e 0 Runas, quem casa pelo
 * apelido e ainda não tem conta: esses não contam.
 * @param {Array<{ userId: string, updatedAt?: any }>} users
 * @param {string[]} candidates
 * @returns {Object|null}
 */
export function pickBankAccount(users, candidates) {
	const want = new Set(candidates || []);
	return (users || []).find((u) => u && want.has(String(u.userId)) && u.updatedAt != null) || null;
}

/** Rótulo da plataforma (a tela antiga: "WhatsApp" para whatsapp, "Telegram" para o resto). */
export const platformLabel = (p) => (p === "whatsapp" ? "WhatsApp" : "Telegram");

/** Identificador da ficha de uma pessoa da lista (como a tela antiga abria o modal). */
export const personId = (u) => (u && (u.canonical_user_id || u.platform_id)) || "";

/**
 * Data de um registro do banco de memória: número em ms ou s, ou texto SQLite
 * "AAAA-MM-DD HH:MM:SS" (UTC, CURRENT_TIMESTAMP). Devolve ms ou null.
 */
export function toMs(v) {
	if (v === null || v === undefined || v === "") return null;
	if (typeof v === "number" || /^\d+$/.test(String(v))) {
		const n = Number(v);
		if (!Number.isFinite(n) || n <= 0) return null;
		return n < 1e12 ? n * 1000 : n;
	}
	const s = String(v);
	const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? `${s.replace(" ", "T")}Z` : s;
	const t = Date.parse(iso);
	return Number.isFinite(t) ? t : null;
}
