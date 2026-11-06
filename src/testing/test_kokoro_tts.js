process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const ServiceProviderService = require("../services/ServiceProviderService");
const SpeechCommands = require("../functions/SpeechCommands");
const { createMessage } = require("./FakeMessage");

async function runTests() {
	console.log("=== INICIANDO TESTES DO KOKORO-TTS ===");

	const bot = new FakeBot({ id: "teste-kokoro-tts", grupoLogs: "logs@g.us" });
	const eventHandler = EventHandler.getInstance();
	const serviceProviderService = ServiceProviderService.getInstance();

	await eventHandler.commandHandler.loadAllCommands();

	// 1. Verificar ServiceProviderService ("kokorotts")
	console.log("\n[TESTE 1] Verificando ServiceProviderService ('kokorotts')...");
	const providers = serviceProviderService.getProviders("kokorotts");
	assert(
		Array.isArray(providers) && providers.length > 0,
		"Deve haver pelo menos 1 provider kokorotts ativo"
	);
	assert(
		providers[0].url.includes("5050"),
		`URL do provider kokorotts deve apontar para porta 5050 (atual: ${providers[0].url})`
	);
	console.log("✅ TESTE 1 APROVADO: Provider kokorotts carregado:", providers[0].url);

	// 2. Verificar ttsCharacters e comandos enxutos em SpeechCommands
	console.log("\n[TESTE 2] Verificando ttsCharacters e lista de comandos de voz...");
	const charNames = SpeechCommands.ttsCharacters.map((c) => c.name);
	assert.deepStrictEqual(
		charNames,
		["mulher", "homem", "narrador"],
		`ttsCharacters deve conter apenas mulher, homem e narrador (atual: ${charNames.join(", ")})`
	);

	const cmdNames = SpeechCommands.commands.map((c) => c.name);
	assert.deepStrictEqual(
		cmdNames,
		["stt", "transcrever", "tts", "tts-mulher", "tts-homem", "tts-narrador"],
		`Comandos em SpeechCommands devem ser enxutos (atual: ${cmdNames.join(", ")})`
	);
	console.log("✅ TESTE 2 APROVADO: ttsCharacters e comandos enxutos validados.");

	// 3. Testar !tts-mulher, !tts-homem, !tts-narrador e !tts (aleatório + random_blend)
	const testGroup = "999999999@g.us";
	const cmdsToTest = [
		{ cmd: "tts-mulher", args: ["Olá,", "testando", "voz", "feminina."] },
		{ cmd: "tts-homem", args: ["Olá,", "testando", "voz", "masculina."] },
		{ cmd: "tts-narrador", args: ["E", "assim", "começou", "a", "jornada."] },
		{ cmd: "tts", args: ["Testando", "comando", "tts", "com", "blend", "aleatório."] }
	];

	for (let idx = 0; idx < cmdsToTest.length; idx++) {
		const item = cmdsToTest[idx];
		console.log(`\n[TESTE E2E] Executando !${item.cmd}...`);
		bot.resetCapture();

		const msg = createMessage({
			content: `!${item.cmd} ${item.args.join(" ")}`,
			type: "chat",
			group: testGroup,
			author: `551199999999${idx}@s.whatsapp.net`
		});

		await eventHandler.commandHandler.processCommand(bot, msg, item.cmd, item.args, null);

		const reply = bot.capturedMessages[0];
		assert(reply, `Deveria ter capturado uma resposta para !${item.cmd}`);
		assert(
			reply.content && reply.content.mimetype === "audio/mpeg",
			`Resposta de !${item.cmd} deve ser MessageMedia audio/mpeg (recebido: ${JSON.stringify(reply.content).substring(0, 100)})`
		);
		assert(
			reply.content.data && reply.content.data.length > 1000,
			`Áudio base64 de !${item.cmd} deve ter conteúdo válido`
		);
		console.log(
			`✅ !${item.cmd} APROVADO: Áudio MP3 gerado (${reply.content.data.length} chars base64).`
		);
	}

	console.log("\n=== TODOS OS TESTES DO KOKORO-TTS PASSARAM COM SUCESSO! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ FALHA NOS TESTES:", err);
		process.exit(1);
	});
