const path = require("path");
const fs = require("fs").promises;
const fsSync = require("fs");
const mime = require("mime-types");
const Logger = require("./utils/Logger");
const LLMService = require("./services/LLMService");
const ReturnMessage = require("./models/ReturnMessage");
const Database = require("./utils/Database");

const logger = new Logger("silly-interaction-handler");
const llmService = LLMService.getInstance();
const database = Database.getInstance();

const nomesBot = ["bot", "boot", "ravena"];

const adjetivosFiltrar = [
	"muito",
	"super",
	"tao",
	"bem",
	"bastante",
	"extremamente",
	"completamente",
	"totalmente",
	"realmente",
	"meio",
	"um pouco",
	"pra caramba",
	"pra krl",
	"demais",
	"e",
	"um",
	"uma"
];

const xingamentosStarts = [
	"lixo",
	"podre",
	"inutil",
	"idiota",
	"bocaberta",
	"imprestavel",
	"ruim",
	"burro",
	"burra",
	"merda",
	"lento",
	"lerdo",
	"lerda",
	"chato",
	"chata",
	"horroroso",
	"horrorosa",
	"tosco",
	"tosca",
	"ridiculo",
	"ridicula",
	"pessimo",
	"pessima",
	"insuportavel"
];

const xingamentosEnds = [
	"odiei o",
	"odiei a",
	"ninguem gosta do",
	"ninguem gosta da",
	"cala boca",
	"cala a boca",
	"vai se ferrar",
	"vai se foder",
	"odeio a",
	"odeio o",
	"que bosta de",
	"que merda de",
	"lixo de",
	"burro esse",
	"burra essa",
	"chato esse",
	"chata essa"
];

const elogiosStart = [
	"lindo",
	"linda",
	"fofo",
	"fofa",
	"maravilhoso",
	"maravilhosa",
	"bom",
	"boa",
	"gostoso",
	"gostosa",
	"perfeito",
	"perfeita",
	"inteligente",
	"util",
	"melhor",
	"incrivel",
	"diva",
	"deusa",
	"monstro",
	"brabo",
	"braba"
];
const elogiosEnd = [
	"amei o",
	"amei a",
	"adorei o",
	"adorei a",
	"amo a",
	"amo o",
	"sou fa da",
	"sou fa do",
	"gosto muito da",
	"gosto muito do",
	"que orgulho da",
	"que orgulho do",
	"obrigado",
	"obrigada",
	"parabens",
	"te amo",
	"te adoro"
];

class SillyInteractionHandler {
	constructor() {
		this.dataDir = path.join(__dirname, "../data/sillies");
		this.dbName = "sillies";
		this.ensureDirectories();
		this.initializeDatabase();
		this.cooldowns = {};
	}

	initializeDatabase() {
		const schema = `CREATE TABLE IF NOT EXISTS stats (category TEXT PRIMARY KEY, count INTEGER DEFAULT 0)`;
		database.getSQLiteDb(this.dbName, schema);
	}

	async ensureDirectories() {
		try {
			await fs.mkdir(path.join(this.dataDir, "elogios"), { recursive: true });
			await fs.mkdir(path.join(this.dataDir, "xingamentos"), { recursive: true });
		} catch (error) {
			logger.error("Erro ao criar diretórios de sillies:", error);
		}
	}

