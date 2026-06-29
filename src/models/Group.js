/**
 * Modelo Group representando um grupo do WhatsApp com propriedades e configurações
 */
class Group {
	/**
	 * Cria uma nova instância de Group
	 * @param {Object} data - Dados do grupo
	 */
	constructor(data = {}) {
		this.id = data.id ?? null;
		this.addedBy = data.addedBy ?? null;
		this.removedBy = data.removedBy ?? false;
		this.name =
			data.name ??
			(this.id ? this.id.split("@")[0].toLowerCase().replace(/\s+/g, "").substring(0, 16) : null);
		this.titulo = data.titulo ?? null;
		this.descricao = data.descricao ?? null;
		this.prefix = data.prefix ?? "!";
		this.customIgnoresPrefix = data.customIgnoresPrefix ?? false;
		this.inviteCode = data.inviteCode ?? null;
		this.paused = data.paused ?? false;
		this.additionalAdmins = data.additionalAdmins ?? [];

		// Filtros
		this.filters = data.filters ?? {
			nsfw: false,
			links: false,
			words: [],
			people: []
		};

		// Monitoramento de plataformas
		this.twitch = data.twitch ?? [];
		this.kick = data.kick ?? [];
		this.youtube = data.youtube ?? [];
		this.botNotInGroup = data.botNotInGroup ?? [];
		this.webhooks = data.webhooks ?? [];

		// Mensagens de boas-vindas e despedida
		this.greetings = data.greetings ?? {};
		this.farewells = data.farewells ?? {};

		// Interacoes Auto
		this.interact = data.interact ?? {
			enabled: true,
			useCmds: true,
			lastInteraction: 0,
			cooldown: 30,
			chance: 100,
			proporcao: 50
		};
		if (this.interact.proporcao === undefined) {
			this.interact.proporcao = 50;
		}

		// Auto translate todas returnMessage
		this.autoTranslateTo = data.autoTranslateTo ?? false;

		// Outras config
		this.autoStt = data.autoStt ?? false;
		this.ignoredNumbers = data.ignoredNumbers ?? [];
		this.ignoredUsers = data.ignoredUsers ?? [];
		this.mutedCommands = data.mutedCommands ?? [];
		this.mutedCategories = data.mutedCategories ?? [];
		this.nicks = data.nicks ?? [];
		this.warnings = data.warnings ?? [];
		this.customAIPrompt = data.customAIPrompt ?? [];
		this.notificaGrupoFechado = data.notificaGrupoFechado ?? false;
		this.notificaGrupoAberto = data.notificaGrupoAberto ?? false;

		// Metadados
		this.createdAt = data.createdAt ?? Date.now();
		this.updatedAt = Date.now();
	}

	/**
	 * Converte instância de Group para objeto simples para serialização
	 * @returns {Object} - Representação em objeto simples
	 */
	toJSON() {
		return {
			id: this.id,
			addedBy: this.addedBy,
			removedBy: this.removedBy,
			name: this.name,
			titulo: this.titulo,
			descricao: this.descricao,
			prefix: this.prefix,
			customIgnoresPrefix: this.customIgnoresPrefix,
			inviteCode: this.inviteCode,
			paused: this.paused,
			additionalAdmins: this.additionalAdmins,
			filters: this.filters,
			twitch: this.twitch,
			kick: this.kick,
			youtube: this.youtube,
			botNotInGroup: this.botNotInGroup,
			webhooks: this.webhooks,
			greetings: this.greetings,
			farewells: this.farewells,
			interact: this.interact,
			autoTranslateTo: this.autoTranslateTo,
			autoStt: this.autoStt,
			ignoredNumbers: this.ignoredNumbers,
			ignoredUsers: this.ignoredUsers,
			mutedCommands: this.mutedCommands,
			// FIX: Adicionado mutedCategories que estava faltando
			mutedCategories: this.mutedCategories,
			nicks: this.nicks,
			warnings: this.warnings,
			customAIPrompt: this.customAIPrompt,
			notificaGrupoFechado: this.notificaGrupoFechado,
			notificaGrupoAberto: this.notificaGrupoAberto,
			createdAt: this.createdAt,
			updatedAt: this.updatedAt
		};
	}

	/**
	 * Cria uma instância de Group a partir de um objeto simples
	 * @param {Object} data - Dados do grupo
	 * @returns {Group} - Nova instância de Group
	 */
	static fromJSON(data) {
		return new Group(data);
	}

