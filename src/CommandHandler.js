const path = require("path");
const fs = require("fs/promises");
const Database = require("./utils/Database");
const Logger = require("./utils/Logger");
const FixedCommands = require("./commands/FixedCommands");
const Management = require("./commands/Management");
const SuperAdmin = require("./commands/SuperAdmin");
const CustomVariableProcessor = require("./utils/CustomVariableProcessor");
const ReturnMessage = require("./models/ReturnMessage");
const AdminUtils = require("./utils/AdminUtils");
const CacheManager = require("./services/CacheManager");
const CmdUsage = require("./utils/CmdUsage");

class CommandHandler {
	constructor() {
		this.logger = new Logger("command-handler");
		this.database = Database.getInstance();
		this.fixedCommands = new FixedCommands();
		this.management = new Management();
		this.superAdmin = new SuperAdmin();
		this.variableProcessor = new CustomVariableProcessor();
		this.adminUtils = AdminUtils.getInstance();
		this.cmdUsage = CmdUsage.getInstance();
		this.customCommands = {}; // Agrupados por groupId
		this.privateManagement = {}; // Para gerenciar grupos a partir de chats privados
		this.cooldownMessages = {}; // Rastreia quando a última mensagem de cooldown foi enviada

		// Inicializa banco de dados de cooldowns
		this.database.getSQLiteDb(
			"cooldowns",
			`
      CREATE TABLE IF NOT EXISTS cooldowns (
        context_key TEXT,
        command TEXT,
        timestamp INTEGER,
        PRIMARY KEY (context_key, command)
      );
    `
		);

		// Emojis de reação padrão
		this.defaultReactions = {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "✅",
			error: "❌"
		};

		// Prevenção de Spam (Debounce e Ban)
		this.spamLogger = new Logger("spam-prevention");
		this.cmdDebounceTime = parseInt(process.env.CMD_DEBOUNCE) || 3000;
		this.debounceBanLimit = parseInt(process.env.DEBOUNCE_BAN) || 10;
		this.debounceDecayTime = (parseInt(process.env.DEBOUNCE_DECAY) || 60) * 1000;
		this.userDebounceMap = new Map();

		// Timer para decaimento periódico das tentativas de bypass
		this.decayInterval = setInterval(() => {
			const now = Date.now();
			for (const [userId, record] of this.userDebounceMap.entries()) {
				if (record.bypassCount > 0) {
					record.bypassCount--;
				}
				// Limpa registros inativos para economizar memória
				if (record.bypassCount === 0 && (!record.bannedUntil || now >= record.bannedUntil)) {
					this.userDebounceMap.delete(userId);
				}
			}
		}, this.debounceDecayTime);

		// Inicializa cache de comandos
		this.loadAllCommands();
	}

	/**
	 * Carrega todos os comandos de arquivos e banco de dados
	 */
	async loadAllCommands() {
		try {
			// Carrega comandos fixos
			await this.fixedCommands.loadCommands();
			this.logger.debug(`Carregados ${this.fixedCommands.getAllCommands().length} comandos fixos`);

			// Imprime comandos fixos carregados
			this.logger.debug(
				"Comandos fixos:",
				this.fixedCommands
					.getAllCommands()
					.map((cmd) => cmd.name)
					.join(", ")
			);

			// Carrega comandos personalizados para todos os grupos
			const groups = await this.database.getGroups();
			if (groups && Array.isArray(groups)) {
				for (const group of groups) {
					await this.loadCustomCommandsForGroup(group.id);
				}

				//this.logger.debug(`Carregados comandos personalizados para ${groups.length} grupos`);

				// Imprime comandos personalizados por grupo
				// for (const groupId in this.customCommands) {
				//   this.logger.debug(`Comandos personalizados para o grupo ${groupId}:`,
				//     this.customCommands[groupId].map(cmd => cmd.startsWith));
				// }
			}

			this.logger.info("Todos os comandos carregados com sucesso");
		} catch (error) {
			this.logger.error("Erro ao carregar comandos:", error.message ?? "xxx");
		}
	}

	/**
	 * Carrega comandos personalizados para um grupo específico
	 * @param {string} groupId - O ID do grupo
	 */
	async loadCustomCommandsForGroup(groupId) {
		try {
			const customCommands = await this.database.getCustomCommands(groupId);
			if (customCommands && Array.isArray(customCommands)) {
				this.customCommands[groupId] = customCommands.filter((cmd) => cmd.active && !cmd.deleted);
				if (this.customCommands[groupId].length > 0) {
					//this.logger.info(`Carregados ${this.customCommands[groupId].length} comandos personalizados para o grupo ${groupId}`);
				}
			} else {
				this.customCommands[groupId] = [];
				//this.logger.debug(`Nenhum comando personalizado encontrado para o grupo ${groupId}`);
			}
		} catch (error) {
			this.logger.error(
				`Erro ao carregar comandos personalizados para o grupo ${groupId}:`,
				error.message ?? "xxx"
			);
			this.customCommands[groupId] = [];
		}
	}

	/**
	 * Métodos de cooldowns removidos (migrado para SQLite)
	 */

	/**
	 * Verifica se um comando está em cooldown
	 * @param {Command|string} command - Comando ou nome do comando
	 * @param {string} groupId - ID do grupo ou chat
	 * @returns {Promise<Object>} - Informações sobre o cooldown
	 */
	async checkCooldown(command, groupId, botId) {
		const commandName = typeof command === "string" ? command : command.name;
		const finalId = `${botId}_${groupId}`;

		try {
			const row = await this.database.dbGet(
				"cooldowns",
				"SELECT timestamp FROM cooldowns WHERE context_key = ? AND command = ?",
				[finalId, commandName]
			);

			const lastUsed = row ? row.timestamp : 0;
			const now = Date.now();

			let cooldownValue = 0;
			if (typeof command === "object") {
				cooldownValue = command.cooldown ?? cooldownValue;
			}

			const cooldownMs = cooldownValue * 1000;

			if (now - lastUsed < cooldownMs) {
				const timeLeft = Math.ceil((cooldownMs - (now - lastUsed)) / 1000);
				return {
					inCooldown: true,
					timeLeft,
					formattedTime: this.formatCooldownTime(timeLeft)
				};
			}
		} catch (error) {
			this.logger.error("Erro ao verificar cooldown:", error);
		}

		return {
			inCooldown: false,
			timeLeft: 0,
			formattedTime: ""
		};
	}

	/**
	 * Formata o tempo de cooldown para exibição
	 * @param {number} seconds - Tempo em segundos
	 * @returns {string} - Tempo formatado
	 */
	formatCooldownTime(seconds) {
		if (seconds < 60) {
			return `${seconds}s`;
		} else if (seconds < 3600) {
			const minutes = Math.floor(seconds / 60);
			const remainingSeconds = seconds % 60;
			return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
		} else {
			const hours = Math.floor(seconds / 3600);
			const minutes = Math.floor((seconds % 3600) / 60);
			if (minutes > 0) {
				return `${hours}h ${minutes}m`;
			} else {
				return `${hours}h`;
			}
		}
	}

	/**
	 * Atualiza o timestamp de cooldown após uso do comando
	 * @param {Command|string} command - Comando ou nome do comando
	 * @param {string} groupId - ID do grupo ou chat
	 */
	async updateCooldown(command, groupId, botId) {
		const commandName = typeof command === "string" ? command : command.name;
		const finalId = `${botId}_${groupId}`;

		try {
			await this.database.dbRun(
				"cooldowns",
				`
        INSERT INTO cooldowns (context_key, command, timestamp) VALUES (?, ?, ?)
        ON CONFLICT(context_key, command) DO UPDATE SET timestamp = excluded.timestamp
      `,
				[finalId, commandName, Date.now()]
			);
		} catch (error) {
			this.logger.error("Erro ao atualizar cooldown:", error);
		}
	}

