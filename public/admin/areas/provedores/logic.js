/*
 * Provedores de IA: regras puras (sem DOM), testadas no Node (src/testing/test_admin_provedores.js).
 * - categorias da config (service-providers.json) e o serviço de /api/services/status de cada uma;
 * - estado de cada provedor (ligado, fora, desligado) a partir do estado da categoria;
 * - operações na config (ligar/desligar, reordenar, criar/editar, apagar) sem mutar a entrada;
 * - formulário → provedor, preservando os campos que a tela não edita;
 * - fila do LLM, uso por provedor e tipo e simulador de custos (as fórmulas da tela antiga).
 */

/** Categorias na ordem da tela antiga, com o nome por extenso. */
export const CATEGORIES = [
	{ id: "llm", name: "Inteligência artificial (LLM)" },
	{ id: "laya", name: "Decisão rápida / intenção (Laya System One)" },
	{ id: "whisper", name: "Transcrição de áudio (Whisper)" },
	{ id: "comfyui", name: "Geração de imagens (ComfyUI)" },
	{ id: "bonsai", name: "Geração de imagens (Bonsai)" },
	{ id: "sdwebui", name: "Geração de imagens (SD WebUI)" },
	{ id: "kokorotts", name: "Texto em fala (Kokoro-TTS)" },
	{ id: "nudenet", name: "Detecção de conteúdo NSFW (NudeNet)" },
	{ id: "rembg", name: "Remoção de fundo de imagem (rembg)" }
];

/** Categoria → chave de /api/services/status (o checkServices do BotAPI). */
export const CATEGORY_SERVICE = {
	llm: "llm",
	bonsai: "imagine",
	whisper: "whisper",
	kokorotts: "kokorotts",
	sdwebui: "sdwebui",
	nudenet: "nudenet"
};

/** Serviço → categoria (para a linha do serviço levar ao grupo). */
export const SERVICE_CATEGORY = Object.fromEntries(
	Object.entries(CATEGORY_SERVICE).map(([c, s]) => [s, c])
);

export const LLM_TYPES = [
	{ value: "ollama", label: "Ollama" },
	{ value: "openai", label: "OpenAI (e compatíveis)" },
	{ value: "openrouter", label: "OpenRouter" }
];

export const LAYA_DEFAULT_MODEL = "ravena-bgem3";

const isOn = (p) => !!p && p.enabled !== false;

/**
 * Categorias a mostrar: as 9 conhecidas e qualquer outra lista que exista na config
 * (ex. "kokoro-tts" antigo), para nada ficar escondido.
 * @param {Object} config
 * @returns {Array<{ id: string, name: string, known: boolean }>}
 */
export function categoriesOf(config) {
	const out = CATEGORIES.map((c) => ({ ...c, known: true }));
	for (const [k, v] of Object.entries(config || {})) {
		if (Array.isArray(v) && !out.some((c) => c.id === k))
			out.push({ id: k, name: k, known: false });
	}
	return out;
}

/** Palavra de status de um valor de /api/services/status: "up" | "backup" | "down" | "unknown". */
export function statusOf(value) {
	const s = value && typeof value === "object" ? value.status : value;
	if (s === "up" || s === "online" || s === "ok") return "up";
	if (s === "backup") return "backup";
	if (s === "down" || s === "offline") return "down";
	return "unknown";
}

/**
 * Estado de cada provedor de uma categoria. Só há saúde por categoria (o checkServices testa o
 * principal e, se cair, os reservas) e, no LLM, o nome do provedor que está atendendo.
 * @param {string} cat
 * @param {Array<Object>} list - provedores na ordem da config
 * @param {Object|null} services - /api/services/status (null = sem dado)
 * @returns {Array<{ state: "ok"|"attention"|"down"|"off", word: string, role: "principal"|"reserva"|null,
 *   rank: number|null, active: boolean }>}
 */
