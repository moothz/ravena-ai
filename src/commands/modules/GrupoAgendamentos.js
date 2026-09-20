const Database = require("../../utils/Database");
const Logger = require("../../utils/Logger");
const ReturnMessage = require("../../models/ReturnMessage");

const logger = new Logger("grupo-agendamentos");
const database = Database.getInstance();
const dbName = "grupo_agendamentos";

// Inicializa a tabela no banco SQLite
database.getSQLiteDb(
	dbName,
	`
    CREATE TABLE IF NOT EXISTS grupo_agendamentos (
      id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      bot_id TEXT,
      tipo TEXT NOT NULL,
      hora INTEGER NOT NULL,
      minuto INTEGER NOT NULL,
      dia_semana INTEGER,
      timestamp_unico INTEGER,
      frase TEXT,
      ativo INTEGER DEFAULT 1,
      criado_em INTEGER NOT NULL,
      executado_em INTEGER,
      PRIMARY KEY (id, group_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agend_group ON grupo_agendamentos(group_id);
    CREATE INDEX IF NOT EXISTS idx_agend_ativo ON grupo_agendamentos(ativo);
`
);

// Armazena timeouts de agendamentos únicos: key `${groupId}:${id}` -> timeoutId
const activeTimeouts = new Map();

// Controla última execução de agendamentos semanais: key `${groupId}:${id}` -> string "YYYY-MM-DD-HH-mm"
const lastFiredWeekly = new Map();

// Interval global para agendamentos semanais
let weeklyCheckInterval = null;

// Mapa de instâncias ativas de bot por botId
const activeBots = new Map();

const DIAS_SEMANA_NOMES = [
	"Domingo",
	"Segunda-feira",
	"Terça-feira",
	"Quarta-feira",
	"Quinta-feira",
	"Sexta-feira",
	"Sábado"
];

const DIAS_MAP = {
	dom: 0,
	domingo: 0,
	sun: 0,
	sunday: 0,
	seg: 1,
	segunda: 1,
	segundafeira: 1,
	mon: 1,
	monday: 1,
	ter: 2,
	terca: 2,
	terça: 2,
	tercafeira: 2,
	terçafeira: 2,
	tue: 2,
	tues: 2,
	tuesday: 2,
	qua: 3,
	quarta: 3,
	quartafeira: 3,
	wed: 3,
	wednesday: 3,
	qui: 4,
	quinta: 4,
	quintafeira: 4,
	thu: 4,
	thur: 4,
	thurs: 4,
	thursday: 4,
	sex: 5,
	sexta: 5,
	sextafeira: 5,
	fri: 5,
	friday: 5,
	sab: 6,
	sabado: 6,
	sábado: 6,
	sat: 6,
	saturday: 6
};

const DIAS_MAP_SHORT = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/**
 * Retorna o dia da semana (0-6) de um objeto Date no fuso de Brasília
 */
function getDiaSemanaBrasilia(date) {
	const dtf = new Intl.DateTimeFormat("en-US", {
		timeZone: "America/Sao_Paulo",
		weekday: "short"
	});
	const dayStr = dtf.format(date).toLowerCase();
	return DIAS_MAP_SHORT[dayStr];
}

/**
 * Retorna as informações de data/hora atual no fuso America/Sao_Paulo (GMT-3)
 */
function getNowBrasilia() {
	const now = new Date();
	const dtf = new Intl.DateTimeFormat("en-US", {
		timeZone: "America/Sao_Paulo",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
		weekday: "short"
	});
	const parts = dtf.formatToParts(now);
	const map = {};
	for (const p of parts) {
		map[p.type] = p.value;
	}

	const year = parseInt(map.year, 10);
	const month = parseInt(map.month, 10);
	const day = parseInt(map.day, 10);
	const hour = parseInt(map.hour, 10);
	const minute = parseInt(map.minute, 10);
	const second = parseInt(map.second, 10);
	const diaSemana = DIAS_MAP_SHORT[map.weekday.toLowerCase()];

	// Monta objeto Date para compatibilidade
	const dateInTz = new Date(
		`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}-03:00`
	);

	return {
		now,
		year,
		month,
		day,
		hour,
		minute,
		second,
		diaSemana,
		dateInTz
	};
}

