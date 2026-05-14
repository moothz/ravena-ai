// src/functions/LogicSequenceGame.js
const Logger = require("../utils/Logger");
const ReturnMessage = require("../models/ReturnMessage");
const Command = require("../models/Command");
const Database = require("../utils/Database");

const logger = new Logger("logic-game");
const database = Database.getInstance();
const dbName = "logic_game";

// Initialize database for ranking
database.getSQLiteDb(
	dbName,
	`
    CREATE TABLE IF NOT EXISTS logic_scores (
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT,
      total_score INTEGER DEFAULT 0,
      games_played INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      last_updated INTEGER,
      PRIMARY KEY (group_id, user_id)
    );
`
);

// Game Constants
const GAME_DURATION = 30 * 1000; // 60 seconds
const MIN_SCORE = 10;
const MAX_SCORE = 100;

// Active games memory storage
const activeGames = {};

/**
 * Generates a pool of Fibonacci numbers up to a limit
 */
function generateFibonacciPool(count) {
	const pool = [1, 1];
	for (let i = 2; i < count; i++) {
		const next = pool[i - 1] + pool[i - 2];
		if (next > Number.MAX_SAFE_INTEGER) break;
		pool.push(next);
	}
	return pool;
}

const FIBONACCI_POOL = generateFibonacciPool(100); // Should reach safe integer limit around index 78

/**
 * Sequence Generators
 * Each generator returns { sequence: "string representation", answer: ["valid", "answers"], explanation: "logic" }
 */
