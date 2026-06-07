// src/functions/TarotGame.js
const Logger = require("../utils/Logger");
const ReturnMessage = require("../models/ReturnMessage");
const Command = require("../models/Command");
const Database = require("../utils/Database");
const LLMService = require("../services/LLMService");
const bonsaiModule = require("./BonsaiCommands");

const logger = new Logger("tarot-game");
const database = Database.getInstance();
const llmService = LLMService.getInstance();
const dbName = "tarot";

// Initialize database
database.getSQLiteDb(
	dbName,
	`
    CREATE TABLE IF NOT EXISTS tarot_users (
      user_id TEXT PRIMARY KEY,
      last_used INTEGER
    );
    CREATE TABLE IF NOT EXISTS tarot_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      user_name TEXT,
      group_id TEXT,
      cards TEXT,
      reading TEXT,
      timestamp INTEGER
    );
`
);

const COOLDOWN_DAYS = 7;

// --- TAROT CARDS DATA ---
const TAROT_CARDS = [
	// Major Arcana (22)
	{ name: "O Louco", meaning: "Novos começos, espontaneidade, salto de fé." },
	{ name: "O Mago", meaning: "Manifestação, recursos, poder pessoal, ação." },
	{ name: "A Sacerdotisa", meaning: "Intuição, mistério, sabedoria interior." },
	{ name: "A Imperatriz", meaning: "Abundância, criatividade, nutrição, natureza." },
	{ name: "O Imperador", meaning: "Autoridade, estrutura, estabilidade, controle." },
	{ name: "O Hierofante", meaning: "Tradição, conformidade, busca de sentido." },
	{ name: "Os Enamorados", meaning: "Escolhas, relacionamentos, alinhamento de valores." },
	{ name: "O Carro", meaning: "Determinação, vitória, autocontrole, foco." },
	{ name: "A Justiça", meaning: "Equilíbrio, verdade, causa e efeito, integridade." },
	{ name: "O Eremita", meaning: "Introspecção, solidão, busca pela verdade." },
	{ name: "A Roda da Fortuna", meaning: "Ciclos, destino, mudanças inesperadas, sorte." },
	{ name: "A Força", meaning: "Coragem, paciência, compaixão, domínio interior." },
	{ name: "O Enforcado", meaning: "Pausa, rendição, ver as coisas por outro ângulo." },
	{ name: "A Morte", meaning: "Fim de ciclo, transformação profunda, renovação." },
	{ name: "A Temperança", meaning: "Equilíbrio, moderação, paciência, alquimia." },
	{ name: "O Diabo", meaning: "Apego, sombras, materialismo, tentação." },
	{ name: "A Torre", meaning: "Mudança súbita, destruição de falsas verdades." },
	{ name: "A Estrela", meaning: "Esperança, inspiração, cura, serenidade." },
	{ name: "A Lua", meaning: "Ilusão, medos, intuição, subconsciente." },
	{ name: "O Sol", meaning: "Sucesso, alegria, vitalidade, clareza." },
	{ name: "O Julgamento", meaning: "Renovação, despertar, chamado, reflexão." },
	{ name: "O Mundo", meaning: "Conclusão, realização, plenitude, viagem." },

	// Minor Arcana - Wands (Paus) - 14
	{ name: "Ás de Paus", meaning: "Nova inspiração, paixão, oportunidade criativa." },
	{ name: "Dois de Paus", meaning: "Planejamento, decisão de avançar, visão inicial." },
	{ name: "Três de Paus", meaning: "Expansão, olhar para o horizonte, progresso." },
	{ name: "Quatro de Paus", meaning: "Celebração, harmonia no lar, estabilidade alegre." },
	{ name: "Cinco de Paus", meaning: "Conflito, competição, tensão, defesa." },
	{ name: "Seis de Paus", meaning: "Reconhecimento, sucesso público, vitória merecida." },
	{ name: "Sete de Paus", meaning: "Persistência em meio a desafios, defesa de posição." },
	{ name: "Oito de Paus", meaning: "Movimento rápido, comunicação veloz, conclusão próxima." },
	{ name: "Nove de Paus", meaning: "Resiliência, defensiva, força final antes do fim." },
	{ name: "Dez de Paus", meaning: "Sobrecarga, responsabilidade excessiva, cansaço." },
	{ name: "Valete de Paus", meaning: "Mensageiro de ideias, entusiasmo, novidade." },
	{ name: "Cavaleiro de Paus", meaning: "Impulsividade, aventura, ação enérgica." },
	{ name: "Rainha de Paus", meaning: "Confiança, magnetismo, independência, calor." },
	{ name: "Rei de Paus", meaning: "Liderança visionária, empreendedorismo, carisma." },

	// Minor Arcana - Cups (Copas) - 14
	{ name: "Ás de Copas", meaning: "Amor puro, renovação emocional, intuição aberta." },
	{ name: "Dois de Copas", meaning: "Conexão profunda, parceria, união equilibrada." },
	{ name: "Três de Copas", meaning: "Amizade, celebração em grupo, alegria compartilhada." },
	{ name: "Quatro de Copas", meaning: "Apatia, reflexão interior, recusa de ofertas." },
	{ name: "Cinco de Copas", meaning: "Luto, foco no que foi perdido, decepção." },
	{ name: "Seis de Copas", meaning: "Nostalgia, memórias de infância, inocência." },
	{ name: "Sete de Copas", meaning: "Escolhas múltiplas, ilusão, sonhos excessivos." },
	{ name: "Oito de Copas", meaning: "Abandono emocional, busca por algo mais profundo." },
	{ name: "Nove de Copas", meaning: "Desejo realizado, satisfação emocional, prazer." },
	{ name: "Dez de Copas", meaning: "Felicidade familiar completa, alinhamento total." },
	{ name: "Valete de Copas", meaning: "Mensagem emocional, sensibilidade, convite amoroso." },
	{ name: "Cavaleiro de Copas", meaning: "Romantismo, busca por ideais, proposta afetiva." },
	{ name: "Rainha de Copas", meaning: "Empatia profunda, intuição guia, compaixão." },
	{ name: "Rei de Copas", meaning: "Estabilidade emocional, controle dos sentimentos, calma." },

	// Minor Arcana - Swords (Espadas) - 14
	{ name: "Ás de Espadas", meaning: "Clareza mental radical, verdade, avanço intelectual." },
	{ name: "Dois de Espadas", meaning: "Impasse, negação, decisão difícil a ser tomada." },
	{ name: "Três de Espadas", meaning: "Coração partido, separação, dor necessária." },
	{ name: "Quatro de Espadas", meaning: "Descanso mental, recuperação, tempo de pausa." },
	{ name: "Cinco de Espadas", meaning: "Conflito agressivo, vitória vazia, má fé." },
	{ name: "Seis de Espadas", meaning: "Transição difícil, busca por águas calmas, viagem." },
	{ name: "Sete de Espadas", meaning: "Estratégia, sigilo, possível desonestidade." },
	{ name: "Oito de Espadas", meaning: "Prisão mental, sensação de impotência, restrição." },
	{ name: "Nove de Espadas", meaning: "Ansiedade, pesadelos, preocupação excessiva." },
	{ name: "Dez de Espadas", meaning: "Fundo do poço, final doloroso, traição final." },
	{ name: "Valete de Espadas", meaning: "Vigilância, curiosidade mental, novas ideias." },
	{ name: "Cavaleiro de Espadas", meaning: "Foco total, rapidez de pensamento, ambição." },
	{ name: "Rainha de Espadas", meaning: "Objetividade, clareza, honestidade direta." },
	{ name: "Rei de Espadas", meaning: "Intelecto soberano, autoridade lógica, justiça." },

	// Minor Arcana - Pentacles (Ouros) - 14
	{ name: "Ás de Ouros", meaning: "Nova oportunidade material, prosperidade inicial." },
	{ name: "Dois de Ouros", meaning: "Equilíbrio de recursos, adaptabilidade, prioridade." },
	{ name: "Três de Ouros", meaning: "Trabalho em equipe, competência, construção." },
	{ name: "Quatro de Ouros", meaning: "Apego material, segurança defensiva, controle financeiro." },
	{ name: "Cinco de Ouros", meaning: "Dificuldade financeira, isolamento, perda material." },
	{ name: "Seis de Ouros", meaning: "Generosidade, caridade, equilíbrio entre dar e receber." },
	{ name: "Sete de Ouros", meaning: "Paciência, avaliação de progresso, investimento longo." },
	{ name: "Oito de Ouros", meaning: "Diligência, aperfeiçoamento de técnica, aprendizado." },
	{ name: "Nove de Ouros", meaning: "Independência financeira, luxo, colheita própria." },
	{ name: "Dez de Ouros", meaning: "Riqueza geracional, herança, segurança a longo prazo." },
	{ name: "Valete de Ouros", meaning: "Semente de oferta prática, ambição realista." },
	{ name: "Cavaleiro de Ouros", meaning: "Consistência, trabalho árduo, avanço lento mas seguro." },
	{ name: "Rainha de Ouros", meaning: "Abundância prática, conforto, generosidade nutridora." },
	{ name: "Rei de Ouros", meaning: "Sucesso empresarial, estabilidade material, maestria." }
];

