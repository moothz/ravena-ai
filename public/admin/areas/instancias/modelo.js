/*
 * Instâncias: regras puras (sem DOM), testadas no Node em src/testing/test_admin_instancias.js.
 * Estado e filtros das instâncias, formulário ⇄ bots.json (mesmas regras da tela antiga
 * /instances), extras em 3 níveis, validação, nova instância, respostas das ações e o markup
 * do WhatsApp dos avisos de status.
 */

/* ── Estado e plataforma ───────────────────────────────────────── */

/** "whatsapp" | "telegram" | "discord" */
export function platformOf(bot) {
	if (bot && bot.useTelegram) return "telegram";
	if (bot && bot.useDiscord) return "discord";
	return "whatsapp";
}

export const PLATFORM_NAMES = { whatsapp: "WhatsApp", telegram: "Telegram", discord: "Discord" };

export const isEnabled = (bot) => !!bot && bot.enabled !== false;
/** Online como na tela antiga: conectada, não banida e ativa. */
export const isOnline = (bot) => !!(bot && bot.connected && !bot.banido && isEnabled(bot));

/**
 * Estado por escrito e lâmpada. Ordem da tela antiga: desativada > banida > online > offline;
 * o offline se divide em "desconectada" (o processo do bot está de pé, sem conexão: isLive) e
 * "parada" (sem processo), como no "Precisa de você".
 * @returns {{ key: string, word: string, lamp: "ok"|"attention"|"down"|"off", pill: ""|"ok"|"att"|"bad" }}
 */
export function botState(bot) {
	if (!isEnabled(bot)) return { key: "desativada", word: "desativada", lamp: "off", pill: "" };
	if (bot.banido) return { key: "banida", word: "banida", lamp: "down", pill: "bad" };
	if (isOnline(bot)) return { key: "online", word: "online", lamp: "ok", pill: "ok" };
	if (bot.isLive)
		return { key: "desconectada", word: "desconectada", lamp: "attention", pill: "att" };
	return { key: "parada", word: "parada", lamp: "down", pill: "bad" };
}

/** Filtros (os da tela antiga; "paradas" é o do mock: ativas fora do ar). */
export const FILTERS = [
	{ id: "todas", label: "Todas", test: () => true },
	{ id: "online", label: "Online", test: isOnline },
	{ id: "paradas", label: "Paradas", test: (b) => isEnabled(b) && !isOnline(b) },
	{ id: "desativadas", label: "Desativadas", test: (b) => !isEnabled(b) },
	{ id: "ativas", label: "Ativas", test: isEnabled },
	{ id: "offline", label: "Offline", test: (b) => !isOnline(b) }
];

export const PLATFORM_FILTERS = [
	{ id: "", label: "Todas as plataformas" },
	{ id: "whatsapp", label: "WhatsApp" },
	{ id: "telegram", label: "Telegram" },
	{ id: "discord", label: "Discord" }
];

/** Busca da tela antiga: nome, nomeExibir, número e telegramBotName. */
export function matchesSearch(bot, q) {
	const s = String(q || "")
		.toLowerCase()
		.trim();
	if (!s) return true;
	return (
		(bot.nome && String(bot.nome).toLowerCase().includes(s)) ||
		(bot.nomeExibir && String(bot.nomeExibir).toLowerCase().includes(s)) ||
		(bot.numero && String(bot.numero).includes(s)) ||
		(bot.telegramBotName && String(bot.telegramBotName).toLowerCase().includes(s)) ||
		false
	);
}

export function filterBots(bots, { filtro = "todas", plataforma = "", q = "" } = {}) {
	const f = FILTERS.find((x) => x.id === filtro) || FILTERS[0];
	return (bots || []).filter(
		(b) => b && matchesSearch(b, q) && f.test(b) && (!plataforma || platformOf(b) === plataforma)
	);
}

