// src/functions/PintoGame.js
const path = require("path");
const Logger = require("../utils/Logger");
const ReturnMessage = require("../models/ReturnMessage");
const Command = require("../models/Command");
const Database = require("../utils/Database");

const logger = new Logger("pinto-game");
const database = Database.getInstance();
const dbName = "pinto";

// Initialize database
database.getSQLiteDb(
	dbName,
	`
    CREATE TABLE IF NOT EXISTS pinto_scores (
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT,
      flaccid REAL,
      erect REAL,
      girth REAL,
      curvature REAL,
      score INTEGER,
      last_updated INTEGER,
      PRIMARY KEY (group_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS pinto_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT,
      user_id TEXT,
      user_name TEXT,
      flaccid REAL,
      erect REAL,
      girth REAL,
      curvature REAL,
      score INTEGER,
      timestamp INTEGER
    );
`
);

// Constantes do jogo
const MIN_FLACCID = 3.0;
const MAX_FLACCID = 12.0;
const MIN_ERECT = 5.0;
const MAX_ERECT = 25.0;
const MIN_GIRTH = 8.0;
const MAX_GIRTH = 18.0;
const MAX_SCORE = 1000;
const COOLDOWN_DAYS = 3; // 3 dias de cooldown

/**
 * Gera um valor aleatório entre min e max com 1 casa decimal
 * @param {number} min - Valor mínimo
 * @param {number} max - Valor máximo
 * @returns {number} - Valor aleatório com 1 casa decimal
 */
function generateRandomValue(min, max) {
	const value = Math.random() * (max - min) + min;
	return Math.round(value * 10) / 10; // Arredonda para 1 casa decimal
}

/**
 * Calcula o score com base nos valores
 * @param {number} flaccid - Comprimento flácido
 * @param {number} erect - Comprimento ereto
 * @param {number} girth - Circunferência
 * @param {number} curvature - Curvatura em graus (-30 a 30)
 * @returns {number} - Score calculado
 */
function calculateScore(flaccid, erect, girth, curvature) {
	// Normaliza os valores (0 a 1)
	const normFlaccid = (flaccid - MIN_FLACCID) / (MAX_FLACCID - MIN_FLACCID);
	const normErect = (erect - MIN_ERECT) / (MAX_ERECT - MIN_ERECT);
	const normGirth = (girth - MIN_GIRTH) / (MAX_GIRTH - MIN_GIRTH);

	// Curvatura: 0 é o maior score, módulo de 30 adiciona 0
	const normCurvature = 1 - Math.abs(curvature) / 30;

	// Calcula a média ponderada (dando mais peso para o comprimento ereto)
	const weightedAvg = normFlaccid * 0.2 + normErect * 0.5 + normGirth * 0.2 + normCurvature * 0.1;

	// Converte para o score final
	return Math.round(weightedAvg * MAX_SCORE);
}

const INTRO_A = [
	"Olá {pessoa}, entre e fique à vontade no consultório do Dr. Raveno! 🩺",
	"Seja bem-vindo(a), {pessoa}. Pode ir tirando a roupa para o exame... 🥼",
	"Ah, {pessoa}! Estava te esperando. Sente-se na maca, por favor. 🛋️",
	"Bom dia, {pessoa}. Pronto para sua avaliação trimestral? 📝",
	"Ora ora, se não é o(a) {pessoa}. Veio finalmente tirar a prova? 🔍",
	"Entre, {pessoa}. Não precisa ter vergonha, já vi de tudo por aqui. 🏥",
	"Aproxime-se, {pessoa}. Vamos ver como andam as coisas... 🧐",
	"Saudações, {pessoa}! O Dr. Raveno está pronto para atendê-lo(a). 🎩",
	"Oi {pessoa}, veio fazer o check-up de rotina? 💉",
	"{pessoa}, você de novo? Veio ver se mudou alguma coisa? 🔄",
	"Bem-vindo(a) à clínica de estética do Dr. Raveno, {pessoa}! ✨",
	"Olha só quem apareceu... Pode entrar, {pessoa}. 🚪",
	"Sente-se, {pessoa}. O procedimento será rápido e indolor (espero). ⚡",
	"Preparado(a) para o veredito, {pessoa}? A ciência não mente! 🔬",
	"Finalmente você criou coragem, {pessoa}! Vamos ao que interessa. 🧪"
];