/**
 * Converte número sequencial para letras (0 -> A, 25 -> Z, 26 -> AA...)
 */
function numberToLetters(num) {
	let str = "";
	let n = num;
	while (n >= 0) {
		str = String.fromCharCode(65 + (n % 26)) + str;
		n = Math.floor(n / 26) - 1;
	}
	return str;
}

/**
 * Converte letras para número (A -> 0, Z -> 25, AA -> 26...)
 */
function lettersToNumber(str) {
	let num = 0;
	for (let i = 0; i < str.length; i++) {
		num = num * 26 + (str.charCodeAt(i) - 64);
	}
	return num - 1;
}

/**
 * Gera o próximo ID único do grupo no padrão 'A', 'B', ..., 'Z', 'AA'
 */
async function gerarProximoId(groupId) {
	const rows = await database.dbAll(
		dbName,
		`SELECT id FROM grupo_agendamentos WHERE group_id = ?`,
		[groupId]
	);

	if (!rows || rows.length === 0) {
		return "A";
	}

	let maxNum = -1;
	for (const r of rows) {
		if (/^[A-Z]+$/.test(r.id)) {
			const n = lettersToNumber(r.id);
			if (n > maxNum) maxNum = n;
		}
	}

	return numberToLetters(maxNum + 1);
}

/**
 * Faz o parse da string de hora: ex: "13:30", "13h30", "7:30", "07h30", "13h", "14"
 * Retorna { hora, minuto } ou null
 */
function parseHora(str) {
	if (!str || typeof str !== "string") return null;
	const clean = str.trim().toLowerCase();

	const match = clean.match(/^(\d{1,2})(?:[:h](\d{1,2})?)?$/);
	if (!match) return null;

	const hora = parseInt(match[1], 10);
	const minuto = match[2] !== undefined ? parseInt(match[2], 10) : 0;

	if (isNaN(hora) || hora < 0 || hora > 23) return null;
	if (isNaN(minuto) || minuto < 0 || minuto > 59) return null;

	return { hora, minuto };
}

/**
 * Faz o parse do dia da semana: "seg", "sexta", "monday", etc.
 * Retorna número 0-6 ou null
 */
function parseDiaSemana(str) {
	if (!str || typeof str !== "string") return null;
	const clean = str
		.trim()
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[-_]/g, "");

	if (clean in DIAS_MAP) {
		return DIAS_MAP[clean];
	}

	return null;
}

/**
 * Formata hora e minuto para exibição "13:30"
 */
function formatarHora(hora, minuto) {
	return `${String(hora).padStart(2, "0")}:${String(minuto).padStart(2, "0")}`;
}

/**
 * Calcula tempo restante legível (ex: "em 3h45min", "em 15min")
 */
function formatarTempoRestante(diffMs) {
	if (diffMs <= 0) return "agora";
	const diffMin = Math.round(diffMs / 60000);
	const horas = Math.floor(diffMin / 60);
	const mins = diffMin % 60;

	if (horas > 0 && mins > 0) {
		return `em ${horas}h${mins}min`;
	} else if (horas > 0) {
		return `em ${horas}h`;
	} else {
		return `em ${mins}min`;
	}
}

/**
 * Valida e ajusta a frase personalizada com o emoji do cadeado
 */
function sanitizarFrase(frase, tipo) {
	if (!frase || typeof frase !== "string") return null;
	let f = frase.trim();
	if (f.length < 5) {
		throw new Error("A frase personalizada deve conter no mínimo 5 caracteres.");
	}

	const emojiPadrao = tipo === "fechar" ? "🔒" : "🔓";
	if (!f.startsWith("🔒") && !f.startsWith("🔓")) {
		f = `${emojiPadrao} ${f}`;
	}

	return f;
}

/**
 * Cria ou calcula a data para agendamento único no fuso GMT-3
 */
