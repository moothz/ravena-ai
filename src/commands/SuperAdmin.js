const fs = require("fs").promises;
const path = require("path");
const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const ReturnMessage = require("../models/ReturnMessage");
const AdminUtils = require("../utils/AdminUtils");
const LLMService = require("../services/LLMService");
const { exec } = require("child_process");

/**
 * Manipula comandos super admin (apenas para admins do sistema)
 */
class SuperAdmin {
	constructor() {
		this.logger = new Logger("superadmin");
		this.adminUtils = AdminUtils.getInstance();
		this.database = Database.getInstance();
		this.llmService = LLMService.getInstance();
		this.dataPath = this.database.databasePath;

		// Lista de superadmins do sistema
		this.superAdmins = process.env.SUPER_ADMINS ? process.env.SUPER_ADMINS.split(",") : [];

		this.logger.info(`SuperAdmin inicializado com ${this.superAdmins.length} administradores`);

		// Mapeamento de comando para método
		this.commandMap = {
			retrospectiva: { method: "endYearMsg", description: "Retrospectiva" },
			testeMsg: { method: "testeMsg", description: "Testar Retorno msg" },
			sendMsg: { method: "sendMsg", description: "Envia mensagem para chatId" },
			joinGrupo: { method: "joinGroup", description: "Entra em um grupo via link de convite" },
			joinGrupoSilencioso: {
				method: "joinGroupSilent",
				description: "Entra em um grupo via link de convite SEM enviar mensagem de boas-vindas"
			},
			modoSilencioso: {
				method: "toggleSilentMode",
				description: "Toggle do modo silencioso global (sem boas-vindas por 30 min)"
			},
			addDonate: { method: "addNewDonate", description: "Adiciona novo donate" },
			addDonateNumero: { method: "addDonorNumber", description: "Adiciona número de um doador" },
			addDonateValor: { method: "updateDonationAmount", description: "Atualiza valor de doação" },
			mergeDonates: { method: "mergeDonors", description: "Une dois doadores em um" },
			block: { method: "blockUser", description: "Bloqueia um usuário" },
			unblock: { method: "unblockUser", description: "Desbloqueia um usuário" },
			leaveGrupo: {
				method: "leaveGroup",
				description: "Sai de um grupo com opção de bloquear membros"
			},
			privacidade: {
				method: "setDefaultPrivacySettings",
				description: "Seta padrões de privacidade"
			},
			foto: { method: "changeProfilePicture", description: "Altera foto de perfil do bot" },
			simular: { method: "simulateStreamEvent", description: "Simula evento de stream" },
			restart: { method: "restartBot", description: "Reinicia o bot" },

			stats: { method: "botStats", description: "Status, grupos" },
			iaStats: { method: "iaStats", description: "Estatísticas de IA (LLM, Comfy, Speech)" },

			getGroupInfo: {
				method: "getGroupInfo",
				description: "Dump de dados de grupo por nome cadastro"
			},
			getMembros: {
				method: "getMembros",
				description: "Lista todos os membros do grupo separados por admin e membros normais"
			},
			blockInvites: { method: "blockInvites", description: "Bloqueia os invites dessa pessoa" },
			unblockInvites: { method: "unblockInvites", description: "Bloqueia os invites dessa pessoa" },
			blockList: {
				method: "blockList",
				description: "Bloqueia todos os contatos recebidos separados por vírgula"
			},
			blockTudoList: {
				method: "blockTudoList",
				description:
					"Sai de todos os grupos em comum com uma lista de pessoas e bloqueia todos os membros"
			},
			unblockList: {
				method: "unblockList",
				description: "Desbloqueia todos os contatos recebidos separados por vírgula"
			},
			listaGruposPessoa: {
				method: "listaGruposPessoa",
				description: "Lista todos os grupos em comum com uma pessoa"
			},
			blockTudoPessoa: {
				method: "blockTudoPessoa",
				description: "Sai de todos os grupos em comum com uma pessoa e bloqueia todos os membros"
			},
			reagir: { method: "reagir", description: "Reage com o emoji informado [debug apenas]" },
			status: { method: "setStatus", description: "Define o status do bot" },
			wol: { method: "wakeOnLan", description: "Envia pacote wake-on-lan na rede" },
			globalStreamRefresh: {
				method: "globalStreamRefresh",
				description: "Reseta a lista de bots ativos/ignorados para transmissões em TODOS os grupos"
			},
			dossie: {
				method: "runDossieAnalysis",
				description: "Trigga análise de dossiê para um grupo"
			},
			addElogio: {
				method: "addElogioSticker",
				description: "Adiciona um sticker de elogio (use em resposta)"
			},
			addXingamento: {
				method: "addXingamentoSticker",
				description: "Adiciona um sticker de xingamento (use em resposta)"
			},
			fixGroupNames: {
				method: "fixGroupNames",
				description: "Escaneia e sugere correção para nomes de grupos (dry run)"
			},
			dumpdbs: {
				method: "dumpDbs",
				description:
					"Força o dump em disco (checkpoint WAL) e roda testes de integridade em todos os bancos de dados"
			},
			removeUserGp: {
				method: "removeUserGp",
				description: "Remove um usuário do grupo: !sa-removeUserGp <grupoJid> <contato>"
			},
			addUserGp: {
				method: "addUserGp",
				description: "Adiciona um usuário ao grupo: !sa-addUserGp <grupoJid> <contato>"
			}
		};

		// Cache temporário para forçar entrada em grupos bloqueados
		this.forceJoinCache = new Map();

		// Timer do modo silencioso global
		this.silentModeTimer = null;
	}

	/**
	 * Obtém o nome do método para um comando super admin
	 * @param {string} command - Nome do comando
	 * @returns {string|null} - Nome do método ou null se não encontrado
	 */
	getCommandMethod(command) {
		return this.commandMap[command]?.method || null;
	}

	/**
	 * Verifica se um usuário é super admin
	 * @param {string} userId - ID do usuário a verificar
	 * @returns {boolean} - True se o usuário for super admin
	 */
	isSuperAdmin(userId) {
		return this.adminUtils.isSuperAdmin(userId);
	}

	isComuAdmin(bot, userId) {
		return this.adminUtils.isComuAdmin(userId, bot);
	}