const SequenceGenerators = {
	// 1. Arithmetic Progression
	arithmetic: () => {
		const len = 8;
		const start = Math.floor(Math.random() * 100); // Increased range
		const diff = Math.floor(Math.random() * 19) + 2; // 2 to 20

		const seq = [];
		for (let i = 0; i < len; i++) seq.push(start + diff * i);

		const missingIndex = Math.floor(Math.random() * (len - 2)) + 2; // Avoid first 2
		const answer = seq[missingIndex];

		const displaySeq = [...seq];
		displaySeq[missingIndex] = "___";

		return {
			type: "Aritmética",
			sequence: displaySeq.join(", "),
			answer: [String(answer)],
			explanation: `Progressão Aritmética com razão ${diff}.`
		};
	},

	// 2. Geometric Progression
	geometric: () => {
		const len = 8;
		const start = Math.floor(Math.random() * 5) + 1;
		const ratio = Math.floor(Math.random() * 4) + 2; // 2 to 5 (Expanded ratio)

		const seq = [];
		let current = start;
		for (let i = 0; i < len; i++) {
			seq.push(current);
			current *= ratio;
		}

		const missingIndex = Math.floor(Math.random() * (len - 2)) + 2;
		const answer = seq[missingIndex];

		const displaySeq = [...seq];
		displaySeq[missingIndex] = "___";

		return {
			type: "Geométrica",
			sequence: displaySeq.join(", "),
			answer: [String(answer)],
			explanation: `Progressão Geométrica com razão ${ratio}.`
		};
	},

	// 3. Fibonacci
	fibonacci: () => {
		const len = 8;
		// Start from random point in fib sequence
		const maxStart = FIBONACCI_POOL.length - len;
		const startIdx = Math.floor(Math.random() * maxStart);
		const subSeq = FIBONACCI_POOL.slice(startIdx, startIdx + len);

		const missingIndex = Math.floor(Math.random() * (len - 2)) + 2;
		const answer = subSeq[missingIndex];

		const displaySeq = [...subSeq];
		displaySeq[missingIndex] = "___";

		return {
			type: "Fibonacci",
			sequence: displaySeq.join(", "),
			answer: [String(answer)],
			explanation: "Sequência de Fibonacci (soma dos dois anteriores)."
		};
	},

	// 4. Squares
	squares: () => {
		const len = 8;
		const start = Math.floor(Math.random() * 10) + 1;
		const seq = [];
		for (let i = 0; i < len; i++) seq.push((start + i) * (start + i));

		const missingIndex = Math.floor(Math.random() * (len - 2)) + 2;
		const answer = seq[missingIndex];

		const displaySeq = [...seq];
		displaySeq[missingIndex] = "___";

		return {
			type: "Quadrados",
			sequence: displaySeq.join(", "),
			answer: [String(answer)],
			explanation: "Sequência de quadrados perfeitos."
		};
	},

	// 5. Days of Week
	weekDays: () => {
		const days = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
		const reverse = Math.random() < 0.5;
		const pool = reverse ? [...days].reverse() : days;
		const len = 5;

		const startIdx = Math.floor(Math.random() * pool.length);
		const seq = [];
		for (let i = 0; i < len; i++) seq.push(pool[(startIdx + i) % 7]);

		const missingIndex = Math.floor(Math.random() * (len - 2)) + 1; // 1 to len-1
		const answer = seq[missingIndex];

		const displaySeq = [...seq];
		displaySeq[missingIndex] = "___";

		return {
			type: "Dias da Semana",
			sequence: displaySeq.join(", "),
			answer: [answer.toLowerCase(), answer.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()],
			explanation: `Dias da semana em ordem${reverse ? " inversa" : ""}.`
		};
	},

	// 6. Alphabet
	alphabet: () => {
		const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
		const reverse = Math.random() < 0.5;
		const pool = reverse ? [...alpha].reverse() : alpha;

		const startIdx = Math.floor(Math.random() * (pool.length - 8)); // Ensure space for seq
		const skip = Math.floor(Math.random() * 2) + 1; // 1 or 2

		const seq = [];
		for (let i = 0; i < 6; i++) {
			if (startIdx + i * skip < pool.length) seq.push(pool[startIdx + i * skip]);
		}

		if (seq.length < 5) return SequenceGenerators.alphabet(); // Retry if too short

		const missingIndex = Math.floor(Math.random() * (seq.length - 2)) + 2;
		const answer = seq[missingIndex];

		const displaySeq = [...seq];
		displaySeq[missingIndex] = "___";

		return {
			type: "Alfabeto",
			sequence: displaySeq.join(", "),
			answer: [answer.toLowerCase()],
			explanation: `Letras do alfabeto${reverse ? " (inverso)" : ""} pulando ${skip - 1}.`
		};
	},

	// 7. Emojis Count
	emojis: () => {
		const emojis = ["🍎", "⭐", "🔵", "🐱", "🌺"];
		const selected = emojis[Math.floor(Math.random() * emojis.length)];
		const seq = [
			selected,
			selected + selected,
			selected + selected + selected,
			selected + selected + selected + selected
		];

		// 1 to 3
		const missingIndex = Math.floor(Math.random() * 3) + 1;
		const answer = seq[missingIndex];

		const displaySeq = [...seq];
		displaySeq[missingIndex] = "___";

		// Generate answers based on count
		const count = missingIndex + 1;
		const validAnswers = [answer, String(count)];
		if (count === 2) validAnswers.push("dois", "duas");
		if (count === 3) validAnswers.push("tres", "três");
		if (count === 4) validAnswers.push("quatro");

		return {
			type: "Padrão Visual",
			sequence: displaySeq.join(", "),
			answer: validAnswers,
			explanation: "Contagem crescente de emojis."
		};
	},

	// 8. Planets
	planets: () => {
		const planets = [
			"Mercúrio",
			"Vênus",
			"Terra",
			"Marte",
			"Júpiter",
			"Saturno",
			"Urano",
			"Netuno"
		];
		const reverse = Math.random() < 0.5;
		const pool = reverse ? [...planets].reverse() : planets;

		const seq = pool.slice(0, 5);

		// Indices 1 to 4
		const missingIndex = Math.floor(Math.random() * 4) + 1;
		const answer = seq[missingIndex];

		const displaySeq = [...seq];
		displaySeq[missingIndex] = "___";

		return {
			type: "Astronomia",
			sequence: displaySeq.join(", "),
			answer: [answer.toLowerCase(), answer.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()],
			explanation: `Planetas do sistema solar em ordem${reverse ? " inversa" : ""} a partir do Sol.`
		};
	},

	// 9. Reverse Numbers
	reverse: () => {
		const start = Math.floor(Math.random() * 20) + 30; // 30-50
		const seq = [start, start - 1, start - 2, start - 3, start - 4];

		const missingIndex = Math.floor(Math.random() * 3) + 2;
		const answer = seq[missingIndex];

		const displaySeq = [...seq];
		displaySeq[missingIndex] = "___";

		return {
			type: "Contagem Regressiva",
			sequence: displaySeq.join(", "),
			answer: [String(answer)],
			explanation: "Números em ordem decrescente."
		};
	},

	// 10. Interleaved Operations
	interleaved: () => {
		const len = 8;
		const start = Math.floor(Math.random() * 20) + 5;

		// Random factors
		const add = Math.floor(Math.random() * 4) + 2; // +2 to +5
		const sub = Math.floor(Math.random() * 3) + 1; // -1 to -3

		// Logic: +add, -sub, +add, -sub
		const seq = [start];
		for (let i = 0; i < len - 1; i++) {
			if (i % 2 === 0) seq.push(seq[i] + add);
			else seq.push(seq[i] - sub);
		}

		const missingIndex = Math.floor(Math.random() * (len - 3)) + 3; // Avoid start
		const answer = seq[missingIndex];

		const displaySeq = [...seq];
		displaySeq[missingIndex] = "___";

		return {
			type: "Lógica Mista",
			sequence: displaySeq.join(", "),
			answer: [String(answer)],
			explanation: `Padrão alternado: soma ${add}, subtrai ${sub}.`
		};
	},

	// 11. Emoji Algebra / Combinations
	emojiAlgebra: () => {
		const combinations = [
			{
				eq: "👨 + 👩 = ?",
				ans: ["bebe", "bebê", "filho", "criança", "baby", "👶"],
				exp: "Homem + Mulher = Bebê"
			},
			{
				eq: "🌧️ + ☀️ = ?",
				ans: ["arco-iris", "arco iris", "arco íris", "rainbow", "🌈"],
				exp: "Chuva + Sol = Arco-íris"
			},
			{
				eq: "⚡ + 🌲 = ?",
				ans: ["fogo", "incendio", "incêndio", "fire", "🔥"],
				exp: "Raio + Árvore = Fogo"
			},
			{ eq: "💧 + ❄️ = ?", ans: ["gelo", "ice", "cubo de gelo", "🧊"], exp: "Água + Frio = Gelo" },
			{
				eq: "🥚 + ⏳ = ?",
				ans: ["pinto", "pintinho", "galinha", "passaro", "pássaro", "ave", "🐣", "🐥", "🐔"],
				exp: "Ovo + Tempo = Nascimento/Ave"
			},
			{ eq: "🐝 + 🌼 = ?", ans: ["mel", "honey", "🍯"], exp: "Abelha + Flor = Mel" },
			{ eq: "🍇 + ⏳ = ?", ans: ["vinho", "wine", "🍷"], exp: "Uva + Tempo/Processo = Vinho" },
			{
				eq: "🐄 + 🥛 = ?",
				ans: ["queijo", "cheese", "🧀"],
				exp: "Leite de vaca processado = Queijo"
			},
			{
				eq: "🔴 + 🔵 = ?",
				ans: ["roxo", "purple", "violeta", "🟣", "🟪"],
				exp: "Vermelho + Azul = Roxo"
			},
			{ eq: "🔵 + 🟡 = ?", ans: ["verde", "green", "🟢", "🟩"], exp: "Azul + Amarelo = Verde" },
			{ eq: "⚪ + ⚫ = ?", ans: ["cinza", "grey", "gray", "🩶"], exp: "Branco + Preto = Cinza" },
			{
				eq: "🔪 + 🍅 = ?",
				ans: ["salada", "salad", "🥗", "fatias"],
				exp: "Tomate cortado = Salada"
			},
			{ eq: "🥶 + 🌧️ = ?", ans: ["neve", "snow", "❄️", "🌨️"], exp: "Frio + Chuva = Neve" },
			{
				eq: "🌎 + 🚀 = ?",
				ans: ["lua", "moon", "espaço", "space", "marte", "martian", "alien", "👽", "🌑", "🌕"],
				exp: "Terra + Foguete = Viagem Espacial (Lua/Marte)"
			},
			{
				eq: "🐛 + ⏳ = ?",
				ans: ["borboleta", "butterfly", "🦋"],
				exp: "Lagarta + Tempo = Borboleta"
			},
			{
				eq: "👑 + 🦁 = ?",
				ans: ["rei leao", "rei leão", "lion king", "simba"],
				exp: "Referência ao filme Rei Leão"
			},
			{
				eq: "🧱 + 🧱 + 🧱 = ?",
				ans: ["parede", "muro", "casa", "construção", "wall", "house", "🏠"],
				exp: "Tijolos formam parede/casa"
			}
		];

		const selected = combinations[Math.floor(Math.random() * combinations.length)];

		return {
			type: "Matemática de Emojis",
			sequence: selected.eq,
			answer: selected.ans, // Already lower case or mixed, will be handled in check
			explanation: selected.exp
		};
	}
};

