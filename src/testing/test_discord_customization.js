const assert = require("assert");
const { PermissionsBitField } = require("discord.js");
const {
	isDiscordAdmin,
	setBotNameCommand,
	setBotAvatarCommand,
	resetBotAvatarCommand
} = require("../functions/DiscordCommands");
const DiscordBot = require("../DiscordBot");

async function runTests() {
	console.log("=== INICIANDO TESTES DE PERSONALIZAÇÃO DISCORD (NOME E AVATAR) ===");

	// 1. Testando verificação de permissões (isDiscordAdmin)
	console.log("\n--- 1. Validando permissões administrativas ---");

	// Usuário comum sem permissões
	const regularMsg = {
		discordMessage: {
			member: {
				id: "user123",
				permissions: new PermissionsBitField()
			},
			guild: { ownerId: "owner999" }
		}
	};
	assert.strictEqual(isDiscordAdmin(regularMsg), false, "Membro comum não deve ter permissão");

	// Dono do servidor
	const ownerMsg = {
		discordMessage: {
			member: {
				id: "owner999",
				permissions: new PermissionsBitField()
			},
			guild: { ownerId: "owner999" }
		}
	};
	assert.strictEqual(isDiscordAdmin(ownerMsg), true, "Dono do servidor deve ter permissão");

	// Administrador
	const adminMsg = {
		discordMessage: {
			member: {
				id: "admin123",
				permissions: new PermissionsBitField(PermissionsBitField.Flags.Administrator)
			},
			guild: { ownerId: "owner999" }
		}
	};
	assert.strictEqual(isDiscordAdmin(adminMsg), true, "Administrador deve ter permissão");

	// Gerenciar Servidor (ManageGuild)
	const manageGuildMsg = {
		discordMessage: {
			member: {
				id: "mod123",
				permissions: new PermissionsBitField(PermissionsBitField.Flags.ManageGuild)
			},
			guild: { ownerId: "owner999" }
		}
	};
	assert.strictEqual(
		isDiscordAdmin(manageGuildMsg),
		true,
		"Quem tem Gerenciar Servidor deve ter permissão"
	);

	console.log("✓ Verificação de permissões OK");

	// 2. Testando métodos da classe DiscordBot (mock do discordClient)
	console.log("\n--- 2. Validando métodos setGuildNickname e setGuildAvatar em DiscordBot ---");

	let lastEditedPayload = null;
	const mockGuild = {
		id: "guild_test_1",
		members: {
			editMe: async (payload) => {
				lastEditedPayload = payload;
				return true;
			}
		}
	};

	const botMock = Object.create(DiscordBot.prototype);
	botMock.id = "test-discord";
	botMock.useDiscord = true;
	botMock.logger = {
		info: () => {},
		error: () => {},
		warn: () => {},
		debug: () => {}
	};
	botMock.discordClient = {
		guilds: {
			cache: new Map([["guild_test_1", mockGuild]]),
			fetch: async (id) => (id === "guild_test_1" ? mockGuild : null)
		}
	};

	// Altera apelido
	await botMock.setGuildNickname("guild_test_1", "Ravena Linda");
	assert.deepStrictEqual(lastEditedPayload, { nick: "Ravena Linda" });

	// Reseta apelido
	await botMock.setGuildNickname("guild_test_1", null);
	assert.deepStrictEqual(lastEditedPayload, { nick: null });

	// Altera avatar
	const dummyBuffer = Buffer.from("fake-avatar-bytes");
	await botMock.setGuildAvatar("guild_test_1", dummyBuffer);
	assert.deepStrictEqual(lastEditedPayload, { avatar: dummyBuffer });

	// Reseta avatar
	await botMock.setGuildAvatar("guild_test_1", null);
	assert.deepStrictEqual(lastEditedPayload, { avatar: null });

	console.log("✓ Métodos setGuildNickname e setGuildAvatar no DiscordBot OK");

	// 3. Testando execução dos comandos
	console.log("\n--- 3. Validando comandos exclusivos do Discord ---");

	// Rejeição fora do Discord
	const waBotMock = { useDiscord: false };
	const resWa = await setBotNameCommand(waBotMock, { from: "123", guildId: "g1" }, ["teste"]);
	assert.ok(resWa.content.includes("exclusivo para servidores do Discord"));

	// Rejeição fora de guild (em PV/DM)
	const resDm = await setBotNameCommand(botMock, { from: "123", guildId: null }, ["teste"]);
	assert.ok(resDm.content.includes("dentro de um servidor"));

	// Rejeição por falta de permissão
	const resNoPerm = await setBotNameCommand(
		botMock,
		{ from: "123", guildId: "guild_test_1", discordMessage: regularMsg.discordMessage },
		["NovoNome"]
	);
	assert.ok(resNoPerm.content.includes("Apenas administradores"));

	// Sucesso na alteração de apelido
	const resSuccessNick = await setBotNameCommand(
		botMock,
		{ from: "123", guildId: "guild_test_1", discordMessage: adminMsg.discordMessage },
		["Novo", "Nome", "Do", "Bot"]
	);
	assert.ok(resSuccessNick.content.includes("atualizado para: **Novo Nome Do Bot**"));
	assert.strictEqual(lastEditedPayload.nick, "Novo Nome Do Bot");

	// Sucesso no reset de apelido
	const resResetNick = await setBotNameCommand(
		botMock,
		{ from: "123", guildId: "guild_test_1", discordMessage: adminMsg.discordMessage },
		["reset"]
	);
	assert.ok(resResetNick.content.includes("resetado para o padrão"));
	assert.strictEqual(lastEditedPayload.nick, null);

	// Sucesso no reset de avatar
	const resResetAvatar = await resetBotAvatarCommand(botMock, {
		from: "123",
		guildId: "guild_test_1",
		discordMessage: adminMsg.discordMessage
	});
	assert.ok(resResetAvatar.content.includes("resetada para o avatar padrão"));
	assert.strictEqual(lastEditedPayload.avatar, null);

	console.log("✓ Comandos !d-botname, !d-botavatar e !d-botavatar-reset validados com sucesso");

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("❌ Falha nos testes:", err);
	process.exit(1);
});
