const Database = require("./Database");
const Logger = require("./Logger");
const axios = require("axios").default;
const { processFileVariable } = require("../functions/FileManager");

/**
 * Processa variáveis personalizadas em respostas de comandos
 */
class CustomVariableProcessor {
	constructor() {
		this.logger = new Logger("variable-processor");
		this.database = Database.getInstance();
		this.cache = {
			variables: null,
			lastFetch: 0
		};

		this.redditCache = {};
	}

	/**
	 * Processa variáveis em uma string
	 * @param {string} text - Texto contendo variáveis
	 * @param {Object} context - Dados de contexto (mensagem, grupo, etc.)
	 * @returns {Promise<string|Object>} - Texto processado ou objeto MessageMedia para variáveis de arquivo
	 */
	async process(text, context) {
		if (!text) return "";

		this.logger.debug(`[CustomVariableProcessor][process] ${text} <=> ${Object.keys(context)}`);

		try {
			const hasFotoPerfil = text.includes("{fotoPerfil}");
			const hasFotoPerfilMention = text.includes("{fotoPerfilMention}");
			let targetJid = null;

			if ((hasFotoPerfil || hasFotoPerfilMention) && context && context.message) {
				if (hasFotoPerfilMention) {
					const mentions =
						context.message.origin?.mentionedIds ??
						context.message.mentionedIds ??
						context.message.mentions ??
						[];
					targetJid =
						mentions.length > 0 ? mentions[0] : context.message.author || context.message.sender;
				} else {
					targetJid = context.message.author || context.message.sender;
				}
			}

			let processedText = text;
			if (hasFotoPerfil || hasFotoPerfilMention) {
				processedText = processedText
					.replace(/\{fotoPerfil\}/g, "")
					.replace(/\{fotoPerfilMention\}/g, "");
			}

			// Verifica se é uma variável de arquivo
			const fileMatch = processedText.match(/^\{file-(.*?)\}$/);
			if (fileMatch && context && context.message) {
				const chatId = context.message.group ?? context.message.author;
				const bot = context.bot;

				if (bot) {
					// Processa variável de arquivo e retorna o MessageMedia
					const media = await processFileVariable(processedText, bot, chatId);
					if (media) {
						return media;
					}
				}
			}

			// Verifica se é variável de reddit
			const redditResult = await this.processRedditVariable(processedText, context);

			if (redditResult) {
				if (redditResult.type === "media") {
					// Se retornou mídia, envia o payload diretamente
					return redditResult.payload;
				} else {
					processedText = redditResult.text;
				}
			}

			// Carrega variáveis personalizadas se não estiverem em cache ou o cache estiver obsoleto
			if (!this.cache.variables || Date.now() - this.cache.lastFetch > 300000) {
				// 5 minutos
				await this.loadCustomVariables();
			}

			// Processa variáveis de API
			processedText = await this.processAPIRequest(processedText, context);

			// Processa variáveis de tempo e data
			processedText = this.processSystemVariables(processedText);

			// Processa variáveis estáticas personalizadas
			if (this.cache.variables) {
				processedText = this.processCustomStaticVariables(processedText);
			}

			// Processa variáveis específicas de contexto
			if (context) {
				processedText = await this.processContextVariables(processedText, context);
			}

			// Processa variáveis dinâmicas de API
			processedText = await this.processDynamicVariables(processedText);

			// Processa variáveis de comando embutido
			processedText = await this.processEmbeddedCommands(processedText, context);

			// Processa menções implícitas na mensagem final (ex: @5511999999999 ou @33543761703009)
			if (context && typeof processedText === "string") {
				const implicitMentions = processedText.matchAll(/@(\d{8,25})/g);
				const jidsToMention = [];
				for (const match of Array.from(implicitMentions)) {
					const num = match[1];
					const resolved = await this.resolveJids(num, context);
					for (const r of resolved) {
						jidsToMention.push(r);
					}
				}

				if (jidsToMention.length > 0) {
					if (!context.options) {
						context.options = {};
					}
					if (!context.options.mentions) {
						context.options.mentions = [];
					}
					for (const jid of jidsToMention) {
						if (!context.options.mentions.includes(jid)) {
							context.options.mentions.push(jid);
						}
					}
				}
			}

			if (
				(hasFotoPerfil || hasFotoPerfilMention) &&
				context &&
				context.message &&
				context.bot &&
				targetJid
			) {
				const mediaResult = await this.handleProfilePictureResponse(
					processedText,
					targetJid,
					context
				);
				return mediaResult;
			}

			return processedText;
		} catch (error) {
			this.logger.error("Erro ao processar variáveis:", error);
			return text; // Retorna o texto original em caso de erro
		}
	}

