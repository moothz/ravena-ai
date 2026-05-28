const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const Database = require("../utils/Database");
const axios = require("axios");
const cron = require("node-cron");

const logger = new Logger("correios-commands");
const database = Database.getInstance();
const DB_NAME = "correios";

// Early return if CORREIOS_API is not defined
if (!process.env.CORREIOS_API) {
	logger.warn("[Correios] CORREIOS_API não definida no .env. Comandos desativados.");
	module.exports = {
		commands: [],
		inicializarRastreio: async () => {}
	};
	return;
}

const urlAPICorreios = process.env.CORREIOS_API.replace(/\/$/, "");

function getStatusEmoji(status) {
	const text = (status || "").toLowerCase();
	if (text.includes("entregue")) return "✅";
	if (text.includes("saiu para entrega") || text.includes("destinatário")) return "🚚";
	if (text.includes("transferência") || text.includes("encaminhado")) return "✈️";
	if (text.includes("postado") || text.includes("recebido")) return "📦";
	if (text.includes("corretores") || text.includes("fiscalização") || text.includes("tributado"))
		return "💸";
	if (text.includes("aguardando retirada") || text.includes("agência")) return "🏪";
	if (text.includes("não entregue") || text.includes("erro") || text.includes("devolvido"))
		return "⚠️";
	return "📌";
}

function formatEventLocation(unidade) {
	if (!unidade) return "Não informado";
	const tipo = unidade.tipo || "";
	const endereco = unidade.endereco || {};
	const cidade = endereco.cidade ? endereco.cidade.trim() : "";
	const uf = endereco.uf ? endereco.uf.trim() : "";

	let loc = "";
	if (tipo) loc += `*${tipo}*`;
	if (cidade || uf) {
		if (loc) loc += " - ";
		loc += `${cidade}/${uf}`;
	}
	return loc || "Não informado";
}

function formatDate(dateStr) {
	if (!dateStr) return "-";
	try {
		const parts = dateStr.split(" ");
		const dateParts = parts[0].split("-");
		if (dateParts.length === 3) {
			const timeParts = parts[1] ? parts[1].split(":") : [];
			const formattedDate = `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`;
			const formattedTime = timeParts.length >= 2 ? ` às ${timeParts[0]}:${timeParts[1]}` : "";
			return `${formattedDate}${formattedTime}`;
		}
	} catch (e) {}
	return dateStr;
}

/**
 * Initializes the Correios tracking database and background task
 */
async function inicializarRastreio(bot) {
	try {
		await database.getSQLiteDb(
			DB_NAME,
			`
			CREATE TABLE IF NOT EXISTS tracks (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id TEXT,
				chat_id TEXT,
				code TEXT,
				description TEXT,
				last_event_text TEXT,
				last_event_date TEXT,
				last_check INTEGER,
				UNIQUE(chat_id, code)
			);
			`,
			true
		);

		// Start cron job: every 15 minutes
		cron.schedule("*/15 * * * *", async () => {
			logger.info("[CorreiosCron] Iniciando verificação de pacotes...");
			await checkAllPackages(bot);
		});

		logger.info("[Correios] Sistema de rastreio inicializado com sucesso.");
	} catch (error) {
		logger.error("[Correios] Erro ao inicializar sistema:", error);
	}
}

/**
 * Checks all registered packages for updates
 */
