// src/functions/StopGame.js
const path = require("path");
const Logger = require("../utils/Logger");
const ReturnMessage = require("../models/ReturnMessage");
const Command = require("../models/Command");
//const Database = require('../utils/Database');
const LLMService = require("../services/LLMService");

const logger = new Logger("stop-game");
//const database = Database.getInstance();
const llmService = LLMService.getInstance();

// Constantes do jogo
const GAME_DURATION = 1.5 * 60 * 1000; // 2 minutos em milissegundos
const NUM_CATEGORIES = 5; // Número de categorias por rodada
const MINIMUM_RESPONSES = 1; // Mínimo de respostas para validar o jogo

// Lista de categorias disponíveis
const CATEGORIES = [
	"Alimento",
	"Fruta",
	"Animal",
	"Celebridade",
	"Carro",
	"CEP",
	"Cor",
	"Esporte",
	"Filme",
	"Série",
	"Banda",
	"Marca",
	"Meios de Transporte",
	"Partes do Corpo",
	"Flor",
	"Objeto"
];

// Lista de letras disponíveis para sorteio (excluindo letras difíceis como K, W, X, Y, Z)
const AVAILABLE_LETTERS = [
	"A",
	"B",
	"C",
	"D",
	"E",
	"F",
	"G",
	"H",
	"I",
	"J",
	"L",
	"M",
	"N",
	"O",
	"P",
	"Q",
	"R",
	"S",
	"T",
	"U",
	"V"
];

const contextoAvaliadorStop = `Você é um juiz de um jogo chamado "Stop" ou "Adedonha". Preciso que analise as respostas do jogo que vão ser fornecidas em formato JSON no prompt e me retorne o mesmo JSON com os campos 'valid' preenchidos para cada resposta. Não altere as respostas, o único campo que você deve alterar é o 'valid'. Seja rigoroso mas justo na avaliação.`;

// Armazena os jogos ativos
const activeGames = {};

/**
 * Seleciona categorias aleatórias da lista
 * @param {number} count - Número de categorias a selecionar
 * @returns {Array} - Array de categorias selecionadas
 */
function getRandomCategories(count) {
	const categories = [...CATEGORIES];
	const selected = [];

	for (let i = 0; i < count && categories.length > 0; i++) {
		const index = Math.floor(Math.random() * categories.length);
		selected.push(categories[index]);
		categories.splice(index, 1); // Remove a categoria selecionada para evitar duplicatas
	}

	return selected;
}

/**
 * Seleciona uma letra aleatória da lista de letras disponíveis
 * @returns {string} - Letra selecionada
 */
function getRandomLetter() {
	const index = Math.floor(Math.random() * AVAILABLE_LETTERS.length);
	return AVAILABLE_LETTERS[index];
}

/**
 * Verifica se uma string começa com a letra especificada (ignorando acentos)
 * @param {string} text - Texto a verificar
 * @param {string} letter - Letra inicial
 * @returns {boolean} - Verdadeiro se começar com a letra
 */
function startsWithLetter(text, letter) {
	if (!text || typeof text !== "string" || text.trim() === "") {
		return false;
	}

	// Normaliza para remover acentos e converte para maiúscula
	const normalizedText = text
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toUpperCase();
	const normalizedLetter = letter
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toUpperCase();

	return normalizedText.startsWith(normalizedLetter);
}

function handleGame(bot, message, args, group) {
	if (message.group) {
		// Se o comando foi enviado no grupo, considera como inicio do game
		return startStopGame(bot, message, args, group);
	} else {
		// Se for no PV, a pessoa tá tentando enviar resposta
		return processStopGameResponse(bot, message);
	}
}

/**
 * Inicia um novo jogo de Stop/Adedonha
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>} Mensagem de retorno
 */