/** Contadores do resumo (os 8 da tela antiga). */
export function summarize(bots) {
	const s = {
		total: 0,
		enabled: 0,
		disabled: 0,
		online: 0,
		offline: 0,
		privado: 0,
		groups: 0,
		msgsHr: 0
	};
	for (const b of bots || []) {
		s.total++;
		if (isEnabled(b)) s.enabled++;
		else s.disabled++;
		if (isOnline(b)) s.online++;
		else s.offline++;
		if (b.privado) s.privado++;
		s.groups += Number(b.groupsCount) || 0;
		s.msgsHr += Math.round(Number(b.msgsHr) || 0);
	}
	return s;
}

/* ── Texto ─────────────────────────────────────────────────────── */

/** +55 (11) 99999-9999 para números brasileiros de 12/13 dígitos; o resto como veio. */
export function formatPhone(num) {
	if (!num) return "—";
	const clean = String(num).replace(/\D/g, "");
	if (clean.length === 12 || clean.length === 13) {
		const ddd = clean.slice(2, 4);
		const a = clean.length === 13 ? clean.slice(4, 9) : clean.slice(4, 8);
		const b = clean.length === 13 ? clean.slice(9) : clean.slice(8);
		return `+55 (${ddd}) ${a}-${b}`;
	}
	return String(num);
}

/** Link "Abrir conversa" (só com número, como na tela antiga). */
export function chatUrl(bot) {
	const raw = bot && bot.numero ? String(bot.numero).replace(/\D/g, "") : "";
	if (!raw) return null;
	if (platformOf(bot) === "telegram") return `https://t.me/${bot.telegramBotName || bot.nome}`;
	return `https://wa.me/${raw}`;
}

/* ── Formulário ⇄ bots.json ────────────────────────────────────── */

/** Campos de runtime que o GET /api/bots acrescenta (o POST os descarta). */
export const RUNTIME_KEYS = [
	"_runtime",
	"connected",
	"msgsHr",
	"responseTime",
	"groupsCount",
	"lastMessageReceived",
	"isLive"
];

const str = (v) => (v === undefined || v === null ? "" : String(v));

/** Valores iniciais do formulário a partir de um item do bots.json (padrões da tela antiga). */
export function formValues(bot) {
	const b = bot || {};
	return {
		plataforma: platformOf(b),
		nome: str(b.nome),
		nomeExibir: str(b.nomeExibir),
		numero: str(b.numero),
		customPrefix: b.customPrefix || "!",
		managementUser: str(b.managementUser),
		managementPW: str(b.managementPW),
		enabled: isEnabled(b),
		privado: !!b.privado,
		vip: !!b.vip,
		comunitario: !!b.comunitario,
		ignorePV: !!b.ignorePV,
		autoDownloadPV: !!b.autoDownloadPV,
		pvAI: !!b.pvAI,
		ignoreInvites: !!b.ignoreInvites,
		updateStatus: b.updateStatus !== false,
		sendJoinInfo: !!b.sendJoinInfo,
		banido: !!b.banido,
		dataNascimento: str(b.dataNascimento),
		dataMorte: str(b.dataMorte),
		aiPersonality: str(b.aiPersonality),
		msgSuporte: str(b.msgSuporte || b.supportMsg),
		numeroResponsavel: str(b.numeroResponsavel),
		grupoLogs: str(b.grupoLogs),
		grupoAvisos: str(b.grupoAvisos),
		grupoInvites: str(b.grupoInvites),
		dossieGroups: str(b.dossieGroups),
		webhookPort: str(b.webhookPort),
		ratelimit: str(b.ratelimit !== undefined && b.ratelimit !== null ? b.ratelimit : 0),
		delayMin: str(b.delayMin !== undefined && b.delayMin !== null ? b.delayMin : 0),
		delayMax: str(b.delayMax !== undefined && b.delayMax !== null ? b.delayMax : b.privado ? 0 : 2),
		deleteMessagesInterval:
			b.deleteMessagesInterval !== undefined ? str(b.deleteMessagesInterval) : "false",
		telegramBotToken: str(b.telegramBotToken),
		telegramBotName: str(b.telegramBotName),
		telegramBotId: str(b.telegramBotId),
		webhookHost: str(b.webhookHost),
		discordToken: str(b.discordToken)
	};
}

