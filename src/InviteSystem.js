const Logger = require("./utils/Logger");
const Database = require("./utils/Database");
const LLMService = require("./services/LLMService");
const path = require("path");
const fs = require("fs").promises;

const MIN_REASON_LENGTH = 15;

/**
 * Verifica se a string contém caracteres "estranhos" (fontes personalizadas,
 * zalgo, marcas de combinação, símbolos exóticos/ornamentais)
 * @param {string} str
 * @returns {boolean}
 */
function hasStrangeCharacters(str) {
	if (!str) return false;

	// 1. Math Alphanumeric Symbols (e.g. 𝖲, 𝗔, 𝖫, 𝖵, 🄐, 𝕾, 𝗤, 𝔄, 𝓐)
	const mathAndEnclosed = /[\u{1D400}-\u{1D7FF}\u{2460}-\u{24FF}\u{1F100}-\u{1F1FF}]/u;
	if (mathAndEnclosed.test(str)) return true;
	// 2. Combining marks (strikethrough, underline, Zalgo, Arabic combining marks, etc.)
	/* eslint-disable no-misleading-character-class */
	const combiningMarks =
		/[\u0300-\u036F\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F\u0610-\u061A\u064B-\u065F\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06EC]/;
	/* eslint-enable no-misleading-character-class */
	if (combiningMarks.test(str)) return true;

	// 3. Specific decorative/exotic symbols commonly used in fancy nickname formatting:
	const exoticOrOrnamental =
		/[\u0F00-\u0FFF\u0A00-\u0A7F\u2C80-\u2CFF\u2700-\u27BF\u2500-\u25FF\u2600-\u26FF\u2200-\u22FF\u2300-\u23FF\u{10650}-\u{10660}]/u;
	if (exoticOrOrnamental.test(str)) return true;

	return false;
}

/**
 * Gerencia o sistema de convites para o bot
 * * Fluxo de trabalho:
 * 1. Usuário envia um link de convite para o bot em um chat privado
 * 2. Bot pergunta o motivo para adicionar o bot ao grupo
 * 3. Usuário responde com um motivo ou ocorre timeout
 * 4. Bot encaminha os detalhes do convite para um grupo designado para aprovação
 * 5. Admins podem usar um comando para entrar no grupo
 */
class InviteSystem {
	// Registro de entradas automáticas recentes por bot (botId -> [timestamp, ...]) para limite de 3/30m
	static recentBotJoins = new Map();

	/**
	 * Cria uma nova instância do InviteSystem
	 * @param {WhatsAppBot} bot - A instância do bot
	 */
	constructor(bot) {
		this.bot = bot;
		this.logger = new Logger(`invite-system-${bot.id}`);
		this.database = Database.getInstance();
		this.pendingRequests = new Map(); // Mapa de autor -> { inviteLink, timeout }
		this.inviteCooldown = 60; // Padrão 60 minutos (para o cooldown de convite por usuário)
		this.userCooldowns = new Map(); // Mapa de autor -> timestamp do último convite de usuário
		this.groupInviteCooldowns = new Map(); // Mapa de inviteCode -> timestamp do último convite do grupo
		this.blockedUserNotifyCache = new Map(); // Mapa de author -> timestamp da última notificação de bloqueio
		this.groupCooldownNotifyCache = new Map(); // Mapa de inviteCode -> timestamp da última notificação de cooldown
	}

	rndString() {
		return (Math.random() + 1).toString(36).substring(7);
	}

	isCommunity(data) {
		return (
			data?.IsParent === true ||
			data?.isParent === true ||
			data?.IsCommunity === true ||
			data?.isCommunity === true ||
			data?.IsCommunityAnnounce === true ||
			data?.isCommunityAnnounce === true
		);
	}

	static canBotJoin(botId) {
		const now = Date.now();
		const windowMs = 30 * 60 * 1000;
		const joins = (InviteSystem.recentBotJoins.get(botId) || []).filter((t) => now - t < windowMs);
		InviteSystem.recentBotJoins.set(botId, joins);
		return joins.length < 3;
	}

	static recordBotJoin(botId) {
		const now = Date.now();
		const joins = InviteSystem.recentBotJoins.get(botId) || [];
		joins.push(now);
		InviteSystem.recentBotJoins.set(botId, joins);
	}

	/**
	 * Seleciona o melhor bot elegível para entrar no grupo automaticamente
	 * Critérios:
	 * - Bot normal (habilitado, não vip, não privado, não comunitário, não banido, não telegram/discord)
	 * - Menor quantidade de mensagens na semana (últimos 7 dias via load_reports)
	 * - Máximo de 3 grupos a cada 30 minutos
	 * @returns {Promise<WhatsAppBotGo|null>}
	 */
	async selectBestBotForAutoJoin() {
		try {
			const allBots = this.database.botInstances || [];
			const eligibleBots = allBots.filter((b) => {
				if (!b || b.banido || b.vip || b.privado || b.comunitario) return false;
				if (b.useTelegram || b.useDiscord) return false;
				if (b.ignoreInvites) return false;
				if (!b.client || typeof b.client.acceptInvite !== "function") return false;
				return true;
			});

			if (eligibleBots.length === 0) {
				this.logger.warn("Nenhum bot normal elegível e disponível para auto-join");
				return null;
			}

			// Busca totais de mensagens na semana
			const weeklyTotals = await this.database.getBotsWeeklyMessageTotals();

			// Ordena por menor mensagens na semana
			eligibleBots.sort((a, b) => {
				const countA = weeklyTotals.get(a.id) || 0;
				const countB = weeklyTotals.get(b.id) || 0;
				return countA - countB;
			});

			for (const candidate of eligibleBots) {
				if (InviteSystem.canBotJoin(candidate.id)) {
					return candidate;
				}
			}

			this.logger.warn("Todos os bots elegíveis atingiram o limite de 3 grupos em 30 minutos");
			return null;
		} catch (err) {
			this.logger.error("Erro ao selecionar bot para auto join:", err);
			return null;
		}
	}

