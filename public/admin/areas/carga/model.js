/*
 * Regras da área "Carga da economia", sem DOM (testadas no Node em
 * src/testing/test_admin_carga.js). Mesmas regras do cartão "Painel da economia" do
 * /banco/admin: situação geral, estado por fonte, texto do agendamento, opções de intervalo e
 * corpo das escritas.
 */

/** Nomes das fontes da carga (as principais e as derivadas). */
export const SOURCE_NAMES = {
	zinthos: "Zinthos",
	petalitas: "Petalitas",
	runas: "Runas",
	"zinthos.players": "Zinthos por jogador",
	"petalitas.players": "Petalitas por jogador",
	"runas.players": "Runas por jogador",
	"zinthos.received": "Zinthos: quem recebe",
	"petalitas.received": "Petalitas: quem recebe",
	"runas.received": "Runas: quem recebe",
	atividade: "Atividade (comandos)"
};

export const sourceName = (src) => SOURCE_NAMES[src] || src;

export const CURRENCY_NAMES = { zinthos: "Zinthos", petalitas: "Petalitas", runas: "Runas" };

/** Opções de moeda do "Registrar mudança" (valor = o que a rota espera). */
export const CURRENCY_OPTIONS = [
	{ value: "todas", label: "Todas as moedas" },
	{ value: "zinthos", label: "Zinthos" },
	{ value: "petalitas", label: "Petalitas" },
	{ value: "runas", label: "Runas" }
];

/** Intervalos aceitos pela rota (o status também manda `presets`). */
export const DEFAULT_PRESETS = [1, 2, 3, 6, 12, 24];

const HOUR = 3600000;
const nf1 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const dayFmtter = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo" });

/** A carga está de pé (ligada no .env e com o worker rodando)? */
export const isAvailable = (st) => !!(st && st.enabled && st.worker);

/** Atraso tolerado: intervalo + 2 h (o mesmo do alerta de carga atrasada). */
export const lagLimit = (sch) => ((sch && sch.everyHours) || 1) * HOUR + 2 * HOUR;

/** Atraso em texto: "1,5 h" abaixo de 48 h, senão "2,3 dias"; sem dado → "—". */
export function fmtLag(ms) {
	if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
	const hours = ms / HOUR;
	return hours < 48 ? `${nf1.format(hours)} h` : `${nf1.format(hours / 24)} dias`;
}

/** Dia (dd/mm/aaaa, horário de Brasília). */
export function dayFmt(ts) {
	const n = Number(ts);
	if (!ts || !Number.isFinite(n)) return "—";
	return dayFmtter.format(new Date(n));
}

/**
 * Situação geral, na mesma ordem do econHealth do kit (menu e Visão geral): com erro >
 * atrasada > pausada > sem carga ainda > rodando agora / em dia. Pausar é escolha de quem
 * administra e já aparece no agendamento; não pode esconder uma falha ou um atraso, que são o
 * que pede ação. Sem a carga de pé: desligada ou parada, com o motivo.
 * lamp: estado do kit (ok | attention | down | off | busy).
 * @param {Object|null} st - GET /api/economy/admin/status
 * @returns {{ lamp: string, word: string, reason?: string, available: boolean }}
 */
export function overall(st) {
	if (!st) return { lamp: "off", word: "sem dado", available: false };
	if (!st.enabled) {
		return {
			lamp: "off",
			word: "desligada",
			reason: "Carga desligada: ECONOMY_ANALYTICS_ENABLED diferente de true no .env.",
			available: false
		};
	}
	if (!st.worker) {
		return {
			lamp: "off",
			word: "carga parada",
			reason: "A carga não está rodando neste processo (ex.: DISABLE_ACTIVITY=true).",
			available: false
		};
	}
	const sch = st.schedule || {};
	const now = st.now || Date.now();
	const main = (st.loads || []).filter((l) => (st.sources || []).includes(l.source));
	const worstLag = main.reduce((m, l) => Math.max(m, l.okTo ? now - l.okTo : Infinity), 0);
	if (main.some((l) => !l.lastOk)) return { lamp: "down", word: "com erro", available: true };
	if (main.length && worstLag > lagLimit(sch))
		return { lamp: "attention", word: "atrasada", available: true };
	if (sch.paused) return { lamp: "off", word: "pausada", available: true };
	if (!main.length) {
		return {
			lamp: st.running ? "busy" : "off",
			word: st.running ? "rodando agora" : "sem carga ainda",
			available: true
		};
	}
	if (st.running) return { lamp: "busy", word: "rodando agora", available: true };
	return { lamp: "ok", word: "em dia", available: true };
}

