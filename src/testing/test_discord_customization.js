const assert = require("assert");
const http = require("http");
const { PermissionsBitField, Collection } = require("discord.js");
const { context, trace } = require("@opentelemetry/api");
const { AsyncLocalStorageContextManager } = require("@opentelemetry/context-async-hooks");
const {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor
} = require("@opentelemetry/sdk-trace-base");

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
const spanExporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(
	new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] })
);
const telemetry = require("../telemetry");
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

	console.log("\n--- 4. Validando apelido sem argumento e acima do limite ---");

	lastEditedPayload = "untouched";
	const resNoArg = await setBotNameCommand(
		botMock,
		{ from: "123", guildId: "guild_test_1", discordMessage: adminMsg.discordMessage },
		[]
	);
	assert.ok(resNoArg.content.includes("!d-botname <novo nome>"));
	assert.strictEqual(lastEditedPayload, "untouched", "Sem argumento não deve resetar o apelido");

	const resLong = await setBotNameCommand(
		botMock,
		{ from: "123", guildId: "guild_test_1", discordMessage: adminMsg.discordMessage },
		["x".repeat(33)]
	);
	assert.ok(resLong.content.includes("32 caracteres"));
	assert.strictEqual(lastEditedPayload, "untouched", "Apelido longo não deve ir à API");

	console.log("✓ Apelido sem argumento e longo recusados");

	console.log("\n--- 5. Validando origem, tipo e tamanho da foto ---");

	const pngBytes = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		Buffer.from("synthetic-png-body")
	]);
	const bigBytes = Buffer.alloc(9 * 1024 * 1024, 1);
	const hits = [];
	const server = http.createServer((req, res) => {
		hits.push(req.url);
		if (req.url === "/big.png") {
			res.writeHead(200, { "content-type": "image/png" });
			res.end(bigBytes);
			return;
		}
		if (req.url === "/internal.png") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end('{"secret":"internal"}');
			return;
		}
		res.writeHead(200, { "content-type": "image/png" });
		res.end(pngBytes);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${server.address().port}`;

	const attachments = (...items) =>
		new Collection(items.map((item, i) => [String(i), { name: `f${i}`, ...item }]));
	const avatarMsg = (atts, extra = {}) => ({
		from: "123",
		guildId: "guild_test_1",
		discordMessage: { ...adminMsg.discordMessage, attachments: atts },
		getQuotedMessage: async () => null,
		...extra
	});

	lastEditedPayload = "untouched";
	const resUrl = await setBotAvatarCommand(botMock, avatarMsg(new Collection()), [
		`${base}/internal.png`
	]);
	assert.strictEqual(hits.length, 0, "URL do argumento não deve ser baixada");
	assert.strictEqual(lastEditedPayload, "untouched");
	assert.ok(resUrl.content.includes("Envie uma imagem"));

	const resDeclaredBig = await setBotAvatarCommand(
		botMock,
		avatarMsg(
			attachments({ contentType: "image/png", size: 9 * 1024 * 1024, url: `${base}/big.png` })
		)
	);
	assert.strictEqual(hits.length, 0, "Anexo acima do limite não deve ser baixado");
	assert.strictEqual(lastEditedPayload, "untouched");
	assert.ok(resDeclaredBig.content.includes("8 MB"));

	const resServedBig = await setBotAvatarCommand(
		botMock,
		avatarMsg(attachments({ contentType: "image/png", size: 1024, url: `${base}/big.png` }))
	);
	assert.deepStrictEqual(hits, ["/big.png"]);
	assert.strictEqual(
		lastEditedPayload,
		"untouched",
		"Resposta acima do limite não deve virar avatar"
	);
	assert.ok(resServedBig.content.includes("Não consegui baixar"));

	hits.length = 0;
	let downloadMediaCalls = 0;
	const resVideo = await setBotAvatarCommand(
		botMock,
		avatarMsg(attachments({ contentType: "video/mp4", size: 1024, url: `${base}/clip.mp4` }), {
			hasMedia: true,
			downloadMedia: async () => {
				downloadMediaCalls++;
				return { mimetype: "video/mp4", data: Buffer.from("video").toString("base64") };
			}
		})
	);
	const resSvg = await setBotAvatarCommand(
		botMock,
		avatarMsg(attachments({ contentType: "image/svg+xml", size: 1024, url: `${base}/a.svg` }))
	);
	assert.strictEqual(hits.length, 0, "Anexo de tipo não aceito não deve ser baixado");
	assert.strictEqual(downloadMediaCalls, 0);
	assert.strictEqual(lastEditedPayload, "untouched", "Vídeo e SVG não devem virar avatar");
	assert.ok(resVideo.content.includes("PNG, JPEG, GIF ou WEBP"));
	assert.ok(resSvg.content.includes("PNG, JPEG, GIF ou WEBP"));

	const resOk = await setBotAvatarCommand(
		botMock,
		avatarMsg(
			attachments(
				{ contentType: "video/mp4", size: 1024, url: `${base}/clip.mp4` },
				{ contentType: "image/png", size: pngBytes.length, url: `${base}/ok.png` }
			)
		)
	);
	assert.ok(resOk.content.includes("atualizada com sucesso"));
	assert.deepStrictEqual(hits, ["/ok.png"]);
	assert.ok(lastEditedPayload.avatar.equals(pngBytes), "Avatar deve receber os bytes baixados");

	hits.length = 0;
	lastEditedPayload = "untouched";
	const resQuoted = await setBotAvatarCommand(
		botMock,
		avatarMsg(new Collection(), {
			getQuotedMessage: async () => ({
				discordMessage: {
					attachments: attachments({
						contentType: "image/webp",
						size: pngBytes.length,
						url: `${base}/quoted.webp`
					})
				}
			})
		})
	);
	assert.ok(resQuoted.content.includes("atualizada com sucesso"));
	assert.deepStrictEqual(hits, ["/quoted.webp"]);
	assert.ok(lastEditedPayload.avatar.equals(pngBytes));

	hits.length = 0;
	lastEditedPayload = "untouched";
	const resAvatarNoPerm = await setBotAvatarCommand(botMock, {
		...avatarMsg(new Collection()),
		discordMessage: {
			...regularMsg.discordMessage,
			attachments: attachments({ contentType: "image/png", size: 10, url: `${base}/ok.png` })
		}
	});
	assert.ok(resAvatarNoPerm.content.includes("Apenas administradores"));
	assert.strictEqual(hits.length, 0);
	assert.strictEqual(lastEditedPayload, "untouched");

	console.log("✓ Foto: só anexo ou citação, tipos de imagem aceitos e limite de 8 MB");

	console.log("\n--- 6. Validando telemetria das recusas e das etapas ---");

	spanExporter.reset();
	await telemetry.withSpan("command d-botavatar", {}, () =>
		setBotAvatarCommand(
			botMock,
			avatarMsg(
				attachments({ contentType: "image/png", size: 9 * 1024 * 1024, url: `${base}/big.png` })
			)
		)
	);
	await telemetry.withSpan("command d-botname", {}, () =>
		setBotNameCommand(
			botMock,
			{ from: "123", guildId: "guild_test_1", discordMessage: regularMsg.discordMessage },
			["Nome"]
		)
	);
	await telemetry.withSpan("command d-botavatar", {}, () =>
		setBotAvatarCommand(
			botMock,
			avatarMsg(
				attachments({ contentType: "image/png", size: pngBytes.length, url: `${base}/ok.png` })
			)
		)
	);
	const spans = spanExporter.getFinishedSpans();
	const commandSpans = spans.filter((sp) => sp.name.startsWith("command "));
	assert.deepStrictEqual(
		commandSpans.map((sp) => [sp.attributes["app.outcome"], sp.attributes["app.reject.reason"]]),
		[
			["rejected", "image_too_large"],
			["rejected", "no_permission"],
			[undefined, undefined]
		]
	);
	const okCommand = commandSpans[2].spanContext().spanId;
	const download = spans.find((sp) => sp.name === "discord avatar.download");
	const update = spans.find((sp) => sp.name === "discord profile.update");
	assert.strictEqual(download.parentSpanContext?.spanId ?? download.parentSpanId, okCommand);
	assert.strictEqual(download.attributes["ravena.discord.avatar.type"], "image/png");
	assert.strictEqual(update.attributes["ravena.discord.profile.field"], "avatar");

	server.close();
	console.log("✓ Recusas marcadas como rejected e etapas com span próprio");

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("❌ Falha nos testes:", err);
	process.exit(1);
});