	/**
	 * Atualiza propriedades do grupo
	 * @param {Object} data - Novos dados do grupo
	 */
	update(data) {
		// Atualiza apenas propriedades fornecidas
		if (data.name) this.name = data.name;
		if (data.titulo !== undefined) this.titulo = data.titulo;
		if (data.descricao !== undefined) this.descricao = data.descricao;
		if (data.prefix) this.prefix = data.prefix;
		if (data.customIgnoresPrefix) this.customIgnoresPrefix = data.customIgnoresPrefix;
		if (data.inviteCode) this.inviteCode = data.inviteCode;
		if (typeof data.paused === "boolean") this.paused = data.paused;
		if (data.additionalAdmins) this.additionalAdmins = data.additionalAdmins;

		// Atualiza filtros se fornecidos
		if (data.filters) {
			this.filters = {
				...this.filters,
				...data.filters
			};
		}

		// Atualiza monitoramento de plataformas
		if (data.twitch) this.twitch = data.twitch;
		if (data.kick) this.kick = data.kick;
		if (data.youtube) this.youtube = data.youtube;

		// Not in group
		if (data.botNotInGroup) this.botNotInGroup = data.botNotInGroup;

		if (data.webhooks) this.webhooks = data.webhooks;

		// Atualiza boas-vindas
		if (data.greetings) {
			this.greetings = {
				...this.greetings,
				...data.greetings
			};
		}

		// Atualiza despedidas
		if (data.farewells) {
			this.farewells = {
				...this.farewells,
				...data.farewells
			};
		}

		// Atualiza interações automáticas
		if (data.interact) {
			this.interact = {
				...this.interact,
				...data.interact
			};
		}

		// Atualiza outras configurações
		if (data.autoTranslateTo) this.autoTranslateTo = data.autoTranslateTo;
		if (typeof data.autoStt === "boolean") this.autoStt = data.autoStt;
		if (data.ignoredNumbers) this.ignoredNumbers = data.ignoredNumbers;
		if (data.ignoredUsers) this.ignoredUsers = data.ignoredUsers;
		if (data.mutedCommands) this.mutedCommands = data.mutedCommands;
		if (data.mutedCategories) this.mutedCategories = data.mutedCategories; // Added support for updating mutedCategories
		if (data.nicks) this.nicks = data.nicks;
		if (data.warnings) this.warnings = data.warnings;
		if (data.customAIPrompt) this.customAIPrompt = data.customAIPrompt;
		if (typeof data.notificaGrupoFechado === "boolean")
			this.notificaGrupoFechado = data.notificaGrupoFechado;
		if (typeof data.notificaGrupoAberto === "boolean")
			this.notificaGrupoAberto = data.notificaGrupoAberto;

		// Atualiza carimbos de data/hora
		this.updatedAt = Date.now();
	}

	/**
	 * Define o grupo como removido
	 * @param {string} userId - ID do usuário que removeu o bot
	 */
	setRemoved(userId) {
		this.removedBy = userId;
		//this.paused = true;
		this.updatedAt = Date.now();
	}

	/**
	 * Verifica se um usuário está monitorando um canal de plataforma específico
	 * @param {string} platform - Nome da plataforma ('twitch', 'kick', 'youtube')
	 * @param {string} channel - Nome ou ID do canal
	 * @returns {boolean} - True se estiver monitorando
	 */
	isMonitoring(platform, channel) {
		if (!this[platform] ?? !Array.isArray(this[platform])) {
			return false;
		}

		if (platform === "twitch" ?? platform === "kick") {
			return this[platform].some((ch) => ch.name.toLowerCase() === channel.toLowerCase());
		} else if (platform === "youtube") {
			return this[platform].includes(channel);
		}

		return false;
	}

	/**
	 * Adiciona monitoramento de plataforma
	 * @param {string} platform - Nome da plataforma ('twitch', 'kick', 'youtube')
	 * @param {Object|string} channelData - Dados do canal ou ID
	 */
	addMonitoring(platform, channelData) {
		if (!this[platform] ?? !Array.isArray(this[platform])) {
			this[platform] = [];
		}

		if (platform === "twitch" ?? platform === "kick") {
			// Verifica se já está monitorando
			const index = this[platform].findIndex(
				(ch) => ch.name.toLowerCase() === channelData.name.toLowerCase()
			);

			if (index !== -1) {
				// Atualiza monitoramento existente
				this[platform][index] = channelData;
			} else {
				// Adiciona novo monitoramento
				this[platform].push(channelData);
			}
		} else if (platform === "youtube") {
			// Adiciona se ainda não estiver monitorando
			if (!this[platform].includes(channelData)) {
				this[platform].push(channelData);
			}
		}

		this.updatedAt = Date.now();
	}

	/**
	 * Remove monitoramento de plataforma
	 * @param {string} platform - Nome da plataforma ('twitch', 'kick', 'youtube')
	 * @param {string} channel - Nome ou ID do canal
	 */
	removeMonitoring(platform, channel) {
		if (!this[platform] ?? !Array.isArray(this[platform])) {
			return;
		}

		if (platform === "twitch" ?? platform === "kick") {
			this[platform] = this[platform].filter(
				(ch) => ch.name.toLowerCase() !== channel.toLowerCase()
			);
		} else if (platform === "youtube") {
			this[platform] = this[platform].filter((id) => id !== channel);
		}

		this.updatedAt = Date.now();
	}
}

module.exports = Group;