async function startStopGame(bot, message, args, group) {
	try {
		const groupId = message.group;

		// Verifica se já existe um jogo ativo
		if (activeGames[groupId]) {
			// Informa que há um jogo em andamento
			const timeRemaining = Math.ceil((activeGames[groupId].endTime - Date.now()) / 1000);
			const minutes = Math.floor(timeRemaining / 60);
			const seconds = timeRemaining % 60;

			return new ReturnMessage({
				chatId: groupId,
				content: `🛑 Já existe um jogo de Stop/Adedonha em andamento! Me encaminhe as respostas no pv.\n\n- 🕐 Tempo restante: ${minutes}m ${seconds}s.`
			});
		}

		// Verifica argumentos para personalização
		let gameDuration = GAME_DURATION;
		let numCategories = NUM_CATEGORIES;

		if (args.length > 0) {
			// Verifica se tem argumento para duração (em minutos)
			const duration = parseInt(args[0]);
			if (!isNaN(duration) && duration > 0 && duration <= 15) {
				gameDuration = duration * 60 * 1000; // Converte minutos para milissegundos
			}
		}

		if (args.length > 1) {
			// Verifica se tem argumento para número de categorias
			const catCount = parseInt(args[1]);
			if (!isNaN(catCount) && catCount > 0 && catCount <= 10) {
				numCategories = catCount;
			}
		}

		// Seleciona categorias aleatórias
		const selectedCategories = getRandomCategories(numCategories);

		// Seleciona uma letra aleatória
		const selectedLetter = getRandomLetter();

		// Cria o objeto do jogo
		activeGames[groupId] = {
			categories: selectedCategories,
			letter: selectedLetter,
			startTime: Date.now(),
			endTime: Date.now() + gameDuration,
			responses: {},
			initiatedBy: message.author,
			initiatorName: message.authorName || "Jogador",
			gameHeader: `${bot.prefix}stop ${groupId}\n🛑 *STOP!* ✋ - Letra: *${selectedLetter}*`
		};

		// Prepara a mensagem do jogo
		let gameMessage = `${activeGames[groupId].gameHeader}\n\n`;

		selectedCategories.forEach((category, index) => {
			gameMessage += `- ${category}:\n`;
		});

		// Adiciona instruções
		const minutes = Math.floor(gameDuration / 60000);
		const seconds = Math.floor((gameDuration % 60000) / 1000);

		let startMessage = `🛑 *STOP!* ✋ - Letra: *${selectedLetter}* - _Inicializando..._\n\nVocês tem ${minutes}m${seconds > 0 ? ` ${seconds}s` : ""} para responder! 🕐\n`;
		startMessage += `Todas as respostas devem começar com a letra *${selectedLetter}*.\n`;
		startMessage += `Copie a mensagem a seguir, preencha as respostas e envie no meu pv!`;

		const messages = [];
		messages.push(
			new ReturnMessage({
				chatId: groupId,
				content: startMessage,
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			})
		);

		messages.push(
			new ReturnMessage({
				chatId: groupId,
				content: gameMessage,
				delay: 500
			})
		);

		// Configura o temporizador para finalizar o jogo
		setTimeout(async () => {
			if (activeGames[groupId]) {
				// Envia mensagem de que o tempo acabou
				await bot.sendMessage(
					groupId,
					`😴 Tempo esgotado para o jogo de Stop/Adedonha!\n\nAguarde, analisando respostas...`
				);

				// Finaliza o jogo após um breve intervalo
				setTimeout(
					(bt, gid) => {
						endGame(bt, gid);
					},
					1000,
					bot,
					groupId
				);
			}
		}, gameDuration);

		return messages;
	} catch (error) {
		logger.warn("Erro ao iniciar jogo de Stop/Adedonha:", error);

		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "❌ Erro ao iniciar o jogo de Stop/Adedonha. Por favor, tente novamente."
		});
	}
}

/**
 * Processa uma mensagem para verificar se é uma resposta ao jogo Stop/Adedonha
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem formatada
 * @returns {Promise<boolean>} - Se a mensagem foi processada como resposta do jogo
 */