/**
 * Helper to pick a random generator
 */
function getRandomSequence() {
	const keys = Object.keys(SequenceGenerators);
	const randomKey = keys[Math.floor(Math.random() * keys.length)];
	return SequenceGenerators[randomKey]();
}

/**
 * Starts the game
 */
async function startLogicGame(bot, message, args, group) {
	try {
		const chatId = message.group || message.author;

		// Check active game
		if (activeGames[chatId]) {
			return new ReturnMessage({
				chatId,
				content: `⚠️ Já existe um jogo de sequência ativo!\nResponda com *!seq <resposta>*`
			});
		}

		const puzzle = getRandomSequence();
		const startTime = Date.now();
		const endTime = startTime + GAME_DURATION;

		activeGames[chatId] = {
			puzzle,
			startTime,
			endTime,
			winners: [], // { id, name, score, timeTaken }
			answeredIds: new Set(),
			timer: setTimeout(() => endLogicGame(bot, chatId), GAME_DURATION)
		};

		const msg =
			`🧠 *Desafio de Lógica* 🧠\n\n` +
			`Descubra o resultado ou o termo que falta:\n\n` +
			`➡️ *${puzzle.sequence}*\n\n` +
			`⏳ Tempo: ${GAME_DURATION / 1000} segundos\n` +
			`💡 Use *!seq <resposta>* para responder!`;

		logger.info(`Jogo iniciado em ${chatId}. Resposta: ${puzzle.answer.join(" ou ")}`);

		return new ReturnMessage({
			chatId,
			content: msg,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("Error starting logic game", error);
		return new ReturnMessage({
			chatId: message.group || message.author,
			content: "❌ Erro ao iniciar o jogo."
		});
	}
}

/**
 * Handles the guess command
 */
async function handleGuess(bot, message, args, group) {
	try {
		const chatId = message.group || message.author;

		if (!activeGames[chatId]) {
			return new ReturnMessage({
				chatId,
				content: "⚠️ Nenhum jogo ativo no momento. Use *!sequencia* para iniciar."
			});
		}

		if (!args || args.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "⚠️ Você precisa enviar uma resposta! Ex: *!seq 42*"
			});
		}

		const game = activeGames[chatId];
		const userId = message.author || message.authorAlt;
		const userName = message.authorName || "Jogador";

		// Check if user already answered correctly
		if (game.answeredIds.has(userId)) {
			// Optional: React telling they already won?
			message.origin.react("👀");
			return;
		}

		const guess = args.join(" ").trim().toLowerCase();

		// Check answer
		const isCorrect = game.puzzle.answer.some((ans) => {
			if (typeof ans === "string") return ans.toLowerCase() === guess;
			return ans == guess; // Loose equality for numbers
		});

		if (isCorrect) {
			// Calculate Score based on time remaining
			const timeElapsed = Date.now() - game.startTime;
			const percentageTimeLeft = 1 - timeElapsed / GAME_DURATION;
			// Score between MIN and MAX based on speed
			const score = Math.floor(MIN_SCORE + percentageTimeLeft * (MAX_SCORE - MIN_SCORE));

			game.winners.push({
				id: userId,
				name: userName,
				score,
				time: (timeElapsed / 1000).toFixed(1)
			});
			game.answeredIds.add(userId);

			message.origin.react("✅");
		} else {
			message.origin.react("❌");
		}
	} catch (error) {
		logger.error("Error processing guess", error);
	}
}