	/**
	 * Envia mensagem de cooldown para o usuário
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Mensagem original
	 * @param {Command|string} command - Comando ou nome do comando
	 * @param {string} groupId - ID do grupo ou chat
	 * @param {Object} cooldownInfo - Informações sobre o cooldown
	 */
	async handleCooldownMessage(bot, message, command, groupId, cooldownInfo, group = null) {
		try {
			// Reage com emoji de relógio
			await message.origin.react("😴");

			// Verifica se já enviamos uma mensagem de cooldown para este comando recentemente
			const cooldownMsgKey = `${groupId}:${command.name ?? command}`;
			const lastCooldownMsg = this.cooldownMessages[cooldownMsgKey] ?? 0;
			const now = Date.now();

			// Envia mensagem apenas se não enviamos uma recentemente (nos últimos 30 segundos)
			if (now - lastCooldownMsg > 30000) {
				const returnMessage = new ReturnMessage({
					chatId: groupId,
					content: `O comando '${command.name ?? command}' está em cooldown, aguarde ${cooldownInfo.formattedTime} para usar novamente.`
				});

				await bot.sendReturnMessages(returnMessage, group);

				// Atualiza timestamp da última mensagem de cooldown
				this.cooldownMessages[cooldownMsgKey] = now;
			}
		} catch (error) {
			this.logger.error("Erro ao enviar mensagem de cooldown:", error.message ?? "xxx");
		}
	}

	/**
	 * Verifica se um comando pode ser executado com base em horário e dias
	 * @param {Command|Object} command - Comando a verificar
	 * @returns {boolean} - True se pode ser executado, false caso contrário
	 */
	checkAllowedTimes(command) {
		// Se não tiver a propriedade allowedTimes, permite sempre
		if (!command.allowedTimes) {
			return true;
		}

		const allowedTimes = command.allowedTimes;
		const now = new Date();

		// Verifica dias da semana permitidos
		if (
			allowedTimes.daysOfWeek &&
			Array.isArray(allowedTimes.daysOfWeek) &&
			allowedTimes.daysOfWeek.length > 0
		) {
			// Mapeia dias da semana para seus equivalentes em português
			const dayMap = {
				dom: 0,
				seg: 1,
				ter: 2,
				qua: 3,
				qui: 4,
				sex: 5,
				sab: 6,
				domingo: 0,
				segunda: 1,
				terca: 2,
				quarta: 3,
				quinta: 4,
				sexta: 5,
				sabado: 6
			};

			// Obtém o dia atual da semana (0-6, onde 0 é domingo)
			const currentDay = now.getDay();

			// Verifica se o dia atual está na lista de dias permitidos
			const isDayAllowed = allowedTimes.daysOfWeek.some((day) => {
				const mappedDay = dayMap[day.toLowerCase()];
				return mappedDay === currentDay;
			});

			// Se não estiver no dia permitido, retorna falso
			if (!isDayAllowed) {
				return false;
			}
		}

		// Verifica horário permitido
		if (allowedTimes.start && allowedTimes.end) {
			const [startHour, startMinute] = allowedTimes.start.split(":").map(Number);
			const [endHour, endMinute] = allowedTimes.end.split(":").map(Number);

			// Cria objetos Date para comparação
			const startTime = new Date();
			startTime.setHours(startHour, startMinute, 0, 0);

			const endTime = new Date();
			endTime.setHours(endHour, endMinute, 0, 0);

			// Se o horário de término for antes do início, significa que atravessa a meia-noite
			if (endTime <= startTime) {
				// Verifica se o horário atual está entre o início e meia-noite OU entre meia-noite e o término
				return now >= startTime || now <= endTime;
			} else {
				// Verifica se o horário atual está entre início e término
				return now >= startTime && now <= endTime;
			}
		}

		// Se chegou aqui, é porque passou em todas as verificações ou não tinha restrições
		return true;
	}

	/**
	 * Formata os dias e horários permitidos para exibição
	 * @param {Command|Object} command - Comando a formatar
	 * @returns {string} - Texto formatado
	 */
	formatAllowedTimes(command) {
		if (!command.allowedTimes) {
			return "qualquer horário e dia";
		}

		const allowedTimes = command.allowedTimes;
		let result = "";

		// Formata horários
		if (allowedTimes.start && allowedTimes.end) {
			result += `das ${allowedTimes.start} até ${allowedTimes.end}`;
		}

		// Formata dias
		if (
			allowedTimes.daysOfWeek &&
			Array.isArray(allowedTimes.daysOfWeek) &&
			allowedTimes.daysOfWeek.length > 0
		) {
			// Mapeia abreviações para nomes completos
			const dayMap = {
				dom: "domingos",
				seg: "segundas",
				ter: "terças",
				qua: "quartas",
				qui: "quintas",
				sex: "sextas",
				sab: "sábados"
			};

			// Formata lista de dias
			const daysText = allowedTimes.daysOfWeek
				.map((day) => dayMap[day.toLowerCase()] ?? day)
				.join(", ");

			if (result) {
				result += ` nos dias: ${daysText}`;
			} else {
				result += `nos dias: ${daysText}`;
			}
		}

		return result ?? "qualquer horário e dia";
	}

	/**
	 * Agrega mensagens de retorno consecutivas que são apenas texto
	 * @param {Array|ReturnMessage} messages - Mensagens a serem agregadas
	 * @returns {Array} - Array de mensagens agregadas
	 */
	aggregateReturnMessages(messages) {
		if (!messages) return [];
		const flatMessages = Array.isArray(messages) ? messages.flat() : [messages];
		const result = [];
		let currentTextOnly = null;

		for (const msg of flatMessages) {
			if (!msg) continue;

			// Verifica se é uma ReturnMessage e se é apenas texto (sem mídia/opções especiais)
			const isTextOnly =
				msg instanceof ReturnMessage &&
				typeof msg.content === "string" &&
				(!msg.options ||
					(!msg.options.caption &&
						!msg.options.sticker &&
						!msg.options.sendMediaAsSticker &&
						!msg.options.mediaUrl));

			if (isTextOnly) {
				if (currentTextOnly) {
					currentTextOnly.content += "\n-----------\n" + msg.content;
				} else {
					currentTextOnly = msg;
					result.push(currentTextOnly);
				}
			} else {
				currentTextOnly = null;
				result.push(msg);
			}
		}

		// Aplica delay incremental de 500ms para cada ReturnMessage no array final
		result.forEach((msg, index) => {
			if (msg instanceof ReturnMessage) {
				msg.delay = (msg.delay || 0) + index * 500;
			}
		});

		return result;
	}

	delayedReaction(msg, emoji, delay) {
		setTimeout(
			(m, e) => {
				m.react(e);
			},
			delay + 1000,
			msg,
			emoji
		);
	}