function processStopGameResponse(bot, message) {
	try {
		const userId = message.author;
		const userName = message.authorName || "Jogador";

		// Verifica se a mensagem começa com o cabeçalho do jogo
		const messageContent = message.content;
		if (typeof messageContent !== "string") {
			return false;
		}

		// A primeira linha é !stop 12345@g.us
		// Pega o ID do grupo
		const groupId = messageContent.match(/(?<=stop\s)\d+(?:-\d+)?@g\.us/);

		if (!groupId) {
			return false;
		}

		// Verifica se há um jogo ativo no grupo
		if (!activeGames[groupId]) {
			return new ReturnMessage({
				chatId: userId,
				content: `🫸 Não há um jogo ativo neste grupo`
			});
		}

		// Verifica se o jogo expirou
		if (Date.now() > activeGames[groupId].endTime) {
			return new ReturnMessage({
				chatId: userId,
				content: `🫸 O último jogo neste grupo já expirou!`
			});
		}

		const categories = activeGames[groupId].categories;
		// Extrai respostas das categorias da mensagem
		const lines = messageContent.split("\n");
		const userAnswers = {};

		for (const line of lines) {
			// Procura por linhas que comecem com "- Categoria:" ou similar
			const categoryMatch = line.match(/^\s*([^:]+):\s*(.*)$/); // [\*-] tirei
			if (categoryMatch) {
				const categoryName = categoryMatch[1].trim();
				const answer = categoryMatch[2].trim();

				// Verifica se é uma das categorias do jogo
				if (categories.some((cat) => categoryName.includes(cat))) {
					// Determina a categoria exata
					const exactCategory = categories.find((cat) => categoryName.includes(cat));
					userAnswers[exactCategory] = { answer, valid: false };
				}
			}
		}

		// Verifica se o usuário respondeu a todas as categorias
		for (const category of categories) {
			if (!userAnswers[category] || userAnswers[category] === "") {
				userAnswers[category] = { answer: "", valid: false };
			}
		}

		let emoji = "✅";
		if (activeGames[groupId].responses[userId]) {
			activeGames[groupId].responses[userId].answers = userAnswers;
			emoji = "🔄";
		} else {
			activeGames[groupId].responses[userId] = {};
			activeGames[groupId].responses[userId].userName = message.authorName;
			activeGames[groupId].responses[userId].answers = userAnswers;
		}

		const timeRemaining = Math.ceil((activeGames[groupId].endTime - Date.now()) / 1000);
		const minutes = Math.floor(timeRemaining / 60);
		const seconds = timeRemaining % 60;

		message.origin.react(emoji);
		return new ReturnMessage({
			chatId: userId,
			content: `${emoji} Recebi suas respostas!\n- 🕐 Tempo restante: ${minutes}m ${seconds}s`
		});
	} catch (error) {
		logger.warn("Erro ao processar resposta do jogo Stop/Adedonha:", error);
		return false;
	}
}

/**
 * Analisa respostas do jogo usando LLM
 * @param {Array} categories - Lista de categorias do jogo
 * @param {Array} responses - Lista de respostas dos usuários
 * @param {string} letter - Letra sorteada para o jogo
 * @returns {Promise<Object>} - Resultados da análise
 */
async function analyzeResponses(game) {
	try {
		try {
			const promptFormatado = `json\n\`\`\`${JSON.stringify(game.responses)}\`\`\``;
			const ctxFormatado = `${contextoAvaliadorStop}. As palavras desta rodada devem começar com a letra '${game.letter}'`;

			const llmResponse = await llmService.getCompletion({
				prompt: promptFormatado,
				systemContext: ctxFormatado,
				priority: 5
			});

			// Analisa a resposta do LLM (espera um JSON)
			const validationResults = parseLLMResponse(llmResponse);

			// Calcula a pontuação
			const validatedAnswers = {};

			// Cada response é a resposta de um usuario (key)
			for (const userId in validationResults) {
				game.responses[userId].score = 0;
				const userAnswers = validationResults[userId].answers;
				for (const category in userAnswers) {
					if (userAnswers[category].valid) {
						game.responses[userId].answers[category].valid = true;
						game.responses[userId].score += 10;
					}
				}
			}
		} catch (llmError) {
			logger.warn("Erro ao validar respostas com LLM:", llmError);
		}

		return game.responses;
	} catch (error) {
		logger.warn("Erro ao analisar respostas:", error);
		throw error;
	}
}

/**
 * Analisa a resposta do LLM para extrair os resultados de validação
 * @param {string} llmResponse - Resposta do LLM
 * @returns {Object} - Objeto com os resultados de validação
 */