const INTRO_B = [
	"Hmm, vejo que hoje o dia está... 'animado' por aqui. 🌡️",
	"Nossa, parece que alguém veio bem preparado para a consulta! 😋",
	"Interessante... O formato me parece bem peculiar. 📐",
	"Pelos meus cálculos iniciais, temos algo digno de nota aqui. 📊",
	"Rapaz, a genética é mesmo uma caixa de surpresas... 🎁",
	"Opa! Quase precisei de uma régua maior para essa primeira olhada. 📏",
	"Calma, deixe-me ajustar meus óculos... Agora sim. 👓",
	"É... Digamos que eu esperava algo diferente, mas vamos prosseguir. 😶",
	"Uau! Acho que o ar condicionado não está afetando em nada aqui. ❄️",
	"Sinto uma energia... potente vindo desta direção. ⚡",
	"O clima esquentou de repente ou é impressão minha? 🔥",
	"De acordo com os manuais de anatomia, isso aqui é raro... 📚",
	"Mantenha a calma. O Dr. Raveno é profissional. 🧤",
	"Sempre fico surpreso com o que encontro nesta profissão... 😮",
	"Tudo bem, respire fundo. O processo de medição vai começar. ⏱️"
];

const INTRO_C = [
	"Vamos lá, posicione-se para a medição oficial. 📋",
	"Iniciando o escaneamento biométrico em 3... 2... 1... 📡",
	"Vou usar o paquímetro digital de precisão para não haver erros. 🛠️",
	"Não se mova! Qualquer milímetro faz diferença no score final. 🎯",
	"Pronto, agora relaxe enquanto o sistema processa os dados. 💾",
	"Certo, já anotei os valores preliminares. Vamos ao cálculo! ✍️",
	"O resultado vai te surpreender (ou não). 🎰",
	"Lembrando que tamanho não é documento, mas o score é! 🏆",
	"A ciência é absoluta. Veja o que descobrimos: 🧬",
	"Terminei a inspeção visual. Agora, los números frios e calculistas: 🔢",
	"Interessante... Muito interessante mesmo. Veja só: 🧐",
	"Não precisa ficar vermelho(a)! Os dados são confidenciais. 🤫",
	"Segura a emoção que lá vem o resultado! 🎢",
	"Depois de cruzar os dados com o IBGE, chegamos a isto: 🌍",
	"Prontinho! O laudo médico está saindo do forno: 🍞"
];

/**
 * Gera um comentário com base no score com maior variedade
 * @param {number} score - Score calculado
 * @returns {string} - Comentário engraçado
 */
function getComment(score) {
	if (score >= 1000) return "🌌 *DEUS DO OLIMPO!* Isso não é um membro, é um monumento histórico!";
	if (score >= 950)
		return "🔥 *LENDÁRIO!* As lendas urbanas falavam de algo assim, mas eu não acreditava!";
	if (score >= 900)
		return "⚡ *IMPRESSIONANTE!* Você precisa de uma licença especial para carregar isso?";
	if (score >= 850) return "🏆 *CAMPEÃO PESO-PESADO!* O Dr. Raveno ficou até sem fôlego!";
	if (score >= 800) return "🌟 *EXCEPCIONAL!* Um verdadeiro espécime de elite, parabéns!";
	if (score >= 750) return "💎 *JOIA RARA!* Acima de qualquer expectativa razoável!";
	if (score >= 700) return "👏 *INCRÍVEL!* Um resultado que impõe respeito em qualquer lugar!";
	if (score >= 650) return "✨ *BRILHANTE!* Você está muito bem servido, sem dúvidas!";
	if (score >= 600) return "👍 *MUITO BOM!* Acima da média e com muito potencial!";
	if (score >= 550) return "✅ *SÓLIDO!* Um resultado respeitável e equilibrado.";
	if (score >= 500) return "😊 *NA MÉDIA!* O famoso 'padrão brasileiro' de qualidade.";
	if (score >= 450) return "🙂 *ACEITÁVEL!* Não ganha medalha, mas também não passa vergonha.";
	if (score >= 400) return "😐 *OK.* Cumpre o que promete, sem grandes firulas.";
	if (score >= 350) return "📉 *UM POUCO ABAIXO.* Talvez seja o frio do consultório?";
	if (score >= 300) return "😬 *EITA.* O importante é o que importa, certo?";
	if (score >= 250) return "🔍 *ONDE ESTÁ?* Brincadeira! Mas uma lupinha ajudaria...";
	if (score >= 200) return "🤏 *COMPACTO!* Ideal para viagens, ocupa pouco espaço.";
	if (score >= 150) return "🧸 *FOFINHO!* Pelo menos é fácil de cuidar.";
	if (score >= 100) return "💀 *F NO CHAT.* A natureza esqueceu de passar na sua casa?";
	if (score >= 50) return "🐜 *FORMIGUINHA?* É... realmente... uma situação complicada.";
	return "🔬 *MICROSCÓPICO!* A ciência agradece por poder estudar algo tão minúsculo!";
}