async function checkAllPackages(bot) {
	try {
		const tracks = await database.dbAll(DB_NAME, "SELECT * FROM tracks");
		logger.debug(`[CorreiosCron] Verificando ${tracks.length} pacotes.`);

		for (const track of tracks) {
			try {
				const result = await trackCode(track.code);
				if (!result || !result.events || result.events.length === 0) continue;

				const lastEvent = result.events[0];
				const currentText = lastEvent.descricao;
				const currentDate = lastEvent.dtHrCriado.date;

				// If status changed
				if (currentText !== track.last_event_text || currentDate !== track.last_event_date) {
					logger.info(
						`[CorreiosCron] Atualização encontrada para ${track.code} (${track.description})`
					);

					// Update DB
					await database.dbRun(
						DB_NAME,
						"UPDATE tracks SET last_event_text = ?, last_event_date = ?, last_check = ? WHERE id = ?",
						[currentText, currentDate, Date.now(), track.id]
					);

					// Notify user
					const statusEmoji = getStatusEmoji(currentText);
					const locationText = formatEventLocation(lastEvent.unidade);
					const formattedDate = formatDate(currentDate);

					const msg =
						`📦 *ATUALIZAÇÃO DE RASTREIO*\n\n` +
						`📋 *Pacote:* ${track.description}\n` +
						`🔢 *Código:* \`${track.code}\`\n\n` +
						`${statusEmoji} *Status:* ${currentText}\n` +
						`📍 *Local:* ${locationText}\n` +
						`📅 *Data:* ${formattedDate}`;

					bot
						.sendMessage(track.chat_id, msg)
						.catch((e) => logger.error(`Erro ao notificar ${track.chat_id}:`, e));
				} else {
					// Just update last check
					await database.dbRun(DB_NAME, "UPDATE tracks SET last_check = ? WHERE id = ?", [
						Date.now(),
						track.id
					]);
				}

				// Sleep a bit between requests to avoid rate limit
				await new Promise((r) => setTimeout(r, 1000));
			} catch (e) {
				logger.error(`[CorreiosCron] Erro ao verificar código ${track.code}:`, e.message);
			}
		}
	} catch (error) {
		logger.error("[CorreiosCron] Erro geral na verificação:", error);
	}
}

/**
 * Tracks a code using the local tracking API
 */
async function trackCode(code) {
	try {
		const response = await axios.get(`${urlAPICorreios}/fetch/${code}`, { timeout: 10000 });
		return response.data;
	} catch (error) {
		if (error.response && error.response.status === 404) {
			logger.warn(`[CorreiosAPI] Código ${code} ainda não possui dados no rastreador (404).`);
			return { events: [] };
		}
		logger.error(`[CorreiosAPI] Erro ao consultar ${code}:`, error.message);
		return null;
	}
}

/**
 * Command: !correios [code] [description]
 */