export function providerStates(cat, list, services) {
	const arr = Array.isArray(list) ? list : [];
	const enabled = arr.map((p, i) => (isOn(p) ? i : -1)).filter((i) => i >= 0);
	const key = CATEGORY_SERVICE[cat];
	const raw = key && services ? services[key] : undefined;
	const st = raw === undefined ? "unknown" : statusOf(raw);
	// No LLM o status diz quem está atendendo agora (o modelo é o nome do provedor).
	let activeIdx = -1;
	if (cat === "llm" && raw && typeof raw === "object" && raw.model) {
		activeIdx = enabled.find((i) => arr[i].name === raw.model) ?? -1;
	}
	if (st === "up" && activeIdx < 0) activeIdx = enabled[0] ?? -1;
	return arr.map((p, i) => {
		if (!isOn(p)) return { state: "off", word: "desligado", role: null, rank: null, active: false };
		const rank = enabled.indexOf(i) + 1;
		const role = rank === 1 ? "principal" : "reserva";
		const base = { role, rank, active: i === activeIdx };
		if (st === "down") return { ...base, state: "down", word: "fora", active: false };
		if (st === "up") {
			return { ...base, state: "ok", word: i === activeIdx ? "no ar" : "ligado" };
		}
		if (st === "backup") {
			// Fora: o principal, e no LLM todos os que vêm antes do que está atendendo.
			const before = activeIdx >= 0 ? enabled.indexOf(i) < enabled.indexOf(activeIdx) : rank === 1;
			if (before) return { ...base, state: "down", word: "fora", active: false };
			return { ...base, state: "ok", word: i === activeIdx ? "atendendo" : "ligado" };
		}
		return { ...base, state: "ok", word: "ligado" };
	});
}

/**
 * Resumo da categoria para a pílula do cartão.
 * @returns {{ text: string, kind: ""|"ok"|"att"|"bad" }}
 */
export function categorySummary(cat, list, services) {
	const arr = Array.isArray(list) ? list : [];
	const on = arr.filter(isOn).length;
	if (!arr.length) return { text: "nenhum cadastrado", kind: "" };
	if (!on) return { text: "todos desligados", kind: "att" };
	const key = CATEGORY_SERVICE[cat];
	const st = key && services ? statusOf(services[key]) : "unknown";
	if (st === "down") return { text: "fora do ar", kind: "bad" };
	if (st === "backup") return { text: "na reserva", kind: "att" };
	if (st === "up") return { text: "no ar", kind: "ok" };
	return { text: `${on} de ${arr.length} ligados`, kind: "" };
}

/** Uma linha de detalhes como na tela antiga: URL, modelo, contexto, saída, circuit breaker. */
export function describeProvider(p, fmt = String) {
	const parts = [];
	if (p.model) parts.push(p.model);
	if (p.url) parts.push(p.url);
	if (p.contextLength) parts.push(`contexto ${fmt(p.contextLength)}`);
	if (p.maxTokens) parts.push(`saída máx. ${fmt(p.maxTokens)}`);
	if (p.circuitBreakerDuration)
		parts.push(`pausa ${Math.round(p.circuitBreakerDuration / 1000)} s`);
	return parts.join(" · ");
}

/* ── Serviços (/api/services/status) ─────────────────────────────── */

const SVC_ORDER = { down: 0, backup: 1, unknown: 2, up: 3 };

/**
 * Linhas de serviços, o que está fora primeiro. f5tts igual ao kokorotts (o BotAPI copia um no
 * outro) vira uma linha só.
 * @param {Object|null} services
 * @param {Object} names - SERVICE_NAMES do kit
 * @returns {Array<{ key: string, name: string, status: "up"|"backup"|"down"|"unknown", model?: string,
 *   resetSeconds?: number, category: string|null }>}
 */
export function serviceRows(services, names = {}) {
	if (!services || typeof services !== "object") return [];
	const same = JSON.stringify(services.f5tts) === JSON.stringify(services.kokorotts);
	return Object.entries(services)
		.filter(([k]) => !(k === "f5tts" && same && "kokorotts" in services))
		.map(([k, v]) => {
			let name = names[k] || k;
			if (k === "kokorotts" && same && "f5tts" in services)
				name = `${name} / ${names.f5tts || "F5 TTS"}`;
			const row = { key: k, name, status: statusOf(v), category: SERVICE_CATEGORY[k] || null };
			if (v && typeof v === "object") {
				if (v.model) row.model = String(v.model);
				if (Number(v.resetSeconds) > 0) row.resetSeconds = Number(v.resetSeconds);
			}
			return row;
		})
		.sort((a, b) => SVC_ORDER[a.status] - SVC_ORDER[b.status]);
}

/* ── Operações na config (nunca mutam a entrada) ─────────────────── */

const clone = (c) => JSON.parse(JSON.stringify(c || {}));

/** Ligar/desligar. */
export function toggleProvider(config, cat, i) {
	const next = clone(config);
	const p = next[cat] && next[cat][i];
	if (!p) throw new Error("Provedor não encontrado");
	p.enabled = !isOn(p);
	return next;
}

