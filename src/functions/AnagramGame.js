/**
 * @file Gerencia a lógica do jogo Anagrama para o bot.
 * @author Zacksb
 */

const path = require("path");
const fs = require("fs").promises;
const fsSync = require("fs");
const Logger = require("../utils/Logger");
const ReturnMessage = require("../models/ReturnMessage");
const Command = require("../models/Command");
const Database = require("../utils/Database");
const Canvas = require("canvas");
const LLMService = require("../services/LLMService");

const llmService = LLMService.getInstance();
const logger = new Logger("anagrama-game");
const database = Database.getInstance();
const dbName = "anagrama";

// --- Configurações do Banco de Dados ---
database.getSQLiteDb(
	dbName,
	`
CREATE TABLE IF NOT EXISTS anagram_groups (
  group_id TEXT PRIMARY KEY,
  record_round INTEGER DEFAULT 0,
  total_tries INTEGER DEFAULT 0,
  total_tips_used INTEGER DEFAULT 0,
  last_updated INTEGER
);
CREATE TABLE IF NOT EXISTS anagram_scores (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT,
  points INTEGER DEFAULT 0,
  tries INTEGER DEFAULT 0,
  correct_guesses INTEGER DEFAULT 0,
  tips_used INTEGER DEFAULT 0,
  last_updated INTEGER,
  PRIMARY KEY (group_id, user_id)
);
`
);

// --- Configurações do Jogo ---
const GAME_DURATION_SECONDS = 60;
const HINTS_PER_ROUND = 3;
const SKIPS_PER_ROUND = 3;

// --- Caminhos ---
const ANAGRAMA_LETTERS_PATH = path.join(database.databasePath, "anagrama", "letters");
const ANAGRAMA_WORDS_PATH = path.join(database.databasePath, "anagrama", "words");

// --- Estado do Jogo ---
/**
 * Armazena os jogos ativos por ID de grupo.
 * @type {Object<string, import('./AnagramGame').GameSession>}
 */
const activeGames = {};

/**
 * @typedef {Object} GameSession
 * @property {number} round
 * @property {number} hintsUsed
 * @property {number} skipsUsed
 * @property {string} word
 * @property {string} scrambledWord
 * @property {NodeJS.Timeout} timer
 * @property {boolean[]} revealedLetters
 */

/**
 * Lê palavras de um arquivo de texto.
 * @param {"portuguese" | "english"} language Idioma das palavras.
 * @returns {string[]}
 */
function readWordsFromFile(language) {
	try {
		const filePath = path.join(ANAGRAMA_WORDS_PATH, `${language}.txt`);
		return fsSync.readFileSync(filePath, "utf8").split("\n").filter(Boolean); // filter(Boolean) remove linhas vazias
	} catch (error) {
		logger.warn(`Arquivo de palavras para "${language}" não encontrado. Usando lista de fallback.`);
		return [
			"laranja",
			"computador",
			"biblioteca",
			"desenvolvedor",
			"inteligencia",
			"paralelepipedo",
			"ornitorrinco",
			"felicidade",
			"aventura",
			"tecnologia",
			"abacaxi",
			"bicicleta",
			"hipopotamo",
			"rinoceronte",
			"independencia"
		];
	}
}

const WORD_LIST = readWordsFromFile("portuguese");

// --- Gerenciamento de Dados (SQLite) ---

async function getGroupData(groupId) {
	try {
		const row = await database.dbGet(dbName, "SELECT * FROM anagram_groups WHERE group_id = ?", [
			groupId
		]);
		return row || { record_round: 0, total_tries: 0, total_tips_used: 0 };
	} catch (error) {
		logger.error("Erro ao buscar dados do grupo:", error);
		return { record_round: 0, total_tries: 0, total_tips_used: 0 };
	}
}

async function updateGroupRecord(groupId, round) {
	const timestamp = Date.now();
	try {
		await database.dbRun(
			dbName,
			`
      INSERT INTO anagram_groups (group_id, record_round, last_updated)
      VALUES (?, ?, ?)
      ON CONFLICT(group_id) DO UPDATE SET 
        record_round = MAX(record_round, excluded.record_round),
        last_updated = excluded.last_updated
    `,
			[groupId, round, timestamp]
		);
	} catch (error) {
		logger.error("Erro ao atualizar recorde do grupo:", error);
	}
}

