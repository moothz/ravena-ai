// src/functions/Copa2026.js
const axios = require("axios");
const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");

const logger = new Logger("copa2026");

// URL da API — configurada via .env
const API_URL = process.env.WDC2026_API_URL;

const Database = require("../utils/Database");
const database = Database.getInstance();

// Inicializa o banco de dados da Copa Seguir
database.getSQLiteDb(
	"copa_seguir",
	`
	CREATE TABLE IF NOT EXISTS copa_seguindo (
		chat_id       TEXT NOT NULL,
		team_id       TEXT NOT NULL,
		team_name_en  TEXT NOT NULL,
		team_name_pt  TEXT NOT NULL,
		fifa_code     TEXT NOT NULL,
		created_at    INTEGER NOT NULL,
		PRIMARY KEY (chat_id, team_id)
	);
	CREATE INDEX IF NOT EXISTS idx_copa_seguindo_team ON copa_seguindo(team_id);
`
);

// ─── Helpers ─────────────────────────────────────────────────

/** Mapa de códigos FIFA → bandeiras (emoji) */
const FLAGS = {
	MEX: "🇲🇽",
	RSA: "🇿🇦",
	KOR: "🇰🇷",
	CZE: "🇨🇿",
	CAN: "🇨🇦",
	BIH: "🇧🇦",
	QAT: "🇶🇦",
	SUI: "🇨🇭",
	BRA: "🇧🇷",
	MAR: "🇲🇦",
	HAI: "🇭🇹",
	SCO: "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
	USA: "🇺🇸",
	PAR: "🇵🇾",
	AUS: "🇦🇺",
	TUR: "🇹🇷",
	GER: "🇩🇪",
	CUW: "🇨🇼",
	CIV: "🇨🇮",
	ECU: "🇪🇨",
	NED: "🇳🇱",
	JPN: "🇯🇵",
	SWE: "🇸🇪",
	TUN: "🇹🇳",
	BEL: "🇧🇪",
	EGY: "🇪🇬",
	IRN: "🇮🇷",
	NZL: "🇳🇿",
	ESP: "🇪🇸",
	CPV: "🇨🇻",
	KSA: "🇸🇦",
	URU: "🇺🇾",
	FRA: "🇫🇷",
	SEN: "🇸🇳",
	IRQ: "🇮🇶",
	NOR: "🇳🇴",
	ARG: "🇦🇷",
	ALG: "🇩🇿",
	AUT: "🇦🇹",
	JOR: "🇯🇴",
	POR: "🇵🇹",
	COD: "🇨🇩",
	UZB: "🇺🇿",
	COL: "🇨🇴",
	ENG: "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
	CRO: "🇭🇷",
	GHA: "🇬🇭",
	PAN: "🇵🇦"
};

function flag(fifaCode) {
	return FLAGS[fifaCode] || "🏳️";
}

/** Mapa de códigos FIFA → nome em português */
const NAMES_PT = {
	MEX: "México",
	RSA: "África do Sul",
	KOR: "Coreia do Sul",
	CZE: "Rep. Tcheca",
	CAN: "Canadá",
	BIH: "Bósnia e Herzegovina",
	QAT: "Catar",
	SUI: "Suíça",
	BRA: "Brasil",
	MAR: "Marrocos",
	HAI: "Haiti",
	SCO: "Escócia",
	USA: "Estados Unidos",
	PAR: "Paraguai",
	AUS: "Austrália",
	TUR: "Turquia",
	GER: "Alemanha",
	CUW: "Curaçao",
	CIV: "Costa do Marfim",
	ECU: "Equador",
	NED: "Holanda",
	JPN: "Japão",
	SWE: "Suécia",
	TUN: "Tunísia",
	BEL: "Bélgica",
	EGY: "Egito",
	IRN: "Irã",
	NZL: "Nova Zelândia",
	ESP: "Espanha",
	CPV: "Cabo Verde",
	KSA: "Arábia Saudita",
	URU: "Uruguai",
	FRA: "França",
	SEN: "Senegal",
	IRQ: "Iraque",
	NOR: "Noruega",
	ARG: "Argentina",
	ALG: "Argélia",
	AUT: "Áustria",
	JOR: "Jordânia",
	POR: "Portugal",
	COD: "Rep. Dem. do Congo",
	UZB: "Uzbequistão",
	COL: "Colômbia",
	ENG: "Inglaterra",
	CRO: "Croácia",
	GHA: "Gana",
	PAN: "Panamá"
};

/** Retorna o nome PT-BR de um objeto time (fallback: name_en) */
function namePt(team) {
	if (!team) return "?";
	return NAMES_PT[team.fifa_code] || team.name_en || "?";
}

/**
 * Mapa alias (normalizado) → nome exato na API.
 * Chaves: lowercase sem acentos, sem espaços extras.
 * Cobre nomes em PT-BR, apelidos, variações e nome em inglês.
 */