	/**
	 * Manipula uma mensagem de comando
	 * @param {WhatsAppBot} bot - A instância do bot
	 * @param {Object} message - A mensagem formatada
	 * @param {string} commandText - O texto do comando (sem prefixo)
	 * @param {Group} group - O objeto do grupo (se em grupo)
	 */
	async handleCommand(bot, message, commandText, group) {
		try {
			const userId = message.author || message.authorAlt || message.from;
			if (userId) {
				// Ignorar prevenção de spam para super admins/dono do bot
				const isSuperAdmin =
					this.superAdmin.isSuperAdmin(userId) ||
					(this.adminUtils &&
						typeof this.adminUtils.isComuAdmin === "function" &&
						this.adminUtils.isComuAdmin(userId, bot));

				if (!isSuperAdmin) {
					const now = Date.now();
					let record = this.userDebounceMap.get(userId);

					if (!record) {
						record = {
							lastCommandTime: 0,
							bypassCount: 0,
							bannedUntil: 0
						};
						this.userDebounceMap.set(userId, record);
					}

					// Verifica se o usuário está atualmente banido
					if (record.bannedUntil && now < record.bannedUntil) {
						this.spamLogger.warn(
							`[SpamPrevention] Usuário ${userId} tentou executar '${commandText.trim()}' mas está banido por spam até ${new Date(record.bannedUntil).toISOString()}`
						);
						return null;
					}

					// Verifica se passou do tempo mínimo do debounce
					const elapsed = now - record.lastCommandTime;
					if (elapsed < this.cmdDebounceTime) {
						record.bypassCount++;
						record.lastCommandTime = now; // Reinicia o cronômetro do debounce

						this.spamLogger.warn(
							`[SpamPrevention] Usuário ${userId} violou o debounce com '${commandText.trim()}' (${elapsed}ms < ${this.cmdDebounceTime}ms). Tentativas de bypass: ${record.bypassCount}/${this.debounceBanLimit}`
						);

						if (record.bypassCount >= this.debounceBanLimit) {
							record.bannedUntil = now + 3600000; // Banido por 1 hora
							this.spamLogger.error(
								`[SpamPrevention] Usuário ${userId} foi banido de usar comandos por 1 hora (excedeu o limite de bypass: ${record.bypassCount}/${this.debounceBanLimit})`
							);

							// Reage com o emoji 📵
							try {
								if (message.origin && typeof message.origin.react === "function") {
									await message.origin.react("📵").catch((err) => {
										this.logger.error("Erro ao reagir com emoji 📵:", err.message ?? "xxx");
									});
								}
							} catch (reactError) {
								this.logger.error(
									"Erro ao aplicar reação de banimento:",
									reactError.message ?? "xxx"
								);
							}

							// Notifica no chat apropriado
							const replyToChat = message.group ?? message.author;
							const returnMessage = new ReturnMessage({
								chatId: replyToChat,
								content: `⚠️ *Prevenção de Spam:* Você foi banido de usar comandos por 1 hora por exceder o limite de spam.`
							});
							await bot.sendReturnMessages(returnMessage, group).catch((err) => {
								this.logger.error(
									"Erro ao enviar mensagem de banimento por spam:",
									err.message ?? "xxx"
								);
							});
						}
						return null; // Interrompe a execução
					}

					// Se passou no debounce, atualiza o timestamp do último comando executado com sucesso/tentativa
					record.lastCommandTime = now;
				}
			}

			// Obtém a primeira palavra como nome do comando
			const [command, ...args] = commandText.trim().split(/\s+/);

			//this.logger.debug(`Processando comando: ${command}, args: ${args.join(', ')}`);

			// Verifica se é um comando de super admin (começa com 'sa-')
			if (command.startsWith("sa-")) {
				// Verifica se o usuário é um super admin
				if (
					this.superAdmin.isSuperAdmin(message.author) ||
					this.adminUtils.isComuAdmin(message.author, bot)
				) {
					const saCommand = command.substring(3); // Remove o prefixo 'sa-'
					const methodName = this.superAdmin.getCommandMethod(saCommand);

					if (methodName && typeof this.superAdmin[methodName] === "function") {
						this.logger.debug(`Executando método de super admin: ${methodName}`);
						const result = await this.superAdmin[methodName](bot, message, args, group);

						// Log usage
						this.cmdUsage.logCommand({
							timestamp: Date.now(),
							type: "superadmin",
							command: saCommand,
							user: message.author,
							groupId: message.group ?? "private",
							args: args.join(" "),
							returnData: result
								? result.content || (Array.isArray(result) ? "Array" : "Object")
								: "void"
						});

						if (result) {
							await bot.sendReturnMessages(result, group);
						}
					} else {
						const chatId = message.group ?? message.author;
						const returnMessage = new ReturnMessage({
							chatId,
							content: `Comando de super admin desconhecido: ${saCommand}`
						});
						await bot.sendReturnMessages(returnMessage, group);
					}
					return;
				} else {
					// Usuário não é super admin
					const chatId = message.group ?? message.author;
					const returnMessage = new ReturnMessage({
						chatId,
						content: "⛔ Apenas super administradores podem usar estes comandos."
					});
					await bot.sendReturnMessages(returnMessage, group);
					return;
				}
			}

			// Processa comando normalmente
			this.processCommand(bot, message, command, args, group).catch((error) => {
				this.logger.error("Erro em processCommand:", error.message ?? "xxx");
			});

			// Nota: Não esperamos processCommand para evitar bloquear a thread de eventos
		} catch (error) {
			this.logger.error("Erro ao manipular comando:", error.message ?? "xxx");
		}
	}

