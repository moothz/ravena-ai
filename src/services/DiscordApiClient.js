const { Client, GatewayIntentBits, Partials } = require("discord.js");

/**
 * Wrapper para o cliente Discord.
 * Por enquanto, ele apenas inicializa e exporta o cliente,
 * já que a biblioteca discord.js já gerencia a maior parte da comunicação.
 */
class DiscordApiClient {
	constructor(token) {
		if (!token) {
			throw new Error("Discord API Client: o token é obrigatório.");
		}

		this.client = new Client({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMembers,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.MessageContent,
				GatewayIntentBits.DirectMessages
			],
			partials: [Partials.Channel]
		});

		this.token = token;

		// Adiciona um listener de debug para diagnosticar problemas de conexão/eventos
		if (process.env.DISCORD_DEBUG === "true") {
			this.client.on("debug", (e) => console.log("[Discord.js Debug]", e));
		}
	}

	/**
	 * Conecta o bot ao Discord.
	 */
	connect() {
		this.client.login(this.token);
	}

	/**
	 * Retorna a instância do cliente do discord.js.
	 * @returns {Client}
	 */
	getClient() {
		return this.client;
	}
}

module.exports = DiscordApiClient;