	/**
	 * Resolve a numeric ID to the correct JID format (LID or PN)
	 */
	async resolveJids(num, context) {
		if (!context) {
			if (num.startsWith("3") && num.length >= 14) {
				return [`${num}@lid`];
			}
			return [`${num}@s.whatsapp.net`];
		}

		// 1. Check if the JID already exists in context.options.mentions
		if (context.options && context.options.mentions && Array.isArray(context.options.mentions)) {
			const existing = context.options.mentions.find(
				(jid) => typeof jid === "string" && jid.split("@")[0] === num
			);
			if (existing) {
				return [existing];
			}
		}

		// 2. Check if it matches the message author or authorAlt
		if (context.message) {
			if (context.message.author === num) {
				return [`${num}@s.whatsapp.net`];
			}
			if (context.message.authorAlt && context.message.authorAlt.split("@")[0] === num) {
				return [context.message.authorAlt];
			}
		}

		// 3. Check if we can find the JID in group participants
		const groupId = context.message?.group ?? context.group?.id;
		if (groupId && context.bot && context.bot.client) {
			try {
				const chat = await context.bot.client.getChatById(groupId);
				if (chat && chat.participants) {
					const found = chat.participants.find((p) => {
						const pLid = p.lid?.split("@")[0];
						const pJid = p.id?._serialized?.split("@")[0];
						return pLid === num || pJid === num;
					});

					if (found) {
						if (found.lid && found.lid.split("@")[0] === num) {
							return [found.lid];
						}
						if (found.id?._serialized && found.id._serialized.split("@")[0] === num) {
							return [found.id._serialized];
						}
					}
				}
			} catch (e) {
				this.logger.error("Erro ao obter chat para resolver JID no grupo:", e);
			}
		}

		// 4. Fallback: check prefix/length
		if (num.startsWith("3") && num.length >= 14) {
			return [`${num}@lid`];
		}
		return [`${num}@s.whatsapp.net`];
	}

	/**
	 * Carrega variáveis personalizadas do banco de dados
	 */
	async loadCustomVariables() {
		try {
			this.cache.variables = await this.database.getCustomVariables();
			this.cache.lastFetch = Date.now();
		} catch (error) {
			this.logger.error("Erro ao carregar variáveis personalizadas:", error);
		}
	}

	/**
	 * Processa variáveis do sistema (data, hora, etc.)
	 * @param {string} text - Texto contendo variáveis
	 * @returns {string} - Texto processado
	 */
	processSystemVariables(text) {
		const now = new Date();

		// Substitui {day} pelo nome do dia atual
		const days = [
			"Domingo",
			"Segunda-feira",
			"Terça-feira",
			"Quarta-feira",
			"Quinta-feira",
			"Sexta-feira",
			"Sábado"
		];
		text = text.replace(/{day}/g, days[now.getDay()]);

		// Substitui {date} pela data atual
		const dateStr = now.toLocaleDateString();
		text = text.replace(/{date}/g, dateStr);

		// Substitui {time} pela hora atual
		const timeStr = now.toLocaleTimeString();
		text = text.replace(/{time}/g, timeStr);

		// NOVAS VARIÁVEIS DE DATA E HORA DETALHADAS
		// Substitui {data-hora} pela hora atual
		text = text.replace(/{data-hora}/g, now.getHours().toString().padStart(2, "0"));

		// Substitui {data-minuto} pelo minuto atual
		text = text.replace(/{data-minuto}/g, now.getMinutes().toString().padStart(2, "0"));

		// Substitui {data-segundo} pelo segundo atual
		text = text.replace(/{data-segundo}/g, now.getSeconds().toString().padStart(2, "0"));

		// Substitui {data-dia} pelo dia atual
		text = text.replace(/{data-dia}/g, now.getDate().toString().padStart(2, "0"));

		// Substitui {data-mes} pelo mês atual
		text = text.replace(/{data-mes}/g, (now.getMonth() + 1).toString().padStart(2, "0"));

		// Substitui {data-ano} pelo ano atual
		text = text.replace(/{data-ano}/g, now.getFullYear());

		// VARIÁVEIS DE NÚMEROS ALEATÓRIOS
		// Substitui {randomPequeno} por um número aleatório de 1 a 10
		text = text.replace(/{randomPequeno}/g, () => Math.floor(Math.random() * 10) + 1);

		// Substitui {randomMedio} por um número aleatório de 1 a 100
		text = text.replace(/{randomMedio}/g, () => Math.floor(Math.random() * 100) + 1);

		// Substitui {randomGrande} por um número aleatório de 1 a 1000
		text = text.replace(/{randomGrande}/g, () => Math.floor(Math.random() * 1000) + 1);

		// Substitui {randomMuitoGrande} por um número aleatório de 1 a 10000
		text = text.replace(/{randomMuitoGrande}/g, () => Math.floor(Math.random() * 10000) + 1);

		// Processar variáveis {rndDado-X} para valores de dado
		const dadoMatches = text.matchAll(/{rndDado-(\d+)}/g);
		for (const match of Array.from(dadoMatches)) {
			const lados = parseInt(match[1]);
			if (!isNaN(lados) && lados > 0) {
				const valor = Math.floor(Math.random() * lados) + 1;
				text = text.replace(match[0], valor);
			}
		}

		// Processar variáveis {rndDadoRange-X-Y} para valores de dado em um intervalo
		const rangeMatches = text.matchAll(/{rndDadoRange-(\d+)-(\d+)}/g);
		for (const match of Array.from(rangeMatches)) {
			const min = parseInt(match[1]);
			const max = parseInt(match[2]);
			if (!isNaN(min) && !isNaN(max) && min <= max) {
				const valor = Math.floor(Math.random() * (max - min + 1)) + min;
				text = text.replace(match[0], valor);
			}
		}

		// Variável {somaRandoms} - calcula a soma das variáveis random já processadas
		const sumMatches = text.match(/{somaRandoms}/g);
		if (sumMatches) {
			// Procura por números anteriores no texto que foram gerados por variáveis random
			const numbersInText = text
				.split(/\\s+/)
				.filter((word) => /^\\d+$/.test(word))
				.map((num) => parseInt(num));
			const sum = numbersInText.reduce((acc, curr) => acc + curr, 0);

			// Substitui {somaRandoms} pela soma
			text = text.replace(/{somaRandoms}/g, sum);
		}

		return text;
	}