	/**
	 * Processa um comando após determinar seu tipo
	 * @param {WhatsAppBot} bot - A instância do bot
	 * @param {Object} message - A mensagem formatada
	 * @param {string} command - O nome do comando
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - O objeto do grupo (se em grupo)
	 * @param {Object} options - Opções de processamento (silent, skipCustom)
	 */
	async processCommand(bot, message, command, args, group, options = {}) {
		const skipCustom = options.skipCustom ?? false;
		const silent = options.silent ?? false;

		//this.logger.debug(`Processando comando: ${command}, determinação de tipo`);

		// Definir o chatId de resposta - por padrão é o chatId original
		let replyToChat = message.group ?? message.author;
		let isManagingFromPrivate = false;
		const gidDebug = group?.name ?? "pv";

		// Verifica se é um comando de gerenciamento
		if (command.startsWith("g-")) {
			this.logger.debug(
				`[${gidDebug}][${message.author}/${message.name}] Comando de gerenciamento: '${command}' '${args.join(" ")}'`
			);

			// Verifica se é gerenciamento de grupo via PV
			if (!message.group) {
				// Se veio no PV, primeiro vê se não é g-manage
				if (command === "g-manage") {
					if (args.length > 0) {
						// Tem argumento, está tentando definir um grupo no PV
						const groupName = args[0].trim().toLowerCase();
						const groups = await this.database.getGroups();
						const targetGroup = groups.find((g) => g.name.trim().toLowerCase() === groupName);

						if (targetGroup) {
							const isUserAdminInTarget = await this.adminUtils.isAdmin(
								message.author,
								targetGroup,
								false,
								bot
							);
							if (isUserAdminInTarget) {
								this.privateManagement[message.author] = targetGroup.id;
								this.logger.info(
									`Usuário ${message.author} agora está gerenciando o grupo: ${targetGroup.name} (${targetGroup.id})`
								);

								const returnMessage = new ReturnMessage({
									chatId: message.author,
									content: `Você agora está gerenciando o grupo: ${targetGroup.name}`,
									reaction: this.defaultReactions.after
								});
								if (!silent) await bot.sendReturnMessages(returnMessage, group);

								return returnMessage;
							} else {
								const returnMessage = new ReturnMessage({
									chatId: message.author,
									content: `Você *NÃO É* administrador do grupo '${targetGroup.name}'.`,
									reaction: "🙅‍♂️"
								});
								if (!silent) await bot.sendReturnMessages(returnMessage, group);
								return returnMessage;
							}
						} else {
							this.logger.warn(`Grupo não encontrado: ${groupName}`);

							const returnMessage = new ReturnMessage({
								chatId: message.author,
								content: `Grupo não encontrado: ${groupName}`,
								reaction: this.defaultReactions.after
							});
							if (!silent) await bot.sendReturnMessages(returnMessage, group);

							return returnMessage;
						}
					} else {
						// No PV e sem argumentos = quer voltar ao normal
						this.privateManagement[message.author] = undefined;
						const returnMessage = new ReturnMessage({
							chatId: message.author,
							content: `Você agora não está mais gerenciando o grupo pelo pv.`,
							reaction: this.defaultReactions.after
						});
						if (!silent) await bot.sendReturnMessages(returnMessage, group);
						return returnMessage;
					}
				} else if (command === "g-painel" && args.length > 0) {
					// Permite !g-painel nomegrupo diretamente no PV
					const groupName = args[0].trim().toLowerCase();
					const groups = await this.database.getGroups();
					const targetGroup = groups.find((g) => g.name.trim().toLowerCase() === groupName);

					if (targetGroup) {
						const isUserAdminInTarget = await this.adminUtils.isAdmin(
							message.author,
							targetGroup,
							false,
							bot
						);
						if (isUserAdminInTarget) {
							this.privateManagement[message.author] = targetGroup.id;
							this.logger.info(
								`Usuário ${message.author} agora está gerenciando o grupo (via g-painel): ${targetGroup.name} (${targetGroup.id})`
							);
							group = targetGroup;
							replyToChat = message.author;
							isManagingFromPrivate = true;
						} else {
							const returnMessage = new ReturnMessage({
								chatId: message.author,
								content: `Você *NÃO É* administrador do grupo '${targetGroup.name}'.`,
								reaction: "🙅‍♂️"
							});
							if (!silent) await bot.sendReturnMessages(returnMessage, group);
							return returnMessage;
						}
					} else {
						this.logger.warn(`Grupo não encontrado: ${groupName}`);

						const returnMessage = new ReturnMessage({
							chatId: message.author,
							content: `Grupo não encontrado: ${groupName}`,
							reaction: this.defaultReactions.after
						});
						if (!silent) await bot.sendReturnMessages(returnMessage, group);
						return returnMessage;
					}
				} else {
					// Não é g-manage ou g-painel com argumentos, então verifica se o cara já está gerenciando um pelo PV

					if (this.privateManagement[message.author]) {
						const managedGroupId = this.privateManagement[message.author];
						const managedGroup = await this.database.getGroup(managedGroupId);

						if (managedGroup) {
							// Processa como se a mensagem fosse enviada no grupo gerenciado
							this.logger.info(
								`Processando comando de gerenciamento para o grupo ${managedGroupId} de chat privado por ${message.author}`
							);
							//return this.processCommand(bot, { ...message, group: managedGroupId }, command, args, managedGroup);
							group = managedGroup;
						} else {
							this.logger.warn(
								`Falha ao encontrar grupo gerenciado ${managedGroupId} para o usuário ${message.author}`
							);
						}

						// Se estamos gerenciando um grupo a partir do PV, vamos responder no PV
						replyToChat = message.author;
						isManagingFromPrivate = true;

						// Registra que estamos respondendo no PV para um comando de gerenciamento de grupo
						this.logger.info(
							`Comando ${command} enviado por ${message.author} no PV para gerenciar o grupo ${group.id} - responderemos no PV`
						);
					}
				}
				// Fim PV
			}

			// Verifica se o grupo está pausado e se o comando NÃO é g-pausar
			// No privado não existe !pausar
			if (group && group.paused && (command !== "g-pausar") & !isManagingFromPrivate) {
				this.logger.info(`Ignorando comando de gerenciamento em grupo pausado: ${command}`);
				return null;
			}

			// Modifica a mensagem para forçar o envio da resposta para o chatId correto
			const originalMessage = { ...message };
			if (isManagingFromPrivate) {
				// Cria um objeto temporário para usar no processamento
				message.managementResponseChatId = replyToChat;
			}

			const result = await this.processManagementCommand(
				bot,
				message,
				command,
				args,
				group,
				silent
			);

			// Restaura a mensagem original se necessário
			if (isManagingFromPrivate) {
				message = originalMessage;
			}

			return result;
		}

		// Verifica se o grupo está pausado (para outros tipos de comandos)
		if (group && group.paused) {
			this.logger.info(
				`[${gidDebug}][${message.author}/${message.authorName}] Ignorando comando em grupo pausado (${command})`
			);
			return null;
		}

		// Verifica se é um comando fixo
		const fixedCommand = this.fixedCommands.getCommand(command);
		if (fixedCommand) {
			this.logger.debug(
				`[${gidDebug}][${message.author}/${message.authorName}] Comando fixo '${command}' '${args.join(" ")}'`
			);
			return await this.executeFixedCommand(bot, message, fixedCommand, args, group, silent);
		}

		// Verifica se é um comando personalizado (apenas para mensagens de grupo)
		if (group && this.customCommands[group.id] && !skipCustom) {
			// Quando é comando embutid ({cmd-xxx}), não roda personalizados, se não vira um loop
			const matchResult = this.findCustomCommand(command, this.customCommands[group.id], args);
			if (matchResult) {
				const { customCommand, newArgs } = matchResult;
				this.logger.debug(
					`[${gidDebug}][${message.author}/${message.authorName}] Comando custom (${customCommand.startsWith}) '${command}' '${newArgs.join(" ")}'`
				);
				return await this.executeCustomCommand(bot, message, customCommand, newArgs, group, silent);
			} else {
				if (group.prefix && group.prefix !== "" && !silent) {
					message.origin.react("🆖");
				}
			}
		}

		// Nenhum comando encontrado
		this.logger.debug(
			`[${gidDebug}][${message.author}/${message.authorName}] Comando desconhecido: '${command}' '${args.join(" ")}'`
		);

		// Se em um grupo, podemos querer notificar sobre comando desconhecido (opcional)
		if (group && process.env.NOTIFY_UNKNOWN_COMMANDS === "true" && !silent) {
			const returnMessage = new ReturnMessage({
				chatId: replyToChat, // Usa o chatId de resposta correto
				content: `Comando desconhecido: ${command}`
			});
			await bot.sendReturnMessages(returnMessage, group);
			return returnMessage;
		}

		return null;
	}

	/**
	 * Processa um comando de gerenciamento
	 * @param {WhatsAppBot} bot - A instância do bot
	 * @param {Object} message - A mensagem formatada
	 * @param {string} command - O nome do comando
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - O objeto do grupo (se em grupo)
	 * @param {boolean} silent - Se true, não envia mensagens nem reage
	 */
	async processManagementCommand(bot, message, command, args, group, silent = false) {
		try {
			const gidDebug = group?.name ?? "pv";

			// Determina o chatId correto para a resposta
			// Se estamos gerenciando via PV, a resposta deve ir para o PV
			const responseChatId = message.managementResponseChatId ?? message.group ?? message.author;

			// Reage com o emoji "antes"
			try {
				// Usa emoji de reação padrão
				if (!silent) await message.origin.react(this.defaultReactions.before);
			} catch (reactError) {
				this.logger.error('Erro ao aplicar reação "antes":', reactError.message ?? "xxx");
			}

			// Comandos de gerenciamento regulares requerem um grupo
			if (!group) {
				this.logger.warn(`Comando de gerenciamento ${command} tentado em chat privado`);

				const returnMessage = new ReturnMessage({
					chatId: responseChatId,
					content:
						"Comandos de gerenciamento só podem ser usados em grupos. Use !g-manage [nomeDoGrupo] para gerenciar um grupo a partir do chat privado."
				});
				if (!silent) await bot.sendReturnMessages(returnMessage, group);

				return returnMessage;
			}

			const chat = message.groupChat ?? (await message.origin.getChat()); // groupChat é o objeto do grupo quando vem do pv
			// Não passa o chat se for pv
			const isUserAdmin = await this.adminUtils.isAdmin(
				message.author,
				group,
				chat.isGroup ? chat : null,
				bot
			);

			if (!isUserAdmin) {
				this.logger.warn(
					`Usuário ${message.author} tentou usar comando de gerenciamento sem ser admin: ${command}`
				);

				const returnMessage = new ReturnMessage({
					chatId: responseChatId,
					content: "⛔ Apenas administradores podem usar comandos de gerenciamento.",
					reaction: this.defaultReactions.error
				});
				if (!silent) await bot.sendReturnMessages(returnMessage, group);

				return returnMessage;
			}

			// Remove o prefixo 'g-'
			const managementCommand = command.substring(2);

			// Encontra o método de gerenciamento apropriado
			const methodName = this.management.getCommandMethod(managementCommand);
			if (methodName && typeof this.management[methodName] === "function") {
				this.logger.debug(`Executando método de gerenciamento: ${methodName}`);

				// Importante: Criar uma cópia da mensagem para não afetar a original
				const messageClone = JSON.parse(JSON.stringify(message));

				// Força o grupo para o comando
				if (message.managementResponseChatId) {
					messageClone.group = group.id; // Importante: garante que o grupo correto seja usado
				}

				messageClone.origin = message.origin; // Aqui precisa, obrigatoriamente, ser a referência, não cópia
				messageClone.origin.body = messageClone.origin.body.replace(
					`${group.prefix} `,
					group.prefix
				); // "! " vira "!"

				const managementResponse = await this.management[methodName](
					bot,
					messageClone,
					args,
					group,
					this.privateManagement
				);

				// Log usage
				this.cmdUsage.logCommand({
					timestamp: Date.now(),
					type: "management",
					command: managementCommand,
					user: message.author,
					groupId: group.id,
					args: args.join(" "),
					returnData: managementResponse
						? managementResponse.content || (Array.isArray(managementResponse) ? "Array" : "Object")
						: "void"
				});

				// Se a resposta for ReturnMessage ou array de ReturnMessage, modifica chatId se necessário
				if (managementResponse) {
					if (Array.isArray(managementResponse)) {
						// Modifica o chatId de todas as mensagens para o chatId correto
						managementResponse.forEach((msg) => {
							if (msg instanceof ReturnMessage && msg.chatId === group.id) {
								msg.chatId = responseChatId;
							}
						});
					} else if (
						managementResponse instanceof ReturnMessage &&
						managementResponse.chatId === group.id
					) {
						managementResponse.chatId = responseChatId;
					}
				}

				if (!silent) await bot.sendReturnMessages(managementResponse, group);

				// Reage com o emoji "depois"
				try {
					if (!silent) await message.origin.react(this.defaultReactions.after);
				} catch (reactError) {
					this.logger.error('Erro ao aplicar reação "depois":', reactError.message ?? "xxx");
				}

				return managementResponse;
			} else {
				this.logger.warn(`Comando de gerenciamento desconhecido: ${managementCommand}`);

				const returnMessage = new ReturnMessage({
					chatId: responseChatId,
					content: `Comando de gerenciamento desconhecido: ${managementCommand}`,
					reaction: this.defaultReactions.after
				});
				if (!silent) await bot.sendReturnMessages(returnMessage, group);

				return returnMessage;
			}
		} catch (error) {
			this.logger.error("Erro ao processar comando de gerenciamento:", error.message ?? "xxx");

			const responseChatId = message.managementResponseChatId ?? message.group ?? message.author;
			const returnMessage = new ReturnMessage({
				chatId: responseChatId,
				content: "Erro ao processar comando de gerenciamento",
				reaction: this.defaultReactions.after
			});
			if (!silent) await bot.sendReturnMessages(returnMessage, group);
			return returnMessage;
		}
	}