function calcularTimestampUnico(hora, minuto) {
	const sp = getNowBrasilia();
	const agoraMs = Date.now();

	// Cria data alvo hoje no fuso
	const targetDate = new Date(
		`${sp.year}-${String(sp.month).padStart(2, "0")}-${String(sp.day).padStart(2, "0")}T${String(hora).padStart(2, "0")}:${String(minuto).padStart(2, "0")}:00-03:00`
	);

	let isTomorrow = false;
	if (targetDate.getTime() <= agoraMs) {
		// Já passou hoje, programa para amanhã (avança 24 horas)
		targetDate.setTime(targetDate.getTime() + 24 * 60 * 60 * 1000);
		isTomorrow = true;
	}

	const diffMs = targetDate.getTime() - agoraMs;
	return {
		timestamp: targetDate.getTime(),
		diffMs,
		isTomorrow,
		diaSemanaCalculado: getDiaSemanaBrasilia(targetDate)
	};
}

/**
 * Executa de fato a abertura ou fechamento do grupo
 */
async function executarAgendamento(agendamento, bot) {
	const { id, group_id: groupId, tipo, frase } = agendamento;
	logger.info(
		`Executando agendamento [${id}] (${tipo}) para o grupo ${groupId} via bot ${bot?.id || "desconhecido"}`
	);

	try {
		if (!bot || !bot.client) {
			logger.warn(`Bot indisponível para executar agendamento [${id}] no grupo ${groupId}`);
			return;
		}

		// Obtém o chat
		const chat = await bot.client.getChatById(groupId);
		if (!chat) {
			logger.error(`Não foi possível obter o chat do grupo ${groupId}`);
			return;
		}

		const setAdminsOnly = tipo === "fechar";
		await chat.setMessagesAdminsOnly(setAdminsOnly);

		// Mensagem enviada
		let content;
		if (frase) {
			content = frase;
		} else {
			content = setAdminsOnly
				? "🔒 *Grupo fechado automaticamente.* Apenas administradores podem enviar mensagens agora."
				: "🔓 *Grupo aberto automaticamente.* Todos os participantes podem enviar mensagens agora.";
		}

		const returnMsg = new ReturnMessage({
			chatId: groupId,
			content
		});

		await bot.sendReturnMessages(returnMsg);

		const now = Date.now();
		if (agendamento.dia_semana === null || agendamento.dia_semana === undefined) {
			// Agendamento único: marca ativo = 0 e salva executado_em
			await database.dbRun(
				dbName,
				`UPDATE grupo_agendamentos SET ativo = 0, executado_em = ? WHERE id = ? AND group_id = ?`,
				[now, id, groupId]
			);
			activeTimeouts.delete(`${groupId}:${id}`);
		} else {
			// Recorrente: apenas registra timestamp
			await database.dbRun(
				dbName,
				`UPDATE grupo_agendamentos SET executado_em = ? WHERE id = ? AND group_id = ?`,
				[now, id, groupId]
			);
		}
	} catch (error) {
		logger.error(`Erro ao executar agendamento [${id}] no grupo ${groupId}:`, error);
	}
}

/**
 * Inicia o setTimeout para um agendamento único
 */
function armarTimerUnico(bot, agendamento) {
	const key = `${agendamento.group_id}:${agendamento.id}`;
	if (activeTimeouts.has(key)) {
		clearTimeout(activeTimeouts.get(key));
		activeTimeouts.delete(key);
	}

	const agora = Date.now();
	const delay = agendamento.timestamp_unico - agora;

	if (delay <= 0) {
		// Já passou
		if (delay > -120000) {
			// Passou há menos de 2 minutos (ex: reinício rápido), executa imediatamente
			executarAgendamento(agendamento, bot);
		} else {
			// Expirado há muito tempo: inativa
			database.dbRun(
				dbName,
				`UPDATE grupo_agendamentos SET ativo = 0 WHERE id = ? AND group_id = ?`,
				[agendamento.id, agendamento.group_id]
			);
		}
		return;
	}

	// Não agendar setTimeout maior que ~24 dias (limite de 32-bit int no Node)
	if (delay > 2147483647) return;

	const timerId = setTimeout(() => {
		executarAgendamento(agendamento, bot);
	}, delay);

	activeTimeouts.set(key, timerId);
}

/**
 * Localiza a melhor instância de bot para executar o agendamento
 */