	/**
	 * Obter um membro aleatório do grupo
	 * @param {Object} bot - Instância do bot
	 * @param {string} groupId - ID do grupo
	 * @returns {Promise<Object|null>} - Membro aleatório ou null
	 */
	async getRandomGroupMember(bot, groupId) {
		try {
			if (!bot || !bot.client || !groupId) {
				return null;
			}

			// Obtém o chat do grupo
			const chat = await bot.client.getChatById(groupId);
			if (!chat || !chat.isGroup) {
				return null;
			}

			// Obtém todos os participantes
			const participants = chat.participants;
			if (!participants || participants.length === 0) {
				return null;
			}

			// Filtra para excluir o próprio bot
			const filteredParticipants = participants.filter(
				(p) => p.id._serialized !== bot.client.info.wid._serialized
			);

			if (filteredParticipants.length === 0) {
				return null;
			}

			// Seleciona um participante aleatório
			const randomIndex = Math.floor(Math.random() * filteredParticipants.length);
			const randomParticipant = filteredParticipants[randomIndex];

			// Obtém o objeto de contato
			const contact = await bot.client.getContactById(randomParticipant.id._serialized);
			return contact;
		} catch (error) {
			this.logger.error("Erro ao obter membro aleatório do grupo:", error);
			return null;
		}
	}

