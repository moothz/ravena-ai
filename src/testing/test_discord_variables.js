const assert = require("assert");
const DiscordBot = require("../DiscordBot");
const CustomVariableProcessor = require("../utils/CustomVariableProcessor");

async function runTests() {
	console.log("=== INICIANDO TESTES DO DISCORD WRAPPER E VARIÁVEIS ===");

	// 1. Instância do bot Discord para teste
	const bot = new DiscordBot({
		id: "test-discord-bot",
		discordToken: "fake-test-token",
		grupoLogs: "1234567890"
	});
	bot.discordBotId = "9999999999";
	bot.client.info.wid._serialized = bot.discordBotId;
	bot.client.info.wid.user = bot.discordBotId;

	// Mock do discordClient
	const mockMembers = new Map();
	mockMembers.set("1111111111", {
		id: "1111111111",
		displayName: "Alice",
		permissions: { has: () => false },
		roles: { cache: [] },
		user: { id: "1111111111", username: "alice_dc", globalName: "Alice", bot: false }
	});
	mockMembers.set("2222222222", {
		id: "2222222222",
		displayName: "Bob",
		permissions: { has: () => true },
		roles: { cache: [{ name: "ravenadmin" }] },
		user: { id: "2222222222", username: "bob_dc", globalName: "Bob", bot: false }
	});
	mockMembers.set("3333333333", {
		id: "3333333333",
		displayName: "MusicBot",
		permissions: { has: () => false },
		roles: { cache: [] },
		user: { id: "3333333333", username: "music_bot", globalName: "MusicBot", bot: true }
	});
	mockMembers.set("9999999999", {
		id: "9999999999",
		displayName: "Ravena",
		permissions: { has: () => true },
		roles: { cache: [] },
		user: { id: "9999999999", username: "ravena", globalName: "Ravena", bot: true }
	});

	const mockGuild = {
		id: "guild-123",
		name: "Servidor Teste",
		memberCount: 4,
		members: {
			cache: mockMembers,
			fetch: async () => mockMembers
		},
		description: "Descrição da Guilda"
	};

	const mockChannel = {
		id: "channel-456",
		name: "geral",
		guild: mockGuild,
		members: mockMembers,
		topic: "Canal de conversas gerais",
		isDMBased: () => false,
		isTextBased: () => true
	};

	bot.discordClient.channels.fetch = async (id) => {
		if (id === "channel-456") return mockChannel;
		throw new Error("Unknown Channel");
	};

	bot.discordClient.guilds.fetch = async (id) => {
		if (id === "guild-123") return mockGuild;
		throw new Error("Unknown Guild");
	};

	bot.discordClient.users.fetch = async (id) => {
		const cleanId = String(id)
			.split("@")[0]
			.replace(/[<@!>]/g, "");
		const member = mockMembers.get(cleanId);
		if (member) {
			return {
				id: member.user.id,
				username: member.user.username,
				globalName: member.user.globalName,
				bot: member.user.bot,
				displayAvatarURL: () => "http://avatar.url"
			};
		}
		throw new Error("User not found");
	};

	// --- TESTE 1: getChatDetails popula participantes com isBot, isAdmin e desc ---
	console.log("\n[TESTE 1] Testando getChatDetails no DiscordBot...");
	const chatDetails = await bot.getChatDetails("channel-456");
	assert.strictEqual(chatDetails.id._serialized, "channel-456");
	assert.strictEqual(chatDetails.name, "geral");
	assert.strictEqual(chatDetails.isGroup, true);
	assert.strictEqual(chatDetails.participants.length, 4);

	const alice = chatDetails.participants.find((p) => p.id._serialized === "1111111111");
	assert.strictEqual(alice.isBot, false);
	assert.strictEqual(alice.isAdmin, false);
	assert.strictEqual(alice.name, "Alice");

	const bob = chatDetails.participants.find((p) => p.id._serialized === "2222222222");
	assert.strictEqual(bob.isBot, false);
	assert.strictEqual(bob.isAdmin, true);

	const musicBot = chatDetails.participants.find((p) => p.id._serialized === "3333333333");
	assert.strictEqual(musicBot.isBot, true);
	assert.strictEqual(chatDetails.groupMetadata.desc, "Canal de conversas gerais");
	console.log("✓ getChatDetails retornou estrutura completa com flags de bot e admin.");

	// --- TESTE 2: getChatDetails com Guild ID ---
	console.log("\n[TESTE 2] Testando getChatDetails com Guild ID...");
	const guildDetails = await bot.getChatDetails("guild-123");
	assert.strictEqual(guildDetails.id._serialized, "guild-123");
	assert.strictEqual(guildDetails.name, "Servidor Teste");
	assert.strictEqual(guildDetails.groupMetadata.desc, "Descrição da Guilda");
	console.log("✓ getChatDetails resolveu Guild ID corretamente.");

	// --- TESTE 3: formatMessageFromDiscord preenche mentionedIds e hasQuotedMsg ---
	console.log("\n[TESTE 3] Testando formatMessageFromDiscord com menções e quote...");
	const mockDiscordMsg = {
		id: "msg-999",
		content: "!comando @Alice",
		inGuild: () => true,
		createdTimestamp: Date.now(),
		author: { id: "2222222222", username: "bob_dc", bot: false },
		member: { displayName: "Bob" },
		channel: mockChannel,
		guild: mockGuild,
		attachments: new Map(),
		mentions: {
			users: new Map([["1111111111", { id: "1111111111", username: "alice_dc" }]])
		},
		reference: { messageId: "msg-888" },
		reactions: { cache: new Map() }
	};

	const formatted = await bot.formatMessageFromDiscord(mockDiscordMsg, true);
	assert.deepStrictEqual(formatted.mentions, ["1111111111"]);
	assert.deepStrictEqual(formatted.mentionedIds, ["1111111111"]);
	assert.deepStrictEqual(formatted.origin.mentionedIds, ["1111111111"]);
	assert.strictEqual(formatted.hasQuotedMsg, true);
	assert.strictEqual(typeof formatted.getQuotedMessage, "function");
	console.log(
		"✓ formatMessageFromDiscord preencheu mentionedIds na raiz e no origin corretamente."
	);

	// --- TESTE 4: CustomVariableProcessor com {membroRandom} ---
	console.log("\n[TESTE 4] Testando processamento de {membroRandom}...");
	const varProcessor = new CustomVariableProcessor();
	const contextMembro = {
		bot,
		message: {
			group: "channel-456",
			author: "2222222222",
			name: "Bob",
			origin: {
				mentionedIds: []
			}
		},
		options: {}
	};

	// Como o bot é 9999999999 e MusicBot é isBot: true, e Bob/Alice são humanos,
	// {membroRandom} deve escolher apenas entre humanos (Alice ou Bob).
	for (let i = 0; i < 10; i++) {
		const result = await varProcessor.processContextVariables(
			"Membro: {membroRandom}",
			contextMembro
		);
		assert.ok(
			result.includes("Alice") || result.includes("Bob"),
			`Deveria escolher Alice ou Bob, mas retornou: ${result}`
		);
		assert.ok(!result.includes("MusicBot"), "Nunca deveria escolher bot!");
		assert.ok(!result.includes("Ravena"), "Nunca deveria escolher a si mesmo!");
	}
	console.log("✓ {membroRandom} sorteou apenas membros humanos e excluiu bots.");

	// --- TESTE 5: Múltiplos {membroRandom} são substituídos por ocorrência ---
	console.log("\n[TESTE 5] Testando múltiplos {membroRandom}...");
	const multiMembroText = "1: {membroRandom} | 2: {membroRandom}";
	const multiResult = await varProcessor.processContextVariables(multiMembroText, contextMembro);
	assert.ok(!multiResult.includes("{membroRandom}"), "Todas as variáveis foram substituídas");
	console.log(`✓ Múltiplos {membroRandom} substituídos com sucesso: "${multiResult}"`);

	// --- TESTE 6: {mention} com menção explícita no Discord ---
	console.log("\n[TESTE 6] Testando {mention} com menção explícita...");
	const contextMention = {
		bot,
		message: formatted,
		options: {}
	};

	const mentionResult = await varProcessor.processContextVariables(
		"Um abraço para {mention}!",
		contextMention
	);
	assert.ok(
		mentionResult.includes("@1111111111"),
		`Deveria conter a menção @1111111111, mas retornou: ${mentionResult}`
	);
	assert.deepStrictEqual(contextMention.options.mentions, ["1111111111"]);
	console.log("✓ {mention} utilizou a menção explícita da mensagem do Discord.");

	// --- TESTE 7: {mention} sem menção explícita cai em membro aleatório humano ---
	console.log("\n[TESTE 7] Testando {mention} como fallback aleatório...");
	const contextNoMention = {
		bot,
		message: {
			group: "channel-456",
			author: "2222222222",
			origin: {
				mentionedIds: []
			}
		},
		options: {}
	};

	const fallbackResult = await varProcessor.processContextVariables(
		"Sorteado: {mention}",
		contextNoMention
	);
	assert.ok(
		fallbackResult.includes("@1111111111") || fallbackResult.includes("@2222222222"),
		`Deveria sortear @1111111111 ou @2222222222, mas retornou: ${fallbackResult}`
	);
	assert.ok(!fallbackResult.includes("@3333333333"), "Não deve sortear bots no fallback!");
	console.log("✓ {mention} em fallback selecionou participante humano e excluiu bots.");

	console.log("\n=== TODOS OS TESTES DO DISCORD WRAPPER PASSARAM COM SUCESSO! ===");
}

runTests()
	.then(() => {
		process.exit(0);
	})
	.catch((err) => {
		console.error("ERRO NO TESTE:", err);
		process.exit(1);
	});