/**
 * Ends the game and announces winners
 */
async function endLogicGame(bot, chatId) {
	const game = activeGames[chatId];
	if (!game) return;

	delete activeGames[chatId]; // Remove from active immediately

	try {
		let text = `🏁 *Fim de Jogo!* 🏁\n\n`;
		text += `A resposta aceita era: *${game.puzzle.answer[0]}*\n`;
		text += `📝 _${game.puzzle.explanation}_\n\n`;

		if (game.winners.length > 0) {
			text += `🏆 *Vencedores:* 🏆\n`;

			// Sort by score (desc)
			game.winners.sort((a, b) => b.score - a.score);

			for (const [idx, winner] of game.winners.entries()) {
				const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : "🔹";
				text += `${medal} *${winner.name}* (+${winner.score} pts) em ${winner.time}s\n`;

				// Update DB
				await updateScore(chatId, winner.id, winner.name, winner.score);
			}
		} else {
			text += `🐢 Ninguém acertou a tempo! Tente novamente.`;
		}

		await bot.sendMessage(chatId, text);
	} catch (error) {
		logger.error("Error ending logic game", error);
	}
}

/**
 * Updates score in database
 */
async function updateScore(groupId, userId, userName, scoreToAdd) {
	try {
		await database.dbRun(
			dbName,
			`
            INSERT INTO logic_scores (group_id, user_id, user_name, total_score, games_played, wins, last_updated)
            VALUES (?, ?, ?, ?, 1, 1, ?)
            ON CONFLICT(group_id, user_id) DO UPDATE SET
                user_name = excluded.user_name,
                total_score = total_score + excluded.total_score,
                games_played = games_played + 1,
                wins = wins + 1,
                last_updated = excluded.last_updated
        `,
			[groupId, userId, userName, scoreToAdd, Date.now()]
		);
	} catch (error) {
		logger.error("Error updating logic score", error);
	}
}