async function correiosCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	const userId = message.author;

	if (args.length === 0) {
		return new ReturnMessage({
			chatId,
			content:
				"📦 *Rastreio de Objetos (Correios)*\n\nUso: !correios [CÓDIGO] [DESCRIÇÃO]\nExemplo: !correios NA123456789BR Monitor Novo\n\nComandos extras:\n!correios-lista\n!correios-del [CÓDIGO]",
			options: { quotedMessageId: message.origin.id._serialized }
		});
	}

	const code = args[0].toUpperCase();
	const description = args.slice(1).join(" ") || "Meu Pacote";

	if (!/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(code)) {
		return new ReturnMessage({
			chatId,
			content: "❌ Formato de código inválido. Use o padrão (ex: AA123456789BR).",
			options: { quotedMessageId: message.origin.id._serialized }
		});
	}

	try {
		// Check if already tracking in this chat
		const existing = await database.dbGet(
			DB_NAME,
			"SELECT * FROM tracks WHERE chat_id = ? AND code = ?",
			[chatId, code]
		);
		if (existing) {
			const result = await trackCode(existing.code);
			let lastText = existing.last_event_text;
			let lastDate = existing.last_event_date;
			let statusEmoji = getStatusEmoji(lastText);
			let locationText = "Fila de rastreamento";

			if (result && result.events && result.events.length > 0) {
				const lastEvent = result.events[0];
				const currentText = lastEvent.descricao;
				const currentDate = lastEvent.dtHrCriado.date;

				if (currentText !== existing.last_event_text || currentDate !== existing.last_event_date) {
					await database.dbRun(
						DB_NAME,
						"UPDATE tracks SET last_event_text = ?, last_event_date = ?, last_check = ? WHERE id = ?",
						[currentText, currentDate, Date.now(), existing.id]
					);
					lastText = currentText;
					lastDate = currentDate;
				}
				statusEmoji = getStatusEmoji(lastText);
				locationText = formatEventLocation(lastEvent.unidade);
			}

			if (
				lastDate === "-" ||
				lastText === "Aguardando Dados" ||
				lastText === "Aguardando postagem / Sincronização"
			) {
				return new ReturnMessage({
					chatId,
					content:
						`📋 *Pacote:* ${existing.description}\n` +
						`🔢 *Código:* \`${existing.code}\`\n\n` +
						`⚠️ Ainda não há dados de rastreamento para este objeto.`,
					options: { quotedMessageId: message.origin.id._serialized }
				});
			}

			const formattedDate = lastDate !== "-" ? formatDate(lastDate) : "-";

			return new ReturnMessage({
				chatId,
				content:
					`📋 *Pacote:* ${existing.description}\n` +
					`🔢 *Código:* \`${existing.code}\`\n\n` +
					`${statusEmoji} *Status Atual:* ${lastText}\n` +
					`📍 *Local:* ${locationText}\n` +
					`📅 *Última Atualização:* ${formattedDate}`,
				options: { quotedMessageId: message.origin.id._serialized }
			});
		}

		// Register with API
		let estMinutes = 15;
		try {
			const apiRes = await axios.post(`${urlAPICorreios}/track`, { code }, { timeout: 10000 });
			estMinutes = apiRes.data.estimated_minutes_until_sync || 15;
		} catch (apiError) {
			logger.error(`[CorreiosAPI] Erro ao registrar ${code} via POST:`, apiError.message);
		}

		// Initial lookup
		const result = await trackCode(code);
		let lastText = "Aguardando Dados";
		let lastDate = "-";
		let statusEmoji = "⏳";
		let locationText = "Fila de rastreamento";

		if (result && result.events && result.events.length > 0) {
			const lastEvent = result.events[0];
			lastText = lastEvent.descricao;
			lastDate = lastEvent.dtHrCriado.date;
			statusEmoji = getStatusEmoji(lastText);
			locationText = formatEventLocation(lastEvent.unidade);
		}

		await database.dbRun(
			DB_NAME,
			"INSERT INTO tracks (user_id, chat_id, code, description, last_event_text, last_event_date, last_check) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[userId, chatId, code, description, lastText, lastDate, Date.now()]
		);

		const formattedDate = lastDate !== "-" ? formatDate(lastDate) : "-";
		const timeMsg = estMinutes > 0 ? ` (Sincronização estimada em ~${estMinutes} minutos)` : "";

		return new ReturnMessage({
			chatId,
			content:
				`✅ *Rastreio Adicionado com Sucesso!*\n\n` +
				`📋 *Pacote:* ${description}\n` +
				`🔢 *Código:* \`${code}\`\n\n` +
				`${statusEmoji} *Status Atual:* ${lastText}\n` +
				`📍 *Local:* ${locationText}\n` +
				`📅 *Última Atualização:* ${formattedDate}\n\n` +
				`🔔 Você será notificado neste chat sempre que o status mudar.${timeMsg}`,
			options: { quotedMessageId: message.origin.id._serialized }
		});
	} catch (error) {
		logger.error("Error in correiosCommand:", error);
		return new ReturnMessage({
			chatId,
			content: "❌ Erro ao adicionar rastreio.",
			options: { quotedMessageId: message.origin.id._serialized }
		});
	}
}

/**
 * Command: !correios-lista
 */