async function incrementGroupStats(groupId, stat, amount = 1) {
	const timestamp = Date.now();
	try {
		// stat deve ser 'total_tries' ou 'total_tips_used'
		if (!["total_tries", "total_tips_used"].includes(stat)) return;

		await database.dbRun(
			dbName,
			`
      INSERT INTO anagram_groups (group_id, ${stat}, last_updated)
      VALUES (?, ?, ?)
      ON CONFLICT(group_id) DO UPDATE SET 
        ${stat} = ${stat} + ?,
        last_updated = ?
    `,
			[groupId, amount, timestamp, amount, timestamp]
		);
	} catch (error) {
		logger.error(`Erro ao incrementar estatística do grupo ${stat}:`, error);
	}
}

async function updateUserStats(groupId, userId, userName, updates) {
	const timestamp = Date.now();
	try {
		// updates: { points: 1, tries: 1, correct_guesses: 1, tips_used: 1 }
		// Constroi a query dinamicamente baseada nos campos fornecidos
		const fields = ["points", "tries", "correct_guesses", "tips_used"];
		const updateParts = [];
		const values = []; // Initialized empty for UPDATE params

		// Preparação para o INSERT
		const insertFields = ["group_id", "user_id", "user_name", "last_updated"];
		const insertPlaceholders = ["?", "?", "?", "?"];
		const insertValues = [groupId, userId, userName, timestamp];

		fields.forEach((field) => {
			if (updates[field]) {
				insertFields.push(field);
				insertPlaceholders.push("?");
				insertValues.push(updates[field]);

				updateParts.push(`${field} = ${field} + ?`);
				values.push(updates[field]);
			}
		});

		// Adiciona user_name e last_updated no update
		updateParts.push(`user_name = ?`);
		values.push(userName);
		updateParts.push(`last_updated = ?`);
		values.push(timestamp);

		if (updateParts.length === 2) return; // Só user_name e last_updated, nada a incrementar

		const sql = `
      INSERT INTO anagram_scores (${insertFields.join(", ")})
      VALUES (${insertPlaceholders.join(", ")})
      ON CONFLICT(group_id, user_id) DO UPDATE SET
        ${updateParts.join(", ")}
    `;

		// Concatena os valores para o INSERT com os valores para o UPDATE
		await database.dbRun(dbName, sql, [...insertValues, ...values]);
	} catch (error) {
		logger.error("Erro ao atualizar estatísticas do usuário:", error);
	}
}

/**
 * Embaralha os caracteres de uma palavra.
 * @param {string} word A palavra a ser embaralhada.
 * @returns {string} A palavra embaralhada.
 */
function scrambleWord(word) {
	const arr = word.split("");
	let scrambled;
	do {
		for (let i = arr.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[arr[i], arr[j]] = [arr[j], arr[i]];
		}
		scrambled = arr.join("");
	} while (scrambled === word && word.length > 1);
	return scrambled;
}

/**
 * Gera uma imagem com a palavra embaralhada.
 */
async function generateImageText(word, level, record) {
	const spaceBetweenLetters = 2;
	const totalWidth = 512;
	const totalHeight = 512;

	const letterWidth = (totalWidth - (word.length - 1) * spaceBetweenLetters) / word.length;
	const letterHeight = letterWidth;

	const canvas = Canvas.createCanvas(totalWidth, totalHeight);
	const context = canvas.getContext("2d");

	const startX =
		(totalWidth - (word.length * (letterWidth + spaceBetweenLetters) - spaceBetweenLetters)) / 2;
	const startY = (totalHeight - letterHeight) / 2;

	let currentX = startX;

	for (const char of word) {
		let letter = char.toLowerCase();
		if (letter === " ") letter = "space";
		const imagePath = path.join(ANAGRAMA_LETTERS_PATH, `${letter}.png`);

		if (fsSync.existsSync(imagePath)) {
			const letterImage = await Canvas.loadImage(imagePath);
			context.drawImage(letterImage, currentX, startY, letterWidth, letterHeight);
			currentX += letterWidth + spaceBetweenLetters;
		}
	}

	// Configurações de texto para Nível e Recorde
	const fontSize = 40;
	// Correção para negrito e fonte
	context.font = `bold ${fontSize}px "Arial"`;
	context.textAlign = "center";
	context.lineWidth = 5;
	context.strokeStyle = "black";
	context.fillStyle = "white";
	const textX = totalWidth / 2;

	if (level) {
		context.strokeText(level, textX, 45);
		context.fillText(level, textX, 45);
	}
	if (record) {
		context.strokeText(record, textX, totalHeight - 20);
		context.fillText(record, textX, totalHeight - 20);
	}

	return canvas.toBuffer("image/png");
}