const TEAM_ALIASES = {
	// Algeria
	algeria: "Algeria",
	argelia: "Algeria",
	alg: "Algeria",

	// Argentina
	argentina: "Argentina",
	arg: "Argentina",
	albiceleste: "Argentina",

	// Australia
	australia: "Australia",
	aus: "Australia",
	socceroos: "Australia",

	// Austria
	austria: "Austria",
	aut: "Austria",

	// Belgium
	belgium: "Belgium",
	belgica: "Belgium",
	bel: "Belgium",
	"diabos vermelhos": "Belgium",

	// Bosnia and Herzegovina
	"bosnia and herzegovina": "Bosnia and Herzegovina",
	bosnia: "Bosnia and Herzegovina",
	"bosnia e herzegovina": "Bosnia and Herzegovina",
	bih: "Bosnia and Herzegovina",

	// Brazil
	brazil: "Brazil",
	brasil: "Brazil",
	bra: "Brazil",
	selecao: "Brazil",
	"selecao brasileira": "Brazil",
	canarinho: "Brazil",
	"verde amarela": "Brazil",
	"verde e amarela": "Brazil",

	// Canada
	canada: "Canada",
	can: "Canada",

	// Cape Verde
	"cape verde": "Cape Verde",
	"cabo verde": "Cape Verde",
	cpv: "Cape Verde",

	// Colombia
	colombia: "Colombia",
	col: "Colombia",
	cafeteros: "Colombia",

	// Croatia
	croatia: "Croatia",
	croacia: "Croatia",
	cro: "Croatia",
	croata: "Croatia",

	// Curacao
	curacao: "Curaçao",
	curacau: "Curaçao",
	curaçao: "Curaçao",
	cuw: "Curaçao",

	// Czech Republic
	"czech republic": "Czech Republic",
	"republica tcheca": "Czech Republic",
	tcheca: "Czech Republic",
	tcheco: "Czech Republic",
	cze: "Czech Republic",

	// Democratic Republic of the Congo
	"democratic republic of the congo": "Democratic Republic of the Congo",
	"republica democratica do congo": "Democratic Republic of the Congo",
	"rd congo": "Democratic Republic of the Congo",
	rdc: "Democratic Republic of the Congo",
	congo: "Democratic Republic of the Congo",
	cod: "Democratic Republic of the Congo",

	// Ecuador
	ecuador: "Ecuador",
	equador: "Ecuador",
	ecu: "Ecuador",

	// Egypt
	egypt: "Egypt",
	egito: "Egypt",
	egy: "Egypt",
	faraos: "Egypt",

	// England
	england: "England",
	inglaterra: "England",
	eng: "England",
	"tres leoes": "England",

	// France
	france: "France",
	franca: "France",
	fra: "France",
	"les bleus": "France",
	bleus: "France",

	// Germany
	germany: "Germany",
	alemanha: "Germany",
	ger: "Germany",
	mannschaft: "Germany",

	// Ghana
	ghana: "Ghana",
	gana: "Ghana",
	gha: "Ghana",

	// Haiti
	haiti: "Haiti",
	hai: "Haiti",

	// Iran
	iran: "Iran",
	ira: "Iran",
	irn: "Iran",

	// Iraq
	iraq: "Iraq",
	iraque: "Iraq",
	irq: "Iraq",

	// Ivory Coast
	"ivory coast": "Ivory Coast",
	"costa do marfim": "Ivory Coast",
	marfim: "Ivory Coast",
	"cote d'ivoire": "Ivory Coast",
	"cote divoire": "Ivory Coast",
	civ: "Ivory Coast",

	// Japan
	japan: "Japan",
	japao: "Japan",
	jpn: "Japan",
	"samurai azul": "Japan",

	// Jordan
	jordan: "Jordan",
	jordania: "Jordan",
	jor: "Jordan",

	// Mexico
	mexico: "Mexico",
	mex: "Mexico",
	"el tri": "Mexico",
	tri: "Mexico",

	// Morocco
	morocco: "Morocco",
	marrocos: "Morocco",
	mar: "Morocco",
	"leoes do atlas": "Morocco",

	// Netherlands
	netherlands: "Netherlands",
	holanda: "Netherlands",
	"paises baixos": "Netherlands",
	ned: "Netherlands",
	"laranja mecanica": "Netherlands",

	// New Zealand
	"new zealand": "New Zealand",
	"nova zelandia": "New Zealand",
	nzl: "New Zealand",
	"all whites": "New Zealand",

	// Norway
	norway: "Norway",
	noruega: "Norway",
	nor: "Norway",

	// Panama
	panama: "Panama",
	pan: "Panama",

	// Paraguay
	paraguay: "Paraguay",
	paraguai: "Paraguay",
	par: "Paraguay",

	// Portugal
	portugal: "Portugal",
	por: "Portugal",
	"selecao das quinas": "Portugal",

	// Qatar
	qatar: "Qatar",
	catar: "Qatar",
	qat: "Qatar",

	// Saudi Arabia
	"saudi arabia": "Saudi Arabia",
	"arabia saudita": "Saudi Arabia",
	ksa: "Saudi Arabia",

	// Scotland
	scotland: "Scotland",
	escocia: "Scotland",
	sco: "Scotland",

	// Senegal
	senegal: "Senegal",
	sen: "Senegal",
	"leoes de teranga": "Senegal",

	// South Africa
	"south africa": "South Africa",
	"africa do sul": "South Africa",
	rsa: "South Africa",
	"bafana bafana": "South Africa",

	// South Korea
	"south korea": "South Korea",
	"coreia do sul": "South Korea",
	coreia: "South Korea",
	korea: "South Korea",
	kor: "South Korea",
	"taeguk warriors": "South Korea",

	// Spain
	spain: "Spain",
	espanha: "Spain",
	esp: "Spain",
	"la furia roja": "Spain",
	"furia roja": "Spain",
	furia: "Spain",

	// Sweden
	sweden: "Sweden",
	suecia: "Sweden",
	swe: "Sweden",

	// Switzerland
	switzerland: "Switzerland",
	suica: "Switzerland",
	sui: "Switzerland",

	// Tunisia
	tunisia: "Tunisia",
	tunísia: "Tunisia",
	tun: "Tunisia",

	// Turkey
	turkey: "Turkey",
	turquia: "Turkey",
	tur: "Turkey",

	// United States
	"united states": "United States",
	"estados unidos": "United States",
	eua: "United States",
	usa: "United States",
	estad: "United States",

	// Uruguay
	uruguay: "Uruguay",
	uruguai: "Uruguay",
	uru: "Uruguay",
	celeste: "Uruguay",

	// Uzbekistan
	uzbekistan: "Uzbekistan",
	uzbequistao: "Uzbekistan",
	uzb: "Uzbekistan"
};

/**
 * Remove acentos e normaliza string para comparação.
 * Ex: "Espàñha" → "espanha"
 */
function normalize(str) {
	return str
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.trim();
}

/**
 * Tenta resolver o input do usuário para o nome exato na API.
 * Prioridade: alias exato → alias parcial → titleCase do original.
 */
function resolveTeamName(input) {
	const key = normalize(input);
	// 1. Match exato no mapa
	if (TEAM_ALIASES[key]) return TEAM_ALIASES[key];
	// 2. Match parcial (começa com ou contém)
	for (const [alias, name] of Object.entries(TEAM_ALIASES)) {
		if (alias.startsWith(key) || key.startsWith(alias)) return name;
	}
	// 3. Fallback: capitaliza cada palavra e manda para API tentar
	return input
		.split(" ")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
		.join(" ");
}

/** Verifica se o jogo está finalizado (API retorna "FALSE"/"TRUE" em maiúsculas) */
function isFinished(game) {
	const f = game.finished;
	if (typeof f === "boolean") return f;
	return String(f).toLowerCase() === "true";
}