function getBotParaAgendamento(row) {
	const botId = row.bot_id;
	const isWhatsApp = row.group_id && row.group_id.includes("@g.us");
	const isDiscord = row.group_id && String(row.group_id).includes("@discord");

	// 1. Tenta achar no activeBots pelo botId exato
	let bot = botId ? activeBots.get(botId) : null;
	if (bot && bot.isConnected) {
		if (isWhatsApp && (bot.useTelegram || bot.useDiscord)) {
			// Incompatível: grupo WhatsApp não pode ser gerenciado por Telegram/Discord
		} else {
			return bot;
		}
	}

	// 2. Tenta achar na lista global de botInstances do Database
	const allBots = Database.getInstance().botInstances || [];
	if (botId) {
		bot = allBots.find((b) => (b.id === botId || b.name === botId) && b.isConnected);
		if (bot) {
			if (isWhatsApp && (bot.useTelegram || bot.useDiscord)) {
				// Incompatível
			} else {
				activeBots.set(bot.id || botId, bot);
				return bot;
			}
		}
	}

	// 3. Fallback inteligente estrito por protocolo
	if (isWhatsApp) {
		// DEVE ser um bot WhatsApp
		bot =
			allBots.find((b) => !b.useTelegram && !b.useDiscord && b.isConnected) ||
			Array.from(activeBots.values()).find(
				(b) => !b.useTelegram && !b.useDiscord && b.isConnected
			) ||
			allBots.find((b) => !b.useTelegram && !b.useDiscord);
	} else if (isDiscord) {
		bot =
			allBots.find((b) => b.useDiscord && b.isConnected) ||
			Array.from(activeBots.values()).find((b) => b.useDiscord && b.isConnected);
	} else {
		// Telegram ou genérico
		bot =
			allBots.find((b) => b.useTelegram && b.isConnected) ||
			Array.from(activeBots.values()).find((b) => b.useTelegram && b.isConnected) ||
			allBots.find((b) => b.isConnected) ||
			Array.from(activeBots.values()).find((b) => b.isConnected);
	}

	if (bot) {
		activeBots.set(bot.id || botId, bot);
	}
	return bot;
}

/**
 * Loop de checagem para agendamentos semanais e verificação de agendamentos únicos pendentes
 */
async function verificarAgendamentosSemanais() {
	try {
		const sp = getNowBrasilia();
		const currentHour = sp.hour;
		const currentMin = sp.minute;
		const currentDay = sp.diaSemana;
		const dateKey = `${sp.year}-${sp.month}-${sp.day}-${currentHour}-${currentMin}`;
		const agoraMs = Date.now();

		// 1. Checa agendamentos únicos pendentes ou que venceram recentemente (fallback seguro contra reinício de container)
		const unicosPendentes = await database.dbAll(
			dbName,
			`SELECT * FROM grupo_agendamentos 
			 WHERE ativo = 1 
			   AND dia_semana IS NULL 
			   AND timestamp_unico <= ?`,
			[agoraMs]
		);

		if (unicosPendentes && unicosPendentes.length > 0) {
			for (const row of unicosPendentes) {
				const bot = getBotParaAgendamento(row);
				const atraso = agoraMs - row.timestamp_unico;
				if (atraso < 15 * 60 * 1000) {
					// Até 15 minutos de atraso (ex: reinício do container ou timeout perdido)
					if (bot) {
						logger.info(
							`Executando agendamento único pendente [${row.id}] (${row.tipo}) no grupo ${row.group_id} (atraso de ${Math.round(atraso / 1000)}s)`
						);
						executarAgendamento(row, bot);
					} else {
						logger.warn(
							`Nenhum bot conectado encontrado para agendamento único pendente [${row.id}] no grupo ${row.group_id}`
						);
					}
				} else {
					// Expirado há mais de 15 minutos: desativa para não acumular
					logger.info(
						`Desativando agendamento único expirado há ${Math.round(atraso / 60000)}min [${row.id}] no grupo ${row.group_id}`
					);
					await database.dbRun(
						dbName,
						`UPDATE grupo_agendamentos SET ativo = 0 WHERE id = ? AND group_id = ?`,
						[row.id, row.group_id]
					);
				}
			}
		}

		// 2. Busca todos os agendamentos semanais ativos para hoje/hora/minuto
		const rows = await database.dbAll(
			dbName,
			`SELECT * FROM grupo_agendamentos 
			 WHERE ativo = 1 
			   AND dia_semana = ? 
			   AND hora = ? 
			   AND minuto = ?`,
			[currentDay, currentHour, currentMin]
		);

		if (!rows || rows.length === 0) return;

		for (const row of rows) {
			const key = `${row.group_id}:${row.id}`;
			if (lastFiredWeekly.get(key) === dateKey) {
				// Já disparou neste minuto
				continue;
			}

			lastFiredWeekly.set(key, dateKey);

			// Acha o bot apropriado para o protocolo do grupo
			const bot = getBotParaAgendamento(row);

			if (bot) {
				executarAgendamento(row, bot);
			} else {
				logger.warn(
					`Nenhum bot conectado encontrado para executar agendamento semanal [${row.id}] no grupo ${row.group_id}`
				);
			}
		}

		// Limpa mapa de lastFiredWeekly para chaves antigas
		if (lastFiredWeekly.size > 200) {
			for (const [k, v] of lastFiredWeekly.entries()) {
				if (v !== dateKey) lastFiredWeekly.delete(k);
			}
		}
	} catch (error) {
		logger.error("Erro na verificação de agendamentos:", error);
	}
}