/** Cemitério: só para instância banida E desativada. */
export const showsCemiterio = (v) => !!(v && v.banido && !v.enabled);

/**
 * Aplica os valores do formulário a um item do bots.json, devolvendo uma cópia. Mesmas regras de
 * updateBotDataFromCard() da tela antiga; campos que o formulário não conhece (ex. linkGrupao)
 * são preservados. extras: objeto já montado (ver rowsToExtras) ou undefined para manter.
 */
export function applyConfig(bot, values, extras) {
	const v = values || {};
	const t = (k) => String(v[k] ?? "").trim();
	const out = { ...(bot || {}) };
	for (const k of RUNTIME_KEYS) delete out[k];

	out.nome = t("nome") || out.nome;
	out.nomeExibir = t("nomeExibir") || out.nome;
	out.numero = t("numero");
	out.customPrefix = t("customPrefix") || "!";
	out.managementUser = t("managementUser");
	out.managementPW = t("managementPW");

	for (const k of [
		"enabled",
		"privado",
		"vip",
		"comunitario",
		"banido",
		"ignorePV",
		"autoDownloadPV",
		"ignoreInvites",
		"pvAI",
		"updateStatus",
		"sendJoinInfo"
	]) {
		out[k] = !!v[k];
	}

	out.aiPersonality = t("aiPersonality");
	out.msgSuporte = t("msgSuporte");
	out.numeroResponsavel = t("numeroResponsavel");

	// A tela antiga só lia o cemitério quando a seção existia no DOM (sempre): vazio → some.
	if (t("dataNascimento")) out.dataNascimento = t("dataNascimento");
	else delete out.dataNascimento;
	if (t("dataMorte")) out.dataMorte = t("dataMorte");
	else delete out.dataMorte;

	out.grupoLogs = t("grupoLogs") || null;
	out.grupoAvisos = t("grupoAvisos") || null;
	out.grupoInvites = t("grupoInvites") || null;
	out.dossieGroups = t("dossieGroups") || null;

	out.webhookPort = t("webhookPort") ? parseInt(t("webhookPort"), 10) : null;
	if (Number.isNaN(out.webhookPort)) out.webhookPort = null;

	const del = t("deleteMessagesInterval");
	if (!del || del.toLowerCase() === "false" || del === "0") out.deleteMessagesInterval = false;
	else {
		const days = parseInt(del, 10);
		out.deleteMessagesInterval = Number.isNaN(days) || days <= 0 ? false : days;
	}

	const plat = v.plataforma || "whatsapp";
	out.useTelegram = plat === "telegram";
	out.useDiscord = plat === "discord";
	if (out.useTelegram) {
		out.telegramBotToken = t("telegramBotToken");
		out.telegramBotName = t("telegramBotName");
		out.telegramBotId = t("telegramBotId");
		out.webhookHost = t("webhookHost") || null;
	} else {
		delete out.telegramBotToken;
		delete out.telegramBotName;
		delete out.telegramBotId;
		delete out.webhookHost;
	}
	if (out.useDiscord) out.discordToken = t("discordToken");
	else delete out.discordToken;

	const rl = parseInt(t("ratelimit"), 10);
	out.ratelimit = !Number.isNaN(rl) && rl > 0 ? Math.min(600, rl) : 0;
	const dMin = parseFloat(t("delayMin"));
	out.delayMin = !Number.isNaN(dMin) && dMin >= 0 ? Math.min(5, dMin) : 0;
	const dMax = parseFloat(t("delayMax"));
	out.delayMax = !Number.isNaN(dMax) && dMax >= 0 ? Math.min(5, dMax) : out.privado ? 0 : 2;

	if (extras !== undefined) out.extras = extras;
	delete out.isNew;
	return out;
}

/* ── Extras (3 níveis: extras → categoria → propriedade) ───────── */

/** Nome de categoria/propriedade como a tela antiga: só letras, números, _ e -. */
export const cleanExtraKey = (s) =>
	String(s || "")
		.trim()
		.replace(/[^a-zA-Z0-9_-]/g, "");