/**
 * Gera as frases de introdução aleatórias
 * @param {string} userName - Nome do usuário
 * @returns {string} - Frase combinada
 */
function generateFlavorText(userName) {
	const a = INTRO_A[Math.floor(Math.random() * INTRO_A.length)].replace(
		"{pessoa}",
		`*${userName}*`
	);
	const b = INTRO_B[Math.floor(Math.random() * INTRO_B.length)];
	const c = INTRO_C[Math.floor(Math.random() * INTRO_C.length)];
	return `${a}\n${b}\n${c}`;
}

/**
 * Formata data para exibição
 * @param {number} timestamp - Timestamp em milissegundos
 * @returns {string} - Data formatada
 */
function formatDate(timestamp) {
	const date = new Date(timestamp);
	return date.toLocaleDateString("pt-BR", {
		day: "2-digit",
		month: "2-digit",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit"
	});
}

/**
 * Verifica se o usuário está em cooldown com base no lastUpdated salvo no banco
 * @param {string} groupId - ID do grupo
 * @param {string} userId - ID do usuário
 * @returns {Promise<Object>} - Status do cooldown e próxima data disponível
 */
async function checkCooldown(groupId, userId) {
	try {
		const row = await database.dbGet(
			dbName,
			`
      SELECT last_updated FROM pinto_scores
      WHERE group_id = ? AND user_id = ?
    `,
			[groupId, userId]
		);

		if (row && row.last_updated) {
			const now = Date.now();
			const lastUsed = row.last_updated;
			const cooldownMs = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

			if (now - lastUsed < cooldownMs) {
				const nextAvailable = new Date(lastUsed + cooldownMs);
				const timeUntil = nextAvailable - now;
				const daysUntil = Math.ceil(timeUntil / (24 * 60 * 60 * 1000));

				return {
					inCooldown: true,
					nextAvailable,
					daysUntil
				};
			}
		}
	} catch (error) {
		logger.error("Erro ao verificar cooldown:", error);
	}

	// Sem cooldown ativo
	return {
		inCooldown: false
	};
}

/**
 * Gera os resultados do comando !pinto
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>} Mensagem de retorno
 */