/**
 * Finaliza uma partida de anagrama.
 * @param {object} bot Instância do bot.
 * @param {string} groupId ID do grupo.
 * @param {'time_up' | 'reset'} reason Motivo do fim do jogo.
 */
async function endGame(bot, groupId, reason) {
	const game = activeGames[groupId];
	if (!game) return;

	const group = game.group;
	clearTimeout(game.timer);
	delete activeGames[groupId];

	const groupData = await getGroupData(groupId);
	let messageContent = "";

	if (reason === "time_up") {
		const newRecord = game.round > groupData.record_round;
		if (newRecord) {
			await updateGroupRecord(groupId, game.round);
		}

		// Busca ranking da sessão (ou geral? O original mostrava ranking dos que pontuaram)
		// Como agora é DB, vamos buscar os top pontuadores do grupo geral,
		// ou idealmente, apenas os que jogaram agora. Mas o original mantinha "sessionRanking"
		// baseado em activeGames? Não, era baseado em `anagramaData.groups[groupId].scores`.
		// O original acumulava scores. Então vamos mostrar o ranking geral atualizado.

		const sortedPlayers = await database.dbAll(
			dbName,
			`
      SELECT user_name as name, points 
      FROM anagram_scores 
      WHERE group_id = ? 
      ORDER BY points DESC 
      LIMIT 10
    `,
			[groupId]
		);

		const sessionRanking =
			sortedPlayers.length > 0
				? generateRankingText(sortedPlayers, `\n🏆 *Ranking do Grupo*\n\n`)
				: "Ninguém pontuou ainda.";

		messageContent = `⏰ O tempo acabou! A palavra era *"${game.word}"*.\n\nVocês chegaram à *rodada ${game.round}*!\n${sessionRanking}`;
		if (newRecord) {
			messageContent += `\n\n🏆 *NOVO RECORDE DO GRUPO!*`;
		}
	} else if (reason === "reset") {
		messageContent = `⚙️ O jogo de anagrama foi resetado por um administrador.`;
	}

	if (messageContent) {
		bot.sendReturnMessages(new ReturnMessage({ chatId: groupId, content: messageContent }), group);
	}
}

/**
 * Inicia uma nova rodada do jogo.
 */
async function startNewRound(bot, message, group, isFirstRound = true) {
	const groupId = message.group;
	const game = activeGames[groupId];
	if (!game) return;

	clearTimeout(game.timer);

	const word = WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)];
	console.log(`[Anagrama] Grupo: ${groupId}, Palavra: ${word}`);
	const scrambledWord = scrambleWord(word);

	// Calcula dicas permitidas: Base + 1 a cada 3 rodadas completas (iniciando do zero ou 1?)
	// "Every 3 rounds, give the user 1 additional Tip"
	// Interpretado como: Limite aumenta em 1 a cada 3 níveis alcançados.
	const extraHints = Math.floor((game.round - 1) / 3);
	const maxHints = HINTS_PER_ROUND + extraHints;

	// Atualiza o estado da sessão
	Object.assign(game, {
		word,
		scrambledWord,
		revealedLetters: new Array(word.length).fill(false),
		timer: setTimeout(() => endGame(bot, groupId, "time_up"), GAME_DURATION_SECONDS * 1000),
		roundEnded: false,
		maxHints // Armazena o limite atual
	});

	// Reseta hintsUsed e skipsUsed se for rodada nova?
	// O original não resetava?
	// O original em startNewRound:
	// if (isFirstRound) ... hintsLeft = HINTS_PER_ROUND - game.hintsUsed
	// game.hintsUsed era inicializado em startGameCommand com 0.
	// E NÃO ERA RESETADO em startNewRound no código original!
	// Isso significa que as dicas eram por JOGO?
	// "hintsLeft = HINTS_PER_ROUND - game.hintsUsed"
	// Se não resetar, é por jogo inteiro.
	// Vou manter a lógica original de ser por jogo, mas com o limite aumentando.

	const groupData = await getGroupData(groupId);
	const buffer = await generateImageText(
		scrambledWord,
		`⭐ Rodada ${game.round}`,
		`🏆 Recorde: ${groupData.record_round}`
	);

	const media = { mimetype: "image/png", data: buffer.toString("base64"), isMessageMedia: true };
	bot.sendReturnMessages(
		new ReturnMessage({
			chatId: groupId,
			content: media,
			options: { sendMediaAsSticker: true, stickerAuthor: "Ravena", stickerName: group.name }
		}),
		group
	);

	if (isFirstRound) {
		const hintsLeft = game.maxHints - game.hintsUsed;
		const skipsLeft = SKIPS_PER_ROUND - game.skipsUsed;
		let startMessage = `Use *!ana <palpite>* para responder.\n`;
		startMessage += `Você tem ${GAME_DURATION_SECONDS} segundos!\n\n`;
		startMessage += `> 💡 Dicas: ${hintsLeft} | 🐇 Pulos: ${skipsLeft}`;
		bot.sendReturnMessages(new ReturnMessage({ chatId: groupId, content: startMessage }), group);
	}
}

