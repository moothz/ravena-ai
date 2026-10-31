process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const path = require("path");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const ServiceProviderService = require("../services/ServiceProviderService");
const { createMessage, loadMediaFile } = require("./FakeMessage");

async function runTests() {
	console.log("=== INICIANDO TESTES DO REMBG SERVICE PROVIDERS ===");

	const bot = new FakeBot({ id: "teste-rembg", grupoLogs: "logs@g.us" });
	const eventHandler = EventHandler.getInstance();
	const serviceProviderService = ServiceProviderService.getInstance();

	await eventHandler.commandHandler.loadAllCommands();

	const testImagePath = path.join(__dirname, "../../data/rare-fish.jpg");
	const media = loadMediaFile(testImagePath);
	const testGroup = "999999999@g.us";

	// Salva a configuração original de rembg para restaurar ao final
	const originalRembg = serviceProviderService.config?.rembg;

	try {
		// ====================================================================
		// TESTE 1: Nenhum provedor rembg configurado
		// ====================================================================
		console.log("\n[TESTE 1] Executando com lista de provedores vazia...");
		serviceProviderService.config.rembg = [];
		bot.resetCapture();

		const msg1 = createMessage({
			content: media,
			caption: "!removebg",
			type: "image",
			group: testGroup,
			author: "5511999999999@s.whatsapp.net"
		});

		await eventHandler.commandHandler.processCommand(bot, msg1, "removebg", [], null);

		const reply1 = bot.capturedMessages[0];
		assert(reply1, "Deveria ter capturado uma resposta do bot");
		console.log("Resposta capturada:", reply1.content);
		assert.strictEqual(
			reply1.content,
			"Problema removendo fundo da imagem: Nenhum serviço de rembg rodando",
			"Deve retornar a mensagem exata informando que não há serviço rodando"
		);
		console.log("✅ TESTE 1 APROVADO: Resposta correta para provedores ausentes.");

		// ====================================================================
		// TESTE 2: Todos os provedores falham (servidor offline/inacessível)
		// ====================================================================
		console.log("\n[TESTE 2] Executando com servidores offline...");
		serviceProviderService.config.rembg = [
			{
				name: "offline-primary",
				url: "http://127.0.0.1:59999",
				timeout: 2000,
				enabled: true
			},
			{
				name: "offline-backup",
				url: "http://127.0.0.1:59998",
				timeout: 2000,
				enabled: true
			}
		];
		bot.resetCapture();

		const msg2 = createMessage({
			content: media,
			caption: "!removebg",
			type: "image",
			group: testGroup,
			author: "5511999999999@s.whatsapp.net"
		});

		await eventHandler.commandHandler.processCommand(bot, msg2, "removebg", [], null);

		const reply2 = bot.capturedMessages[0];
		assert(reply2, "Deveria ter capturado uma resposta do bot");
		console.log("Resposta capturada:", reply2.content);
		assert.strictEqual(
			reply2.content,
			"Problema removendo fundo da imagem: Nenhum servidor de *rembg* retornou a imagem recortada",
			"Deve retornar a mensagem exata informando que nenhum servidor retornou a imagem recortada"
		);
		console.log("✅ TESTE 2 APROVADO: Resposta correta quando todos os provedores falham.");

		// ====================================================================
		// TESTE 3: Fallback transparente (1º offline -> 2º Hyperion online)
		// ====================================================================
		console.log("\n[TESTE 3] Executando fallback: 1º offline -> 2º Hyperion (online)...");
		serviceProviderService.config.rembg = [
			{
				name: "offline-primary",
				url: "http://127.0.0.1:59999",
				timeout: 2000,
				enabled: true
			},
			{
				name: "hyperion",
				url: "http://192.168.195.212:7000",
				timeout: 30000,
				enabled: true
			}
		];
		bot.resetCapture();

		const msg3 = createMessage({
			content: media,
			caption: "!removebg",
			type: "image",
			group: testGroup,
			author: "5511999999999@s.whatsapp.net"
		});

		await eventHandler.commandHandler.processCommand(bot, msg3, "removebg", [], null);

		const reply3 = bot.capturedMessages[0];
		assert(reply3, "Deveria ter capturado uma resposta com a mídia processada");
		assert(reply3.options?.sendMediaAsDocument, "Deveria enviar como documento");
		assert.strictEqual(
			reply3.options?.caption,
			"Fundo removido e salvo como arquivo",
			"Legenda deve indicar sucesso"
		);
		console.log("✅ TESTE 3 APROVADO: Fallback executado com sucesso e imagem retornada!");

		// ====================================================================
		// TESTE 4: Comando !stickerbg com provedores ausentes
		// ====================================================================
		console.log("\n[TESTE 4] Executando !stickerbg sem provedores...");
		serviceProviderService.config.rembg = [];
		bot.resetCapture();

		const msg4 = createMessage({
			content: media,
			caption: "!stickerbg",
			type: "image",
			group: testGroup,
			author: "5511999999999@s.whatsapp.net"
		});

		await eventHandler.commandHandler.processCommand(bot, msg4, "stickerbg", [], null);

		const reply4 = bot.capturedMessages[0];
		assert(reply4, "Deveria ter capturado uma resposta do bot");
		assert.strictEqual(
			reply4.content,
			"Problema removendo fundo da imagem: Nenhum serviço de rembg rodando",
			"Stickerbg também deve retornar a mensagem específica de erro"
		);
		console.log("✅ TESTE 4 APROVADO: !stickerbg validado com sucesso.");

		console.log("\n🎉 TODOS OS TESTES DE REMBG PASSARAM COM SUCESSO!");
	} finally {
		// Restaura a configuração
		if (originalRembg) {
			serviceProviderService.config.rembg = originalRembg;
		}
	}
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ ERRO NA EXECUÇÃO DOS TESTES:", err);
		process.exit(1);
	});