export function typeOfExtra(v) {
	if (typeof v === "number") return "number";
	if (typeof v === "boolean") return "boolean";
	return "string";
}

/** Converte o valor ao trocar de tipo (mesma regra da tela antiga). */
export function castExtra(value, type) {
	if (type === "number") return Number(value) || 0;
	if (type === "boolean") return value === true || value === "true";
	return value === undefined || value === null ? "" : String(value);
}

/** { cat: { prop: v } } → [{ key, props: [{ key, type, value }] }] (editável, com renomear). */
export function extrasToRows(extras) {
	return Object.entries(extras || {}).map(([key, props]) => ({
		key,
		props: Object.entries(props && typeof props === "object" ? props : {}).map(([k, v]) => ({
			key: k,
			type: typeOfExtra(v),
			value: v
		}))
	}));
}

/** Volta para objeto; propriedade sem nome é descartada (como antes). */
export function rowsToExtras(rows) {
	const out = {};
	for (const c of rows || []) {
		if (!c.key) continue;
		out[c.key] = {};
		for (const p of c.props || []) {
			const k = String(p.key || "").trim();
			if (!k) continue;
			out[c.key][k] = castExtra(p.value, p.type);
		}
	}
	return out;
}

/* ── Validação e montagem do POST ──────────────────────────────── */

/**
 * Validação antes de salvar (a mesma da tela antiga, mais nome repetido). Devolve a mensagem do
 * primeiro problema ou null.
 */
export function validateBots(bots) {
	const seen = new Set();
	for (const b of bots || []) {
		if (!b.nome || !String(b.nome).trim())
			return "Toda instância precisa de um identificador (nome).";
		if (seen.has(b.nome)) return `Há duas instâncias com o nome '${b.nome}'.`;
		seen.add(b.nome);
		if (!b.useDiscord && (!b.numero || !String(b.numero).trim()))
			return `O número é obrigatório para a instância '${b.nome}' (só o Discord dispensa).`;
	}
	return null;
}

/**
 * Lista para o POST /api/bots: a lista atual do servidor com os rascunhos aplicados por nome e
 * as novas instâncias no início (como a tela antiga fazia com unshift).
 * @param {Array} current - GET /api/bots
 * @param {Map<string, Object>|Object} edited - nome → item já aplicado (applyConfig)
 * @param {Array} [added] - novas instâncias (já aplicadas)
 */
export function buildSaveList(current, edited, added = []) {
	const map = edited instanceof Map ? edited : new Map(Object.entries(edited || {}));
	const list = (current || []).map((b) => {
		const copy = map.has(b.nome) ? { ...map.get(b.nome) } : { ...b };
		for (const k of RUNTIME_KEYS) delete copy[k];
		return copy;
	});
	return [...added.map((b) => ({ ...b })), ...list];
}

/* ── Nova instância ────────────────────────────────────────────── */

export const PW_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*";

/** Senha aleatória (16 caracteres do mesmo alfabeto da tela antiga). rand(n) → inteiro em [0, n). */
export function generatePassword(length = 16, rand = defaultRand) {
	let s = "";
	for (let i = 0; i < length; i++) s += PW_CHARS.charAt(rand(PW_CHARS.length));
	return s;
}

function defaultRand(n) {
	const c = globalThis.crypto;
	if (c && typeof c.getRandomValues === "function") {
		const a = new Uint32Array(1);
		c.getRandomValues(a);
		return a[0] % n;
	}
	return Math.floor(Math.random() * n);
}

/** Maior webhookPort + 1, ou 14000. */
export function nextWebhookPort(bots) {
	const max = (bots || []).reduce((m, b) => {
		const p = parseInt(b && b.webhookPort, 10);
		return !Number.isNaN(p) && p > m ? p : m;
	}, 0);
	return max > 0 ? max + 1 : 14000;
}

