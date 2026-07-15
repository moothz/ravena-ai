const fs = require("fs").promises;
const path = require("path");
const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const AdminUtils = require("../utils/AdminUtils");
const NSFWPredict = require("../utils/NSFWPredict");
const ReturnMessage = require("../models/ReturnMessage");
const Command = require("../models/Command");
const WebManagement = require("../utils/WebManagement");
const StreamSystem = require("../StreamSystem");

class Management {
	constructor() {
		this.logger = new Logger("management");
		this.database = Database.getInstance();
		this.nsfwPredict = NSFWPredict.getInstance();
		this.dataPath = this.database.databasePath;
		this.adminUtils = AdminUtils.getInstance();

		// Mapeamento de comando para método
		this.commandMap = {
			setNome: {
				method: "setGroupName",
				description: "ID/Nome do grupo (nome stickers, gerenciamento)"
			},
			setPrefixo: {
				method: "setCustomPrefix",
				description: "Altera o prefixo de comandos do *grupo* (padrão !)"
			},

			setCustomSemPrefixo: {
				method: "setCustomSemPrefixo",
				description: "Faz com que comandos personalizados não precisem de prefixo"
			},

			setBoasvindas: {
				method: "setWelcomeMessage",
				description:
					"Mensagem quando alguém entra no grupo. Você pode usar as variáveis {pessoa} e {tituloGrupo}, além de todas as variáveis disponíveis em !g-variaveis, assim como no !g-addCmd"
			},
			delBoasvindas: {
				method: "deleteWelcomeMessage",
				description:
					"Remove um tipo de mídia específico da mensagem de boas-vindas (text, image, audio, video, sticker)"
			},
			setDespedida: {
				method: "setFarewellMessage",
				description: "Mensagem quando alguém sai do grupo"
			},
			delDespedida: {
				method: "deleteFarewellMessage",
				description:
					"Remove um tipo de mídia específico da mensagem de despedida (text, image, audio, video, sticker)"
			},
			autoStt: {
				method: "toggleAutoStt",
				description: "Ativa/desativa conversão automática de voz para texto"
			},
			info: {
				method: "showGroupInfo",
				description: "Mostra informações detalhadas do grupo (debug)"
			},
			manage: {
				method: "manageCommand",
				description: "Ativa o gerenciamento do grupo pelo PV do bot"
			},
			setAutoTranslate: {
				method: "setAutoTranslate",
				description:
					"Define o idioma para tradução automática de todas as respostas do bot (Ex: Spanish (ES))"
			},

			// Controles de comandos personalizados
			addCmd: {
				method: "addCustomCommand",
				description: "Cria um comando personalizado"
			},
			addCmdReply: {
				method: "addCustomCommandReply",
				description: "Adiciona outra resposta a um comando existente"
			},
			delCmd: {
				method: "deleteCustomCommand",
				description: "Exclui um comando personalizado"
			},

			"cmd-enable": {
				method: "enableCustomCommand",
				description: "Habilita comando (comandos personalizados)"
			},
			"cmd-disable": {
				method: "disableCustomCommand",
				description: "Desabilita comando (comandos personalizados)"
			},
			"cmd-setPV": {
				method: "setCustomCommandInPv",
				description: "A resposta do comando será enviada no PV (comandos personalizados)"
			},
			"cmd-enviarTudo": {
				method: "toggleSendAllResponses",
				description: "Envia todas as respostas do comando (se houver mais de uma)"
			},
			"cmd-responder": {
				method: "toggleReply",
				description: "Ativa/Desativa se o comando deve responder citando a mensagem"
			},
			"cmd-react": {
				method: "setReaction",
				description: "Reaçao quando usar o comando"
			},
			"cmd-startReact": {
				method: "setStartReaction",
				description: "Reaçao pré-comando (útil para APIs, como loading)"
			},
			"cmd-setAdm": {
				method: "setCmdAdmin",
				description: "Define que apenas admins podem usar um comando"
			},
			"cmd-setInteragir": {
				method: "setCmdInteragir",
				description: "Define que comando seja usado nas interações aleatórias"
			},
			"cmd-cd": {
				method: "setCmdCooldown",
				description:
					"Define o cooldown (em segundos) de um comando personalizado. Uso: !g-cmd-cd <comando> <segundos>"
			},
			"cmd-setHoras": {
				method: "setCmdAllowedHours",
				description: "Define horários permitidos para um comando"
			},
			"cmd-setDias": {
				method: "setCmdAllowedDays",
				description: "Define dias permitidos para um comando"
			},
			"filtro-palavra": {
				method: "filterWord",
				description: "Detecta e Apaga mensagens com a palavra/frase especificada"
			},
			"filtro-links": {
				method: "filterLinks",
				description: "Detecta e Apaga mensagens com links"
			},
			"filtro-pessoa": {
				method: "filterPerson",
				description: "Detecta e Apaga mensagens desta pessoa (Marcar com @)"
			},
			"filtro-nsfw": {
				method: "filterNSFW",
				description: "Detecta e Apaga mensagens NSFW"
			},
			// 'apelido': {
			//   method: 'setUserNickname',
			//   description: 'Define apelido de *outro membro* no grupo'
			// },
			ignorar: {
				method: "ignoreUser",
				description: "O bot irá ignorar as mensagens desta pessoa"
			},
			mute: {
				method: "muteCommand",
				description: "Desativa/ativa comando com a palavra especificada"
			},
			muteCategoria: {
				method: "toggleMuteCategory",
				description: "Desativa/ativa todos os comandos da categoria especificada"
			},
			customAdmin: {
				method: "customAdmin",
				description: "Adiciona pessoas como administradoras fixas do bot no grupo"
			},
			pausar: {
				method: "pauseGroup",
				description: "Pausa/retoma a atividade do bot no grupo"
			},
			interagir: {
				method: "toggleInteraction",
				description: "Ativa/desativa interações automáticas do bot"
			},
			"interagir-cmd": {
				method: "toggleCmdInteraction",
				description: "Ativa/desativa interações automáticas do bot usando comandos do grupo"
			},
			"interagir-cd": {
				method: "setInteractionCooldown",
				description: "Define o tempo de espera entre interações automáticas"
			},
			"interagir-chance": {
				method: "setInteractionChance",
				description: "Define a chance de ocorrer interações automáticas"
			},
			"interagir-proporcao": {
				method: "setInteractionProportion",
				description: "Define a proporção entre comandos e IA para interações automáticas"
			},
			ban: {
				method: "banUser",
				description: "Remove membros mencionados do grupo",
				hidden: true
			},
			block: {
				method: "blockGroupUser",
				description: "Remove membros mencionados do grupo e impede reentrada",
				hidden: true
			},
			fechar: {
				method: "closeGroup",
				description: "Fecha o grupo (apenas admins enviam msgs)"
			},
			abrir: {
				method: "openGroup",
				description: "Abre o grupo (todos podem envar msgs)"
			},
			"notificar-grupoFechado": {
				method: "toggleNotificaGrupoFechado",
				description: "Ativa/desativa a notificação quando o grupo é fechado"
			},
			"notificar-grupoAberto": {
				method: "toggleNotificaGrupoAberto",
				description: "Ativa/desativa a notificação quando o grupo é aberto"
			},
			setPersonalidade: {
				method: "setPersonalidadeIA",
				description: "Define uma personalidade para os comandos de IA (max. 1500 caracteres)"
			},
			setApelido: {
				method: "setUserNicknameAdmin",
				description: "Define apelido de *outro membro* no grupo (@marcar_pessoa)"
			},
			"twitch-canal": {
				method: "toggleTwitchChannel",
				description: "Adiciona/remove canal da Twitch para monitoramento"
			},
			"twitch-mudarTitulo": {
				method: "toggleTwitchTitleChange",
				description: "Ativa/desativa mudança de título do grupo para eventos da Twitch"
			},
			"twitch-titulo": {
				method: "setTwitchTitle",
				description: "Define título do grupo para eventos de canal da Twitch"
			},
			"twitch-fotoGrupo": {
				method: "setTwitchGroupPhoto",
				description: "Define foto do grupo para eventos de canal da Twitch"
			},
			"twitch-midia": {
				method: "setTwitchMedia",
				description: "Define mídia para notificação de canal da Twitch"
			},
			"twitch-midia-del": {
				method: "deleteTwitchMedia",
				description: "Remove mídia específica da notificação de canal da Twitch"
			},
			"twitch-usarIA": {
				method: "toggleTwitchAI",
				description: "Ativa/desativa uso de IA para gerar mensagens de notificação"
			},
			"twitch-usarThumbnail": {
				method: "toggleTwitchThumbnail",
				description: "Ativa/desativa o envio da thumbnail da stream junto com o texto"
			},
			"twitch-marcar": {
				method: "toggleTwitchMentions",
				description: "Ativa/desativa menção a todos os membros nas notificações de canal da Twitch"
			},
			"kick-canal": {
				method: "toggleKickChannel",
				description: "Adiciona/remove canal do Kick para monitoramento"
			},
			"kick-mudarTitulo": {
				method: "toggleKickTitleChange",
				description: "Ativa/desativa mudança de título do grupo para eventos do Kick"
			},
			"kick-titulo": {
				method: "setKickTitle",
				description: "Define título do grupo para eventos de canal do Kick"
			},
			"kick-fotoGrupo": {
				method: "setKickGroupPhoto",
				description: "Define foto do grupo para eventos de canal do Kick"
			},
			"kick-midia": {
				method: "setKickMedia",
				description: "Define mídia para notificação de canal do Kick"
			},
			"kick-midia-del": {
				method: "deleteKickMedia",
				description: "Remove mídia específica da notificação de canal do Kick"
			},
			"kick-usarIA": {
				method: "toggleKickAI",
				description: "Ativa/desativa uso de IA para gerar mensagens de notificação"
			},
			"kick-usarThumbnail": {
				method: "toggleKickThumbnail",
				description: "Ativa/desativa o envio da thumbnail da stream junto com o texto"
			},
			"kick-marcar": {
				method: "toggleKickMentions",
				description: "Ativa/desativa menção a todos os membros nas notificações de canal do Kick"
			},
			"youtube-canal": {
				method: "toggleYoutubeChannel",
				description: "Adiciona/remove canal do YouTube para monitoramento"
			},
			"youtube-mudarTitulo": {
				method: "toggleYoutubeTitleChange",
				description: "Ativa/desativa mudança de título do grupo para eventos do YouTube"
			},
			"youtube-titulo": {
				method: "setYoutubeTitle",
				description: "Define título do grupo para eventos de canal do YouTube"
			},
			"youtube-fotoGrupo": {
				method: "setYoutubeGroupPhoto",
				description: "Define foto do grupo para eventos de canal do YouTube"
			},
			"youtube-midia": {
				method: "setYoutubeMedia",
				description: "Define mídia para notificação de canal do YouTube"
			},
			"youtube-midia-del": {
				method: "deleteYoutubeMedia",
				description: "Remove mídia específica da notificação de canal do YouTube"
			},
			"youtube-usarIA": {
				method: "toggleYoutubeAI",
				description: "Ativa/desativa uso de IA para gerar mensagens de notificação"
			},
			"youtube-usarThumbnail": {
				method: "toggleYoutubeThumbnail",
				description: "Ativa/desativa o envio da thumbnail da stream junto com o texto"
			},
			"youtube-marcar": {
				method: "toggleYoutubeMentions",
				description: "Ativa/desativa menção a todos os membros nas notificações de canal do YouTube"
			},
			variaveis: {
				method: "listVariables",
				description: "Lista todas as variáveis disponíveis para comandos personalizados"
			},
			painel: {
				method: "generatePainelCommand",
				description: "Gera um link para gerenciar o bot via web"
			},
			setWebhook: {
				method: "setWebhook",
				description: "Cria ou atualiza um webhook para este grupo"
			},
			delWebhook: {
				method: "delWebhook",
				description: "Apaga um webhook deste grupo"
			},
			advertir: {
				method: "advertirUser",
				description: "Adiciona uma advertência aos membros mencionados"
			},
			advertencias: {
				method: "listWarnings",
				description: "Lista as advertências atuais do grupo"
			},
			"limpar-advertencias": {
				method: "clearWarnings",
				description: "Remove as advertências dos membros mencionados"
			},
			streamRefresh: {
				method: "streamRefresh",
				description: "Reseta a lista de bots ativos/ignorados para as notificações de stream"
			},
			dossie: {
				method: "runDossieAnalysis",
				description: "Exibe o histórico de dossiês deste grupo"
			},
			copiarCmds: {
				method: "copyCommands",
				description: "Copia os comandos do grupoOrigem pro grupoDestino"
			}
		};

		this.help = {
			naoEncontrado:
				"\n\n> Dica: Você só pode alterar comandos *criados* neste grupo, não os fixos do bot. Você pode silenciar o comando original (!g-mute pesca) e criar um atalho com nome diferente para o seu (Ex.: !g-addCmd peska {cmd-pesca})"
		};
	}

	/**
	 * Obtém a lista de comandos de gerenciamento e suas descrições
	 * @returns {Object} - Objeto com comandos e descrições
	 */
	getCommandMethod(command) {
		return this.commandMap[command]?.method;
	}

	/**
	 * Obtém a lista de comandos de gerenciamento e suas descrições
	 * @returns {Object} - Objeto com comandos e descrições
	 */
	getManagementCommands() {
		const commands = {};

		// Constrói objeto de comandos a partir do commandMap
		for (const [cmdName, cmdData] of Object.entries(this.commandMap)) {
			if (cmdData.hidden) continue;
			commands[cmdName] = {
				description: cmdData.description ?? "Sem descrição disponível",
				method: cmdData.method
			};
		}

		return commands;
	}

	async setAutoTranslate(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length === 0) {
			group.autoTranslateTo = false;
			await this.database.saveGroup(group);
			return new ReturnMessage({
				chatId: group.id,
				content: "Tradução automática desativada."
			});
		}

		const targetLanguage = args.join(" ");

		const SUPPORTED_LANGUAGES = [
			"English (EN)",
			"Spanish (ES)",
			"Russian (RU)",
			"French (FR)",
			"German (DE)",
			"Italian (IT)",
			"Japanese (JA)",
			"Chinese (ZH)",
			"Korean (KO)",
			"Arabic (AR)",
			"Hindi (HI)",
			"Turkish (TR)",
			"Dutch (NL)",
			"Polish (PL)",
			"Indonesian (ID)",
			"Vietnamese (VI)",
			"Thai (TH)"
		];

		if (!SUPPORTED_LANGUAGES.some((lang) => lang.toLowerCase() === targetLanguage.toLowerCase())) {
			return new ReturnMessage({
				chatId: group.id,
				content: `❌ Idioma não suportado ou formato inválido.\n\nEscolha um da lista: ${SUPPORTED_LANGUAGES.join(", ")}`
			});
		}

		// Normaliza para o nome correto (com caps do array)
		const normalizedLang = SUPPORTED_LANGUAGES.find(
			(lang) => lang.toLowerCase() === targetLanguage.toLowerCase()
		);

		group.autoTranslateTo = normalizedLang;
		await this.database.saveGroup(group);