/**
 * Gera o texto do ranking.
 * @param {Array<Object>} users Array de jogadores com nome e pontos.
 * @param {string} [customText] Cabeçalho personalizado.
 * @returns {string}
 */
function generateRankingText(users, customText) {
	const sortedUsers = users; // Já deve vir ordenado do banco
	let rankingText = `${customText ?? "🏆 *Ranking do Grupo*\n\n"}`;
	const emojis = ["🥇", "🥈", "🥉", "🏅", "🎖"];

	sortedUsers.forEach((user, i) => {
		const emoji = emojis[i] ?? "🔸";
		rankingText += `${emoji} ${user.name.trim()} - Pontuação: *${user.points}*\n`;
	});

	return rankingText;
}

// --- Comandos do Jogo ---

async function startGameCommand(bot, message, args, group) {
	const groupId = message.group;
	if (!groupId) {
		return new ReturnMessage({
			chatId: message.author,
			content: "O jogo de anagrama só pode ser jogado em grupos."
		});
	}
	if (activeGames[groupId]) {
		return new ReturnMessage({
			chatId: groupId,
			content: `Já existe uma partida em andamento na *rodada ${activeGames[groupId].round}*! A palavra é: *${activeGames[groupId].scrambledWord}*`,
			options: { quotedMessageId: message.origin.id._serialized }
		});
	}

	// Cria uma nova sessão de jogo
	activeGames[groupId] = {
		round: 1,
		hintsUsed: 0,
		skipsUsed: 0,
		maxHints: HINTS_PER_ROUND,
		group
	};

	startNewRound(bot, message, group, true);
	return null;
}

async function guessCommand(bot, message, args, group) {
	const groupId = message.group;
	const game = activeGames[groupId];
	if (!game) return null; // Ignora palpites se não houver jogo

	const guess = args[0]?.toLowerCase();
	if (!guess) {
		return new ReturnMessage({
			chatId: groupId,
			content: "Você precisa fornecer um palpite. Ex: `!ana palavra`",
			options: { quotedMessageId: message.origin.id._serialized }
		});
	}

	const userId = message.author;
	const userName = message.authorName ?? "Jogador";

	// Registra a tentativa no banco (para stats)
	await incrementGroupStats(groupId, "total_tries", 1);
	await updateUserStats(groupId, userId, userName, { tries: 1 });

	if (guess === game.word.toLowerCase()) {
		if (game.roundEnded) return null;
		game.roundEnded = true;

		// Atualiza a pontuação e acertos
		await updateUserStats(groupId, userId, userName, { points: 1, correct_guesses: 1 });

		const successMessage = `🎉 *${userName} acertou!*`;

		game.round++; // Incrementa a rodada SÓ no acerto

		// Verifica se ganhou dica extra (apenas informativo, a lógica está no startNewRound)
		// "Every 3 rounds" -> se completou 3, 6, 9...
		// Se acabou de completar a rodada 3 (agora indo para 4), ganhou +1?
		// A logica no startNewRound usa (round-1)/3.
		// Rodada 1 -> 0 extra. Rodada 4 -> 1 extra.
		// Então ao completar a 3, indo para 4, ganha 1.

		bot.sendReturnMessages(
			new ReturnMessage({
				chatId: message.group,
				content: `${successMessage}\n\n🔄 Iniciando próxima rodada... 🌟 *Level ${game.round}*`
			}),
			group
		);

		setTimeout(() => {
			startNewRound(bot, message, group, false);
		}, 2000); // 2 segundos de delay
	} else {
		// Reage com base na similaridade
		const distance = (s1, s2) => {
			/* Implementação de Levenshtein */
			const costs = [];
			for (let i = 0; i <= s1.length; i++) {
				let lastValue = i;
				for (let j = 0; j <= s2.length; j++) {
					if (i === 0) costs[j] = j;
					else if (j > 0) {
						let newValue = costs[j - 1];
						if (s1.charAt(i - 1) !== s2.charAt(j - 1))
							newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
						costs[j - 1] = lastValue;
						lastValue = newValue;
					}
				}
				if (i > 0) costs[s2.length] = lastValue;
			}
			return costs[s2.length];
		};
		const similarity = 1 - distance(guess, game.word) / Math.max(guess.length, game.word.length);

		let reaction = "🥶"; // Frio
		if (similarity > 0.8)
			reaction = "🔥"; // Quente
		else if (similarity > 0.5) reaction = "🥵"; // Morno

		// Opcional: Reagir à mensagem (se o bot suportar)
		// bot.react(message.origin, reaction);
	}
	return null;
}