/**
 * Linhas da tabela por fonte (sem as fontes *.reload, como no cartão antigo).
 * state: "error" (última tentativa falhou), "late" (principal com atraso acima do limite) ou "ok".
 * lag só para as fontes principais (as de `st.sources`).
 */
export function sourceRows(st) {
	if (!isAvailable(st)) return [];
	const now = st.now || Date.now();
	const limit = lagLimit(st.schedule);
	const main = st.sources || [];
	return (st.loads || [])
		.filter((l) => l && typeof l.source === "string" && !l.source.endsWith(".reload"))
		.map((l) => {
			const isMain = main.includes(l.source);
			const lag = isMain && l.okTo ? now - l.okTo : null;
			const late = isMain && (!l.okTo || lag > limit);
			return {
				source: l.source,
				name: sourceName(l.source),
				okTo: l.okTo || null,
				lastTs: l.lastTs || null,
				lastOk: !!l.lastOk,
				lastError: l.lastOk ? null : l.lastError || "erro",
				isMain,
				lag,
				state: !l.lastOk ? "error" : late ? "late" : "ok"
			};
		});
}

/** Selo do agendamento: "pausada" ou "a cada N h". */
export const scheduleBadge = (sch) =>
	sch && sch.paused ? "pausada" : `a cada ${(sch && sch.everyHours) || 1} h`;

/** De onde vem o intervalo em vigor. */
export function scheduleFrom(sch) {
	if (!sch) return "padrão";
	if (sch.from === "admin") return "este painel";
	if (sch.from === "env") return "ECONOMY_ANALYTICS_EVERY_HOURS";
	return "padrão";
}

/**
 * Detalhe do agendamento, como no cartão antigo:
 * "cron 5 * * * * (minuto 5) · definido por este painel em 21/11/2026, 14:05."
 * @param {Object} sch
 * @param {(ts: number) => string} dateFmt
 */
export function scheduleDetail(sch, dateFmt) {
	if (!sch) return "";
	const when = sch.updatedAt ? ` em ${dateFmt(sch.updatedAt)}` : "";
	return `cron ${sch.cron || "—"} (minuto 5) · definido por ${scheduleFrom(sch)}${when}.`;
}

/**
 * Opções do intervalo: a 1ª é "padrão do .env (N h)" (sem escolha do admin), depois os presets.
 * selected: "" quando o intervalo não veio deste painel; senão o número em texto.
 */
export function intervalOptions(st) {
	const sch = (st && st.schedule) || {};
	const presets =
		st && Array.isArray(st.presets) && st.presets.length ? st.presets : DEFAULT_PRESETS;
	const fromAdmin = sch.from === "admin";
	return {
		options: [
			{ value: "", label: `padrão do .env (${sch.defaultEveryHours || 1} h)` },
			...presets.map((hh) => ({ value: String(hh), label: `${hh} h` }))
		],
		selected: fromAdmin && sch.everyHours ? String(sch.everyHours) : ""
	};
}

/** Corpo do POST /schedule para o valor do seletor ("" = padrão do .env). */
export const scheduleBody = (value) =>
	value === "" || value === null || value === undefined
		? { useDefault: true }
		: { everyHours: Number(value) };

/**
 * Valor de um <input type="datetime-local"> ("2026-11-21T14:05"), lido como horário de Brasília
 * (UTC−3, sem horário de verão desde 2019), em ISO 8601. Vazio → null (a rota usa "agora").
 * Formato inválido → undefined.
 */
export function brasiliaToIso(value) {
	if (value === null || value === undefined || String(value).trim() === "") return null;
	const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value).trim());
	if (!m) return undefined;
	const ts = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || "00"}-03:00`);
	return Number.isFinite(ts) ? new Date(ts).toISOString() : undefined;
}

/**
 * Corpo do POST /annotations a partir dos valores do formulário.
 * @throws {Error} hora em formato inválido
 */
export function annotationBody(values) {
	const hora = brasiliaToIso(values && values.hora);
	if (hora === undefined) throw new Error("Hora inválida: use dia e hora completos.");
	return {
		texto: String((values && values.texto) || "").trim(),
		moeda: (values && values.moeda) || "todas",
		hora
	};
}

/** Nome da moeda de uma anotação (null = todas). */
export const currencyName = (c) => CURRENCY_NAMES[c] || "Todas";

/**
 * Resumo de uma rodada que acabou de terminar (para o aviso): fontes principais que falharam.
 * @returns {{ ok: boolean, text: string }}
 */
export function runOutcome(st) {
	const failed = sourceRows(st).filter((r) => r.isMain && r.state === "error");
	if (!failed.length) return { ok: true, text: "Carga concluída." };
	return {
		ok: false,
		text: `Carga concluída; ${failed.map((r) => `${r.name} falhou (${r.lastError})`).join(", ")}.`
	};
}