/**
 * Shows the ranking
 */
async function showRanking(bot, message, args, group) {
	try {
		const chatId = message.group || message.author;

		const rows = await database.dbAll(
			dbName,
			`
            SELECT user_name, total_score, wins
            FROM logic_scores
            WHERE group_id = ?
            ORDER BY total_score DESC
            LIMIT 10
        `,
			[chatId]
		);

		if (!rows || rows.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "📉 Ainda não há ranking para este grupo. Jogue com *!sequencia*!"
			});
		}

		let text = `📊 *Ranking de Lógica* 📊\n\n`;
		rows.forEach((row, i) => {
			const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
			text += `${medal} *${row.user_name}*\n   └ ${row.total_score} pts (${row.wins} vitórias)\n`;
		});

		return new ReturnMessage({
			chatId,
			content: text
		});
	} catch (error) {
		logger.error("Error showing ranking", error);
		return new ReturnMessage({
			chatId: message.group || message.author,
			content: "❌ Erro ao buscar ranking."
		});
	}
}

const commands = [
	new Command({
		name: "sequencia",
		description: "Inicia um jogo de sequência lógica",
		category: "jogos",
		cooldown: 10,
		reactions: { before: "🧠" },
		method: startLogicGame
	}),
	new Command({
		name: "seq",
		description: "Tentar adivinhar a sequência",
		category: "jogos",
		cooldown: 0, // No cooldown for guessing
		method: handleGuess
	}),
	new Command({
		name: "sequencia-ranking",
		description: "Ver o ranking de lógica",
		category: "jogos",
		cooldown: 5,
		reactions: { before: "📊" },
		method: showRanking
	})
];

module.exports = { commands, activeGames };
