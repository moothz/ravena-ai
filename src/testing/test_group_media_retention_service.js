process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const GroupMediaRetentionService = require("../services/GroupMediaRetentionService");

async function runTests() {
	console.log("=== INICIANDO TESTES DO GROUP MEDIA RETENTION SERVICE ===");

	const testStatePath = path.resolve(__dirname, "../../temp/test-orphan-cleaner-state.json");
	if (fs.existsSync(testStatePath)) {
		fs.unlinkSync(testStatePath);
	}

	const deletedS3Groups = [];
	const mockStorageService = {
		deleteGroup: async (groupId, bucket) => {
			deletedS3Groups.push({ groupId, bucket });
			return 5; // Simula 5 objetos removidos
		}
	};

	// 1. Teste de detecção de mídia em respostas
	console.log("-> Teste 1: Validação de detecção de tokens de mídia...");
	const serviceInstance = new GroupMediaRetentionService({
		bots: [],
		database: { coreRepo: { mappers: {} } },
		storageService: mockStorageService,
		stateFilePath: testStatePath
	});

	assert.strictEqual(serviceInstance.hasMediaResponse(["{video-sample.mp4}"]), true);
	assert.strictEqual(serviceInstance.hasMediaResponse(["{image-abc.png}"]), true);
	assert.strictEqual(serviceInstance.hasMediaResponse(["{audio-123.ogg} audio de teste"]), true);
	assert.strictEqual(serviceInstance.hasMediaResponse(["{sticker-xyz.webp}"]), true);
	assert.strictEqual(serviceInstance.hasMediaResponse(["{media-teste.jpg}"]), true);
	assert.strictEqual(serviceInstance.hasMediaResponse(["Texto puro sem mídia"]), false);
	assert.strictEqual(serviceInstance.hasMediaResponse(["!pix 123.456.789-00"]), false);
	assert.strictEqual(serviceInstance.hasMediaResponse(["{chave_invalida}"]), false);
	console.log("✓ Detecção de mídia aprovada!");

	// 2. Teste de coleta de grupos ativos
	console.log("-> Teste 2: Coleta de grupos ativos entre instâncias de bots...");
	const fakeBot1 = {
		id: "rav-bot1",
		useTelegram: false,
		useDiscord: false,
		listGroups: async () => [
			{ JID: "1203630001@g.us", Name: "Grupo Ativo 1" },
			{ JID: "1203630002@g.us", Name: "Grupo Ativo 2" }
		]
	};
	const fakeBot2 = {
		id: "rav-bot2",
		useTelegram: false,
		useDiscord: false,
		listGroups: async () => [
			{ JID: "1203630002@g.us", Name: "Grupo Ativo 2 (mesmo grupo)" },
			{ JID: "1203630003@g.us", Name: "Grupo Ativo 3" }
		]
	};
	const fakeTgBot = {
		id: "rav-tg",
		useTelegram: true,
		listGroups: async () => [{ JID: "tg-group-ignore" }]
	};

	const multiBotService = new GroupMediaRetentionService({
		bots: [fakeBot1, fakeBot2, fakeTgBot],
		database: { coreRepo: { mappers: {} } },
		storageService: mockStorageService,
		stateFilePath: testStatePath
	});

	const activeJids = await multiBotService.getActiveWhatsAppGroups();
	assert.strictEqual(activeJids.size, 3);
	assert.strictEqual(activeJids.has("1203630001@g.us"), true);
	assert.strictEqual(activeJids.has("1203630002@g.us"), true);
	assert.strictEqual(activeJids.has("1203630003@g.us"), true);
	assert.strictEqual(activeJids.has("tg-group-ignore"), false);
	console.log("✓ Coleta de grupos ativos aprovada!");

	// 3. Teste de ciclo de retenção com mock do banco de dados
	console.log("-> Teste 3: Ciclo de retenção e limpeza seletiva de mídias...");

	const mockDbState = {
		custom_commands: [
			// Grupo 1: Ativo -> nada deve ser deletado
			{ group_id: "1203630001@g.us", trigger: "!foto", responses: '["{image-1.png}"]' },
			// Grupo 4: Órfão há 5 dias (< 30) -> nada deve ser deletado
			{ group_id: "1203630004@g.us", trigger: "!foto", responses: '["{image-4.png}"]' },
			// Grupo 5: Órfão há 45 dias (> 30) -> comando com mídia DEVE ser deletado, comando de texto NÃO
			{ group_id: "1203630005@g.us", trigger: "!video", responses: '["{video-5.mp4}"]' },
			{ group_id: "1203630005@g.us", trigger: "!regras", responses: '["Regras do grupo em texto"]' }
		],
		groups: [
			{
				id: "1203630005@g.us",
				greetings: JSON.stringify({
					text: "Bem vindo!",
					image: { file: "welcome.jpg", caption: "Bem vindo!" }
				}),
				farewells: JSON.stringify({
					text: "Adeus!",
					video: { file: "bye.mp4" }
				}),
				twitch: JSON.stringify([{ channel: "streamer", mediaConfig: { content: "live.png" } }]),
				kick: JSON.stringify([])
			}
		],
		periods: {
			"1203630004@g.us": {
				// Saiu há 5 dias
				last_leave: Math.floor((Date.now() - 5 * 86400 * 1000) / 1000)
			},
			"1203630005@g.us": {
				// Saiu há 45 dias
				last_leave: Math.floor((Date.now() - 45 * 86400 * 1000) / 1000)
			}
		}
	};

	const mockDatabase = {
		coreRepo: {
			mappers: {
				all: (db, query, params) => {
					if (db === "custom_commands") {
						if (params && params[0]) {
							return mockDbState.custom_commands.filter((c) => c.group_id === params[0]);
						}
						return mockDbState.custom_commands;
					}
					if (db === "core") {
						return mockDbState.groups.map((g) => ({ id: g.id }));
					}
					return [];
				},
				get: (db, query, params) => {
					if (db === "core" && query.includes("group_membership_periods")) {
						const jid = params[0];
						return mockDbState.periods[jid] || null;
					}
					if (db === "core" && query.includes("FROM groups WHERE id")) {
						const jid = params[0];
						return mockDbState.groups.find((g) => g.id === jid) || null;
					}
					return null;
				},
				run: (db, query, params) => {
					if (db === "custom_commands" && query.includes("DELETE FROM custom_commands")) {
						const [groupId, trigger] = params;
						mockDbState.custom_commands = mockDbState.custom_commands.filter(
							(c) => !(c.group_id === groupId && c.trigger === trigger)
						);
					}
					if (db === "core" && query.includes("UPDATE groups SET")) {
						const [greetings, farewells, twitch, kick, groupId] = params;
						const grp = mockDbState.groups.find((g) => g.id === groupId);
						if (grp) {
							grp.greetings = greetings;
							grp.farewells = farewells;
							grp.twitch = twitch;
							grp.kick = kick;
						}
					}
				}
			}
		}
	};

	const testService = new GroupMediaRetentionService({
		bots: [fakeBot1, fakeBot2],
		database: mockDatabase,
		storageService: mockStorageService,
		stateFilePath: testStatePath,
		retentionDays: 30
	});

	// Rodar em modo real
	const summary = await testService.runCleanupCycle({ dryRun: false });

	assert.strictEqual(summary.totalActiveGroups, 3);
	assert.strictEqual(summary.orphanGroupsFound, 2); // 1203630004 e 1203630005
	assert.strictEqual(summary.eligibleForCleanup, 1); // Somente 1203630005 (> 30 dias)
	assert.strictEqual(summary.totalMediaCommandsDeleted, 1);
	assert.strictEqual(summary.totalS3ObjectsDeleted, 5);

	// Verificar se comando de texto foi preservado
	const remainingCmds = mockDbState.custom_commands.filter((c) => c.group_id === "1203630005@g.us");
	assert.strictEqual(remainingCmds.length, 1);
	assert.strictEqual(remainingCmds[0].trigger, "!regras");
	console.log("✓ Comando de texto '!regras' foi preservado com sucesso!");

	// Verificar se greetings e farewells mantiveram texto e removeram imagem/vídeo
	const cleanedGroup = mockDbState.groups.find((g) => g.id === "1203630005@g.us");
	const parsedGreetings = JSON.parse(cleanedGroup.greetings);
	const parsedFarewells = JSON.parse(cleanedGroup.farewells);
	const parsedTwitch = JSON.parse(cleanedGroup.twitch);

	assert.strictEqual(parsedGreetings.text, "Bem vindo!");
	assert.strictEqual(parsedGreetings.image, undefined);
	assert.strictEqual(parsedFarewells.text, "Adeus!");
	assert.strictEqual(parsedFarewells.video, undefined);
	assert.strictEqual(parsedTwitch[0].mediaConfig, undefined);
	console.log("✓ Greetings/Farewells/Twitch tiveram mídias removidas mantendo os textos!");

	// Verificar se storageService.deleteGroup foi chamado para o grupo 5
	assert.strictEqual(deletedS3Groups.length, 1);
	assert.strictEqual(deletedS3Groups[0].groupId, "1203630005@g.us");
	assert.strictEqual(deletedS3Groups[0].bucket, "zap-media");
	console.log("✓ S3 deleteGroup executado corretamente no bucket zap-media!");

	// Limpar temp
	if (fs.existsSync(testStatePath)) {
		fs.unlinkSync(testStatePath);
	}

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
}

runTests().catch((err) => {
	console.error("ERRO NO TESTE:", err);
	process.exit(1);
});