async function hintCommand(bot, message) {
	const groupId = message.group;
	const game = activeGames[groupId];
	if (!game) return new ReturnMessage({ chatId: groupId, content: "Não há um jogo em andamento." });

	// Usa o limite dinâmico calculado no início da rodada
	if (game.hintsUsed >= game.maxHints)
		return new ReturnMessage({
			chatId: groupId,
			content: "> As dicas para esta partida já acabaram!"
		});

	const unrevealedIndices = game.revealedLetters
		.map((revealed, i) => (revealed ? null : i))
		.filter((i) => i !== null);
	if (unrevealedIndices.length <= 2)
		return new ReturnMessage({ chatId: groupId, content: "> A palavra já está muito revelada!" });

	const randomIndex = unrevealedIndices[Math.floor(Math.random() * unrevealedIndices.length)];
	game.revealedLetters[randomIndex] = true;
	game.hintsUsed++;

	// Registra uso de dica no banco
	const userId = message.author;
	const userName = message.authorName ?? "Jogador";
	await incrementGroupStats(groupId, "total_tips_used", 1);
	await updateUserStats(groupId, userId, userName, { tips_used: 1 });

	const hintDisplay = game.word
		.split("")
		.map((char, i) => (game.revealedLetters[i] ? ` ${char.toUpperCase()} ` : " __ "))
		.join("");
	const hintsLeft = game.maxHints - game.hintsUsed;

	let dicaIA = "";
	try {
		const respostaIA = await llmService.getCompletion({
			prompt: `O usuário requisitou uma dica, responda ((apenas)) com: sinônimo ou frase que ajude.\n\nPalavra: ${game.word}`,
			systemContext: "Você é um robo que está controlando um jogo de Anagrama",
			priority: 5,
			timeout: 30000
		});
		if (respostaIA && !respostaIA.toLowerCase().includes("erro")) {
			dicaIA = `\nℹ️ *Dica:* _${respostaIA}_\n`;
		}
	} catch (e) {
		logger.error("Erro na dica IA", e);
	}

	return new ReturnMessage({
		chatId: groupId,
		content: `📝 ${hintDisplay}\n${dicaIA}\n> 💡 Você tem mais ${hintsLeft} dica(s) nesta partida.`
	});
}

async function skipCommand(bot, message, args, group) {
	const groupId = message.group;
	const game = activeGames[groupId];
	if (!game)
		return new ReturnMessage({
			chatId: groupId,
			content: "> Não há um jogo em andamento para pular."
		});
	if (game.roundEnded) return null;
	if (game.skipsUsed >= SKIPS_PER_ROUND)
		return new ReturnMessage({
			chatId: groupId,
			content: "> Os pulos para esta rodada já acabaram!"
		});

	game.roundEnded = true;
	game.skipsUsed++;
	const skipsLeft = SKIPS_PER_ROUND - game.skipsUsed;
	const skippedWord = game.word;

	bot.sendReturnMessages(
		new ReturnMessage({
			chatId: groupId,
			content: `⏭️ A palavra *"${skippedWord}"* foi pulada!\n\n> 🐇 Pulos restantes: ${skipsLeft}\n\n🔄 Carregando nova palavra para a *rodada ${game.round}*...`
		}),
		group
	);

	// Inicia a próxima rodada (com uma nova palavra, mas no mesmo nível)
	setTimeout(() => {
		startNewRound(bot, message, group, false);
	}, 2000); // 2 segundos de delay

	return null;
}