// --- PHRASES DATA ---
const ENTRANCE_PHRASES = [
	"Sente-se... sinto uma energia densa ao seu redor. 🕯️",
	"As estrelas se alinharam para revelar seu destino hoje. 🌠",
	"O véu entre os mundos está fino... vamos ver o que ele esconde. 🌫️",
	"Respire fundo. As cartas não mentem, apenas revelam o que você já sabe. 🧘",
	"Em cada lâmina, uma verdade; em cada símbolo, um caminho. Vamos começar? 🎴",
	"As energias do cosmos me sussurram sua presença... aproxime-se. 🌌",
	"O destino é um rio que corre, e as cartas são os marcos na margem. 🌊",
	"Sinto que você carrega perguntas que apenas o oculto pode responder. 🔮",
	"Entre na luz da clarividência, o futuro aguarda sua primeira olhada. ✨",
	"Os guias sussurram seu nome. Deixe-me ver o que o amanhã lhe reserva. 🎩"
];

const DRAW_PHRASES = [
	"As cartas que guiarão este momento são:",
	"As cartas reveladas para sua jornada são:",
	"O destino se manifesta nestas lâminas sagradas:",
	"O que o universo decidiu te mostrar agora:",
	"A mensagem do oculto está nestas três verdades:",
	"Velas acesas e cartas postas... contemple seu sorteio:",
	"As forças invisíveis escolheram estas cartas para você:"
];

