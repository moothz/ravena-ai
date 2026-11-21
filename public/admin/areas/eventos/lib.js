/*
 * Funções puras da área Eventos (sem DOM, sem fetch). Testadas no Node em
 * src/testing/test_admin_eventos.js. As regras espelham src/services/ScheduledEventService.js.
 */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Horário de Brasília é UTC-03:00 fixo (sem horário de verão desde 2019), como a tela antiga. */
const BRT_OFFSET_MS = 3 * HOUR;

export const STATUS_LABELS = {
	ativo: "em andamento",
	proximo: "próximo",
	normal: "programado",
	passado: "encerrado"
};

/** Filtro de status (os mesmos valores do serviço e da tela antiga). */
export const STATUS_FILTERS = [
	{ id: "todos", label: "Todos" },
	{ id: "ativo", label: "Agora" },
	{ id: "proximo", label: "Próximo" },
	{ id: "normal", label: "Programado" },
	{ id: "passado", label: "Encerrado" }
];

const isNum = (n) => typeof n === "number" && Number.isFinite(n);

/**
 * Classifica como o serviço (classifyEvents): ativo, passado, proximo (os de menor início
 * futuro) e normal. Recalculado no cliente para o tempo andar entre uma leitura e outra.
 * @param {Array<{id:number,startTime:number,endTime:number}>} events
 * @param {number} now
 */
export function classify(events, now) {
	const sorted = [...(events || [])].sort((a, b) => a.startTime - b.startTime || a.id - b.id);
	const future = sorted.filter((e) => e.startTime > now).map((e) => e.startTime);
	const next = future.length ? Math.min(...future) : null;
	return sorted.map((e) => {
		let status = "normal";
		if (e.endTime <= now) status = "passado";
		else if (e.startTime <= now) status = "ativo";
		else if (next !== null && e.startTime === next) status = "proximo";
		return { ...e, status };
	});
}

/**
 * Agrupa para a lista: Agora (ativo), Programados (proximo + normal, do mais perto ao mais
 * longe) e Encerrados (do mais recente ao mais antigo).
 */
export function groupEvents(classified) {
	const agora = classified
		.filter((e) => e.status === "ativo")
		.sort((a, b) => a.endTime - b.endTime);
	const programados = classified
		.filter((e) => e.status === "proximo" || e.status === "normal")
		.sort((a, b) => a.startTime - b.startTime || a.id - b.id);
	const encerrados = classified
		.filter((e) => e.status === "passado")
		.sort((a, b) => b.endTime - a.endTime || b.id - a.id);
	return { agora, programados, encerrados };
}

/** Busca por nome (contém, sem diferenciar maiúsculas/acentos) e filtro de status. */
export function filterEvents(events, { q = "", status = "todos" } = {}) {
	const norm = (s) =>
		String(s || "")
			.normalize("NFD")
			.replace(/[̀-ͯ]/g, "")
			.toLowerCase();
	const query = norm(q.trim());
	return events.filter(
		(e) =>
			(status === "todos" || !status || e.status === status) &&
			(!query || norm(e.name).includes(query))
	);
}

/** "5 dias", "1 dia", "3 h", "12 min" (sempre pelo menos 1 min). */
export function spanText(ms) {
	const abs = Math.abs(ms);
	if (abs < HOUR) return `${Math.max(1, Math.round(abs / MIN))} min`;
	if (abs < DAY) return `${Math.round(abs / HOUR)} h`;
	const d = Math.round(abs / DAY);
	return `${d} ${d === 1 ? "dia" : "dias"}`;
}

/** Frase de tempo do cartão: "termina em 5 dias", "começa em 3 h", "terminou há 2 dias". */
export function whenText(e, now) {
	if (e.status === "ativo") return `termina em ${spanText(e.endTime - now)}`;
	if (e.status === "passado") return `terminou há ${spanText(now - e.endTime)}`;
	return `começa em ${spanText(e.startTime - now)}`;
}

/** Andamento de 0 a 100 de um evento em curso (null fora dele). */
export function progressPct(e, now) {
	if (!isNum(e.startTime) || !isNum(e.endTime) || e.endTime <= e.startTime) return null;
	if (now < e.startTime || now >= e.endTime) return null;
	return Math.min(
		100,
		Math.max(0, Math.round(((now - e.startTime) / (e.endTime - e.startTime)) * 100))
	);
}