/**
 * Inicializa agendamentos para a instância do bot
 */
async function inicializarAgendamentos(bot) {
	try {
		const botId = bot?.id || bot?.name || "default";
		if (bot) {
			activeBots.set(botId, bot);
		}

		// Inicializa o interval global de checagem se ainda não estiver rodando
		if (!weeklyCheckInterval) {
			weeklyCheckInterval = setInterval(verificarAgendamentosSemanais, 30000);
		}

		// Carrega agendamentos únicos ativos futuros
		const agora = Date.now();
		const rows = await database.dbAll(
			dbName,
			`SELECT * FROM grupo_agendamentos 
			 WHERE ativo = 1 
			   AND dia_semana IS NULL 
			   AND timestamp_unico > ?`,
			[agora]
		);

		logger.info(`Inicializando ${rows.length} agendamentos únicos futuros`);

		for (const row of rows) {
			const botToUse = bot || getBotParaAgendamento(row);
			if (botToUse) {
				armarTimerUnico(botToUse, row);
			}
		}
	} catch (error) {
		logger.error("Erro ao inicializar agendamentos do grupo:", error);
	}
}

/**
 * Conta quantos agendamentos ativos já existem para um grupo naquele dia da semana
 */
async function contarAgendamentosNoDia(groupId, diaSemana) {
	const rows = await database.dbAll(
		dbName,
		`SELECT * FROM grupo_agendamentos WHERE group_id = ? AND ativo = 1`,
		[groupId]
	);

	let count = 0;

	for (const r of rows) {
		if (r.dia_semana !== null && r.dia_semana !== undefined) {
			if (r.dia_semana === diaSemana) count++;
		} else if (r.timestamp_unico) {
			// Checa qual o dia da semana deste agendamento único no fuso
			const uniqueDay = getDiaSemanaBrasilia(new Date(r.timestamp_unico));
			if (uniqueDay === diaSemana) count++;
		}
	}

	return count;
}

/**
 * Cria um novo agendamento
 */