/** Item novo, desativado, com os padrões da tela antiga. */
export function newBot(bots, rand = defaultRand) {
	const taken = new Set((bots || []).map((b) => b && b.nome));
	let nome;
	do nome = `rav-${1000 + rand(9000)}`;
	while (taken.has(nome));
	return {
		enabled: false,
		nome,
		nomeExibir: "Nova Ravena",
		numero: "",
		webhookPort: nextWebhookPort(bots),
		customPrefix: "!",
		managementUser: "admin",
		managementPW: generatePassword(16, rand),
		privado: false,
		vip: false,
		comunitario: false,
		ignorePV: false,
		autoDownloadPV: false,
		ignoreInvites: false,
		pvAI: true,
		updateStatus: true,
		sendJoinInfo: true,
		aiPersonality: "",
		msgSuporte: "",
		extras: {}
	};
}

/** "usuário:senha" do painel da instância (o authenticateBasic das rotas :botId usa estes). */
export function botCredentials(bot) {
	if (!bot || !bot.managementUser || !bot.managementPW) return null;
	return `${bot.managementUser}:${bot.managementPW}`;
}

/* ── Respostas das ações (/restart, /logout, /reconnect, /recreate) ── */

function msgText(m) {
	if (m === undefined || m === null || m === "") return "";
	if (typeof m === "string") return m;
	if (typeof m === "object") {
		if (typeof m.message === "string" && m.message) return m.message;
		try {
			const j = JSON.stringify(m);
			return j === "{}" ? "" : j;
		} catch {
			return "";
		}
	}
	return String(m);
}

/** Passos do /recreate ({ action, status, error, attempt }) resumidos: "create (3×): motivo". */
function stepsText(steps) {
	const groups = new Map();
	for (const st of steps) {
		const key = `${st.action || "passo"}: ${msgText(st.error) || st.status}`;
		groups.set(key, (groups.get(key) || 0) + 1);
	}
	return [...groups].map(([k, n]) => (n > 1 ? k.replace(":", ` (${n}×):`) : k)).join("; ");
}

/**
 * O /restart responde 200 com status "error" quando o bot falha; o /reconnect também pode; o
 * /recreate responde "ok" mesmo quando todos os passos falharam (details[].status "error").
 * Devolve { ok, message } com a mensagem do servidor por escrito.
 */
export function actionOutcome(json) {
	if (!json || typeof json !== "object") return { ok: true, message: msgText(json) };
	const ok = json.status === undefined || json.status === "ok" || json.status === "success";
	const steps = Array.isArray(json.details)
		? json.details.filter((d) => d && typeof d === "object" && d.status)
		: [];
	if (ok && steps.length) {
		const bad = steps.filter((d) => d.status === "error");
		const good = steps.filter((d) => d.status !== "error");
		const lastCreate = [...steps].reverse().find((d) => d.action === "create");
		if (bad.length && (!good.length || (lastCreate && lastCreate.status === "error")))
			return { ok: false, message: stepsText(bad) };
		if (bad.length)
			return { ok: true, message: `${msgText(json.message)} (com avisos: ${stepsText(bad)})` };
	}
	return {
		ok,
		message: msgText(json.message) || (Array.isArray(json.details) ? "" : msgText(json.details))
	};
}

/* ── Avisos de status ──────────────────────────────────────────── */