async function correiosListaCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	try {
		const tracks = await database.dbAll(DB_NAME, "SELECT * FROM tracks WHERE chat_id = ?", [
			chatId
		]);

		if (tracks.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "📭 Nenhum pacote sendo rastreado neste chat.",
				options: { quotedMessageId: message.origin.id._serialized }
			});
		}

		let list = `📦 *PACOTES SENDO RASTREADOS (${tracks.length})*\n\n`;
		for (const track of tracks) {
			// Query central API on-demand to show the most recent status
			const result = await trackCode(track.code);
			let lastText = track.last_event_text;
			let lastDate = track.last_event_date;

			if (result && result.events && result.events.length > 0) {
				const lastEvent = result.events[0];
				const currentText = lastEvent.descricao;
				const currentDate = lastEvent.dtHrCriado.date;

				if (currentText !== track.last_event_text || currentDate !== track.last_event_date) {
					// Update local DB to avoid double alerting later
					await database.dbRun(
						DB_NAME,
						"UPDATE tracks SET last_event_text = ?, last_event_date = ?, last_check = ? WHERE id = ?",
						[currentText, currentDate, Date.now(), track.id]
					);
					lastText = currentText;
					lastDate = currentDate;
				}
			}

			let displayStatus = lastText;
			let statusEmoji = getStatusEmoji(lastText);
			if (
				lastDate === "-" ||
				lastText === "Aguardando Dados" ||
				lastText === "Aguardando postagem / Sincronização"
			) {
				displayStatus = "Sem dados ainda";
				statusEmoji = "⏳";
			}

			let locationStr = "";
			if (result && result.events && result.events.length > 0) {
				const lastEvent = result.events[0];
				if (lastEvent.unidade && lastEvent.unidade.endereco) {
					const cidade = lastEvent.unidade.endereco.cidade
						? lastEvent.unidade.endereco.cidade.trim()
						: "";
					const uf = lastEvent.unidade.endereco.uf ? lastEvent.unidade.endereco.uf.trim() : "";
					if (cidade && uf) {
						locationStr = `[${cidade}/${uf}] `;
					} else if (cidade || uf) {
						locationStr = `[${cidade || uf}] `;
					}
				}
			}

			const formattedDate = lastDate !== "-" ? formatDate(lastDate) : "-";
			list += `• \`${track.code}\` - *${track.description}*\n`;
			list += `  ${statusEmoji} ${locationStr}_${displayStatus}_ (${formattedDate})\n\n`;
		}

		return new ReturnMessage({
			chatId,
			content: list,
			options: { quotedMessageId: message.origin.id._serialized }
		});
	} catch (error) {
		logger.error("Error in correiosListaCommand:", error);
		return new ReturnMessage({
			chatId,
			content: "❌ Erro ao listar pacotes.",
			options: { quotedMessageId: message.origin.id._serialized }
		});
	}
}

/**
 * Command: !correios-del [code]
 */
async function correiosDelCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	if (args.length === 0) {
		return new ReturnMessage({
			chatId,
			content: "❌ Informe o código que deseja remover. Ex: !correios-del NA123456789BR",
			options: { quotedMessageId: message.origin.id._serialized }
		});
	}

	const code = args[0].toUpperCase();

	try {
		const result = await database.dbRun(
			DB_NAME,
			"DELETE FROM tracks WHERE chat_id = ? AND code = ?",
			[chatId, code]
		);

		if (result && result.changes > 0) {
			// Check if any other chat is still tracking this code
			const others = await database.dbGet(DB_NAME, "SELECT id FROM tracks WHERE code = ?", [code]);
			if (!others) {
				// No one else is tracking, we can untrack from our Express API!
				try {
					await axios.post(`${urlAPICorreios}/untrack`, { code }, { timeout: 5000 });
				} catch (err) {
					logger.error(`[CorreiosAPI] Erro ao untrack ${code} na API:`, err.message);
				}
			}
			return new ReturnMessage({
				chatId,
				content: `✅ Rastreio do código \`${code}\` removido com sucesso.`,
				options: { quotedMessageId: message.origin.id._serialized }
			});
		} else {
			return new ReturnMessage({
				chatId,
				content: `⚠️ Código \`${code}\` não encontrado no rastreio deste chat.`,
				options: { quotedMessageId: message.origin.id._serialized }
			});
		}
	} catch (error) {
		logger.error("Error in correiosDelCommand:", error);
		return new ReturnMessage({
			chatId,
			content: "❌ Erro ao remover rastreio.",
			options: { quotedMessageId: message.origin.id._serialized }
		});
	}
}

const commands = [
	new Command({
		name: "correios",
		description: "Rastreia uma encomenda dos Correios",
		category: "utilidades",
		reactions: {
			before: "📦",
			after: "✅"
		},
		method: correiosCommand
	}),
	new Command({
		name: "correios-lista",
		description: "Lista encomendas sendo rastreadas no chat",
		category: "utilidades",
		reactions: {
			before: "📋"
		},
		method: correiosListaCommand
	}),
	new Command({
		name: "correios-del",
		description: "Para de rastrear uma encomenda",
		category: "utilidades",
		reactions: {
			before: "🗑️",
			after: "✅"
		},
		method: correiosDelCommand
	})
];

module.exports = { commands, inicializarRastreio };