	/**
	 * Executa um comando fixo
	 * @param {WhatsAppBot} bot - A instância do bot
	 * @param {Object} message - A mensagem formatada
	 * @param {Object} command - O objeto de comando
	 * @param {Array} args - Argumentos do comando
	 * @param {Group} group - O objeto do grupo (se em grupo)
	 * @param {boolean} silent - Se true, não envia mensagens nem reage
	 */
	async executeFixedCommand(
		bot,
		message,
		command,
		args,
		group,
		silent = false,
		silentReaction = false
	) {
		try {
			// this.logger.info(
			// 	`[${bot.id}][${message.author ?? message.authorAlt}@${group?.name ?? "PV"}] Executando comando fixo '${command.name}'`,
			// 	{ args }
			// );

			// Verifica se a categoria de comando não está mutada
			if (group && group.mutedCategories && Array.isArray(group.mutedCategories)) {
				if (
					command &&
					command.category &&
					group.mutedCategories.includes(command.category.toLowerCase())
				) {
					this.logger.debug(
						`Ignorando comando '${command.name}' da categoria silenciada '${command.category}'`
					);
					return null;
				}
			}

			// Verifica se o comando específico está mutado
			if (group && group.mutedCommands && Array.isArray(group.mutedCommands)) {
				if (command && group.mutedCommands.includes(command.name)) {
					this.logger.debug(`Ignorando comando '${command.name}' pois está silenciado no grupo.`);
					if (!silent && !silentReaction) message.origin.react("⛔️");
					return null;
				}
			}

			// Verifica se o comando requer mensagem citada
			if (command.needsQuotedMsg) {
				const quotedMsg = await message.origin.getQuotedMessage().catch(() => null);
				if (!quotedMsg) {
					this.logger.debug(
						`Comando ${command.name} requer mensagem citada, mas nenhuma foi fornecida`
					);
					return null; // Ignora o comando silenciosamente
				}
			}

			// Apenas para adminsitradores
			if (command.adminOnly) {
				const chat = await message.origin.getChat();
				const isUserAdmin = await this.adminUtils.isAdmin(message.author, group, chat, bot);
				if (!isUserAdmin) {
					if (!silent && !silentReaction) message.origin.react("📵");
					this.logger.debug(`Comando ${command.name} requer administrador, mas o usuário não é`, {
						author: message.author,
						group,
						chat
					});
					return null;
				}
			}

			// Verifica se o comando requer mídia
			if (command.needsMedia) {
				const hasDirectMedia = message.type !== "text";

				// Verifica a mensagem citada para mídia se a mensagem direta não tiver
				let hasQuotedMedia = false;
				if (!hasDirectMedia) {
					// Se há referência a uma mensagem citada (mesmo que o cache tenha expirado),
					// passa o comando adiante para que ele possa retornar a mensagem de erro adequada
					if (message.hasQuotedMsg) {
						hasQuotedMedia = true; // deixa o comando tratar o caso de cache expirado
					} else {
						const quotedMsg = await message.origin.getQuotedMessage().catch(() => null);
						hasQuotedMedia = quotedMsg && quotedMsg.hasMedia;
					}
				}

				if (!hasDirectMedia && !hasQuotedMedia) {
					this.logger.debug(`Comando ${command.name} requer mídia, mas nenhuma foi fornecida`);
					return null; // Ignora o comando silenciosamente
				}
			}

			// Comando exclusivo para alguns grupos, como APIs pagas
			if (command.exclusive) {
				if (!command.exclusive.includes(group?.name ?? "----")) {
					this.logger.debug(
						`Comando ${command.name} não está habilitado para este grupo ('${group?.name ?? "PV"}').`
					);
					return null;
				}
			}

			// Verifica horários permitidos
			if (!this.checkAllowedTimes(command)) {
				this.logger.debug(`Comando ${command.name} não está disponível neste horário/dia`);

				// Reage com emoji de relógio
				if (!silent && !silentReaction) {
					try {
						message.origin.react("🕒");
					} catch (reactError) {
						this.logger.error(
							'Erro ao aplicar reação "indisponível":',
							reactError.message ?? "xxx"
						);
					}
				}

				const chatId = message.group ?? message.author;
				const returnMessage = new ReturnMessage({
					chatId,
					content: `O comando ${command.name} só está disponível ${this.formatAllowedTimes(command)}.`
				});

				if (!silent) await bot.sendReturnMessages(returnMessage, group);
				return returnMessage;
			}

			// Verifica cooldown
			const groupId = message.group ?? message.author;
			const cooldownInfo = await this.checkCooldown(command, groupId, bot.id);

			if (cooldownInfo.inCooldown) {
				this.logger.debug(`Comando ${command.name} em cooldown por mais ${cooldownInfo.timeLeft}s`);
				if (!silent) await this.handleCooldownMessage(bot, message, command, groupId, cooldownInfo);
				return null;
			}

			// Reage com emoji "antes" (específico do comando ou padrão)
			if (!silent && !silentReaction && command.reactions?.before) {
				try {
					message.origin.react(command.reactions?.before);
				} catch (reactError) {
					this.logger.error('Erro ao aplicar reação "antes":', reactError.message ?? "xxx");
				}
			}

			// Executa método do comando
			if (typeof command.method === "function") {
				this.updateCooldown(command, groupId, bot.id);
				//this.logger.debug(`Comando ${command.name} tem method, executando`);
				let result = await command.method(bot, message, args, group);

				// Log usage
				this.cmdUsage.logCommand({
					timestamp: Date.now(),
					type: "fixed",
					command: command.name,
					user: message.author,
					groupId: groupId || "private",
					args: args.join(" "),
					returnData: result
						? result.content || (Array.isArray(result) ? "Array" : "Object")
						: "void"
				});

				//this.logger.debug(`Comando ${command.name} resposta do method: `, { ReMsg: (result instanceof ReturnMessage), result });

				// Verifica se o resultado é um ReturnMessage ou array de ReturnMessages
				if (result) {
					if (typeof result === "string") {
						result = new ReturnMessage({
							chatId: groupId,
							content: result,
							options: { quotedMessageId: message.origin.id._serialized }
						});
					}
					if (
						result instanceof ReturnMessage ||
						(Array.isArray(result) && result.length > 0 && result[0] instanceof ReturnMessage)
					) {
						// Adiciona reação "depois" nas mensagens se não estiver definida

						const messages = Array.isArray(result) ? result : [result];
						const requesterId = message.authorAlt || message.author;

						messages.forEach((msg) => {
							if (!msg.reactions && command.reactions?.after) {
								msg.reaction = command.reactions?.after;
							}

							// Auto-mention do usuário que pediu o comando (apenas em grupos)
							if (requesterId && msg instanceof ReturnMessage && message.group) {
								if (!msg.options) msg.options = {};
								if (!msg.options.mentions) msg.options.mentions = [];
								if (!msg.options.mentions.includes(requesterId)) {
									msg.options.mentions.push(requesterId);
								}
							}
						});

						// Envia as ReturnMessages
						if (!silent) await bot.sendReturnMessages(result, group);
					}
				}

				//this.logger.debug(`Comando ${command.name} executado com sucesso, enviando after reaction`);

				// Reage com emoji "depois" (específico do comando ou padrão)
				if (!silent && !silentReaction && command.reactions?.after && result !== false) {
					this.delayedReaction(message.origin, command.reactions.after, 1000);
				}

				return result;
			} else {
				this.logger.error(`Método de comando inválido para ${command.name}`);

				// Reage com emoji "depois" mesmo para erro
				const afterEmoji = command.reactions?.after ?? this.defaultReactions.after;
				if (!silent && !silentReaction) {
					try {
						message.origin.react(afterEmoji);
					} catch (reactError) {
						this.logger.error('Erro ao aplicar reação "depois":', reactError.message ?? "xxx");
					}
				}
				return null;
			}
		} catch (error) {
			this.logger.error(`Erro ao executar comando fixo ${command.name}:`, error.message ?? "xxx");

			const chatId = message.group ?? message.author;
			const errorEmoji = command.reactions?.error ?? this.defaultReactions.error;

			const returnMessage = new ReturnMessage({
				chatId,
				content: `Erro ao executar comando: ${command.name}`,
				reaction: !silent && !silentReaction ? errorEmoji : undefined
			});
			if (!silent) await bot.sendReturnMessages(returnMessage, group);
			return returnMessage;
		}
	}