/** Trocar de lugar com o vizinho (delta -1 sobe, +1 desce). Fora dos limites: igual. */
export function moveProvider(config, cat, i, delta) {
	const next = clone(config);
	const arr = next[cat];
	const j = i + delta;
	if (!Array.isArray(arr) || !arr[i] || j < 0 || j >= arr.length) return next;
	[arr[i], arr[j]] = [arr[j], arr[i]];
	return next;
}

export function removeProvider(config, cat, i) {
	const next = clone(config);
	if (!Array.isArray(next[cat]) || !next[cat][i]) throw new Error("Provedor não encontrado");
	next[cat].splice(i, 1);
	return next;
}

/** i = -1 acrescenta no fim (menor prioridade), como a tela antiga. */
export function upsertProvider(config, cat, i, provider) {
	const next = clone(config);
	if (!Array.isArray(next[cat])) next[cat] = [];
	if (i < 0) next[cat].push(provider);
	else if (next[cat][i]) next[cat][i] = provider;
	else throw new Error("Provedor não encontrado");
	return next;
}

/** É o único ligado da categoria? (desligar para o serviço) */
export function isLastEnabled(list, i) {
	const arr = Array.isArray(list) ? list : [];
	return isOn(arr[i]) && arr.filter(isOn).length === 1;
}

/* ── Formulário ──────────────────────────────────────────────────── */

const str = (v) => (v === undefined || v === null ? "" : String(v));

/**
 * Valores iniciais do formulário (novo: os padrões da tela antiga).
 * @param {string} cat
 * @param {Object|null} p
 */
export function formValues(cat, p) {
	const e = p || {};
	const v = {
		name: str(e.name),
		url: str(e.url),
		apiKey: str(e.apiKey),
		enabled: p ? isOn(p) : true
	};
	if (cat === "llm") {
		Object.assign(v, {
			type: e.type || "ollama",
			model: str(e.model),
			timeout_multiplier: str(e.timeout_multiplier),
			textOnly: !!e.textOnly,
			ignoreVideo: !!e.ignoreVideo,
			toolCalling: !!e.toolCalling,
			contextLength: str(e.contextLength),
			maxTokens: str(e.maxTokens)
		});
	} else if (cat === "laya") {
		Object.assign(v, {
			model: e.model || LAYA_DEFAULT_MODEL,
			timeoutMs: str(e.timeoutMs || e.timeout || 3000)
		});
	} else if (cat === "nudenet") {
		const cb =
			e.circuitBreakerDuration !== undefined
				? Math.round(e.circuitBreakerDuration / 1000)
				: e.circuitBreaker || 15;
		Object.assign(v, {
			threshold: str(e.threshold !== undefined ? e.threshold : 0.8),
			circuitBreakerSeconds: str(cb),
			debug: !!e.debug,
			detectAll: !!e.detectAll
		});
	}
	return v;
}

const num = (v) => {
	const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
	return Number.isFinite(n) ? n : NaN;
};

/**
 * Formulário → provedor. Parte do provedor existente (campos que a tela não edita, como
 * temperature, top_k, width/steps do SD WebUI e videoFps do NudeNet, continuam lá) e aplica o
 * que o formulário tem. Número vazio ou inválido não é gravado (e sai, se existia), como antes.
 * @param {string} cat
 * @param {Object} values - do form() do kit (checkbox → boolean)
 * @param {Object|null} existing
 */
export function buildProvider(cat, values, existing) {
	const p = existing ? clone(existing) : {};
	const v = values || {};
	p.name = str(v.name).trim();
	p.url = str(v.url).trim();
	const key = str(v.apiKey).trim();
	if (key || "apiKey" in p) p.apiKey = key;
	p.enabled = !!v.enabled;
	const setNum = (field, n, ok) => {
		if (ok(n)) p[field] = n;
		else delete p[field];
	};
	if (cat === "llm") {
		p.type = v.type || "ollama";
		p.model = str(v.model).trim();
		setNum("timeout_multiplier", num(v.timeout_multiplier), (n) => !Number.isNaN(n));
		p.textOnly = !!v.textOnly;
		p.ignoreVideo = !!v.ignoreVideo;
		p.toolCalling = !!v.toolCalling;
		setNum("contextLength", parseInt(str(v.contextLength), 10), (n) => n > 0);
		setNum("maxTokens", parseInt(str(v.maxTokens), 10), (n) => n > 0);
	} else if (cat === "laya") {
		p.model = str(v.model).trim() || LAYA_DEFAULT_MODEL;
		setNum("timeoutMs", parseInt(str(v.timeoutMs), 10), (n) => n > 0);
	} else if (cat === "nudenet") {
		const cb = num(v.circuitBreakerSeconds);
		if (cb > 0) p.circuitBreakerDuration = cb * 1000;
		const th = num(v.threshold);
		if (!Number.isNaN(th)) p.threshold = th;
		p.debug = !!v.debug;
		p.detectAll = !!v.detectAll;
	}
	return p;
}