async function pintoCommand(bot, message, args, group) {
	try {
		// Verifica se está em um grupo
		if (!message.group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este jogo só pode ser jogado em grupos.",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		// Obtém IDs e nome
		const groupId = message.group;
		const userId = message.author ?? message.authorAlt;
		const userName =
			message.name ?? message.pushName ?? message.pushname ?? message.authorName ?? "Fulano";

		// Verifica o cooldown baseado no lastUpdated salvo no banco
		const cooldownStatus = await checkCooldown(groupId, userId);

		if (cooldownStatus.inCooldown) {
			return new ReturnMessage({
				chatId: groupId,
				content: `⌛️ ${userName}, você já realizou sua avaliação recentemente.\n\nPróxima avaliação disponível em ${cooldownStatus.daysUntil} dia(s), dia ${formatDate(cooldownStatus.nextAvailable)}.`,
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		// Gera os valores aleatórios
		const flaccid = generateRandomValue(MIN_FLACCID, MAX_FLACCID);
		const erect = generateRandomValue(Math.max(flaccid, MIN_ERECT), MAX_ERECT); // Ereto é no mínimo igual ao flácido
		const girth = generateRandomValue(MIN_GIRTH, MAX_GIRTH);
		const curvature = generateRandomValue(-30, 30);

		// Calcula o score
		const score = calculateScore(flaccid, erect, girth, curvature);

		// Obtém um comentário baseado no score
		const comment = getComment(score);

		// Timestamp atual
		const currentTimestamp = Date.now();

		// Salva os resultados no banco de dados
		try {
			// Salva ou atualiza os dados do jogador para este grupo
			await database.dbRun(
				dbName,
				`
        INSERT INTO pinto_scores (group_id, user_id, user_name, flaccid, erect, girth, curvature, score, last_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(group_id, user_id) DO UPDATE SET
          user_name = excluded.user_name,
          flaccid = excluded.flaccid,
          erect = excluded.erect,
          girth = excluded.girth,
          curvature = excluded.curvature,
          score = excluded.score,
          last_updated = excluded.last_updated
      `,
				[groupId, userId, userName, flaccid, erect, girth, curvature, score, currentTimestamp]
			);

			// Adiciona ao histórico geral
			await database.dbRun(
				dbName,
				`
        INSERT INTO pinto_history (group_id, user_id, user_name, flaccid, erect, girth, curvature, score, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
				[groupId, userId, userName, flaccid, erect, girth, curvature, score, currentTimestamp]
			);
		} catch (dbError) {
			logger.error("Erro ao salvar dados do jogo:", dbError);
			throw dbError; // Re-throw para cair no catch principal se falhar o banco
		}

		// Determina o texto descritivo da curvatura
		let curvatureText = "";
		const absCurvature = Math.abs(curvature);
		if (curvature >= -5 && curvature <= 5) {
			curvatureText = `${absCurvature.toFixed(1)}°, retinho!`;
		} else if (curvature < -5) {
			curvatureText = `${absCurvature.toFixed(1)}°, torto para esquerda`;
		} else {
			curvatureText = `${absCurvature.toFixed(1)}°, torto para direita`;
		}

		// Prepara a mensagem de resposta
		const flavorText = generateFlavorText(userName);
		const response =
			`${flavorText}\n\n` +
			`• *Comprimento Flácido:* ${flaccid.toFixed(1)} cm\n` +
			`• *Comprimento Ereto:* ${erect.toFixed(1)} cm\n` +
			`• *Circunferência:* ${girth.toFixed(1)} cm\n` +
			`• *Curvatura:* ${curvatureText}\n` +
			`• *Score:* _${score} pontos_\n\n` +
			`${comment}\n\n` +
			`> Você pode voltar daqui a ${COOLDOWN_DAYS} dias para refazermos sua avaliação.`;

		return new ReturnMessage({
			chatId: groupId,
			content: response,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("Erro no comando de pinto:", error);

		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "❌ Erro ao processar o comando. Por favor, tente novamente.",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}
}

/**
 * Mostra o ranking do jogo Pinto
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage>} Mensagem de retorno
 */
async function pintoRankingCommand(bot, message, args, group) {
	try {
		// Verifica se está em um grupo
		if (!message.group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "🏆 O ranking do jogo só pode ser visualizado em grupos."
			});
		}

		const groupId = message.group;

		// Obtém o ranking do banco de dados
		const topPlayers = await database.dbAll(
			dbName,
			`
      SELECT user_id, user_name, score
      FROM pinto_scores
      WHERE group_id = ?
      ORDER BY score DESC
      LIMIT 10
    `,
			[groupId]
		);

		if (topPlayers.length === 0) {
			return new ReturnMessage({
				chatId: groupId,
				content: "🏆 Ainda não há dados para o ranking neste grupo. Use !pinto para participar!"
			});
		}

		// Prepara a mensagem de ranking
		let rankingMessage = `🍆 *Ranking do Tamanho - ${group.name || "Grupo"}*

`;

		topPlayers.forEach((player, index) => {
			const medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : `${index + 1}.`;
			rankingMessage += `${medal} ${player.user_name}: ${player.score} pontos\n`;
		});

		// Verifica a posição do usuário se ele não estiver no top 10
		const userId = message.author ?? message.authorAlt;
		const userInTop10 = topPlayers.some((p) => p.user_id === userId);

		if (!userInTop10) {
			const userScore = await database.dbGet(
				dbName,
				`
        SELECT score FROM pinto_scores
        WHERE group_id = ? AND user_id = ?
      `,
				[groupId, userId]
			);

			if (userScore) {
				const betterPlayers = await database.dbGet(
					dbName,
					`
          SELECT COUNT(*) as count FROM pinto_scores
          WHERE group_id = ? AND score > ?
        `,
					[groupId, userScore.score]
				);

				const rank = betterPlayers.count + 1;
				rankingMessage += `
...

`;
				rankingMessage += `${rank}. Você: ${userScore.score} pontos`;
			}
		}

		return new ReturnMessage({
			chatId: groupId,
			content: rankingMessage
		});
	} catch (error) {
		logger.error("Erro ao mostrar ranking do jogo:", error);

		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "❌ Erro ao mostrar ranking. Por favor, tente novamente."
		});
	}
}

/**
 * Reseta os dados do jogo Pinto para um grupo específico
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage[]>} Array de mensagens de retorno
 */
async function pintoResetCommand(bot, message, args, group) {
	try {
		// Verifica se está em um grupo
		if (!message.group) {
			return [
				new ReturnMessage({
					chatId: message.author,
					content: "O reset do jogo só pode ser executado em grupos."
				})
			];
		}

		const groupId = message.group;
		const userId = message.author;

		// Verifica se o usuário é admin
		const isAdmin = await bot.isUserAdminInGroup(userId, groupId);
		if (!isAdmin) {
			return [
				new ReturnMessage({
					chatId: groupId,
					content: "⛔ Apenas administradores podem resetar os dados do jogo.",
					options: {
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				})
			];
		}

		// Verifica quantos jogadores existem antes de deletar
		const countResult = await database.dbGet(
			dbName,
			`
      SELECT COUNT(*) as count FROM pinto_scores WHERE group_id = ?
    `,
			[groupId]
		);

		const numJogadores = countResult ? countResult.count : 0;

		// Verifica se há dados para este grupo
		if (numJogadores === 0) {
			return [
				new ReturnMessage({
					chatId: groupId,
					content: "⚠️ Não há dados do jogo para este grupo.",
					options: {
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				})
			];
		}

		// Obtém o ranking atual antes de resetar
		const rankingMessage = await pintoRankingCommand(bot, message, args, group);

		// Reseta os dados do grupo (Scores)
		await database.dbRun(
			dbName,
			`
      DELETE FROM pinto_scores WHERE group_id = ?
    `,
			[groupId]
		);

		// Retorna mensagens
		return [
			rankingMessage,
			new ReturnMessage({
				chatId: groupId,
				content: `🔄 *Dados do Jogo Pinto Resetados*\n\nForam removidos dados de ${numJogadores} jogadores deste grupo.\n\nO ranking acima mostra como estava antes do reset.`,
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			})
		];
	} catch (error) {
		logger.error("Erro ao resetar dados do jogo:", error);

		return [
			new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "Erro ao resetar dados do jogo. Por favor, tente novamente."
			})
		];
	}
}

// Criar array de comandos usando a classe Command
const commands = [
	new Command({
		name: "pinto",
		description: "Gera uma avaliação de tamanho aleatória",
		category: "jogos",
		cooldown: 0, // O cooldown é controlado internamente pelo lastUpdated
		reactions: {
			before: "📏",
			after: "🍆",
			error: "❌"
		},
		method: pintoCommand
	}),

	new Command({
		name: "pinto-ranking",
		description: "Mostra o ranking do jogo",
		category: "jogos",
		cooldown: 30,
		reactions: {
			after: "🏆",
			error: "❌"
		},
		method: pintoRankingCommand
	}),

	new Command({
		name: "pinto-reset",
		description: "Reseta os dados do jogo para este grupo",
		category: "jogos",
		adminOnly: true,
		cooldown: 60,
		reactions: {
			after: "🔄",
			error: "❌"
		},
		method: pintoResetCommand
	})
];

module.exports = { commands };