	/**
	 * Encontra um comando personalizado pelo nome na lista
	 * @param {string} firstWord - O nome do comando ou primeira palavra
	 * @param {Array} commands - Lista de comandos personalizados
	 * @param {Array} args - Argumentos do comando
	 * @returns {Object|null} - Objeto contendo { customCommand, newArgs } ou null
	 */
	findCustomCommand(firstWord, commands, args = []) {
		// Construct all possible prefixes from input
		const inputs = [];
		let current = firstWord;
		inputs.push({ text: current, consumed: 0 });

		const limit = Math.min(args.length, 10);
		for (let i = 0; i < limit; i++) {
			current += " " + args[i];
			inputs.push({ text: current, consumed: i + 1 });
		}

		// 1. Exact matches (Longest first)
		for (let i = inputs.length - 1; i >= 0; i--) {
			const check = inputs[i];
			const commandName = check.text;

			const exactMatch = commands.find(
				(cmd) =>
					cmd.startsWith &&
					(cmd.caseSensitive
						? cmd.startsWith === commandName
						: cmd.startsWith.toLowerCase() === commandName.toLowerCase())
			);

			if (exactMatch) {
				this.logger.debug(`Encontrada correspondência exata para comando '${commandName}'`);
				return { customCommand: exactMatch, newArgs: args.slice(check.consumed) };
			}
		}

		// 2. Partial matches (Longest first)
		for (let i = inputs.length - 1; i >= 0; i--) {
			const check = inputs[i];
			const commandName = check.text;

			const partialMatch = commands.find((cmd) => {
				if (cmd.startsWith && commandName.toLowerCase().startsWith(cmd.startsWith.toLowerCase())) {
					return true;
				}
				return false;
			});

			if (partialMatch) {
				return { customCommand: partialMatch, newArgs: args.slice(check.consumed) };
			}
		}

		return null;
	}

	/**
	 * Executa um comando personalizado
	 * @param {WhatsAppBot} bot - A instância do bot
	 * @param {Object} message - A mensagem formatada
	 * @param {Object} command - O objeto de comando personalizado
	 * @param {Array} args - Argumentos do comando
	 * @param {Group} group - O objeto do grupo
	 * @param {boolean} silent - Se true, não envia mensagens nem reage
	 */
	async executeCustomCommand(
		bot,
		message,
		command,
		args,
		group,
		silent = false,
		silentReaction = false
	) {
		try {
			//this.logger.info(`Executando comando personalizado: ${command.startsWith}`);

			// Obtém as respostas
			const responses = command.responses ?? [];
			if (responses.length === 0) {
				this.logger.warn(`Comando ${command.startsWith} não tem respostas`);
				return null;
			}

			// Apenas para adminsitradores
			if (command.adminOnly) {
				const chat = await message.origin.getChat();
				const isUserAdmin = await this.adminUtils.isAdmin(message.author, group, chat, bot);
				if (!isUserAdmin) {
					this.logger.debug(`Comando ${command.name} requer administrador, mas o usuário não é`);

					if (!silent && !silentReaction) {
						try {
							message.origin.react("⛔️");
						} catch (reactError) {
							this.logger.error(
								'Erro ao aplicar reação "indisponível":',
								reactError.message ?? "xxx"
							);
						}
					}

					const returnMessage = new ReturnMessage({
						chatId: message.group,
						content: `o comando *${command.startsWith}* só pode ser usado por _administradores_.`
					});

					return returnMessage;
				}
			}

			if (command.allowedTimes && !this.checkAllowedTimes(command)) {
				this.logger.debug(`Comando ${command.startsWith} não está disponível neste horário/dia`);

				// Reage com emoji de relógio
				if (!silent && !silentReaction) {
					try {
						message.origin.react("🕒");
					} catch (reactError) {
						this.logger.error(
							'Erro ao aplicar reação "indisponível":',
							reactError.message ?? "xxx"
						);
					}
				}

				const returnMessage = new ReturnMessage({
					chatId: message.group,
					content: `o comando *${command.startsWith}* só está disponível ${this.formatAllowedTimes(command)}.`
				});

				if (!silent) await bot.sendReturnMessages(returnMessage, group);
				return returnMessage;
			}

			// Verifica cooldown (passa objeto inteiro para que o cooldown personalizado do comando seja respeitado)
			const cooldownCheckCmd = { name: command.startsWith, cooldown: command.cooldown ?? 0 };
			const cooldownInfo = await this.checkCooldown(cooldownCheckCmd, message.group, bot.id);

			if (cooldownInfo.inCooldown) {
				this.logger.debug(
					`Comando ${command.startsWith} em cooldown por mais ${cooldownInfo.timeLeft}s`
				);
				if (!silent)
					await this.handleCooldownMessage(
						bot,
						message,
						command.startsWith,
						message.group,
						cooldownInfo
					);
				return null;
			}

			// Reage com emoji antes (do comando ou padrão)
			if (!silent && !silentReaction && command.reactions?.before) {
				try {
					await message.origin.react(command.reactions?.before);
				} catch (reactError) {
					this.logger.error('Erro ao aplicar reação "antes":', reactError.message ?? "xxx");
				}
			}

			// Atualiza estatísticas de uso do comando
			command.count = (command.count ?? 0) + 1;
			command.lastUsed = Date.now();
			await this.database.updateCustomCommand(group.id, command);
			this.logger.debug(
				`Atualizadas estatísticas de uso para o comando *${command.startsWith}*, contagem: ${command.count}`
			);

			// Log usage
			this.cmdUsage.logCommand({
				timestamp: Date.now(),
				type: "custom",
				command: command.startsWith,
				user: message.author,
				groupId: group.id,
				args: args.join(" "),
				returnData: `Responses: ${responses.length}`
			});

			// Reage à mensagem se especificado (esta é a reação específica do comando)
			if (!silent && !silentReaction && command.react) {
				try {
					this.logger.debug(`Reagindo à mensagem com: ${command.react}`);
					await message.origin.react(command.react);
				} catch (error) {
					this.logger.error("Erro ao reagir à mensagem:", error.message ?? "xxx");
				}
			}

			this.updateCooldown(command.startsWith, message.group, bot.id);

			let finalResult = null;

			// Envia todas as respostas ou seleciona uma aleatória
			if (command.sendAllResponses) {
				this.logger.debug(
					`Enviando todas as ${responses.length} respostas para o comando *${command.startsWith}*`
				);
				const returnMessages = [];

				for (const response of responses) {
					const processedMessage = await this.processCustomCommandResponse(
						bot,
						message,
						response,
						command,
						group,
						args
					);
					if (processedMessage) {
						if (command.replyInPvivate) {
							processedMessage.chatId = message.author; // ou authorAlt?
						}
						// Adiciona menções do comando
						if (!processedMessage.options) processedMessage.options = {};
						const mentionsSet = new Set(processedMessage.options.mentions || []);

						if (command.mentions && command.mentions.length > 0) {
							command.mentions.forEach((m) => mentionsSet.add(m));
						}

						// Auto-mention do usuário que pediu o comando (apenas em grupos e se não for resposta privada)
						if (message.group && !command.replyInPvivate) {
							const requesterId = message.authorAlt || message.author;
							if (requesterId) mentionsSet.add(requesterId);
						}

						processedMessage.options.mentions = Array.from(mentionsSet);
						returnMessages.push(processedMessage);
					}
				}

				// Envia todas as mensagens de retorno
				if (returnMessages.length > 0) {
					// Enviar mensagem no grupo ou pv?
					if (!silent) await bot.sendReturnMessages(returnMessages, group);
				}
				finalResult = returnMessages;
			} else {
				const randomIndex = Math.floor(Math.random() * responses.length);
				this.logger.debug(
					`Enviando resposta aleatória (${randomIndex + 1}/${responses.length}) para o comando *${command.startsWith}*`
				);

				const returnMessage = await this.processCustomCommandResponse(
					bot,
					message,
					responses[randomIndex],
					command,
					group,
					args
				);
				if (returnMessage) {
					if (command.replyInPvivate) {
						returnMessage.chatId = message.author; // ou authorAlt?
					}
					// Adiciona menções do comando
					if (!returnMessage.options) returnMessage.options = {};
					const mentionsSet = new Set(returnMessage.options.mentions || []);

					if (command.mentions && command.mentions.length > 0) {
						command.mentions.forEach((m) => mentionsSet.add(m));
					}

					// Auto-mention do usuário que pediu o comando (apenas em grupos e se não for resposta privada)
					if (message.group && !command.replyInPvivate) {
						const requesterId = message.authorAlt || message.author;
						if (requesterId) mentionsSet.add(requesterId);
					}

					returnMessage.options.mentions = Array.from(mentionsSet);
					if (!silent) await bot.sendReturnMessages(returnMessage, group);
				}
				finalResult = returnMessage;
			}

			// Reage com emoji depois (do comando ou padrão)
			const afterEmoji = command.reactions?.after ?? null;
			if (!silent && !silentReaction) {
				try {
					if (afterEmoji && command.react !== false) {
						message.origin.react(afterEmoji);
					}
				} catch (reactError) {
					this.logger.error('Erro ao aplicar reação "depois":', reactError.message ?? "xxx");
				}
			}

			return finalResult;
		} catch (error) {
			this.logger.error(
				`Erro ao executar comando personalizado ${command.startsWith}:`,
				error.message ?? "xxx"
			);

			const errorEmoji = command.reactions?.error ?? "❌";
			const returnMessage = new ReturnMessage({
				chatId: message.group,
				content: `Erro ao executar comando personalizado: ${command.startsWith}`,
				reaction: !silent && !silentReaction && command.react !== false ? errorEmoji : null
			});
			if (!silent) await bot.sendReturnMessages(returnMessage, group);
			return returnMessage;
		}
	}