	/**
	 * Processa variáveis específicas de contexto (mensagem, grupo, etc.)
	 * @param {string} text - Texto contendo variáveis
	 * @param {Object} context - Dados de contexto
	 * @returns {string} - Texto processado
	 */
	async processContextVariables(text, context) {
		// Substitui {pessoa} pelo nome do remetente
		if (context.message && context.message.author) {
			// Tenta obter o nome real ou o apelido do remetente
			const fromMe =
				context.message.goMessageData?.key?.fromMe ??
				context.message.key?.fromMe ??
				context.message.fromMe ??
				context.message.origin?.fromMe ??
				false;
			const authorName = fromMe
				? "ravena"
				: (context.message.goMessageData?.pushName ??
					context.message.origin?.pushName ??
					context.message.name ??
					context.message.authorName ??
					context.message.pushname ??
					"Pessoa");
			text = text.replace(/{pessoa}/g, authorName);

			// Nova variável {nomeAutor} - mesmo comportamento que {pessoa}
			text = text.replace(/{nomeAutor}/g, authorName);
		}

		// Substitui {group} pelo nome do grupo
		if (context.group && context.group.name) {
			text = text.replace(/{group}/g, context.group.name);

			// Novas variáveis {nomeCanal} e {nomeGrupo} - mesmo comportamento que {group}
			text = text.replace(/{nomeCanal}/g, context.group.name);
			text = text.replace(/{nomeGrupo}/g, context.group.name);
		}

		// Variável {contador} - número de vezes que o comando foi executado
		if (context.command && context.command.count !== undefined) {
			text = text.replace(/{contador}/g, context.command.count);
		}

		// Variável {membroRandom} - nome de um membro aleatório do grupo
		const membroRandomMatches = text.match(/{membroRandom}/g);
		if (membroRandomMatches && context.bot && context.message && context.message.group) {
			try {
				const randomMember = await this.getRandomGroupMember(context.bot, context.message.group);
				const memberName = randomMember
					? (randomMember.pushname ?? randomMember.name ?? "Alguém")
					: "Alguém";
				text = text.replace(/{membroRandom}/g, memberName.pushName ?? memberName);
			} catch (error) {
				this.logger.error("Erro ao processar variável {membroRandom}:", error);
				text = text.replace(/{membroRandom}/g, "Alguém");
			}
		}

		// Variável {mention} - nome da pessoa mencionada ou um membro aleatório se não houver menção
		if (context.message && context.message.origin) {
			try {
				// Quando for um mention, usar @1234567 ao invés do nome
				/* Ordem de pegar mention:
        1. Pessoa marcada na mensagem (mentionedIds)
        2. Mensagem em quote
        3. Membro random do grupo
        */

				// Rastreia menções já usadas para não repetir a mesma pessoa
				const usedMentions = [];

				// Função para substituir cada ocorrência de {mention} com uma pessoa diferente
				const replaceMention = async (fallbackNumber = false) => {
					let mentionId = null;
					let mentionName = null;

					// 1. Primeiro, verifica se há pessoas mencionadas na mensagem original
					if (
						context.message.origin.mentionedIds &&
						context.message.origin.mentionedIds.length > 0
					) {
						// Filtra para usar apenas menções que ainda não foram usadas
						const availableMentions = context.message.origin.mentionedIds.filter(
							(id) => !usedMentions.includes(id)
						);
						this.logger.debug(`[processContextVariables][availableMentions] `, availableMentions);
						if (availableMentions.length > 0) {
							// Seleciona uma menção aleatória das disponíveis, sem pegar contato
							const randomIndex = Math.floor(Math.random() * availableMentions.length);
							mentionId = availableMentions[randomIndex];

							let mentionContact = undefined;
							try {
								// Obtém informações do contato mencionado
								mentionContact = await context.bot.client.getContactById(mentionId);
								mentionName = `@${mentionContact?.number?.split("@")[0] ?? mentionContact?.id?.user.split("@")[0]}`;
							} catch (err) {
								this.logger.error("Erro ao obter contato mencionado:", err);
								mentionName = `@${mentionId.split("@")[0]}`;
							}

							// Marca esta menção como usada
							usedMentions.push(mentionId);
							return { mentionId, mentionName, mentionContact };
						}
					}

					// 2. Se não há menções ou todas já foram usadas, tenta usar a mensagem citada
					const quotedMsg = await context.message.origin.getQuotedMessage().catch(() => null);

					if (quotedMsg && !usedMentions.includes(quotedMsg.author)) {
						// Usa o contato da mensagem citada
						try {
							const mentionContact = await quotedMsg.getContact();
							if (mentionContact) {
								mentionId = mentionContact.id._serialized;
								mentionName = `@${mentionContact?.number?.split("@")[0] ?? mentionContact?.id?.user?.split("@")[0]}`;

								// Marca esta menção como usada
								usedMentions.push(mentionId);
								return { mentionId, mentionName, mentionContact };
							}
						} catch (err) {
							this.logger.error("Erro ao obter contato da mensagem citada:", err);
						}
					}

					// 3. Se não há mensagem citada ou já foi usada, seleciona um membro aleatório - a não ser que tenha um fallback especificado
					if (fallbackNumber) {
						const mentionContact = await context.bot.client.getContactById(fallbackNumber);
						mentionName = `@${mentionContact?.number?.split("@")[0] ?? mentionContact?.id?.user?.split("@")[0]}`;

						return { mentionId: fallbackNumber, mentionName, mentionContact };
					} else {
						if (context.bot && context.message.group) {
							try {
								// Obtém membros que ainda não foram usados
								const chat = await context.bot.client.getChatById(context.message.group);
								if (chat && chat.isGroup && Array.isArray(chat.participants)) {
									// Filtra participantes para excluir o próprio bot e menções já usadas
									const filteredParticipants = chat.participants.filter(
										(p) =>
											p.id._serialized !== context.bot.client.info.wid._serialized &&
											!usedMentions.includes(p.id._serialized)
									);

									if (filteredParticipants.length > 0) {
										// Seleciona um participante aleatório
										const randomIndex = Math.floor(Math.random() * filteredParticipants.length);
										const randomParticipant = filteredParticipants[randomIndex];

										mentionId = randomParticipant.id._serialized;

										// Obtém o objeto de contato
										const mentionContact = await context.bot.client.getContactById(mentionId);
										mentionName = `@${mentionContact?.number?.split("@")[0] ?? mentionContact?.id?.user?.split("@")[0]}`;

										// Marca esta menção como usada
										usedMentions.push(mentionId);
										return { mentionId, mentionName, mentionContact };
									} else if (chat.participants.length > 1) {
										// Se todos já foram usados, reseta e usa qualquer um exceto o bot
										const nonBotParticipants = chat.participants.filter(
											(p) => p.id._serialized !== context.bot.client.info.wid._serialized
										);

										if (nonBotParticipants.length > 0) {
											const randomIndex = Math.floor(Math.random() * nonBotParticipants.length);
											const randomParticipant = nonBotParticipants[randomIndex];

											mentionId = randomParticipant.id._serialized;

											// Obtém o objeto de contato
											const mentionContact = await context.bot.client.getContactById(mentionId);
											mentionName = `@${mentionContact?.number?.split("@")[0] ?? mentionContact?.id?.user?.split("@")[0]}`;

											return { mentionId, mentionName, mentionContact };
										}
									}
								}
							} catch (err) {
								this.logger.error("Erro ao obter membro aleatório do grupo:", err);
							}
						}
					}

					// Fallback se nada funcionar
					return { mentionId: null, mentionName: "Usuário", mentionContact: null };
				};

				// Conta quantas ocorrências de {mention} existem no texto
				const mentionMatches = text.match(/{mention}/g);
				if (mentionMatches) {
					// Para cada ocorrência, substitui por uma menção diferente
					for (let i = 0; i < mentionMatches.length; i++) {
						const { mentionId, mentionName, mentionContact } = await replaceMention();

						// Substitui apenas a primeira ocorrência restante
						text = text.replace(/{mention}/, mentionName);

						// Adiciona à lista de menções para notificação
						if (mentionId) {
							this.logger.debug(`[processContextVariables] Mention: ${mentionId}, ${mentionName}`);
							if (context.options && context.options.mentions) {
								if (!context.options.mentions.includes(mentionId)) {
									context.options.mentions.push(mentionId);
								}
							} else if (context.options) {
								context.options.mentions = [mentionId];
							}
						}
					}
				}

				const singleMentionMatches = text.match(/{singleMention}/g);
				if (singleMentionMatches) {
					// Todos pela mesma
					const { mentionId, mentionName, mentionContact } = await replaceMention();
					for (let i = 0; i < singleMentionMatches.length; i++) {
						// Substitui apenas a primeira ocorrência restante
						text = text.replace(/{singleMention}/, mentionName);
					}
					// Adiciona à lista de menções para notificação
					if (mentionId) {
						this.logger.debug(
							`[processContextVariables] SingleMention: ${mentionId}, ${mentionName}`
						);
						if (context.options && context.options.mentions) {
							if (!context.options.mentions.includes(mentionId)) {
								context.options.mentions.push(mentionId);
							}
						} else if (context.options) {
							context.options.mentions = [mentionId];
						}
					}
				}

				const selfMentionMatches = text.match(/{mentionOuEu}/g);
				if (selfMentionMatches) {
					// Todos pela mesma
					const { mentionId, mentionName, mentionContact } = await replaceMention(
						context.message.authorAlt ?? context.message.author
					);
					for (let i = 0; i < selfMentionMatches.length; i++) {
						// Substitui apenas a primeira ocorrência restante
						text = text.replace(/{mentionOuEu}/, mentionName);
					}

					// Adiciona à lista de menções para notificação
					if (mentionId) {
						this.logger.debug(
							`[processContextVariables] mentionOuEu: ${mentionId}, ${mentionName}`
						);
						if (context.options && context.options.mentions) {
							if (!context.options.mentions.includes(mentionId)) {
								context.options.mentions.push(mentionId);
							}
						} else if (context.options) {
							context.options.mentions = [mentionId];
						}
					}
				}
			} catch (error) {
				this.logger.error("Erro ao processar variável {mention}:", error);
			}
		}

		// Processa variáveis de menções específicas {mention-NUMERO}
		const mentionMatches = text.matchAll(/\{mention-([^}]+)\}/g);
		for (const match of Array.from(mentionMatches)) {
			const userIdToMention = match[1];
			const userPart = userIdToMention.split("@")[0];

			// Verifica se o ID/número é válido
			if (userPart && userPart.length >= 8 && userPart.length <= 25) {
				let jidsToAdd = [];
				if (userIdToMention.includes("@")) {
					if (userIdToMention.endsWith("@c.us")) {
						jidsToAdd.push(`${userPart}@s.whatsapp.net`);
					} else {
						jidsToAdd.push(userIdToMention);
					}
				} else {
					// Sem domínio: resolve de forma inteligente
					jidsToAdd = await this.resolveJids(userPart, context);
				}

				text = text.replace(match[0], `@${userPart}`);

				if (!context.options) {
					context.options = {};
				}
				if (!context.options.mentions) {
					context.options.mentions = [];
				}

				for (const jid of jidsToAdd) {
					if (!context.options.mentions.includes(jid)) {
						context.options.mentions.push(jid);
					}
				}
			} else {
				// Remove a variável inválida
				text = text.replace(match[0], "");
			}
		}