const FALLBACK_PHRASES = [
	"O véu entre os mundos está muito espesso agora... não consegui uma leitura clara. 🌫️",
	"As energias estão em conflito e minha visão falhou por um momento místico. ⚡",
	"Os oráculos se silenciaram momentaneamente, mas as cartas ainda têm significado. 🤫",
	"Sinto uma interferência astral de Marte... tente novamente mais tarde para uma análise profunda! 🪐",
	"As cartas estão relutantes em falar detalhadamente comigo agora. Vamos ver o básico? 🔮",
	"Uma névoa espiritual cobriu minha bola de cristal hoje. 🌫️"
];

// --- HELPER FUNCTIONS ---

function getRandom(arr) {
	return arr[Math.floor(Math.random() * arr.length)];
}

async function checkCooldown(userId) {
	const row = await database.dbGet(dbName, "SELECT last_used FROM tarot_users WHERE user_id = ?", [
		userId
	]);
	if (row && row.last_used) {
		const now = Date.now();
		const cooldownMs = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
		if (now - row.last_used < cooldownMs) {
			return { inCooldown: true, remaining: cooldownMs - (now - row.last_used) };
		}
	}
	return { inCooldown: false };
}

async function setCooldown(userId) {
	await database.dbRun(
		dbName,
		"INSERT INTO tarot_users (user_id, last_used) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET last_used = excluded.last_used",
		[userId, Date.now()]
	);
}

async function saveHistory(userId, userName, chatId, cards, reading) {
	await database.dbRun(
		dbName,
		"INSERT INTO tarot_history (user_id, user_name, group_id, cards, reading, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
		[userId, userName, chatId, cards.join(", "), reading, Date.now()]
	);
}

// --- COMMAND FUNCTION ---