/** Busca times da API e monta mapa id → time com flag emoji e nome PT */
async function fetchTeamsMap() {
	const res = await axios.get(`${API_URL}/get/teams`, { timeout: 8000 });
	const teams = res.data.teams || [];
	const map = {};
	for (const t of teams) map[t.id] = { ...t, flagEmoji: flag(t.fifa_code), namePt: namePt(t) };
	return map;
}

/** Busca todos os grupos */
async function fetchGroups() {
	const res = await axios.get(`${API_URL}/get/groups`, { timeout: 8000 });
	return res.data.groups || [];
}

/** Busca todos os jogos */
async function fetchGames() {
	const res = await axios.get(`${API_URL}/get/games`, { timeout: 8000 });
	return res.data.games || [];
}

/** Busca todos os estádios */
async function fetchStadiums() {
	const res = await axios.get(`${API_URL}/get/stadiums`, { timeout: 8000 });
	return res.data.stadiums || [];
}

/** Formata data local a partir de "MM/DD/YYYY HH:mm" (formato da API) */
function fmtDate(dateStr) {
	try {
		const d = parseGameDate(dateStr);
		if (d.getTime() > 8000000000000000) return dateStr || "TBD";
		return d.toLocaleDateString("pt-BR", {
			day: "numeric",
			month: "long",
			year: "numeric",
			timeZone: "America/Sao_Paulo"
		});
	} catch {
		return dateStr || "TBD";
	}
}

/** Formata data e hora local (ajustada) */
function fmtFullDate(dateStr) {
	try {
		const d = parseGameDate(dateStr);
		if (d.getTime() > 8000000000000000) return dateStr || "TBD";
		const date = d.toLocaleDateString("pt-BR", {
			day: "2-digit",
			month: "2-digit",
			year: "numeric",
			timeZone: "America/Sao_Paulo"
		});
		const time = d.toLocaleTimeString("pt-BR", {
			hour: "2-digit",
			minute: "2-digit",
			timeZone: "America/Sao_Paulo"
		});
		return `${date} ${time}h`;
	} catch {
		return dateStr || "TBD";
	}
}

/** Ordena standings por pts desc, depois saldo de gols desc */
function sortStandings(standings) {
	return [...standings].sort((a, b) => {
		const ptsDiff = (Number(b.pts) || 0) - (Number(a.pts) || 0);
		if (ptsDiff !== 0) return ptsDiff;
		const gdB = (Number(b.gf) || 0) - (Number(b.ga) || 0);
		const gdA = (Number(a.gf) || 0) - (Number(a.ga) || 0);
		return gdB - gdA;
	});
}

/**
 * Mapa de offsets de fuso horário (UTC) por Estádio.
 * Baseado nas sedes da Copa 2026 e seus respectivos fusos em Junho/Julho (DST).
 */
const STADIUM_UTC_OFFSETS = {
	1: "-06:00", // Mexico City (CST)
	2: "-06:00", // Guadalajara (CST)
	3: "-06:00", // Monterrey (CST)
	4: "-05:00", // Dallas (CDT)
	5: "-05:00", // Houston (CDT)
	6: "-05:00", // Kansas City (CDT)
	7: "-04:00", // Atlanta (EDT)
	8: "-04:00", // Miami (EDT)
	9: "-04:00", // Boston (EDT)
	10: "-04:00", // Philadelphia (EDT)
	11: "-04:00", // New York/NJ (EDT)
	12: "-04:00", // Toronto (EDT)
	13: "-07:00", // Vancouver (PDT)
	14: "-07:00", // Seattle (PDT)
	15: "-07:00", // San Francisco (PDT)
	16: "-07:00" // Los Angeles (PDT)
};

/**
 * Converte "MM/DD/YYYY HH:mm" (formato da API) → Date com ajuste de fuso por estádio.
 * Retorna Date muito distante se inválido.
 */
function parseGameDate(gmOrStr) {
	const raw = typeof gmOrStr === "string" ? gmOrStr : gmOrStr?.local_date || gmOrStr?.date || "";
	const stadiumId = gmOrStr?.stadium_id;

	const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
	if (m) {
		const offsetStr = STADIUM_UTC_OFFSETS[stadiumId] || "-06:00";
		const isoStr = `${m[3]}-${m[1]}-${m[2]}T${m[4]}:${m[5]}:00${offsetStr}`;
		const d = new Date(isoStr);
		if (!isNaN(d)) return d;
	}

	const d = new Date(raw);
	if (isNaN(d)) return new Date(8640000000000000);
	return d;
}

/** Formata um countdown de milissegundos em "Xd Yh Zm" */
function fmtCountdown(ms) {
	if (ms <= 0) return null;
	const totalMin = Math.floor(ms / 60000);
	const days = Math.floor(totalMin / 1440);
	const hours = Math.floor((totalMin % 1440) / 60);
	const mins = totalMin % 60;
	const parts = [];
	if (days > 0) parts.push(`${days} dia${days !== 1 ? "s" : ""}`);
	if (hours > 0) parts.push(`${hours}h`);
	parts.push(`${mins}min`);
	return parts.join(", ");
}

// ─── Comandos ─────────────────────────────────────────────────

/** !copa — menu principal */
async function copaMenu(bot, message, args, group) {
	const chatId = message.group ?? message.from;

	// Busca o primeiro jogo para montar countdown
	let countdownLine = "";
	try {
		const games = await fetchGames();
		const firstGame = games
			.filter((g) => g.local_date)
			.sort((a, b) => parseGameDate(a) - parseGameDate(b))[0];
		if (firstGame) {
			const kickoff = parseGameDate(firstGame);
			const countdown = fmtCountdown(kickoff - Date.now());
			if (countdown) {
				const kickoffStr = fmtDate(firstGame);
				countdownLine = `\n⏳ *Faltam ${countdown} para a Copa!*\n_(1º jogo: ${kickoffStr})_\n`;
			}
		}
	} catch {
		// countdown é opcional, não bloqueia o menu
	}

	const content =
		`⚽ *COPA DO MUNDO 2026*\n` +
		`__(EUA, México e Canadá)__\n` +
		countdownLine +
		`\n📋 *Comandos disponíveis:*\n\n` +
		`!copa-jogos — próximos jogos\n` +
		`!copa-jogo <id> — detalhes de uma partida\n` +
		`!copa-times — lista todos os 48 times\n` +
		`!copa-time <nome> — info de um time\n` +
		`!copa-grupos — tabela de todos os grupos\n` +
		`!copa-grupo <letra> — classificação de um grupo\n` +
		`!copa-estadios — lista os 16 estádios\n` +
		`!copa-seguir <nome> — receber notificações de um time 🔥\n\n` +
		`🏟️ *Total:* 48 times | 12 grupos | 104 partidas | 16 estádios`;

	return new ReturnMessage({
		chatId,
		content,
		options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
	});
}