function parseLLMResponse(llmResponse) {
	try {
		// Tenta extrair apenas a parte JSON da resposta
		const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			return JSON.parse(jsonMatch[0]);
		}

		// Se não encontrar um padrão JSON claro, tenta analisar a resposta completa
		try {
			const tudo = JSON.parse(llmResponse);
			return tudo;
		} catch (e) {
			logger.warn("Erro ao analisar resposta do LLM completa:", e);
			logger.debug(llmResponse);
			return {};
		}
	} catch (error) {
		logger.warn("Erro ao analisar resposta do LLM:", error);
		logger.debug("Resposta do LLM:", llmResponse);

		// Retorna um objeto vazio em caso de erro
		return {};
	}
}

/**
 * Finaliza um jogo de Stop/Adedonha
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {string} groupId - ID do grupo
 */
async function endGame(bot, groupId) {
	try {
		if (!activeGames[groupId]) {
			return;
		}

		const game = activeGames[groupId];

		// Verifica se há respostas suficientes
		if (Object.keys(game.responses).length < MINIMUM_RESPONSES) {
			await bot.sendMessage(
				groupId,
				`📝 O jogo de Stop/Adedonha foi cancelado por ter menos de ${MINIMUM_RESPONSES} respostas.`
			);
			delete activeGames[groupId];
			return;
		}

		// Analisa as respostas
		const results = await analyzeResponses(game);

		// Prepara a mensagem de resultados
		let resultsMessage = `🏁 *Resultados do Stop/Adedonha - Letra: ${game.letter}*\n\n`;

		// Ordena os jogadores por pontuação
		const sortedPlayers = Object.entries(results).sort(
			([, resultA], [, resultB]) => resultB.score - resultA.score
		);

		// Mostra o ranking
		let options = undefined;
		if (sortedPlayers.length > 0) {
			resultsMessage += "*Classificação:*\n";

			sortedPlayers.forEach(([userId, result], index) => {
				const medal =
					index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : `${index + 1}.`;
				resultsMessage += `${medal} ${result.userName}: ${result.score} pontos\n`;
			});

			// Mostra detalhes do vencedor se houver
			if (sortedPlayers.length > 0) {
				const [winnerId, winner] = sortedPlayers[0];
				options = { mentions: [winnerId] };

				resultsMessage += `\n🏆 *Vencedor:* @${winnerId.split("@")[0]}\n\n`;
				resultsMessage += "*Respostas enviadas:*\n";

				sortedPlayers.forEach(([userId, result], index) => {
					const medal =
						index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : `${index + 1}.`;
					resultsMessage += `${medal} *${result.userName}*\n`;

					for (const category of game.categories) {
						const answer = result.answers[category];
						const status = answer.valid ? "✅" : "❌";
						resultsMessage += `- ${status} ${category}: ${answer.answer || "(não respondeu)"}\n`;
					}
					resultsMessage += "\n";
				});
			}
		} else {
			resultsMessage += "Nenhuma resposta válida nesta rodada. 😢";
		}

		// Envia a mensagem com os resultados
		await bot.sendMessage(groupId, resultsMessage, options);

		// Remove o jogo da lista de ativos
		delete activeGames[groupId];
	} catch (error) {
		logger.warn("Erro ao finalizar jogo de Stop/Adedonha:", error);

		// Tenta enviar mensagem de erro
		try {
			await bot.sendMessage(
				groupId,
				"❌ Ocorreu um erro ao finalizar o jogo. Por favor, tente novamente."
			);
		} catch (sendError) {
			logger.warn("Erro ao enviar mensagem de erro:", sendError);
		}

		// Garante que o jogo seja removido mesmo em caso de erro
		delete activeGames[groupId];
	}
}

// Criar array de comandos usando a classe Command
const commands = [
	new Command({
		name: "adedonha",
		description: "Inicia um jogo de Stop/Adedonha",
		group: "stopadedonha",
		category: "jogos",
		cooldown: 0,
		reactions: {
			before: "🛑",
			after: "📝",
			error: "❌"
		},
		method: handleGame
	}),

	new Command({
		name: "stop",
		description: "Alias para o jogo de Stop/Adedonha",
		group: "stopadedonha",
		category: "jogos",
		cooldown: 0,
		reactions: {
			before: "🛑",
			after: "📝",
			error: "❌"
		},
		method: handleGame
	})
];

module.exports = { commands };