	normalize(text) {
		if (typeof text !== "string") return "";
		return text
			.toLowerCase()
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "");
	}

	async handle(bot, message, group) {
		const chatId = message.group ?? message.author;
		const now = Date.now();
		const COOLDOWN_MS = 30000;

		if (this.cooldowns[chatId] && now - this.cooldowns[chatId] < COOLDOWN_MS) {
			return false;
		}

		let text = message.content || message.caption;
		if (!text || typeof text !== "string") return false;

		// Limpa espaços e markup de monospace do WhatsApp (backticks)
		text = text.trim();
		if (text.startsWith("`") && text.endsWith("`")) {
			text = text.slice(1, -1).trim();
		}

		let normalizedText = this.normalize(text).trim();

		// Filtrar adjetivos de intensidade e conectivos
		for (const adj of adjetivosFiltrar) {
			const normAdj = this.normalize(adj);
			// Regex para remover a palavra exata com espaços ao redor
			const regex = new RegExp(`\\b${normAdj}\\b`, "gi");
			normalizedText = normalizedText.replace(regex, "").replace(/\s+/g, " ").trim();
		}

		let category = null;
		const currentNomes = [...nomesBot];
		if (bot.nomeExibir) {
			currentNomes.push(bot.nomeExibir);
		}
		const normalizedNomes = currentNomes.map((n) => this.normalize(n));

		const checkMatch = (botAtStartArr, botAtEndArr) => {
			for (const nome of normalizedNomes) {
				// Caso: Nome do bot no início, elemento no fim (ex: "ravena lixo")
				for (const s of botAtStartArr) {
					const normS = this.normalize(s);
					if (normalizedText.startsWith(nome) && normalizedText.endsWith(normS)) {
						return true;
					}
				}
				// Caso: Elemento no início, nome do bot no fim (ex: "odiei o boot")
				for (const e of botAtEndArr) {
					const normE = this.normalize(e);
					if (normalizedText.startsWith(normE) && normalizedText.endsWith(nome)) {
						return true;
					}
				}
			}
			return false;
		};

		if (checkMatch(xingamentosStarts, xingamentosEnds)) {
			category = "xingamentos";
		} else if (checkMatch(elogiosStart, elogiosEnd)) {
			category = "elogios";
		}

		if (!category) return false;

		// Update tracking
		await database.dbRun(
			this.dbName,
			`INSERT INTO stats (category, count) VALUES (?, 1)
			 ON CONFLICT(category) DO UPDATE SET count = count + 1`,
			[category]
		);

		// Update cooldown early to avoid spam if generation takes time
		this.cooldowns[chatId] = now;

		logger.info(`Silly interaction detected (${category}) from ${message.author}`);

		// 25% LLM, 75% Sticker
		if (Math.random() < 0.25) {
			return await this.handleLLM(bot, message, category);
		} else {
			return await this.handleSticker(bot, message, category);
		}
	}

	async handleLLM(bot, message, category) {
		const nomePessoa = message.name || message.pushName || message.authorName || "usuário";
		const msgRecebida = message.content || message.caption;

		let prompt = "";
		if (category === "xingamentos") {
			prompt = `Usuário ${nomePessoa} te xingou falando '${msgRecebida}'. Responda xingando ele de volta, mandando ele respeitar ou se colocar no lugar ele, ou ficar bem quieto, ou qualquer outra resposta witty, esperta, seja criativo e engraçado.`;
		} else {
			prompt = `Usuário ${nomePessoa} te elogiou falando '${msgRecebida}'. Responda de forma fofa, agradecendo e sendo gentil como a ${bot.nomeExibir || "ravena"}.`;
		}

		try {
			const response = await llmService.getCompletion({
				prompt,
				priority: 5,
				systemContext:
					"Sua personalidade: Atrevida se for xingada, fofa e gentil se for elogiada. Não use muitas emojis."
			});

			const returnMsg = new ReturnMessage({
				chatId: message.group ?? message.author,
				content: response,
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});

			await bot.sendReturnMessages(returnMsg);
			return true;
		} catch (error) {
			logger.error("Erro ao gerar resposta LLM silly:", error);
			return await this.handleSticker(bot, message, category);
		}
	}

	async handleSticker(bot, message, category) {
		const folder = path.join(this.dataDir, category);
		try {
			const files = await fs.readdir(folder);
			const stickerFiles = files.filter((f) => /\.(webp|png|jpg|jpeg|gif)$/i.test(f));

			if (stickerFiles.length === 0) {
				logger.warn(`Nenhum sticker encontrado em ${folder}`);
				// Se for elogio e não tiver sticker, talvez responder com texto simples?
				return false;
			}

			const randomFile = stickerFiles[Math.floor(Math.random() * stickerFiles.length)];
			const filePath = path.join(folder, randomFile);

			const fileBuffer = await fs.readFile(filePath);
			const mimeType = mime.lookup(filePath) || "application/octet-stream";
			const media = {
				mimetype: mimeType,
				data: fileBuffer.toString("base64"),
				filename: path.basename(filePath),
				isMessageMedia: true
			};

			const returnMsg = new ReturnMessage({
				chatId: message.group ?? message.author,
				content: media,
				options: {
					sendMediaAsSticker: true,
					stickerAuthor: bot.nomeExibir || "Ravena",
					stickerName: "Silly",
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});

			await bot.sendReturnMessages(returnMsg);
			return true;
		} catch (error) {
			logger.error(`Erro ao enviar sticker silly de ${folder}:`, error);
			return false;
		}
	}
}

module.exports = new SillyInteractionHandler();