/** Duração em pt-BR igual ao serviço (formatDurationPtBr): "1 dia e 6 horas", "45 minutos". */
export function durationText(ms) {
	const total = Math.max(1, Math.round(Math.max(MIN, ms) / MIN));
	const days = Math.floor(total / (24 * 60));
	const hours = Math.floor((total % (24 * 60)) / 60);
	const minutes = total % 60;
	const parts = [];
	if (days > 0) parts.push(`${days} ${days === 1 ? "dia" : "dias"}`);
	if (hours > 0) parts.push(`${hours} ${hours === 1 ? "hora" : "horas"}`);
	if (parts.length === 0 || (days === 0 && minutes > 0) || (days > 0 && hours === 0 && minutes > 0))
		parts.push(`${minutes} ${minutes === 1 ? "minuto" : "minutos"}`);
	if (parts.length === 1) return parts[0];
	if (parts.length === 2) return `${parts[0]} e ${parts[1]}`;
	return `${parts[0]}, ${parts[1]} e ${parts[2]}`;
}

/** epoch ms → valor de <input type="datetime-local"> no horário de Brasília ("2026-11-28T18:00"). */
export function toBrtLocal(ts) {
	if (!isNum(ts)) return "";
	return new Date(ts - BRT_OFFSET_MS).toISOString().slice(0, 16);
}

/** valor de datetime-local (Brasília) → epoch ms (NaN se inválido). */
export function fromBrtLocal(value) {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return NaN;
	const t = Date.parse(`${value}:00-03:00`);
	return Number.isFinite(t) ? t : NaN;
}

/**
 * Valida a seleção de bônus como a tela antiga: só itens marcados, valor inteiro dentro de
 * min..max. Lança Error com mensagem em pt-BR.
 * @param {Array<{id:string,label:string,min:number,max:number,unit:string}>} catalog
 * @param {Array<{id:string,checked:boolean,value:string}>} entries
 * @returns {Object<string, number>}
 */
export function collectSelection(catalog, entries) {
	const out = {};
	for (const it of entries) {
		if (!it.checked) continue;
		const spec = catalog.find((c) => c.id === it.id);
		const raw = String(it.value ?? "").trim();
		const label = spec ? spec.label : it.id;
		if (!/^\d+$/.test(raw)) throw new Error(`Informe um número inteiro válido para "${label}".`);
		const n = parseInt(raw, 10);
		if (spec && (n < spec.min || n > spec.max))
			throw new Error(
				`"${spec.label}" aceita valores entre ${spec.min} e ${spec.max} (${spec.unit}).`
			);
		out[it.id] = n;
	}
	return out;
}

/** Validação do formulário antes de enviar (o servidor valida de novo). Lança Error. */
export function checkForm({ name, startTime, endTime }) {
	if (!String(name || "").trim()) throw new Error("Informe o nome do evento.");
	if (String(name).trim().length > 120)
		throw new Error("O nome do evento deve ter no máximo 120 caracteres.");
	if (!startTime || !endTime) throw new Error("Preencha a data e hora de início e de fim.");
	const s = fromBrtLocal(startTime);
	const e = fromBrtLocal(endTime);
	if (!Number.isFinite(s) || !Number.isFinite(e)) throw new Error("Data e hora inválidas.");
	if (e <= s) throw new Error("O fim precisa ser depois do início.");
}

/** Corpo do PUT a partir de um evento salvo, com campos trocados (Encerrar/Começar agora). */
export function eventBody(ev, patch = {}) {
	return {
		name: ev.name,
		startTime: ev.startTime,
		endTime: ev.endTime,
		startGrants: ev.startGrants || {},
		ongoingBuffs: ev.ongoingBuffs || {},
		message: ev.message || "",
		...patch
	};
}

/** Horário padrão de um evento novo: começa em 1 h (minuto cheio) e dura `durationMs` (24 h). */
export function defaultTimes(now, durationMs = DAY) {
	const start = Math.ceil((now + HOUR) / MIN) * MIN;
	return { start, end: start + Math.max(MIN, durationMs) };
}

/** Texto de um bônus: "🪙 Zinthos para todos (Waifuletes): +500 Zinthos" / "+25%". */
export function bonusText(item) {
	const v = Number(item.value).toLocaleString("pt-BR");
	const amount = item.unit === "%" ? `+${v}%` : `+${v} ${item.unit}`;
	return `${item.emoji ? `${item.emoji} ` : ""}${item.label} (${item.gameLabel}): ${amount}`;
}