async function rankingCommand(bot, message) {
	const groupId = message.group;
	if (!groupId)
		return new ReturnMessage({
			chatId: message.author,
			content: "> O ranking só pode ser visto em grupos."
		});

	try {
		const groupData = await getGroupData(groupId);

		const topPlayers = await database.dbAll(
			dbName,
			`
      SELECT user_name as name, points 
      FROM anagram_scores 
      WHERE group_id = ? 
      ORDER BY points DESC 
      LIMIT 15
    `,
			[groupId]
		);

		if (topPlayers.length === 0 && !groupData.record_round) {
			return new ReturnMessage({
				chatId: groupId,
				content:
					"🏆 Ainda não há dados de Anagrama para este grupo. Comece a jogar com `!anagrama`!"
			});
		}

		let rankingMessage = "";

		if (topPlayers.length === 0) {
			rankingMessage += "📊 *Ainda não há jogadores no ranking.*";
		} else {
			rankingMessage += generateRankingText(topPlayers);
		}
		rankingMessage += `\n📈 *Recorde do Grupo:* ${groupData.record_round} rodadas`;

		// Adiciona stats extras se houver (opcional)
		if (groupData.total_tries > 0) {
			rankingMessage += `\n🎯 *Total de Tentativas do Grupo:* ${groupData.total_tries}`;
		}

		return new ReturnMessage({ chatId: groupId, content: rankingMessage });
	} catch (error) {
		logger.error("Erro no comando ranking:", error);
		return new ReturnMessage({ chatId: groupId, content: "❌ Erro ao buscar ranking." });
	}
}

async function resetCommand(bot, message, args, group) {
	const groupId = message.group;
	if (!groupId)
		return new ReturnMessage({
			chatId: message.author,
			content: "Este comando só funciona em grupos."
		});
	const isAdmin = await bot.adminUtils.isAdmin(message.author, group, null, bot);
	if (!isAdmin)
		return new ReturnMessage({
			chatId: groupId,
			content: "❌ Apenas administradores podem resetar os dados."
		});

	if (activeGames[groupId]) {
		endGame(bot, groupId, "reset");
	}

	try {
		// Reseta dados do banco
		await database.dbRun(dbName, "DELETE FROM anagram_groups WHERE group_id = ?", [groupId]);
		await database.dbRun(dbName, "DELETE FROM anagram_scores WHERE group_id = ?", [groupId]);

		return new ReturnMessage({
			chatId: groupId,
			content: "✅ O ranking e recorde do Anagrama para este grupo foram resetados!"
		});
	} catch (error) {
		logger.error("Erro ao resetar dados:", error);
		return new ReturnMessage({ chatId: groupId, content: "❌ Erro ao resetar dados do grupo." });
	}
}

// --- Definição dos Comandos ---
const commands = [
	new Command({
		name: "anagrama",
		description: "Inicia uma partida do jogo Anagrama.",
		category: "jogos",
		aliases: ["anagram"],
		cooldown: 20,
		method: startGameCommand,
		reactions: {
			before: "🧩",
			error: "❌"
		}
	}),
	new Command({
		name: "ana",
		description: "Envia um palpite para o jogo Anagrama.",
		category: "jogos",
		usage: "!ana <palpite>",
		needsArgs: true,
		cooldown: 2,
		method: guessCommand
	}),
	new Command({
		name: "ana-dica",
		description: "Pede uma dica para a palavra atual do Anagrama.",
		category: "jogos",
		cooldown: 5,
		method: hintCommand,
		reactions: {
			after: "📝",
			error: "❌"
		}
	}),
	new Command({
		name: "ana-pular",
		description: "Pula a palavra atual no jogo Anagrama.",
		category: "jogos",
		cooldown: 5,
		method: skipCommand,
		reactions: {
			after: "⏭️",
			error: "❌"
		}
	}),
	new Command({
		name: "anagrama-ranking",
		description: "Mostra o ranking do jogo Anagrama.",
		category: "jogos",
		aliases: ["a-rank", "anagramaranking"],
		cooldown: 10,
		method: rankingCommand,
		reactions: {
			after: "🏆",
			error: "❌"
		}
	}),
	new Command({
		name: "anagrama-reset",
		description: "Reseta o ranking do Anagrama para o grupo (admins).",
		category: "jogos",
		adminOnly: true,
		cooldown: 60,
		method: resetCommand,
		reactions: {
			before: "🧹",
			after: "✅",
			error: "❌"
		}
	})
];

module.exports = {
	commands
};