		return text;
	}

	/**
	 * Processa variáveis estáticas personalizadas do banco de dados
	 * @param {string} text - Texto contendo variáveis
	 * @returns {string} - Texto processado
	 */
	processCustomStaticVariables(text) {
		// Nenhuma substituição se nenhuma variável carregada
		if (!this.cache.variables) return text;

		// Verifica por variáveis personalizadas
		const customVars = this.cache.variables;

		// Rastreia quais índices já foram usados para cada variável de array
		const usedIndices = {};

		for (const [key, value] of Object.entries(customVars)) {
			// Cria regex para a variável
			const regex = new RegExp(`{${key}}`, "g");

			// Se o valor é um array, seleciona elementos aleatórios para cada ocorrência
			if (Array.isArray(value)) {
				// Conta ocorrências desta variável
				const matches = text.match(regex);
				if (!matches) continue;

				// Inicializa índices usados para esta variável
				usedIndices[key] = [];

				// Substitui cada ocorrência por um elemento aleatório
				for (let i = 0; i < matches.length; i++) {
					// Obtém índices disponíveis (ainda não usados)
					let availableIndices = Array.from({ length: value.length }, (_, i) => i).filter(
						(idx) => !usedIndices[key].includes(idx)
					);

					// Se todos os índices já foram usados, reseta se precisarmos de mais
					if (availableIndices.length === 0) {
						usedIndices[key] = [];
						availableIndices = Array.from({ length: value.length }, (_, i) => i);
					}

					// Seleciona um índice disponível aleatório
					const randomIndex = Math.floor(Math.random() * availableIndices.length);
					const selectedIndex = availableIndices[randomIndex];

					// Marca este índice como usado
					usedIndices[key].push(selectedIndex);

					// Substitui a primeira ocorrência da variável pelo valor selecionado
					text = text.replace(regex, value[selectedIndex]);
				}
			} else if (typeof value === "string") {
				// Para valores de string, substitui normalmente
				text = text.replace(regex, value);
			}
		}

		return text;
	}

	/**
	 * Processa variáveis de solicitação de API no formato {API#MÉTODO#TIPO_RESPOSTA#URL}
	 * @param {string} text - Texto contendo variáveis de API
	 * @param {Object} context - Dados de contexto (mensagem, args, etc.)
	 * @returns {Promise<string>} - Texto processado
	 */
	async processAPIRequest(text, context) {
		try {
			// Expressão regular para encontrar variáveis de solicitação de API
			const apiRegex = /{API#(GET|POST|FORM)#(TEXT|JSON)#([^}]+)}/gs;

			// Encontra todas as variáveis de solicitação de API
			const matches = Array.from(text.matchAll(apiRegex));
			if (matches.length === 0) return text;

			this.logger.debug(`Encontradas ${matches.length} variáveis de API para processar`);

			// Processa cada correspondência
			for (const match of matches) {
				const [fullMatch, method, responseType, urlAndTemplate] = match;

				// Divide URL e template (para tipo de resposta JSON)
				let url, template;
				if (responseType === "JSON") {
					// Encontra a primeira quebra de linha para separar URL do template
					const firstLineBreak = urlAndTemplate.indexOf("\n");
					if (firstLineBreak !== -1) {
						url = urlAndTemplate.substring(0, firstLineBreak).trim();
						template = urlAndTemplate.substring(firstLineBreak + 1).trim();
					} else {
						url = urlAndTemplate.trim();
						template = "";
					}
				} else {
					url = urlAndTemplate.trim();
				}

				// Processa argumentos na URL (arg1, arg2, etc.)
				if (context && context.command && Array.isArray(context.command.args)) {
					// Substitui arg1, arg2, etc. pelos argumentos reais
					url = url.replace(/arg(\d+)/g, (match, index) => {
						const argIndex = parseInt(index, 10) - 1;
						return argIndex < context.command.args.length
							? encodeURIComponent(context.command.args[argIndex])
							: "";
					});
				}

				this.logger.debug(`Processando solicitação de API: ${method} ${url}`);

				// Faz a solicitação de API real
				let response;
				try {
					if (method === "GET") {
						response = await axios.get(url);
					} else if (method === "POST") {
						// Analisa a URL para extrair dados
						const [baseUrl, queryParams] = url.split("?");
						const data = {};

						if (queryParams) {
							queryParams.split("&").forEach((param) => {
								const [key, value] = param.split("=");
								if (key && value) {
									data[decodeURIComponent(key)] = decodeURIComponent(value);
								}
							});
						}

						response = await axios.post(baseUrl, data);
					} else if (method === "FORM") {
						// Analisa a URL para extrair dados do formulário
						const [baseUrl, queryParams] = url.split("?");
						const formData = new URLSearchParams();

						if (queryParams) {
							queryParams.split("&").forEach((param) => {
								const [key, value] = param.split("=");
								if (key && value) {
									formData.append(decodeURIComponent(key), decodeURIComponent(value));
								}
							});
						}

						response = await axios.post(baseUrl, formData, {
							headers: {
								"Content-Type": "application/x-www-form-urlencoded"
							}
						});
					}

					// Processa a resposta com base no tipo de resposta
					let result;
					if (responseType === "TEXT") {
						// Retorna a resposta de texto bruto
						result =
							typeof response.data === "string" ? response.data : JSON.stringify(response.data);
					} else if (responseType === "JSON") {
						// Processa o template JSON
						const jsonData = response.data;

						// Substitui [variavel.caminho] no template por valores da resposta JSON
						result = template.replace(/\[([^\]]+)\]/g, (match, path) => {
							// Navega no objeto JSON usando o caminho
							const parts = path.split(".");
							let value = jsonData;

							for (const part of parts) {
								if (value === undefined || value === null) {
									return "[indefinido]";
								}
								value = value[part];
							}

							return value !== undefined ? value : "[indefinido]";
						});
					}

					// Substitui a variável de API pelo resultado
					text = text.replace(fullMatch, result);
				} catch (apiError) {
					this.logger.error(`Erro ao fazer solicitação de API para ${url}:`, apiError);
					text = text.replace(fullMatch, `Erro na requisição API: ${apiError.message}`);
				}
			}

			return text;
		} catch (error) {
			this.logger.error("Erro ao processar solicitações de API:", error);
			return text;
		}
	}

	/**
	 * Processa variáveis dinâmicas que requerem chamadas de API ou computação
	 * @param {string} text - Texto contendo variáveis
	 * @returns {Promise<string>} - Texto processado
	 */
	async processDynamicVariables(text) {
		try {
			// Variável de clima: {weather:location}
			const weatherMatches = text.match(/{weather:([^}]+)}/g);
			if (weatherMatches) {
				for (const match of weatherMatches) {
					const location = match.substring(9, match.length - 1);
					const weather = await this.getWeather(location);
					text = text.replace(match, weather);
				}
			}

			// Espaço reservado para mais variáveis dinâmicas

			return text;
		} catch (error) {
			this.logger.error("Erro ao processar variáveis dinâmicas:", error);
			return text;
		}
	}

	/**
	 * Processa variáveis de comando embutido
	 * @param {string} text - Texto contendo variáveis
	 * @param {Object} context - Dados de contexto
	 * @returns {Promise<string|Object>} - Texto processado ou objeto com comandos a serem executados
	 */
	async processEmbeddedCommands(text, context) {
		try {
			if (!context || !context.bot) {
				return text;
			}

			const cmdRegex = /\{cmd-(.*?)\}/g;
			const cmdMatches = text.match(cmdRegex);

			if (!cmdMatches) {
				return text;
			}

			if (context && context.message && context.bot) {
				// Verifica se o texto consiste apenas de comandos e espaços/quebras de linha
				const pureCommandsText = text.replace(cmdRegex, "").trim();

				if (pureCommandsText === "") {
					// Extrai os comandos, limitando a 10
					const commands = cmdMatches
						.slice(0, 10)
						.map((m) => {
							const match = m.match(/\{cmd-(.*?)\}/);
							return match ? match[1].trim() : null;
						})
						.filter((cmd) => cmd !== null);

					this.logger.debug(`Detectadas ${commands.length} variáveis de comando embutido`);

					return {
						type: "embedded-commands",
						commands
					};
				}
			}

			// Processa cada ocorrência que esteja misturada com texto
			for (const match of cmdMatches) {
				try {
					const matchContent = match.match(/\{cmd-(.*?)\}/);
					const commandText = matchContent ? matchContent[1].trim() : "";

					this.logger.debug(`Processando comando embutido misturado: ${commandText}`);

					if (!commandText) {
						continue;
					}

					text = text.replace(match, `[Comando embutido: ${commandText}]`);
				} catch (cmdError) {
					this.logger.error(`Erro ao processar comando embutido ${match}:`, cmdError);
					text = text.replace(match, "[Erro no comando embutido]");
				}
			}

			return text;
		} catch (error) {
			this.logger.error("Erro ao processar variáveis de comando:", error);
			return text;
		}
	}

	/**
	 * Obtém informações de clima (implementação de exemplo)
	 * @param {string} location - Nome da localização
	 * @returns {Promise<string>} - Informações de clima
	 */
	async getWeather(location) {
		try {
			// Isso é um placeholder. Em uma implementação real, você chamaria uma API de clima
			return `Clima para ${location}: Ensolarado, 25°C`;
		} catch (error) {
			this.logger.error(`Erro ao obter clima para ${location}:`, error);
			return `Dados de clima não disponíveis para ${location}`;
		}
	}

	async processRedditVariable(text, context) {
		// A regex agora busca por {reddit-xxx} dentro do texto recebido
		const regex = /\{reddit-(.+?)\}/;
		const match = text.match(regex);

		// Se a variável não for encontrada, retorna o texto original para continuar o processamento.
		if (!match) {
			return { type: "text", text };
		}

		const fullVariable = match[0]; // Ex: "{reddit-memes-funny-coolthings}"

		// Separa os subreddits especificados pelo caractere '-'
		const subredditOptions = match[1].split("-"); // Ex: ['memes', 'funny', 'coolthings']

		// Escolhe um subreddit aleatório da lista fornecida
		const subreddit = subredditOptions[Math.floor(Math.random() * subredditOptions.length)];

		try {
			// 1. Busca os posts mais recentes via API do Reddit
			const response = await axios.get(`https://www.reddit.com/r/${subreddit}/new.json?limit=100`);
			const posts = response?.data?.data?.children;

			if (!posts || posts.length === 0) {
				const newText = text.replace(
					fullVariable,
					`Subreddit r/${subreddit} não foi encontrado ou não possui posts.`
				);
				return { type: "text", text: newText };
			}

			// 2. Gerencia o cache global
			const groupId = context.group;
			if (!this.redditCache[groupId]) this.redditCache[groupId] = {};
			if (!this.redditCache[groupId][subreddit]) this.redditCache[groupId][subreddit] = [];

			// 3. Filtra posts fixados e já enviados
			let availablePosts = posts
				.filter((p) => !p.data.stickied)
				.filter((p) => !this.redditCache[groupId][subreddit].includes(p.data.id));

			// 4. Se todos os posts já foram vistos, reseta o cache
			if (availablePosts.length === 0 && posts.filter((p) => !p.data.stickied).length > 0) {
				this.redditCache[groupId][subreddit] = [];
				availablePosts = posts.filter((p) => !p.data.stickied);
			}

			// 5. Separa e seleciona a mídia com base na prioridade (Imagem > GIF > Vídeo)
			const images = [],
				gifs = [],
				videos = [];
			for (const post of availablePosts) {
				const { data } = post;
				const url = data.url_overridden_by_dest;
				const hint = data.post_hint;
				if (!url) continue;

				if (hint === "image" && (url.endsWith(".jpg") || url.endsWith(".png"))) images.push(post);
				else if (hint === "image" && (url.endsWith(".gif") || url.endsWith(".gifv")))
					gifs.push(post);
				else if (
					(data.is_video || hint === "hosted:video") &&
					data?.media?.reddit_video?.fallback_url
				) {
					videos.push(post);
				}
			}

			const selectRandom = (arr) =>
				arr.length > 0 ? arr[Math.floor(Math.random() * arr.length)] : null;
			let selectedPost, mediaUrl, mediaType;

			let customMime = "image/jpeg";
			if ((selectedPost = selectRandom(images))) {
				mediaUrl = selectedPost.data.url_overridden_by_dest;
				mediaType = "image";
			} else if ((selectedPost = selectRandom(gifs))) {
				mediaUrl = selectedPost.data.url_overridden_by_dest;
				mediaType = "image";
			} else if ((selectedPost = selectRandom(videos))) {
				mediaUrl = selectedPost.data.media.reddit_video.fallback_url;
				mediaType = "video";
				customMime = "video/mp4";
			}

			// 6. Cria o MessageMedia e retorna o payload
			if (selectedPost && mediaUrl && mediaType) {
				const opts = { unsafeMime: false, customMime };
				const media = await context.bot.createMediaFromURL(mediaUrl, opts);

				// Hijack as options pra fazer legenda
				context.options.caption = `📷 [${selectedPost.data.subreddit_name_prefixed}] _${selectedPost.data.title}_
> ${selectedPost.data.ups} 👍 ${selectedPost.data.downs} 👎
> reddit.com/${selectedPost.data.permalink}`; // > reddit.com/u/${selectedPost.data.author

				if (media) {
					this.redditCache[groupId][subreddit].push(selectedPost.data.id);
					// Retorna um tipo 'media' para indicar que a mensagem inteira deve ser este anexo
					return { type: "media", payload: media };
				}
			}

			// Se nenhuma mídia foi encontrada ou a criação do MessageMedia falhou
			const errorText = `Nenhuma mídia (imagem/gif/vídeo) recente encontrada em r/${subreddit}.`;
			return { type: "text", text: text.replace(fullVariable, errorText) };
		} catch (error) {
			console.error(`[RedditVariable] Erro ao processar r/${subreddit}:`, error.message);
			const errorText = `Subreddit r/${subreddit} não foi encontrado.`;
			return { type: "text", text: text.replace(fullVariable, errorText) };
		}
	}

	/**
	 * Busca a foto de perfil do usuário alvo, e retorna como mídia (legenda <= 1000) ou
	 * envia a imagem diretamente e retorna o restante do texto (legenda > 1000).
	 * Em caso de erro, anexa uma mensagem informativa ao final.
	 */
	async handleProfilePictureResponse(processedText, targetJid, context) {
		try {
			if (typeof context.bot.getProfilePictureUrl !== "function") {
				throw new Error("Bot não suporta getProfilePictureUrl");
			}

			const profileUrl = await context.bot.getProfilePictureUrl(targetJid);
			if (!profileUrl) {
				throw new Error("Nenhuma URL de imagem de perfil encontrada");
			}

			const response = await axios.get(profileUrl, { responseType: "arraybuffer" });
			const buffer = Buffer.from(response.data, "binary");
			const media = {
				mimetype: "image/jpeg",
				data: buffer.toString("base64"),
				filename: "profile.jpg",
				isMessageMedia: true
			};

			if (processedText.length <= 1000) {
				if (!context.options) {
					context.options = {};
				}
				context.options.caption = processedText;
				return media;
			} else {
				const chatId = context.message.group ?? context.message.author;
				await context.bot.sendMessage(chatId, media, {
					goReply: context.message.origin
				});
				return processedText;
			}
		} catch (error) {
			this.logger.error(`Erro ao obter foto de perfil para ${targetJid}:`, error.message);
			return processedText + "\n> não foi possível baixar a foto de perfil deste usuário";
		}
	}
}

module.exports = CustomVariableProcessor;