		return new ReturnMessage({
			chatId: group.id,
			content: `O bot agora irá tentar traduzir todas as mensagens para '${normalizedLang}'.`
		});
	}

	/**
	 * Substituto para hasMedia
	 * @param {Message} message - Objeto msg do wwebjs
	 * @returns {bool|null} - Tem ou não
	 */
	isMediaMsg(message) {
		return ["audio", "voice", "image", "video", "document", "sticker"].some(
			(t) => message.type.toLowerCase() == t
		);
	}

	/**
	 * Define nome do grupo
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async setGroupName(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length === 0) {
			return new ReturnMessage({
				chatId: group.id,
				content: "Por favor, forneça um novo nome para o grupo. Exemplo: !g-setName NovoNomeGrupo"
			});
		}

		const rawName = args[0].trim(); // Apenas o primeiro argumento (sem espaços) trimmed

		// Valida: apenas letras, números, _, - e . ; entre 1 e 30 caracteres
		if (!/^[a-zA-Z0-9_\-.]{1,30}$/.test(rawName)) {
			return new ReturnMessage({
				chatId: group.id,
				content: `❌ Nome inválido. O nome deve conter apenas letras, números, _, - e ., sem espaços, com no máximo 30 caracteres. Exemplo: !g-setName meuGrupo_01`
			});
		}

		const newName = rawName.toLowerCase();

		const grupoExistente = await this.database.getGroupByName(newName);

		if (grupoExistente) {
			this.logger.info(
				`[setGroupName] ${message.author} tentou renomear grupo '${group.name}' para '${newName}', mas já existe um!`,
				[group, grupoExistente]
			);
			return new ReturnMessage({
				chatId: group.id,
				content: `Já existe um grupo chamado '${newName}', por favor, escolha outro nome.`
			});
		}

		// Atualiza nome do grupo no banco de dados
		group.name = newName;
		await this.database.saveGroup(group);

		return new ReturnMessage({
			chatId: group.id,
			content: `Nome do grupo atualizado para: ${group.name}`
		});
	}

	/**
	 * Adiciona um comando personalizado
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async addCustomCommand(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length === 0) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					"Por favor, forneça um gatilho para o comando personalizado. Exemplo: !g-addCmd saudação"
			});
		}

		let commandTrigger = args.join(" ").trim().toLowerCase();

		// Verifica se a mensagem é uma resposta
		const quotedMsg = await message.origin.getQuotedMessage();

		let bodyTexto;
		if (!quotedMsg) {
			if (args.length > 1) {
				// Tem argumetnos, tenta pegar o body pra incluir quebras de linha
				if (message.origin && message.origin.body) {
					// Extrai o texto após o comando
					const prefixo = group.prefix ?? "!";
					commandTrigger = args[0].trim();
					const comandoCompleto = `${prefixo}g-addCmd ${commandTrigger}`;
					bodyTexto = message.origin.body
						.substring(message.origin.body.indexOf(comandoCompleto) + comandoCompleto.length)
						.trim();
				} else {
					this.logger.info(
						`[addCmd] Não consegui pegar o body de mensagem, vou usar os args mesmo.`
					);
					bodyTexto = args.slice(1).join(" ");
					commandTrigger = args[0].trim();
				}
			} else {
				return new ReturnMessage({
					chatId: group.id,
					content: "Este comando deve ser usado como resposta a uma mensagem."
				});
			}
		} else {
			bodyTexto = quotedMsg.caption ?? quotedMsg.content ?? quotedMsg.body ?? quotedMsg._data.body;
		}

		const prefix = (group.prefix || "!").trim();
		if (commandTrigger.startsWith(prefix)) {
			commandTrigger = commandTrigger.substring(prefix.length).trim();
		} else if (prefix !== "!" && commandTrigger.startsWith("!")) {
			commandTrigger = commandTrigger.substring(1).trim();
		}

		if (!commandTrigger) {
			return new ReturnMessage({
				chatId: group.id,
				content: "⚠️ Por favor, forneça um gatilho de comando válido."
			});
		}

		if (commandTrigger.split(/\s+/).length > 10) {
			return new ReturnMessage({
				chatId: group.id,
				content: "O gatilho do comando não pode ter mais de 10 palavras."
			});
		}

		// Obtém o conteúdo da mensagem citada
		let responseContent = false;

		// Trata mensagens de mídia
		if (quotedMsg?.hasMedia) {
			this.logger.info(`tem mídia, baixando...`);
			const caption = quotedMsg.caption ?? quotedMsg._data?.caption;
			try {
				const media = await quotedMsg.downloadMedia({ keep: true });
				let mediaType = media.mimetype.split("/")[0]; // 'image', 'audio', 'video', etc.

				if (quotedMsg.type.toLowerCase() == "sticker") {
					mediaType = "sticker";
				}

				if (quotedMsg.type.toLowerCase() == "voice") {
					mediaType = "voice";
				}

				const isGif =
					quotedMsg.content?._mediaDetails?.gifPlayback === true ||
					quotedMsg._mediaDetails?.gifPlayback === true ||
					quotedMsg.isGif === true ||
					media.mimetype === "image/gif";

				if (isGif) {
					mediaType = "gif";
				}

				// 2 casos: sticker animado ou resto
				// Sticker animado preciso salvar o gif na pasta public pra poder ser enviado

				if (media.stickerGif) {
					this.logger.info(`Arquivo de mídia já existia como stickerGIF: ${media.stickerGif}`);
					responseContent = `{stickerGif-${media.stickerGif}}`;
				} else {
					// Gera nome de arquivo com extensão apropriada
					let fileExt = media.mimetype.split("/")[1];
					if (fileExt.includes(";")) {
						fileExt = fileExt.split(";")[0];
					}
					const fileName = `${Date.now()}-${Math.floor(Math.random() * 1000)}.${fileExt}`;

					// Cria diretório de mídia se não existir
					const mediaDir = path.join(this.dataPath, "media");
					await fs.mkdir(mediaDir, { recursive: true });

					// Salva arquivo de mídia (sem base64 na resposta)
					const filePath = path.join(mediaDir, fileName);
					await fs.writeFile(filePath, Buffer.from(media.data, "base64"));

					this.logger.info(`Arquivo de mídia salvo para comando: ${filePath}`);

					// Formata a resposta adequadamente para sendCustomCommandResponse
					// Este é o formato: {mediaType-fileName} Caption
					responseContent = `{${mediaType}-${fileName}}${caption ? " " + caption : ""}`;
				}
			} catch (error) {
				this.logger.error("Erro ao salvar mídia para comando personalizado:", error);
				return new ReturnMessage({
					chatId: group.id,
					content: "Erro ao salvar mídia para comando personalizado."
				});
			}
		} else {
			responseContent = bodyTexto;
		}

		// Obtém menções da mensagem citada
		const mentions = quotedMsg ? quotedMsg.mentions || [] : [];

		// Cria o comando personalizado
		const customCommand = {
			startsWith: commandTrigger,
			responses: [responseContent],
			adminOnly: false,
			ignoreInteract: false,
			sendAllResponses: false,
			mentions,
			cooldown: 0,
			react: null,
			reply: true,
			count: 0,
			metadata: {
				createdBy: message.author,
				createdAt: Date.now()
			},
			active: true,
			deleted: false
		};

		// Salva o comando personalizado
		await this.database.saveCustomCommand(group.id, customCommand);

		// Limpa cache de comandos para garantir que o novo comando seja carregado
		this.database.clearCache(`commands:${group.id}`);

		// Recarrega comandos
		await bot.eventHandler.commandHandler.loadCustomCommandsForGroup(group.id);

		let content = `Comando personalizado '${commandTrigger}' adicionado com sucesso.`;

		if (mentions.length > 0) {
			content += `\n\nEstes membros serão mencionados na mensagem:\n`;
			mentions.forEach((m) => {
				// Formata para mostrar apenas o número, se possível
				const num = m.split("@")[0];
				content += `- @${num}\n`;
			});
		}

		return new ReturnMessage({
			chatId: group.id,
			content,
			options: {
				mentions // Menciona eles na mensagem de confirmação também
			}
		});
	}

	/**
	 * Adiciona uma resposta a um comando personalizado existente
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async addCustomCommandReply(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length === 0) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					"Por favor, forneça o comando para adicionar uma resposta. Exemplo: !g-addCmdReply saudação"
			});
		}

		let commandTrigger = args.join(" ").trim().toLowerCase();

		const quotedMsg = await message.origin.getQuotedMessage();

		let bodyTexto;
		if (!quotedMsg) {
			if (args.length > 1) {
				// Tem argumetnos, tenta pegar o body pra incluir quebras de linha
				if (message.origin && message.origin.body) {
					// Extrai o texto após o comando
					const prefixo = group.prefix ?? "!";
					commandTrigger = args[0].trim();
					const comandoCompleto = `${prefixo}g-addCmdReply ${commandTrigger}`;
					bodyTexto = message.origin.body
						.substring(message.origin.body.indexOf(comandoCompleto) + comandoCompleto.length)
						.trim();
				} else {
					this.logger.info(
						`[addCmdReply] Não consegui pegar o body de mensagem, vou usar os args mesmo.`
					);
					bodyTexto = args.slice(1).join(" ");
					commandTrigger = args[0].trim();
				}
			} else {
				return new ReturnMessage({
					chatId: group.id,
					content: "Este comando deve ser usado como resposta a uma mensagem."
				});
			}
		} else {
			bodyTexto = quotedMsg.caption ?? quotedMsg.content ?? quotedMsg.body ?? quotedMsg._data.body;
		}
		const prefix = (group.prefix || "!").trim();
		if (commandTrigger.startsWith(prefix)) {
			commandTrigger = commandTrigger.substring(prefix.length).trim();
		} else if (prefix !== "!" && commandTrigger.startsWith("!")) {
			commandTrigger = commandTrigger.substring(1).trim();
		}

		if (!commandTrigger) {
			return new ReturnMessage({
				chatId: group.id,
				content: "⚠️ Por favor, forneça um gatilho de comando válido."
			});
		}

		// MELHORIA: Usa o comando completo como gatilho em vez de apenas a primeira palavra

		// Obtém comandos personalizados para este grupo
		const commands = await this.database.getCustomCommands(group.id);
		const command = commands.find(
			(cmd) => cmd.startsWith?.trim() === commandTrigger && !cmd.deleted
		);

		if (!command) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Comando personalizado '${commandTrigger}' não encontrado.`
			});
		}

		// Obtém o conteúdo da mensagem citada
		let responseContent = bodyTexto;

		// Trata mensagens de mídia
		if (quotedMsg?.hasMedia) {
			try {
				const media = await quotedMsg.downloadMedia({ keep: true });
				let mediaType = media.mimetype.split("/")[0]; // 'image', 'audio', 'video', etc.

				if (quotedMsg.type.toLowerCase() == "sticker") {
					mediaType = "sticker";
				}
				if (quotedMsg.type.toLowerCase() == "voice") {
					mediaType = "voice";
				}

				const isGif =
					quotedMsg.content?._mediaDetails?.gifPlayback === true ||
					quotedMsg._mediaDetails?.gifPlayback === true ||
					quotedMsg.isGif === true ||
					media.mimetype === "image/gif";

				if (isGif) {
					mediaType = "gif";
				}

				if (media.stickerGif) {
					this.logger.info(`Arquivo de mídia já existia como stickerGIF: ${media.stickerGif}`);
					responseContent = `{stickerGif-${media.stickerGif}}`;
				} else {
					// Gera nome de arquivo com extensão apropriada
					let fileExt = media.mimetype.split("/")[1];
					if (fileExt.includes(";")) {
						fileExt = fileExt.split(";")[0];
					}
					const fileName = `${Date.now()}-${Math.floor(Math.random() * 1000)}.${fileExt}`;

					// Cria diretório de mídia se não existir
					const mediaDir = path.join(this.dataPath, "media");
					await fs.mkdir(mediaDir, { recursive: true });

					// Salva arquivo de mídia
					const filePath = path.join(mediaDir, fileName);
					await fs.writeFile(filePath, Buffer.from(media.data, "base64"));

					this.logger.info(`Arquivo de mídia salvo para resposta de comando: ${filePath}`);

					// Formata a resposta adequadamente para sendCustomCommandResponse
					responseContent = `{${mediaType}-${fileName}}${quotedMsg.caption ? " " + quotedMsg.caption : ""}`;
				}
			} catch (error) {
				this.logger.error("Erro ao salvar mídia para resposta de comando personalizado:", error);
				return new ReturnMessage({
					chatId: group.id,
					content: "Erro ao salvar mídia para resposta de comando personalizado."
				});
			}
		}

		// Adiciona a nova resposta
		if (!command.responses) {
			command.responses = [];
		}
		command.responses.push(responseContent);

		// Atualiza o comando
		await this.database.updateCustomCommand(group.id, command);

		// Limpa cache de comandos para garantir que o comando atualizado seja carregado
		this.database.clearCache(`commands:${group.id}`);

		// Recarrega comandos
		await bot.eventHandler.commandHandler.loadCustomCommandsForGroup(group.id);

		return new ReturnMessage({
			chatId: group.id,
			content: `Adicionada nova resposta ao comando personalizado '${commandTrigger}'.`
		});
	}

	/**
	 * Exclui um comando personalizado
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async deleteCustomCommand(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length === 0) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					"Por favor, forneça o comando personalizado a ser excluído. Exemplo: !g-delCmd saudação"
			});
		}

		const commandTrigger = args.join(" ").trim().toLowerCase();

		// Obtém comandos personalizados para este grupo
		const commands = await this.database.getCustomCommands(group.id);
		const command = commands.find(
			(cmd) => cmd.startsWith?.trim()?.toLowerCase() === commandTrigger && !cmd.deleted
		);

		if (!command) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Comando personalizado '${commandTrigger}' não encontrado.`
			});
		}

		// Marca comando como excluído
		command.deleted = true;
		command.active = false;

		// Atualiza o comando
		await this.database.updateCustomCommand(group.id, command);

		// Limpa cache de comandos para garantir que o comando atualizado seja carregado
		this.database.clearCache(`commands:${group.id}`);

		// Recarrega comandos
		await bot.eventHandler.commandHandler.loadCustomCommandsForGroup(group.id);

		return new ReturnMessage({
			chatId: group.id,
			content: `Comando personalizado '${commandTrigger}' excluído.`
		});
	}

	/**
	 * Habilita um comando personalizado
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async enableCustomCommand(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		const commandTrigger = args.join(" ").trim().toLowerCase();

		// Obtém comandos personalizados para este grupo
		const commands = await this.database.getCustomCommands(group.id);
		const command = commands.find(
			(cmd) => cmd.startsWith?.trim()?.toLowerCase() === commandTrigger && !cmd.deleted
		);

		if (!command) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Comando personalizado '${commandTrigger}' não encontrado.`
			});
		}

		// Habilita comando
		command.active = true;

		// Atualiza o comando
		await this.database.updateCustomCommand(group.id, command);

		// Limpa cache de comandos para garantir que o comando atualizado seja carregado
		this.database.clearCache(`commands:${group.id}`);

		// Recarrega comandos
		await bot.eventHandler.commandHandler.loadCustomCommandsForGroup(group.id);

		return new ReturnMessage({
			chatId: group.id,
			content: `Comando personalizado '${commandTrigger}' habilitado.`
		});
	}

	/**
	 * Faz com que a resposta do comando personalizado seja enviada no PV da pessoa
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async setCustomCommandInPv(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length === 0) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					"Por favor, forneça o comando personalizado a ser modificado. Exemplo: !g-cmd-setPV saudação"
			});
		}

		const commandTrigger = args.join(" ").trim().toLowerCase();

		// Obtém comandos personalizados para este grupo
		const commands = await this.database.getCustomCommands(group.id);
		const command = commands.find(
			(cmd) => cmd.startsWith?.trim()?.toLowerCase() === commandTrigger && !cmd.deleted
		);

		if (!command) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Comando personalizado '${commandTrigger}' não encontrado.`
			});
		}

		// Toggle entre ser no PV ou não
		command.replyInPvivate = !(command.replyInPvivate ?? false);

		// Atualiza o comando
		await this.database.updateCustomCommand(group.id, command);

		// Limpa cache de comandos para garantir que o comando atualizado seja carregado
		this.database.clearCache(`commands:${group.id}`);

		// Recarrega comandos
		await bot.eventHandler.commandHandler.loadCustomCommandsForGroup(group.id);

		return new ReturnMessage({
			chatId: group.id,
			content: `Comando personalizado '${commandTrigger}' ${command.replyInPvivate ? " agora é respondido no PV da pessoa que solicitou" : " agora é respondido dentro do grupo (padrão)"}.`
		});
	}

	/**
	 * Alterna a opção de enviar todas as respostas do comando
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async toggleSendAllResponses(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length === 0) {
			return new ReturnMessage({
				chatId: group.id,
				content: "Por favor, forneça o comando personalizado. Exemplo: !g-cmd-enviarTudo saudação"
			});
		}

		const commandTrigger = args.join(" ").trim().toLowerCase();

		// Obtém comandos personalizados para este grupo
		const commands = await this.database.getCustomCommands(group.id);
		const command = commands.find(
			(cmd) => cmd.startsWith?.trim()?.toLowerCase() === commandTrigger && !cmd.deleted
		);

		if (!command) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Comando personalizado '${commandTrigger}' não encontrado.`
			});
		}

		// Toggle
		command.sendAllResponses = !command.sendAllResponses;

		// Atualiza o comando
		await this.database.updateCustomCommand(group.id, command);
		this.database.clearCache(`commands:${group.id}`);
		await bot.eventHandler.commandHandler.loadCustomCommandsForGroup(group.id);

		return new ReturnMessage({
			chatId: group.id,
			content: `Comando personalizado '${commandTrigger}' agora ${command.sendAllResponses ? "envia TODAS as respostas" : "envia UMA resposta aleatória"}.`
		});
	}

	/**
	 * Alterna a opção de responder (reply/quote)
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async toggleReply(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length === 0) {
			return new ReturnMessage({
				chatId: group.id,
				content: "Por favor, forneça o comando personalizado. Exemplo: !g-cmd-responder saudação"
			});
		}

		const commandTrigger = args.join(" ").trim().toLowerCase();

		// Obtém comandos personalizados para este grupo
		const commands = await this.database.getCustomCommands(group.id);
		const command = commands.find(
			(cmd) => cmd.startsWith?.trim()?.toLowerCase() === commandTrigger && !cmd.deleted
		);

		if (!command) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Comando personalizado '${commandTrigger}' não encontrado.`
			});
		}

		// Toggle (default is true usually, so undefined = true)
		if (command.reply === undefined) command.reply = true;
		command.reply = !command.reply;

		// Atualiza o comando
		await this.database.updateCustomCommand(group.id, command);
		this.database.clearCache(`commands:${group.id}`);
		await bot.eventHandler.commandHandler.loadCustomCommandsForGroup(group.id);

		return new ReturnMessage({
			chatId: group.id,
			content: `Comando personalizado '${commandTrigger}' agora ${command.reply ? "responde citando a mensagem" : "apenas envia a mensagem (sem quote)"}.`
		});
	}

	/**
	 * Desabilita um comando personalizado
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async disableCustomCommand(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length === 0) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					"Por favor, forneça o comando personalizado a ser desabilitado. Exemplo: !g-cmd-disable saudação"
			});
		}

		const commandTrigger = args.join(" ").trim().toLowerCase();

		// Obtém comandos personalizados para este grupo
		const commands = await this.database.getCustomCommands(group.id);
		const command = commands.find(
			(cmd) => cmd.startsWith?.trim()?.toLowerCase() === commandTrigger && !cmd.deleted
		);

		if (!command) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Comando personalizado '${commandTrigger}' não encontrado.`
			});
		}

		// Desabilita comando
		command.active = false;

		// Atualiza o comando
		await this.database.updateCustomCommand(group.id, command);

		// Limpa cache de comandos para garantir que o comando atualizado seja carregado
		this.database.clearCache(`commands:${group.id}`);

		// Recarrega comandos
		await bot.eventHandler.commandHandler.loadCustomCommandsForGroup(group.id);

		return new ReturnMessage({
			chatId: group.id,
			content: `Comando personalizado '${commandTrigger}' desabilitado.`
		});
	}

	async setCustomSemPrefixo(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Alterna a configuração de auto-STT
		group.customIgnoresPrefix = !group.customIgnoresPrefix;

		// Atualiza grupo no banco de dados
		await this.database.saveGroup(group);

		// Envia mensagem de confirmação
		const statusMsg = group.customIgnoresPrefix
			? "Os comandos personalizados do grupo agora *não precisam* mais do prefixo pra serem ativados."
			: "Os comandos personalizados do grupo agora *precisam* do prefixo para serm ativados _(funcionamento normal)_.";

		return new ReturnMessage({
			chatId: group.id,
			content: statusMsg
		});
	}

	/**
	 * Define prefixo personalizado para um grupo
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async setCustomPrefix(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// MELHORIA: Permite definir prefixo vazio quando não há argumentos
		let newPrefix = "";
		if (args.length > 0) {
			newPrefix = args[0];
		}

		// Atualiza prefixo do grupo
		group.prefix = newPrefix;
		await this.database.saveGroup(group);

		// Mensagem especial para prefixo vazio
		if (newPrefix === "") {
			return new ReturnMessage({
				chatId: group.id,
				content: `Prefixo de comando removido. Qualquer mensagem agora pode ser um comando.`
			});
		} else {
			return new ReturnMessage({
				chatId: group.id,
				content: `Prefixo de comando atualizado para: ${newPrefix}`
			});
		}
	}

	/**
	 * Define mensagem de boas-vindas para um grupo
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async setWelcomeMessage(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Verifica se a mensagem é uma resposta a outra mensagem
		const quotedMsg = await message.origin.getQuotedMessage().catch(() => null);

		// Inicializa objeto de greetings se não existir
		if (!group.greetings) {
			group.greetings = {};
		}

		// Se tiver mensagem citada
		if (quotedMsg) {
			const type = "text";
			const content = quotedMsg.caption ?? quotedMsg.content ?? quotedMsg.body ?? "";

			if (quotedMsg.hasMedia) {
				try {
					const media = await quotedMsg.downloadMedia({ keep: true });
					let mediaType = media.mimetype.split("/")[0]; // 'image', 'audio', 'video', etc.

					if (quotedMsg.type.toLowerCase() == "sticker") {
						mediaType = "sticker";
					}
					if (quotedMsg.type.toLowerCase() == "voice") {
						mediaType = "audio";
					}

					// Gera nome de arquivo com extensão apropriada
					let fileExt = media.mimetype.split("/")[1];
					if (fileExt.includes(";")) {
						fileExt = fileExt.split(";")[0];
					}
					const fileName = `${Date.now()}-${Math.floor(Math.random() * 1000)}.${fileExt}`;

					// Cria diretório de mídia se não existir
					const mediaDir = path.join(this.dataPath, "media");
					await fs.mkdir(mediaDir, { recursive: true });

					// Salva arquivo de mídia
					const filePath = path.join(mediaDir, fileName);
					await fs.writeFile(filePath, Buffer.from(media.data, "base64"));

					this.logger.info(`[setWelcome] Mídia salva: ${filePath} (${mediaType})`);

					// Define o objeto de mídia
					group.greetings[mediaType] = {
						file: fileName,
						caption: content // legenda original
					};

					// Se a legenda tiver texto, atualiza também o texto principal?
					// A lógica do usuário pede para usar variáveis na caption.
					// Vamos manter o texto separado do objeto de mídia para flexibilidade,
					// mas o handler de envio deve decidir qual texto usar.
					// Se definirmos group.greetings.text aqui, sobrescreve o anterior.
					// Se a caption não for vazia, vamos definir como texto principal também?
					// Ou vamos manter separado?
					// "images, videos: make sure to get the caption too, variables such as {pessoa} should be replaced in the caption just like text greetings"
					// Então a caption da imagem É o greeting de texto associado à imagem.
				} catch (error) {
					this.logger.error("Erro ao salvar mídia para boas-vindas:", error);
					return new ReturnMessage({
						chatId: group.id,
						content: "Erro ao salvar mídia para boas-vindas."
					});
				}
			} else {
				// É apenas texto citado
				group.greetings.text = content;
			}

			await this.database.saveGroup(group);

			return new ReturnMessage({
				chatId: group.id,
				content: `Mensagem/Mídia de boas-vindas atualizada!`
			});
		}
		// Se tiver argumentos (e não for resposta), assume que é texto
		else if (message.origin && message.origin.body) {
			// Extrai o texto após o comando
			const prefixo = group.prefix ?? "!";
			const comandoCompleto = `${prefixo}g-setBoasvindas`;
			let texto = "";

			if (message.origin.body.includes(comandoCompleto)) {
				texto = message.origin.body
					.substring(message.origin.body.indexOf(comandoCompleto) + comandoCompleto.length)
					.trim();
			} else {
				texto = args.join(" ");
			}

			// Se não tem texto, avisa
			if (!texto) {
				const activeTypes = Object.keys(group.greetings).filter((k) => group.greetings[k]);
				return new ReturnMessage({
					chatId: group.id,
					content: `Mídias ativas: ${activeTypes.join(", ")}\n\nPara definir texto: !g-setBoasvindas <texto>\nPara mídia: Responda a uma mídia com o comando.`
				});
			}

			group.greetings.text = texto;
			await this.database.saveGroup(group);

			return new ReturnMessage({
				chatId: group.id,
				content: `Texto de boas-vindas atualizado para: ${texto}`
			});
		} else {
			return new ReturnMessage({
				chatId: group.id,
				content: "Use !g-setBoasvindas <texto> ou responda a uma mídia com o comando."
			});
		}
	}

	/**
	 * Remove um tipo de mídia da mensagem de boas-vindas
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async deleteWelcomeMessage(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (!group.greetings) {
			return new ReturnMessage({
				chatId: group.id,
				content: "Nenhuma mensagem de boas-vindas configurada."
			});
		}

		const type = args[0]?.toLowerCase();
		const allowedTypes = ["text", "image", "video", "audio", "sticker"];

		if (!type || !allowedTypes.includes(type)) {
			const activeTypes = Object.keys(group.greetings).filter((k) => group.greetings[k]);
			return new ReturnMessage({
				chatId: group.id,
				content: `Especifique o tipo para remover: ${allowedTypes.join(", ")}\n\nTipos ativos atualmente: ${activeTypes.join(", ") || "Nenhum"}`
			});
		}

		if (group.greetings[type]) {
			delete group.greetings[type];
			await this.database.saveGroup(group);
			return new ReturnMessage({
				chatId: group.id,
				content: `Boas-vindas do tipo '${type}' removido com sucesso.`
			});
		} else {
			return new ReturnMessage({
				chatId: group.id,
				content: `Não há boas-vindas do tipo '${type}' configurado.`
			});
		}
	}

	/**
	 * Define mensagem de despedida para um grupo
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async setFarewellMessage(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Verifica se a mensagem é uma resposta a outra mensagem
		const quotedMsg = await message.origin.getQuotedMessage().catch(() => null);

		// Inicializa objeto de farewells se não existir
		if (!group.farewells) {
			group.farewells = {};
		}

		// Se tiver mensagem citada
		if (quotedMsg) {
			const content = quotedMsg.caption ?? quotedMsg.content ?? quotedMsg.body ?? "";

			if (quotedMsg.hasMedia) {
				try {
					const media = await quotedMsg.downloadMedia({ keep: true });
					let mediaType = media.mimetype.split("/")[0]; // 'image', 'audio', 'video', etc.

					if (quotedMsg.type.toLowerCase() == "sticker") {
						mediaType = "sticker";
					}
					if (quotedMsg.type.toLowerCase() == "voice") {
						mediaType = "audio";
					}

					// Gera nome de arquivo com extensão apropriada
					let fileExt = media.mimetype.split("/")[1];
					if (fileExt.includes(";")) {
						fileExt = fileExt.split(";")[0];
					}
					const fileName = `${Date.now()}-${Math.floor(Math.random() * 1000)}.${fileExt}`;

					// Cria diretório de mídia se não existir
					const mediaDir = path.join(this.dataPath, "media");
					await fs.mkdir(mediaDir, { recursive: true });

					// Salva arquivo de mídia
					const filePath = path.join(mediaDir, fileName);
					await fs.writeFile(filePath, Buffer.from(media.data, "base64"));

					this.logger.info(`[setFarewell] Mídia salva: ${filePath} (${mediaType})`);

					// Define o objeto de mídia
					group.farewells[mediaType] = {
						file: fileName,
						caption: content // legenda original
					};
				} catch (error) {
					this.logger.error("Erro ao salvar mídia para despedida:", error);
					return new ReturnMessage({
						chatId: group.id,
						content: "Erro ao salvar mídia para despedida."
					});
				}
			} else {
				// É apenas texto citado
				group.farewells.text = content;
			}

			await this.database.saveGroup(group);

			return new ReturnMessage({
				chatId: group.id,
				content: `Mensagem/Mídia de despedida atualizada!`
			});
		}
		// Se tiver argumentos (e não for resposta), assume que é texto
		else if (message.origin && message.origin.body) {
			// Extrai o texto após o comando
			const prefixo = group.prefix ?? "!";
			const comandoCompleto = `${prefixo}g-setDespedida`;
			let texto = "";

			if (message.origin.body.includes(comandoCompleto)) {
				texto = message.origin.body
					.substring(message.origin.body.indexOf(comandoCompleto) + comandoCompleto.length)
					.trim();
			} else {
				texto = args.join(" ");
			}

			// Se não tem texto, avisa
			if (!texto) {
				const activeTypes = Object.keys(group.farewells).filter((k) => group.farewells[k]);
				return new ReturnMessage({
					chatId: group.id,
					content: `Mídias ativas: ${activeTypes.join(", ")}\n\nPara definir texto: !g-setDespedida <texto>\nPara mídia: Responda a uma mídia com o comando.`
				});
			}

			group.farewells.text = texto;
			await this.database.saveGroup(group);

			return new ReturnMessage({
				chatId: group.id,
				content: `Texto de despedida atualizado para: ${texto}`
			});
		} else {
			return new ReturnMessage({
				chatId: group.id,
				content: "Use !g-setDespedida <texto> ou responda a uma mídia com o comando."
			});
		}
	}

	/**
	 * Remove um tipo de mídia da mensagem de despedida
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async deleteFarewellMessage(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (!group.farewells) {
			return new ReturnMessage({
				chatId: group.id,
				content: "Nenhuma mensagem de despedida configurada."
			});
		}

		const type = args[0]?.toLowerCase();
		const allowedTypes = ["text", "image", "video", "audio", "sticker"];

		if (!type || !allowedTypes.includes(type)) {
			const activeTypes = Object.keys(group.farewells).filter((k) => group.farewells[k]);
			return new ReturnMessage({
				chatId: group.id,
				content: `Especifique o tipo para remover: ${allowedTypes.join(", ")}\n\nTipos ativos atualmente: ${activeTypes.join(", ") || "Nenhum"}`
			});
		}

		if (group.farewells[type]) {
			delete group.farewells[type];
			await this.database.saveGroup(group);
			return new ReturnMessage({
				chatId: group.id,
				content: `Despedida do tipo '${type}' removido com sucesso.`
			});
		} else {
			return new ReturnMessage({
				chatId: group.id,
				content: `Não há despedida do tipo '${type}' configurado.`
			});
		}
	}

	/**
	 * Mostra mensagem de ajuda de gerenciamento
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async showManagementHelp(bot, message, args, group) {
		const chatId = group ? group.id : message.author;

		const helpText = `*Comandos de Gerenciamento de Grupo:*

  *!g-setName* <nome> - Define um nome personalizado para o grupo
  *!g-addCmd* <gatilho> - Adiciona um comando personalizado (deve ser usado como resposta)
  *!g-addCmdReply* <comando> - Adiciona outra resposta a um comando existente
  *!g-delCmd* <comando> - Exclui um comando personalizado
  *!g-enableCmd* <comando> - Habilita um comando desabilitado
  *!g-disableCmd* <comando> - Desabilita um comando
  *!g-setPrefixo* <prefixo> - Altera o prefixo de comando
  *!g-setBoasvindas* <mensagem> - Define mensagem de boas-vindas para novos membros
  *!g-setDespedida* <mensagem> - Define mensagem de despedida para membros que saem
  *!g-info* - Mostra informações detalhadas do grupo
  *!g-manage* <nomeGrupo> - Gerencia um grupo a partir de chat privado
  *!g-copiarCmds* <grupoOrigem> <grupoDestino> - Copia comandos personalizados de um grupo para outro (estilo rsync)

  *Comandos de Filtro:*
  *!g-filtro-palavra* <palavra> - Adiciona/remove palavra do filtro
  *!g-filtro-links* - Ativa/desativa filtro de links
  *!g-filtro-pessoa* @MarcarPessoa - Adiciona/remove número do filtro
  *!g-filtro-nsfw* - Ativa/desativa filtro de conteúdo NSFW

  *Variáveis em mensagens:*
  {pessoa} - Nome da pessoa que entrou/saiu do grupo
  {day} - Dia atual
  {date} - Data atual
  {time} - Hora atual
  {cmd-!comando arg} - Executa outro comando (criando um alias)`;

		return new ReturnMessage({
			chatId,
			content: helpText
		});
	}

	/**
	 * Mostra informações detalhadas do grupo
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async showGroupInfo(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		try {
			// Obtém comandos personalizados para este grupo
			const customCommands = await this.database.getCustomCommands(group.id);
			const activeCommands = customCommands.filter((cmd) => cmd.active && !cmd.deleted);

			// Formata mensagem de boas-vindas e despedida
			const welcomeMessage =
				group.greetings && group.greetings.text ? group.greetings.text : "Não definida";

			const farewellMessage =
				group.farewells && group.farewells.text ? group.farewells.text : "Não definida";

			// Formata informações de filtro
			const wordFilters =
				group.filters && group.filters.words && group.filters.words.length > 0
					? group.filters.words.join(", ")
					: "Nenhuma palavra filtrada";

			const linkFiltering = group.filters && group.filters.links ? "Sim" : "Não";

			const personFilters =
				group.filters && group.filters.people && group.filters.people.length > 0
					? group.filters.people.join(", ")
					: "Nenhuma pessoa filtrada";

			const nsfwFiltering = group.filters && group.filters.nsfw ? "Sim" : "Não";

			// Formata data de criação
			const creationDate = new Date(group.createdAt).toLocaleString("pt-BR");

			// Obtém informações do sistema de arquivos para o grupo
			const filesInfo = {
				totalFiles: 0,
				totalSize: 0
			};

			try {
				// Carrega informações do banco de dados de arquivos
				const filesDb = await this.loadFilesDB();

				if (filesDb && filesDb.chats && filesDb.chats[group.id]) {
					const groupStorage = filesDb.chats[group.id];

					// Conta o número de arquivos (não pastas)
					const files = Object.values(groupStorage.files ?? {}).filter((file) => !file.isFolder);

					filesInfo.totalFiles = files.length;
					filesInfo.totalSize = groupStorage.totalSize ?? 0;
				}
			} catch (filesError) {
				this.logger.error("Erro ao obter informações de arquivos:", filesError);
			}

			// Formata tamanho do armazenamento
			const formatSize = (bytes) => {
				if (bytes < 1024) return `${bytes} B`;
				if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
				if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
				return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
			};

			// Formata informações de streams configurados
			const twitchChannels = Array.isArray(group.twitch) ? group.twitch : [];
			const kickChannels = Array.isArray(group.kick) ? group.kick : [];
			const youtubeChannels = Array.isArray(group.youtube) ? group.youtube : [];

			// Função auxiliar para formatar as configurações de mídia
			const formatMediaConfig = (config) => {
				if (!config || !config.media || config.media.length === 0) {
					return "Nenhuma mídia configurada";
				}

				const mediaTypes = config.media.reduce((types, media) => {
					if (!types.includes(media.type)) {
						types.push(media.type);
					}
					return types;
				}, []);

				return mediaTypes.join(", ");
			};

			// Constrói mensagem informativa
			let infoMessage = `*📊 Informações do Grupo*\n\n`;
			infoMessage += `*Nome:* ${group.name}\n`;
			infoMessage += `*ID:* ${group.id}\n`;
			infoMessage += `*Prefixo:* "${group.prefix}"\n`;
			infoMessage += `*Data de Criação:* ${creationDate}\n`;
			infoMessage += `*Pausado:* ${group.paused ? "Sim" : "Não"}\n\n`;

			// Adiciona informações de admins adicionais
			const admins = group.additionalAdmins ?? [];
			if (admins.length > 0) {
				infoMessage += `*Administradores:* ${admins.length}\n`;
				for (let i = 0; i < Math.min(3, admins.length); i++) {
					infoMessage += `- ${this.formatPhoneNumber(admins[i])}\n`;
				}
				if (admins.length > 300) {
					infoMessage += `... e mais ${admins.length - 300} administradores\n`;
				}
				infoMessage += "\n";
			}

			// Adiciona informações de armazenamento
			if (group.customAIPrompt && group.customAIPrompt.length > 1) {
				infoMessage += `*Personalidade IA*:\n`;
				infoMessage += `- \`${group.customAIPrompt}\`\n\n`;
			}

			infoMessage += `*Respostas Automáticas:*\n`;
			infoMessage += `- *Boas-vindas:* \`\`\`${welcomeMessage}\`\`\`\n`;
			infoMessage += `- *Despedidas:* \`\`\`${farewellMessage}\`\`\`\n`;
			infoMessage += `- *Auto-STT:* ${group.autoStt ? "Sim" : "Não"}\n`;
			infoMessage += `- *Notificar Fechado:* ${group.notificaGrupoFechado ? "Sim" : "Não"}\n`;
			infoMessage += `- *Notificar Aberto:* ${group.notificaGrupoAberto ? "Sim" : "Não"}\n\n`;

			if (group.interact) {
				infoMessage += `*Interações Automáticas:*\n`;
				infoMessage += `- *Ativado:* ${group.interact.enabled ? "Sim" : "Não"}\n`;
				infoMessage += `- *Chance:* ${group.interact.chance / 100}% (${group.interact.chance}/10000)\n`;
				infoMessage += `- *Cooldown:* ${group.interact.cooldown} minutos\n`;
				const proporcao = group.interact.proporcao !== undefined ? group.interact.proporcao : 50;
				infoMessage += `- *Proporção:* ${proporcao}% IA, ${100 - proporcao}% comandos\n\n`;
			}

			infoMessage += `*Filtros:*\n`;
			infoMessage += `- *Palavras:* ${wordFilters}\n`;
			infoMessage += `- *Links:* ${linkFiltering}\n`;
			infoMessage += `- *Pessoas:* ${personFilters}\n`;
			infoMessage += `- *NSFW:* ${nsfwFiltering}\n`;

			// Buscar Dossiês
			let dossierInfo = "";
			try {
				const dossiers = await this.database.dbAll(
					"summaries",
					"SELECT dossier_json FROM group_dossiers WHERE group_id = ? ORDER BY created_at DESC LIMIT 15",
					[group.id]
				);

				if (dossiers && dossiers.length > 0) {
					const latest = JSON.parse(dossiers[0].dossier_json);
					const totalScore = dossiers.reduce((acc, d) => {
						try {
							return acc + JSON.parse(d.dossier_json).problematic_score;
						} catch (e) {
							return acc;
						}
					}, 0);
					const avgScore = (totalScore / dossiers.length).toFixed(1);

					dossierInfo += `\n*📋 Dossiê do Grupo:*\n`;
					dossierInfo += `- *Último:* [${latest.type}] ${latest.summary}\n`;
					dossierInfo += `- *Nota Média:* ${avgScore}/10 (baseado em ${dossiers.length} análises)\n`;
				}
			} catch (e) {
				this.logger.error("Erro ao buscar dossiês para info:", e);
			}

			if (group.ignoredNumbers && group.ignoredNumbers.length > 0) {
				infoMessage += `\n*Números Ignorados:* ${group.ignoredNumbers.join(", ")}\n`;
			}

			infoMessage += dossierInfo;

			// Apelidos configurados
			if (group.mutedCategories && group.mutedCategories.length > 0) {
				infoMessage += `\n*Categorias Silenciadas:* ${group.mutedCategories.join(", ")}\n`;
			}

			if (group.mutedCommands && group.mutedCommands.length > 0) {
				infoMessage += `*Comandos Silenciados:* ${group.mutedCommands.join(", ")}\n`;
			}

			if (group.ignoredNumbers && group.ignoredNumbers.length > 0) {
				infoMessage += `\n*Números Ignorados:* ${group.ignoredNumbers.join(", ")}\n`;
			}

			// Apelidos configurados
			if (group.nicks && group.nicks.length > 0) {
				infoMessage += `\n*Apelidos Configurados:* ${group.nicks.map((n) => `${n.apelido} (${n.numero})`).join(", ")}\n`;
			}

			infoMessage += `*Canais Monitorados:*\n`;

			// Twitch
			if (twitchChannels.length > 0) {
				infoMessage += `*Twitch (${twitchChannels.length}):*\n`;

				for (const channel of twitchChannels) {
					infoMessage += `- *${channel.channel}*:\n`;

					if (channel.pausedUntil && new Date(channel.pausedUntil) > new Date()) {
						infoMessage += `  • Status: ⏸️ *PAUSADO* (até ${new Date(channel.pausedUntil).toLocaleString("pt-BR")})\n`;
					}

					// Tipos de mídia configurados para online/offline
					const onlineMedia = formatMediaConfig(channel.onConfig);
					const offlineMedia = formatMediaConfig(channel.offConfig);

					infoMessage += `  • Mídias Online: ${onlineMedia}\n`;
					infoMessage += `  • Mídias Offline: ${offlineMedia}\n`;

					// Configurações adicionais
					infoMessage += `  • Mudar título do grupo: ${channel.changeTitleOnEvent ? "Sim" : "Não"}\n`;

					if (channel.changeTitleOnEvent) {
						if (channel.onlineTitle) {
							infoMessage += `  • Título Online: "${channel.onlineTitle}"\n`;
						}
						if (channel.offlineTitle) {
							infoMessage += `  • Título Offline: "${channel.offlineTitle}"\n`;
						}
					}

					infoMessage += `  • Marcar Todos: ${channel.mentionAllMembers ? "Sim" : "Não"}\n`;
					infoMessage += `  • Usar Thumbnail: ${channel.useThumbnail ? "Sim" : "Não"}\n`;
					infoMessage += `  • Usar IA: ${channel.useAI ? "Sim" : "Não"}\n`;

					if (channel.groupPhotoOnline) {
						infoMessage += `  • Foto de grupo Online: Configurada\n`;
					}

					if (channel.groupPhotoOffline) {
						infoMessage += `  • Foto de grupo Offline: Configurada\n`;
					}

					infoMessage += "\n";
				}
			}

			// Kick
			if (kickChannels.length > 0) {
				infoMessage += `*Kick (${kickChannels.length}):*\n`;

				for (const channel of kickChannels) {
					infoMessage += `- *${channel.channel}*:\n`;

					if (channel.pausedUntil && new Date(channel.pausedUntil) > new Date()) {
						infoMessage += `  • Status: ⏸️ *PAUSADO* (até ${new Date(channel.pausedUntil).toLocaleString("pt-BR")})\n`;
					}

					// Tipos de mídia configurados para online/offline
					const onlineMedia = formatMediaConfig(channel.onConfig);
					const offlineMedia = formatMediaConfig(channel.offConfig);

					infoMessage += `  • Mídias Online: ${onlineMedia}\n`;
					infoMessage += `  • Mídias Offline: ${offlineMedia}\n`;

					// Configurações adicionais
					infoMessage += `  • Mudar título do grupo: ${channel.changeTitleOnEvent ? "Sim" : "Não"}\n`;

					if (channel.changeTitleOnEvent) {
						if (channel.onlineTitle) {
							infoMessage += `  • Título Online: "${channel.onlineTitle}"\n`;
						}
						if (channel.offlineTitle) {
							infoMessage += `  • Título Offline: "${channel.offlineTitle}"\n`;
						}
					}

					infoMessage += `  • Usar IA: ${channel.useAI ? "Sim" : "Não"}\n`;

					if (channel.groupPhotoOnline) {
						infoMessage += `  • Foto de grupo Online: Configurada\n`;
					}

					if (channel.groupPhotoOffline) {
						infoMessage += `  • Foto de grupo Offline: Configurada\n`;
					}

					infoMessage += "\n";
				}
			}

			// YouTube
			if (youtubeChannels.length > 0) {
				infoMessage += `*YouTube (${youtubeChannels.length}):*\n`;

				for (const channel of youtubeChannels) {
					infoMessage += `- *${channel.channel}*:\n`;

					if (channel.pausedUntil && new Date(channel.pausedUntil) > new Date()) {
						infoMessage += `  • Status: ⏸️ *PAUSADO* (até ${new Date(channel.pausedUntil).toLocaleString("pt-BR")})\n`;
					}

					// Tipos de mídia configurados
					const mediaConfig = formatMediaConfig(channel.onConfig);

					infoMessage += `  • Mídias Notificação: ${mediaConfig}\n`;

					// Configurações adicionais
					infoMessage += `  • Mudar título do grupo: ${channel.changeTitleOnEvent ? "Sim" : "Não"}\n`;

					if (channel.changeTitleOnEvent && channel.onlineTitle) {
						infoMessage += `  • Título Novo Vídeo: "${channel.onlineTitle}"\n`;
					}

					infoMessage += `  • Usar IA: ${channel.useAI ? "Sim" : "Não"}\n`;

					if (channel.groupPhotoOnline) {
						infoMessage += `  • Foto de grupo Novo Vídeo: Configurada\n`;
					}

					infoMessage += "\n";
				}
			}

			if (
				twitchChannels.length === 0 &&
				kickChannels.length === 0 &&
				youtubeChannels.length === 0
			) {
				infoMessage += `Nenhum canal configurado. Use !g-twitch-canal, !g-kick-canal ou !g-youtube-canal para adicionar.\n\n`;
			}

			// Adiciona informação sobre comandos personalizados
			infoMessage += `*Comandos Personalizados (${activeCommands.length}):*\n`;

			// Lista comandos personalizados com suas informações detalhadas
			const maxCommands = Math.min(1000, activeCommands.length);
			for (let i = 0; i < maxCommands; i++) {
				const cmd = activeCommands[i];
				infoMessage += `- *${group.prefix}${cmd.startsWith}*: `;

				// Mostra contagem de respostas
				if (cmd.responses && cmd.responses.length > 0) {
					infoMessage += `${cmd.responses.length} respostas`;
					// Mostra contador de uso
					if (cmd.count) {
						infoMessage += `, usado ${cmd.count} vezes\n`;
					}

					for (const resp of cmd.responses) {
						infoMessage += `> ${resp}\n`;
					}

					// Mostra se tem restrições de horário/dias
					if (cmd.allowedTimes) {
						infoMessage += `, `;
						if (cmd.allowedTimes.start && cmd.allowedTimes.end) {
							infoMessage += `${cmd.allowedTimes.start}-${cmd.allowedTimes.end}`;
						}
						if (cmd.allowedTimes.daysOfWeek && cmd.allowedTimes.daysOfWeek.length > 0) {
							infoMessage += ` [${cmd.allowedTimes.daysOfWeek.join(", ")}]`;
						}
					}
				} else {
					infoMessage += "Sem respostas";
				}

				infoMessage += "\n";
			}

			// Indica se existem mais comandos
			if (activeCommands.length > maxCommands) {
				infoMessage += `_... e mais ${activeCommands.length - maxCommands} comandos_\n`;
			}

			infoMessage += `\n*Armazenamento:*\n`;
			infoMessage += `- *Arquivos:* ${filesInfo.totalFiles} arquivos\n`;
			infoMessage += `- *Espaço usado:* ${formatSize(filesInfo.totalSize)}\n\n`;

			return new ReturnMessage({
				chatId: group.id,
				content: infoMessage
			});
		} catch (error) {
			this.logger.error("Erro ao mostrar informações do grupo:", error);
			return new ReturnMessage({
				chatId: group.id,
				content: "Erro ao recuperar informações do grupo. Por favor, tente novamente."
			});
		}
	}

	/**
	 * Carrega o banco de dados de arquivos
	 * @returns {Promise<Object>} Banco de dados de arquivos
	 */
	async loadFilesDB() {
		try {
			const FILES_DB_FILE = "files-db.json";
			return await this.database.loadJSON(path.join(this.database.databasePath, FILES_DB_FILE));
		} catch (error) {
			this.logger.error("Erro ao carregar banco de dados de arquivos:", error);
			return null;
		}
	}

	/**
	 * Verifica se o bot é admin no grupo
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Objet} group - grupo
	 * @returns {Promise<boolean>} - Se o bot é admin
	 */
	async isBotAdmin(bot, group) {
		try {
			const chat = await bot.client.getChatById(group.id);

			return await this.adminUtils.isAdmin(bot.phoneNumber, group, chat, bot, false);
		} catch (error) {
			this.logger.error(`Erro ao verificar se o bot é admin em ${group.id}:`, error);
			return false;
		}
	}

	/**
	 * Adiciona ou remove uma palavra do filtro
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async filterWord(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Verifica se o bot é admin para filtros efetivos
		const isAdmin = await this.isBotAdmin(bot, group);
		if (!isAdmin) {
			await bot.sendMessage(
				group.id,
				"⚠️ Atenção: O bot não é administrador do grupo. Ele não poderá apagar mensagens filtradas. Para usar filtros efetivamente, adicione o bot como administrador."
			);
		}

		if (args.length === 0) {
			// Mostra lista de palavras filtradas atual
			const wordFilters =
				group.filters && group.filters.words && group.filters.words.length > 0
					? group.filters.words.join(", ")
					: "Nenhuma palavra filtrada";

			return new ReturnMessage({
				chatId: group.id,
				content: `*Palavras filtradas atualmente:*\n${wordFilters}\n\nPara adicionar ou remover uma palavra do filtro, use: !g-filtro-palavra <palavra ou frase>`
			});
		}

		// Inicializa filtros se não existirem
		if (!group.filters) {
			group.filters = {};
		}

		if (!group.filters.words || !Array.isArray(group.filters.words)) {
			group.filters.words = [];
		}

		// Junta todos os argumentos como uma única frase
		const word = args.join(" ").toLowerCase();

		// Verifica se a palavra já está no filtro
		const index = group.filters.words.findIndex((w) => w.toLowerCase() === word);

		if (index !== -1) {
			// Remove a palavra
			group.filters.words.splice(index, 1);
			await this.database.saveGroup(group);

			// Mostra lista atualizada
			const wordFilters =
				group.filters.words.length > 0
					? group.filters.words.join(", ")
					: "Nenhuma palavra filtrada";

			return new ReturnMessage({
				chatId: group.id,
				content: `✅ Palavra removida do filtro: "${word}"\n\n*Palavras filtradas atualmente:*\n${wordFilters}`
			});
		} else {
			// Adiciona a palavra
			group.filters.words.push(word);
			await this.database.saveGroup(group);

			// Mostra lista atualizada
			const wordFilters =
				group.filters.words.length > 0
					? group.filters.words.join(", ")
					: "Nenhuma palavra filtrada";

			return new ReturnMessage({
				chatId: group.id,
				content: `✅ Palavra adicionada ao filtro: "${word}"\n\n*Palavras filtradas atualmente:*\n${wordFilters}`
			});
		}
	}

	/**
	 * Ativa ou desativa filtro de links
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async filterLinks(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Verifica se o bot é admin para filtros efetivos
		const isAdmin = await this.isBotAdmin(bot, group);
		if (!isAdmin) {
			await bot.sendMessage(
				group.id,
				"⚠️ Atenção: O bot não é administrador do grupo. Ele não poderá apagar mensagens filtradas. Para usar filtros efetivamente, adicione o bot como administrador."
			);
		}

		// Inicializa filtros se não existirem
		if (!group.filters) {
			group.filters = {};
		}

		// Alterna estado do filtro
		group.filters.links = !group.filters.links;
		await this.database.saveGroup(group);

		if (group.filters.links) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					"✅ Filtro de links ativado. Mensagens contendo links serão apagadas automaticamente."
			});
		} else {
			return new ReturnMessage({
				chatId: group.id,
				content: "❌ Filtro de links desativado. Mensagens contendo links não serão mais filtradas."
			});
		}
	}

	/**
	 * Adiciona ou remove uma pessoa do filtro
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async filterPerson(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Verifica se o bot é admin para filtros efetivos
		const isAdmin = await this.isBotAdmin(bot, group);
		if (!isAdmin) {
			await bot.sendMessage(
				group.id,
				"⚠️ Atenção: O bot não é administrador do grupo. Ele não poderá apagar mensagens filtradas. Para usar filtros efetivamente, adicione o bot como administrador."
			);
		}

		// Inicializa filtros se não existirem
		if (!group.filters) {
			group.filters = {};
		}

		if (!group.filters.people || !Array.isArray(group.filters.people)) {
			group.filters.people = [];
		}

		// this.logger.debug(`[filtroPesosa] `, { message });

		const pessoasIgnorar = message.mentions ?? [];

		if (pessoasIgnorar.length === 0) {
			// Mostra lista de pessoas filtradas
			const personFilters =
				group.filters.people.length > 0
					? group.filters.people.join(", ")
					: "Nenhuma pessoa filtrada";

			return new ReturnMessage({
				chatId: group.id,
				content: `*Pessoas filtradas atualmente:*\n${personFilters}\n\nPara adicionar ou remover uma pessoa do filtro, use: !g-filtro-pessoa @MarcarPessoa`
			});
		}

		let msgRetorno = "";
		for (let numero of pessoasIgnorar) {
			numero = numero.split("@")[0];
			// Verifica se o número já está no filtro
			const index = group.filters.people.indexOf(numero);

			if (index !== -1) {
				// Remove o número
				group.filters.people.splice(index, 1);
				msgRetorno += `➖ Pessoa removida ao filtro: ${numero}`;
			} else {
				group.filters.people.push(numero);
				msgRetorno += `➕ Pessoa adicionada ao filtro: ${numero}`;
			}
		}

		await this.database.saveGroup(group);
		// Mostra lista atualizada
		const personFilters =
			group.filters.people.length > 0 ? group.filters.people.join(", ") : "Nenhuma pessoa filtrada";

		return new ReturnMessage({
			chatId: group.id,
			content: `${msgRetorno}\n*Pessoas filtradas atualmente:*\n${personFilters}`
		});
	}

	/**
	 * Ativa ou desativa filtro de conteúdo NSFW
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async filterNSFW(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Verifica se o bot é admin para filtros efetivos
		const isAdmin = await this.isBotAdmin(bot, group);
		if (!isAdmin) {
			await bot.sendMessage(
				group.id,
				"⚠️ Atenção: O bot não é administrador do grupo. Ele não poderá apagar mensagens filtradas. Para usar filtros efetivamente, adicione o bot como administrador."
			);
		}

		// Inicializa filtros se não existirem
		if (!group.filters) {
			group.filters = {};
		}

		// Alterna estado do filtro
		group.filters.nsfw = !group.filters.nsfw;
		await this.database.saveGroup(group);

		if (group.filters.nsfw) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					"✅ Filtro de conteúdo NSFW ativado. Imagens e vídeos detectados como conteúdo adulto serão automaticamente removidos."
			});
		} else {
			return new ReturnMessage({
				chatId: group.id,
				content:
					"❌ Filtro de conteúdo NSFW desativado. Imagens e vídeos não serão filtrados para conteúdo adulto."
			});
		}
	}

	/**
	 * Define uma personalidade customizada para os comandos de IA
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async setPersonalidadeIA(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (!group.customAIPrompt) {
			group.customAIPrompt = "";
		}

		if (args.length === 0) {
			// Zera mensagem
			group.customAIPrompt = "";
		} else {
			group.customAIPrompt = args.join(" ").slice(0, 1500);
		}

		// Alterna estado do filtro
		await this.database.saveGroup(group);

		if (group.customAIPrompt.length > 0) {
			return new ReturnMessage({
				chatId: group.id,
				content: `✅🤖 Personalidade IA definida como: \`${group.customAIPrompt}\``
			});
		} else {
			return new ReturnMessage({
				chatId: group.id,
				content: "❌🤖 A personalidade IA foi removida, usando padrão"
			});
		}
	}

	/**
	 * Define reação 'depois' personalizada para um comando
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async setReaction(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length < 2) {
			return new ReturnMessage({
				chatId: group.id,
				content: "Por favor, forneça um nome de comando e emoji. Exemplo: !g-cmd-react sticker 🎯"
			});
		}

		const commandName = args[0];
		const emoji = args[1];

		// Verifica se é um comando personalizado
		const customCommands = await this.database.getCustomCommands(group.id);
		const customCommand = customCommands.find(
			(cmd) => cmd.startsWith === commandName && !cmd.deleted
		);

		if (customCommand) {
			// Inicializa reações se necessário
			if (!customCommand.reactions) {
				customCommand.reactions = {
					after: emoji,
					error: "❌"
				};
			} else {
				customCommand.reactions.after = emoji;
			}

			// Atualiza o comando
			await this.database.updateCustomCommand(group.id, customCommand);

			// Limpa cache de comandos para garantir que o comando atualizado seja carregado
			this.database.clearCache(`commands:${group.id}`);

			// Recarrega comandos
			await bot.eventHandler.commandHandler.loadCustomCommandsForGroup(group.id);

			return new ReturnMessage({
				chatId: group.id,
				content: `Definida reação 'depois' de '${commandName}' para ${emoji}`
			});
		}

		return new ReturnMessage({
			chatId: group.id,
			content: `Comando personalizado '${commandName}' não encontrado.${this.help.naoEncontrado}`
		});
	}

	/**
	 * Define reação 'antes' personalizada para um comando
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async setStartReaction(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length < 2) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					"Por favor, forneça um nome de comando e emoji. Exemplo: !g-cmd-startReact sticker 🎯"
			});
		}

		const commandName = args[0];
		const emoji = args[1];

		// Verifica se é um comando personalizado
		const customCommands = await this.database.getCustomCommands(group.id);
		const customCommand = customCommands.find(
			(cmd) => cmd.startsWith === commandName && !cmd.deleted
		);

		if (customCommand) {
			// Inicializa reações se necessário
			if (!customCommand.reactions) {
				customCommand.reactions = {
					before: emoji,
					error: "❌"
				};
			} else {
				customCommand.reactions.before = emoji;
			}

			// Atualiza o comando
			await this.database.updateCustomCommand(group.id, customCommand);

			// Limpa cache de comandos para garantir que o comando atualizado seja carregado
			this.database.clearCache(`commands:${group.id}`);

			// Recarrega comandos
			await bot.eventHandler.commandHandler.loadCustomCommandsForGroup(group.id);

			return new ReturnMessage({
				chatId: group.id,
				content: `Definida reação 'antes' de '${commandName}' para ${emoji}`
			});
		}

		return new ReturnMessage({
			chatId: group.id,
			content: `Comando personalizado '${commandName}' não encontrado.${this.help.naoEncontrado}`
		});
	}

	/**
	 * Define o cooldown personalizado de um comando
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async setCmdCooldown(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length < 2) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					"Por favor, forneça um nome de comando e o cooldown em segundos. Exemplo: !g-cmd-cd sticker 30"
			});
		}

		const commandName = args[0];
		const cooldownRaw = parseInt(args[1]);

		if (isNaN(cooldownRaw)) {
			return new ReturnMessage({
				chatId: group.id,
				content: "O cooldown deve ser um número (em segundos). Exemplo: !g-cmd-cd sticker 30"
			});
		}

		// Respeita o mínimo (1 segundo) e o máximo (60000 segundos ~16,6h)
		const MIN_COOLDOWN = 1;
		const MAX_COOLDOWN = 60000;
		let cooldown = cooldownRaw;
		let textoAjuste = "";

		if (cooldown <= 0) {
			cooldown = 0;
			textoAjuste = " (cooldown removido)";
		} else if (cooldown < MIN_COOLDOWN) {
			cooldown = MIN_COOLDOWN;
			textoAjuste = ` (mínimo: ${MIN_COOLDOWN}s)`;
		} else if (cooldown > MAX_COOLDOWN) {
			cooldown = MAX_COOLDOWN;
			textoAjuste = ` (máximo: ${MAX_COOLDOWN}s)`;
		}

		// Verifica se é um comando personalizado
		const customCommands = await this.database.getCustomCommands(group.id);
		const customCommand = customCommands.find(
			(cmd) => cmd.startsWith === commandName && !cmd.deleted
		);

		if (customCommand) {
			customCommand.cooldown = cooldown;

			// Atualiza o comando
			await this.database.updateCustomCommand(group.id, customCommand);

			// Limpa cache de comandos para garantir que o comando atualizado seja carregado
			this.database.clearCache(`commands:${group.id}`);

			// Recarrega comandos
			await bot.eventHandler.commandHandler.loadCustomCommandsForGroup(group.id);

			const msgCooldown =
				cooldown === 0
					? `Cooldown do comando '${commandName}' removido${textoAjuste}.`
					: `Cooldown do comando '${commandName}' definido para ${cooldown} segundo(s)${textoAjuste}.`;

			return new ReturnMessage({
				chatId: group.id,
				content: `🕐 ${msgCooldown}`
			});
		}

		return new ReturnMessage({
			chatId: group.id,
			content: `Comando personalizado '${commandName}' não encontrado.${this.help.naoEncontrado}`
		});
	}

	/**
	 * Alterna conversão automática de voz para texto em mensagens de voz em um grupo
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async toggleAutoStt(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Alterna a configuração de auto-STT
		group.autoStt = !group.autoStt;

		// Atualiza grupo no banco de dados
		await this.database.saveGroup(group);

		// Envia mensagem de confirmação
		const statusMsg = group.autoStt
			? "Conversão automática de voz para texto agora está *ativada* para este grupo."
			: "Conversão automática de voz para texto agora está *desativada* para este grupo.";

		return new ReturnMessage({
			chatId: group.id,
			content: statusMsg
		});
	}

	/**
	 * Alterna a notificação automática quando o grupo é fechado
	 * @param {WhatsAppBot} bot - A instância do bot
	 * @param {Object} message - A mensagem recebida
	 * @param {Array} args - Argumentos do comando
	 * @param {Group} group - O objeto do grupo
	 * @returns {Promise<ReturnMessage>}
	 */
	async toggleNotificaGrupoFechado(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		group.notificaGrupoFechado = !group.notificaGrupoFechado;
		await this.database.saveGroup(group);

		const statusMsg = group.notificaGrupoFechado
			? "🔔 Notificação automática de *grupo fechado* agora está *ativada*."
			: "🔕 Notificação automática de *grupo fechado* agora está *desativada*.";

		return new ReturnMessage({
			chatId: group.id,
			content: statusMsg
		});
	}

	/**
	 * Alterna a notificação automática quando o grupo é aberto
	 * @param {WhatsAppBot} bot - A instância do bot
	 * @param {Object} message - A mensagem recebida
	 * @param {Array} args - Argumentos do comando
	 * @param {Group} group - O objeto do grupo
	 * @returns {Promise<ReturnMessage>}
	 */
	async toggleNotificaGrupoAberto(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		group.notificaGrupoAberto = !group.notificaGrupoAberto;
		await this.database.saveGroup(group);

		const statusMsg = group.notificaGrupoAberto
			? "🔔 Notificação automática de *grupo aberto* agora está *ativada*."
			: "🔕 Notificação automática de *grupo aberto* agora está *desativada*.";

		return new ReturnMessage({
			chatId: group.id,
			content: statusMsg
		});
	}

	/**
	 * Gets the platform-specific channel configuration from the group
	 * @param {Object} group - The group object
	 * @param {string} platform - The platform ('twitch', 'kick', 'youtube')
	 * @returns {Array} - Array of channel configurations for the platform
	 */
	getChannelConfig(group, platform) {
		if (!group[platform]) {
			group[platform] = [];
		}
		return group[platform];
	}

	/**
	 * Finds a channel configuration in the group
	 * @param {Object} group - The group object
	 * @param {string} platform - The platform ('twitch', 'kick', 'youtube')
	 * @param {string} channelName - The channel name to find
	 * @returns {Object|null} - The channel configuration or null if not found
	 */
	findChannelConfig(group, platform, channelName) {
		const channels = this.getChannelConfig(group, platform);
		return channels.find((c) => c.channel.toLowerCase() === channelName.toLowerCase());
	}

	/**
	 * Validates and gets the channel name for commands
	 * @param {WhatsAppBot} bot - The bot instance
	 * @param {Object} message - The message object
	 * @param {Array} args - Command arguments
	 * @param {Object} group - The group object
	 * @param {string} platform - The platform ('twitch', 'kick', 'youtube')
	 * @returns {Promise<string|null>} - The validated channel name or null if invalid
	 */
	async validateChannelName(bot, message, args, group, platform) {
		// If a channel name is provided, use it
		if (args.length > 0) {
			return args[0].toLowerCase();
		}

		// If no channel name provided, check if there's only one configured channel
		const channels = this.getChannelConfig(group, platform);

		if (channels.length === 0) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Nenhum canal de ${platform} configurado. Use !g-${platform}-canal <nome do canal> para configurar.`
			});
		}

		if (channels.length === 1) {
			return channels[0].channel;
		}

		// If multiple channels, show list and instructions
		const channelsList = channels.map((c) => c.channel).join(", ");

		return new ReturnMessage({
			chatId: group.id,
			content:
				`Múltiplos canais de ${platform} configurados. Especifique o canal:\n` +
				`!g-${platform}-midia on <canal>\n\n` +
				`Canais configurados: ${channelsList}`
		});
	}

	/**
	 * Creates default notification configuration
	 * @param {string} platform - The platform ('twitch', 'kick', 'youtube')
	 * @param {string} channelName - The channel name
	 * @returns {Object} - Default notification configuration
	 */
	createDefaultNotificationConfig(platform, channelName) {
		let defaultText = "";

		if (platform === "twitch" || platform === "kick") {
			const domain = platform === "twitch" ? "tv" : "com";
			defaultText =
				`⚠️ ATENÇÃO!⚠️\n\n🌟 *${channelName}* ✨ está *online* streamando *{jogo}*!\n_{titulo}_\n\n` +
				`https://${platform}.${domain}/${channelName}`;
		} else if (platform === "youtube") {
			defaultText = `*⚠️ Vídeo novo! ⚠️*\n\n*{author}:* *{title}* \n{link}`;
		}

		return {
			media: [
				{
					type: "text",
					content: defaultText
				}
			]
		};
	}

	/**
	 * Processes a string to extract and sanitize a Twitch channel name.
	 *
	 * @param {string} inputString - The raw input string, potentially a URL or just a name.
	 * @returns {string} The sanitized Twitch channel name, or an empty string if input is invalid.
	 */
	sanitizeTwitchChannelName(inputString) {
		// Check if inputString is actually a string and not null/undefined
		if (typeof inputString !== "string") {
			return "";
		}

		// 1. Remove common Twitch URL prefixes (http, https, www) case-insensitively.
		//    The regex ^(https?:\/\/)?(www\.)?twitch\.tv\/ matches:
		//    - ^             : asserts position at start of the string
		//    - (https?:\/\/)? : optionally matches "http://" or "https://"
		//    - (www\.)?      : optionally matches "www."
		//    - twitch\.tv\/  : matches "twitch.tv/"
		//    - i             : flag for case-insensitive matching of the URL part
		const withoutUrl = inputString.replace(/^(https?:\/\/)?(www\.)?twitch\.tv\//i, "");

		// 2. Convert the result to lowercase, as Twitch names are case-insensitive in practice
		//    and often normalized to lowercase.
		const lowercased = withoutUrl.toLowerCase();

		// 3. Sanitize the name to keep only characters allowed in Twitch usernames:
		//    - a-z (lowercase letters)
		//    - 0-9 (numbers)
		//    - _   (underscore)
		//    The regex /[^a-z0-9_]/g matches any character that is NOT in the allowed set.
		//    - [^...] : is a negated character set
		//    - g      : flag for global match (replaces all occurrences)
		const sanitized = lowercased.replace(/[^a-z0-9_]/g, "");

		// Note: Twitch usernames also have length constraints (typically 4-25 characters).
		// This sanitization step focuses on character validity.
		// Length validation should be performed separately if needed.
		// e.g., if (sanitized.length >= 4 && sanitized.length <= 25) { ... }

		return sanitized ?? "";
	}

	/**
	 * Toggles monitoring of a Twitch channel
	 * @param {WhatsAppBot} bot - The bot instance
	 * @param {Object} message - The message object
	 * @param {Array} args - Command arguments
	 * @param {Object} group - The group object
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async toggleTwitchChannel(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		args = args.filter((a) => !["on", "off"].includes(a.toLowerCase()));

		if (args.length === 0) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					"Por favor, forneça o nome do canal da Twitch. Exemplo: !g-twitch-canal nomeDoCanal"
			});
		}

		const channelName = this.sanitizeTwitchChannelName(args[0] ?? "") ?? "";

		// Get current channels
		const channels = this.getChannelConfig(group, "twitch");

		// Check if channel is already configured
		const existingChannel = this.findChannelConfig(group, "twitch", channelName);

		if (existingChannel) {
			// Remove channel
			const updatedChannels = channels.filter(
				(c) => c.channel.toLowerCase() !== channelName.toLowerCase()
			);
			group.twitch = updatedChannels;

			await this.database.saveGroup(group);

			// Unsubscribe from StreamMonitor if it exists
			if (bot.streamMonitor) {
				bot.streamMonitor.unsubscribe(channelName, "twitch");
			}

			return new ReturnMessage({
				chatId: group.id,
				content: `Canal da Twitch removido: ${channelName}`
			});
		} else {
			// Check if the channel exists on Twitch before adding
			if (bot.streamMonitor) {
				if (channelName.length > 3 && channelName.length < 25) {
					const charsValidos = /^(#)?[a-zA-Z0-9_]{4,25}$/;
					let channelExists = charsValidos.test(channelName);
					if (channelExists) {
						// só verifica se for um nome válido
						channelExists = await bot.streamMonitor.twitchChannelExists(channelName);
					}

					if (!channelExists) {
						return new ReturnMessage({
							chatId: group.id,
							content: `❌ Erro: O canal "${channelName}" não existe na Twitch. Use apenas o nome do seu canal, sem caracteres extras.`
						});
					}

					// Add channel with default configuration
					const newChannel = {
						channel: channelName,
						onConfig: this.createDefaultNotificationConfig("twitch", channelName),
						offConfig: {
							media: []
						},
						changeTitleOnEvent: true,
						useThumbnail: true,
						useAI: false
					};

					channels.push(newChannel);
					await this.database.saveGroup(group);

					// Atualiza bots ignorados etc (cleanup)
					await this._refreshStreamBots(group);

					// Subscribe to the channel in StreamMonitor
					bot.streamMonitor.subscribe(channelName, "twitch");

					if (bot.grupoLogs) {
						bot.sendMessage(
							bot.grupoLogs,
							`Novo canal da twitch adicionado em '${group.name ?? "grupo"}' (${group.id}):\n- twitch.tv/${channelName}`
						);
					}

					return new ReturnMessage({
						chatId: group.id,
						content:
							`Canal da Twitch adicionado: ${channelName}\n\n` +
							`Configuração padrão de notificação "online" definida. Use !g-twitch-midia on ${channelName} para personalizar.`
					});
				} else {
					return new ReturnMessage({
						chatId: group.id,
						content: `❌ Erro: O canal "${channelName}" não parece ser válido. Os canais da twitch precisam ter entre _4 e 25 caracteres_.`
					});
				}
			} else {
				return new ReturnMessage({
					chatId: group.id,
					content: `❌ Erro: O monitoramento de streams não está inicializado no bot.`
				});
			}
		}
	}

	/**
	 * Toggles title change on stream events
	 * @param {WhatsAppBot} bot - The bot instance
	 * @param {Object} message - The message object
	 * @param {Array} args - Command arguments
	 * @param {Object} group - The group object
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async toggleTwitchTitleChange(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Validate and get channel name
		const channelName = await this.validateChannelName(bot, message, args, group, "twitch");

		// If validateChannelName returned a ReturnMessage, return it
		if (channelName instanceof ReturnMessage) {
			return channelName;
		}

		// Find the channel configuration
		const channelConfig = this.findChannelConfig(group, "twitch", channelName);

		if (!channelConfig) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Canal da Twitch não configurado: ${channelName}. Use !g-twitch-canal ${channelName} para configurar.`
			});
		}

		// Check if bot is admin in the group
		const isAdmin = await this.isBotAdmin(bot, group);

		if (!isAdmin) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					"⚠️ O bot não é administrador do grupo. Para alterar o título do grupo, o bot precisa ser um administrador. " +
					"Por favor, adicione o bot como administrador e tente novamente."
			});
		}

		// Toggle the setting
		channelConfig.changeTitleOnEvent = !channelConfig.changeTitleOnEvent;

		await this.database.saveGroup(group);

		const status = channelConfig.changeTitleOnEvent ? "ativada" : "desativada";

		if (channelConfig.changeTitleOnEvent) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					`Alteração de título para eventos do canal ${channelName} ${status}.\n\n` +
					`Você pode definir títulos personalizados com:\n` +
					`!g-twitch-titulo on ${channelName} [título]\n` +
					`!g-twitch-titulo off ${channelName} [título]`
			});
		} else {
			return new ReturnMessage({
				chatId: group.id,
				content: `Alteração de título para eventos do canal ${channelName} ${status}.`
			});
		}
	}

	/**
	 * Sets the custom "online" title for a Twitch channel
	 * @param {WhatsAppBot} bot - The bot instance
	 * @param {Object} message - The message object
	 * @param {Array} args - Command arguments
	 * @param {Object} group - The group object
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async setTwitchOnlineTitle(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length === 0) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					"Por favor, forneça o nome do canal ou título personalizado. Exemplo: !g-twitch-titulo on nomeDoCanal Título Personalizado"
			});
		}

		// Get channel name (first arg) and title (remaining args)
		let channelName, customTitle;

		// Check if first argument is a configured channel
		const firstArg = args[0].toLowerCase();
		const channels = this.getChannelConfig(group, "twitch");
		const isChannelArg = channels.some((c) => c.channel.toLowerCase() === firstArg);

		if (isChannelArg) {
			channelName = firstArg;
			customTitle = args.slice(1).join(" ");
		} else if (channels.length === 1) {
			// If only one channel is configured, use it
			channelName = channels[0].channel;
			customTitle = args.join(" ");
		} else {
			// Multiple channels, none specified
			const channelsList = channels.map((c) => c.channel).join(", ");

			return new ReturnMessage({
				chatId: group.id,
				content:
					`Múltiplos canais da Twitch configurados. Especifique o canal:\n` +
					`!g-twitch-titulo on <canal> <título>\n\n` +
					`Canais configurados: ${channelsList}`
			});
		}

		// Find the channel configuration
		const channelConfig = this.findChannelConfig(group, "twitch", channelName);

		if (!channelConfig) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Canal da Twitch não configurado: ${channelName}. Use !g-twitch-canal ${channelName} para configurar.`
			});
		}

		// If no title provided, remove custom title
		if (!customTitle) {
			delete channelConfig.onlineTitle;
			await this.database.saveGroup(group);

			return new ReturnMessage({
				chatId: group.id,
				content:
					`Título personalizado para eventos "online" do canal ${channelName} removido.\n` +
					`O bot irá substituir automaticamente "OFF" por "ON" no título do grupo quando o canal ficar online.`
			});
		}

		// Set custom title
		channelConfig.onlineTitle = customTitle;

		// Make sure title change is enabled
		if (!channelConfig.changeTitleOnEvent) {
			channelConfig.changeTitleOnEvent = true;

			await this.database.saveGroup(group);

			return new ReturnMessage({
				chatId: group.id,
				content:
					`Título personalizado para eventos "online" do canal ${channelName} definido: "${customTitle}"\n` +
					`Alteração de título para eventos foi automaticamente ativada.`
			});
		}

		await this.database.saveGroup(group);

		return new ReturnMessage({
			chatId: group.id,
			content: `Título personalizado para eventos "online" do canal ${channelName} definido: "${customTitle}"`
		});
	}

	/**
	 * Sets the custom "offline" title for a Twitch channel
	 * @param {WhatsAppBot} bot - The bot instance
	 * @param {Object} message - The message object
	 * @param {Array} args - Command arguments
	 * @param {Object} group - The group object
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async setTwitchOfflineTitle(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length === 0) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					"Por favor, forneça o nome do canal ou título personalizado. Exemplo: !g-twitch-titulo off nomeDoCanal Título Personalizado"
			});
		}

		// Get channel name (first arg) and title (remaining args)
		let channelName, customTitle;

		// Check if first argument is a configured channel
		const firstArg = args[0].toLowerCase();
		const channels = this.getChannelConfig(group, "twitch");
		const isChannelArg = channels.some((c) => c.channel.toLowerCase() === firstArg);

		if (isChannelArg) {
			channelName = firstArg;
			customTitle = args.slice(1).join(" ");
		} else if (channels.length === 1) {
			// If only one channel is configured, use it
			channelName = channels[0].channel;
			customTitle = args.join(" ");
		} else {
			// Multiple channels, none specified
			const channelsList = channels.map((c) => c.channel).join(", ");

			return new ReturnMessage({
				chatId: group.id,
				content:
					`Múltiplos canais da Twitch configurados. Especifique o canal:\n` +
					`!g-twitch-titulo off <canal> <título>\n\n` +
					`Canais configurados: ${channelsList}`
			});
		}

		// Find the channel configuration
		const channelConfig = this.findChannelConfig(group, "twitch", channelName);

		if (!channelConfig) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Canal da Twitch não configurado: ${channelName}. Use !g-twitch-canal ${channelName} para configurar.`
			});
		}

		// If no title provided, remove custom title
		if (!customTitle) {
			delete channelConfig.offlineTitle;
			await this.database.saveGroup(group);

			return new ReturnMessage({
				chatId: group.id,
				content:
					`Título personalizado para eventos "offline" do canal ${channelName} removido.\n` +
					`O bot irá substituir automaticamente "ON" por "OFF" no título do grupo quando o canal ficar offline.`
			});
		}

		// Set custom title
		channelConfig.offlineTitle = customTitle;

		// Make sure title change is enabled
		if (!channelConfig.changeTitleOnEvent) {
			channelConfig.changeTitleOnEvent = true;

			await this.database.saveGroup(group);

			return new ReturnMessage({
				chatId: group.id,
				content:
					`Título personalizado para eventos "offline" do canal ${channelName} definido: "${customTitle}"\n` +
					`Alteração de título para eventos foi automaticamente ativada.`
			});
		}

		await this.database.saveGroup(group);

		return new ReturnMessage({
			chatId: group.id,
			content: `Título personalizado para eventos "offline" do canal ${channelName} definido: "${customTitle}"`
		});
	}

	async toggleTwitchThumbnail(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Validate and get channel name
		const channelName = await this.validateChannelName(bot, message, args, group, "twitch");

		// If validateChannelName returned a ReturnMessage, return it
		if (channelName instanceof ReturnMessage) {
			return channelName;
		}

		// Find the channel configuration
		const channelConfig = this.findChannelConfig(group, "twitch", channelName);

		if (!channelConfig) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Canal da Twitch não configurado: ${channelName}. Use !g-twitch-canal ${channelName} para configurar.`
			});
		}

		// Toggle the setting
		if (!channelConfig.useThumbnail) {
			channelConfig.useThumbnail = true;
		} else {
			channelConfig.useThumbnail = false;
		}

		await this.database.saveGroup(group);

		const status = channelConfig.useThumbnail ? "irá enviar" : "não irá enviar";

		return new ReturnMessage({
			chatId: group.id,
			content: `O bot agora ${status} junto a thumbnail da stream do canal ${channelName}.\n\n`
		});
	}
	async toggleKickThumbnail(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Validate and get channel name
		const channelName = await this.validateChannelName(bot, message, args, group, "kick");

		// If validateChannelName returned a ReturnMessage, return it
		if (channelName instanceof ReturnMessage) {
			return channelName;
		}

		// Find the channel configuration
		const channelConfig = this.findChannelConfig(group, "kick", channelName);

		if (!channelConfig) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Canal da Kick não configurado: ${channelName}. Use !g-kick-canal ${channelName} para configurar.`
			});
		}

		// Toggle the setting
		if (!channelConfig.useThumbnail) {
			channelConfig.useThumbnail = true;
		} else {
			channelConfig.useThumbnail = false;
		}

		await this.database.saveGroup(group);

		const status = channelConfig.useThumbnail ? "irá enviar" : "não irá enviar";

		return new ReturnMessage({
			chatId: group.id,
			content: `O bot agora ${status} junto a thumbnail da stream do canal ${channelName}.\n\n`
		});
	}
	async toggleYoutubeThumbnail(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Validate and get channel name
		const channelName = await this.validateChannelName(bot, message, args, group, "youtube");

		// If validateChannelName returned a ReturnMessage, return it
		if (channelName instanceof ReturnMessage) {
			return channelName;
		}

		// Find the channel configuration
		const channelConfig = this.findChannelConfig(group, "youtube", channelName);

		if (!channelConfig) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Canal do Youtube não configurado: ${channelName}. Use !g-youtube-canal ${channelName} para configurar.`
			});
		}

		// Toggle the setting
		if (!channelConfig.useThumbnail) {
			channelConfig.useThumbnail = true;
		} else {
			channelConfig.useThumbnail = false;
		}

		await this.database.saveGroup(group);

		const status = channelConfig.useThumbnail ? "irá enviar" : "não irá enviar";

		return new ReturnMessage({
			chatId: group.id,
			content: `O bot agora ${status} junto a thumbnail da stream/video do canal ${channelName}.\n\n`
		});
	}

	/**
	 * Toggles AI generated messages for stream events
	 * @param {WhatsAppBot} bot - The bot instance
	 * @param {Object} message - The message object
	 * @param {Array} args - Command arguments
	 * @param {Object} group - The group object
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async toggleTwitchAI(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Validate and get channel name
		const channelName = await this.validateChannelName(bot, message, args, group, "twitch");

		// If validateChannelName returned a ReturnMessage, return it
		if (channelName instanceof ReturnMessage) {
			return channelName;
		}

		// Find the channel configuration
		const channelConfig = this.findChannelConfig(group, "twitch", channelName);

		if (!channelConfig) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Canal da Twitch não configurado: ${channelName}. Use !g-twitch-canal ${channelName} para configurar.`
			});
		}

		// Toggle the setting
		channelConfig.useAI = !channelConfig.useAI;

		await this.database.saveGroup(group);

		const status = channelConfig.useAI ? "ativadas" : "desativadas";

		if (channelConfig.useAI) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					`Mensagens geradas por IA para eventos do canal ${channelName} ${status}.\n\n` +
					`O bot usará IA para gerar mensagens personalizadas quando o canal ficar online.`
			});
		} else {
			return new ReturnMessage({
				chatId: group.id,
				content: `Mensagens geradas por IA para eventos do canal ${channelName} ${status}.`
			});
		}
	}

	/**
	 * Toggles monitoring of a Kick channel
	 * @param {WhatsAppBot} bot - The bot instance
	 * @param {Object} message - The message object
	 * @param {Array} args - Command arguments
	 * @param {Object} group - The group object
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async toggleKickChannel(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length === 0) {
			return new ReturnMessage({
				chatId: group.id,
				content: "Por favor, forneça o nome do canal do Kick. Exemplo: !g-kick-canal nomeDoCanal"
			});
		}

		const channelName = args[0].toLowerCase();

		// Get current channels
		const channels = this.getChannelConfig(group, "kick");

		// Check if channel is already configured
		const existingChannel = this.findChannelConfig(group, "kick", channelName);

		if (existingChannel) {
			// Remove channel
			// Remove channel
			const updatedChannels = channels.filter(
				(c) => c.channel.toLowerCase() !== channelName.toLowerCase()
			);
			group.kick = updatedChannels;

			await this.database.saveGroup(group);

			// Unsubscribe from StreamMonitor if it exists
			if (bot.streamMonitor) {
				bot.streamMonitor.unsubscribe(channelName, "kick");
			}

			return new ReturnMessage({
				chatId: group.id,
				content: `Canal do Kick removido: ${channelName}`
			});
		} else {
			// Add channel with default configuration
			const newChannel = {
				channel: channelName,
				onConfig: this.createDefaultNotificationConfig("kick", channelName),
				offConfig: {
					media: []
				},
				changeTitleOnEvent: true,
				useAI: false
			};

			channels.push(newChannel);
			await this.database.saveGroup(group);

			// Atualiza bots ignorados etc (cleanup)
			await this._refreshStreamBots(group);

			// Subscribe to the channel in StreamMonitor
			if (bot.streamMonitor) {
				bot.streamMonitor.subscribe(channelName, "kick");

				if (bot.grupoLogs) {
					bot.sendMessage(
						bot.grupoLogs,
						`Novo canal da kick adicionado em '${group.name ?? "grupo"}' (${group.id}):\n- kick.com/${channelName}`
					);
				}

				return new ReturnMessage({
					chatId: group.id,
					content:
						`Canal do Kick adicionado: ${channelName}\n\n` +
						`Configuração padrão de notificação "online" definida. Use !g-kick-midia on ${channelName} para personalizar.`
				});
			} else {
				return new ReturnMessage({
					chatId: group.id,
					content:
						`Canal do Kick adicionado: ${channelName}\n\n` +
						`⚠️ Aviso: O monitoramento de streams não está inicializado no bot. Entre em contato com o administrador.`
				});
			}
		}
	}

	/**
	 * Toggles title change on Kick stream events
	 * @param {WhatsAppBot} bot - The bot instance
	 * @param {Object} message - The message object
	 * @param {Array} args - Command arguments
	 * @param {Object} group - The group object
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async toggleKickTitleChange(bot, message, args, group) {
		// Identical to Twitch version with platform name differences
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Validate and get channel name
		const channelName = await this.validateChannelName(bot, message, args, group, "kick");

		// If validateChannelName returned a ReturnMessage, return it
		if (channelName instanceof ReturnMessage) {
			return channelName;
		}

		const channelConfig = this.findChannelConfig(group, "kick", channelName);

		if (!channelConfig) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Canal do Kick não configurado: ${channelName}. Use !g-kick-canal ${channelName} para configurar.`
			});
		}

		const isAdmin = await this.isBotAdmin(bot, group);

		if (!isAdmin) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					"⚠️ O bot não é administrador do grupo. Para alterar o título do grupo, o bot precisa ser um administrador. " +
					"Por favor, adicione o bot como administrador e tente novamente."
			});
		}

		// Toggle the setting
		channelConfig.changeTitleOnEvent = !channelConfig.changeTitleOnEvent;

		await this.database.saveGroup(group);

		const status = channelConfig.changeTitleOnEvent ? "ativada" : "desativada";

		if (channelConfig.changeTitleOnEvent) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					`Alteração de título para eventos do canal ${channelName} ${status}.\n\n` +
					`Você pode definir títulos personalizados com:\n` +
					`!g-kick-titulo on ${channelName} [título]\n` +
					`!g-kick-titulo off ${channelName} [título]`
			});
		} else {
			return new ReturnMessage({
				chatId: group.id,
				content: `Alteração de título para eventos do canal ${channelName} ${status}.`
			});
		}
	}

	/**
	 * Sets the custom "online" title for a Kick channel
	 * @param {WhatsAppBot} bot - The bot instance
	 * @param {Object} message - The message object
	 * @param {Array} args - Command arguments
	 * @param {Object} group - The group object
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async setKickOnlineTitle(bot, message, args, group) {
		// Identical to Twitch version with platform name differences
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length === 0) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					"Por favor, forneça o nome do canal ou título personalizado. Exemplo: !g-kick-titulo on nomeDoCanal Título Personalizado"
			});
		}

		// Get channel name (first arg) and title (remaining args)
		let channelName, customTitle;

		// Check if first argument is a configured channel
		const firstArg = args[0].toLowerCase();
		const channels = this.getChannelConfig(group, "kick");
		const isChannelArg = channels.some((c) => c.channel.toLowerCase() === firstArg);

		if (isChannelArg) {
			channelName = firstArg;
			customTitle = args.slice(1).join(" ");
		} else if (channels.length === 1) {
			// If only one channel is configured, use it
			channelName = channels[0].channel;
			customTitle = args.join(" ");
		} else {
			// Multiple channels, none specified
			const channelsList = channels.map((c) => c.channel).join(", ");

			return new ReturnMessage({
				chatId: group.id,
				content:
					`Múltiplos canais do Kick configurados. Especifique o canal:\n` +
					`!g-kick-titulo on <canal> <título>\n\n` +
					`Canais configurados: ${channelsList}`
			});
		}

		// Find the channel configuration
		const channelConfig = this.findChannelConfig(group, "kick", channelName);

		if (!channelConfig) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Canal do Kick não configurado: ${channelName}. Use !g-kick-canal ${channelName} para configurar.`
			});
		}

		// If no title provided, remove custom title
		if (!customTitle) {
			delete channelConfig.onlineTitle;
			await this.database.saveGroup(group);

			return new ReturnMessage({
				chatId: group.id,
				content:
					`Título personalizado para eventos "online" do canal ${channelName} removido.\n` +
					`O bot irá substituir automaticamente "OFF" por "ON" no título do grupo quando o canal ficar online.`
			});
		}

		// Set custom title
		channelConfig.onlineTitle = customTitle;

		// Make sure title change is enabled
		if (!channelConfig.changeTitleOnEvent) {
			channelConfig.changeTitleOnEvent = true;

			await this.database.saveGroup(group);

			return new ReturnMessage({
				chatId: group.id,
				content:
					`Título personalizado para eventos "online" do canal ${channelName} definido: "${customTitle}"\n` +
					`Alteração de título para eventos foi automaticamente ativada.`
			});
		}

		await this.database.saveGroup(group);

		return new ReturnMessage({
			chatId: group.id,
			content: `Título personalizado para eventos "online" do canal ${channelName} definido: "${customTitle}"`
		});
	}

	/**
	 * Sets the custom "offline" title for a Kick channel
	 * @param {WhatsAppBot} bot - The bot instance
	 * @param {Object} message - The message object
	 * @param {Array} args - Command arguments
	 * @param {Object} group - The group object
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async setKickOfflineTitle(bot, message, args, group) {
		// Identical to Twitch version with platform name differences
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length === 0) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					"Por favor, forneça o nome do canal ou título personalizado. Exemplo: !g-kick-titulo off nomeDoCanal Título Personalizado"
			});
		}

		// Get channel name (first arg) and title (remaining args)
		let channelName, customTitle;

		// Check if first argument is a configured channel
		const firstArg = args[0].toLowerCase();
		const channels = this.getChannelConfig(group, "kick");
		const isChannelArg = channels.some((c) => c.channel.toLowerCase() === firstArg);

		if (isChannelArg) {
			channelName = firstArg;
			customTitle = args.slice(1).join(" ");
		} else if (channels.length === 1) {
			// If only one channel is configured, use it
			channelName = channels[0].channel;
			customTitle = args.join(" ");
		} else {
			// Multiple channels, none specified
			const channelsList = channels.map((c) => c.channel).join(", ");

			return new ReturnMessage({
				chatId: group.id,
				content:
					`Múltiplos canais do Kick configurados. Especifique o canal:\n` +
					`!g-kick-titulo off <canal> <título>\n\n` +
					`Canais configurados: ${channelsList}`
			});
		}

		// Find the channel configuration
		const channelConfig = this.findChannelConfig(group, "kick", channelName);

		if (!channelConfig) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Canal do Kick não configurado: ${channelName}. Use !g-kick-canal ${channelName} para configurar.`
			});
		}

		// If no title provided, remove custom title
		if (!customTitle) {
			delete channelConfig.offlineTitle;
			await this.database.saveGroup(group);

			return new ReturnMessage({
				chatId: group.id,
				content:
					`Título personalizado para eventos "offline" do canal ${channelName} removido.\n` +
					`O bot irá substituir automaticamente "ON" por "OFF" no título do grupo quando o canal ficar offline.`
			});
		}

		// Set custom title
		channelConfig.offlineTitle = customTitle;

		// Make sure title change is enabled
		if (!channelConfig.changeTitleOnEvent) {
			channelConfig.changeTitleOnEvent = true;

			await this.database.saveGroup(group);

			return new ReturnMessage({
				chatId: group.id,
				content:
					`Título personalizado para eventos "offline" do canal ${channelName} definido: "${customTitle}"\n` +
					`Alteração de título para eventos foi automaticamente ativada.`
			});
		}

		await this.database.saveGroup(group);

		return new ReturnMessage({
			chatId: group.id,
			content: `Título personalizado para eventos "offline" do canal ${channelName} definido: "${customTitle}"`
		});
	}

	/**
	 * Toggles AI generated messages for Kick stream events
	 * @param {WhatsAppBot} bot - The bot instance
	 * @param {Object} message - The message object
	 * @param {Array} args - Command arguments
	 * @param {Object} group - The group object
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async toggleKickAI(bot, message, args, group) {
		// Identical to Twitch version with platform name differences
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Validate and get channel name
		const channelName = await this.validateChannelName(bot, message, args, group, "kick");

		// If validateChannelName returned a ReturnMessage, return it
		if (channelName instanceof ReturnMessage) {
			return channelName;
		}

		// Find the channel configuration
		const channelConfig = this.findChannelConfig(group, "kick", channelName);

		if (!channelConfig) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Canal do Kick não configurado: ${channelName}. Use !g-kick-canal ${channelName} para configurar.`
			});
		}

		// Toggle the setting
		channelConfig.useAI = !channelConfig.useAI;

		await this.database.saveGroup(group);

		const status = channelConfig.useAI ? "ativadas" : "desativadas";

		if (channelConfig.useAI) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					`Mensagens geradas por IA para eventos do canal ${channelName} ${status}.\n\n` +
					`O bot usará IA para gerar mensagens personalizadas quando o canal ficar online.`
			});
		} else {
			return new ReturnMessage({
				chatId: group.id,
				content: `Mensagens geradas por IA para eventos do canal ${channelName} ${status}.`
			});
		}
	}

	/**
	 * Toggles monitoring of a YouTube channel
	 * @param {WhatsAppBot} bot - The bot instance
	 * @param {Object} message - The message object
	 * @param {Array} args - Command arguments
	 * @param {Object} group - The group object
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async toggleYoutubeChannel(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length === 0) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					"Por favor, forneça o nome ou ID do canal do YouTube. Exemplo: !g-youtube-canal nomeDoCanal"
			});
		}

		let channelName = args[0].includes("/") ? args[0].split("/").at(-1) : args[0];
		channelName = channelName.replace("@", "");

		// Get current channels
		const channels = this.getChannelConfig(group, "youtube");

		// Check if channel is already configured
		const existingChannel = this.findChannelConfig(group, "youtube", channelName);

		if (existingChannel) {
			// Remove channel
			const updatedChannels = channels.filter(
				(c) => c.channel.toLowerCase() !== channelName.toLowerCase()
			);
			group.youtube = updatedChannels;

			await this.database.saveGroup(group);

			// Unsubscribe from StreamMonitor if it exists
			if (bot.streamMonitor) {
				bot.streamMonitor.unsubscribe(channelName, "youtube");
			}

			return new ReturnMessage({
				chatId: group.id,
				content: `Canal do YouTube removido: ${channelName}`
			});
		} else {
			// Add channel with default configuration
			const newChannel = {
				channel: channelName,
				onConfig: this.createDefaultNotificationConfig("youtube", channelName),
				offConfig: {
					media: []
				},
				changeTitleOnEvent: false,
				useAI: false,
				useThumbnail: true
			};

			channels.push(newChannel);
			await this.database.saveGroup(group);

			// Atualiza bots ignorados etc (cleanup)
			await this._refreshStreamBots(group);

			// Subscribe to the channel in StreamMonitor
			if (bot.streamMonitor) {
				bot.streamMonitor.subscribe(channelName, "youtube");

				if (bot.grupoLogs) {
					bot.sendMessage(
						bot.grupoLogs,
						`Novo canal do youtube adicionado em '${group.name ?? "grupo"}' (${group.id}):\n- youtube.com/${channelName}`
					);
				}

				return new ReturnMessage({
					chatId: group.id,
					content:
						`Canal do YouTube adicionado: ${channelName}\n\n` +
						`Configuração padrão de notificação de vídeo definida. Use !g-youtube-midia on ${channelName} para personalizar.`
				});
			} else {
				return new ReturnMessage({
					chatId: group.id,
					content:
						`Canal do YouTube adicionado: ${channelName}\n\n` +
						`⚠️ Aviso: O monitoramento de canais não está inicializado no bot. Entre em contato com o administrador.`
				});
			}
		}
	}

	/**
	 * Sets a nickname for a user in a group
	 * @param {WhatsAppBot} bot - Bot instance
	 * @param {Object} message - Message data
	 * @param {Array} args - Command arguments
	 * @param {Object} group - Group data
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async setUserNickname(bot, message, args, group) {
		try {
			if (!group) {
				return new ReturnMessage({
					chatId: message.author,
					content: "Este comando só pode ser usado em grupos."
				});
			}

			// If no args, show current nickname if exists
			if (args.length === 0) {
				const userNick = this.getUserNickname(group, message.author);
				if (userNick) {
					return new ReturnMessage({
						chatId: group.id,
						content: `Seu apelido atual é: ${userNick}`
					});
				} else {
					return new ReturnMessage({
						chatId: group.id,
						content: "Você não tem um apelido definido. Use !g-apelido [apelido] para definir um."
					});
				}
			}

			// Get nickname from arguments
			let nickname = args.join(" ");

			// Limit to 20 characters
			if (nickname.length > 20) {
				nickname = nickname.substring(0, 20);

				return new ReturnMessage({
					chatId: group.id,
					content: `O apelido foi limitado a 20 caracteres: ${nickname}`
				});
			}

			// Initialize nicks array if it doesn't exist
			if (!group.nicks) {
				group.nicks = [];
			}

			// Check if user already has a nickname
			const existingIndex = group.nicks.findIndex((nick) => nick.numero === message.author);

			if (existingIndex !== -1) {
				// Update existing nickname
				group.nicks[existingIndex].apelido = nickname;
			} else {
				// Add new nickname
				group.nicks.push({
					numero: message.author,
					apelido: nickname
				});
			}

			// Save group data
			await this.database.saveGroup(group);

			return new ReturnMessage({
				chatId: group.id,
				content: `Apelido definido: ${nickname}`
			});
		} catch (error) {
			this.logger.error("Erro ao definir apelido:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "Erro ao definir apelido. Por favor, tente novamente."
			});
		}
	}

	/**
	 * Gets a user's nickname from the group
	 * @param {Object} group - Group data
	 * @param {string} userId - User ID
	 * @returns {string|null} - User's nickname or null if not set
	 */
	getUserNickname(group, userId) {
		if (!group || !group.nicks || !Array.isArray(group.nicks)) {
			return null;
		}

		const nickData = group.nicks.find((nick) => nick.numero === userId);
		return nickData ? nickData.apelido : null;
	}

	/**
	 * Ignores messages from a specific number
	 * @param {WhatsAppBot} bot - Bot instance
	 * @param {Object} message - Message data
	 * @param {Array} args - Command arguments
	 * @param {Object} group - Group data
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async ignoreUser(bot, message, args, group) {
		try {
			if (!group) {
				return new ReturnMessage({
					chatId: message.author,
					content: "Este comando só pode ser usado em grupos."
				});
			}

			if (args.length === 0) {
				// Show currently ignored users
				if (
					!group.ignoredNumbers ||
					!Array.isArray(group.ignoredNumbers) ||
					group.ignoredNumbers.length === 0
				) {
					return new ReturnMessage({
						chatId: group.id,
						content: "Nenhum número está sendo ignorado neste grupo."
					});
				} else {
					let ignoredList = "*Números ignorados:*\n";
					group.ignoredNumbers.forEach((number) => {
						ignoredList += `- ${number}\n`;
					});

					return new ReturnMessage({
						chatId: group.id,
						content: ignoredList
					});
				}
			}

			// Get number from argument and clean it (keep only digits)
			const number = args[0].replace(/\D/g, "");

			// Check if number has at least 8 digits
			if (number.length < 8) {
				return new ReturnMessage({
					chatId: group.id,
					content: "O número deve ter pelo menos 8 dígitos."
				});
			}

			// Initialize ignoredNumbers array if it doesn't exist
			if (!group.ignoredNumbers) {
				group.ignoredNumbers = [];
			}

			// Check if number is already in the list
			const index = group.ignoredNumbers.indexOf(number);

			if (index !== -1) {
				// Remove number from ignored list
				group.ignoredNumbers.splice(index, 1);
				await this.database.saveGroup(group);

				return new ReturnMessage({
					chatId: group.id,
					content: `O número ${number} não será mais ignorado.`
				});
			} else {
				// Add number to ignored list
				group.ignoredNumbers.push(number);
				await this.database.saveGroup(group);

				return new ReturnMessage({
					chatId: group.id,
					content: `O número ${number} será ignorado.`
				});
			}
		} catch (error) {
			this.logger.error("Erro ao ignorar usuário:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "Erro ao processar comando. Por favor, tente novamente."
			});
		}
	}

	async toggleMuteCategory(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length === 0) {
			// Show current muted categories
			const mutedCategories = group.mutedCategories ?? [];

			if (mutedCategories.length === 0) {
				return new ReturnMessage({
					chatId: group.id,
					content:
						"Não há categorias silenciadas neste grupo. Use !g-muteCategoria [categoria] para silenciar uma categoria inteira de comandos."
				});
			}

			return new ReturnMessage({
				chatId: group.id,
				content: `*Categorias silenciadas:*\n${mutedCategories.join(", ")}`
			});
		}

		const category = args[0].toLowerCase();

		// Initialize mutedCategories if it doesn't exist
		if (!group.mutedCategories) {
			group.mutedCategories = [];
		}

		// Check if category is already muted
		const index = group.mutedCategories.indexOf(category);

		if (index !== -1) {
			// Remove category from muted list
			group.mutedCategories.splice(index, 1);
			await this.database.saveGroup(group);

			return new ReturnMessage({
				chatId: group.id,
				content: `✅ Categoria '${category}' foi reativada.`
			});
		} else {
			// Add category to muted list
			group.mutedCategories.push(category);
			await this.database.saveGroup(group);

			return new ReturnMessage({
				chatId: group.id,
				content: `🔇 Categoria '${category}' foi silenciada.`
			});
		}
	}

	/**
	 * Mutes a fixed command
	 * @param {WhatsAppBot} bot - Bot instance
	 * @param {Object} message - Message data
	 * @param {Array} args - Command arguments
	 * @param {Object} group - Group data
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async muteCommand(bot, message, args, group) {
		try {
			if (!group) {
				return new ReturnMessage({
					chatId: message.author,
					content: "Este comando só pode ser usado em grupos."
				});
			}

			if (args.length === 0) {
				// Show currently muted commands
				if (
					!group.mutedCommands ||
					!Array.isArray(group.mutedCommands) ||
					group.mutedCommands.length === 0
				) {
					return new ReturnMessage({
						chatId: group.id,
						content: "Nenhum comando está silenciado neste grupo."
					});
				} else {
					let mutedList = "*Comandos silenciados:*\n";
					group.mutedCommands.sort().forEach((cmd) => {
						mutedList += `- ${cmd}\n`;
					});

					return new ReturnMessage({
						chatId: group.id,
						content: mutedList
					});
				}
			}

			// Normalize command name (remove prefix if present)
			let cmdName = args[0].trim();
			if (group.prefix && cmdName.startsWith(group.prefix)) {
				cmdName = cmdName.slice(group.prefix.length);
			} else if (cmdName.startsWith("!")) {
				// Also handle standard '!' prefix just in case
				cmdName = cmdName.slice(1);
			}

			// Check if command exists in fixed commands
			const fixedCommandsHandler = bot.eventHandler.commandHandler.fixedCommands;
			let targetCommand = fixedCommandsHandler.getCommand(cmdName);

			// If not found by name, try to find by reaction emoji
			if (!targetCommand && bot.eventHandler.reactionsHandler) {
				const reactionMap = bot.eventHandler.reactionsHandler.reactionCommands;
				// reactionMap is { "🎣": "pescar", ... }
				if (reactionMap && reactionMap[cmdName]) {
					const mappedName = reactionMap[cmdName];
					targetCommand = fixedCommandsHandler.getCommand(mappedName);
				}
			}

			if (!targetCommand) {
				return new ReturnMessage({
					chatId: group.id,
					content: `❌ Comando '${cmdName}' não encontrado entre os comandos fixos do bot.\nPara ver todos os comandos, use !cmd.`
				});
			}

			// Initialize mutedCommands array if it doesn't exist
			if (!group.mutedCommands) {
				group.mutedCommands = [];
			}

			// Find all commands that share the same method (aliases/siblings)
			const relatedCommands = fixedCommandsHandler.getAllCommands().filter((cmd) => {
				// Check for same method reference
				if (targetCommand.method && cmd.method === targetCommand.method) {
					return true;
				}
				// Fallback: check by name if method is null (shouldn't happen for valid commands)
				return cmd.name === targetCommand.name;
			});

			const commandNames = relatedCommands.map((c) => c.name);
			const isMuted = group.mutedCommands.includes(targetCommand.name);
			const action = isMuted ? "reativado" : "silenciado";
			const emoji = isMuted ? "✅" : "🔇";

			let changedCount = 0;

			if (isMuted) {
				// Unmute all related commands
				commandNames.forEach((name) => {
					const index = group.mutedCommands.indexOf(name);
					if (index !== -1) {
						group.mutedCommands.splice(index, 1);
						changedCount++;
					}
				});
			} else {
				// Mute all related commands
				commandNames.forEach((name) => {
					if (!group.mutedCommands.includes(name)) {
						group.mutedCommands.push(name);
						changedCount++;
					}
				});
			}

			await this.database.saveGroup(group);

			const commandsList = commandNames.join(", ");
			return new ReturnMessage({
				chatId: group.id,
				content: `${emoji} Comando(s) ${action}(s): ${commandsList}`
			});
		} catch (error) {
			this.logger.error("Erro ao configurar mute:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "Erro ao processar comando. Por favor, tente novamente."
			});
		}
	}

	/**
	 * Add custom admin
	 * @param {WhatsAppBot} bot - Bot instance
	 * @param {Object} message - Message data
	 * @param {Array} args - Command arguments
	 * @param {Object} group - Group data
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async customAdmin(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length === 0) {
			// Mostra lista atual de admins adicionais
			const admins = group.additionalAdmins ?? [];
			if (admins.length === 0) {
				return new ReturnMessage({
					chatId: group.id,
					content: "Não há administradores adicionais configurados para este grupo."
				});
			} else {
				let adminList = "*Administradores adicionais:*\n";
				for (const admin of admins) {
					// Formata o número para exibição
					const formattedNumber = this.formatPhoneNumber(admin);
					adminList += `- ${formattedNumber}\n`;
				}

				return new ReturnMessage({
					chatId: group.id,
					content: adminList
				});
			}
		}

		// Obtém e formata o número do argumento
		let numero = args[0].replace(/\D/g, "");

		// Verifica se o número tem pelo menos 8 dígitos
		if (numero.length < 8) {
			return new ReturnMessage({
				chatId: group.id,
				content: "O número deve ter pelo menos 8 dígitos."
			});
		}

		// Formata o número como 123456789012@c.us
		if (!numero.includes("@")) {
			numero = `${numero}@c.us`;
		}

		// Inicializa additionalAdmins se não existir
		if (!group.additionalAdmins) {
			group.additionalAdmins = [];
		}

		// Verifica se o número já está na lista
		const index = group.additionalAdmins.indexOf(numero);

		if (index !== -1) {
			// Remove o número
			group.additionalAdmins.splice(index, 1);
			await this.database.saveGroup(group);

			// Exibe a lista atualizada
			const admins = group.additionalAdmins ?? [];
			if (admins.length === 0) {
				return new ReturnMessage({
					chatId: group.id,
					content:
						`Número removido da lista de administradores adicionais: ${this.formatPhoneNumber(numero)}\n\n` +
						`Lista de administradores adicionais está vazia agora.`
				});
			} else {
				let adminList = "*Administradores adicionais:*\n";
				for (const admin of admins) {
					const formattedNumber = this.formatPhoneNumber(admin);
					adminList += `- ${formattedNumber}\n`;
				}

				return new ReturnMessage({
					chatId: group.id,
					content:
						`Número removido da lista de administradores adicionais: ${this.formatPhoneNumber(numero)}\n\n` +
						adminList
				});
			}
		} else {
			// Adiciona o número
			group.additionalAdmins.push(numero);
			await this.database.saveGroup(group);

			// Exibe a lista atualizada
			let adminList = "*Administradores adicionais:*\n";
			for (const admin of group.additionalAdmins) {
				const formattedNumber = this.formatPhoneNumber(admin);
				adminList += `- ${formattedNumber}\n`;
			}

			return new ReturnMessage({
				chatId: group.id,
				content:
					`Número adicionado à lista de administradores adicionais: ${this.formatPhoneNumber(numero)}\n\n` +
					adminList
			});
		}
	}

	// Método auxiliar para formatar números de telefone
	formatPhoneNumber(phoneNumber) {
		// Remove a parte @c.us
		const number = phoneNumber.replace("@c.us", "");

		// Formata como +XX (XX) 9XXXX-XXXX se tiver comprimento suficiente
		if (number.length >= 12) {
			return `+${number.substring(0, 2)} (${number.substring(2, 4)}) ${number.substring(4, 9)}-${number.substring(9)}`;
		} else {
			return number;
		}
	}

	/**
	 * Pausa ou retoma a atividade do bot no grupo
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async pauseGroup(bot, message, args, group) {
		try {
			if (!group) {
				return new ReturnMessage({
					chatId: message.author,
					content: "Este comando só pode ser usado em grupos."
				});
			}

			// Alterna o estado de pausa do grupo
			group.paused = !group.paused;

			// Salva a configuração atualizada
			await this.database.saveGroup(group);

			if (group.paused) {
				return new ReturnMessage({
					chatId: group.id,
					content:
						"⏸️ Bot pausado neste grupo. Somente o comando `!g-pausar` será processado até que seja reativado."
				});
			} else {
				return new ReturnMessage({
					chatId: group.id,
					content: "▶️ Bot reativado neste grupo. Todos os comandos estão disponíveis novamente."
				});
			}
		} catch (error) {
			this.logger.error("Erro ao pausar/retomar grupo:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "Erro ao processar comando. Por favor, tente novamente."
			});
		}
	}

	/**
	 * Alterna interações automáticas para um grupo
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async toggleInteraction(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Inicializa objeto de interação se não existir
		if (!group.interact) {
			group.interact = {
				enabled: false,
				useCmds: true,
				chance: 100, // Padrão: 1%
				cooldown: 30, // Padrão: 30 minutos
				lastInteraction: 0,
				proporcao: 50
			};
		}

		// Alterna estado de habilitado
		group.interact.enabled = !group.interact.enabled;

		// Salva mudanças
		await this.database.saveGroup(group);

		// Constrói mensagem de resposta
		let response = group.interact.enabled
			? "Interações automáticas **ativadas** para este grupo.\n\n"
			: "Interações automáticas **desativadas** para este grupo.\n\n";

		if (group.interact.enabled) {
			response += `📊 Chance atual: ${group.interact.chance / 100}%\n`;
			response += `🕐 Cooldown atual: ${group.interact.cooldown} minutos\n`;
			const proporcao = group.interact.proporcao !== undefined ? group.interact.proporcao : 50;
			response += `⚖️ Proporção atual: ${proporcao}% IA, ${100 - proporcao}% comandos\n\n`;
			response +=
				"Use `!g-interagir-chance`, `!g-interagir-cd` e `!g-interagir-proporcao` para ajustar estes valores.";
		}

		return new ReturnMessage({
			chatId: group.id,
			content: response
		});
	}

	/**
	 * Define que o bot use os comandos personalizados do grupo pra interagir
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async toggleCmdInteraction(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Inicializa objeto de interação se não existir
		if (!group.interact) {
			group.interact = {
				enabled: false,
				useCmds: true,
				chance: 100, // Padrão: 1%
				cooldown: 30, // Padrão: 30 minutos
				lastInteraction: 0,
				proporcao: 50
			};
		}

		// Atualiza cooldown
		group.interact.useCmds = !group.interact.useCmds;

		// Salva mudanças
		await this.database.saveGroup(group);

		// Constrói mensagem de resposta
		const response = group.interact.useCmds
			? "🛠 Interações automáticas com comandos personalizados **ativadas** para este grupo.\n\n"
			: "🛠 Interações automáticas com comandos personalizados **desativadas** para este grupo.\n\n";

		return new ReturnMessage({
			chatId: group.id,
			content: response
		});
	}

	/**
	 * Define o cooldown para interações automáticas
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async setInteractionCooldown(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Inicializa objeto de interação se não existir
		if (!group.interact) {
			group.interact = {
				enabled: false,
				useCmds: true,
				chance: 100, // Padrão: 1%
				cooldown: 30, // Padrão: 30 minutos
				lastInteraction: 0,
				proporcao: 50
			};
		}

		// Verifica se valor de cooldown foi fornecido
		if (args.length === 0 || isNaN(parseInt(args[0]))) {
			return new ReturnMessage({
				chatId: group.id,
				content: `🕐 Cooldown atual: ${group.interact.cooldown} minutos\n\nUse !g-interagir-cd [minutos] para alterar. Valores entre 5 minutos e 30 dias (43200 minutos).`
			});
		}

		// Analisa e valida o cooldown
		let textoMinimo = "";

		let cooldown = parseInt(args[0]);
		if (cooldown < 30) {
			textoMinimo = " (mínimo possível)";
			cooldown = 30; // Mínimo 30 minutos
		}

		if (cooldown > 43200) cooldown = 43200; // Máximo 30 dias

		// Atualiza cooldown
		group.interact.cooldown = cooldown;

		// Salva mudanças
		await this.database.saveGroup(group);

		return new ReturnMessage({
			chatId: group.id,
			content: `🕐 Cooldown de interações definido para ${cooldown} minutos${textoMinimo}.`
		});
	}

	/**
	 * Define a chance para interações automáticas
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async setInteractionChance(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Inicializa objeto de interação se não existir
		if (!group.interact) {
			group.interact = {
				enabled: false,
				useCmds: true,
				chance: 100, // Padrão: 1%
				cooldown: 30, // Padrão: 30 minutos
				lastInteraction: 0,
				proporcao: 50
			};
		}

		if (group.interact.proporcao === undefined) {
			group.interact.proporcao = 50;
		}

		// Verifica se valor de chance foi fornecido
		if (args.length === 0 || isNaN(parseInt(args[0]))) {
			return new ReturnMessage({
				chatId: group.id,
				content: `📊 Chance atual: ${group.interact.chance / 100}% (${group.interact.chance}/10000)\n\nUse !g-interagir-chance [1-1000] para alterar. Valores entre 0.01% e 10%.`
			});
		}

		let textoMaximo = "";
		// Analisa e valida a chance
		let chance = parseInt(args[0]);
		if (chance < 1) chance = 1; // Mínimo 0.01%
		if (chance >= 500) {
			chance = 500; // Máximo 5%
			textoMaximo = " (máximo possível)";
		}

		// Atualiza chance
		group.interact.chance = chance;

		// Salva mudanças
		await this.database.saveGroup(group);

		return new ReturnMessage({
			chatId: group.id,
			content: `📊 Chance de interações definida para ${chance / 100}%${textoMaximo}.`
		});
	}

	/**
	 * Define a proporção de interação automática (chance para IA vs comandos)
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async setInteractionProportion(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Inicializa objeto de interação se não existir
		if (!group.interact) {
			group.interact = {
				enabled: false,
				useCmds: true,
				chance: 100, // Padrão: 1%
				cooldown: 30, // Padrão: 30 minutos
				lastInteraction: 0,
				proporcao: 50
			};
		}

		if (group.interact.proporcao === undefined) {
			group.interact.proporcao = 50;
		}

		const helperText = `Para usar apenas *IA* na interação, envie:\n!g-interagir-proporcao 100\n\nPara usar apenas *comandos* na interação, envie:\n!g-interagir-proporcao 0`;

		// Verifica se valor da proporção foi fornecido
		if (args.length === 0 || isNaN(parseInt(args[0]))) {
			return new ReturnMessage({
				chatId: group.id,
				content: `📊 Proporção de interação atual: ${group.interact.proporcao}% para IA e ${100 - group.interact.proporcao}% para comandos.\n\nUse !g-interagir-proporcao [0-100] para alterar.\n\n${helperText}`
			});
		}

		// Analisa e valida a proporção
		let proporcao = parseInt(args[0]);
		if (proporcao < 0) proporcao = 0;
		if (proporcao > 100) proporcao = 100;

		// Atualiza proporção
		group.interact.proporcao = proporcao;

		// Salva mudanças
		await this.database.saveGroup(group);

		let fraseSimples = "";
		if (proporcao === 100) {
			fraseSimples = "Usando apenas *IA* para interagir";
		} else if (proporcao === 0) {
			fraseSimples = "Usando apenas *comandos* para interagir";
		} else {
			fraseSimples = `${100 - proporcao}% de chance de usar algum comando, ${proporcao}% de chance de usar IA para interagir`;
		}

		return new ReturnMessage({
			chatId: group.id,
			content: `📊 Proporção de interação definida para ${proporcao}% IA e ${100 - proporcao}% comandos.\n\n_${fraseSimples}_\n\n${helperText}`
		});
	}

	/**
	 * Comando !g-manage sem argumentos para usar no grupo
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async manageCommand(bot, message, args, group, privateManagement) {
		try {
			// Verifica se está em um grupo
			if (!message.group) {
				return new ReturnMessage({
					chatId: message.author,
					content:
						"Você já está em um chat privado comigo. Para gerenciar um grupo, use: !g-manage [nomeDoGrupo] (teste também: !g-painel)"
				});
			}

			// Configura o gerenciamento do grupo pelo PV
			privateManagement[message.author] = group.id;
			this.logger.info(
				`Usuário ${message.author} ativou gerenciamento do grupo ${group.name} (${group.id}) via comando direto no grupo`
			);

			// Envia mensagem para o autor no PV
			const returnMessagePV = new ReturnMessage({
				chatId: message.author,
				content: `🔧 Você agora está gerenciando o grupo: *${group.name}*\nVocê pode usar os comandos de administração aqui no privado para configurar o grupo sem poluí-lo com mensagens de configuração.\n\n🔥Teste também a administração web enviando: \`!g-painel\``
			});

			// Envia mensagem no grupo
			const returnMessageGroup = new ReturnMessage({
				chatId: group.id,
				content: `✅ ${message.authorName ?? "Administrador"} agora está gerenciando o grupo pelo chat privado.`
			});

			return [returnMessageGroup, returnMessagePV];
		} catch (error) {
			this.logger.error("Erro ao configurar gerenciamento de grupo:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "❌ Erro ao configurar gerenciamento de grupo. Por favor, tente novamente."
			});
		}
	}

	/**
	 * Sets the "online" or "offline" media notification for a platform channel
	 * @param {WhatsAppBot} bot - The bot instance
	 * @param {Object} message - The message object
	 * @param {Array} args - Command arguments
	 * @param {Object} group - The group object
	 * @param {string} platform - The platform name (twitch, kick, youtube)
	 * @param {string} mode - The mode (on or off)
	 * @returns {Promise<ReturnMessage>} Return message
	 */
	async setStreamMedia(bot, message, args, group, platform, mode = "on") {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		this.logger.debug(`[setStreamMedia] Recebido pedido para: ${args.join("|")}, modo ${mode}`);

		// Determina o modo (online/offline) a partir dos argumentos
		if (args.length > 0) {
			const modeArg = args[0].toLowerCase();
			if (modeArg === "on" || modeArg === "online") {
				mode = "on";
				args = args.slice(1); // Remove o primeiro argumento
			} else if (modeArg === "off" || modeArg === "offline") {
				mode = "off";
				args = args.slice(1); // Remove o primeiro argumento
			}
		}

		// Validate and get channel name
		const channelName = await this.validateChannelName(bot, message, args, group, platform);

		// If validateChannelName returned a ReturnMessage, return it
		if (channelName instanceof ReturnMessage) {
			return channelName;
		}

		// Find the channel configuration
		const channelConfig = this.findChannelConfig(group, platform, channelName);

		if (!channelConfig) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Canal do ${platform} não configurado: ${channelName}. Use !g-${platform}-canal ${channelName} para configurar.`
			});
		}

		// Verify if this is a reply to a message

		const quotedMsg = await message.origin.getQuotedMessage().catch(() => null);

		const configKey = mode === "on" ? "onConfig" : "offConfig";

		if (!quotedMsg && args.length <= 1) {
			this.logger.debug(`[stream media] no quoted`, { quotedMsg, message });

			if (message.isQuoted) {
				return new ReturnMessage({
					chatId: group.id,
					content: `Ocorreu um erro e não consegui buscar a mensagem que você marcou.`
				});
			} else {
				// Reset to default if no quoted message and no additional args
				if (mode === "on") {
					channelConfig[configKey] = this.createDefaultNotificationConfig(platform, channelName);
				} else {
					channelConfig[configKey] = { media: [] };
				}
				await this.database.saveGroup(group);

				return new ReturnMessage({
					chatId: group.id,
					content: `Configuração de notificação "${mode === "on" ? "online" : "offline"}" para o canal ${channelName} redefinida para o padrão.`
				});
			}
		}

		if (!quotedMsg) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					"Este comando deve ser usado como resposta a uma mensagem ou mídia para definir a notificação."
			});
		}

		// Handle media message
		try {
			// Create media configuration
			const mediaConfig = {
				type: "text",
				content:
					quotedMsg.caption ?? quotedMsg.content ?? quotedMsg.body ?? quotedMsg._data.body ?? ""
			};

			// For media messages, add the media type
			let mediaType = "text";
			if (quotedMsg.hasMedia) {
				this.logger.debug(`[stream] hasMedia`, quotedMsg);
				const media = await quotedMsg.downloadMedia({ keep: true });
				mediaType = media.mimetype.split("/")[0]; // 'image', 'audio', 'video', etc.
				let fileExt = media.mimetype.split("/")[1];

				// Sticker animado ou GIF PRECISAM ser uma url
				let mediaUrl = false;

				// GIF transformar em sticker animado
				if (quotedMsg.type.toLowerCase() === "gif") {
					mediaType = "sticker";
					mediaUrl = await bot.convertToSquareAnimatedGif(media.data, true);
				}

				if (media.stickerGif) {
					// Caso especial: sticker animado é URL
					mediaType = "sticker";
					mediaUrl = media.stickerGif;
				}

				if (quotedMsg.type.toLowerCase() === "voice") {
					mediaType = "voice";
				}

				// Sticker tem mimetype image, corrige
				if (quotedMsg.type.toLowerCase() === "sticker") {
					mediaType = "sticker";
				}

				// Save media file
				if (fileExt.includes(";")) {
					fileExt = fileExt.split(";")[0];
				}

				mediaConfig.type = mediaType;

				if (mediaUrl) {
					mediaConfig.content = mediaUrl;
				} else {
					const fileName = `${Date.now()}-${Math.floor(Math.random() * 1000)}.${fileExt}`;
					const mediaDir = path.join(this.dataPath, "media");
					await fs.mkdir(mediaDir, { recursive: true });

					const filePath = path.join(mediaDir, fileName);
					await fs.writeFile(filePath, Buffer.from(media.data, "base64"));

					mediaConfig.content = fileName;
					mediaConfig.caption = quotedMsg.caption ?? "";
				}
			}

			// Initialize the config if it doesn't exist
			if (!channelConfig[configKey]) {
				channelConfig[configKey] = { media: [] };
			}

			// Make sure media array exists
			if (!channelConfig[configKey].media) {
				channelConfig[configKey].media = [];
			}

			// FIX: Check if we already have a media of this type
			const existingMediaIndex = channelConfig[configKey].media.findIndex(
				(m) => m.type === mediaConfig.type
			);

			if (existingMediaIndex !== -1) {
				// Replace just this media type entry
				channelConfig[configKey].media[existingMediaIndex] = mediaConfig;
			} else {
				// Add the new media entry
				channelConfig[configKey].media.push(mediaConfig);
			}

			await this.database.saveGroup(group);

			const mediaTypeDesc = {
				text: "texto",
				image: "imagem",
				audio: "áudio",
				video: "vídeo",
				voice: "audio de voz",
				sticker: "sticker"
			};

			return new ReturnMessage({
				chatId: group.id,
				content: `Configuração de notificação "${mode === "on" ? "online" : "offline"}" para o canal ${channelName} atualizada com sucesso.\n\nAdicionado conteúdo do tipo: ${mediaTypeDesc[mediaType] || mediaType}\n\nPara remover este tipo de conteúdo, use:\n!g-${platform}-midia-del ${mode} ${mediaType} ${channelName}`
			});
		} catch (error) {
			this.logger.error(
				`Erro ao configurar notificação "${mode}" para o canal ${channelName}:`,
				error
			);

			return new ReturnMessage({
				chatId: group.id,
				content: `Erro ao configurar notificação: ${error.message}`
			});
		}
	}
	/**
	 * Remove um tipo específico de mídia da configuração de stream
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @param {string} platform - Plataforma (twitch, kick, youtube)
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async deleteStreamMedia(bot, message, args, group, platform) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Verifica se todos os argumentos necessários foram fornecidos
		if (args.length < 2) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Argumentos insuficientes. Uso: !g-${platform}-midia-del [on/off] [tipo]
        
  Onde:
  - [on/off]: Especifica se é para notificação online ou offline
  - [tipo]: Tipo de mídia (text, image, audio, video, sticker)`
			});
		}

		// Determina o modo (online/offline)
		const mode = args[0].toLowerCase();
		if (mode !== "on" && mode !== "off") {
			return new ReturnMessage({
				chatId: group.id,
				content: `Modo inválido: ${mode}. Use "on" ou "off".`
			});
		}

		// Determina o tipo de mídia
		const mediaType = args[1].toLowerCase();
		if (!["text", "image", "audio", "video", "sticker"].includes(mediaType)) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Tipo de mídia inválido: ${mediaType}. Tipos válidos: text, image, audio, video, sticker`
			});
		}

		// Valida e obtém o nome do canal
		const channelName = await this.validateChannelName(
			bot,
			message,
			args.slice(2),
			group,
			platform
		);

		// Se validateChannelName retornou um ReturnMessage, retorna-o
		if (channelName instanceof ReturnMessage) {
			return channelName;
		}

		// Encontra a configuração do canal
		const channelConfig = this.findChannelConfig(group, platform, channelName);

		if (!channelConfig) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Canal não configurado: ${channelName}. Use !g-${platform}-canal ${channelName} para configurar.`
			});
		}

		// Seleciona a configuração correta com base no modo
		const configKey = mode === "on" ? "onConfig" : "offConfig";

		// Verifica se a configuração e o array de mídia existem
		if (!channelConfig[configKey] || !channelConfig[configKey].media) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Nenhuma mídia configurada para ${mode} no canal ${channelName}.`
			});
		}

		// Filtra para remover o tipo de mídia especificado
		const originalLength = channelConfig[configKey].media.length;
		channelConfig[configKey].media = channelConfig[configKey].media.filter(
			(item) => item.type !== mediaType
		);

		// Verifica se algo foi removido
		if (channelConfig[configKey].media.length === originalLength) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Nenhuma mídia do tipo "${mediaType}" encontrada para ${mode} no canal ${channelName}.`
			});
		}

		// Salva a configuração atualizada
		await this.database.saveGroup(group);

		return new ReturnMessage({
			chatId: group.id,
			content: `Mídia do tipo "${mediaType}" removida com sucesso da configuração ${mode} para o canal ${channelName}.`
		});
	}

	/**
	 * Define a foto do grupo para quando uma stream ficar online/offline
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @param {string} platform - Plataforma (twitch, kick, youtube)
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async setStreamGroupPhoto(bot, message, args, group, platform) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Verifica se o bot é administrador do grupo
		const isAdmin = await this.isBotAdmin(bot, group);
		if (!isAdmin) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					"⚠️ O bot não é administrador do grupo. Para alterar a foto do grupo, o bot precisa ser um administrador."
			});
		}

		// Determina o modo (online/offline) a partir dos argumentos
		let mode = "on";
		if (args.length > 0) {
			const modeArg = args[0].toLowerCase();
			if (modeArg === "on" || modeArg === "online") {
				mode = "on";
				args = args.slice(1); // Remove o primeiro argumento
			} else if (modeArg === "off" || modeArg === "offline") {
				mode = "off";
				args = args.slice(1); // Remove o primeiro argumento
			}
		}

		// Valida e obtém o nome do canal
		const channelName = await this.validateChannelName(bot, message, args, group, platform);

		// Se validateChannelName retornou um ReturnMessage, retorna-o
		if (channelName instanceof ReturnMessage) {
			return channelName;
		}

		// Encontra a configuração do canal
		const channelConfig = this.findChannelConfig(group, platform, channelName);

		if (!channelConfig) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Canal não configurado: ${channelName}. Use !g-${platform}-canal ${channelName} para configurar.`
			});
		}

		// Verifica se há uma mensagem citada com mídia ou se a mensagem atual tem mídia
		let mediaData = null;

		// 1. Tenta obter da mensagem citada
		const quotedMsg = await message.origin.getQuotedMessage().catch(() => null);
		if (quotedMsg && quotedMsg.hasMedia) {
			try {
				const media = await quotedMsg.downloadMedia();
				if (media.mimetype.startsWith("image/")) {
					// Salva arquivo no disco em vez de base64 no banco
					const ext = media.mimetype.split("/")[1].split(";")[0] || "jpg";
					const fileName = `group-photo-${Date.now()}-${Math.floor(Math.random() * 1000)}.${ext}`;
					const mediaDir = path.join(this.dataPath, "media");
					await fs.mkdir(mediaDir, { recursive: true });

					await fs.writeFile(path.join(mediaDir, fileName), Buffer.from(media.data, "base64"));
					mediaData = fileName;
				}
			} catch (error) {
				this.logger.error("Erro ao baixar mídia da mensagem citada:", error);
			}
		}

		// 2. Se não encontrou na mensagem citada, verifica a mensagem atual
		if (!mediaData && message.type === "image" && message.content) {
			let imageData = message.content.data;
			if (!imageData && typeof message.downloadMedia === "function") {
				try {
					const media = await message.downloadMedia();
					imageData = media?.data;
				} catch (e) {
					this.logger.error("Erro ao baixar imagem da mensagem atual:", e);
				}
			}

			if (imageData) {
				const ext = message.content.mimetype.split("/")[1].split(";")[0] || "jpg";
				const fileName = `group-photo-${Date.now()}-${Math.floor(Math.random() * 1000)}.${ext}`;
				const mediaDir = path.join(this.dataPath, "media");
				await fs.mkdir(mediaDir, { recursive: true });

				await fs.writeFile(path.join(mediaDir, fileName), Buffer.from(imageData, "base64"));
				mediaData = fileName;
			}
		}

		// Se não há argumentos e não há mídia, remove a configuração de foto
		if (args.length === 0 && !mediaData) {
			if (mode === "on") {
				delete channelConfig.groupPhotoOnline;
			} else {
				delete channelConfig.groupPhotoOffline;
			}

			await this.database.saveGroup(group);

			return new ReturnMessage({
				chatId: group.id,
				content: `Configuração de foto do grupo para eventos ${mode} do canal ${channelName} removida.`
			});
		}

		// Se não há mídia, instrui o usuário
		if (!mediaData) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Para definir a foto do grupo para eventos ${mode} do canal ${channelName}, envie uma imagem com o comando na legenda ou use o comando como resposta a uma imagem.`
			});
		}

		// Salva a configuração de foto
		if (mode === "on") {
			channelConfig.groupPhotoOnline = mediaData;
		} else {
			channelConfig.groupPhotoOffline = mediaData;
		}

		// Ativa mudança de título se não estiver ativa
		if (!channelConfig.changeTitleOnEvent) {
			channelConfig.changeTitleOnEvent = true;
		}

		await this.database.saveGroup(group);

		return new ReturnMessage({
			chatId: group.id,
			content: `Foto do grupo para eventos ${mode === "on" ? "online" : "offline"} do canal ${channelName} configurada com sucesso.
      
  A mudança de título para eventos também foi automaticamente ativada.`
		});
	}

	/**
	 * Manipulador unificado para comandos de título de stream
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @param {string} platform - Plataforma (twitch, kick, youtube)
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async setStreamTitle(bot, message, args, group, platform) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Determina o modo (online/offline) a partir dos argumentos
		let mode = "on";
		let titleArgs = [...args];

		if (args.length > 0) {
			const modeArg = args[0].toLowerCase();
			if (modeArg === "on" || modeArg === "online") {
				mode = "on";
				titleArgs = args.slice(1); // Remove o primeiro argumento
			} else if (modeArg === "off" || modeArg === "offline") {
				mode = "off";
				titleArgs = args.slice(1); // Remove o primeiro argumento
			}
		}

		// Separa o primeiro argumento como possível nome de canal e o resto como título
		let channelArg = null;
		let customTitle = null;

		if (titleArgs.length > 0) {
			// Verifica se o primeiro argumento é um canal configurado
			const firstArg = titleArgs[0].toLowerCase();
			const channels = this.getChannelConfig(group, platform);
			const isChannelArg = channels.some((c) => c.channel.toLowerCase() === firstArg);

			if (isChannelArg) {
				channelArg = firstArg;
				customTitle = titleArgs.slice(1).join(" ");
			} else if (channels.length === 1) {
				// Se há apenas um canal configurado, usa ele
				channelArg = channels[0].channel;
				customTitle = titleArgs.join(" ");
			} else if (channels.length === 0) {
				return new ReturnMessage({
					chatId: group.id,
					content: `Nenhum canal de ${platform} configurado. Use !g-${platform}-canal <nome do canal> para configurar.`
				});
			} else {
				// Múltiplos canais, nenhum especificado
				const channelsList = channels.map((c) => c.channel).join(", ");

				return new ReturnMessage({
					chatId: group.id,
					content:
						`Múltiplos canais de ${platform} configurados. Especifique o canal:\n` +
						`!g-${platform}-titulo ${mode} <canal> <título>\n\n` +
						`Canais configurados: ${channelsList}`
				});
			}
		} else if (
			args.length === 0 ||
			(args.length === 1 && (args[0] === "on" || args[0] === "off"))
		) {
			// Sem argumentos além do modo, verifica se há apenas um canal
			const channels = this.getChannelConfig(group, platform);

			if (channels.length === 1) {
				channelArg = channels[0].channel;
				customTitle = null; // Removerá o título personalizado
			} else if (channels.length === 0) {
				return new ReturnMessage({
					chatId: group.id,
					content: `Nenhum canal de ${platform} configurado. Use !g-${platform}-canal <nome do canal> para configurar.`
				});
			} else {
				// Múltiplos canais, nenhum especificado
				const channelsList = channels.map((c) => c.channel).join(", ");

				return new ReturnMessage({
					chatId: group.id,
					content:
						`Múltiplos canais de ${platform} configurados. Especifique o canal:\n` +
						`!g-${platform}-titulo ${mode} <canal>\n\n` +
						`Canais configurados: ${channelsList}`
				});
			}
		}

		// Encontra a configuração do canal
		const channelConfig = this.findChannelConfig(group, platform, channelArg);

		if (!channelConfig) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Canal de ${platform} não configurado: ${channelArg}. Use !g-${platform}-canal ${channelArg} para configurar.`
			});
		}

		// Verifica se o bot é administrador para alterar título
		const isAdmin = await this.isBotAdmin(bot, group);
		if (!isAdmin) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					"⚠️ O bot não é administrador do grupo. Para alterar o título do grupo, o bot precisa ser um administrador."
			});
		}

		// Atualiza ou remove título personalizado com base no modo
		if (mode === "on") {
			if (customTitle === null || customTitle === "") {
				delete channelConfig.onlineTitle;
				await this.database.saveGroup(group);

				return new ReturnMessage({
					chatId: group.id,
					content:
						`Título personalizado para eventos "online" do canal ${channelArg} removido.\n` +
						`O bot irá substituir automaticamente "OFF" por "ON" no título do grupo quando o canal ficar online.`
				});
			} else {
				channelConfig.onlineTitle = customTitle;
			}
		} else {
			if (customTitle === null || customTitle === "") {
				delete channelConfig.offlineTitle;
				await this.database.saveGroup(group);

				return new ReturnMessage({
					chatId: group.id,
					content:
						`Título personalizado para eventos "offline" do canal ${channelArg} removido.\n` +
						`O bot irá substituir automaticamente "ON" por "OFF" no título do grupo quando o canal ficar offline.`
				});
			} else {
				channelConfig.offlineTitle = customTitle;
			}
		}

		// Ativa mudança de título se não estiver ativa
		if (!channelConfig.changeTitleOnEvent) {
			channelConfig.changeTitleOnEvent = true;
		}

		await this.database.saveGroup(group);

		return new ReturnMessage({
			chatId: group.id,
			content:
				`Título personalizado para eventos "${mode}" do canal ${channelArg} definido: "${customTitle}"\n` +
				`Alteração de título para eventos foi ativada.`
		});
	}

	/**
	 * Lista todas as variáveis disponíveis para uso em comandos personalizados
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async listVariables(bot, message, args, group) {
		try {
			const chatId = message.group ?? message.author;

			// Obtém variáveis personalizadas do banco de dados
			const customVariables = await this.database.getCustomVariables();

			// Lista de variáveis de sistema
			const systemVariables = [
				{ name: "{day}", description: "Nome do dia atual (ex: Segunda-feira)" },
				{ name: "{date}", description: "Data atual" },
				{ name: "{time}", description: "Hora atual" },
				{ name: "{data-hora}", description: "Hora atual (apenas o número)" },
				{ name: "{data-minuto}", description: "Minuto atual (apenas o número)" },
				{ name: "{data-segundo}", description: "Segundo atual (apenas o número)" },
				{ name: "{data-dia}", description: "Dia atual (apenas o número)" },
				{ name: "{data-mes}", description: "Mês atual (apenas o número)" },
				{ name: "{data-ano}", description: "Ano atual (apenas o número)" }
			];

			// Lista de variáveis de números aleatórios
			const randomVariables = [
				{ name: "{randomPequeno}", description: "Número aleatório de 1 a 10" },
				{ name: "{randomMedio}", description: "Número aleatório de 1 a 100" },
				{ name: "{randomGrande}", description: "Número aleatório de 1 a 1000" },
				{ name: "{randomMuitoGrande}", description: "Número aleatório de 1 a 10000" },
				{ name: "{rndDado-X}", description: "Simula dado de X lados (substitua X pelo número)" },
				{
					name: "{rndDadoRange-X-Y}",
					description: "Número aleatório entre X e Y (substitua X e Y)"
				},
				{ name: "{somaRandoms}", description: "Soma dos números aleatórios anteriores na mensagem" }
			];

			// Lista de variáveis de contexto
			const contextVariables = [
				{ name: "{pessoa}", description: "Nome do autor da mensagem" },
				{ name: "{nomeAutor}", description: "Nome do autor da mensagem (mesmo que {pessoa})" },
				{ name: "{group}", description: "Nome do grupo" },
				{ name: "{nomeCanal}", description: "Nome do grupo (mesmo que {group})" },
				{ name: "{nomeGrupo}", description: "Nome do grupo (mesmo que {group})" },
				{ name: "{contador}", description: "Número de vezes que o comando foi executado" },
				{
					name: "{mention}",
					description:
						"Marca a pessoa mencionada (na própria mensage, na mensagem resposta ou alguém aleatório). A cada ocorrência pega um mention diferente"
				},
				{
					name: "{singleMention}",
					description:
						"Igual ao {mention}, mas troca todas as ocorrências da variável pra mesma ao invés de escolher outro membro aleatório"
				},
				{
					name: "{mentionOuEu}",
					description:
						"Igual ao {singleMention}, mas ao invés de escolher um membro aleatório caso não exista mention, marca quem enviou a mensagem"
				},
				{ name: "{mention-5511999999999@c.us}", description: "Menciona usuário específico" }
			];

			// Lista de variáveis de API
			const apiVariables = [
				{ name: "{reddit-XXXX}", description: "Busca mídia em um subreddit" },
				{ name: "{API#GET#TEXT#url}", description: "Faz uma requisição GET e retorna o texto" },
				{
					name: "{API#GET#JSON#url\ntemplate}",
					description: "Faz uma requisição GET e formata o JSON"
				},
				{
					name: "{API#POST#TEXT#url?param=valor}",
					description: "Faz uma requisição POST com parâmetros"
				}
			];

			// Lista de variáveis de arquivo
			const fileVariables = [
				{ name: "{file-nomeArquivo}", description: "Envia arquivo da pasta 'data/media/'" },
				{ name: "{file-pasta/}", description: "Envia até 5 arquivos da pasta 'data/media/pasta/'" }
			];

			// Lista de variáveis de comando
			const commandVariables = [
				{
					name: "{cmd-!comando arg1 arg2}",
					description: "Executa outro comando (criando um alias)"
				}
			];

			// Lista de variáveis de Boas Vindas/despedidas
			const welcomeVaribles = [
				{ name: "{pessoa}", description: "Nome(s) da(s) pessoa(s) adicionada(s) no grupo" },
				{ name: "{tituloGrupo}", description: "Título do grupo no whatsApp" },
				{ name: "{nomeGrupo}", description: "ID do grupo na ravena" }
			];

			// Constrói a mensagem de resposta
			let response = `*📝 Variáveis Disponíveis para Comandos Personalizados*\n\n> Quando você colocar {estas} {coisas} na resposta de um comando, o bot irár substituir por um texto conforme a tabela apresentada abaixo.\n\n`;

			// Adiciona variáveis de boas vindas/despedida
			response += `🚪 *Boas vindas/despedidas*:\n`;
			for (const variable of welcomeVaribles) {
				response += `• ${variable.name} - ${variable.description}\n`;
			}
			response += "\n";

			// Adiciona variáveis de sistema
			response += `🕐 *Variáveis de Sistema*:\n`;
			for (const variable of systemVariables) {
				response += `• ${variable.name} - ${variable.description}\n`;
			}
			response += "\n";

			// Adiciona variáveis de números aleatórios
			response += `🎲 *Variáveis de Números Aleatórios*:\n`;
			for (const variable of randomVariables) {
				response += `• ${variable.name} - ${variable.description}\n`;
			}
			response += "\n";

			// Adiciona variáveis de contexto
			response += `👤 *Variáveis de Contexto*:\n`;
			for (const variable of contextVariables) {
				response += `• ${variable.name} - ${variable.description}\n`;
			}
			response += "\n";

			// Adiciona variáveis de API
			response += `🌐 *Variáveis de API*:\n`;
			for (const variable of apiVariables) {
				response += `• ${variable.name} - ${variable.description}\n`;
			}
			response += "\n";

			// Adiciona variáveis de arquivo
			response += `📁 *Variáveis de Arquivo*:\n`;
			for (const variable of fileVariables) {
				response += `• ${variable.name} - ${variable.description}\n`;
			}
			response += "\n";

			// Adiciona variáveis de comando
			response += `⚙️ *Variáveis de Comando*:\n`;
			for (const variable of commandVariables) {
				response += `• ${variable.name} - ${variable.description}\n`;
			}
			response += "\n";

			// Adiciona variáveis personalizadas
			if (customVariables && Object.keys(customVariables).length > 0) {
				response += `🔍 *Variáveis Personalizadas*:\n`;
				for (const [key, value] of Object.entries(customVariables)) {
					const valueType = Array.isArray(value)
						? `Array com ${value.length} items`
						: typeof value === "string"
							? "Texto"
							: typeof value;

					response += `• {${key}} - ${valueType}\n`;
				}
			}

			return new ReturnMessage({
				chatId,
				content: response
			});
		} catch (error) {
			this.logger.error("Erro ao listar variáveis:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "Erro ao listar variáveis disponíveis. Por favor, tente novamente."
			});
		}
	}

	/**
	 * Métodos auxiliares para encaminhar comandos unificados para cada plataforma específica
	 */

	// Métodos para mídia
	async setTwitchMedia(bot, message, args, group) {
		return this.setStreamMedia(bot, message, args, group, "twitch");
	}

	async setKickMedia(bot, message, args, group) {
		return this.setStreamMedia(bot, message, args, group, "kick");
	}

	async setYoutubeMedia(bot, message, args, group) {
		return this.setStreamMedia(bot, message, args, group, "youtube");
	}

	// Métodos para excluir mídia
	async deleteTwitchMedia(bot, message, args, group) {
		return this.deleteStreamMedia(bot, message, args, group, "twitch");
	}

	async deleteKickMedia(bot, message, args, group) {
		return this.deleteStreamMedia(bot, message, args, group, "kick");
	}

	async deleteYoutubeMedia(bot, message, args, group) {
		return this.deleteStreamMedia(bot, message, args, group, "youtube");
	}

	// Métodos para título
	async setTwitchTitle(bot, message, args, group) {
		return this.setStreamTitle(bot, message, args, group, "twitch");
	}

	async setKickTitle(bot, message, args, group) {
		return this.setStreamTitle(bot, message, args, group, "kick");
	}

	async setYoutubeTitle(bot, message, args, group) {
		return this.setStreamTitle(bot, message, args, group, "youtube");
	}

	// Métodos para foto do grupo
	async setTwitchGroupPhoto(bot, message, args, group) {
		return this.setStreamGroupPhoto(bot, message, args, group, "twitch");
	}

	async setKickGroupPhoto(bot, message, args, group) {
		return this.setStreamGroupPhoto(bot, message, args, group, "kick");
	}

	async setYoutubeGroupPhoto(bot, message, args, group) {
		return this.setStreamGroupPhoto(bot, message, args, group, "youtube");
	}

	/**
	 * Define horários permitidos para um comando personalizado
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async setCmdInteragir(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length < 1) {
			return new ReturnMessage({
				chatId: group.id,
				content: "Por favor, forneça um nome de comando. Exemplo: !g-cmd-setInteragir comando"
			});
		}

		const commandName = args[0];
		const emoji = args[1];

		// Verifica se é um comando personalizado
		const customCommands = await this.database.getCustomCommands(group.id);
		const customCommand = customCommands.find(
			(cmd) => cmd.startsWith === commandName && !cmd.deleted
		);

		if (customCommand) {
			if (customCommand.ignoreInteract) {
				customCommand.ignoreInteract = false;
			} else {
				customCommand.ignoreInteract = true;
			}

			// Atualiza o comando
			await this.database.updateCustomCommand(group.id, customCommand);

			// Limpa cache de comandos para garantir que o comando atualizado seja carregado
			this.database.clearCache(`commands:${group.id}`);

			// Recarrega comandos
			await bot.eventHandler.commandHandler.loadCustomCommandsForGroup(group.id);

			return new ReturnMessage({
				chatId: group.id,
				content: `Definido '${commandName}' para ${customCommand.ignoreInteract ? "*não*" : ""}ser usado nas interações aleatórias`
			});
		}

		return new ReturnMessage({
			chatId: group.id,
			content: `Comando personalizado '${commandName}' não encontrado.${this.help.naoEncontrado}`
		});
	}

	/**
	 * Define horários permitidos para um comando personalizado
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async setCmdAdmin(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length < 1) {
			return new ReturnMessage({
				chatId: group.id,
				content: "Por favor, forneça um nome de comando. Exemplo: !g-cmd-setAdm comando"
			});
		}

		const commandName = args[0];
		const emoji = args[1];

		// Verifica se é um comando personalizado
		const customCommands = await this.database.getCustomCommands(group.id);
		const customCommand = customCommands.find(
			(cmd) => cmd.startsWith === commandName && !cmd.deleted
		);

		if (customCommand) {
			if (!customCommand.adminOnly) {
				customCommand.adminOnly = true;
			} else {
				customCommand.adminOnly = false;
			}

			// Atualiza o comando
			await this.database.updateCustomCommand(group.id, customCommand);

			// Limpa cache de comandos para garantir que o comando atualizado seja carregado
			this.database.clearCache(`commands:${group.id}`);

			// Recarrega comandos
			await bot.eventHandler.commandHandler.loadCustomCommandsForGroup(group.id);

			return new ReturnMessage({
				chatId: group.id,
				content: `Definido '${commandName}' para ${customCommand.adminOnly ? "apenas administradores" : "sem restrição de adm"}`
			});
		}

		return new ReturnMessage({
			chatId: group.id,
			content: `Comando personalizado '${commandName}' não encontrado.${this.help.naoEncontrado}`
		});
	}
	/**
	 * Define horários permitidos para um comando personalizado
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async setCmdAllowedHours(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length === 0) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					"Por favor, forneça o nome do comando e, opcionalmente, os horários permitidos. Exemplo: !g-cmd-setHoras comando 08:00 20:00"
			});
		}

		// Obtém o nome do comando
		const commandName = args[0];

		// Obtém os horários (start e end)
		let startTime = null;
		let endTime = null;

		if (args.length >= 3) {
			startTime = args[1];
			endTime = args[2];

			// Valida o formato das horas (HH:MM)
			const timeRegex = /^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/;
			if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
				return new ReturnMessage({
					chatId: group.id,
					content: "Formato de hora inválido. Use o formato HH:MM, por exemplo: 08:00 20:00"
				});
			}
		}

		// Busca o comando personalizado
		const commands = await this.database.getCustomCommands(group.id);
		const command = commands.find((cmd) => cmd.startsWith === commandName && !cmd.deleted);

		if (!command) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Comando personalizado '${commandName}' não encontrado.${this.help.naoEncontrado}`
			});
		}

		// Inicializa ou atualiza a propriedade allowedTimes
		if (!command.allowedTimes) {
			command.allowedTimes = {};
		}

		// Se não forneceu horários, remove a restrição
		if (!startTime || !endTime) {
			if (command.allowedTimes) {
				delete command.allowedTimes.start;
				delete command.allowedTimes.end;

				// Se não houver mais restrições, remove a propriedade inteira
				if (!command.allowedTimes.daysOfWeek || command.allowedTimes.daysOfWeek.length === 0) {
					delete command.allowedTimes;
				}
			}

			// Atualiza o comando
			await this.database.updateCustomCommand(group.id, command);

			// Limpa cache de comandos
			this.database.clearCache(`commands:${group.id}`);
			await bot.eventHandler.commandHandler.loadCustomCommandsForGroup(group.id);

			return new ReturnMessage({
				chatId: group.id,
				content: `Restrição de horário removida para o comando '${commandName}'.`
			});
		}

		// Atualiza os horários permitidos
		command.allowedTimes.start = startTime;
		command.allowedTimes.end = endTime;

		// Atualiza o comando
		await this.database.updateCustomCommand(group.id, command);

		// Limpa cache de comandos
		this.database.clearCache(`commands:${group.id}`);
		await bot.eventHandler.commandHandler.loadCustomCommandsForGroup(group.id);

		return new ReturnMessage({
			chatId: group.id,
			content: `🕰️ Horários para o comando _${commandName}_:
* 🟢 *Habilitado*: ${startTime} às ${endTime}
* 🔴 *Desabilitado*: ${endTime} às ${startTime}`
		});
	}

	/**
	 * Define dias permitidos para um comando personalizado
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async setCmdAllowedDays(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length === 0) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					"Por favor, forneça o nome do comando e, opcionalmente, os dias permitidos. Exemplo: !g-cmd-setDias comando seg ter qua"
			});
		}

		// Obtém o nome do comando
		const commandName = args[0];

		// Obtém os dias
		const days = args.slice(1).map((day) => day.toLowerCase());

		// Valida os dias (deve ser seg, ter, qua, qui, sex, sab, dom)
		const validDays = [
			"dom",
			"seg",
			"ter",
			"qua",
			"qui",
			"sex",
			"sab",
			"domingo",
			"segunda",
			"terca",
			"quarta",
			"quinta",
			"sexta",
			"sabado"
		];

		const invalidDays = days.filter((day) => !validDays.includes(day));
		if (invalidDays.length > 0 && days.length > 0) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Dias inválidos: ${invalidDays.join(", ")}. Use abreviações de três letras (seg, ter, qua, qui, sex, sab, dom).`
			});
		}

		// Busca o comando personalizado
		const commands = await this.database.getCustomCommands(group.id);
		const command = commands.find((cmd) => cmd.startsWith === commandName && !cmd.deleted);

		if (!command) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Comando personalizado '${commandName}' não encontrado.${this.help.naoEncontrado}`
			});
		}

		// Inicializa ou atualiza a propriedade allowedTimes
		if (!command.allowedTimes) {
			command.allowedTimes = {};
		}

		// Se não forneceu dias, remove a restrição
		if (days.length === 0) {
			if (command.allowedTimes) {
				delete command.allowedTimes.daysOfWeek;

				// Se não houver mais restrições, remove a propriedade inteira
				if (!command.allowedTimes.start || !command.allowedTimes.end) {
					delete command.allowedTimes;
				}
			}

			// Atualiza o comando
			await this.database.updateCustomCommand(group.id, command);

			// Limpa cache de comandos
			this.database.clearCache(`commands:${group.id}`);
			await bot.eventHandler.commandHandler.loadCustomCommandsForGroup(group.id);

			return new ReturnMessage({
				chatId: group.id,
				content: `Restrição de dias removida para o comando '${commandName}'.`
			});
		}

		// Atualiza os dias permitidos
		command.allowedTimes.daysOfWeek = days;

		// Atualiza o comando
		await this.database.updateCustomCommand(group.id, command);

		// Limpa cache de comandos
		this.database.clearCache(`commands:${group.id}`);
		await bot.eventHandler.commandHandler.loadCustomCommandsForGroup(group.id);

		return new ReturnMessage({
			chatId: group.id,
			content: `Dias permitidos para o comando '${commandName}' definidos: ${days.join(", ")}.`
		});
	}

	/**
	 * Abre ou fecha o grupo para que apenas admins possam enviar mensagens
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @param {boolean} setAdminsOnly - Se true, apenas admins podem enviar mensagens
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async toggleGroupMessagesAdminsOnly(bot, message, args, group, setAdminsOnly) {
		try {
			if (!group) {
				return new ReturnMessage({
					chatId: message.author,
					content: "Este comando só pode ser usado em grupos."
				});
			}

			// Verifica se o bot é administrador do grupo (necessário para esta operação)
			const isAdmin = await this.isBotAdmin(bot, group);

			if (!isAdmin) {
				return new ReturnMessage({
					chatId: group.id,
					content:
						"⚠️ O bot precisa ser administrador do grupo para poder alterar as configurações do grupo."
				});
			}

			// Obtém o chat do grupo
			try {
				const chat = await bot.client.getChatById(group.id);

				// Define configuração de apenas admins para mensagens
				await chat.setMessagesAdminsOnly(setAdminsOnly);

				const statusMsg = setAdminsOnly
					? "🔒 Grupo fechado. Apenas administradores podem enviar mensagens agora."
					: "🔓 Grupo aberto. Todos os participantes podem enviar mensagens agora.";

				return new ReturnMessage({
					chatId: group.id,
					content: statusMsg
				});
			} catch (error) {
				this.logger.error(`Erro ao ${setAdminsOnly ? "fechar" : "abrir"} grupo:`, error);

				return new ReturnMessage({
					chatId: group.id,
					content: `❌ Erro ao ${setAdminsOnly ? "fechar" : "abrir"} grupo: ${error.message}`
				});
			}
		} catch (error) {
			this.logger.error(
				`Erro ao executar comando de ${setAdminsOnly ? "fechar" : "abrir"} grupo:`,
				error
			);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: `❌ Erro ao executar o comando. Por favor, tente novamente.`
			});
		}
	}

	/**
	 * Fecha o grupo para que apenas admins possam enviar mensagens
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async closeGroup(bot, message, args, group) {
		return this.toggleGroupMessagesAdminsOnly(bot, message, args, group, true);
	}

	/**
	 * Abre o grupo para que todos possam enviar mensagens
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async openGroup(bot, message, args, group) {
		return this.toggleGroupMessagesAdminsOnly(bot, message, args, group, false);
	}

	/**
	 * Define um apelido para um usuário específico (para admins)
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async setUserNicknameAdmin(bot, message, args, group) {
		try {
			if (!group) {
				return new ReturnMessage({
					chatId: message.author,
					content: "Este comando só pode ser usado em grupos."
				});
			}

			// 1. A mensagem deve possuir mentions.length === 1
			if (!message.mentions || message.mentions.length !== 1) {
				return new ReturnMessage({
					chatId: group.id,
					content: "⚠️ Você precisa mencionar exatamente uma pessoa para definir o apelido."
				});
			}

			const mentionJid = message.mentions[0];
			const mentionUserPart = mentionJid.split("@")[0];

			// Resolve phone number from LID if possible
			let pnUserPart = mentionUserPart;
			if (bot.getPnFromLid) {
				const resolvedPn = bot.getPnFromLid(mentionUserPart, message.origin?.groupData);
				if (resolvedPn) {
					pnUserPart = resolvedPn.split("@")[0];
				}
			}

			// 2. Parse na string para remover o mention da mensagem e pegar a string de texto restante
			let nickname = args.join(" ");
			nickname = nickname.replace("@" + mentionUserPart, "");
			if (pnUserPart !== mentionUserPart) {
				nickname = nickname.replace("@" + pnUserPart, "");
			}
			nickname = nickname.trim();

			if (!nickname) {
				return new ReturnMessage({
					chatId: group.id,
					content:
						"⚠️ Por favor, forneça o apelido para a pessoa mencionada. Exemplo:\n!g-setApelido Apelido @pessoa\nou\n!g-setApelido @pessoa Apelido"
				});
			}

			// Limita o apelido a 20 caracteres
			const trimmedNickname = nickname.length > 20 ? nickname.substring(0, 20) : nickname;

			// A chave numero em group.nicks é o número de telefone (sem JID)
			const userNumber = pnUserPart;

			// Inicializa o array de apelidos se não existir
			if (!group.nicks) {
				group.nicks = [];
			}

			// Verifica se o usuário já tem um apelido
			const existingIndex = group.nicks.findIndex((nick) => nick.numero === userNumber);

			if (existingIndex !== -1) {
				// Atualiza o apelido existente
				group.nicks[existingIndex].apelido = trimmedNickname;
			} else {
				// Adiciona novo apelido
				group.nicks.push({
					numero: userNumber,
					apelido: trimmedNickname
				});
			}

			// Salva o grupo atualizado
			await this.database.saveGroup(group);

			// Tenta obter o nome do contato do target
			let contactName = "usuário";
			try {
				const contact = await bot.client.getContactById(mentionJid);
				this.logger.debug(`[setNickAdmin] `, { contact });
				contactName = contact.name?.pushName ?? contact.pushname ?? contact.name ?? userNumber;
			} catch (contactError) {
				this.logger.debug(
					`Não foi possível obter informações do contato ${userNumber}:`,
					contactError
				);
			}

			return new ReturnMessage({
				chatId: group.id,
				content: `✅ Apelido definido para ${contactName} (${userNumber}): "${trimmedNickname}"`
			});
		} catch (error) {
			this.logger.error("Erro ao definir apelido para usuário:", error);

			return new ReturnMessage({
				chatId: message.group ?? message.author,
				content: "Erro ao definir apelido. Por favor, tente novamente."
			});
		}
	}

	/**
	 * Alterna a funcionalidade de mencionar todos os membros nas notificações de stream
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @param {string} platform - Plataforma (twitch, kick, youtube)
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async toggleStreamMentions(bot, message, args, group, platform) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		// Valida e obtém o nome do canal
		const channelName = await this.validateChannelName(bot, message, args, group, platform);

		// Se validateChannelName retornou um ReturnMessage, retorna-o
		if (channelName instanceof ReturnMessage) {
			return channelName;
		}

		// Encontra a configuração do canal
		const channelConfig = this.findChannelConfig(group, platform, channelName);

		if (!channelConfig) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Canal do ${platform} não configurado: ${channelName}. Use !g-${platform}-canal ${channelName} para configurar.`
			});
		}

		// Inicializa a propriedade mentionAllMembers se não existir
		if (channelConfig.mentionAllMembers === undefined) {
			channelConfig.mentionAllMembers = true;
		}

		// Alterna o valor
		channelConfig.mentionAllMembers = !channelConfig.mentionAllMembers;

		// Salva a configuração atualizada
		await this.database.saveGroup(group);

		// Retorna uma mensagem informando o novo estado
		const novoEstado = channelConfig.mentionAllMembers ? "ativada" : "desativada";

		return new ReturnMessage({
			chatId: group.id,
			content: `✅ Função de mencionar todos os membros ${novoEstado} para notificações do canal ${channelName} da ${platform}.`
		});
	}

	// Métodos para cada plataforma
	async toggleTwitchMentions(bot, message, args, group) {
		return this.toggleStreamMentions(bot, message, args, group, "twitch");
	}

	async toggleKickMentions(bot, message, args, group) {
		return this.toggleStreamMentions(bot, message, args, group, "kick");
	}

	async toggleYoutubeMentions(bot, message, args, group) {
		return this.toggleStreamMentions(bot, message, args, group, "youtube");
	}

	async generatePainelCommand(bot, message, args, group, privateManagement) {
		let targetGroup = group;

		// Se veio no PV, não há grupo ativo ou o usuário quer acessar outro grupo diretamente por g-painel nomegrupo
		if (!message.group && args.length > 0) {
			const groupName = args[0].trim().toLowerCase();
			const groups = await this.database.getGroups();
			targetGroup = groups.find((g) => g.name.trim().toLowerCase() === groupName);

			if (targetGroup) {
				const isUserAdminInTarget = await this.adminUtils.isAdmin(
					message.author,
					targetGroup,
					false,
					bot
				);
				if (isUserAdminInTarget) {
					if (privateManagement) {
						privateManagement[message.author] = targetGroup.id;
					}
				} else {
					return new ReturnMessage({
						chatId: message.author,
						content: `Você *NÃO É* administrador do grupo '${targetGroup.name}'.`,
						reaction: "🙅‍♂️"
					});
				}
			} else {
				return new ReturnMessage({
					chatId: message.author,
					content: `Grupo não encontrado: ${groupName}`,
					reaction: "🙅‍♂️"
				});
			}
		}

		if (!targetGroup) {
			return new ReturnMessage({
				chatId: message.author,
				content:
					"Você precisa especificar um grupo ou estar em um grupo gerenciado. Exemplo: !g-painel [nomeDoGrupo]"
			});
		}

		// Generate token
		const token = this.generateRandomToken(32);
		const now = new Date();
		const expirationMinutes = parseInt(process.env.MANAGEMENT_TOKEN_DURATION ?? "30");
		const expiration = new Date(now.getTime() + expirationMinutes * 60000);

		// Format for display
		const formattedExpiration = expiration.toLocaleDateString("pt-BR", {
			day: "2-digit",
			month: "2-digit",
			year: "numeric",
			hour: "2-digit",
			minute: "2-digit"
		});

		// Save token data
		const webManagementData = {
			token,
			requestNumber: message.author,
			authorName: message.authorName ?? "Unknown",
			groupName: targetGroup.name,
			groupId: targetGroup.id,
			botId: bot.id,
			createdAt: now.toISOString(),
			expiresAt: expiration.toISOString()
		};

		await this.saveWebManagementToken(webManagementData);
		const managementLink = `${process.env.BOT_DOMAIN}/manage/${token}`;

		return new ReturnMessage({
			chatId: message.author,
			content: `Link para gerenciamento do grupo criado com sucesso!\n\nAcesse: ${managementLink}\n\nEste link é válido até ${formattedExpiration}.`
		});
	}

	generateRandomToken(length) {
		const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
		let result = "";
		for (let i = 0; i < length; i++) {
			result += characters.charAt(Math.floor(Math.random() * characters.length));
		}
		return result;
	}

	async saveWebManagementToken(tokenData) {
		try {
			await WebManagement.getInstance().saveToken(tokenData);
		} catch (error) {
			this.logger.error("Error saving web management token:", error);
		}
	}
	async delWebhook(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length === 0) {
			return new ReturnMessage({
				chatId: group.id,
				content: "Por favor, forneça o nome do webhook para remover. Ex: !g-delWebhook meuhook"
			});
		}

		const name = args[0].trim();

		if (!group.webhooks) group.webhooks = [];

		const index = group.webhooks.findIndex((w) => w.name === name);

		if (index === -1) {
			return new ReturnMessage({
				chatId: group.id,
				content: `Webhook '${name}' não encontrado.`
			});
		}

		const removed = group.webhooks.splice(index, 1)[0];
		await this.database.saveGroup(group);

		// Reload webhooks in API memory
		if (bot.botApi) {
			bot.botApi.reloadWebhooks();
		}

		return new ReturnMessage({
			chatId: group.id,
			content: `Webhook '${name}' removido.\n\nBackup da configuração:\n\`\`\`${JSON.stringify(removed, null, 2)}\`\`\``
		});
	}

	async setWebhook(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		const usage =
			"Você pode configurar até *10* webhooks no grupo.\n" +
			"Seu webhook deve apontar para:\n" +
			`> ${process.env.GROUP_WEBHOOKS_DOMAIN || "https://webhooks.example.com"}/${bot.id}/${group.id.split("@")[0]}\n\n` +
			"Você deve enviar uma mensagem com o JSON de configuração a seguir e responder/marcar a mesma com este comando.\n\n" +
			"```{\n" +
			'  "name": "seuWebhook1",\n' +
			'  "header": {"name": "x-token-secreto", "value": "abc123!@#"},\n' +
			'  "headerValue": "match|include",\n' +
			'  "template": "Recebi um webhook, de {{cliente.nome}} com o valor de R${{valor}}",\n' +
			'  "bot": "' +
			bot.id +
			'"\n' +
			"}\n\n" +
			"- name: Usado pra identificar o webhook (caso queira editar, envie com o mesmo nome)\n" +
			"- header: Informe o nome e o valor do header secreto que seu webhook terá. Ambos precisam estar definidos.\n" +
			"- headerValue: pode ser 'match' ou 'include'. match aceita apenas valores identicos e include apenas verifica se o valor está contido dentro do valor.\n" +
			"- template: Uma string que representará a mensagem que o bot vai enviar no grupo quando receber o webhook.\n\n" +
			"O bot envia no máximo 1 mensagem a cada 120 segundos, se ele receber mais de um webhook durante o período de 'cooldown', elas serão concatenadas.\n" +
			"```";

		const quotedMsg = await message.origin.getQuotedMessage().catch(() => null);
		let jsonContent = "";

		if (quotedMsg) {
			jsonContent = quotedMsg.body ?? quotedMsg.content ?? "";
		} else {
			// Try to find JSON in args if user pasted it directly (less reliable due to formatting)
			// Better to just show usage if no quoted message
			return new ReturnMessage({
				chatId: group.id,
				content: usage
			});
		}

		// Try to parse JSON
		// Clean up potential markdown code blocks
		jsonContent = jsonContent
			.replace(/```json/g, "")
			.replace(/```/g, "")
			.trim();

		let webhookConfig;
		try {
			webhookConfig = JSON.parse(jsonContent);
		} catch (e) {
			return new ReturnMessage({
				chatId: group.id,
				content: "Erro ao ler JSON. Verifique a formatação.\n" + e.message
			});
		}

		// Validation
		if (!webhookConfig.name || typeof webhookConfig.name !== "string") {
			return new ReturnMessage({
				chatId: group.id,
				content: "Erro: 'name' é obrigatório e deve ser texto."
			});
		}
		if (!webhookConfig.header || !webhookConfig.header.name || !webhookConfig.header.value) {
			return new ReturnMessage({
				chatId: group.id,
				content: "Erro: 'header' deve conter 'name' e 'value'."
			});
		}
		if (!webhookConfig.template || typeof webhookConfig.template !== "string") {
			return new ReturnMessage({
				chatId: group.id,
				content: "Erro: 'template' é obrigatório e deve ser texto."
			});
		}

		if (!group.webhooks) group.webhooks = [];

		// Check limit (unless updating existing)
		const existingIndex = group.webhooks.findIndex((w) => w.name === webhookConfig.name);
		if (existingIndex === -1 && group.webhooks.length >= 10) {
			return new ReturnMessage({
				chatId: group.id,
				content: "Limite de 10 webhooks por grupo atingido."
			});
		}

		// Save
		const newWebhook = {
			name: webhookConfig.name,
			header: webhookConfig.header,
			headerValue: webhookConfig.headerValue === "include" ? "include" : "match",
			template: webhookConfig.template,
			botId: webhookConfig.bot || bot.id, // Optional validation against current bot?
			createdAt: Date.now()
		};

		if (existingIndex !== -1) {
			group.webhooks[existingIndex] = newWebhook;
		} else {
			group.webhooks.push(newWebhook);
		}

		await this.database.saveGroup(group);

		// Reload webhooks in API memory
		if (bot.botApi) {
			bot.botApi.reloadWebhooks();
		}

		return new ReturnMessage({
			chatId: group.id,
			content: `Webhook '${newWebhook.name}' configurado com sucesso!`
		});
	}

	/**
	 * Adiciona advertência aos membros mencionados
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	/**
	 * Gera os emojis de advertência baseados na contagem
	 * @param {number} count - Número de advertências
	 * @returns {string} - String formatada com emojis, ex: [🟢🟢🟢]
	 */
	getWarningEmojis(count) {
		const colors = ["🟢", "🟡", "🟠", "🔴", "⚫️"];

		if (count >= 12) return "[⚫️⚫️⚫️]";

		const level = Math.floor((count - 1) / 3);
		const higherCount = ((count - 1) % 3) + 1;
		const higherColor = colors[level + 1] || "⚫️";
		const lowerColor = colors[level] || "🟢";

		let emojis = "";
		for (let i = 0; i < higherCount; i++) emojis += higherColor;
		for (let i = 0; i < 3 - higherCount; i++) emojis += lowerColor;

		return `[${emojis}]`;
	}

	/**
	 * Adiciona advertência aos membros mencionados
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async advertirUser(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		const mentions = message.mentions ?? [];

		if (mentions.length === 0) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					"Para advertir um membro, marque o mesmo com @. Para ver as advertencias do grupo, envie !g-advertencias"
			});
		}

		if (!group.warnings) {
			group.warnings = [];
		}

		let response = "🚨 *Advertência*\n";

		for (const jid of mentions) {
			const number = jid.split("@")[0];
			const existingIndex = group.warnings.findIndex((w) => w.jid === jid || w.numero === number);

			let currentCount = 1;
			if (existingIndex !== -1) {
				group.warnings[existingIndex].count += 1;
				currentCount = group.warnings[existingIndex].count;
				// Atualiza para o JID completo caso estivesse apenas o número
				group.warnings[existingIndex].jid = jid;
			} else {
				group.warnings.push({ jid, numero: number, count: 1 });
			}

			const emojis = this.getWarningEmojis(currentCount);
			response += `- ${emojis} @${number} (${currentCount}) ❗️\n`;
		}

		response += "\n⚠️ _Respeitem as regras do grupo!_ 🚔";

		//this.logger.debug(`[advertencias] `, { response, mentions });

		await this.database.saveGroup(group);

		return new ReturnMessage({
			chatId: group.id,
			content: response,
			options: {
				mentions
			}
		});
	}

	/**
	 * Lista as advertências atuais do grupo
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async listWarnings(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (!group.warnings || group.warnings.length === 0) {
			return new ReturnMessage({
				chatId: group.id,
				content: "Não há advertências registradas neste grupo. 😇"
			});
		}

		// Ordena por maior número de advertências
		const sortedWarnings = [...group.warnings].sort((a, b) => b.count - a.count);

		let response = "🚓 *Advertências Atuais* 🚨\n";
		const mentions = [];

		for (const warn of sortedWarnings) {
			const emojis = this.getWarningEmojis(warn.count);
			const jid = warn.jid || `${warn.numero}@lid`;
			const number = jid.split("@")[0];

			response += `- ${emojis} @${number} (${warn.count})\n`;
			mentions.push(jid);
		}

		response += "\n_Respeitem sempre as regras do grupo!_ ⚠️";

		//this.logger.debug(`[advertencias] `, { response, mentions });
		return new ReturnMessage({
			chatId: group.id,
			content: response,
			options: {
				mentions
			}
		});
	}
	/**
	 * Remove as advertências das pessoas mencionadas
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async clearWarnings(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		const mentions = message.mentions ?? [];

		if (mentions.length === 0) {
			return new ReturnMessage({
				chatId: group.id,
				content: "Para limpar advertências, marque os membros com @."
			});
		}

		if (!group.warnings) {
			group.warnings = [];
		}

		let response = "✅ *Advertências Removidas*\n";
		const removedMentions = [];

		for (const jid of mentions) {
			const number = jid.split("@")[0];
			const existingIndex = group.warnings.findIndex((w) => w.jid === jid || w.numero === number);

			if (existingIndex !== -1) {
				const count = group.warnings[existingIndex].count;
				group.warnings.splice(existingIndex, 1);
				response += `- @${number} (${count}) 🍀\n`;
				removedMentions.push(jid);
			}
		}

		if (removedMentions.length === 0) {
			return new ReturnMessage({
				chatId: group.id,
				content: "Nenhum dos membros mencionados possui advertências."
			});
		}

		response += "\n_Da próxima vez, respeite as regras do grupo!_ 🚔";

		await this.database.saveGroup(group);

		return new ReturnMessage({
			chatId: group.id,
			content: response,
			options: {
				mentions: removedMentions
			}
		});
	}
	/**
	 * Remove o ID do grupo de todos os bots ignorados e limpa blacklist local
	 * @param {Object} group - Dados do grupo
	 */
	async _refreshStreamBots(group) {
		await StreamSystem.getInstance().refreshGroup(group);
	}

	async streamRefresh(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		await this._refreshStreamBots(group);

		return new ReturnMessage({
			chatId: group.id,
			content: "✅ Lista de bots ativos e ignorados para este grupo foi resetada com sucesso."
		});
	}

	/**
	 * Exibe o histórico de dossiês do grupo
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async runDossieAnalysis(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		try {
			const dossiers = await this.database.dbAll(
				"summaries",
				"SELECT dossier_json, created_at FROM group_dossiers WHERE group_id = ? ORDER BY created_at DESC LIMIT 15",
				[group.id]
			);

			if (!dossiers || dossiers.length === 0) {
				return new ReturnMessage({
					chatId: group.id,
					content: "Nenhum dossiê encontrado para este grupo."
				});
			}

			let response = `*📋 Histórico de Dossiês - ${group.name}*\n> Histórico de análises automáticas realizadas pela IA sobre o comportamento do grupo - quanto maior a nota, mais preocupado é o conteúdo e maior a possibilidade da ravena ser removida em caso de conteúdo problemático/denúncias por membros. As análises são realizadas de forma automática, de tempos em tempos.\n\n`;

			dossiers.forEach((d, i) => {
				try {
					const p = JSON.parse(d.dossier_json);
					const date = new Date(d.created_at).toLocaleString("pt-BR");
					response += `*${i + 1}. [${date}]* (Nota: ${p.problematic_score}/10)\n`;
					response += `> *Tipo:* ${p.type}\n`;
					response += `> *Resumo:* ${p.summary}\n\n`;
				} catch (e) {
					// Ignora
				}
			});

			return new ReturnMessage({
				chatId: group.id,
				content: response
			});
		} catch (error) {
			this.logger.error("Erro ao listar dossiês:", error);
			return new ReturnMessage({
				chatId: group.id,
				content: "❌ Erro ao buscar histórico de dossiês."
			});
		}
	}

	/**
	 * Copia comandos personalizados de um grupo para outro
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async copyCommands(bot, message, args, group) {
		if (!group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só pode ser usado em grupos."
			});
		}

		if (args.length < 2) {
			return new ReturnMessage({
				chatId: group.id,
				content:
					"⚠️ *Uso incorreto.* Como usar:\n\n*!g-copiarCmds <grupoOrigem> <grupoDestino>*\n\nExemplo: !g-copiarCmds grupoA grupoB"
			});
		}

		const fromGroupName = args[0].trim();
		const toGroupName = args[1].trim();

		try {
			// Busca os grupos
			const groups = await this.database.getGroups();
			const fromGroup = groups.find(
				(g) => g.name.trim().toLowerCase() === fromGroupName.toLowerCase() || g.id === fromGroupName
			);
			const toGroup = groups.find(
				(g) => g.name.trim().toLowerCase() === toGroupName.toLowerCase() || g.id === toGroupName
			);

			if (!fromGroup) {
				return new ReturnMessage({
					chatId: group.id,
					content: `❌ Grupo de origem '${fromGroupName}' não foi encontrado.`
				});
			}

			if (!toGroup) {
				return new ReturnMessage({
					chatId: group.id,
					content: `❌ Grupo de destino '${toGroupName}' não foi encontrado.`
				});
			}

			if (fromGroup.id === toGroup.id) {
				return new ReturnMessage({
					chatId: group.id,
					content: `⚠️ O grupo de origem e o de destino são o mesmo grupo (${fromGroup.name}).`
				});
			}

			// Verifica se o remetente é administrador nos 2 grupos
			const isAdminInFrom = await this.adminUtils.isAdmin(message.author, fromGroup, null, bot);
			if (!isAdminInFrom) {
				return new ReturnMessage({
					chatId: group.id,
					content: `❌ Você não é administrador no grupo de origem '${fromGroup.name}'.`
				});
			}

			const isAdminInTo = await this.adminUtils.isAdmin(message.author, toGroup, null, bot);
			if (!isAdminInTo) {
				return new ReturnMessage({
					chatId: group.id,
					content: `❌ Você não é administrador no grupo de destino '${toGroup.name}'.`
				});
			}

			// Carrega os comandos de ambos os grupos
			const fromCmds = await this.database.getCustomCommands(fromGroup.id);
			const toCmds = await this.database.getCustomCommands(toGroup.id);

			const originActiveCmds = fromCmds.filter((cmd) => !cmd.deleted);
			const destMap = new Map(toCmds.map((cmd) => [cmd.startsWith.toLowerCase(), cmd]));

			const newCmdsList = [];
			const updatedCmdsList = [];
			let copiedCount = 0;
			let overwrittenCount = 0;

			const isDifferent = (cmdA, cmdB) => {
				if (cmdA.active !== cmdB.active) return true;
				if (cmdA.adminOnly !== cmdB.adminOnly) return true;
				if (cmdA.cooldown !== cmdB.cooldown) return true;
				if (cmdA.react !== cmdB.react) return true;
				if (cmdA.reply !== cmdB.reply) return true;
				if (cmdA.sendAllResponses !== cmdB.sendAllResponses) return true;
				if (cmdA.ignoreInteract !== cmdB.ignoreInteract) return true;

				// Compara respostas
				const respA = cmdA.responses || [];
				const respB = cmdB.responses || [];
				if (respA.length !== respB.length) return true;
				for (let i = 0; i < respA.length; i++) {
					if (respA[i] !== respB[i]) return true;
				}

				// Compara menções
				const mentA = cmdA.mentions || [];
				const mentB = cmdB.mentions || [];
				if (mentA.length !== mentB.length) return true;
				for (let i = 0; i < mentA.length; i++) {
					if (mentA[i] !== mentB[i]) return true;
				}

				return false;
			};

			for (const origCmd of originActiveCmds) {
				const trigger = origCmd.startsWith.toLowerCase();
				const destCmd = destMap.get(trigger);

				if (!destCmd || destCmd.deleted) {
					// Não existe no destino, ou existia e foi deletado
					const newCmd = {
						...origCmd,
						groupId: toGroup.id,
						metadata: {
							createdBy: message.author,
							createdAt: Date.now()
						}
					};
					await this.database.saveCustomCommand(toGroup.id, newCmd);
					newCmdsList.push(origCmd.startsWith);
					copiedCount++;
				} else if (isDifferent(origCmd, destCmd)) {
					// Existe mas é diferente
					const updatedCmd = {
						...origCmd,
						groupId: toGroup.id,
						metadata: {
							createdBy:
								destCmd.metadata?.createdBy || origCmd.metadata?.createdBy || message.author,
							createdAt: destCmd.metadata?.createdAt || origCmd.metadata?.createdAt || Date.now(),
							updatedBy: message.author,
							updatedAt: Date.now()
						}
					};
					await this.database.saveCustomCommand(toGroup.id, updatedCmd);
					updatedCmdsList.push(origCmd.startsWith);
					overwrittenCount++;
				}
			}

			if (copiedCount > 0 || overwrittenCount > 0) {
				this.database.clearCache(`commands:${toGroup.id}`);
				await bot.eventHandler.commandHandler.loadCustomCommandsForGroup(toGroup.id);
			}

			const prefix = toGroup.prefix ?? "!";
			let responseContent = `*Sincronização de comandos concluída com sucesso! (Estilo rsync)*\n\n`;
			responseContent += `• Origem: *${fromGroup.name}*\n`;
			responseContent += `• Destino: *${toGroup.name}*\n\n`;

			if (copiedCount > 0) {
				responseContent += `*Novos comandos copiados (${copiedCount}):*\n`;
				responseContent += newCmdsList.map((cmd) => `  - ${prefix}${cmd}`).join("\n") + `\n\n`;
			}

			if (overwrittenCount > 0) {
				responseContent += `*Comandos atualizados (${overwrittenCount}):*\n`;
				responseContent += updatedCmdsList.map((cmd) => `  - ${prefix}${cmd}`).join("\n") + `\n\n`;
			}

			if (copiedCount === 0 && overwrittenCount === 0) {
				responseContent += `✅ Todos os comandos do grupo destino já estão idênticos aos do grupo de origem (nada a fazer).`;
			} else {
				responseContent += `✨ Total analisado: ${originActiveCmds.length} comandos.`;
			}

			return new ReturnMessage({
				chatId: group.id,
				content: responseContent
			});
		} catch (error) {
			this.logger.error("Erro ao copiar comandos entre grupos:", error);
			return new ReturnMessage({
				chatId: group.id,
				content: "❌ Erro inesperado ao sincronizar os comandos."
			});
		}
	}

	/**
	 * Remove membros mencionados do grupo
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async banUser(bot, message, args, group) {
		if (!group || !bot.privado) return null;

		const isAdmin = await this.isBotAdmin(bot, group);
		if (!isAdmin) {
			return new ReturnMessage({
				chatId: group.id,
				content: "⚠️ O bot precisa ser administrador do grupo para remover membros."
			});
		}

		const mentions = message.mentions ?? [];
		if (mentions.length === 0) {
			return new ReturnMessage({
				chatId: group.id,
				content: "⚠️ Por favor, mencione pelo menos uma pessoa para remover."
			});
		}

		// Remove cada pessoa mencionada
		const removed = [];
		const failed = [];
		for (const target of mentions) {
			try {
				await bot.removeFromGroup(group.id, [target]);
				removed.push(target.split("@")[0]);
			} catch (err) {
				this.logger.error(`Erro ao banir usuário ${target} do grupo ${group.id}:`, err);
				failed.push(target.split("@")[0]);
			}
		}

		let response = "";
		if (removed.length > 0) {
			response += `✅ Removido(s) do grupo: @${removed.join(", @")}\n`;
		}
		if (failed.length > 0) {
			response += `❌ Falha ao remover: @${failed.join(", @")}\n`;
		}

		return new ReturnMessage({
			chatId: group.id,
			content: response.trim(),
			options: {
				mentions
			}
		});
	}

	/**
	 * Remove membros mencionados do grupo e os bloqueia no banco de dados
	 * @param {WhatsAppBot} bot - Instância do bot
	 * @param {Object} message - Dados da mensagem
	 * @param {Array} args - Argumentos do comando
	 * @param {Object} group - Dados do grupo
	 * @returns {Promise<ReturnMessage>} Mensagem de retorno
	 */
	async blockGroupUser(bot, message, args, group) {
		if (!group || !bot.privado) return null;

		const isAdmin = await this.isBotAdmin(bot, group);
		if (!isAdmin) {
			return new ReturnMessage({
				chatId: group.id,
				content: "⚠️ O bot precisa ser administrador do grupo para remover e bloquear membros."
			});
		}

		const mentions = message.mentions ?? [];
		if (mentions.length === 0) {
			return new ReturnMessage({
				chatId: group.id,
				content: "⚠️ Por favor, mencione pelo menos uma pessoa para bloquear."
			});
		}

		// Garante que o array filters.people está inicializado
		if (!group.filters) {
			group.filters = {};
		}
		if (!group.filters.people || !Array.isArray(group.filters.people)) {
			group.filters.people = [];
		}

		const removed = [];
		const failed = [];

		for (const target of mentions) {
			try {
				// Resolve o contato para obter o número e o LID correto
				let pn = target.split("@")[0];
				let lid = null;
				try {
					const contact = await bot.client.getContactById(target);
					if (contact) {
						pn = contact.id._serialized.split("@")[0];
						if (contact.lid) {
							lid = contact.lid.split("@")[0];
						}
					}
				} catch (e) {
					this.logger.error(`Erro ao obter contato para obter LID de ${target}:`, e.message);
				}

				// Adiciona ao banco de dados (group.filters.people)
				if (!group.filters.people.includes(pn)) {
					group.filters.people.push(pn);
				}
				if (lid && !group.filters.people.includes(lid) && lid !== pn) {
					group.filters.people.push(lid);
				}

				// Remove a pessoa do grupo
				await bot.removeFromGroup(group.id, [target]);
				removed.push(pn);
			} catch (err) {
				this.logger.error(`Erro ao bloquear/remover usuário ${target} do grupo ${group.id}:`, err);
				failed.push(target.split("@")[0]);
			}
		}

		// Salva o grupo atualizado
		await this.database.saveGroup(group);

		let response = "";
		if (removed.length > 0) {
			response += `🔒 Removido(s) e bloqueado(s) do grupo: @${removed.join(", @")}\n`;
		}
		if (failed.length > 0) {
			response += `❌ Falha ao remover/bloquear: @${failed.join(", @")}\n`;
		}

		return new ReturnMessage({
			chatId: group.id,
			content: response.trim(),
			options: {
				mentions
			}
		});
	}
}

module.exports = Management;