/** Erro de formulário em pt-BR, ou null. */
export function validateProvider(cat, p) {
	if (!p.name) return "Dê um nome ao provedor.";
	if (!p.url) return "Informe a URL do provedor.";
	if (cat === "nudenet" && p.threshold !== undefined && (p.threshold < 0 || p.threshold > 1))
		return "O limiar do NudeNet vai de 0 a 1.";
	return null;
}

/* ── Fila e uso ──────────────────────────────────────────────────── */

/** Fila do LLM por prioridade, a maior primeiro. */
export function queueRows(queues) {
	if (!queues || typeof queues !== "object") return [];
	return Object.keys(queues)
		.sort((a, b) => Number(b) - Number(a))
		.map((p) => {
			const q = queues[p] || {};
			return {
				priority: p,
				pending: q.pending || 0,
				processing: q.processing || 0,
				fulfilled: q.fulfilled || 0,
				failed: q.failed || 0
			};
		});
}

/** Falhas sobre o total de tentativas (atendidas + falhas), em %, como a tela antiga. */
export function failPercent(s) {
	const ok = (s && s.total_requests) || 0;
	const bad = (s && s.total_failures) || 0;
	return ok + bad > 0 ? (bad / (ok + bad)) * 100 : 0;
}

/** Linhas provedor × tipo, com vídeo somado a texto. */
export function providerTypeRows(stats) {
	const out = [];
	for (const [provider, pData] of Object.entries((stats && stats.by_provider) || {})) {
		const merged = {};
		for (const [type, t] of Object.entries((pData && pData.by_type) || {})) {
			const k = type === "video" ? "text" : type;
			const m = (merged[k] ||= {
				requests: 0,
				failures: 0,
				input_tokens: 0,
				output_tokens: 0,
				duration_sec: 0
			});
			m.requests += t.requests || 0;
			m.failures += t.failures || 0;
			m.input_tokens += t.input_tokens || 0;
			m.output_tokens += t.output_tokens || 0;
			m.duration_sec += t.duration_sec || 0;
		}
		for (const [type, m] of Object.entries(merged)) out.push({ provider, type, ...m });
	}
	return out;
}

const priceOf = (m) => {
	if (m.price !== undefined) return m.price;
	if (m.input !== undefined) return (m.input + m.output) / 2;
	if (m.price_per_minute !== undefined) return m.price_per_minute;
	if (m.price_per_1m_chars !== undefined) return m.price_per_1m_chars;
	return 0;
};

/** Modelos do simulador por tipo, do mais barato para o mais caro. */
export function costModels(costData, type) {
	const list = (costData && Array.isArray(costData[type]) && costData[type]) || [];
	return [...list].sort((a, b) => priceOf(a) - priceOf(b));
}

/** Custo estimado (USD) de uma linha provedor × tipo com o modelo escolhido. */
export function rowCost(type, t, model) {
	if (!model || !t) return 0;
	if (type === "text") {
		return (
			(t.input_tokens / 1e6) * (model.input || 0) + (t.output_tokens / 1e6) * (model.output || 0)
		);
	}
	if (type === "image") {
		if (model.price !== undefined) return t.requests * model.price;
		return ((t.input_tokens + t.output_tokens) / 1e6) * 1.0;
	}
	if (type === "stt") {
		if (model.price_per_minute) {
			return ((t.duration_sec || t.requests * 10) / 60) * model.price_per_minute;
		}
		if (model.price_per_1m_chars) return (t.input_tokens / 1e6) * model.price_per_1m_chars;
		return 0;
	}
	if (type === "tts") {
		if (model.price_per_1m_chars) return (t.output_tokens / 1e6) * model.price_per_1m_chars;
		if (model.price !== undefined) return t.requests * model.price;
	}
	return 0;
}

/** Períodos da aba Uso (os da tela antiga e o 24 h do painel). ms 0 = todo o período. */
export const USO_PERIODS = [
	{ id: "1h", label: "1 h", ms: 3600000 },
	{ id: "24h", label: "24 h", ms: 86400000 },
	{ id: "7d", label: "7 d", ms: 604800000 },
	{ id: "15d", label: "15 d", ms: 1296000000 },
	{ id: "30d", label: "30 d", ms: 2592000000 },
	{ id: "tudo", label: "Tudo", ms: 0 }
];