/** datetime-local no fuso do navegador (o mesmo da tela antiga). */
export function toDatetimeLocal(ts) {
	const d = new Date(Number(ts));
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const EXPIRY_PRESETS = [
	{ hours: 1, label: "+1 hora" },
	{ hours: 6, label: "+6 horas" },
	{ hours: 12, label: "+12 horas" },
	{ hours: 24, label: "+1 dia" },
	{ hours: 72, label: "+3 dias" },
	{ hours: 168, label: "+1 semana" }
];

export const QUICK_EMOJIS = ["📢", "⚠️", "🚀", "🔧", "ℹ️", "🕒", "🛑", "✨", "🚨", "🔄"];

/** Validação do aviso antes de enviar. Devolve { error, field } ou { expiresAt }. */
export function validateAnnouncement(message, expiryValue, now = Date.now()) {
	if (!String(message || "").trim())
		return { error: "Digite o texto do aviso antes de salvar.", field: "message" };
	if (!expiryValue) return { error: "Escolha a data e a hora de expiração.", field: "expires" };
	const ts = new Date(expiryValue).getTime();
	if (!Number.isFinite(ts) || ts <= now)
		return { error: "A expiração precisa ser depois de agora.", field: "expires" };
	return { expiresAt: ts };
}

/**
 * Inserção no cursor (barra de formatação): devolve { value, cursor }.
 * Com seleção, envolve; sem seleção, o cursor fica entre os marcadores.
 */
export function insertAround(text, start, end, before, after = "") {
	const t = String(text || "");
	const sel = t.substring(start, end);
	const rep = before + sel + after;
	return {
		value: t.substring(0, start) + rep + t.substring(end),
		cursor: sel ? start + rep.length : start + before.length
	};
}

/**
 * Markup do WhatsApp → árvore simples (sem HTML), para a prévia. Mesmas regras da tela antiga:
 * ```bloco```, `código`, linhas "> citação", *negrito*, _itálico_, ~tachado~ e links http(s).
 * Nó: string (texto) | { t: "b"|"i"|"s"|"code"|"pre"|"quote"|"a"|"br", c?: Nó[], text?, href? }
 */
export function parseWaMarkup(text) {
	if (!text || typeof text !== "string") return [];
	const out = [];
	const parts = text.split(/```([\s\S]*?)```/);
	parts.forEach((part, i) => {
		if (i % 2 === 1) {
			out.push({ t: "pre", text: part });
			return;
		}
		if (!part) return;
		const lines = part.split("\n");
		let quote = null;
		const flush = () => {
			if (quote) out.push({ t: "quote", c: quote });
			quote = null;
		};
		lines.forEach((line, li) => {
			const m = line.match(/^>\s?(.*)$/);
			if (m) {
				if (quote) quote.push({ t: "br" });
				else quote = [];
				quote.push(...parseInline(m[1]));
				return;
			}
			flush();
			out.push(...parseInline(line));
			if (li < lines.length - 1) out.push({ t: "br" });
		});
		flush();
	});
	return out;
}

const INLINE = [
	{ t: "code", re: /`([^`\n]+?)`/g, raw: true },
	{ t: "b", re: /\*([^*\n]+?)\*/g, pre: /[\s>(~_]/, mark: "*" },
	{ t: "i", re: /_([^_\n]+?)_/g, pre: /[\s>(~*]/, mark: "_" },
	{ t: "s", re: /~([^~\n]+?)~/g, pre: /[\s>(_*]/, mark: "~" },
	{ t: "a", re: /https?:\/\/[^\s<]+/gi, link: true }
];

function parseInline(s) {
	if (!s) return [];
	let best = null;
	for (const rule of INLINE) {
		rule.re.lastIndex = 0;
		let m;
		while ((m = rule.re.exec(s))) {
			if (rule.pre) {
				const prev = m.index > 0 ? s[m.index - 1] : "";
				const next = s[m.index + m[0].length] || "";
				const okPrev = !prev || rule.pre.test(prev);
				const okNext =
					!next || !new RegExp(`[\\w${rule.mark === "*" ? "\\*" : rule.mark}]`).test(next);
				if (!okPrev || !okNext || /^\s*$/.test(m[1])) {
					rule.re.lastIndex = m.index + 1;
					continue;
				}
			}
			if (!best || m.index < best.m.index) best = { rule, m };
			break;
		}
	}
	if (!best) return [s];
	const { rule, m } = best;
	const before = s.slice(0, m.index);
	const after = s.slice(m.index + m[0].length);
	let node;
	if (rule.raw) node = { t: rule.t, text: m[1] };
	else if (rule.link) node = { t: "a", href: m[0], text: m[0] };
	else node = { t: rule.t, c: parseInline(m[1]) };
	return [...(before ? [before] : []), node, ...parseInline(after)];
}