/** !copa-times — lista times (todos ou por grupo) */
async function copaTimes(bot, message, args, group) {
	const chatId = message.group ?? message.from;
	try {
		const res = await axios.get(`${API_URL}/get/teams`, { timeout: 8000 });
		let teams = res.data.teams || [];

		const filterGroup = args.length > 0 ? args[0].toUpperCase() : null;
		if (filterGroup) {
			// Aceita tanto "!copa-times C" quanto "!copa-times Grupo C"
			const letter = filterGroup.replace(/^GRUPO\s*/i, "").trim();
			teams = teams.filter((t) => t.groups === letter);
			if (teams.length === 0) {
				return new ReturnMessage({
					chatId,
					content: `❌ Grupo "${filterGroup}" não encontrado. Use A-L.`,
					options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
				});
			}
		}

		let msg = filterGroup
			? `🏆 *Times do Grupo ${filterGroup}*\n\n`
			: `🌎 *48 Times da Copa 2026*\n\n`;

		// Agrupa por grupo se for listagem geral
		if (!filterGroup) {
			const groups = {};
			for (const t of teams) {
				const g = t.groups || "?";
				if (!groups[g]) groups[g] = [];
				groups[g].push(t);
			}
			const letters = Object.keys(groups).sort();
			for (const l of letters) {
				msg += `📌 *Grupo ${l}:*\n`;
				for (const t of groups[l]) {
					msg += `  ${flag(t.fifa_code)} ${NAMES_PT[t.fifa_code] || t.name_en}\n`;
				}
				msg += "\n";
			}
		} else {
			for (const t of teams) {
				msg += `${flag(t.fifa_code)} *${NAMES_PT[t.fifa_code] || t.name_en}* — ${t.fifa_code || "---"}\n`;
			}
		}

		return new ReturnMessage({
			chatId,
			content: msg,
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	} catch (error) {
		logger.error("Erro em copaTimes:", error);
		return new ReturnMessage({
			chatId,
			content: `❌ Erro ao buscar times: ${error.message}`,
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	}
}

/** !copa-time <nome> — info de um time */
async function copaTime(bot, message, args, group) {
	const chatId = message.group ?? message.from;
	try {
		if (args.length === 0) {
			return new ReturnMessage({
				chatId,
				content:
					"❌ Use: `!copa-time <nome>`\nEx: `!copa-time brasil`, `!copa-time argentina`, `!copa-time franca`",
				options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
			});
		}

		const rawInput = args.join(" ");
		const name = resolveTeamName(rawInput);
		const res = await axios.get(`${API_URL}/get/team/`, {
			params: { name },
			timeout: 8000
		});
		const team = res.data.team;

		if (!team) {
			// Monta lista de nomes conhecidos para ajudar o usuário
			const known = [...new Set(Object.values(TEAM_ALIASES))].sort().join(", ");
			return new ReturnMessage({
				chatId,
				content:
					`❌ Time "${rawInput}" não encontrado.\n\n` +
					`💡 Tente com o nome em português ou inglês. Times disponíveis:\n${known}`,
				options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
			});
		}

		const msg =
			`${flag(team.fifa_code)} *${namePt(team)}*\n` +
			`_${team.name_fa || ""}_\n\n` +
			`🏷️ Código FIFA: \`${team.fifa_code}\`\n` +
			`📌 Grupo: *${team.groups || "—"}*\n` +
			`🔢 ID: ${team.id}\n`;

		return new ReturnMessage({
			chatId,
			content: msg,
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	} catch (error) {
		logger.error("Erro em copaTime:", error);
		return new ReturnMessage({
			chatId,
			content: `❌ Erro ao buscar time: ${error.message}`,
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	}
}

/** !copa-grupos — tabela de todos os grupos */
async function copaGrupos(bot, message, args, group) {
	const chatId = message.group ?? message.from;
	try {
		const [groups, teamsMap] = await Promise.all([fetchGroups(), fetchTeamsMap()]);

		let msg = `📊 *CLASSIFICAÇÃO — TODOS OS GRUPOS*\n\n`;

		for (const g of groups) {
			msg += `*${g.name}*\n`;
			const standings = sortStandings(g.teams || []);
			let pos = 1;
			for (const s of standings) {
				const t = teamsMap[s.team_id] || {};
				const emoji = pos === 1 ? "🥇" : pos === 2 ? "🥈" : pos === 3 ? "🥉" : `${pos}.`;
				msg += `${emoji} ${t.flagEmoji || ""} ${t.namePt || s.team_id} `;
				msg += `— ${Number(s.pts) || 0}pts (${Number(s.w) || 0}V ${Number(s.d) || 0}E ${Number(s.l) || 0}D) `;
				msg += `⚽ ${Number(s.gf) || 0}:${Number(s.ga) || 0}\n`;
				pos++;
			}
			msg += "\n";
		}

		return new ReturnMessage({
			chatId,
			content: msg,
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	} catch (error) {
		logger.error("Erro em copaGrupos:", error);
		return new ReturnMessage({
			chatId,
			content: `❌ Erro ao buscar grupos: ${error.message}`,
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	}
}

/** !copa-grupo <letra> — classificação de um grupo específico */
async function copaGrupo(bot, message, args, group) {
	const chatId = message.group ?? message.from;
	try {
		if (args.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "❌ Use: `!copa-grupo <letra>`\nEx: `!copa-grupo C`",
				options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
			});
		}

		const letter = args[0].toUpperCase().replace(/^GRUPO\s*/i, "");
		const res = await axios.get(`${API_URL}/get/group/`, {
			params: { name: letter },
			timeout: 8000
		});
		const groupData = res.data.group || res.data.groups?.[0];

		if (!groupData) {
			return new ReturnMessage({
				chatId,
				content: `❌ Grupo "${letter}" não encontrado. Use A-L.`,
				options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
			});
		}

		const teamsMap = await fetchTeamsMap();
		const standings = sortStandings(groupData.teams || []);

		let msg = `📊 *GRUPO ${groupData.name}*\n\n`;
		msg += "`#  Time                   P  V  E  D  GP  GC  SG`\n";
		for (let i = 0; i < standings.length; i++) {
			const s = standings[i];
			const t = teamsMap[s.team_id] || {};
			const pts = String(Number(s.pts) || 0).padStart(2);
			const w = String(Number(s.w) || 0).padStart(1);
			const d = String(Number(s.d) || 0).padStart(1);
			const l = String(Number(s.l) || 0).padStart(1);
			const gf = String(Number(s.gf) || 0).padStart(2);
			const ga = String(Number(s.ga) || 0).padStart(2);
			const gd = String((Number(s.gf) || 0) - (Number(s.ga) || 0)).padStart(3);
			const name = (t.namePt || s.team_id || "???").padEnd(20);
			msg += `${i + 1}. ${name} ${pts}  ${w}  ${d}  ${l}  ${gf}  ${ga}  ${gd}\n`;
		}

		// Jogos do grupo
		msg += `\n*⚽ Jogos do Grupo ${groupData.name}:*\n`;
		try {
			const gamesRes = await axios.get(`${API_URL}/get/games`, { timeout: 8000 });
			const allGames = gamesRes.data.games || [];
			const groupGames = allGames.filter((gm) => gm.group === groupData.name);
			for (const gm of groupGames.slice(0, 4)) {
				const home = teamsMap[gm.home_team_id] || {};
				const away = teamsMap[gm.away_team_id] || {};
				const finished = isFinished(gm);
				const isLive = !finished && gm.time_elapsed !== "notstarted";
				const score = finished || isLive ? `${gm.home_score || 0} x ${gm.away_score || 0}` : "vs";
				const liveTag = isLive ? " (AO VIVO 🔴)" : "";
				msg += `${home.flagEmoji || ""} ${home.namePt || gm.home_team_label || "?"} ${score} ${away.flagEmoji || ""} ${away.namePt || gm.away_team_label || "?"}${liveTag}\n`;
			}
		} catch {
			// jogos opcionais
		}

		return new ReturnMessage({
			chatId,
			content: msg,
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	} catch (error) {
		logger.error("Erro em copaGrupo:", error);
		return new ReturnMessage({
			chatId,
			content: `❌ Erro ao buscar grupo: ${error.message}`,
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	}
}

/** !copa-jogos — calendário de jogos (todos ou por grupo) */
async function copaJogos(bot, message, args, group) {
	const chatId = message.group ?? message.from;
	try {
		const [games, teamsMap] = await Promise.all([fetchGames(), fetchTeamsMap()]);

		const filterGroup = args.length > 0 ? args[0].toUpperCase().replace(/^GRUPO\s*/i, "") : null;

		/** (parseGameDate já está disponível no escopo do módulo) */

		if (filterGroup) {
			// ── Modo grupo: mostra TODOS os jogos do grupo (passados e futuros) ──
			const groupGames = games
				.filter((g) => g.group === filterGroup)
				.sort((a, b) => parseGameDate(a) - parseGameDate(b));

			if (groupGames.length === 0) {
				return new ReturnMessage({
					chatId,
					content: `❌ Grupo "${filterGroup}" não encontrado. Use A-L.`,
					options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
				});
			}

			let msg = `📅 *Jogos do Grupo ${filterGroup}*\n\n`;
			for (const gm of groupGames) {
				const home = teamsMap[gm.home_team_id] || {};
				const away = teamsMap[gm.away_team_id] || {};
				const finished = isFinished(gm);
				const isLive = !finished && gm.time_elapsed !== "notstarted";
				const score = finished || isLive ? `*${gm.home_score || 0} x ${gm.away_score || 0}*` : "vs";
				const liveTag = isLive ? " (AO VIVO 🔴)" : "";
				const day = gm.local_date ? fmtDate(gm) : "";
				const status = finished ? "✅" : isLive ? "🔴" : "⏳";
				msg += `${status} ${home.flagEmoji || ""} ${home.namePt || gm.home_team_label || "?"} ${score} ${away.flagEmoji || ""} ${away.namePt || gm.away_team_label || "?"}${liveTag}`;
				if (gm.matchday) msg += ` (Rodada ${gm.matchday})`;
				msg += "\n";
				if (day) msg += `   📆 ${day}\n`;
			}
			msg += `\n🔢 ${groupGames.length} partidas`;

			return new ReturnMessage({
				chatId,
				content: msg,
				options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
			});
		}

		// ── Modo geral: jogos ativos (ao vivo) e futuros, sem os encerrados ──
		const now = new Date();
		const upcoming = games
			.filter((g) => !isFinished(g) && (g.time_elapsed !== "notstarted" || parseGameDate(g) >= now))
			.sort((a, b) => parseGameDate(a) - parseGameDate(b))
			.slice(0, 20);

		if (upcoming.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "⚽ Nenhum jogo futuro encontrado. A Copa pode ter encerrado!",
				options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
			});
		}

		let msg = `📅 *PRÓXIMOS JOGOS — COPA 2026*\n_(${upcoming.length} partidas)_\n\n`;

		// Agrupa por data para facilitar leitura
		const byDay = {};
		for (const gm of upcoming) {
			const d = parseGameDate(gm);
			const key = d.toLocaleDateString("pt-BR", {
				weekday: "long",
				day: "numeric",
				month: "long",
				timeZone: "America/Sao_Paulo"
			});
			if (!byDay[key]) byDay[key] = [];
			byDay[key].push(gm);
		}

		for (const [day, dayGames] of Object.entries(byDay)) {
			msg += `📆 *${day.charAt(0).toUpperCase() + day.slice(1)}*\n`;
			for (const gm of dayGames) {
				const home = teamsMap[gm.home_team_id] || {};
				const away = teamsMap[gm.away_team_id] || {};
				const isLive = gm.time_elapsed !== "notstarted";
				const gameDate = parseGameDate(gm);
				const time = gameDate.toLocaleTimeString("pt-BR", {
					hour: "2-digit",
					minute: "2-digit",
					timeZone: "America/Sao_Paulo"
				});
				const grp = `[${gm.id}]${gm.group ? `[${gm.group}]` : ""} `;
				const status = isLive ? "🔴 " : "⚽ ";
				msg += `  ${status}${grp}${home.flagEmoji || ""} ${home.namePt || gm.home_team_label || "?"} vs ${away.flagEmoji || ""} ${away.namePt || gm.away_team_label || "?"}`;
				if (isLive) msg += ` — *AO VIVO: ${gm.home_score}x${gm.away_score}* (${gm.time_elapsed})`;
				else if (time) msg += ` — ${time}h`;
				msg += "\n";
			}
			msg += "\n";
		}

		msg += `_Use !copa-jogo <id> para ver detalhes de um jogo (o id aparece entre colchetes ao lado de cada partida)_\n`;
		msg += `_Use !copa-jogos <grupo> para filtrar por grupo (ex: !copa-jogos A)_`;

		return new ReturnMessage({
			chatId,
			content: msg,
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	} catch (error) {
		logger.error("Erro em copaJogos:", error);
		return new ReturnMessage({
			chatId,
			content: `❌ Erro ao buscar jogos: ${error.message}`,
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	}
}

/** !copa-jogo <id> — detalhes de uma partida */
async function copaJogo(bot, message, args, group) {
	const chatId = message.group ?? message.from;
	try {
		if (args.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "❌ Use: `!copa-jogo <id>`\nEx: `!copa-jogo 1`",
				options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
			});
		}

		const gameId = String(args[0]);
		const [games, teamsMap] = await Promise.all([fetchGames(), fetchTeamsMap()]);
		let game = games.find((g) => g.id === gameId || g._id === gameId);

		if (!game) {
			return new ReturnMessage({
				chatId,
				content: `❌ Jogo #${gameId} não encontrado.`,
				options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
			});
		}

		// Busca detalhes em tempo real se o jogo estiver rolando
		const isLive = !isFinished(game) && game.time_elapsed !== "notstarted";
		if (isLive) {
			try {
				const res = await axios.get(`${API_URL}/get/game/${game._id}`, { timeout: 5000 });
				const detail = res.data.game || res.data;
				if (detail) game = { ...game, ...detail };
			} catch (e) {
				logger.error(`Erro ao buscar real-time para jogo ${game.id}:`, e.message);
			}
		}

		const home = teamsMap[game.home_team_id] || {};
		const away = teamsMap[game.away_team_id] || {};
		const finished = isFinished(game);
		const currentlyLive = !finished && game.time_elapsed !== "notstarted";
		const score =
			finished || currentlyLive
				? `*${game.home_score || 0} x ${game.away_score || 0}*`
				: "⚽ A definir";

		let msg =
			`⚽ *Jogo #${game.id}*\n\n` +
			`${home.flagEmoji || ""} *${home.namePt || game.home_team_name_en || game.home_team_label || "Casa"}*  vs  ${away.flagEmoji || ""} *${away.namePt || game.away_team_name_en || game.away_team_label || "Fora"}*\n\n` +
			`🏆 *Placar:* ${score}\n`;

		if (currentlyLive) {
			msg += `🕒 *Tempo:* ${game.time_elapsed}\n`;
			msg += `🔥 *STATUS:* AO VIVO 🔴\n\n`;
		} else {
			msg += `\n`;
		}

		msg +=
			`📌 Grupo: *${game.group || "—"}*\n` +
			`🔄 Rodada: ${game.matchday || "—"}\n` +
			`📆 Data: ${fmtFullDate(game)}\n` +
			`✅ Finalizado: ${finished ? "Sim 🏁" : "Não ⏳"}\n`;

		if (game.type) msg += `🏅 Fase: ${game.type}\n`;
		if (game.stadium_id) msg += `🏟️ Estádio ID: ${game.stadium_id}\n`;

		return new ReturnMessage({
			chatId,
			content: msg,
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	} catch (error) {
		logger.error("Erro em copaJogo:", error);
		return new ReturnMessage({
			chatId,
			content: `❌ Erro ao buscar jogo: ${error.message}`,
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	}
}

/** !copa-estadios — lista todos os estádios */
async function copaEstadios(bot, message, args, group) {
	const chatId = message.group ?? message.from;
	try {
		const stadiums = await fetchStadiums();

		let msg = `🏟️ *16 ESTÁDIOS DA COPA 2026*\n\n`;

		const countries = { "United States": "🇺🇸", Mexico: "🇲🇽", Canada: "🇨🇦" };
		const byCountry = {};
		for (const s of stadiums) {
			const c = s.country_en || "Other";
			if (!byCountry[c]) byCountry[c] = [];
			byCountry[c].push(s);
		}

		for (const [country, list] of Object.entries(byCountry)) {
			msg += `${countries[country] || "🏳️"} *${country}:*\n`;
			for (const s of list) {
				msg += `  🏟️ *${s.name_en}* — ${s.city_en || ""}\n`;
				if (s.capacity)
					msg += `     👥 Capacidade: ${Number(s.capacity).toLocaleString("pt-BR")}\n`;
			}
			msg += "\n";
		}

		return new ReturnMessage({
			chatId,
			content: msg,
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	} catch (error) {
		logger.error("Erro em copaEstadios:", error);
		return new ReturnMessage({
			chatId,
			content: `❌ Erro ao buscar estádios: ${error.message}`,
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	}
}

/** !copa-seguir <nome> — Habilita/Desabilita notificações de um time */
async function copaSeguir(bot, message, args, group) {
	const chatId = message.group ?? message.from;
	const stripped = chatId.split("@")[0];
	try {
		if (args.length === 0) {
			let followed = [];
			try {
				followed = await database.dbAll(
					"copa_seguir",
					"SELECT team_name_pt, fifa_code FROM copa_seguindo WHERE chat_id = ? OR chat_id = ?",
					[chatId, stripped]
				);
			} catch (err) {
				logger.error("Erro ao buscar times seguidos no banco:", err);
			}

			let followedListStr = "";
			if (followed && followed.length > 0) {
				followedListStr =
					"\n\n*Times sendo seguidos neste chat:*\n" +
					followed.map((t) => `${flag(t.fifa_code)} ${t.team_name_pt} (${t.fifa_code})`).join("\n");
			} else {
				followedListStr = "\n\nNenhum time está sendo seguido neste chat.";
			}

			return new ReturnMessage({
				chatId,
				content:
					"❌ Use: `!copa-seguir <nome>`\n" +
					"Ex: `!copa-seguir brasil`, `!copa-seguir argentina`" +
					followedListStr +
					`\n\n> ${chatId}`,
				options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
			});
		}

		const rawInput = args.join(" ");
		const name = resolveTeamName(rawInput);
		const res = await axios.get(`${API_URL}/get/team/`, {
			params: { name },
			timeout: 8000
		});
		const team = res.data.team;

		if (!team) {
			const known = [...new Set(Object.values(TEAM_ALIASES))].sort().join(", ");
			return new ReturnMessage({
				chatId,
				content:
					`❌ Time "${rawInput}" não encontrado.\n\n` +
					`💡 Tente com o nome em português ou inglês. Ex: brasil, argentina, franca.`,
				options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
			});
		}

		const nameEn = team.name_en;
		const teamId = String(team.id);
		const fifaCode = team.fifa_code;
		const ptName = namePt(team);
		const emoji = flag(fifaCode);

		const existing = await database.dbGet(
			"copa_seguir",
			"SELECT 1 FROM copa_seguindo WHERE (chat_id = ? OR chat_id = ?) AND team_id = ?",
			[chatId, stripped, teamId]
		);

		if (existing) {
			await database.dbRun(
				"copa_seguir",
				"DELETE FROM copa_seguindo WHERE (chat_id = ? OR chat_id = ?) AND team_id = ?",
				[chatId, stripped, teamId]
			);
			return new ReturnMessage({
				chatId,
				content: `🔔 *Notificações Desativadas!*\n\nVocê deixou de seguir o time: ${emoji} *${ptName}* (${fifaCode}).\nNão enviarei mais atualizações deste time neste chat.`,
				options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
			});
		} else {
			await database.dbRun(
				"copa_seguir",
				"INSERT INTO copa_seguindo (chat_id, team_id, team_name_en, team_name_pt, fifa_code, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[chatId, teamId, nameEn, ptName, fifaCode, Date.now()]
			);
			return new ReturnMessage({
				chatId,
				content: `🔔 *Notificações Ativadas!*\n\nVocê agora está seguindo o time: ${emoji} *${ptName}* (${fifaCode}).\nEnviarei avisos de início de partida, gols e fim de partida neste chat!`,
				options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
			});
		}
	} catch (error) {
		logger.error("Erro em copaSeguir:", error);
		return new ReturnMessage({
			chatId,
			content: `❌ Erro ao processar comando: ${error.message}`,
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	}
}

// ─── Copa GIF via Newsletter ────────────────────────────────

/** ID fixo do canal de newsletter de gols da Copa 2026 */
const COPA_NEWSLETTER_ID = "120363424179275833@newsletter";

/**
 * Set de captions já processadas — evita envio duplicado quando múltiplos
 * bots rodam no mesmo processo Node e todos recebem a mesma mensagem do canal.
 */
const _processedCopaGifCaptions = new Set();

/**
 * Mapas invertidos: emoji de bandeira → fifa_code  e  nome PT → fifa_code.
 * Construídos uma única vez na inicialização do módulo.
 */
const FLAG_TO_CODE = Object.fromEntries(
	Object.entries(FLAGS).map(([code, emoji]) => [emoji, code])
);
const NAMEPT_TO_CODE = Object.fromEntries(
	Object.entries(NAMES_PT).map(([code, name]) => [name.toLowerCase(), code])
);

/**
 * Extrai os fifa_codes dos times mencionados numa caption de gol da Copa.
 * Estratégia: 1) detecta emojis de bandeira; 2) detecta nomes PT.
 * @param {string} caption
 * @returns {string[]} Array de fifa_codes (únicos)
 */
function extractTeamCodesFromCaption(caption) {
	const found = new Set();

	// 1. Busca por emojis de bandeira conhecidos
	for (const [emoji, code] of Object.entries(FLAG_TO_CODE)) {
		if (caption.includes(emoji)) found.add(code);
	}

	// 2. Busca por nomes PT (case-insensitive)
	const captionLower = caption.toLowerCase();
	for (const [nameLower, code] of Object.entries(NAMEPT_TO_CODE)) {
		if (captionLower.includes(nameLower)) found.add(code);
	}

	return [...found];
}

/**
 * Detecta GIF de gol/placar da Copa via newsletter e encaminha para os
 * grupos que estão seguindo algum dos times mencionados na caption.
 *
 * Critérios de detecção:
 *  - Mensagem vinda do newsletter COPA_NEWSLETTER_ID
 *  - content._mediaDetails.gifPlayback === true
 *  - caption contém padrão \d+x\d+ (placar) e "Copa do Mundo"
 *
 * @param {Object} message - Mensagem formatada pelo EventHandler
 * @param {Object} bot - Bot que recebeu a mensagem (usado para download)
 * @returns {Promise<boolean>} true se detectado e encaminhado
 */
async function detectCopaGif(message, bot) {
	try {
		// 1. Valida origem
		if (message.from !== COPA_NEWSLETTER_ID) return false;

		// 2. Valida que é um GIF (gifPlayback = true)
		const mediaDetails = message.content?._mediaDetails;
		if (!mediaDetails?.gifPlayback) return false;

		// 3. Valida caption com placar e contexto da Copa
		const caption = mediaDetails.caption || "";
		if (!caption) return false;

		const hasScore = /\d+x\d+/i.test(caption);
		const hasCopa = /copa do mundo/i.test(caption);
		if (!hasScore || !hasCopa) return false;

		// 4. Dedup: mesma caption = mesma mensagem (múltiplos bots no mesmo processo)
		if (_processedCopaGifCaptions.has(caption)) {
			logger.debug(
				`[Copa GIF] Caption já processada, ignorando dedup: ${caption.substring(0, 60)}`
			);
			return false;
		}
		_processedCopaGifCaptions.add(caption);

		// Limpa dedup após 10min para não acumular memória indefinidamente
		setTimeout(() => _processedCopaGifCaptions.delete(caption), 10 * 60 * 1000);

		logger.info(`[Copa GIF] GIF de gol detectado! Caption: ${caption.substring(0, 80)}`);

		// 5. Detecta times na caption
		const fifaCodes = extractTeamCodesFromCaption(caption);
		if (fifaCodes.length === 0) {
			logger.warn(`[Copa GIF] Nenhum time reconhecido na caption: ${caption.substring(0, 80)}`);
			return false;
		}
		logger.info(`[Copa GIF] Times detectados: ${fifaCodes.join(", ")}`);

		// 6. Busca team_ids pela API para consultar o BD
		let teamsMap = {};
		try {
			teamsMap = await fetchTeamsMap();
		} catch (e) {
			logger.error(`[Copa GIF] Erro ao buscar mapa de times: ${e.message}`);
		}

		// Mapeia fifa_codes → team_ids
		const teamIds = [];
		for (const [id, team] of Object.entries(teamsMap)) {
			if (fifaCodes.includes(team.fifa_code)) teamIds.push(String(id));
		}

		if (teamIds.length === 0) {
			logger.warn(`[Copa GIF] Nenhum team_id encontrado para códigos: ${fifaCodes.join(", ")}`);
			return false;
		}

		// 7. Consulta BD: grupos seguindo algum desses times
		const placeholders = teamIds.map(() => "?").join(", ");
		const followers = await database.dbAll(
			"copa_seguir",
			`SELECT DISTINCT chat_id FROM copa_seguindo WHERE team_id IN (${placeholders})`,
			teamIds
		);

		if (!followers || followers.length === 0) {
			logger.info(`[Copa GIF] Nenhum grupo seguindo os times: ${fifaCodes.join(", ")}`);
			return true; // detectou, mas sem destinatários
		}

		const chatIds = followers.map((f) => f.chat_id);
		logger.info(`[Copa GIF] Encaminhando para ${chatIds.length} grupo(s): ${chatIds.join(", ")}`);

		// 8. Baixa a mídia via bot que recebeu a mensagem
		let media = null;
		try {
			media = await message.downloadMedia();
		} catch (e) {
			logger.error(`[Copa GIF] Erro ao baixar mídia: ${e.message}`);
		}

		if (!media) {
			logger.error(`[Copa GIF] Download da mídia falhou.`);
			return false;
		}

		// 9. Prepara token aleatório para anti-spam (mesmo padrão do webhook /copa)
		const rndToken = () =>
			Math.random().toString(36).substring(2, 6) + Math.random().toString(36).substring(2, 6);

		const captionComToken = `${caption}\n\n_${rndToken()}_`;

		// 10. Obtém lista de todos os bots via bot.botApi (injetado pelo BotAPI no init)
		const allBots = bot?.botApi?.bots || [bot];

		// 11. Envia para cada chatId
		for (const chatId of chatIds) {
			try {
				const isWhatsAppChat =
					chatId.includes("@") ||
					(/^\d+$/.test(chatId) && chatId.length >= 10 && chatId.length <= 15);

				if (isWhatsAppChat) {
					// Tenta todos os bots WA até um conseguir enviar
					const waBots = allBots.filter((b) => b.isConnected && !b.useTelegram && !b.useDiscord);
					if (waBots.length === 0) {
						const fallbackWa = allBots.find((b) => !b.useTelegram && !b.useDiscord);
						if (fallbackWa) waBots.push(fallbackWa);
					}

					let sent = false;
					for (const currentBot of waBots) {
						try {
							await currentBot.sendMessage(chatId, media, {
								caption: captionComToken,
								sendVideoAsGif: true
							});
							logger.info(
								`[Copa GIF] Enviado para ${chatId} via bot ${currentBot.id || currentBot.botId}`
							);
							sent = true;
							break;
						} catch (err) {
							logger.warn(
								`[Copa GIF] Falhou com bot ${currentBot.id || currentBot.botId}: ${err.message}. Tentando próximo...`
							);
						}
					}

					if (!sent) {
						logger.error(`[Copa GIF] Todos os bots WA falharam ao enviar para ${chatId}`);
					}
				} else {
					// Telegram ou Discord
					let targetBot = null;
					if (/^\d{17,20}$/.test(chatId)) {
						targetBot =
							allBots.find((b) => b.useDiscord && b.isConnected) ||
							allBots.find((b) => b.useDiscord);
					} else {
						targetBot =
							allBots.find((b) => b.useTelegram && b.isConnected) ||
							allBots.find((b) => b.useTelegram);
					}

					if (targetBot) {
						await targetBot.sendMessage(chatId, media, {
							caption: captionComToken,
							sendVideoAsGif: true
						});
						logger.info(`[Copa GIF] Enviado para ${chatId} via ${targetBot.id}`);
					} else {
						logger.error(`[Copa GIF] Nenhum bot compatível para ${chatId}`);
					}
				}
			} catch (err) {
				logger.error(`[Copa GIF] Erro ao enviar para ${chatId}: ${err.message}`);
			}
		}

		return true;
	} catch (error) {
		logger.error("[Copa GIF] Erro inesperado em detectCopaGif:", error);
		return false;
	}
}

// ─── Registro ────────────────────────────────────────────────

const commands = [
	new Command({
		name: "copa",
		description: "Lista todos os comandos da Copa do Mundo 2026",
		category: "cultura",
		reactions: { before: "⌛️", after: "⚽", error: "❌" },
		method: copaMenu
	}),

	new Command({
		name: "copa-times",
		description: "Lista todos os 48 times (ou de um grupo: !copa-times C)",
		category: "cultura",
		reactions: { before: "⌛️", after: "🌎", error: "❌" },
		method: copaTimes
	}),

	new Command({
		name: "copa-time",
		description: "Informações de um time específico",
		category: "cultura",
		reactions: { before: "⌛️", after: "🏆", error: "❌" },
		method: copaTime
	}),

	new Command({
		name: "copa-grupos",
		description: "Classificação de todos os 12 grupos",
		category: "cultura",
		reactions: { before: "⌛️", after: "📊", error: "❌" },
		method: copaGrupos
	}),

	new Command({
		name: "copa-grupo",
		description: "Classificação detalhada de um grupo (ex: !copa-grupo C)",
		category: "cultura",
		reactions: { before: "⌛️", after: "📊", error: "❌" },
		method: copaGrupo
	}),

	new Command({
		name: "copa-jogos",
		description: "Calendário de jogos (ou de um grupo: !copa-jogos A)",
		category: "cultura",
		reactions: { before: "⌛️", after: "📅", error: "❌" },
		method: copaJogos
	}),

	new Command({
		name: "copa-jogo",
		description: "Detalhes de uma partida (ex: !copa-jogo 1)",
		category: "cultura",
		reactions: { before: "⌛️", after: "⚽", error: "❌" },
		method: copaJogo
	}),

	new Command({
		name: "copa-estadios",
		description: "Lista todos os 16 estádios da Copa",
		category: "cultura",
		reactions: { before: "⌛️", after: "🏟️", error: "❌" },
		method: copaEstadios
	}),

	new Command({
		name: "copa-seguir",
		description: "Habilita/Desabilita notificações de partidas de um time",
		category: "cultura",
		reactions: { before: "⌛️", after: "🔔", error: "❌" },
		method: copaSeguir
	})
];

module.exports = {
	commands: API_URL ? commands : [],
	FLAGS,
	NAMES_PT,
	flag,
	namePt,
	fetchTeamsMap,
	detectCopaGif
};