async function criarAgendamento(bot, groupId, tipo, hora, minuto, diaSemana, fraseRaw) {
	const botId = bot?.id || bot?.name || "default";
	activeBots.set(botId, bot);

	const frase = fraseRaw ? sanitizarFrase(fraseRaw, tipo) : null;

	let timestampUnico = null;
	let diffMs = 0;
	let isTomorrow = false;
	let diaAlvo = diaSemana;

	if (diaSemana === null || diaSemana === undefined) {
		// Agendamento único
		const calc = calcularTimestampUnico(hora, minuto);
		timestampUnico = calc.timestamp;
		diffMs = calc.diffMs;
		isTomorrow = calc.isTomorrow;
		diaAlvo = calc.diaSemanaCalculado;
	}

	// Validação de limite: máximo 4 ao total por dia da semana
	const totalNoDia = await contarAgendamentosNoDia(groupId, diaAlvo);
	if (totalNoDia >= 4) {
		const nomeDia = DIAS_SEMANA_NOMES[diaAlvo];
		throw new Error(
			`Limite atingido! O grupo já possui 4 agendamentos programados para ${nomeDia}. Use !g-${tipo}-lista para ver e !g-${tipo}-del <id> para remover um antes de adicionar outro.`
		);
	}

	const id = await gerarProximoId(groupId);
	const criadoEm = Date.now();

	await database.dbRun(
		dbName,
		`INSERT INTO grupo_agendamentos (
			id, group_id, bot_id, tipo, hora, minuto, dia_semana, timestamp_unico, frase, ativo, criado_em
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
		[id, groupId, botId, tipo, hora, minuto, diaSemana ?? null, timestampUnico, frase, criadoEm]
	);

	const agendamento = {
		id,
		group_id: groupId,
		bot_id: botId,
		tipo,
		hora,
		minuto,
		dia_semana: diaSemana ?? null,
		timestamp_unico: timestampUnico,
		frase,
		ativo: 1,
		criado_em: criadoEm
	};

	if (timestampUnico && bot) {
		armarTimerUnico(bot, agendamento);
	}

	return {
		agendamento,
		diffMs,
		isTomorrow,
		diaAlvo
	};
}

/**
 * Lista agendamentos ativos de um grupo
 * Se tipo for especificado ('fechar' ou 'abrir'), filtra por tipo
 */
async function listarAgendamentos(groupId, tipo = null) {
	let query = `SELECT * FROM grupo_agendamentos WHERE group_id = ? AND ativo = 1`;
	const params = [groupId];

	if (tipo) {
		query += ` AND tipo = ?`;
		params.push(tipo);
	}

	const rows = await database.dbAll(dbName, query, params);
	if (!rows) return [];

	const agora = Date.now();

	// Ordena: primeiro os agendados apenas horários (únicos por timestamp_unico ASC)
	// depois os por dia da semana (por dia_semana ASC, depois hora/minuto ASC)
	const unicos = rows
		.filter((r) => r.dia_semana === null || r.dia_semana === undefined)
		.sort((a, b) => (a.timestamp_unico || 0) - (b.timestamp_unico || 0));

	const semanais = rows
		.filter((r) => r.dia_semana !== null && r.dia_semana !== undefined)
		.sort((a, b) => {
			if (a.dia_semana !== b.dia_semana) return a.dia_semana - b.dia_semana;
			if (a.hora !== b.hora) return a.hora - b.hora;
			return a.minuto - b.minuto;
		});

	return [...unicos, ...semanais];
}

/**
 * Desativa um agendamento (ativo = 0)
 */
async function deletarAgendamento(groupId, id, tipo = null) {
	const cleanId = id.trim().toUpperCase();

	let query = `SELECT * FROM grupo_agendamentos WHERE group_id = ? AND id = ? AND ativo = 1`;
	const params = [groupId, cleanId];
	if (tipo) {
		query += ` AND tipo = ?`;
		params.push(tipo);
	}

	const row = await database.dbGet(dbName, query, params);
	if (!row) {
		return null;
	}

	await database.dbRun(
		dbName,
		`UPDATE grupo_agendamentos SET ativo = 0 WHERE group_id = ? AND id = ?`,
		[groupId, cleanId]
	);

	// Cancela timer se for único
	const key = `${groupId}:${cleanId}`;
	if (activeTimeouts.has(key)) {
		clearTimeout(activeTimeouts.get(key));
		activeTimeouts.delete(key);
	}

	return row;
}

module.exports = {
	DIAS_SEMANA_NOMES,
	DIAS_MAP,
	getNowBrasilia,
	getDiaSemanaBrasilia,
	parseHora,
	parseDiaSemana,
	formatarHora,
	formatarTempoRestante,
	sanitizarFrase,
	calcularTimestampUnico,
	gerarProximoId,
	inicializarAgendamentos,
	contarAgendamentosNoDia,
	criarAgendamento,
	listarAgendamentos,
	deletarAgendamento,
	executarAgendamento,
	verificarAgendamentosSemanais,
	getBotParaAgendamento
};