async function tarotCommand(bot, message, args, group) {
	const userId = message.author ?? message.authorAlt;
	const userName =
		message.name ?? message.pushName ?? message.pushname ?? message.authorName ?? "Busca-Destino";
	const chatId = message.group ?? message.author;

	// 1. Check Cooldown
	const cooldown = await checkCooldown(userId);
	if (cooldown.inCooldown) {
		const daysLeft = Math.ceil(cooldown.remaining / (24 * 60 * 60 * 1000));
		return new ReturnMessage({
			chatId,
			content: `⚖️ *Destino em Pausa* ⏳\n\n*${userName}*, você já consultou as cartas recentemente.\n\nAguarde o ciclo lunar se completar (${daysLeft} dias restantes) para uma nova tiragem profunda.`,
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	}

	// 2. Draw Cards
	const drawn = [];
	const available = [...TAROT_CARDS];
	for (let i = 0; i < 3; i++) {
		const index = Math.floor(Math.random() * available.length);
		drawn.push(available.splice(index, 1)[0]);
	}

	const entrance = getRandom(ENTRANCE_PHRASES);
	const drawIntro = getRandom(DRAW_PHRASES);
	const cardNames = drawn.map((c) => `*${c.name}*`).join(", ");

	let response = `🔮 *Cartomante _ravenabot_* 🎩\n\n`;
	response += `✨ _${entrance}_ 🪄\n\n`;
	response += `🎴 ${drawIntro}\n${cardNames}\n\n`;

	// 3. IA Analysis
	let prompt = `Faça uma análise mística, encorajadora e profunda de tarô para o usuário ${userName}.
As cartas tiradas foram:
1. ${drawn[0].name} (Posição: Situação/Passado/Cerne)
2. ${drawn[1].name} (Posição: Desafio/Presente/Ação)
3. ${drawn[2].name} (Posição: Caminho/Futuro/Conselho)

Exiba sempre "Situação, Desafio e Caminho"
`;

	const question = args.join(" ");
	if (question.length > 0) {
		prompt += `O usuário fez a seguinte pergunta ou busca orientação sobre: "${question}"\nLeve isso em conta na sua interpretação e como foco da tiragem.\n\n`;
	}

	prompt += `Entregue uma interpretação sucinta, resumida, única, fluida e envolvente, conectando situação, desafio e caminho. Use um tom místico, direto e pessoal, como se estivesse captando a energia da pessoa. Não faça perguntas e entregue tudo em uma única mensagem. Ao final, escolha UMA área da vida que MAIS SE RELACIONE com as cartas tiradas (ex: finanças, saúde física, carreira, amizades, espiritualidade, família, autocuidado, etc.) e dê um conselho final curto e inspirador. Seja criativo: evite focar sempre em 'emoções' ou usar frases repetitivas como 'cuide de suas emoções'.
Responda em PORTUGUÊS BRASIL.`;

	let analysis = "";
	try {
		logger.debug(`[Tarot] Requesting IA analysis for ${userName}`);
		analysis = await llmService.getCompletion({
			prompt,
			systemContext:
				"Você é uma cartomante experiente, futurista e misteriosa chamada ravenabot. Suas respostas sempre são em 800 caracteres ou menos, sucintas mas poderosas.",
			priority: 5
		});
	} catch (error) {
		logger.error("[Tarot] Error in IA analysis:", error);
	}

	if (analysis && analysis.length > 50) {
		// Success
		await setCooldown(userId);
		await saveHistory(
			userId,
			userName,
			chatId,
			drawn.map((c) => c.name),
			analysis
		);

		const fullContent = response + `> ${analysis}\n`;

		// 4. Try to generate Image
		try {
			const imagePrompt = `Mesa de Tarot em uma taverna futurista. Mesa de madeira, mística, neon. Contém 3 cartas de tarot recém selecionadas: ${drawn[0].name}, ${drawn[1].name}, ${drawn[2].name}. Estilo místico, futurista, detalhado, iluminação neon suave.`;
			const imageResult = await bonsaiModule.generateImage(bot, message, imagePrompt, group, true, {
				skipNSFW: true,
				isProgrammatic: true
			});

			// Check if we got a valid image ReturnMessage
			// ComfyUI's generateImage returns a ReturnMessage or ReturnMessage[]
			let media = null;
			if (Array.isArray(imageResult)) {
				const mediaMsg = imageResult.find((m) => m.content && m.content.mimetype);
				if (mediaMsg) media = mediaMsg.content;
			} else if (imageResult && imageResult.content && imageResult.content.mimetype) {
				media = imageResult.content;
			}

			if (media) {
				// We have an image! Handle caption limit (1024 chars for WA, user asked for 1000)
				if (fullContent.length < 1000) {
					return new ReturnMessage({
						chatId,
						content: media,
						options: {
							caption: fullContent,
							quotedMessageId: message.origin.id._serialized,
							goReply: message.origin
						}
					});
				} else {
					// Split: Image first, then text
					return [
						new ReturnMessage({
							chatId,
							content: media,
							options: {
								quotedMessageId: message.origin.id._serialized,
								goReply: message.origin
							}
						}),
						new ReturnMessage({
							chatId,
							content: fullContent,
							delay: 500,
							options: {
								quotedMessageId: message.origin.id._serialized,
								goReply: message.origin
							}
						})
					];
				}
			}
		} catch (imgError) {
			logger.error("[Tarot] Error generating image, falling back to text:", imgError);
		}

		// Fallback to text-only if image failed or not returned
		return new ReturnMessage({
			chatId,
			content: fullContent,
			options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
		});
	} else {
		// Fallback
		const fallbackText = getRandom(FALLBACK_PHRASES);
		response += `> ${fallbackText}\n\n`;
		response += `📝 *Significados Rápidos:*\n`;
		drawn.forEach((c) => {
			response += `• *${c.name}*: ${c.meaning}\n`;
		});
		response += `\n⚠️ _Sua leitura não pôde ser analisada profundamente agora. Por esse motivo, você poderá tentar novamente quando desejar sem aguardar os 7 dias!_`;
	}

	return new ReturnMessage({
		chatId,
		content: response,
		options: { quotedMessageId: message.origin.id._serialized, goReply: message.origin }
	});
}

const commands = [
	new Command({
		name: "tarot",
		description: "Consulta a cartomante para uma tiragem",
		category: "jogos",
		reactions: {
			before: "🕯️",
			after: "🔮"
		},
		method: tarotCommand
	})
];

module.exports = { commands };