	async wakeOnLan(bot, message, args) {
		const chatId = message.group ?? message.author;
		try {
			if (!this.isSuperAdmin(message.author)) return;
			if (args[0]) {
				// Mac tem 17 caracteres
				const macAddress = args[0].trim();
				if (macAddress.length === 17) {
					exec(`wakeonlan ${macAddress}`);
					return new ReturnMessage({
						chatId: message.group ?? message.author,
						content: `✅ Sending magic packet to 255.255.255.255:9 with ${macAddress}`
					});
				} else {
					return new ReturnMessage({
						chatId: message.group ?? message.author,
						content: `❌ Mac inválido '${macAddress}' (${macAddress.length})`
					});
				}
			}
		} catch (error) {
			this.logger.error("Erro no comando wakeOnLan:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao processar comando."
			});
		}
	}

	async botStats(bot, message, args) {
		const chatId = message.group ?? message.author;
		try {
			if (!this.isSuperAdmin(message.author) && !this.isComuAdmin(bot, message.author)) return;

			const gruposBot = (await bot.listGroups()) ?? [];
			const groups = await this.database.getGroups();

			const now = Date.now();
			const periods = {
				year: now - 365 * 24 * 60 * 60 * 1000,
				threeMonths: now - 91 * 24 * 60 * 60 * 1000,
				twoMonths: now - 61 * 24 * 60 * 60 * 1000,
				month: now - 30 * 24 * 60 * 60 * 1000,
				week: now - 7 * 24 * 60 * 60 * 1000,
				day: now - 24 * 60 * 60 * 1000,
				hour: now - 60 * 60 * 1000
			};

			// Carrega estatísticas para todos os períodos em paralelo
			const statsPromises = Object.entries(periods).map(async ([key, startDate]) => {
				const stats = await bot.loadReport.getStatistics({
					startDate,
					endDate: now,
					botId: bot.id
				});
				return { key, stats };
			});

			const results = await Promise.all(statsPromises);
			const periodStats = results.reduce((acc, { key, stats }) => {
				acc[key] = stats;
				return acc;
			}, {});

			const formatNum = (num) => (num ?? 0).toLocaleString("pt-BR");

			const header =
				`🤖 *${bot.id}* - Estatísticas\n\n` +
				`📊 *Total Mensagens:*\n` +
				`- 1 Hora: ${formatNum(periodStats.hour.totalMessages)}\n` +
				`- 24 Horas: ${formatNum(periodStats.day.totalMessages)}\n` +
				`- 7 Dias: ${formatNum(periodStats.week.totalMessages)}\n` +
				`- 30 Dias: ${formatNum(periodStats.month.totalMessages)}\n` +
				`- 365 Dias: ${formatNum(periodStats.year.totalMessages)}\n`;

			const groupStats = gruposBot.map((grupo) => {
				const group = groups.find((g) => g.id === grupo.JID);
				const name = group?.name ?? "Sem registro";
				const memberCount = grupo.Participants ? grupo.Participants.length : "?";

				// Coleta stats do grupo para cada período
				const sYear = periodStats.year.byGroup[grupo.JID] ?? 0;
				const sThreeMonths = periodStats.threeMonths.byGroup[grupo.JID] ?? 0;
				const sTwoMonths = periodStats.twoMonths.byGroup[grupo.JID] ?? 0;
				const sMonth = periodStats.month.byGroup[grupo.JID] ?? 0;
				const sWeek = periodStats.week.byGroup[grupo.JID] ?? 0;
				const sDay = periodStats.day.byGroup[grupo.JID] ?? 0;
				const sHour = periodStats.hour.byGroup[grupo.JID] ?? 0;

				return {
					grupo,
					name,
					memberCount,
					sYear,
					sThreeMonths,
					sTwoMonths,
					sMonth,
					sWeek,
					sDay,
					sHour
				};
			});

			// Ordena por mensagens: Hoje > Hora > Semana > Mês > Ano
			groupStats.sort((a, b) => {
				if (b.sDay !== a.sDay) return b.sDay - a.sDay;
				if (b.sHour !== a.sHour) return b.sHour - a.sHour;
				if (b.sWeek !== a.sWeek) return b.sWeek - a.sWeek;
				if (b.sMonth !== a.sMonth) return b.sMonth - a.sMonth;
				return b.sYear - a.sYear;
			});

			const listGroups = groupStats
				.map((item) => {
					const { grupo, name, memberCount, sYear, sMonth, sWeek, sDay, sHour } = item;
					return `- [${name}] ${grupo.Name}: _${memberCount} membros_ (${sDay}/hj, ${sHour}/hr, ${sWeek}/s, ${sMonth}/m, ${sYear}/a)`;
				})
				.join("\n");

			// Categoriza inativos
			const inactive = {
				week: [],
				month: [],
				twoMonths: [],
				threeMonths: []
			};

			groupStats.forEach((item) => {
				if (item.sThreeMonths === 0) {
					inactive.threeMonths.push(item);
				} else if (item.sTwoMonths === 0) {
					inactive.twoMonths.push(item);
				} else if (item.sMonth === 0) {
					inactive.month.push(item);
				} else if (item.sWeek === 0) {
					inactive.week.push(item);
				}
			});

			const formatInactiveList = (list) =>
				list.length > 0
					? list.map((item) => `  • ${item.name} (${item.grupo.Name})`).join("\n")
					: "  _(nenhum)_";

			const inactiveSection =
				`🛑 *Grupos Inativos*\n\n` +
				`*Há +3 meses (${inactive.threeMonths.length}):*\n${formatInactiveList(inactive.threeMonths)}\n\n` +
				`*Há +2 meses (${inactive.twoMonths.length}):*\n${formatInactiveList(inactive.twoMonths)}\n\n` +
				`*Há +1 mês (${inactive.month.length}):*\n${formatInactiveList(inactive.month)}\n\n` +
				`*Há +1 semana (${inactive.week.length}):*\n${formatInactiveList(inactive.week)}`;

			const dadosBot = `${header}\n- *${gruposBot.length} grupos:*
${listGroups}\n\n${inactiveSection}`;

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: dadosBot
			});
		} catch (error) {
			this.logger.error("Erro no comando botStats:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao processar comando."
			});
		}
	}

	async iaStats(bot, message, args) {
		const chatId = message.group ?? message.author;
		try {
			if (!this.isSuperAdmin(message.author)) return;

			const StatsService = require("../services/StatsService");
			const statsService = new StatsService();
			const stats = await statsService.getAllStats();

			const formatNum = (num) => (num ?? 0).toLocaleString("pt-BR");

			let response = "🤖 *Estatísticas de IA*\n\n";

			// LLM Stats
			response += "🧠 *LLM (Grandes Modelos de Linguagem)*\n";
			response += `- Total Requisições: ${formatNum(stats.llm.total_requests)}\n`;
			response += `- Tokens Entrada: ${formatNum(stats.llm.total_input_tokens)}\n`;
			response += `- Tokens Saída: ${formatNum(stats.llm.total_output_tokens)}\n\n`;

			response += "*Por Tipo:*\n";
			for (const [type, data] of Object.entries(stats.llm.by_type)) {
				if (data.requests > 0) {
					response += `- ${type.toUpperCase()}: ${formatNum(data.requests)} reqs (${formatNum(data.input_tokens)} in / ${formatNum(data.output_tokens)} out)\n`;
				}
			}

			response += "\n*Por Provedor:*\n";
			for (const [provider, data] of Object.entries(stats.llm.by_provider)) {
				response += `- ${provider}: ${formatNum(data.requests)} reqs\n`;
			}

			// ComfyUI Stats
			response += "\n🎨 *ComfyUI (Geração de Imagens)*\n";
			response += `- Total Imagens: ${formatNum(stats.comfyui.total_images)}\n`;
			for (const [res, count] of Object.entries(stats.comfyui.by_resolution)) {
				response += `- ${res}: ${formatNum(count)}\n`;
			}

			// Speech Stats
			response += "\n🎙️ *Speech (Voz e Áudio)*\n";
			response += "*TTS (Texto para Voz):*\n";
			response += `- Requisições: ${formatNum(stats.speech.tts.total_requests)}\n`;
			response += `- Caracteres: ${formatNum(stats.speech.tts.total_chars)}\n`;
			response += `- Duração Total: ${formatNum(Math.round(stats.speech.tts.total_duration_sec))}s\n`;
			response += `- Tempo Médio Proc: ${formatNum(Math.round(stats.speech.tts.avg_processing_time_ms))}ms\n\n`;

			response += "*STT (Voz para Texto):*\n";
			response += `- Requisições: ${formatNum(stats.speech.stt.total_requests)}\n`;
			response += `- Caracteres: ${formatNum(stats.speech.stt.total_chars)}\n`;
			response += `- Duração Áudio Total: ${formatNum(Math.round(stats.speech.stt.total_duration_sec))}s\n`;
			response += `- Tempo Médio Proc: ${formatNum(Math.round(stats.speech.stt.avg_processing_time_ms))}ms\n`;

			// Calculate duration
			const getMinTs = async (dbName, table) => {
				try {
					const rows = await this.database.dbAll(
						dbName,
						`SELECT MIN(timestamp) as ts FROM ${table}`
					);
					return rows[0]?.ts ? parseInt(rows[0].ts) : null;
				} catch (e) {
					return null;
				}
			};

			const minTimestamps = await Promise.all([
				getMinTs("llm_stats", "usage_stats"),
				getMinTs("media_stats", "comfy_stats"),
				getMinTs("media_stats", "speech_generation_stats"),
				getMinTs("media_stats", "speech_transcription_stats")
			]);

			const validTs = minTimestamps.filter((ts) => ts !== null && ts > 0);
			let durationText = "unknown period";
			if (validTs.length > 0) {
				const startTs = Math.min(...validTs);
				const now = Date.now();
				const days = Math.max(1, Math.ceil((now - startTs) / (1000 * 60 * 60 * 24)));
				durationText = `${days} days`;
			}

			const prompt = `Please analyze the following AI usage statistics collected over the last ${durationText}:

**LLM Usage:**
- Total Input Tokens: ${stats.llm.total_input_tokens}
- Total Output Tokens: ${stats.llm.total_output_tokens}
- Total Requests: ${stats.llm.total_requests}

**Image Generation:**
- Total Images Generated: ${stats.comfyui.total_images}

**Audio Processing:**
- TTS (Text-to-Speech) Total Duration: ${Math.round(stats.speech.tts.total_duration_sec)} seconds
- STT (Speech-to-Text) Total Duration: ${Math.round(stats.speech.stt.total_duration_sec)} seconds

**Task:**
Provide a cost approximation for this usage if it were billed using the 'gemini-2.5-flash-lite' model pricing for LLM.
For Image and Audio components, please estimate costs based on standard commercial API rates (e.g., typical market rates for image generation and speech processing).
Break down the cost by category and provide a total estimated cost.`;

			return [
				new ReturnMessage({
					chatId,
					content: response
				}),
				new ReturnMessage({
					chatId,
					content: prompt
				})
			];
		} catch (error) {
			this.logger.error("Erro no comando iaStats:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao obter estatísticas de IA."
			});
		}
	}

	async endYearMsg(bot, message, args) {
		const chatId = message.group ?? message.author;
		try {
			if (!this.isSuperAdmin(message.author)) return;

			const filePath = path.join(this.dataPath, "textos", "end-year.txt");
			const fileContent = await fs.readFile(filePath, "utf8");

			bot.sendReturnMessages(
				new ReturnMessage({
					chatId,
					content: fileContent
				})
			);

			bot.sendReturnMessages(
				new ReturnMessage({
					chatId: bot.grupoAvisos,
					content: fileContent
				})
			);

			bot.sendReturnMessages(
				new ReturnMessage({
					chatId: bot.grupoAnuncios,
					content: fileContent
				})
			);
		} catch (error) {
			this.logger.error("Erro no comando endYearMsg:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao processar comando."
			});
		}
	}

	async testeMsg(bot, message, args, group) {
		const chatId = message.group ?? message.author;
		try {
			if (!this.isSuperAdmin(message.author)) return;

			const resMsgValida = await bot.sendReturnMessages(
				new ReturnMessage({
					chatId,
					content: `\`\`\`\n${JSON.stringify(message, null, "  ")}\`\`\``
				}),
				group
			);
		} catch (error) {
			this.logger.error("Erro no comando testeMsg:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao processar comando."
			});
		}
	}

	async sendMsg(bot, message, args, group) {
		try {
			const chatId = message.group ?? message.author;

			// Verifica se o usuário é um super admin
			if (!this.isSuperAdmin(message.author) && !this.isComuAdmin(bot, message.author)) {
				return new ReturnMessage({
					chatId,
					content: "⛔ Apenas super administradores podem usar este comando."
				});
			}

			if (args.length === 0) {
				return new ReturnMessage({
					chatId,
					content:
						"Por favor, forneça um numero e a mensagem. Exemplo: !sa-sendMsg 123456@g.us Mensagem de texto"
				});
			}

			const chatToSend = args[0];
			let msg = "Teste";
			let caption = undefined;

			if (args.length > 1) {
				msg = args.slice(1).join(" ");
			}

			if (msg === "IMAGEM") {
				msg = await bot.createMedia(path.join(this.dataPath, "ravenavip.png"));
				caption = "Legenda para IMAGEM";
			}

			if (msg === "AUDIO") {
				msg = await bot.createMedia(path.join(this.dataPath, "ravena_sample.mp3"));
				caption = "Legenda para AUDIO";
			}

			if (msg === "VIDEO") {
				msg = await bot.createMedia(path.join(this.dataPath, "example-video.mp4"));
				caption = "Legenda para VIDEO";
			}

			try {
				const resMsgValida = await bot.sendReturnMessages(
					new ReturnMessage({
						chatId: chatToSend,
						content: msg,
						caption
					}),
					group
				);

				return new ReturnMessage({
					chatId,
					content: `✅ Enviada msg '${msg}' com sucesso para ${chatToSend};\n${JSON.stringify(resMsgValida, null, "\t")}`
				});
			} catch (error) {
				this.logger.error("Erro ao enviar msg para chat:", error);

				return new ReturnMessage({
					chatId,
					content: `❌ Erro ao enviar msg para chat: ${error.message}`
				});
			}
		} catch (error) {
			this.logger.error("Erro no comando sendMsg:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao processar comando."
			});
		}
	}

	/**
	 * Entra em um grupo via link de convite
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @returns {Promise<ReturnMessage>} - Retorna mensagem de sucesso ou erro
	 */
	async joinGroup(bot, message, args) {
		try {
			const chatId = message.group ?? message.author;

			// Verifica se o usuário é um super admin
			if (!this.isSuperAdmin(message.author) && !this.isComuAdmin(bot, message.author)) {
				return new ReturnMessage({
					chatId,
					content: "⛔ Apenas super administradores podem usar este comando."
				});
			}

			if (args.length === 0) {
				return new ReturnMessage({
					chatId,
					content: "Por favor, forneça um código de convite. Exemplo: !sa-joinGrupo abcd1234"
				});
			}

			// Obtém código de convite
			const inviteCode = args[0];

			// Verifica se está no cache de force join (tentativa repetida em menos de 1 min)
			const forceJoinKey = `${message.author}:${inviteCode}`;
			const isForced = this.forceJoinCache.has(forceJoinKey);

			if (!isForced) {
				// Verifica se o código está bloqueado no banco de dados
				const isBlocked = await this.database.isInviteBlocked(inviteCode, null);
				if (isBlocked) {
					// Adiciona ao cache por 1 minuto
					this.forceJoinCache.set(forceJoinKey, Date.now());
					setTimeout(() => {
						this.forceJoinCache.delete(forceJoinKey);
					}, 60000);

					return new ReturnMessage({
						chatId,
						content: `⚠️ Este código de convite está bloqueado. Use o comando novamente em menos de 1 minuto para forçar a entrada.`
					});
				}
			} else {
				// Limpa o cache após usar
				this.forceJoinCache.delete(forceJoinKey);
			}

			// Obtém dados do autor, se fornecidos
			let authorId = null;
			let authorName = null;

			if (args.length > 1) {
				authorId = args[1];
				// O nome pode conter espaços, então juntamos o resto dos argumentos
				if (args.length > 2) {
					authorName = args.slice(2).join(" ");
				}
			}

			try {
				// Aceita o convite
				const joinResult = await bot.client.acceptInvite(inviteCode);

				if (joinResult.accepted) {
					// Salva os dados do autor que enviou o convite para uso posterior
					if (authorId) {
						await this.database.savePendingJoin(inviteCode, { authorId, authorName });
					}

					// Remove dos convites pendentes se existir
					await this.database.removePendingJoin(inviteCode);

					return new ReturnMessage({
						chatId,
						content: `✅ Entrou com sucesso no grupo com código de convite ${inviteCode}`
					});
				} else {
					const msgErro = joinResult.error ? `\n> ${joinResult.error}` : "";
					return new ReturnMessage({
						chatId,
						content: `❌ Falha ao entrar no grupo com código de convite ${inviteCode}${msgErro}`
					});
				}
			} catch (error) {
				this.logger.error("Erro ao aceitar convite de grupo:", error);

				return new ReturnMessage({
					chatId,
					content: `❌ Erro ao entrar no grupo: ${error.message}`
				});
			}
		} catch (error) {
			this.logger.error("Erro no comando joinGroup:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao processar comando."
			});
		}
	}

	/**
	 * Entra em um grupo via link de convite, SEM enviar mensagem de boas-vindas
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @returns {Promise<ReturnMessage>} - Retorna mensagem de sucesso ou erro
	 */
	async joinGroupSilent(bot, message, args) {
		try {
			const chatId = message.group ?? message.author;

			// Verifica se o usuário é um super admin
			if (!this.isSuperAdmin(message.author) && !this.isComuAdmin(bot, message.author)) {
				return new ReturnMessage({
					chatId,
					content: "⛔ Apenas super administradores podem usar este comando."
				});
			}

			if (args.length === 0) {
				return new ReturnMessage({
					chatId,
					content:
						"Por favor, forneça um código de convite. Exemplo: !sa-joinGrupoSilencioso abcd1234"
				});
			}

			const inviteCode = args[0];

			// Inicializa o set de joins silenciosos no bot (se ainda não existir)
			if (!bot.silentJoinGroups) {
				bot.silentJoinGroups = new Set();
			}

			// Busca as informações do grupo via invite code para obter o JID antes de entrar
			let groupJid = null;
			try {
				const info = await bot.inviteInfo(inviteCode);
				// A resposta tem a estrutura { JID, Name, ... }
				groupJid = info?.JID ?? info?.data?.JID ?? null;
				this.logger.info(
					`[joinGroupSilent] Invite info para '${inviteCode}': JID=${groupJid}, Nome=${info?.Name ?? "?"}`
				);
			} catch (infoError) {
				this.logger.warn(
					`[joinGroupSilent] Não foi possível obter info do invite '${inviteCode}':`,
					infoError
				);
			}

			if (!groupJid) {
				return new ReturnMessage({
					chatId,
					content: `❌ Não foi possível obter o ID do grupo a partir do código de convite '${inviteCode}'. Verifique se o link é válido.`
				});
			}

			// Registra o JID na lista de joins silenciosos ANTES de entrar
			bot.silentJoinGroups.add(groupJid);
			this.logger.info(
				`[joinGroupSilent] Grupo ${groupJid} adicionado à lista de silentJoinGroups. Entrando silenciosamente...`
			);

			try {
				// Aceita o convite
				const joinResult = await bot.client.acceptInvite(inviteCode);

				if (joinResult.accepted) {
					// Remove dos convites pendentes se existir
					await this.database.removePendingJoin(inviteCode);

					return new ReturnMessage({
						chatId,
						content: `✅ Entrou silenciosamente no grupo *${groupJid}* com código de convite ${inviteCode}\n🔇 _Nenhuma mensagem de boas-vindas será enviada._`
					});
				} else {
					// Remove do set pois o join falhou
					bot.silentJoinGroups.delete(groupJid);
					const msgErro = joinResult.error ? `\n> ${joinResult.error}` : "";
					return new ReturnMessage({
						chatId,
						content: `❌ Falha ao entrar no grupo com código de convite ${inviteCode}${msgErro}`
					});
				}
			} catch (error) {
				// Remove do set pois o join falhou
				bot.silentJoinGroups.delete(groupJid);
				this.logger.error("Erro ao aceitar convite de grupo (silencioso):", error);

				return new ReturnMessage({
					chatId,
					content: `❌ Erro ao entrar no grupo: ${error.message}`
				});
			}
		} catch (error) {
			this.logger.error("Erro no comando joinGroupSilent:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao processar comando."
			});
		}
	}

	/**
	 * Toggle do modo silencioso global do bot (sem mensagens de boas-vindas por 30 min)
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @returns {Promise<ReturnMessage>} - Retorna mensagem de status
	 */
	async toggleSilentMode(bot, message) {
		const chatId = message.group ?? message.author;

		if (!this.isSuperAdmin(message.author)) {
			return new ReturnMessage({
				chatId,
				content: "⛔ Apenas super administradores podem usar este comando."
			});
		}

		const SILENT_DURATION_MS = 30 * 60 * 1000; // 30 minutos

		if (bot.joinSilencioso) {
			// Já está ativo — toggle para OFF
			bot.joinSilencioso = false;
			if (this.silentModeTimer) {
				clearTimeout(this.silentModeTimer);
				this.silentModeTimer = null;
			}
			this.logger.info(
				`[toggleSilentMode] Modo silencioso global DESATIVADO para o bot '${bot.id}'.`
			);
			return new ReturnMessage({
				chatId,
				content: `🔊 Modo silencioso *desativado*. O bot voltará a enviar mensagens de boas-vindas normalmente.`
			});
		} else {
			// Estava OFF — ativa por 30 minutos
			bot.joinSilencioso = true;
			this.logger.info(
				`[toggleSilentMode] Modo silencioso global ATIVADO para o bot '${bot.id}' por 30 minutos.`
			);

			// Cancela timer anterior se houver (não deveria, mas por segurança)
			if (this.silentModeTimer) {
				clearTimeout(this.silentModeTimer);
			}

			this.silentModeTimer = setTimeout(() => {
				bot.joinSilencioso = false;
				this.silentModeTimer = null;
				this.logger.info(
					`[toggleSilentMode] Modo silencioso global EXPIROU automaticamente para o bot '${bot.id}'.`
				);
				// Notifica o chat que o modo expirou
				bot
					.sendMessage(
						chatId,
						`🔊 Modo silencioso *expirou* automaticamente. O bot voltará a enviar mensagens de boas-vindas normalmente.`
					)
					.catch(() => {});
			}, SILENT_DURATION_MS);

			const expiraEm = new Date(Date.now() + SILENT_DURATION_MS).toLocaleTimeString("pt-BR", {
				hour: "2-digit",
				minute: "2-digit"
			});

			return new ReturnMessage({
				chatId,
				content: `🔇 Modo silencioso *ativado* por 30 minutos (expira às ${expiraEm}).\n\nO bot *não* enviará mensagens de boas-vindas ao entrar em grupos. Use o comando novamente para desativar antes do tempo.`
			});
		}
	}

	formatPhoneNumber(phone) {
		// Ensure only digits
		const digits = phone.replace(/\D/g, "");

		// Match and format
		const match = digits.match(/^(\d{2})(\d{2})(\d{5})(\d{4})$/);
		if (!match) return "Invalid number";

		const [, country, area, part1, part2] = match;
		return `+${country} (${area}) ${part1}-${part2}`;
	}

	/**
	 * Adiciona novo doador na lista
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @returns {Promise<ReturnMessage>} - Retorna mensagem de sucesso ou erro
	 */
	async addNewDonate(bot, message, args) {
		try {
			const chatId = message.group ?? message.author;

			// Verifica se o usuário é um super admin
			if (!this.isSuperAdmin(message.author)) {
				return new ReturnMessage({
					chatId,
					content: "⛔ Apenas super administradores podem usar este comando."
				});
			}

			if (args.length < 2) {
				return new ReturnMessage({
					chatId,
					content:
						"Por favor, forneça um número e nome do doador. Exemplo: !sa-addDonate 5512345678901 João Silva"
				});
			}

			// Extrai número e nome
			const numero = args[0].replace(/\D/g, ""); // Remove não-dígitos
			const donorName = args.slice(1).join(" ");

			if (!numero || numero.length < 10) {
				return new ReturnMessage({
					chatId,
					content: "Por favor, forneça um número válido com código de país. Exemplo: 5512345678901"
				});
			}

			// Atualiza número do doador no banco de dados
			const success = await this.database.addDonation(donorName, 0, numero);

			if (success) {
				bot.whitelist.push(numero);

				return [
					new ReturnMessage({
						chatId,
						content: `✅ ${donorName}, ${numero} adicionado com sucesso à lista!`
					})
				];
			} else {
				return new ReturnMessage({
					chatId,
					content: `❌ Falha ao atualizar doador.`
				});
			}
		} catch (error) {
			this.logger.error("Erro no comando addNewDonate:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao processar comando."
			});
		}
	}

	/**
	 * Adiciona ou atualiza o número de WhatsApp de um doador
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @returns {Promise<ReturnMessage>} - Retorna mensagem de sucesso ou erro
	 */
	async addDonorNumber(bot, message, args) {
		try {
			const chatId = message.group ?? message.author;

			// Verifica se o usuário é um super admin
			if (!this.isSuperAdmin(message.author)) {
				return new ReturnMessage({
					chatId,
					content: "⛔ Apenas super administradores podem usar este comando."
				});
			}

			if (args.length < 2) {
				return new ReturnMessage({
					chatId,
					content:
						"Por favor, forneça um número e nome do doador. Exemplo: !sa-addDonateNumero 5512345678901 João Silva"
				});
			}

			// Extrai número e nome
			const numero = args[0].replace(/\D/g, ""); // Remove não-dígitos
			const donorName = args.slice(1).join(" ");

			if (!numero || numero.length < 10) {
				return new ReturnMessage({
					chatId,
					content: "Por favor, forneça um número válido com código de país. Exemplo: 5512345678901"
				});
			}

			// Atualiza número do doador no banco de dados
			const success = await this.database.updateDonorNumber(donorName, numero);

			if (success) {
				// Pega contato do doador e envia junto pra poder add
				let cttDonate = await bot.createContact(numero);

				if (!cttDonate) {
					cttDonate = `${donorName} apoiador ${bot.nomeExibir || "ravenabot"}`;
				}

				this.logger.debug("[cttDonate]", cttDonate);

				return [
					new ReturnMessage({
						chatId,
						content: `✅ Número ${numero} adicionado com sucesso ao doador ${donorName}`
					}),
					new ReturnMessage({
						chatId,
						content: cttDonate
					})
				];
			} else {
				return new ReturnMessage({
					chatId,
					content: `❌ Falha ao atualizar doador. Certifique-se que ${donorName} existe no banco de dados de doações.`
				});
			}
		} catch (error) {
			this.logger.error("Erro no comando addDonorNumber:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao processar comando."
			});
		}
	}

	/**
	 * Une dois doadores
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async mergeDonors(bot, message, args, group) {
		try {
			if (!this.isSuperAdmin(message.author)) return;
			const chatId = message.group ?? message.author;

			// Obtém o texto completo do argumento
			const fullText = args.join(" ");

			if (!fullText.includes("##")) {
				return new ReturnMessage({
					chatId,
					content: "Por favor, use o formato: !g-mergeDonates PrimeiroDoador##SegundoDoador"
				});
			}

			// Divide os nomes
			const [targetName, sourceName] = fullText.split("##").map((name) => name.trim());

			if (!targetName || !sourceName) {
				return new ReturnMessage({
					chatId,
					content:
						"Ambos os nomes de doadores devem ser fornecidos. Formato: !g-mergeDonates PrimeiroDoador##SegundoDoador"
				});
			}

			// Une doadores no banco de dados
			const success = await this.database.mergeDonors(targetName, sourceName);

			if (success) {
				return new ReturnMessage({
					chatId,
					content: `Doador ${sourceName} unido com sucesso a ${targetName}`
				});
			} else {
				return new ReturnMessage({
					chatId,
					content: `Falha ao unir doadores. Certifique-se que tanto ${targetName} quanto ${sourceName} existem no banco de dados de doações.`
				});
			}
		} catch (error) {
			this.logger.error("Erro no comando mergeDonors:", error);
			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "Erro ao processar comando."
			});
		}
	}

	/**
	 * Atualiza valor de doação para um doador
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @returns {Promise<ReturnMessage>} - Retorna mensagem de sucesso ou erro
	 */
	async updateDonationAmount(bot, message, args) {
		try {
			const chatId = message.group ?? message.author;

			// Verifica se o usuário é um super admin
			if (!this.isSuperAdmin(message.author)) {
				return new ReturnMessage({
					chatId,
					content: "⛔ Apenas super administradores podem usar este comando."
				});
			}

			if (args.length < 2) {
				return new ReturnMessage({
					chatId,
					content:
						"Por favor, forneça um valor e nome do doador. Exemplo: !sa-addDonateValor 50.5 João Silva"
				});
			}

			// Extrai valor e nome
			const amountStr = args[0].replace(",", "."); // Trata vírgula como separador decimal
			const amount = parseFloat(amountStr);
			const donorName = args.slice(1).join(" ");

			if (isNaN(amount)) {
				return new ReturnMessage({
					chatId,
					content: "Por favor, forneça um valor válido. Exemplo: 50.5"
				});
			}

			// Atualiza valor de doação no banco de dados
			const success = await this.database.updateDonationAmount(donorName, amount);

			if (success) {
				return new ReturnMessage({
					chatId,
					content: `✅ ${amount >= 0 ? "Adicionado" : "Subtraído"} ${Math.abs(amount).toFixed(2)} com sucesso ao doador ${donorName}`
				});
			} else {
				return new ReturnMessage({
					chatId,
					content: `❌ Falha ao atualizar doação. Certifique-se que ${donorName} existe no banco de dados de doações.`
				});
			}
		} catch (error) {
			this.logger.error("Erro no comando updateDonationAmount:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao processar comando."
			});
		}
	}

	async removeFromSpecialGroups(bot, phoneNumber, specialGroups = [], message) {
		if (!this.isSuperAdmin(message.author)) return;

		const results = {
			successes: 0,
			failures: 0,
			details: []
		};

		for (const groupId of specialGroups) {
			try {
				const chat = await bot.client.getChatById(groupId);

				// Verifica se o contato está no grupo
				if (chat) {
					this.logger.debug(`[removeFromSpecialGroups] `, { phoneNumber, chat });

					const isInGroup = chat.participants?.some((p) => p.id._serialized === phoneNumber);

					if (isInGroup) {
						// Remove a pessoa do grupo
						await chat.removeParticipants([phoneNumber]);
						results.successes++;
						results.details.push({
							groupId,
							groupName: chat.name,
							status: "success"
						});
					} else {
						results.details.push({
							groupId,
							groupName: chat.name,
							status: "not_present"
						});
					}
				}
			} catch (error) {
				this.logger.error(`Erro ao remover ${phoneNumber} do grupo especial ${groupId}:`, error);
				results.failures++;
				results.details.push({
					groupId,
					error: error.message,
					status: "error"
				});
			}
		}

		return results;
	}

	/**
	 * Bloqueia convites de um usuário
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @returns {Promise<ReturnMessage>} - Retorna mensagem de sucesso ou erro
	 */
	async blockInvites(bot, message, args) {
		const chatId = message.group ?? message.author;

		// Verifica se o usuário é um super admin
		if (!this.isSuperAdmin(message.author) && !this.isComuAdmin(bot, message.author)) {
			return new ReturnMessage({
				chatId,
				content: "⛔ Apenas super administradores podem usar este comando."
			});
		}

		if (args.length === 0) {
			return new ReturnMessage({
				chatId,
				content:
					"Por favor, forneça um número de telefone para bloquear. Exemplo: !sa-blockInvites +5511999999999 [inviteCode]"
			});
		}

		// Processa o número para formato padrão (apenas dígitos)
		let phoneNumber = args[0].replace(/\D/g, "");
		phoneNumber = phoneNumber.split("@")[0];

		const blockedList = new Set();
		if (phoneNumber) blockedList.add(phoneNumber);

		const inviteCode = args[1];
		let inviteInfoData = null;

		if (inviteCode) {
			try {
				const infoResponse = await bot.client.getInviteInfo(inviteCode);
				if (infoResponse) {
					inviteInfoData = infoResponse;

					const addId = (id) => {
						if (!id) return;
						const cleanId = id.split("@")[0];
						if (cleanId) blockedList.add(cleanId);
					};

					addId(inviteInfoData.JID);
					addId(inviteInfoData.OwnerJID);
					addId(inviteInfoData.OwnerPN);

					if (Array.isArray(inviteInfoData.Participants)) {
						for (const p of inviteInfoData.Participants) {
							addId(p.JID);
							addId(p.PhoneNumber);
							addId(p.LID);
						}
					}
				}
			} catch (error) {
				this.logger.error("Erro ao obter info do invite no blockInvites:", error);
			}
		}

		const results = [];
		for (const id of blockedList) {
			await this.database.toggleUserInvites(id, true);
			results.push(id);
		}

		// Adicionalmente bloqueia o invite code e o JID do grupo se disponíveis
		if (inviteCode && inviteInfoData?.JID) {
			await this.database.saveBlockedInvite(inviteCode, inviteInfoData.JID);
		}

		let response = `✅ Bloqueio de convites realizado para ${results.length} identificadores:\n- ${results.join("\n- ")}`;

		if (inviteInfoData) {
			response += `\n\n📦 *Invite Info:*\n\`\`\`json\n${JSON.stringify(inviteInfoData, null, 2)}\n\`\`\``;
		}

		return new ReturnMessage({
			chatId,
			content: response
		});
	}

	/**
	 * Desbloqueia convites de um usuário
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @returns {Promise<ReturnMessage>} - Retorna mensagem de sucesso ou erro
	 */
	async unblockInvites(bot, message, args) {
		const chatId = message.group ?? message.author;

		// Verifica se o usuário é um super admin
		if (!this.isSuperAdmin(message.author) && !this.isComuAdmin(bot, message.author)) {
			return new ReturnMessage({
				chatId,
				content: "⛔ Apenas super administradores podem usar este comando."
			});
		}

		if (args.length === 0) {
			return new ReturnMessage({
				chatId,
				content:
					"Por favor, forneça um número de telefone para desbloquear. Exemplo: !sa-unblock +5511999999999"
			});
		}

		// Processa o número para formato padrão (apenas dígitos)
		let phoneNumber = args.join(" ").replace(/\D/g, "");
		phoneNumber = phoneNumber.split("@")[0];

		await this.database.toggleUserInvites(phoneNumber, false);

		return new ReturnMessage({
			chatId,
			content: `✅ Convites do número ${phoneNumber} desbloqueados com sucesso.`
		});
	}

	/**
	 * Bloqueia um usuário
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @returns {Promise<ReturnMessage>} - Retorna mensagem de sucesso ou erro
	 */
	async blockUser(bot, message, args) {
		try {
			const chatId = message.group ?? message.author;

			// Verifica se o usuário é um super admin
			if (!this.isSuperAdmin(message.author) && !this.isComuAdmin(bot, message.author)) {
				return new ReturnMessage({
					chatId,
					content: "⛔ Apenas super administradores podem usar este comando."
				});
			}

			let mode = "both";
			let numberArgs = args;
			if (args[0] === "local" || args[0] === "whats") {
				mode = args[0];
				numberArgs = args.slice(1);
			}

			if (numberArgs.length === 0) {
				return new ReturnMessage({
					chatId,
					content:
						"Por favor, forneça um número de telefone para bloquear. Exemplo: !sa-block " +
						(mode !== "both" ? mode + " " : "") +
						"+5511999999999"
				});
			}

			// Processa o número para formato padrão (apenas dígitos)
			let phoneNumber = numberArgs.join(" ").replace(/\D/g, "");

			// Se o número não tiver o formato @c.us, adicione
			if (!phoneNumber.includes("@")) {
				phoneNumber = `${phoneNumber}@c.us`;
			}

			// Grupos especiais que não devem ser deixados, apenas remover a pessoa
			const specialGroups = [];

			// Adicionar grupos especiais se estiverem definidos
			if (bot.grupoInteracao) specialGroups.push(bot.grupoInteracao);
			if (bot.grupoAvisos) specialGroups.push(bot.grupoAvisos);
			if (bot.grupoAnuncios) specialGroups.push(bot.grupoAnuncios);

			try {
				// Tenta remover o contato de grupos especiais primeiro
				let removeResults = {};
				if (specialGroups.length > 0 && (mode === "both" || mode === "whats")) {
					removeResults = await this.removeFromSpecialGroups(
						bot,
						phoneNumber,
						specialGroups,
						message
					);
					this.logger.info(
						`Resultados da remoção de grupos especiais: ${JSON.stringify(removeResults)}`
					);
				}

				let apiStatus = "";
				let localStatus = "";

				// 1. Tenta bloquear o contato na API externa
				if (mode === "both" || mode === "whats") {
					try {
						const contatoBloquear = await bot.client.getContactById(phoneNumber);
						await contatoBloquear.block();
						apiStatus = "✅ API (Sucesso)";
					} catch (blockError) {
						this.logger.error("Erro ao bloquear contato na API:", blockError);
						apiStatus = `❌ API (${blockError.message})`;
					}
				} else {
					apiStatus = "⏭️ API (Ignorado)";
				}

				// 2. Tenta bloquear o contato localmente
				if (mode === "both" || mode === "local") {
					try {
						const pnClean = phoneNumber.split("@")[0];
						await this.database.addLocalBlock(pnClean);
						localStatus = "✅ Local (Sucesso)";
					} catch (localError) {
						this.logger.error("Erro ao bloquear contato localmente:", localError);
						localStatus = `❌ Local (${localError.message})`;
					}
				} else {
					localStatus = "⏭️ Local (Ignorado)";
				}

				// Cria a resposta
				const responseMessage = `*Resultado do Bloqueio:*\n- ${apiStatus}\n- ${localStatus}\n\nContato: ${phoneNumber}\n${Object.keys(removeResults).length > 0 ? `Remoções: ${JSON.stringify(removeResults)}` : ""}`;

				return new ReturnMessage({
					chatId,
					content: responseMessage
				});
			} catch (err) {
				this.logger.error("Erro ao processar bloqueio:", err);
				return new ReturnMessage({
					chatId,
					content: `❌ Erro inesperado ao bloquear contato: ${err.message}`
				});
			}
		} catch (error) {
			this.logger.error("Erro no comando blockUser:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao processar comando."
			});
		}
	}

	/**
	 * Desbloqueia um usuário
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @returns {Promise<ReturnMessage>} - Retorna mensagem de sucesso ou erro
	 */
	async unblockUser(bot, message, args) {
		try {
			const chatId = message.group ?? message.author;

			// Verifica se o usuário é um super admin
			if (!this.isSuperAdmin(message.author) && !this.isComuAdmin(bot, message.author)) {
				return new ReturnMessage({
					chatId,
					content: "⛔ Apenas super administradores podem usar este comando."
				});
			}

			let mode = "both";
			let numberArgs = args;
			if (args[0] === "local" || args[0] === "whats") {
				mode = args[0];
				numberArgs = args.slice(1);
			}

			if (numberArgs.length === 0) {
				return new ReturnMessage({
					chatId,
					content:
						"Por favor, forneça um número de telefone para desbloquear. Exemplo: !sa-unblock " +
						(mode !== "both" ? mode + " " : "") +
						"+5511999999999"
				});
			}

			// Processa o número para formato padrão (apenas dígitos)
			let phoneNumber = numberArgs.join(" ").replace(/\D/g, "");

			// Se o número não tiver o formato @c.us, adicione
			if (!phoneNumber.includes("@")) {
				phoneNumber = `${phoneNumber}@c.us`;
			}

			try {
				let apiStatus = "";
				let localStatus = "";

				// 1. Tenta desbloquear o contato na API externa
				let contact = null;
				if (mode === "both" || mode === "whats") {
					try {
						contact = await bot.client.getContactById(phoneNumber);
						await contact.unblock();
						apiStatus = "✅ API (Sucesso)";
					} catch (unblockError) {
						this.logger.error("Erro ao desbloquear contato na API:", unblockError);
						apiStatus = `❌ API (${unblockError.message})`;
					}
				} else {
					apiStatus = "⏭️ API (Ignorado)";
				}

				// 2. Tenta desbloquear o contato localmente
				if (mode === "both" || mode === "local") {
					try {
						const pnClean = phoneNumber.split("@")[0];
						await this.database.removeLocalBlock(pnClean);
						if (!contact && (mode === "both" || mode === "local")) {
							try {
								contact = await bot.client.getContactById(phoneNumber);
							} catch (e) {}
						}
						if (contact && contact.lid) {
							const lidClean = contact.lid.split("@")[0];
							if (lidClean && lidClean !== pnClean) {
								await this.database.removeLocalBlock(lidClean);
							}
						}
						localStatus = "✅ Local (Sucesso)";
					} catch (localError) {
						this.logger.error("Erro ao desbloquear contato localmente:", localError);
						localStatus = `❌ Local (${localError.message})`;
					}
				} else {
					localStatus = "⏭️ Local (Ignorado)";
				}

				// Cria a resposta
				const responseMessage = `*Resultado do Desbloqueio:*\n- ${apiStatus}\n- ${localStatus}\n\nContato: ${phoneNumber}`;

				return new ReturnMessage({
					chatId,
					content: responseMessage
				});
			} catch (err) {
				this.logger.error("Erro ao processar desbloqueio:", err);
				return new ReturnMessage({
					chatId,
					content: `❌ Erro inesperado ao desbloquear contato: ${err.message}`
				});
			}
		} catch (error) {
			this.logger.error("Erro no comando unblockUser:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao processar comando."
			});
		}
	}

	/**
	 * Versão melhorada do comando leaveGroup com lista de bloqueio
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @returns {Promise<ReturnMessage>} - Retorna mensagem de sucesso ou erro
	 */
	async leaveGroup(bot, message, args) {
		try {
			const chatId = message.group ?? message.author;

			// Verifica se o usuário é um super admin
			if (!this.isSuperAdmin(message.author) && !this.isComuAdmin(bot, message.author)) {
				return new ReturnMessage({
					chatId,
					content: "⛔ Apenas super administradores podem usar este comando."
				});
			}

			if (args.length === 0 && !message.group) {
				return new ReturnMessage({
					chatId,
					content:
						"Por favor, forneça o ID do grupo ou execute o comando dentro de um grupo. Exemplo: !sa-leaveGrupo 123456789@g.us ou !sa-leaveGrupo nomeGrupo"
				});
			}

			const groupIdentifier = args.length > 0 ? args[0] : message.group;
			let groupId;

			// Verifica se o formato é um ID de grupo
			if (groupIdentifier.includes("@g.us")) {
				groupId = groupIdentifier;
			} else if (message.group) {
				groupId = message.group;
			} else {
				// Busca o grupo pelo nome
				const groups = await this.database.getGroups();
				const group = groups.find(
					(g) => g.name.trim().toLowerCase() === groupIdentifier.trim().toLowerCase()
				);

				if (!group) {
					return new ReturnMessage({
						chatId,
						content: `❌ Grupo '${groupIdentifier}' não encontrado no banco de dados.`
					});
				}

				groupId = group.id;
			}

			try {
				// Obtém o chat do grupo
				const chat = await bot.client.getChatById(groupId);

				if (!chat.isGroup) {
					return new ReturnMessage({
						chatId,
						content: `O ID fornecido (${groupId}) não corresponde a um grupo.`
					});
				}

				// Obtém participantes do grupo
				const participants = chat.participants ?? [];

				// Separa administradores e membros normais
				const admins = [];
				const members = [];
				const adminsLid = [];
				const membersLid = [];

				// Prepara verificação do número do bot (últimos 8 dígitos)
				const botPhoneClean = bot.phoneNumber ? bot.phoneNumber.replace(/\D/g, "") : "";
				const botPhoneLast8 = botPhoneClean.length >= 8 ? botPhoneClean.slice(-8) : botPhoneClean;

				for (const participant of participants) {
					const lid = participant.lid ?? participant.id._serialized;
					const pn = participant.phoneNumber;

					// Verifica se é o próprio bot
					if (pn && botPhoneLast8) {
						const pnClean = pn.split("@")[0].replace(/\D/g, "");
						// Se for o bot, pula para não adicionar nas listas de bloqueio
						if (pnClean.endsWith(botPhoneLast8)) {
							this.logger.info(`[leaveGroup] Ignorando bot na lista de bloqueio: ${pn}`);
							continue;
						}
					}

					if (participant.isAdmin || participant.isSuperAdmin) {
						if (pn) admins.push(pn.split("@")[0]);
						adminsLid.push(lid);
					} else {
						if (pn) members.push(pn.split("@")[0]);
						membersLid.push(lid);
					}
				}

				// Constrói os comandos de bloqueio
				const blockAdminsCmd = `!sa-blockList ${admins.join(", ")}\n!sa-blockList ${adminsLid.join(", ")}`;
				const blockMembersCmd = `!sa-blockList ${members.join(", ")}\n!sa-blockList ${membersLid.join(", ")}`;

				// Envia mensagem de despedida para o grupo
				//await bot.sendMessage(groupId, '👋 Saindo do grupo por comando administrativo. Até mais!');

				// Tenta sair do grupo
				await bot.client.leaveGroup(groupId);

				// Prepara mensagem de retorno com comandos de bloqueio
				let responseMessage = `✅ Bot saiu do grupo ${chat.name} (${groupId}) com sucesso.\n\n`;
				responseMessage += `*Para bloquear administradores:*\n${blockAdminsCmd}\n\n`;
				responseMessage += `*Para bloquear demais membros:*\n${blockMembersCmd}`;

				return new ReturnMessage({
					chatId,
					content: responseMessage
				});
			} catch (leaveError) {
				this.logger.error("Erro ao sair do grupo:", leaveError);

				return new ReturnMessage({
					chatId,
					content: `❌ Erro ao sair do grupo: ${leaveError.message}`
				});
			}
		} catch (error) {
			this.logger.error("Erro no comando leaveGroup:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao processar comando."
			});
		}
	}

	/**
	 * Coloca as configs de privacidade no padrão do bot
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @returns {Promise<ReturnMessage>} - Retorna mensagem de sucesso ou erro
	 */
	async setDefaultPrivacySettings(bot, message, args) {
		try {
			const chatId = message.group ?? message.author;

			// Verifica se o usuário é um super admin
			if (!this.isSuperAdmin(message.author)) {
				return new ReturnMessage({
					chatId,
					content: "⛔ Apenas super administradores podem usar este comando."
				});
			}

			try {
				// Obtém a mídia da mensagem
				const media = message.content;

				// Altera as configs
				const privacySettings = {
					readreceipts: "all",
					profile: "all",
					status: "all",
					online: "all",
					last: "all",
					groupadd: "contact_blacklist"
				};
				await bot.client.setPrivacySettings(privacySettings);

				return new ReturnMessage({
					chatId,
					content: `✅ Configs de privacidade no defualt!\n${JSON.stringify(privacySettings, null, "\t")}`
				});
			} catch (privacyError) {
				this.logger.error("Erro ao definir configs de privacidade:", privacyError);

				return new ReturnMessage({
					chatId,
					content: `❌ Erro ao definir configs de privacidade: ${privacyError.message}`
				});
			}
		} catch (error) {
			this.logger.error("Erro no comando setDefaultPrivacySettings:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao processar comando."
			});
		}
	}

	/**
	 * Altera a foto de perfil do bot
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @returns {Promise<ReturnMessage>} - Retorna mensagem de sucesso ou erro
	 */
	async changeProfilePicture(bot, message, args) {
		try {
			const chatId = message.group ?? message.author;

			// Verifica se o usuário é um super admin
			if (!this.isSuperAdmin(message.author) && !this.isComuAdmin(bot, message.author)) {
				return new ReturnMessage({
					chatId,
					content: "⛔ Apenas super administradores podem usar este comando."
				});
			}

			// Verifica se a mensagem contém uma imagem
			if (message.type !== "image") {
				return new ReturnMessage({
					chatId,
					content: "❌ Este comando deve ser usado como legenda de uma imagem."
				});
			}

			try {
				// Obtém a mídia da mensagem
				const media = message.content;

				// Altera a foto de perfil
				await bot.client.setProfilePicture(media);

				return new ReturnMessage({
					chatId,
					content: "✅ Foto de perfil alterada com sucesso!"
				});
			} catch (pictureError) {
				this.logger.error("Erro ao alterar foto de perfil:", pictureError);

				return new ReturnMessage({
					chatId,
					content: `❌ Erro ao alterar foto de perfil: ${pictureError.message}`
				});
			}
		} catch (error) {
			this.logger.error("Erro no comando changeProfilePicture:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao processar comando."
			});
		}
	}

	/**
	 * Pra testar reacts
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @returns {Promise<ReturnMessage>} - Retorna mensagem de sucesso ou erro
	 */
	async reagir(bot, message, args) {
		if (!this.isSuperAdmin(message.author) && !this.isComuAdmin(bot, message.author)) {
			return;
		}

		try {
			const chatId = message.group ?? message.author;

			try {
				const emoji = args[0] ?? "✅";
				await message.origin.react(emoji);
			} catch (e) {
				this.logger.error("Erro ao reagir:", e);
			}
		} catch (error) {
			this.logger.error("Erro no comando reagir:", error);
		}
	}

	/**
	 * Pra testar status
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @returns {Promise<ReturnMessage>} - Retorna mensagem de sucesso ou erro
	 */
	async setStatus(bot, message, args) {
		if (!this.isSuperAdmin(message.author) && !this.isComuAdmin(bot, message.author)) {
			return;
		}

		try {
			const chatId = message.group ?? message.author;

			try {
				bot.updateProfileStatus(args.join(" "));
			} catch (e) {
				this.logger.error("Erro ao definir status:", e);
			}
		} catch (error) {
			this.logger.error("Erro no comando status:", error);
		}
	}

	/**
	 * Simula um evento de stream online/offline
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @returns {Promise<ReturnMessage>} - Retorna mensagem de sucesso ou erro
	 */
	async simulateStreamEvent(bot, message, args) {
		try {
			const chatId = message.group ?? message.author;

			// Verifica se o usuário é um super admin
			if (!this.isSuperAdmin(message.author)) {
				return new ReturnMessage({
					chatId,
					content: "⛔ Apenas super administradores podem usar este comando."
				});
			}

			if (args.length < 3) {
				return new ReturnMessage({
					chatId,
					content:
						"Por favor, forneça a plataforma, o nome do canal e o estado. Exemplo: !sa-simular twitch canal_teste on [vidYoutube]"
				});
			}

			// Extrai argumentos
			const platform = args[0].toLowerCase();
			const channelName = args[1].toLowerCase();
			const state = args[2].toLowerCase();

			// Verifica se a plataforma é válida
			if (!["twitch", "kick", "youtube"].includes(platform)) {
				return new ReturnMessage({
					chatId,
					content: `Plataforma inválida: ${platform}. Use 'twitch', 'kick' ou 'youtube'.`
				});
			}

			// Verifica se o estado é válido
			if (!["on", "off"].includes(state)) {
				return new ReturnMessage({
					chatId,
					content: `Estado inválido: ${state}. Use 'on' ou 'off'.`
				});
			}

			// Verifica se o StreamMonitor está disponível
			if (!bot.streamMonitor) {
				return new ReturnMessage({
					chatId,
					content: "❌ StreamMonitor não está inicializado no bot."
				});
			}

			// Preparar dados do evento
			const now = new Date();
			const eventData = {
				platform,
				channelName,
				title: state === "on" ? `${channelName} fazendo stream simulada em ${platform}` : null,
				game: state === "on" ? "Jogo Simulado Fantástico" : null,
				startedAt: now.toISOString(),
				viewerCount: Math.floor(Math.random() * 1000) + 1
			};

			// Adicionar dados específicos para cada plataforma
			if (platform === "twitch") {
				eventData.title = `${channelName} jogando ao vivo em uma simulação épica!`;
				eventData.game = "Super Simulator 2025";
			} else if (platform === "kick") {
				eventData.title = `LIVE de ${channelName} na maior simulação de todos os tempos!`;
				eventData.game = "Kick Streaming Simulator";
			} else if (platform === "youtube") {
				eventData.title = `Não acredite nos seus olhos! ${channelName} ao vivo agora!`;
				eventData.url = `https://youtube.com/watch?v=simulado${Math.floor(Math.random() * 10000)}`;
				eventData.videoId = args[3] ?? `simulado${Math.floor(Math.random() * 10000)}`;
			}

			// Adicionar thumbnail simulada
			const mediaPath = path.join(this.database.databasePath, "simulado-live.jpg");
			try {
				if (platform === "youtube") {
					eventData.thumbnail = `https://i.ytimg.com/vi/${eventData.videoId}/maxresdefault.jpg`;
				} else {
					const stats = await fs.stat(mediaPath);
					if (stats.isFile()) {
						//eventData.thumbnail = `data:image/jpeg;base64,simulado`;
						eventData.thumbnail = `https://cdn.m7g.twitch.tv/ba46b4e5e395b11efd34/assets/uploads/generic-email-header-1.jpg?w=1200&h=630&fm=jpg&auto=format`;
					}
				}
			} catch (error) {
				this.logger.warn(`Arquivo simulado-live.jpg não encontrado: ${error.message}`);
				eventData.thumbnail = null;
			}

			// Emitir evento
			this.logger.info(
				`Emitindo evento simulado: ${platform}/${channelName} ${state === "on" ? "online" : "offline"}`
			);

			if (state === "on") {
				bot.streamMonitor.emit("streamOnline", eventData);
			} else {
				bot.streamMonitor.emit("streamOffline", eventData);
			}

			return new ReturnMessage({
				chatId,
				content:
					`✅ Evento ${state === "on" ? "online" : "offline"} simulado com sucesso para ${platform}/${channelName}\n\n` +
					`Título: ${eventData.title ?? "N/A"}\n` +
					`Jogo: ${eventData.game ?? "N/A"}\n` +
					`Thumbnail: ${eventData.thumbnail ? "[Configurado]" : "[Não disponível]"}\n\n` +
					`O evento foi despachado para todos os grupos que monitoram este canal.`
			});
		} catch (error) {
			this.logger.error("Erro no comando simulateStreamEvent:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao processar comando."
			});
		}
	}

	/**
	 * Reinicia um bot específico
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @returns {Promise<ReturnMessage>} - Retorna mensagem de sucesso ou erro
	 */
	async restartBot(bot, message, args) {
		try {
			const chatId = message.group ?? message.author;

			// Verifica se o usuário é um super admin
			if (!this.isSuperAdmin(message.author)) {
				return new ReturnMessage({
					chatId,
					content: "⛔ Apenas super administradores podem usar este comando."
				});
			}

			if (args.length === 0) {
				return new ReturnMessage({
					chatId,
					content:
						"Por favor, forneça o ID do bot a reiniciar. Exemplo: !sa-restart ravena-testes Manutenção programada"
				});
			}

			// Obtém ID do bot e motivo
			const targetBotId = args[0];
			const reason =
				args.length > 1 ? args.slice(1).join(" ") : "Reinicialização solicitada por admin";

			// Obtém instância do bot alvo
			let targetBot = null;

			// Verifica se estamos tentando reiniciar o bot atual
			if (targetBotId === bot.id) {
				targetBot = bot;
			} else {
				// Verifica se o bot está na lista de outros bots
				if (bot.otherBots && Array.isArray(bot.otherBots)) {
					targetBot = bot.otherBots.find((b) => b.id === targetBotId);
				}
			}

			if (!targetBot) {
				return new ReturnMessage({
					chatId,
					content: `❌ Bot com ID '${targetBotId}' não encontrado. Verifique se o ID está correto.`
				});
			}

			// Verifica se o bot tem método de reinicialização
			if (typeof targetBot.restartBot !== "function") {
				return new ReturnMessage({
					chatId,
					content: `❌ O bot '${targetBotId}' não possui o método de reinicialização.`
				});
			}

			// Envia mensagem de resposta antes de reiniciar
			this.logger.info(`Reiniciando bot ${targetBotId} por comando de ${message.authorName}`);

			// Iniciar processo de reinicialização em um setTimeout para permitir que a resposta seja enviada primeiro
			setTimeout(async () => {
				try {
					// Tenta reiniciar o bot
					await targetBot.restartBot(reason);
				} catch (restartError) {
					this.logger.error(`Erro ao reiniciar bot ${targetBotId}:`, restartError);

					// Tenta enviar mensagem de erro (se possível)
					try {
						await bot.sendMessage(
							chatId,
							`❌ Erro ao reiniciar bot ${targetBotId}: ${restartError.message}`
						);
					} catch (sendError) {
						this.logger.error("Erro ao enviar mensagem de falha de reinicialização:", sendError);
					}
				}
			}, 1000);

			return new ReturnMessage({
				chatId,
				content: `✅ Iniciando reinicialização do bot '${targetBotId}'...\nMotivo: ${reason}\n\nEste processo pode levar alguns segundos. Você receberá notificações sobre o progresso no grupo de avisos.`
			});
		} catch (error) {
			this.logger.error("Erro no comando restartBot:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao processar comando."
			});
		}
	}

	/**
	 * Lista os membros de um grupo separando administradores e membros normais
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @returns {Promise<ReturnMessage>} - Retorna mensagem com a lista de membros
	 */
	async getMembros(bot, message, args) {
		try {
			const chatId = message.group ?? message.author;

			// Verifica se o usuário é um super admin
			if (!this.isSuperAdmin(message.author) && !this.isComuAdmin(bot, message.author)) {
				return new ReturnMessage({
					chatId,
					content: "⛔ Apenas super administradores podem usar este comando."
				});
			}

			// Verifica se é um grupo ou se recebeu o ID do grupo
			let groupId = message.group;

			if (!groupId && args.length > 0) {
				groupId = args[0];

				// Verifica se o formato é válido para ID de grupo
				if (!groupId.endsWith("@g.us")) {
					groupId = `${groupId}@g.us`;
				}
			}

			if (!groupId) {
				return new ReturnMessage({
					chatId,
					content: "Por favor, forneça o ID do grupo ou execute o comando dentro de um grupo."
				});
			}

			try {
				// Obtém o chat do grupo
				const chat = await bot.client.getChatById(groupId);

				if (!chat.isGroup) {
					return new ReturnMessage({
						chatId,
						content: `O ID fornecido (${groupId}) não corresponde a um grupo.`
					});
				}

				// Obtém participantes do grupo
				const participants = chat.participants ?? [];

				// Separa administradores e membros normais
				const admins = [];
				const members = [];

				for (const participant of participants) {
					const contactId = participant.id._serialized;
					let contactName = "Desconhecido";

					try {
						// Tenta obter dados do contato
						const contact = await bot.client.getContactById(contactId);
						contactName = contact.pushname ?? contact.name ?? contactId.replace("@c.us", "");
					} catch (contactError) {
						this.logger.debug(
							`Não foi possível obter informações do contato ${contactId}:`,
							contactError
						);
					}

					if (participant.isAdmin || participant.isSuperAdmin) {
						admins.push({ id: contactId, name: contactName });
					} else {
						members.push({ id: contactId, name: contactName });
					}
				}

				// Constrói a mensagem de resposta
				let responseMessage = `*Membros do Grupo:* ${chat.name}\n\n`;

				responseMessage += `*Administradores (${admins.length}):*\n`;
				for (const admin of admins) {
					responseMessage += `• ${admin.id} - ${admin.name}\n`;
				}

				responseMessage += `\n*Membros (${members.length}):*\n`;
				for (const member of members) {
					responseMessage += `• ${member.id} - ${member.name}\n`;
				}

				return new ReturnMessage({
					chatId,
					content: responseMessage
				});
			} catch (error) {
				this.logger.error(`Erro ao obter membros do grupo ${groupId}:`, error);

				return new ReturnMessage({
					chatId,
					content: `❌ Erro ao obter membros do grupo: ${error.message}`
				});
			}
		} catch (error) {
			this.logger.error("Erro no comando getMembros:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao processar comando."
			});
		}
	}

	/**
	 * Bloqueia uma lista de contatos de uma vez
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @returns {Promise<ReturnMessage>} - Retorna mensagem com resultados dos bloqueios
	 */
	async blockList(bot, message, args) {
		try {
			const chatId = message.group ?? message.author;

			// Verifica se o usuário é um super admin
			if (!this.isSuperAdmin(message.author)) {
				return new ReturnMessage({
					chatId,
					content: "⛔ Apenas super administradores podem usar este comando."
				});
			}

			let mode = "both";
			let numbersText = args.join(" ");

			if (args[0] === "local" || args[0] === "whats") {
				mode = args[0];
				numbersText = args.slice(1).join(" ");
			}

			if (!numbersText.trim()) {
				return new ReturnMessage({
					chatId,
					content:
						"Por favor, forneça uma lista de contatos separados por vírgula. Exemplo: !sa-blockList " +
						(mode !== "both" ? mode + " " : "") +
						"5511999999999@c.us, 5511888888888@c.us"
				});
			}

			// Divide a lista de contatos por vírgula
			const contactsList = numbersText.split(",").map((contact) => contact.trim());

			if (contactsList.length === 0) {
				return new ReturnMessage({
					chatId,
					content: "Nenhum contato válido encontrado na lista."
				});
			}

			// Grupos especiais que não devem ser deixados, apenas remover a pessoa
			const specialGroups = [];

			// Adicionar grupos especiais se estiverem definidos
			if (bot.grupoInteracao) specialGroups.push(bot.grupoInteracao);
			if (bot.grupoAvisos) specialGroups.push(bot.grupoAvisos);
			if (bot.grupoAnuncios) specialGroups.push(bot.grupoAnuncios);

			// Resultados do bloqueio
			const results = [];
			const specialGroupResults = {};

			// Processa cada contato
			for (const contactItem of contactsList) {
				// Processa o número para formato padrão
				let phoneNumber = contactItem.replace(/\D/g, "");

				// Se o número estiver vazio, pula para o próximo
				if (!phoneNumber) {
					results.push({ id: contactItem, status: "Erro", message: "Número inválido" });
					continue;
				}

				// Se o número não tiver o formato @c.us, adicione
				if (!contactItem.includes("@")) {
					phoneNumber = `${phoneNumber}@c.us`;
				} else {
					phoneNumber = contactItem;
				}

				try {
					// Tenta remover o contato de grupos especiais primeiro
					if (specialGroups.length > 0 && (mode === "both" || mode === "whats")) {
						const removeResults = await this.removeFromSpecialGroups(
							bot,
							phoneNumber,
							specialGroups,
							message
						);
						specialGroupResults[phoneNumber] = removeResults;
					}

					let apiOk = false;
					let localOk = false;
					let apiError = "";
					let localError = "";

					// 1. Tenta bloquear o contato na API externa
					if (mode === "both" || mode === "whats") {
						try {
							const contact = await bot.client.getContactById(phoneNumber);
							await contact.block();
							apiOk = true;
						} catch (blockError) {
							this.logger.error(`Erro ao bloquear contato ${phoneNumber} na API:`, blockError);
							apiError = blockError.message ?? "Erro API";
						}
					} else {
						apiOk = true;
					}

					// 2. Tenta bloquear o contato localmente
					if (mode === "both" || mode === "local") {
						try {
							const pnClean = phoneNumber.split("@")[0];
							await this.database.addLocalBlock(pnClean);
							localOk = true;
						} catch (dbError) {
							this.logger.error(`Erro ao bloquear contato ${phoneNumber} localmente:`, dbError);
							localError = dbError.message ?? "Erro Local";
						}
					} else {
						localOk = true;
					}

					if (apiOk && localOk) {
						let successMsg = "Sucesso";
						if (mode === "local") successMsg += " (Local apenas)";
						else if (mode === "whats") successMsg += " (API apenas)";
						else successMsg += " (API & Local)";

						results.push({
							id: phoneNumber,
							status: "Bloqueado",
							message: successMsg
						});
					} else {
						let statusMsg = "";
						if (apiOk) statusMsg += "API: ✅ ";
						else statusMsg += `API: ❌ (${apiError}) `;

						if (localOk) statusMsg += "Local: ✅";
						else statusMsg += `Local: ❌ (${localError})`;

						results.push({
							id: phoneNumber,
							status: apiOk || localOk ? "Parcial" : "Erro",
							message: statusMsg
						});
					}
				} catch (err) {
					this.logger.error(`Erro ao processar contato ${phoneNumber}:`, err);

					results.push({
						id: phoneNumber,
						status: "Erro",
						message: err.message ?? "Erro desconhecido"
					});
				}
			}

			// Constrói a mensagem de resposta
			let responseMessage = `*Resultados do bloqueio (${results.length} contatos):*\n\n`;

			// Conta bloqueados e erros
			const blocked = results.filter((r) => r.status === "Bloqueado").length;
			const errors = results.filter((r) => r.status === "Erro").length;

			responseMessage += `✅ *Bloqueados com sucesso:* ${blocked}\n`;
			responseMessage += `❌ *Erros:* ${errors}\n\n`;

			// Lista detalhada
			responseMessage += `*Detalhes:*\n`;
			for (const result of results) {
				const statusEmoji = result.status === "Bloqueado" ? "✅" : "❌";
				responseMessage += `${statusEmoji} ${result.id}: ${result.status}\n`;

				// Adiciona informações sobre remoção de grupos especiais se disponível
				if (specialGroupResults[result.id]) {
					const sgr = specialGroupResults[result.id];
					if (sgr.successes > 0) {
						responseMessage += `  └ Removido de ${sgr.successes} grupos especiais\n`;
					}
				}
			}

			return new ReturnMessage({
				chatId,
				content: responseMessage
			});
		} catch (error) {
			this.logger.error("Erro no comando blockList:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao processar comando."
			});
		}
	}

	async blockTudoList(bot, message, args) {
		try {
			const chatId = message.group ?? message.author;

			// Verifica se o usuário é um super admin
			if (!this.isSuperAdmin(message.author)) {
				return new ReturnMessage({
					chatId,
					content: "⛔ Apenas super administradores podem usar este comando."
				});
			}

			// Obtém o texto completo de argumentos e divide por vírgulas
			const contactsText = args.join(" ");
			if (!contactsText.trim()) {
				return new ReturnMessage({
					chatId,
					content:
						"Por favor, forneça uma lista de contatos separados por vírgula. Exemplo: !sa-blockTudoList 5511999999999, 5511888888888"
				});
			}

			// Divide a lista de contatos por vírgula
			const contactsList = contactsText.split(",").map((contact) => contact.trim());

			if (contactsList.length === 0) {
				return new ReturnMessage({
					chatId,
					content: "Nenhum contato válido encontrado na lista."
				});
			}

			// Grupos especiais que não devem ser deixados, apenas remover a pessoa
			const specialGroups = [];

			// Adicionar grupos especiais se estiverem definidos
			if (bot.grupoInteracao) specialGroups.push(bot.grupoInteracao);
			if (bot.grupoAvisos) specialGroups.push(bot.grupoAvisos);
			if (bot.grupoAnuncios) specialGroups.push(bot.grupoAnuncios);

			this.logger.info(`Grupos especiais configurados: ${specialGroups.join(", ")}`);

			// Resultados da operação para cada contato
			const contactResults = [];

			// Conjunto para armazenar todos os contatos únicos de todos os grupos
			const allContactsSet = new Set();

			// Conjunto para armazenar todos os grupos processados
			const processedGroups = new Set();

			// Processa cada contato na lista
			for (const contactItem of contactsList) {
				// Processa o número para formato padrão
				let phoneNumber = contactItem.replace(/\D/g, "");

				// Se o número estiver vazio, pula para o próximo
				if (!phoneNumber) {
					contactResults.push({
						phoneNumber: contactItem,
						status: "Erro",
						message: "Número inválido",
						groups: [],
						totalGroups: 0
					});
					continue;
				}

				// Se o número não tiver o formato @c.us, adicione
				if (!phoneNumber.includes("@")) {
					phoneNumber = `${phoneNumber}@c.us`;
				} else {
					phoneNumber = contactItem;
				}

				try {
					// Obtém o contato
					const contact = await bot.client.getContactById(phoneNumber);
					const contactName = contact.pushname ?? contact.name ?? phoneNumber;

					// Obtém grupos em comum
					const commonGroups = await contact.getCommonGroups();

					if (!commonGroups || commonGroups.length === 0) {
						contactResults.push({
							phoneNumber,
							contactName,
							status: "Sem grupos",
							message: "Nenhum grupo em comum encontrado",
							groups: [],
							totalGroups: 0
						});
						continue;
					}

					// Resultados para este contato
					const results = {
						phoneNumber,
						contactName,
						totalGroups: commonGroups.length,
						leftGroups: 0,
						specialGroups: 0,
						errors: 0,
						status: "Processado",
						groups: []
					};

					// Processa cada grupo
					for (const group of commonGroups) {
						const groupId = group.JID || group;
						try {
							// Se já processamos este grupo, pula
							if (processedGroups.has(groupId)) {
								this.logger.debug(`Grupo ${groupId} já foi processado anteriormente, pulando.`);
								results.groups.push({
									id: groupId,
									status: "Já processado"
								});
								continue;
							}

							// Obtém o chat do grupo
							const chat = await bot.client.getChatById(groupId);
							const groupName = chat.name ?? groupId;

							// Verifica se é um grupo especial
							const nameLower = groupName ? groupName.toLowerCase() : "";
							const isSpecialGroup =
								specialGroups.includes(groupId) ||
								(groupName &&
									(nameLower.includes("gpzuera") ||
										nameLower.includes("rapescas") ||
										nameLower.includes("ravdownloads")));

							if (isSpecialGroup) {
								this.logger.info(
									`Grupo especial detectado: ${groupId} (${groupName}). Removendo o contato.`
								);
								results.specialGroups++;

								try {
									// Verifica se o contato está no grupo
									const isInGroup = chat.participants.some((p) => p.id._serialized === phoneNumber);

									if (isInGroup) {
										// Remove apenas a pessoa do grupo
										await chat.removeParticipants([phoneNumber]);

										results.groups.push({
											id: groupId,
											name: groupName,
											status: "Especial",
											action: "Removido"
										});
									} else {
										results.groups.push({
											id: groupId,
											name: groupName,
											status: "Especial",
											action: "Não presente"
										});
									}
								} catch (removeError) {
									this.logger.error(
										`Erro ao remover contato do grupo especial ${groupId}:`,
										removeError
									);

									results.errors++;
									results.groups.push({
										id: groupId,
										name: groupName,
										status: "Erro",
										action: "Remover",
										error: removeError.message
									});
								}
							} else {
								// Para grupos normais, obtém participantes e sai do grupo
								const participants = chat.participants ?? [];

								// Adiciona ID de cada participante ao conjunto global e marca o grupo como processado
								if (!processedGroups.has(groupId)) {
									participants.forEach((participant) => {
										// Não adicione os contatos da lista sendo processada
										const participantId = participant.id._serialized;
										if (
											!contactsList.includes(participantId) &&
											!contactsList.includes(participantId.replace("@c.us", ""))
										) {
											allContactsSet.add(participantId);
										}
									});

									// Marca o grupo como processado
									processedGroups.add(groupId);

									// Envia mensagem de despedida (opcional)
									//await bot.sendMessage(groupId, '👋 Saindo deste grupo por comando administrativo. Até mais!');

									// Sai do grupo
									await bot.client.leaveGroup(groupId);

									results.leftGroups++;
									results.groups.push({
										id: groupId,
										name: groupName,
										status: "Sucesso",
										action: "Saiu",
										members: participants.length
									});
								} else {
									results.groups.push({
										id: groupId,
										name: groupName,
										status: "Já processado"
									});
								}
							}
						} catch (groupError) {
							this.logger.error(`Erro ao processar grupo ${groupId}:`, groupError);

							results.errors++;
							results.groups.push({
								id: groupId,
								status: "Erro",
								error: groupError.message
							});
						}
					}

					// Adiciona os resultados deste contato
					contactResults.push(results);

					// Tenta bloquear este contato (API e Local)
					try {
						// API
						try {
							await contact.block();
						} catch (apiError) {
							this.logger.error(`Erro ao bloquear contato ${phoneNumber} na API:`, apiError);
						}
						// Local
						try {
							const pnClean = phoneNumber.split("@")[0];
							await this.database.addLocalBlock(pnClean);
						} catch (localError) {
							this.logger.error(`Erro ao bloquear contato ${phoneNumber} localmente:`, localError);
						}

						this.logger.info(`Contato ${phoneNumber} bloqueado (API/Local).`);
					} catch (blockError) {
						this.logger.error(`Erro ao processar bloqueio de ${phoneNumber}:`, blockError);
						results.status = "Erro ao bloquear";
						results.error = blockError.message;
					}
				} catch (contactError) {
					this.logger.error(`Erro ao processar contato ${phoneNumber}:`, contactError);
					contactResults.push({
						phoneNumber,
						status: "Erro",
						message: contactError.message,
						groups: [],
						totalGroups: 0
					});
				}
			}

			// Converte o conjunto para array para facilitar o processamento
			const allContacts = Array.from(allContactsSet);

			// Bloqueia todos os contatos coletados dos grupos (API e Local)
			let blockedCount = 0;
			let blockErrors = 0;

			for (const contactId of allContacts) {
				try {
					// Verifica se não é o próprio usuário ou um dos contatos da lista
					if (
						contactId === message.author ||
						contactsList.includes(contactId) ||
						contactsList.includes(contactId.replace("@c.us", ""))
					) {
						continue;
					}

					// API
					try {
						const contactToBlock = await bot.client.getContactById(contactId);
						await contactToBlock.block();
					} catch (apiErr) {
						this.logger.error(`Erro ao bloquear membro ${contactId} na API:`, apiErr);
					}

					// Local
					try {
						const pnClean = contactId.split("@")[0];
						await this.database.addLocalBlock(pnClean);
					} catch (localErr) {
						this.logger.error(`Erro ao bloquear membro ${contactId} localmente:`, localErr);
					}

					blockedCount++;
				} catch (blockError) {
					this.logger.error(`Erro ao bloquear contato ${contactId}:`, blockError);
					blockErrors++;
				}
			}

			// Constrói a mensagem de resposta
			let responseMessage = `*Operação de Bloqueio em Massa Concluída*\n\n`;
			responseMessage += `📊 *Resumo Geral:*\n`;
			responseMessage += `• Contatos processados: ${contactResults.length}\n`;
			responseMessage += `• Grupos únicos processados: ${processedGroups.size}\n`;
			responseMessage += `• Contatos únicos encontrados: ${allContacts.length}\n`;
			responseMessage += `• Contatos bloqueados: ${blockedCount}\n`;
			responseMessage += `• Erros de bloqueio: ${blockErrors}\n\n`;

			// Adiciona detalhes para cada contato processado
			responseMessage += `*Detalhes por Contato:*\n`;
			for (const result of contactResults) {
				const statusEmoji =
					result.status === "Processado" ? "✅" : result.status === "Sem grupos" ? "⚠️" : "❌";

				responseMessage += `${statusEmoji} *${result.contactName ?? result.phoneNumber}*: `;

				if (result.status === "Processado") {
					responseMessage += `${result.totalGroups} grupos (${result.leftGroups} saídos, ${result.specialGroups} especiais)\n`;
				} else {
					responseMessage += `${result.status} - ${result.message ?? ""}\n`;
				}
			}

			// Se a mensagem for muito longa, truncar e adicionar nota
			if (responseMessage.length > 4000) {
				responseMessage = responseMessage.substring(0, 4000);
				responseMessage += "\n... (mensagem truncada devido ao tamanho)";
			}

			return new ReturnMessage({
				chatId,
				content: responseMessage
			});
		} catch (error) {
			this.logger.error("Erro no comando blockTudoList:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao processar comando."
			});
		}
	}

	/**
	 * Desbloqueia uma lista de contatos de uma vez
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @returns {Promise<ReturnMessage>} - Retorna mensagem com resultados dos desbloqueios
	 */
	async unblockList(bot, message, args) {
		try {
			const chatId = message.group ?? message.author;

			// Verifica se o usuário é um super admin
			if (!this.isSuperAdmin(message.author)) {
				return new ReturnMessage({
					chatId,
					content: "⛔ Apenas super administradores podem usar este comando."
				});
			}

			let mode = "both";
			let numbersText = args.join(" ");

			if (args[0] === "local" || args[0] === "whats") {
				mode = args[0];
				numbersText = args.slice(1).join(" ");
			}

			if (!numbersText.trim()) {
				return new ReturnMessage({
					chatId,
					content:
						"Por favor, forneça uma lista de contatos separados por vírgula. Exemplo: !sa-unblockList " +
						(mode !== "both" ? mode + " " : "") +
						"5511999999999@c.us, 5511888888888@c.us"
				});
			}

			// Divide a lista de contatos por vírgula
			const contactsList = numbersText.split(",").map((contact) => contact.trim());

			if (contactsList.length === 0) {
				return new ReturnMessage({
					chatId,
					content: "Nenhum contato válido encontrado na lista."
				});
			}

			// Resultados do desbloqueio
			const results = [];

			// Processa cada contato
			for (const contactItem of contactsList) {
				// Processa o número para formato padrão
				let phoneNumber = contactItem.replace(/\D/g, "");

				// Se o número estiver vazio, pula para o próximo
				if (!phoneNumber) {
					results.push({ id: contactItem, status: "Erro", message: "Número inválido" });
					continue;
				}

				// Se o número não tiver o formato @c.us, adicione
				if (!contactItem.includes("@")) {
					phoneNumber = `${phoneNumber}@c.us`;
				} else {
					phoneNumber = contactItem;
				}

				try {
					let apiOk = false;
					let localOk = false;
					let apiError = "";
					let localError = "";

					// 1. Tenta desbloquear o contato na API externa
					let contact = null;
					if (mode === "both" || mode === "whats") {
						try {
							contact = await bot.client.getContactById(phoneNumber);
							await contact.unblock();
							apiOk = true;
						} catch (unblockError) {
							this.logger.error(`Erro ao desbloquear contato ${phoneNumber} na API:`, unblockError);
							apiError = unblockError.message ?? "Erro API";
						}
					} else {
						apiOk = true;
					}

					// 2. Tenta desbloquear o contato localmente
					if (mode === "both" || mode === "local") {
						try {
							const pnClean = phoneNumber.split("@")[0];
							await this.database.removeLocalBlock(pnClean);
							if (!contact && (mode === "both" || mode === "local")) {
								try {
									contact = await bot.client.getContactById(phoneNumber);
								} catch (e) {}
							}
							if (contact && contact.lid) {
								const lidClean = contact.lid.split("@")[0];
								if (lidClean && lidClean !== pnClean) {
									await this.database.removeLocalBlock(lidClean);
								}
							}
							localOk = true;
						} catch (dbError) {
							this.logger.error(`Erro ao desbloquear contato ${phoneNumber} localmente:`, dbError);
							localError = dbError.message ?? "Erro Local";
						}
					} else {
						localOk = true;
					}

					if (apiOk && localOk) {
						results.push({
							id: phoneNumber,
							status: "Desbloqueado",
							message: "Sucesso (API & Local)"
						});
					} else {
						let statusMsg = "";
						if (apiOk) statusMsg += "API: ✅ ";
						else statusMsg += `API: ❌ (${apiError}) `;

						if (localOk) statusMsg += "Local: ✅";
						else statusMsg += `Local: ❌ (${localError})`;

						results.push({
							id: phoneNumber,
							status: apiOk || localOk ? "Parcial" : "Erro",
							message: statusMsg
						});
					}
				} catch (err) {
					this.logger.error(`Erro ao processar contato ${phoneNumber}:`, err);

					results.push({
						id: phoneNumber,
						status: "Erro",
						message: err.message ?? "Erro desconhecido"
					});
				}
			}

			// Constrói a mensagem de resposta
			let responseMessage = `*Resultados do desbloqueio (${results.length} contatos):*\n\n`;

			// Conta desbloqueados e erros
			const unblocked = results.filter((r) => r.status === "Desbloqueado").length;
			const errors = results.filter((r) => r.status === "Erro").length;

			responseMessage += `✅ *Desbloqueados com sucesso:* ${unblocked}\n`;
			responseMessage += `❌ *Erros:* ${errors}\n\n`;

			// Lista detalhada
			responseMessage += `*Detalhes:*\n`;
			for (const result of results) {
				const statusEmoji = result.status === "Desbloqueado" ? "✅" : "❌";
				responseMessage += `${statusEmoji} ${result.id}: ${result.status}\n`;
			}

			return new ReturnMessage({
				chatId,
				content: responseMessage
			});
		} catch (error) {
			this.logger.error("Erro no comando unblockList:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao processar comando."
			});
		}
	}

	/**
	 * Lista todos os grupos em comum com um contato
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @returns {Promise<ReturnMessage>} - Retorna mensagem com a lista de grupos
	 */
	async listaGruposPessoa(bot, message, args) {
		try {
			const chatId = message.group ?? message.author;

			// Verifica se o usuário é um super admin
			if (!this.isSuperAdmin(message.author)) {
				return new ReturnMessage({
					chatId,
					content: "⛔ Apenas super administradores podem usar este comando."
				});
			}

			if (args.length === 0) {
				return new ReturnMessage({
					chatId,
					content:
						"Por favor, forneça o número do contato. Exemplo: !sa-listaGruposPessoa 5511999999999"
				});
			}

			// Processa o número para formato padrão
			let phoneNumber = args[0].replace(/\D/g, "");

			// Se o número não tiver o formato @c.us, adicione
			if (!phoneNumber.includes("@")) {
				phoneNumber = `${phoneNumber}@c.us`;
			}

			try {
				// Obtém o contato
				const contact = await bot.client.getContactById(phoneNumber);
				const contactName = contact.pushname ?? contact.name ?? phoneNumber;

				// Obtém grupos em comum
				const commonGroups = await contact.getCommonGroups();

				if (!commonGroups || commonGroups.length === 0) {
					return new ReturnMessage({
						chatId,
						content: `Nenhum grupo em comum encontrado com ${contactName} (${phoneNumber}).`
					});
				}

				// Obtém informações dos grupos do banco de dados
				const groups = await this.database.getGroups();

				// Constrói a mensagem de resposta
				let responseMessage = `*Grupos em comum com ${contactName} (${phoneNumber}):*\n\n`;

				// Adiciona cada grupo à resposta
				for (const group of commonGroups) {
					const groupId = group.JID || group;
					// Busca informações do banco de dados
					const groupData = groups.find((g) => g.id === groupId);
					const groupName = groupData ? groupData.name : "Nome desconhecido";

					// Tenta obter nome do chat
					let chatName = groupName;
					try {
						const chat = await bot.client.getChatById(groupId);
						chatName = chat.name ?? groupName;
					} catch (error) {
						this.logger.debug(`Erro ao obter informações do chat ${groupId}:`, error);
					}

					responseMessage += `• ${groupId} - ${chatName}\n`;
				}

				return new ReturnMessage({
					chatId,
					content: responseMessage
				});
			} catch (error) {
				this.logger.error(`Erro ao listar grupos em comum com ${phoneNumber}:`, error);

				return new ReturnMessage({
					chatId,
					content: `❌ Erro ao listar grupos em comum: ${error.message}`
				});
			}
		} catch (error) {
			this.logger.error("Erro no comando listaGruposPessoa:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao processar comando."
			});
		}
	}

	/**
	 * Sai de todos os grupos em comum com um contato e bloqueia todos os membros
	 * Comportamento especial: Não sai dos grupos de interação e avisos, apenas remove a pessoa
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @returns {Promise<ReturnMessage>} - Retorna mensagem com o resultado da operação
	 */
	async blockTudoPessoa(bot, message, args) {
		try {
			const chatId = message.group ?? message.author;

			// Verifica se o usuário é um super admin
			if (!this.isSuperAdmin(message.author)) {
				return new ReturnMessage({
					chatId,
					content: "⛔ Apenas super administradores podem usar este comando."
				});
			}

			if (args.length === 0) {
				return new ReturnMessage({
					chatId,
					content:
						"Por favor, forneça o número do contato. Exemplo: !sa-blockTudoPessoa 5511999999999"
				});
			}

			// Grupos especiais que não devem ser deixados, apenas remover a pessoa
			const specialGroups = [];

			// Adicionar grupos especiais se estiverem definidos
			if (bot.grupoInteracao) specialGroups.push(bot.grupoInteracao);
			if (bot.grupoAvisos) specialGroups.push(bot.grupoAvisos);
			if (bot.grupoAnuncios) specialGroups.push(bot.grupoAnuncios);

			this.logger.info(`Grupos especiais configurados: ${specialGroups.join(", ")}`);

			// Processa o número para formato padrão
			let phoneNumber = args[0].replace(/\D/g, "");

			// Se o número não tiver o formato @c.us, adicione
			if (!phoneNumber.includes("@")) {
				phoneNumber = `${phoneNumber}@c.us`;
			}

			try {
				// Obtém o contato
				const contact = await bot.client.getContactById(phoneNumber);
				const contactName = contact.pushname ?? contact.name ?? phoneNumber;

				// Obtém grupos em comum
				const commonGroups = await contact.getCommonGroups();

				if (!commonGroups || commonGroups.length === 0) {
					return new ReturnMessage({
						chatId,
						content: `Nenhum grupo em comum encontrado com ${contactName} (${phoneNumber}).`
					});
				}

				// Resultados da operação
				const results = {
					totalGroups: commonGroups.length,
					leftGroups: 0,
					specialGroups: 0,
					totalContacts: 0,
					blockedContacts: 0,
					errors: 0,
					groupsInfo: []
				};

				// Conjunto para armazenar todos os contatos únicos
				const allContacts = new Set();

				// Processa cada grupo
				for (const group of commonGroups) {
					const groupId = group.JID || group;
					try {
						// Obtém o chat do grupo
						const chat = await bot.client.getChatById(groupId);
						const groupName = chat.name ?? groupId;

						// Verifica se é um grupo especial
						const nameLower = groupName ? groupName.toLowerCase() : "";
						const isSpecialGroup =
							specialGroups.includes(groupId) ||
							(groupName &&
								(nameLower.includes("gpzuera") ||
									nameLower.includes("rapescas") ||
									nameLower.includes("ravdownloads")));

						if (isSpecialGroup) {
							this.logger.info(
								`Grupo especial detectado: ${groupId} (${groupName}). Removendo o contato.`
							);
							results.specialGroups++;

							try {
								// Verifica se o contato está no grupo
								const isInGroup = chat.participants.some((p) => p.id._serialized === phoneNumber);

								if (isInGroup) {
									// Remove apenas a pessoa do grupo
									await chat.removeParticipants([phoneNumber]);

									results.groupsInfo.push({
										id: groupId,
										name: groupName,
										status: "Especial",
										action: "Removido",
										members: chat.participants.length
									});

									//await bot.sendMessage(groupId, `👤 Contato ${contactName} removido do grupo por comando administrativo.`);
								} else {
									results.groupsInfo.push({
										id: groupId,
										name: groupName,
										status: "Especial",
										action: "Não presente",
										members: chat.participants.length
									});
								}
							} catch (removeError) {
								this.logger.error(
									`Erro ao remover contato do grupo especial ${groupId}:`,
									removeError
								);

								results.errors++;
								results.groupsInfo.push({
									id: groupId,
									name: groupName,
									status: "Erro",
									action: "Remover",
									error: removeError.message
								});
							}
						} else {
							// Para grupos normais, obtém participantes e sai do grupo
							const participants = chat.participants ?? [];

							// Adiciona ID de cada participante ao conjunto
							participants.forEach((participant) => {
								// Não adicione o próprio contato sendo bloqueado
								if (participant.id._serialized !== phoneNumber) {
									allContacts.add(participant.id._serialized);
								}
							});

							// Envia mensagem de despedida
							//await bot.sendMessage(groupId, '👋 Saindo deste grupo por comando administrativo. Até mais!');

							// Sai do grupo
							await bot.client.leaveGroup(groupId);

							results.leftGroups++;
							results.groupsInfo.push({
								id: groupId,
								name: groupName,
								status: "Sucesso",
								action: "Saiu",
								members: participants.length
							});
						}
					} catch (groupError) {
						this.logger.error(`Erro ao processar grupo ${groupId}:`, groupError);

						results.errors++;
						results.groupsInfo.push({
							id: groupId,
							status: "Erro",
							error: groupError.message
						});
					}
				}

				results.totalContacts = allContacts.size;

				// Bloqueia todos os contatos coletados dos grupos não-especiais (API e Local)
				for (const contactId of allContacts) {
					try {
						// Verifica se não é o próprio usuário ou o contato alvo
						if (contactId === message.author || contactId === phoneNumber) continue;

						// API
						try {
							const contactToBlock = await bot.client.getContactById(contactId);
							await contactToBlock.block();
						} catch (apiErr) {
							this.logger.error(`Erro ao bloquear membro ${contactId} na API:`, apiErr);
						}

						// Local
						try {
							const pnClean = contactId.split("@")[0];
							await this.database.addLocalBlock(pnClean);
						} catch (localErr) {
							this.logger.error(`Erro ao bloquear membro ${contactId} localmente:`, localErr);
						}

						results.blockedContacts++;
					} catch (blockError) {
						this.logger.error(`Erro ao bloquear contato ${contactId}:`, blockError);
						results.errors++;
					}
				}

				// Bloqueia o contato alvo por último (API e Local)
				try {
					// API
					try {
						await contact.block();
					} catch (apiErr) {
						this.logger.error(`Erro ao bloquear contato alvo ${phoneNumber} na API:`, apiErr);
					}

					// Local
					try {
						const pnClean = phoneNumber.split("@")[0];
						await this.database.addLocalBlock(pnClean);
					} catch (localErr) {
						this.logger.error(`Erro ao bloquear contato alvo ${phoneNumber} localmente:`, localErr);
					}

					this.logger.info(`Contato alvo ${phoneNumber} bloqueado (API/Local).`);
				} catch (blockTargetError) {
					this.logger.error(`Erro ao bloquear contato alvo ${phoneNumber}:`, blockTargetError);
					results.errors++;
				}

				// Constrói a mensagem de resposta
				let responseMessage = `*Operação completa para ${contactName} (${phoneNumber}):*\n\n`;
				responseMessage += `📊 *Resumo:*\n`;
				responseMessage += `• Grupos encontrados: ${results.totalGroups}\n`;
				responseMessage += `• Grupos especiais (apenas remoção): ${results.specialGroups}\n`;
				responseMessage += `• Grupos deixados: ${results.leftGroups}\n`;
				responseMessage += `• Contatos únicos: ${results.totalContacts}\n`;
				responseMessage += `• Contatos bloqueados: ${results.blockedContacts}\n`;
				responseMessage += `• Erros: ${results.errors}\n\n`;

				responseMessage += `*Detalhes dos grupos:*\n`;
				for (const group of results.groupsInfo) {
					let statusEmoji;
					if (group.status === "Sucesso") statusEmoji = "✅";
					else if (group.status === "Especial") statusEmoji = "⭐";
					else statusEmoji = "❌";

					// Melhoria na exibição dos detalhes do grupo
					const groupName = group.name ?? "Nome desconhecido";

					// Verifica se o ID é um objeto e exibe adequadamente
					let groupId;
					if (typeof group.id === "object") {
						groupId = group.id?._serialized || JSON.stringify(group.id);
					} else {
						groupId = group.id;
					}

					responseMessage += `${statusEmoji} ${groupId} - ${groupName} (${group.action ?? group.status})`;

					// Adicionar detalhes do erro se houver
					if (group.error) {
						responseMessage += `: ${group.error}`;
					}

					responseMessage += "\n";
				}

				return new ReturnMessage({
					chatId,
					content: responseMessage
				});
			} catch (error) {
				this.logger.error(`Erro ao processar blockTudoPessoa para ${phoneNumber}:`, error);

				return new ReturnMessage({
					chatId,
					content: `❌ Erro ao processar operação: ${error.message}`
				});
			}
		} catch (error) {
			this.logger.error("Erro no comando blockTudoPessoa:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao processar comando."
			});
		}
	}

	/**
	 * Escaneia a base de dados e sugere correção para nomes de grupos.
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Objeto da mensagem
	 * @param {Array} args - Argumentos do comando
	 */
	async fixGroupNames(bot, message, args) {
		const chatId = message.group ?? message.author;
		try {
			if (!this.isSuperAdmin(message.author)) return;

			const groups = await this.database.getGroups();
			const toFixLength = [];
			const toFixNumeric = [];
			const allExistingNames = new Set(groups.map((g) => g.name.toLowerCase()));

			for (const group of groups) {
				const isNumeric = /^\d+$/.test(group.name.trim());
				if (group.name.trim().length > 30) {
					toFixLength.push(group);
				} else if (isNumeric) {
					toFixNumeric.push(group);
				}
			}

			if (toFixLength.length === 0 && toFixNumeric.length === 0) {
				return new ReturnMessage({
					chatId,
					content: "✅ Todos os nomes de grupos estão dentro dos padrões."
				});
			}

			let response = "🔍 *Sugestões de Reorganização de Grupos*\n\n";
			const changes = [];

			const sanitize = (text) => {
				if (!text) return "";
				return text
					.normalize("NFD")
					.replace(/[\u0300-\u036f]/g, "") // Remove accents
					.replace(/[^a-zA-Z0-9\s]/g, "") // Remove special chars but keep spaces for TitleCase
					.trim()
					.split(/\s+/)
					.filter((word) => word.length > 0)
					.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
					.join("");
			};

			// Handle Numeric Names
			for (const group of toFixNumeric) {
				try {
					let currentTitle = "Desconhecido";
					try {
						const chat = await bot.client.getChatById(group.id);
						currentTitle = chat.name || chat.subject || "";
					} catch (e) {
						this.logger.warn(`Não foi possível obter chat para ${group.id}: ${e.message}`);
					}

					let newName = sanitize(currentTitle);

					if (!newName || newName.length < 3) {
						newName = sanitize(group.id.split("@")[0]);
					}

					// Ensure uniqueness
					const baseName = newName.substring(0, 25);
					let counter = 1;
					let finalName = newName.substring(0, 30);
					while (allExistingNames.has(finalName.toLowerCase())) {
						finalName = `${baseName}${counter}`.substring(0, 30);
						counter++;
					}
					allExistingNames.add(finalName.toLowerCase());

					changes.push({
						id: group.id,
						oldName: group.name,
						newName: finalName,
						reason: "Nome numérico",
						currentTitle
					});
				} catch (e) {
					this.logger.error(`Erro ao processar grupo numérico ${group.id}:`, e);
				}
			}

			// Handle Long Names in batch
			if (toFixLength.length > 0) {
				const longNamesList = toFixLength.map((g) => `- ${g.name} (${g.id})`).join("\n");
				const prompt = `Sugira nomes curtos (máximo 30 caracteres) para os seguintes grupos de WhatsApp. 
Use TitleCase, remova acentos e espaços. Os nomes devem ser únicos e descritivos.
Se o nome atual já for descritivo, tente apenas encurtá-lo mantendo o sentido.

Grupos:
${longNamesList}

Retorne no formato JSON rigoroso:
{
  "suggestions": [
    {"id": "group_id", "newName": "Sugestao"}
  ]
}`;

				const schema = {
					type: "json_schema",
					json_schema: {
						name: "fix_group_names",
						schema: {
							type: "object",
							properties: {
								suggestions: {
									type: "array",
									items: {
										type: "object",
										properties: {
											id: { type: "string" },
											newName: { type: "string" }
										},
										required: ["id", "newName"]
									}
								}
							},
							required: ["suggestions"]
						}
					}
				};

				try {
					const llmResponse = await this.llmService.getCompletion({
						prompt,
						response_format: schema,
						temperature: 0.3,
						priority: 4
					});

					const parsed = JSON.parse(llmResponse);
					if (parsed.suggestions) {
						for (const sugg of parsed.suggestions) {
							const group = toFixLength.find((g) => g.id === sugg.id);
							if (group) {
								const suggestedName = sanitize(sugg.newName);

								// Ensure uniqueness and length
								const baseName = suggestedName.substring(0, 25);
								let counter = 1;
								let finalName = suggestedName.substring(0, 30);
								while (allExistingNames.has(finalName.toLowerCase())) {
									finalName = `${baseName}${counter}`.substring(0, 30);
									counter++;
								}
								allExistingNames.add(finalName.toLowerCase());

								changes.push({
									id: group.id,
									oldName: group.name,
									newName: finalName,
									reason: "Nome muito longo"
								});
							}
						}
					}
				} catch (e) {
					this.logger.error("Erro ao obter sugestões do LLM:", e);
					response += "⚠️ _Erro ao obter sugestões do LLM para nomes longos._\n\n";
				}
			}

			if (changes.length === 0) {
				return new ReturnMessage({
					chatId,
					content: response + "Nenhuma alteração sugerida."
				});
			}

			const isCommit = args[0] === "commit";
			const commitResults = [];

			for (const change of changes) {
				response += `🔹 *${change.oldName}* ➔ *${change.newName}*\n`;
				response += `   ID: ${change.id}\n`;
				response += `   Motivo: ${change.reason}\n`;
				if (change.currentTitle && change.currentTitle !== "Desconhecido") {
					response += `   Título Atual: ${change.currentTitle}\n`;
				}
				response += "\n";

				if (isCommit) {
					try {
						const groupData = await this.database.getGroup(change.id);
						if (groupData) {
							groupData.name = change.newName;
							groupData.updatedAt = Date.now();
							const success = await this.database.saveGroup(groupData);
							commitResults.push(success);
						} else {
							commitResults.push(false);
						}
					} catch (e) {
						this.logger.error(`Erro ao persistir mudança para ${change.id}:`, e);
						commitResults.push(false);
					}
				}
			}

			if (isCommit) {
				const successCount = commitResults.filter((r) => r).length;
				response += `✅ *Commit realizado:* ${successCount} de ${commitResults.length} alterações aplicadas.`;
				if (successCount > 0) {
					bot.eventHandler.loadGroups(); // Recarrega os grupos em memória
				}
			} else {
				response +=
					"_Este é um dry run. Nenhuma alteração foi salva no banco de dados. Use '!sa-fixGroupNames commit' para aplicar._";
			}

			return new ReturnMessage({
				chatId,
				content: response
			});
		} catch (error) {
			this.logger.error("Erro no comando fixGroupNames:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao processar comando."
			});
		}
	}

	/**
	 * Exibe informações detalhadas de um grupo pelo nome de cadastro
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @returns {Promise<ReturnMessage>} - Retorna mensagem com as informações do grupo
	 */
	async getGroupInfo(bot, message, args) {
		try {
			const chatId = message.group ?? message.author;

			// Verifica se o usuário é um super admin
			if (!this.isSuperAdmin(message.author) && !this.isComuAdmin(bot, message.author)) {
				return new ReturnMessage({
					chatId,
					content: "⛔ Apenas super administradores podem usar este comando."
				});
			}

			if (args.length === 0) {
				return new ReturnMessage({
					chatId,
					content:
						"Por favor, forneça o nome de cadastro do grupo. Exemplo: !sa-getGroupInfo nomeGrupo"
				});
			}

			// Obtém nome do grupo a partir dos argumentos
			const groupName = args.join(" ").trim().toLowerCase();

			// Busca o grupo no banco de dados
			const groups = await this.database.getGroups();
			const group = groups.find((g) => g.name.trim().toLowerCase() === groupName);

			if (!group) {
				return new ReturnMessage({
					chatId,
					content: `❌ Grupo '${groupName}' não encontrado no banco de dados.`
				});
			}

			// Tenta obter informações do chat do grupo
			let chatInfo = null;
			try {
				const chat = await bot.client.getChatById(group.id);
				chatInfo = JSON.stringify(chat, null, 2);
			} catch (chatError) {
				this.logger.error(`Erro ao obter informações do chat ${group.id}:`, chatError);
				chatInfo = `Erro ao obter informações do chat: ${chatError.message}`;
			}

			// Formata os dados do grupo para exibição
			const groupData = JSON.stringify(group, null, 2);

			// Informações resumidas do grupo
			let responseMessage = `*Informações do Grupo: ${group.name}*\n\n`;
			responseMessage += `*ID:* ${group.id}\n`;
			responseMessage += `*Nome de Cadastro:* ${group.name}\n`;
			responseMessage += `*Prefixo:* ${group.prefix ?? "!"}\n`;
			responseMessage += `*Pausado:* ${group.paused ? "Sim" : "Não"}\n`;
			responseMessage += `*Auto STT:* ${group.autoStt ? "Ativado" : "Desativado"}\n`;

			// Informações sobre filtros
			if (group.filters) {
				responseMessage += `\n*Filtros:*\n`;
				responseMessage += `- *NSFW:* ${group.filters.nsfw ? "Ativado" : "Desativado"}\n`;
				responseMessage += `- *Links:* ${group.filters.links ? "Ativado" : "Desativado"}\n`;

				if (group.filters.words && group.filters.words.length > 0) {
					responseMessage += `- *Palavras:* ${group.filters.words.join(", ")}\n`;
				}

				if (group.filters.people && group.filters.people.length > 0) {
					responseMessage += `- *Pessoas:* ${group.filters.people.length} pessoas filtradas\n`;
				}
			}

			// Comandos personalizados
			const commands = await this.database.getCustomCommands(group.id);
			const activeCommands = commands.filter((cmd) => cmd.active && !cmd.deleted);
			responseMessage += `\n*Comandos Personalizados:* ${activeCommands.length}\n`;

			// Resposta completa com os dados em formato JSON
			responseMessage += `\n*Detalhes completos do grupo serão enviados como mensagens separadas.*`;

			// Envia mensagem inicial
			await bot.sendMessage(chatId, responseMessage);

			// Envia dados do banco de dados
			await bot.sendMessage(
				chatId,
				`*Dados do Banco de Dados (group):*\n\n\`\`\`json\n${groupData}\n\`\`\``
			);

			// Envia informações do chat
			await bot.sendMessage(
				chatId,
				`*Dados do Chat API (client.getChatById):*\n\n\`\`\`json\n${chatInfo}\n\`\`\``
			);

			return new ReturnMessage({
				content: "Informações enviadas com sucesso.",
				chatId
			});
		} catch (error) {
			this.logger.error("Erro no comando getGroupInfo:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: `❌ Erro ao processar comando: ${error.message}`
			});
		}
	}

	async globalStreamRefresh(bot, message, args) {
		try {
			if (!this.isSuperAdmin(message.author)) return;

			const StreamSystem = require("../StreamSystem");
			const streamSystem = StreamSystem.getInstance();

			await streamSystem.refreshAllGroups();

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "✅ O status de bots para transmissões foi resetado em TODOS os grupos do sistema."
			});
		} catch (error) {
			this.logger.error("Erro no comando globalStreamRefresh:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao realizar o refresh global de streams."
			});
		}
	}

	async runDossieAnalysis(bot, message, args) {
		const chatId = message.group ?? message.author;
		try {
			if (!this.isSuperAdmin(message.author)) return;

			const targetChatId =
				args[0] || (message.quotedMsg ? message.quotedMsg.group || message.quotedMsg.author : null);

			if (!targetChatId) {
				return new ReturnMessage({
					chatId,
					content:
						"❌ Por favor informado o ID do grupo ou responda a uma mensagem do grupo. Uso: !sa-dossie idGrupo"
				});
			}

			const SummaryCommands = require("../functions/SummaryCommands");

			// Busca o texto pendente no banco de dados (tabela de status)
			const dossierStatus = await this.database.dbGet(
				"summaries",
				"SELECT pending_text FROM group_dossier_status WHERE group_id = ?",
				[targetChatId]
			);

			if (!dossierStatus || !dossierStatus.pending_text) {
				return new ReturnMessage({
					chatId,
					content: `⚠️ Não há texto pendente para análise no grupo ${targetChatId}.`
				});
			}

			// Dispara a análise
			await SummaryCommands.runGroupAnalysis(targetChatId, dossierStatus.pending_text, bot);

			return new ReturnMessage({
				chatId,
				content: `✅ Análise de dossiê disparada com sucesso para o grupo ${targetChatId}. Aguarde alguns segundos para ver o resultado no dashboard.`
			});
		} catch (error) {
			this.logger.error("Erro no comando runDossieAnalysis:", error);

			return new ReturnMessage({
				chatId,
				content: `❌ Erro ao disparar análise: ${error.message}`
			});
		}
	}

	async addElogioSticker(bot, message, args) {
		return await this.saveSillySticker(bot, message, "elogios", "botbom");
	}

	async addXingamentoSticker(bot, message, args) {
		return await this.saveSillySticker(bot, message, "xingamentos", "botruim");
	}

	async saveSillySticker(bot, message, category, prefix) {
		const chatId = message.group ?? message.author;
		try {
			if (!this.isSuperAdmin(message.author)) return;

			const quotedMsg = await message.origin.getQuotedMessage();
			if (!quotedMsg || quotedMsg.type !== "sticker") {
				return new ReturnMessage({
					chatId,
					content: "❌ Por favor, use este comando em resposta a um sticker."
				});
			}

			const media = await quotedMsg.downloadMedia();
			if (!media) {
				return new ReturnMessage({
					chatId,
					content: "❌ Não consegui baixar o sticker."
				});
			}

			const folder = path.join(__dirname, "../../data/sillies", category);
			await fs.mkdir(folder, { recursive: true });

			// Find next index
			const files = await fs.readdir(folder);
			let nextIndex = 0;
			const regex = new RegExp(`^${prefix}_(\\d+)\\.webp$`);

			files.forEach((f) => {
				const match = f.match(regex);
				if (match) {
					const idx = parseInt(match[1]);
					if (idx >= nextIndex) nextIndex = idx + 1;
				}
			});

			const fileName = `${prefix}_${nextIndex}.webp`;
			const filePath = path.join(folder, fileName);

			await fs.writeFile(filePath, Buffer.from(media.data, "base64"));
			this.logger.info(`Sticker salvo: ${filePath}`);

			return new ReturnMessage({
				chatId,
				content: `✅ Sticker adicionado em *${category}* como _${fileName}_`
			});
		} catch (error) {
			this.logger.error(`Erro ao salvar sticker silly (${category}):`, error);
			return new ReturnMessage({
				chatId,
				content: `❌ Erro: ${error.message}`
			});
		}
	}

	/**
	 * Força checkpoint de WAL em disco e valida a integridade de todos os bancos de dados
	 */
	async dumpDbs(bot, message, args) {
		const chatId = message.group ?? message.author;
		try {
			if (!this.isSuperAdmin(message.author)) return;

			await bot.sendMessage(
				chatId,
				"⏳ Iniciando checkpoint de WAL e verificação de integridade em todos os bancos de dados..."
			);

			const sqlitesDir = path.join(this.dataPath, "sqlites");
			if (!require("fs").existsSync(sqlitesDir)) {
				return new ReturnMessage({
					chatId,
					content: "❌ Pasta 'sqlites' não existe localmente."
				});
			}

			const files = require("fs").readdirSync(sqlitesDir);
			const dbFiles = files.filter((f) => f.endsWith(".db") && f !== "cooldowns.db");

			const results = [];
			const BetterSQLite = require("better-sqlite3");

			for (const dbFile of dbFiles) {
				const dbName = dbFile.replace(".db", "");
				const dbPath = path.join(sqlitesDir, dbFile);
				let conn = null;
				let wasOpen = false;

				try {
					// 1. Obter ou abrir conexão
					if (this.database.mappers && this.database.mappers.connections[dbName]) {
						conn = this.database.mappers.connections[dbName];
						wasOpen = true;
					} else {
						conn = new BetterSQLite(dbPath);
						wasOpen = false;
					}

					// 2. Executar Checkpoint (forçar mesclagem de WAL em disco)
					conn.pragma("wal_checkpoint(TRUNCATE)");

					// 3. Executar Integrity Check
					const integrityRows = conn.pragma("integrity_check");
					const isOk =
						Array.isArray(integrityRows) &&
						integrityRows.length === 1 &&
						integrityRows[0].integrity_check === "ok";

					results.push({
						name: dbFile,
						checkpoint: "OK",
						integrity: isOk ? "SAUDÁVEL" : `CORROMPIDO (${JSON.stringify(integrityRows)})`
					});

					// Fechar conexão se abrimos temporariamente
					if (!wasOpen) {
						conn.close();
					}
				} catch (err) {
					results.push({
						name: dbFile,
						checkpoint: "ERRO",
						integrity: `FALHA AO ABRIR/EXECUTAR (${err.message})`
					});
				}
			}

			// Formata relatório final
			let response = "📊 *Relatório do Dump de Bancos de Dados*\n\n";
			let hasError = false;

			results.forEach((res) => {
				const statusIcon = res.integrity === "SAUDÁVEL" ? "🟢" : "🔴";
				response += `${statusIcon} *${res.name}*:\n`;
				response += `  - Checkpoint (WAL): ${res.checkpoint}\n`;
				response += `  - Integridade: ${res.integrity}\n\n`;
				if (res.integrity !== "SAUDÁVEL") {
					hasError = true;
				}
			});

			if (hasError) {
				response +=
					"⚠️ *Atenção:* Foram detectados problemas de integridade em alguns bancos de dados!";
			} else {
				response += "✅ Todos os bancos de dados foram gravados em disco e estão saudáveis!";
			}

			return new ReturnMessage({
				chatId,
				content: response
			});
		} catch (error) {
			this.logger.error("Erro no comando dumpDbs:", error);
			return new ReturnMessage({
				chatId,
				content: `❌ Erro geral ao executar dump e verificação: ${error.message}`
			});
		}
	}

	async removeUserGp(bot, message, args) {
		const chatId = message.group ?? message.author;
		try {
			if (!this.isSuperAdmin(message.author)) {
				return new ReturnMessage({
					chatId,
					content: "⛔ Apenas super administradores podem usar este comando."
				});
			}

			if (args.length < 2) {
				return new ReturnMessage({
					chatId,
					content: "Uso incorreto. Exemplo: !sa-removeUserGp 123456789@g.us 55999999999"
				});
			}

			let groupJid = args[0].trim();
			let targetJid = args[1].trim();

			// Normaliza groupJid se necessário
			if (!groupJid.endsWith("@g.us")) {
				groupJid = `${groupJid.split("@")[0]}@g.us`;
			}

			// Normaliza targetJid
			if (!targetJid.includes("@")) {
				targetJid = `${targetJid.replace(/\D/g, "")}@s.whatsapp.net`;
			}

			// Tenta buscar o chat
			const chat = await bot.client.getChatById(groupJid);
			if (!chat || chat.notInGroup) {
				return new ReturnMessage({
					chatId,
					content: "❌ Grupo não encontrado ou o bot não está nele."
				});
			}

			// Tenta remover
			await chat.removeParticipants([targetJid]);

			return new ReturnMessage({
				chatId,
				content: `✅ Solicitação de remoção de '${targetJid}' do grupo '${groupJid}' enviada com sucesso.`
			});
		} catch (error) {
			this.logger.error("Erro no comando removeUserGp:", error);
			return new ReturnMessage({
				chatId,
				content: `❌ Erro ao remover usuário: ${error.message || JSON.stringify(error)}`
			});
		}
	}

	async addUserGp(bot, message, args) {
		const chatId = message.group ?? message.author;
		try {
			if (!this.isSuperAdmin(message.author)) {
				return new ReturnMessage({
					chatId,
					content: "⛔ Apenas super administradores podem usar este comando."
				});
			}

			if (args.length < 2) {
				return new ReturnMessage({
					chatId,
					content: "Uso incorreto. Exemplo: !sa-addUserGp 123456789@g.us 55999999999"
				});
			}

			let groupJid = args[0].trim();
			let targetJid = args[1].trim();

			// Normaliza groupJid se necessário
			if (!groupJid.endsWith("@g.us")) {
				groupJid = `${groupJid.split("@")[0]}@g.us`;
			}

			// Normaliza targetJid
			if (!targetJid.includes("@")) {
				targetJid = `${targetJid.replace(/\D/g, "")}@s.whatsapp.net`;
			}

			// Tenta buscar o chat
			const chat = await bot.client.getChatById(groupJid);
			if (!chat || chat.notInGroup) {
				return new ReturnMessage({
					chatId,
					content: "❌ Grupo não encontrado ou o bot não está nele."
				});
			}

			// Tenta adicionar
			await chat.addParticipants([targetJid]);

			return new ReturnMessage({
				chatId,
				content: `✅ Solicitação de adição de '${targetJid}' no grupo '${groupJid}' enviada com sucesso.`
			});
		} catch (error) {
			this.logger.error("Erro no comando addUserGp:", error);
			return new ReturnMessage({
				chatId,
				content: `❌ Erro ao adicionar usuário: ${error.message || JSON.stringify(error)}`
			});
		}
	}
}

module.exports = SuperAdmin;