	processCustomIgnoresPrefix(textContent, bot, message, group) {
		const command = `${textContent}`;

		//this.logger.debug(`[processCustomIgnoresPrefix][${group.name}] Buscando comando '${command}'`);
		const matchResult = this.findCustomCommand(command, this.customCommands[group.id]);

		if (matchResult) {
			const { customCommand, newArgs } = matchResult;
			this.logger.debug(`[processCustomIgnoresPrefix] `, customCommand);
			this.executeCustomCommand(bot, message, customCommand, newArgs, group);
		}
	}

	/**
	 * Processa uma resposta para um comando personalizado
	 * @param {WhatsAppBot} bot - A instância do bot
	 * @param {Object} message - A mensagem original
	 * @param {string} responseText - O texto da resposta
	 * @param {Object} command - O objeto de comando personalizado
	 * @param {Group} group - O objeto do grupo
	 * @returns {Promise<ReturnMessage|null>} - A mensagem de retorno processada
	 */
	async processCustomCommandResponse(bot, message, responseText, command, group, args) {
		try {
			this.logger.debug(
				`Processando resposta para comando ${command.startsWith}: ${responseText.substring(0, 50)}${responseText.length > 50 ? "..." : ""}`
			);

			// Processa variáveis na resposta
			const options = {};
			const processedResponse = await this.variableProcessor.process(responseText, {
				message,
				group,
				command,
				options,
				bot // Incluindo o bot no contexto para processar variáveis de arquivo
			});

			this.logger.debug(
				`Processando resposta: '${processedResponse}', options ${JSON.stringify(options)}`
			);

			if (
				processedResponse &&
				typeof processedResponse === "object" &&
				processedResponse.type === "embedded-commands"
			) {
				this.logger.info(`Executando comandos embutidos (múltiplos)`);

				try {
					const allResults = [];
					for (let cmdText of processedResponse.commands) {
						const prefix = group.prefix ?? "!";

						// Se o comando já tem um prefixo, usamos ele; senão, usamos o prefixo do grupo
						if (cmdText.startsWith(prefix)) {
							cmdText = cmdText.substring(prefix.length);
						} else if (cmdText.startsWith("!")) {
							// Trata caso especial onde o comando está com prefixo padrão
							cmdText = cmdText.substring(1);
						}

						// Divide o comando em nome e argumentos
						const [embeddedCmd, ...embeddedArgs] = cmdText.trim().split(/\s+/);

						// Executamos o comando silenciosamente
						const result = await this.processCommand(
							bot,
							message,
							embeddedCmd,
							embeddedArgs.concat(args),
							group,
							{ skipCustom: true, silent: true }
						);
						if (result) allResults.push(result);
					}

					return this.aggregateReturnMessages(allResults);
				} catch (embeddedError) {
					this.logger.error(`Erro ao executar comandos embutidos`, embeddedError);
					return null;
				}
			}

			if (
				processedResponse &&
				typeof processedResponse === "object" &&
				processedResponse.type === "embedded-command"
			) {
				this.logger.info(`Executando comando embutido: ${processedResponse.command}`);

				try {
					// Extrai o comando (pode incluir prefixo ou não)
					let cmdText = processedResponse.command;
					const prefix = group.prefix ?? "!";

					// Se o comando já tem um prefixo, usamos ele; senão, usamos o prefixo do grupo
					if (cmdText.startsWith(prefix)) {
						cmdText = cmdText.substring(prefix.length);
					} else if (cmdText.startsWith("!")) {
						// Trata caso especial onde o comando está com prefixo padrão
						cmdText = cmdText.substring(1);
					}

					// Divide o comando em nome e argumentos
					const [embeddedCmd, ...embeddedArgs] = cmdText.trim().split(/\s+/);

					// Executamos o comando
					return await this.processCommand(
						bot,
						message,
						embeddedCmd,
						embeddedArgs.concat(args),
						group,
						{ skipCustom: true }
					);
				} catch (embeddedError) {
					this.logger.error(
						`Erro ao executar comando embutido: ${processedResponse.command}`,
						embeddedError
					);

					return new ReturnMessage({
						chatId: message.group,
						content: `Erro ao executar comando embutido: ${processedResponse.command}`,
						options: {
							quotedMessageId: command.reply ? message.origin.id._serialized : undefined,
							goReply: message.origin,
							...options
						}
					});
				}
			}

			// Verifica se a resposta é um array de objetos MessageMedia (caso de variável {file-pasta/})
			if (processedResponse && Array.isArray(processedResponse)) {
				this.logger.debug(
					`Enviando múltiplas respostas de mídia para comando ${command.startsWith} (via variável file para pasta)`
				);

				// Cria array de ReturnMessages, máximo de 5
				const returnMessages = [];
				for (let i = 0; i < Math.min(processedResponse.length, 5); i++) {
					const mediaItem = processedResponse[i];
					returnMessages.push(
						new ReturnMessage({
							chatId: message.group,
							content: mediaItem.media,
							options: {
								caption: mediaItem.caption,
								quotedMessageId: command.reply ? message.origin.id._serialized : undefined,
								goReply: message.origin,
								...options
							},
							delay: i * 1000 // Adiciona delay de 1 segundo entre mensagens
						})
					);
				}

				return returnMessages;
			}

			// Verifica se a resposta é um objeto MessageMedia (caso de variável {file-...}, api de arquivo como {reddit-})
			console.log(processedResponse, typeof processedResponse);
			if (
				processedResponse &&
				typeof processedResponse === "object" &&
				processedResponse.mimetype
			) {
				this.logger.debug(
					`Enviando resposta de mídia para comando ${command.startsWith} (via variável file)`
				);

				return new ReturnMessage({
					chatId: message.group,
					content: processedResponse,
					options: {
						quotedMessageId: command.reply ? message.origin.id._serialized : undefined,
						goReply: message.origin,
						...options
					}
				});
			}

			// Verifica se é uma resposta de mídia (formato: "{img-filename.png} Legenda\nlegenda 2...")
			const mediaMatch = processedResponse.match(
				/^\{(audio|voice|image|video|gif|document|sticker|stickerGif)-([^}]+)\}\s*(.*)/s
			);

			if (mediaMatch) {
				const [, mediaType, fileName, caption] = mediaMatch;

				// Atualiza caminho para procurar no diretório de mídia
				const mediaPath = path.join(__dirname, "..", "data", "media", fileName);

				this.logger.debug(`Enviando resposta de mídia (${mediaType}): ${mediaPath}`);

				try {
					if (mediaType === "stickerGif") {
						this.logger.debug(`[stickerGif] URL? ${fileName}`);

						return new ReturnMessage({
							chatId: message.group,
							content: fileName,
							options: {
								sendMediaAsSticker: true,
								quotedMessageId: command.reply ? message.origin.id._serialized : undefined,
								goReply: message.origin,
								...options
							}
						});
					} else {
						// Audio 'mpeg' ela acha que é video, enviar customMime
						let customMime = false;
						if (mediaType === "audio") {
							customMime = "audio/mpeg";
						}
						const media = await bot.createMedia(mediaPath, customMime);

						return new ReturnMessage({
							chatId: message.group,
							content: media,
							options: {
								caption: caption ?? undefined,
								sendMediaAsSticker: mediaType === "sticker",
								sendVideoAsGif: mediaType === "gif",
								quotedMessageId: command.reply ? message.origin.id._serialized : undefined,
								goReply: message.origin,
								...options
							}
						});
					}
				} catch (error) {
					this.logger.error(
						`Erro ao enviar resposta de mídia (${mediaPath}):`,
						error.message ?? "xxx"
					);

					return new ReturnMessage({
						chatId: message.group,
						content: `Erro: Não foi possível enviar o arquivo de mídia ${fileName}`
					});
				}
			} else {
				// Resposta de texto
				this.logger.debug(`Enviando resposta de texto para o comando *${command.startsWith}*`);

				return new ReturnMessage({
					chatId: message.group,
					content: processedResponse,
					options: {
						quotedMessageId: command.reply ? message.origin.id._serialized : undefined,
						goReply: message.origin,
						...options
					}
				});
			}
		} catch (error) {
			this.logger.error(
				"Erro ao processar resposta de comando personalizado:",
				error.message ?? "xxx"
			);
			return null;
		}
	}

	/**
	 * Verifica comandos acionados automaticamente (aqueles que não requerem prefixo)
	 * @param {WhatsAppBot} bot - A instância do bot
	 * @param {Object} message - A mensagem formatada
	 * @param {string} text - O texto da mensagem
	 * @param {Group} group - O objeto do grupo
	 */
	async checkAutoTriggeredCommands(bot, message, text, group) {
		try {
			// Pula se não houver comandos personalizados para este grupo
			const customCommandsProcessar = this.customCommands[group.id] ?? [];

			// Verifica se o grupo está pausado
			if (group.paused) {
				//this.logger.info(`Ignorando comandos auto-acionados em grupo pausado: ${group.id}`);
				return;
			}

			//this.logger.debug(`Verificando comandos auto-acionados para o texto: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`);

			// Verifica se interações automáticas estão habilitadas para este grupo
			if (group.interact && group.interact.enabled) {
				// Verifica o último tempo de interação para cooldown
				const now = Date.now();
				const lastInteraction = group.interact.lastInteraction ?? 0;
				let cdMinutos = group.interact.cooldown ?? 60;
				if (cdMinutos < 30) {
					cdMinutos = 30; // Limite 30
				}
				const cooldown = cdMinutos * 60 * 1000; // Converte minutos para milissegundos

				if (now - lastInteraction >= cooldown) {
					// Gera número aleatório entre 1 e 10000
					const randomValue = Math.floor(Math.random() * 10000) + 1;
					let interactionChance = group.interact.chance ?? 100; // Padrão 1% de chance (100/10000)
					if (interactionChance > 500) {
						interactionChance = 500; // Limite 5%
					}

					//this.logger.debug(`Verificação de interação automática: ${randomValue} <= ${interactionChance}`);

					if (randomValue <= interactionChance) {
						// Atualiza último tempo de interação (em memória e no banco)
						group.interact.lastInteraction = now;
						this.database.updateGroupInteract(group.id, group.interact);

						const autoCommands = group.interact.useCmds
							? customCommandsProcessar.filter(
									(cmd) => cmd.active && !cmd.deleted && !cmd.ignoreInteract
								)
							: [];

						// 2 tipos de interação: Um usa o !interagir e outro pega comando custom do grupo
						// Se não tiver custom, sempre usar LLM
						const proporcaoVal =
							group.interact.proporcao !== undefined ? group.interact.proporcao : 50;
						const interagirLLM = autoCommands.length == 0 || Math.random() * 100 < proporcaoVal;
						if (interagirLLM) {
							const interactCommand = this.fixedCommands.getCommand("interagir");
							this.logger.info(`[interagir] Acionando LLM-Interagir`);

							this.executeFixedCommand(bot, message, interactCommand, [false], group, false, true);
							return;
						} else {
							const randomCommand = autoCommands[Math.floor(Math.random() * autoCommands.length)];
							this.logger.info(
								`[interagir] Acionando comando automaticamente: ${randomCommand.startsWith}`
							);

							// Executa o comando
							this.executeCustomCommand(bot, message, randomCommand, [], group, false, true);
							return;
						}
					}
				}
			}

			// Verifica cada comando personalizado
			for (const command of customCommandsProcessar) {
				// Processa apenas comandos com startsWith que não precisam de prefixo
				if (
					command.startsWith &&
					command.ignorePrefix &&
					text.toLowerCase().includes(command.startsWith.toLowerCase())
				) {
					this.logger.debug(`Encontrado comando auto-acionado: ${command.startsWith}`);
					// Executa o comando, mas não espera para evitar bloqueio
					this.executeCustomCommand(bot, message, command, [], group, false, true).catch(
						(error) => {
							this.logger.error(
								`Erro no comando auto-acionado ${command.startsWith}:`,
								error.message ?? "xxx"
							);
						}
					);
					break; // Executa apenas o primeiro comando correspondente
				}
			}

			//this.logger.debug(`Verificação de comando auto-acionado concluída para o grupo ${group.id}`);
		} catch (error) {
			this.logger.error("Erro ao verificar comandos auto-acionados:", error.message ?? "xxx");
		}
	}

	/**
	 * Recarrega comandos de arquivos e banco de dados
	 */
	async reloadCommands() {
		this.logger.info("Recarregando todos os comandos...");

		// Limpa cache de comandos
		this.customCommands = {};
		this.database.clearCache("commands");

		// Recarrega comandos
		await this.loadAllCommands();

		this.logger.info("Todos os comandos recarregados");
	}
}

module.exports = CommandHandler;