	/**
	 * Avalia a solicitação de convite com a LLM
	 * @param {Object} params
	 * @returns {Promise<{ shouldAutoAccept: boolean, reason: string, rawResponse?: string }>}
	 */
	async evaluateAutoAcceptWithLLM({
		userName,
		authorId,
		groupName,
		participantCount,
		description,
		reason,
		isDonator = false,
		donateValue = 0
	}) {
		// Doador acima de R$49: Aceite automático direto
		if (isDonator && donateValue > 49) {
			return {
				shouldAutoAccept: true,
				reason: `Doador VIP (R$${donateValue}) - Aceite automático garantido`
			};
		}

		// 1. Pré-filtros determinísticos para economizar tokens
		// Se doador >= 10, aceita independente da quantidade de membros
		if (!isDonator || donateValue < 10) {
			if (typeof participantCount === "number" && participantCount < 3) {
				return {
					shouldAutoAccept: false,
					reason: `Grupo com poucos participantes (${participantCount} membros)`
				};
			}
		}

		if (hasStrangeCharacters(userName)) {
			return {
				shouldAutoAccept: false,
				reason: "Caracteres estranhos/ornamentais no nome do usuário"
			};
		}

		if (hasStrangeCharacters(groupName)) {
			return {
				shouldAutoAccept: false,
				reason: "Caracteres estranhos/ornamentais no título do grupo"
			};
		}

		if (hasStrangeCharacters(description)) {
			return {
				shouldAutoAccept: false,
				reason: "Caracteres estranhos/ornamentais na descrição do grupo"
			};
		}

		// Rejeição de grupos de teste pelo título
		const normGroupName = (groupName || "")
			.toLowerCase()
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "");
		if (/\b(teste|testes|test|tests|testar|testando)\b/i.test(normGroupName)) {
			return {
				shouldAutoAccept: false,
				reason: `Grupo de testes identificado no título ("${groupName}")`
			};
		}

		// Rejeição de motivos com menção a teste
		const normReason = (reason || "")
			.toLowerCase()
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "");
		if (
			/\b(testar|teste|testes|testando)\b/i.test(normReason) ||
			normReason.includes("para testar") ||
			normReason.includes("pra testar") ||
			normReason.includes("so teste")
		) {
			return {
				shouldAutoAccept: false,
				reason: `Motivo menciona teste ("${reason}")`
			};
		}

		// Se doador >= 30, aceita mesmo com motivo ruim
		if (!isDonator || donateValue < 30) {
			const cleanReason = (reason || "").trim().toLowerCase();
			const badReasons = [
				"tenho permissão",
				"tenho permissao",
				"sim",
				"posso te colocar",
				"entra aí",
				"entra ai",
				"entra por favor",
				"entra pfv",
				"coloca aí",
				"quero testar",
				"legal"
			];
			if (
				badReasons.some(
					(br) => cleanReason === br || cleanReason === `${br}.` || cleanReason === `${br}!`
				)
			) {
				return {
					shouldAutoAccept: false,
					reason: `Motivo genérico/fraco ("${reason}")`
				};
			}
		}

		// 2. Avaliação via LLM
		try {
			const llmService = LLMService.getInstance();
			const autoAcceptSchema = {
				type: "json_schema",
				json_schema: {
					name: "auto_accept_evaluation",
					schema: {
						type: "object",
						properties: {
							should_auto_accept: {
								type: "boolean",
								description:
									"True apenas se o grupo cumprir todos os critérios para ser aceito automaticamente."
							},
							reason: {
								type: "string",
								description:
									"Explicação concisa (em português) do motivo para aceitar ou recusar automaticamente."
							}
						},
						required: ["should_auto_accept", "reason"],
						additionalProperties: false
					}
				}
			};

			const systemPrompt = `Você é um avaliador criterioso de convites de grupos para bots de WhatsApp.
Seu objetivo é decidir se um grupo deve ser ACEITO AUTOMATICAMENTE ou se deve ser enviado para moderação manual humana.

REGRAS ESTRITAS DE REJEIÇÃO (NUNCA ACEITAR AUTOMATICAMENTE):
1. Caracteres estranhos/fontes ornamentais/zalgo no nome da pessoa, grupo ou descrição.
2. Grupos com menos de 3 pessoas (a menos que o usuário seja doador R$10+).
3. Grupos que pareçam ser de menor de idade (turmas de colégio, escola, vocabulário infantil/underage).
4. Motivos ruins, preguiçosos ou genéricos ("tenho permissão", "sim", "posso te colocar", "entra aí", "entra por favor", etc., a menos que o usuário seja doador R$30+).
5. Título, descrição ou motivo com qualquer sinal de racismo, homofobia, xenofobia, assédio, pedofilia, drogas ilícitas, gore, extremismo ou ódio (NUNCA aceitar, mesmo se for doador).
6. Grupos de teste ou com finalidade de testes (palavra 'teste'/'testar' no nome do grupo, descrição ou motivo).

CRITÉRIOS POSITIVOS PARA ACEITAÇÃO AUTOMÁTICA:
1. Usuário Doador (grande peso):
   - R$1 a R$10: Aceitar mesmo com motivo intermediário/simples se a descrição for coerente.
   - R$10 a R$30: Aceitar independente da quantidade de membros.
   - R$30 a R$49: Aceitar mesmo com motivo ruim/fraco.
   - Acima de R$49: Sempre aceitar (desde que sem conteúdo ilegal/ódio).
2. Motivo bem escrito, educado e detalhado, justificando o uso das funções do bot sem quebrar regras.
3. Grupo de streamer: possui nome ou link de canal (Twitch, YouTube, Kick) na descrição ou tags "[OFF]" ou "[ON]" no título.

Seja exigente: em caso de dúvida, falta de clareza ou risco potencial, recuse (should_auto_accept: false).
Responda APENAS com um objeto JSON no formato especificado.`;

			const donorInfo = isDonator ? `Sim (💸 R$${donateValue} 💰)` : "Não";

			const prompt = `Analise a solicitação de convite abaixo:

- Usuário solicitante: "${userName}" (${authorId.split("@")[0]})
- Doador: ${donorInfo}
- Nome do Grupo: "${groupName || "Desconhecido"}"
- Membros: ${participantCount ?? "Desconhecido"}
- Descrição do Grupo: "${description || "Sem descrição"}"
- Motivo enviado pelo usuário:
"${reason}"

Decida se este grupo deve ser aceito automaticamente.`;

			const response = await llmService.getCompletion({
				prompt,
				systemContext: systemPrompt,
				response_format: autoAcceptSchema,
				priority: 2,
				timeout: 30000
			});

			if (response) {
				const cleanResponse = response.replace(/```json|```/g, "").trim();
				const parsed = JSON.parse(cleanResponse);
				return {
					shouldAutoAccept: Boolean(parsed.should_auto_accept),
					reason: parsed.reason || "Avaliado pela IA",
					rawResponse: cleanResponse
				};
			} else {
				return {
					shouldAutoAccept: false,
					reason: "IA não retornou resposta"
				};
			}
		} catch (err) {
			this.logger.error("Erro ao avaliar convite com LLM:", err);
			return {
				shouldAutoAccept: false,
				reason: `Falha na avaliação IA: ${err.message}`
			};
		}
	}

	/**
	 * Processa uma mensagem privada que pode conter um link de convite
	 * @param {Object} message - O objeto da mensagem
	 * @returns {Promise<boolean>} - Se a mensagem foi tratada como um convite
	 */
	async processMessage(message) {
		try {
			// Processa apenas mensagens privadas
			if (message.group) return false;

			const text = message.type === "text" ? message.content : message.caption;
			if (!text) return false;

			// Verifica se a mensagem contém um link de convite do WhatsApp
			const inviteMatch = text.match(/chat.whatsapp.com\/([a-zA-Z0-9]{10,50})/i);
			if (!inviteMatch) return false;

			const inviteLink = inviteMatch[0];
			const inviteCode = inviteMatch[1];
			const currentTime = Date.now();

			// Checa se o link é comunidade antes de iniciar cooldown ou pedir motivo
			try {
				if (this.bot.client && typeof this.bot.client.getInviteInfo === "function") {
					const infoCheck = await this.bot.client.getInviteInfo(inviteCode);
					if (infoCheck && this.isCommunity(infoCheck)) {
						this.logger.info(
							`Ignorando convite de comunidade de ${message.author} (${inviteCode}) sem aplicar cooldown.`
						);
						if (message.origin && typeof message.origin.react === "function") {
							message.origin.react("👥");
						}
						await this.bot.sendMessage(
							message.author,
							"Este link parece ser de uma *comunidade*, e o bot não consegue entrar em comunidades inteiras. Por favor, tente novamente enviando o link do *grupo específico* dentro da comunidade que você deseja adicionar!"
						);
						return true;
					}
				}
			} catch (infoErr) {
				this.logger.debug(
					`Erro ao checar info prévia do convite ${inviteCode} em processMessage:`,
					infoErr?.message
				);
			}

			const isBlocked = await this.database.isUserInviteBlocked(message.author.split("@")[0]);
			if (isBlocked) {
				this.logger.info(
					`Ignorando convite de usuário bloqueado: ${message.author} Link: ${inviteLink}`
				);
				message.origin.react("🛑");

				const lastNotify = this.blockedUserNotifyCache.get(message.author) || 0;
				// Notifica max 1x por semana (7 dias * 24h * 60m * 60s * 1000ms)
				if (currentTime - lastNotify > 7 * 24 * 60 * 60 * 1000) {
					await this.bot.sendMessage(
						message.author,
						`🛑 A ${this.bot.nomeExibir || "ravenabot"} não está mais recebendo convites de seu número, pois você foi bloqueado.`
					);
					// if (this.bot.grupoInvites) {
					// 	await this.bot.sendMessage(
					// 		this.bot.grupoInvites,
					// 		`🛑 Usuário bloqueado tentou enviar convite: ${message.author}\nLink: ${inviteLink}`
					// 	);
					// }
					this.blockedUserNotifyCache.set(message.author, currentTime);
				}

				return true;
			}

			// Verifica se o invite code está bloqueado
			const isInviteBlocked = await this.database.isInviteBlocked(inviteCode, null);
			if (isInviteBlocked) {
				this.logger.info(`Ignorando link de invite bloqueado: ${inviteLink}`);
				message.origin.react("🛑");
				await this.bot.sendMessage(
					message.author,
					`🛑 A ${this.bot.nomeExibir || "ravenabot"} não recebe mais convite deste grupo, pois ele foi bloqueado.`
				);

				// if (this.bot.grupoInvites) {
				// 	await this.bot.sendMessage(
				// 		this.bot.grupoInvites,
				// 		`🛑 Usuário ${message.author} tentou enviar convite de grupo bloqueado: ${inviteLink}`
				// 	);
				// }
				return true;
			}

			// Verifica o cooldown do usuário
			const lastUserInviteTime = this.userCooldowns.get(message.author);
			const userCooldownDurationMs = this.inviteCooldown * 60 * 1000; // Cooldown do usuário em milissegundos

			if (lastUserInviteTime && currentTime - lastUserInviteTime < userCooldownDurationMs) {
				this.logger.info(
					`Usuário ${message.author} está em cooldown para convites. Ignorando (invite? '${inviteMatch}').`
				);
				if (inviteMatch) {
					message.origin.react("⏰");
					return true;
				} else {
					return false;
				}
			}

			// Verifica o cooldown do grupo (inviteCode)
			const lastGroupInviteTime = this.groupInviteCooldowns.get(inviteCode);
			const groupCooldownDurationMs = this.inviteCooldown * 60 * 1000; // Cooldown do grupo em milissegundos

			if (lastGroupInviteTime && currentTime - lastGroupInviteTime < groupCooldownDurationMs) {
				this.logger.info(`Convite para o grupo ${inviteCode} está em cooldown. Ignorando.`);
				message.origin.react("⏱️");

				const lastGroupNotify = this.groupCooldownNotifyCache.get(inviteCode) || 0;
				// Notifica max 1x por hora
				if (currentTime - lastGroupNotify > 60 * 60 * 1000) {
					await this.bot.sendMessage(
						message.author,
						"⏱️ Você já enviou um convite recentemente, este link foi ignorado"
					);
					this.groupCooldownNotifyCache.set(inviteCode, currentTime);
				}
				return true; // Retorna true para parar o processamento aqui
			}

			this.logger.info(`Recebido convite de grupo de ${message.author}: ${inviteLink}`, {
				message
			});

			// Verifica se o usuário já tem uma solicitação pendente
			if (this.pendingRequests.has(message.author)) {
				// Limpa o timeout anterior
				clearTimeout(this.pendingRequests.get(message.author).timeout);
				this.pendingRequests.delete(message.author);
			}

			const invitesPrePath = path.join(this.database.databasePath, "textos", "invites_pre.txt");
			const preConvite = await fs.readFile(invitesPrePath, "utf8");

			// Gera código de verificação
			const verificationCode = this.rndString();

			// Pergunta o motivo para adicionar o bot
			await this.bot.sendMessage(message.author, `${preConvite}\n\`${verificationCode}\``);

			// Define um timeout para tratar o convite mesmo se o usuário não responder
			const timeoutId = setTimeout(
				() => {
					this.handleInviteRequest(
						message.author,
						inviteCode,
						inviteLink,
						"Nenhum motivo fornecido",
						message
					);
				},
				5 * 60 * 1000
			); // 5 minutos

			// Armazena a solicitação pendente
			this.pendingRequests.set(message.author, {
				inviteLink,
				inviteCode,
				timeout: timeoutId,
				verificationCode,
				preConviteContent: preConvite // Guarda o conteúdo para verificar preguiça depois
			});

			// Define o timestamp do último convite para o usuário (inicia o cooldown de usuário)
			this.userCooldowns.set(message.author, currentTime);
			// Define o timestamp do último convite para o grupo (inicia o cooldown de grupo)
			this.groupInviteCooldowns.set(inviteCode, currentTime);

			return true;
		} catch (error) {
			this.logger.error("Erro ao processar potencial convite:", error);
			return false;
		}
	}

	/**
	 * Processa uma mensagem de acompanhamento (motivo do convite)
	 * @param {Object} message - O objeto da mensagem
	 * @returns {Promise<boolean>} - Se a mensagem foi tratada como um motivo de convite
	 */
	async processFollowUpMessage(message) {
		try {
			// Processa apenas mensagens privadas
			if (message.group) return false;

			// Verifica se o usuário tem uma solicitação pendente
			if (!this.pendingRequests.has(message.author)) return false;

			// Somente mensagens de texto são consideradas como motivo
			if (message.type !== "text") return false;
			const text = message.content;
			if (!text) return false;

			const requestData = this.pendingRequests.get(message.author);
			const {
				inviteCode,
				inviteLink,
				timeout,
				verificationCode,
				preConviteContent,
				accumulatedMessages
			} = requestData;

			// 1. Verifica se enviou o código de verificação — ainda processado imediatamente
			if (verificationCode && text.trim().toLowerCase() === verificationCode.toLowerCase()) {
				clearTimeout(timeout);
				if (requestData.accumulationTimeout) clearTimeout(requestData.accumulationTimeout);
				this.pendingRequests.delete(message.author);
				await this.handleInviteRequest(
					message.author,
					inviteCode,
					inviteLink,
					text,
					message,
					verificationCode,
					preConviteContent
				);
				return true;
			}

			// 2. Se já está acumulando mensagens, apenas adiciona ao buffer
			if (accumulatedMessages) {
				accumulatedMessages.push(text.trim());
				// Atualiza o requestData (array é mutável, mas mantemos a referência)
				this.pendingRequests.set(message.author, { ...requestData, accumulatedMessages });
				return true;
			}

			// 3. Primeira mensagem de motivo: cancela o timeout de 5 min e inicia acumulação de 30s
			clearTimeout(timeout);

			const newAccumulatedMessages = [text.trim()];

			const accumulationTimeoutId = setTimeout(() => {
				this._processAccumulatedReason(message.author, message).catch((err) =>
					this.logger.error("Erro ao processar motivo acumulado:", err)
				);
			}, 30 * 1000);

			this.pendingRequests.set(message.author, {
				...requestData,
				timeout: null,
				accumulatedMessages: newAccumulatedMessages,
				accumulationTimeout: accumulationTimeoutId
			});

			return true;
		} catch (error) {
			this.logger.error("Erro ao processar mensagem de acompanhamento de convite:", error);
			return false;
		}
	}

	/**
	 * Processa o motivo acumulado após o período de 30 segundos
	 * @param {string} authorId - ID do usuário
	 * @param {Object} originalMessage - Objeto da primeira mensagem de motivo
	 */
	async _processAccumulatedReason(authorId, originalMessage) {
		const requestData = this.pendingRequests.get(authorId);
		if (!requestData) return;

		const {
			inviteCode,
			inviteLink,
			verificationCode,
			preConviteContent,
			accumulatedMessages,
			secondChance
		} = requestData;

		const reason = (accumulatedMessages || []).join("\n").trim();

		// Sem motivo algum
		if (!reason) {
			this.pendingRequests.delete(authorId);
			await this.handleInviteRequest(
				authorId,
				inviteCode,
				inviteLink,
				"Nenhum motivo fornecido",
				originalMessage,
				verificationCode,
				preConviteContent
			);
			return;
		}

		// Verifica se o motivo é muito curto
		if (reason.length < MIN_REASON_LENGTH) {
			if (!secondChance) {
				// Primeira tentativa curta: dá segunda chance com nova janela de 30s
				const secondChanceMsg =
					`O motivo é apenas um filtro inicial pro criador analisar se seu grupo não vai fazer mau uso do bot. Não precisa ser nada absurdo, mas escreve pelo menos ${MIN_REASON_LENGTH} caracteres aí!\n\n` +
					"Vou te dar mais uma chance.";

				await this.bot.sendMessage(authorId, secondChanceMsg);

				// Nova janela de acumulação de 30s para a segunda chance
				const accumulationTimeoutId = setTimeout(() => {
					this._processAccumulatedReason(authorId, originalMessage).catch((err) =>
						this.logger.error("Erro ao processar motivo acumulado (2ª chance):", err)
					);
				}, 30 * 1000);

				this.pendingRequests.set(authorId, {
					...requestData,
					secondChance: true,
					accumulatedMessages: [],
					accumulationTimeout: accumulationTimeoutId,
					timeout: null
				});
				return;
			} else {
				// Segunda tentativa curta: aplica cooldown estendido e descarta
				this.pendingRequests.delete(authorId);

				try {
					const ignoredPath = path.join(
						this.database.databasePath,
						"textos",
						"invite_ignorado.txt"
					);
					const ignoredText = await fs
						.readFile(ignoredPath, "utf8")
						.catch(
							() =>
								"Parece que ler e escrever não é seu forte, né? Seu convite _não foi registrado_ e suas próximas requisições serão ignoradas durante algumas horas."
						);
					await this.bot.sendMessage(authorId, ignoredText);
				} catch (err) {
					await this.bot.sendMessage(
						authorId,
						"Parece que ler e escrever não é seu forte, né? Seu convite _não foi registrado_ e suas próximas requisições serão ignoradas durante algumas horas."
					);
				}

				const punishDuration = 10 * this.inviteCooldown * 60 * 1000;
				const normalDuration = this.inviteCooldown * 60 * 1000;
				const futureTime = Date.now() + punishDuration - normalDuration;
				this.userCooldowns.set(authorId, futureTime);
				return;
			}
		}

		// Motivo válido: processa o convite com todas as mensagens acumuladas
		this.pendingRequests.delete(authorId);
		await this.handleInviteRequest(
			authorId,
			inviteCode,
			inviteLink,
			reason,
			originalMessage,
			verificationCode,
			preConviteContent
		);
	}

	/**
	 * Trata uma solicitação de convite
	 * @param {string} authorId - ID do usuário que enviou o convite
	 * @param {string} inviteCode - O código de convite
	 * @param {string} inviteLink - O link de convite completo
	 * @param {string} reason - Motivo do convite
	 * @param {Object} message - Objeto da mensagem original
	 * @param {string} [verificationCode] - Código de verificação enviado ao usuário
	 * @param {string} [preConviteContent] - Conteúdo da mensagem pré-convite para verificação de preguiça
	 */
	async handleInviteRequest(
		authorId,
		inviteCode,
		inviteLink,
		reason,
		message,
		verificationCode,
		preConviteContent
	) {
		try {
			this.logger.info(
				`Processando solicitação de convite de ${authorId} para o código ${inviteCode}`
			);

			if (!reason || reason === "Nenhum motivo fornecido") {
				await this.bot.sendMessage(
					authorId,
					"Seu convite não foi processado, pois não recebi sua mensagem."
				);
				return;
			}

			// Verifica preguiça (copiou parte do preConvite)
			if (preConviteContent) {
				// Remove linhas comuns e compara
				const cleanReason = reason.trim().toLowerCase();
				// Pega trechos significantes do preConvite
				const phrases = [
					"recebi seu convite",
					"me envie uma mensagem pra me convencer",
					"se você copiar e colar algo aqui",
					"só vou encaminhar seu pedido depois",
					"infraestrutura do servidor e celulares é limitada"
				];

				if (phrases.some((p) => cleanReason.includes(p))) {
					await this.bot.sendMessage(
						authorId,
						"Você precisa informar um motivo, já vi que está com preguiça. _Convite Ignorado_"
					);
					// if (this.bot.grupoInvites) {
					// 	await this.bot.sendMessage(
					// 		this.bot.grupoInvites,
					// 		`⚠️ Usuário ${authorId} tentou copiar o texto do bot como motivo. Convite ignorado.`
					// 	);
					// }
					// Penalidade
					const punishDuration = 10 * this.inviteCooldown * 60 * 1000;
					const normalDuration = this.inviteCooldown * 60 * 1000;
					const futureTime = Date.now() + punishDuration - normalDuration;
					this.userCooldowns.set(authorId, futureTime);
					return;
				}
			}

			// Verifica se o usuário enviou o código de verificação como motivo
			if (
				verificationCode &&
				reason &&
				reason.trim().toLowerCase() === verificationCode.toLowerCase()
			) {
				this.logger.info(
					`Usuário ${authorId} enviou o código de verificação como motivo (${verificationCode}). Ignorando convite.`
				);

				// this.bot.sendMessage(
				// 	this.bot.grupoInvites,
				// 	`Usuário ${authorId} enviou o código de verificação como motivo (${verificationCode}). Ignorando convite.`
				// );

				try {
					const ignoredPath = path.join(
						this.database.databasePath,
						"textos",
						"invite_ignorado.txt"
					);
					const ignoredText = await fs
						.readFile(ignoredPath, "utf8")
						.catch(() => "Leitura não é o seu forte, né? _Convite ignorado._");
					await this.bot.sendMessage(authorId, ignoredText);
				} catch (err) {
					this.bot.sendMessage(authorId, "Leitura não é o seu forte, né? _Convite ignorado._");
				}

				const punishDuration = 10 * this.inviteCooldown * 60 * 1000;
				const normalDuration = this.inviteCooldown * 60 * 1000;

				const futureTime = Date.now() + punishDuration - normalDuration;
				this.userCooldowns.set(authorId, futureTime);

				return;
			}

			let inviteInfoData = null;
			const otherBotsInGroup = [];
			let ownerMatch = false;

			try {
				const infoResponse = await this.bot.client.getInviteInfo(inviteCode);
				this.logger.debug("Invite info response:", infoResponse);

				if (infoResponse) {
					inviteInfoData = infoResponse;

					// 1. Check Community
					if (this.isCommunity(inviteInfoData)) {
						this.userCooldowns.delete(authorId);
						this.groupInviteCooldowns.delete(inviteCode);
						await this.bot.sendMessage(
							authorId,
							"Este link parece ser de uma *comunidade*, e o bot não consegue entrar em comunidades inteiras. Por favor, tente novamente enviando o link do *grupo específico* dentro da comunidade que você deseja adicionar!"
						);
						return;
					}

					// 2. Check Owner PN
					if (inviteInfoData.OwnerPN) {
						// Normalize PNs
						const ownerNum = inviteInfoData.OwnerPN.split("@")[0];
						const authorNum = authorId.split("@")[0];
						if (ownerNum === authorNum) {
							ownerMatch = true;
						}
					}

					// 3. Check Participants for other bots
					if (
						inviteInfoData.Participants &&
						Array.isArray(inviteInfoData.Participants) &&
						this.bot.otherBots
					) {
						for (const p of inviteInfoData.Participants) {
							const pNum = p.PhoneNumber ? p.PhoneNumber.split("@")[0] : p.JID.split("@")[0];
							// this.bot.otherBots should be array of numbers (strings)
							if (this.bot.otherBots.includes(pNum)) {
								otherBotsInGroup.push(pNum);
							}
						}
					}

					// Verifica se o JID do grupo está bloqueado (mesmo que o invite link tenha mudado)
					const isGroupBlocked = await this.database.isInviteBlocked(null, inviteInfoData.JID);
					if (isGroupBlocked) {
						this.logger.info(`Ignorando convite de JID bloqueado: ${inviteInfoData.JID}`);
						await this.bot.sendMessage(
							authorId,
							`🛑 A ${this.bot.nomeExibir || "ravenabot"} não recebe mais convite deste grupo, pois ele foi bloqueado.`
						);
						return;
					}
				}
			} catch (err) {
				this.logger.error(`Erro ao buscar invite info para ${inviteCode}:`, err);

				// Check for specific error (Example 3)
				if (
					err.message?.includes("not-authorized") ||
					err.message?.includes("401") ||
					err.response?.data?.error?.includes("not-authorized")
				) {
					await this.bot.sendMessage(
						authorId,
						"Este bot já foi removido do grupo e não consegue entrar mais, se tiver dúvidas, chame no !grupao"
					);
					return; // Stop processing
				}
				// Continue processing if other error (maybe API down), but warn
			}

			if (otherBotsInGroup.length > 0) {
				const botsStr = otherBotsInGroup.map((b) => `+${b}`).join(", ");
				await this.bot.sendMessage(authorId, `⚠️ Bot ${botsStr} já está neste grupo!`);
			}

			// Obtém informações do usuário
			const userName =
				message.name ?? message.pushName ?? message.pushname ?? message.authorName ?? "Pessoa";

			// Salva o convite pendente no banco de dados
			const invite = {
				code: inviteCode,
				link: inviteLink,
				author: {
					id: authorId,
					name: userName
				},
				reason,
				timestamp: Date.now()
			};

			// Salva pending join
			await this.database.savePendingJoin(inviteCode, {
				authorId,
				authorName: userName
			});

			await this.database.addInviteHistory({
				code: inviteCode,
				groupJid: inviteInfoData?.JID || null,
				authorId,
				authorName: userName,
				timestamp: Date.now(),
				reason
			});

			// Verifica se o bot já foi removido manualmente deste grupo anteriormente
			let manualLeaveInfo = null;
			let lastDossiersText = "";
			if (inviteInfoData?.JID) {
				try {
					manualLeaveInfo = await this.database.getManualGroupLeave(inviteInfoData.JID);
				} catch (leaveCheckErr) {
					this.logger.error("Erro ao verificar saída manual do grupo:", leaveCheckErr);
				}

				try {
					const lastDossiers = await this.database.getLastGroupDossiers(inviteInfoData.JID, 3);
					if (lastDossiers && lastDossiers.length > 0) {
						lastDossiersText = "\n📊 *Últimos Dossiês Registrados:*\n";
						lastDossiers.forEach((d, idx) => {
							try {
								const p =
									typeof d.dossier_json === "string" ? JSON.parse(d.dossier_json) : d.dossier_json;
								const dateStr = d.created_at
									? ` (${new Date(d.created_at).toLocaleDateString("pt-BR")})`
									: "";
								let evText = "";
								if (Array.isArray(p.classified_items) && p.classified_items.length > 0) {
									evText =
										"\n" +
										p.classified_items
											.map((it) => `  • *${it.category}:* "${it.evidence}"`)
											.join("\n");
								}
								lastDossiersText += `${idx + 1}. *[${p.type || "geral"}]* Nota: *${p.problematic_score}/10*${dateStr}\n- Resumo: ${p.summary}${evText}\n`;
							} catch (e) {}
						});
					}
				} catch (dossierErr) {
					this.logger.error("Erro ao carregar últimos dossiês do grupo:", dossierErr);
				}
			}

			// Verifica se o autor está na lista de doadores
			let isDonator = false;
			let donateValue = 0;

			try {
				const donations = await this.database.getDonations();

				if (donations && donations.length > 0) {
					const cleanAuthorId = authorId.replace(/[^0-9]/g, "");

					isDonator = donations.some((donation) => {
						if (donation.numero) {
							const cleanDonorNumber = donation.numero.replace(/[^0-9]/g, "");
							if (cleanDonorNumber.length > 10) {
								if (
									cleanDonorNumber.includes(cleanAuthorId) ||
									cleanAuthorId.includes(cleanDonorNumber)
								) {
									donateValue = Number(donation.valor) || 0;
									return true;
								}
							}
						}
						return false;
					});
				}
			} catch (donationError) {
				this.logger.error("Erro ao verificar se o autor é doador:", donationError);
			}

			// Avaliação com LLM para Auto-Accept
			let autoAccepted = false;
			let autoAcceptBot = null;
			let llmReason = "";

			if (manualLeaveInfo) {
				llmReason = `Bot já foi removido manualmente deste grupo anteriormente (${manualLeaveInfo.group_name || "Desconhecido"})`;
			} else {
				try {
					const evalResult = await this.evaluateAutoAcceptWithLLM({
						userName,
						authorId,
						groupName: inviteInfoData?.Name,
						participantCount: inviteInfoData?.ParticipantCount,
						description:
							inviteInfoData?.Description || inviteInfoData?.Desc || inviteInfoData?.Topic || "",
						reason,
						isDonator,
						donateValue
					});

					llmReason = evalResult.reason;

					if (evalResult.shouldAutoAccept) {
						const selectedBot = await this.selectBestBotForAutoJoin();
						if (selectedBot) {
							this.logger.info(
								`[AutoAccept] Convite ${inviteCode} aceito automaticamente pelo bot ${selectedBot.id}. Motivo: ${evalResult.reason}`
							);
							const joinResult = await selectedBot.client.acceptInvite(inviteCode);
							if (joinResult && joinResult.accepted) {
								autoAccepted = true;
								autoAcceptBot = selectedBot;
								InviteSystem.recordBotJoin(selectedBot.id);
								await this.database.savePendingJoin(inviteCode, {
									authorId,
									authorName: userName
								});
								await this.database.removePendingJoin(inviteCode);
							} else {
								this.logger.warn(
									`[AutoAccept] Falha do bot ${selectedBot.id} ao aceitar convite: ${joinResult?.error || "Erro desconhecido"}`
								);
								llmReason = `Aprovado pela IA, mas bot ${selectedBot.id} falhou ao entrar (${joinResult?.error || "Erro"})`;
							}
						} else {
							this.logger.info(
								`[AutoAccept] Convite ${inviteCode} aprovado pela IA, mas nenhum bot elegível disponível no momento.`
							);
							llmReason = `Aprovado pela IA (${evalResult.reason}), mas nenhum bot elegível disponível (limite 3/30m ou offline)`;
						}
					}
				} catch (evalErr) {
					this.logger.error("Erro no fluxo de auto-accept com LLM:", evalErr);
					llmReason = `Falha ao avaliar com IA: ${evalErr.message}`;
				}
			}

			// Envia notificação para o usuário
			let extraText = "";
			let addedAny = false;

			if (inviteInfoData?.ParticipantCount !== undefined && inviteInfoData.ParticipantCount <= 2) {
				const botName = this.bot.nomeExibir || "ravena";
				extraText += `\n- 😪 Este parece ser um grupo particular. Lembre-se que a ${botName} faz tudo no PV, não tem necessidade de criar um grupo com ela! Se quiser só brincar com os comandos, que tal entrar na nossa comunidade? Envie !grupao - temos grupos de downloads, jogos e bate papo.`;
				addedAny = true;
			}

			if (
				(inviteInfoData?.Name && hasStrangeCharacters(inviteInfoData.Name)) ||
				(userName && hasStrangeCharacters(userName))
			) {
				extraText +=
					"\n- ⛔️ *Evito* grupos e pessoas com esses caracteres estranhos, pois geralmente são crianças.";
				addedAny = true;
			}

			if (inviteInfoData && this.isCommunity(inviteInfoData)) {
				extraText +=
					"\n- 👎 *Não consigo* entrar em comunidade, você vai precisar mandar o convite do grupo em específico que eu devo entrar.";
				addedAny = true;
			}

			if (addedAny) {
				extraText += "\n- 🧾 *!convite* para saber mais.";
			}

			const invitesPosPath = path.join(this.database.databasePath, "textos", "invites_pos.txt");
			const posConvite = await fs.readFile(invitesPosPath, "utf8");

			await this.bot.sendMessage(
				authorId,
				"Seu convite foi recebido e será analisado." + extraText + posConvite
			);

			// Envia notificações para o grupoInvites se configurado
			if (this.bot.grupoInvites) {
				try {
					let infoMessageHeader = `📩 *Nova Solicitação de Convite de Grupo*\n\n`;
					if (autoAccepted) {
						infoMessageHeader =
							`✨ *ACEITO AUTOMATICAMENTE:* ${llmReason}\n🤖 *Bot que entrou:* ${autoAcceptBot.id}\n\n` +
							infoMessageHeader;
					}
					if (isDonator) {
						infoMessageHeader = `💸💸 R$${donateValue} 💸💸\n` + infoMessageHeader;
					}
					const ownerMark = ownerMatch ? " ✅" : "";

					let botWarning = "";
					if (otherBotsInGroup.length > 0) {
						const botsStr = otherBotsInGroup.map((b) => `+${b}`).join(", ");
						botWarning = `\n⚠️ *Bot ${botsStr} Já está neste grupo!*`;
					}

					// Fetch Invite statistics
					let wasInGroupBefore = false;
					if (inviteInfoData?.JID) {
						try {
							const existingGroup = await this.database.getGroup(inviteInfoData.JID);
							if (existingGroup) {
								wasInGroupBefore = true;
							}
						} catch (groupCheckErr) {
							this.logger.warn(`Erro ao verificar grupo na base: ${groupCheckErr.message}`);
						}
					}

					let authorInvitesCount = 0;
					let groupInvitesCount = 0;
					let otherInvitersText = "";
					let membershipHistoryText = "";

					try {
						const authorInvites = await this.database.getInviteHistoryByAuthor(authorId);
						authorInvitesCount = authorInvites.length;
					} catch (err) {
						this.logger.error("Erro ao carregar histórico de convites do autor:", err);
					}

					try {
						const groupInvites = await this.database.getInviteHistoryByGroup(
							inviteInfoData?.JID || null,
							inviteCode
						);
						groupInvitesCount = groupInvites.length;

						const otherInvitersMap = new Map();
						const cleanCurrentAuthor = authorId.replace(/[^0-9]/g, "");
						for (const gi of groupInvites) {
							if (gi.author_id) {
								const cleanGiAuthor = gi.author_id.replace(/[^0-9]/g, "");
								if (cleanGiAuthor !== cleanCurrentAuthor) {
									otherInvitersMap.set(cleanGiAuthor, gi.author_name || "Pessoa");
								}
							}
						}
						if (otherInvitersMap.size > 0) {
							const list = Array.from(otherInvitersMap.entries()).map(
								([num, name]) => `${name} (${num})`
							);
							otherInvitersText = `- 👥 *Outros que já indicaram*: ${list.join(", ")}\n`;
						}
					} catch (err) {
						this.logger.error("Erro ao carregar histórico de convites do grupo:", err);
					}

					if (inviteInfoData?.JID) {
						try {
							const periods = await this.database.getGroupMembershipPeriods(inviteInfoData.JID);
							if (periods && periods.length > 0) {
								membershipHistoryText = `\n🚪 *Histórico de Estadia no Grupo:*\n`;
								periods.forEach((p, idx) => {
									const joinDate = p.join_timestamp
										? new Date(p.join_timestamp).toLocaleString("pt-BR")
										: "Desconhecido";
									const leaveDate = p.leave_timestamp
										? new Date(p.leave_timestamp).toLocaleString("pt-BR")
										: "Ainda no grupo";

									let durationText = "";
									if (p.duration) {
										const sec = Math.floor(p.duration / 1000);
										const days = Math.floor(sec / 86400);
										const hours = Math.floor((sec % 86400) / 3600);
										const minutes = Math.floor((sec % 3600) / 60);

										const parts = [];
										if (days > 0) parts.push(`${days}d`);
										if (hours > 0) parts.push(`${hours}h`);
										if (minutes > 0) parts.push(`${minutes}m`);
										if (parts.length === 0) parts.push("menos de 1m");
										durationText = ` (${parts.join(" ")})`;
									} else if (p.join_timestamp && p.leave_timestamp) {
										durationText = " (tempo desconhecido)";
									}

									const botTag = p.bot_id ? ` [🤖 ${p.bot_id}]` : "";
									membershipHistoryText += `${idx + 1}.${botTag} 🟢 ${joinDate} até 🔴 ${leaveDate}${durationText}\n`;
								});
							}
						} catch (err) {
							this.logger.error("Erro ao carregar histórico de estadias:", err);
						}
					}

					let manualLeaveWarning = "";
					if (manualLeaveInfo) {
						manualLeaveWarning = `\n⚠️ *Bot já foi removido manualmente deste grupo anteriormente (${manualLeaveInfo.group_name || "Desconhecido"})*\n`;
					}

					const infoMessage =
						infoMessageHeader +
						`🔗 *Link*: chat.whatsapp.com/${inviteCode}\n` +
						`👤 *De:* ${userName} (${authorId.split("@")[0]})${ownerMark}${isDonator ? " 💰" : ""}\n` +
						(inviteInfoData?.Name ? `🏷️ *Nome*: ${inviteInfoData.Name}\n` : "") +
						(inviteInfoData?.JID ? `🫆 *ID*: ${inviteInfoData.JID}\n` : "") +
						(inviteInfoData?.ParticipantCount
							? `👥 *Membros*: ${inviteInfoData.ParticipantCount}\n`
							: "") +
						(wasInGroupBefore ? `⚠️ Já esteve neste grupo (${inviteInfoData?.JID || ""})\n` : "") +
						manualLeaveWarning +
						`- 📈 *Convites deste usuário*: ${authorInvitesCount}\n` +
						`- 📊 *Vezes que este grupo foi indicado*: ${groupInvitesCount}\n` +
						otherInvitersText +
						membershipHistoryText +
						`\n💬 *Motivo:*\n${reason}\n` +
						botWarning +
						(!autoAccepted && llmReason
							? `\n🤖 *Análise IA (Não aceito auto):* ${llmReason}\n`
							: "") +
						lastDossiersText +
						(isDonator ? `\n💸💸${this.rndString()}💸💸` : `\n${this.rndString()}`);

					await this.bot.sendMessage(this.bot.grupoInvites, infoMessage);

					// Se não foi aceito automaticamente, envia comando para aceitar e comando para bloquear
					if (!autoAccepted) {
						const commandMessage = `!sa-joinGrupo ${inviteCode} ${authorId} ${userName}`;
						await this.bot.sendMessage(this.bot.grupoInvites, commandMessage);

						const blockCommand = `!sa-blockInvites ${authorId.split("@")[0]} ${inviteCode}`;
						await this.bot.sendMessage(this.bot.grupoInvites, blockCommand);
					}
				} catch (error) {
					this.logger.error("Erro ao enviar notificação de convite para grupoInvites:", error);
				}
			} else {
				this.logger.warn("Nenhum grupoInvites configurado, o convite não será encaminhado");
			}
		} catch (error) {
			this.logger.error("Erro ao tratar solicitação de convite:", error);
		}
	}

	/**
	 * Limpa recursos
	 */
	destroy() {
		// Limpa todos os timeouts pendentes
		for (const { timeout, accumulationTimeout } of this.pendingRequests.values()) {
			clearTimeout(timeout);
			if (accumulationTimeout) clearTimeout(accumulationTimeout);
		}
		this.pendingRequests.clear();
		this.userCooldowns.clear(); // Limpa também o mapa de cooldowns de usuário
		this.groupInviteCooldowns.clear(); // Limpa também o mapa de cooldowns de grupo
	}
}

module.exports = InviteSystem;
