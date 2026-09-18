const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const NSFWPredict = require("../utils/NSFWPredict");
const { createMessage } = require("./FakeMessage");

async function runTests() {
	console.log("=== Testando Verificação via LLM para Stickers com FEMALE_BREAST_EXPOSED ===");

	const nsfwPredict = NSFWPredict.getInstance();

	// 1. Testa detectNSFW quando NudeNet classifica sticker como FEMALE_BREAST_EXPOSED e LLM descarta falso positivo (seguro)
	console.log("\n1. Testando sticker marcado com FEMALE_BREAST_EXPOSED descartado pelo LLM...");
	{
		// Mock do executeNudeNetWithRetry ou detectNSFWWithNudeNet
		const originalExecute = nsfwPredict._executeNudeNetWithRetry;
		const originalLLM = nsfwPredict.detectNSFWWithLLM;
		const originalIsAvailable = nsfwPredict.isAvailable;
		const originalGetAvailable = nsfwPredict.getAvailableProviders;

		nsfwPredict.isAvailable = () => true;
		nsfwPredict.getAvailableProviders = () => [{ name: "mock-nudenet", url: "http://mock" }];

		let llmCalled = false;
		nsfwPredict._executeNudeNetWithRetry = async () => ({
			isNSFW: true,
			reason: "FEMALE_BREAST_EXPOSED (89%)",
			detections: [{ label: "FEMALE_BREAST_EXPOSED", confidence: 0.89 }]
		});

		nsfwPredict.detectNSFWWithLLM = async () => {
			llmCalled = true;
			return {
				isNSFW: false,
				reason: "Ilustração cartoon com olhos grandes, sem nudez"
			};
		};

		const result = await nsfwPredict.detectNSFW("dummy_base64", {
			isSticker: true,
			groupName: "TestGroup"
		});

		assert.strictEqual(
			llmCalled,
			true,
			"LLM deve ter sido chamado para o sticker com FEMALE_BREAST_EXPOSED"
		);
		assert.strictEqual(result.isNSFW, false, "Resultado final deve ser seguro (isNSFW: false)");
		assert(
			result.reason.includes("Falso positivo"),
			"Motivo deve mencionar descarte de falso positivo"
		);

		// Restaura métodos
		nsfwPredict._executeNudeNetWithRetry = originalExecute;
		nsfwPredict.detectNSFWWithLLM = originalLLM;
		nsfwPredict.isAvailable = originalIsAvailable;
		nsfwPredict.getAvailableProviders = originalGetAvailable;
		console.log("✓ Falso positivo descartado pelo LLM com sucesso!");
	}

	// 2. Testa detectNSFW quando NudeNet classifica sticker como FEMALE_BREAST_EXPOSED e LLM confirma que é NSFW
	console.log(
		"\n2. Testando sticker marcado com FEMALE_BREAST_EXPOSED confirmado como NSFW pelo LLM..."
	);
	{
		const originalExecute = nsfwPredict._executeNudeNetWithRetry;
		const originalLLM = nsfwPredict.detectNSFWWithLLM;
		const originalIsAvailable = nsfwPredict.isAvailable;
		const originalGetAvailable = nsfwPredict.getAvailableProviders;

		nsfwPredict.isAvailable = () => true;
		nsfwPredict.getAvailableProviders = () => [{ name: "mock-nudenet", url: "http://mock" }];

		let llmCalled = false;
		nsfwPredict._executeNudeNetWithRetry = async () => ({
			isNSFW: true,
			reason: "FEMALE_BREAST_EXPOSED (95%)",
			detections: [{ label: "FEMALE_BREAST_EXPOSED", confidence: 0.95 }]
		});

		nsfwPredict.detectNSFWWithLLM = async () => {
			llmCalled = true;
			return {
				isNSFW: true,
				reason: "Conteúdo adulto explícito"
			};
		};

		const result = await nsfwPredict.detectNSFW("dummy_base64", {
			isSticker: true,
			groupName: "TestGroup"
		});

		assert.strictEqual(llmCalled, true, "LLM deve ter sido chamado");
		assert.strictEqual(result.isNSFW, true, "Resultado final deve ser NSFW (isNSFW: true)");
		assert.strictEqual(result.reason, "Conteúdo adulto explícito");

		nsfwPredict._executeNudeNetWithRetry = originalExecute;
		nsfwPredict.detectNSFWWithLLM = originalLLM;
		nsfwPredict.isAvailable = originalIsAvailable;
		nsfwPredict.getAvailableProviders = originalGetAvailable;
		console.log("✓ NSFW confirmado pelo LLM com sucesso!");
	}

	// 3. Testa quando NÃO é sticker: LLM não deve ser chamado mesmo se FEMALE_BREAST_EXPOSED
	console.log("\n3. Testando imagem normal com FEMALE_BREAST_EXPOSED (não deve chamar LLM)...");
	{
		const originalExecute = nsfwPredict._executeNudeNetWithRetry;
		const originalLLM = nsfwPredict.detectNSFWWithLLM;
		const originalIsAvailable = nsfwPredict.isAvailable;
		const originalGetAvailable = nsfwPredict.getAvailableProviders;

		nsfwPredict.isAvailable = () => true;
		nsfwPredict.getAvailableProviders = () => [{ name: "mock-nudenet", url: "http://mock" }];

		let llmCalled = false;
		nsfwPredict._executeNudeNetWithRetry = async () => ({
			isNSFW: true,
			reason: "FEMALE_BREAST_EXPOSED (95%)",
			detections: [{ label: "FEMALE_BREAST_EXPOSED", confidence: 0.95 }]
		});

		nsfwPredict.detectNSFWWithLLM = async () => {
			llmCalled = true;
			return { isNSFW: false, reason: "" };
		};

		const result = await nsfwPredict.detectNSFW("dummy_base64", {
			isSticker: false,
			groupName: "TestGroup"
		});

		assert.strictEqual(llmCalled, false, "LLM NÃO deve ser chamado para imagem normal");
		assert.strictEqual(result.isNSFW, true, "Resultado deve ser NSFW diretamente do NudeNet");

		nsfwPredict._executeNudeNetWithRetry = originalExecute;
		nsfwPredict.detectNSFWWithLLM = originalLLM;
		nsfwPredict.isAvailable = originalIsAvailable;
		nsfwPredict.getAvailableProviders = originalGetAvailable;
		console.log("✓ Imagem normal com FEMALE_BREAST_EXPOSED tratada diretamente pelo NudeNet!");
	}

	// 4. Testa quando é sticker mas a classificação é diferente (ex: FEMALE_GENITALIA_EXPOSED)
	console.log("\n4. Testando sticker com outra classificação (não FEMALE_BREAST_EXPOSED)...");
	{
		const originalExecute = nsfwPredict._executeNudeNetWithRetry;
		const originalLLM = nsfwPredict.detectNSFWWithLLM;
		const originalIsAvailable = nsfwPredict.isAvailable;
		const originalGetAvailable = nsfwPredict.getAvailableProviders;

		nsfwPredict.isAvailable = () => true;
		nsfwPredict.getAvailableProviders = () => [{ name: "mock-nudenet", url: "http://mock" }];

		let llmCalled = false;
		nsfwPredict._executeNudeNetWithRetry = async () => ({
			isNSFW: true,
			reason: "FEMALE_GENITALIA_EXPOSED (90%)",
			detections: [{ label: "FEMALE_GENITALIA_EXPOSED", confidence: 0.9 }]
		});

		nsfwPredict.detectNSFWWithLLM = async () => {
			llmCalled = true;
			return { isNSFW: false, reason: "" };
		};

		const result = await nsfwPredict.detectNSFW("dummy_base64", {
			isSticker: true,
			groupName: "TestGroup"
		});

		assert.strictEqual(
			llmCalled,
			false,
			"LLM NÃO deve ser chamado se não for FEMALE_BREAST_EXPOSED"
		);
		assert.strictEqual(result.isNSFW, true, "Resultado deve permanecer NSFW");

		nsfwPredict._executeNudeNetWithRetry = originalExecute;
		nsfwPredict.detectNSFWWithLLM = originalLLM;
		nsfwPredict.isAvailable = originalIsAvailable;
		nsfwPredict.getAvailableProviders = originalGetAvailable;
		console.log("✓ Sticker com outra classificação mantido sem chamada desnecessária ao LLM!");
	}

	// 5. Integração com EventHandler.checkNSFW: Sticker com falso positivo não deve ser deletado
	console.log(
		"\n5. Testando integração completa no EventHandler (mensagem não deve ser deletada)..."
	);
	{
		const eventHandler = new EventHandler();
		const bot = new FakeBot({ id: "test-bot" });

		const groupComFiltro = {
			id: "123456@g.us",
			name: "Grupo Filtro NSFW",
			filters: { nsfw: true }
		};

		let messageDeleted = false;
		const msgSticker = createMessage({
			type: "sticker",
			group: "123456@g.us",
			author: "5511999999999@s.whatsapp.net",
			content: {
				mimetype: "image/webp",
				data: "dummy_sticker_base64"
			}
		});
		msgSticker.origin.delete = async () => {
			messageDeleted = true;
			return { success: true };
		};

		// Mock do nsfwPredict no eventHandler
		eventHandler.nsfwPredict.isAvailable = () => true;
		eventHandler.nsfwPredict.getAvailableProviders = () => [
			{ name: "mock-nudenet", url: "http://mock" }
		];
		eventHandler.nsfwPredict._executeNudeNetWithRetry = async () => ({
			isNSFW: true,
			reason: "FEMALE_BREAST_EXPOSED (88%)",
			detections: [{ label: "FEMALE_BREAST_EXPOSED", confidence: 0.88 }]
		});
		eventHandler.nsfwPredict.detectNSFWWithLLM = async () => ({
			isNSFW: false,
			reason: "Personagem chibi com olhos expressivos grandes"
		});

		const filtered = await eventHandler.checkNSFW(bot, msgSticker, groupComFiltro);
		assert.strictEqual(
			filtered,
			false,
			"checkNSFW deve retornar false quando LLM descarta falso positivo"
		);
		assert.strictEqual(messageDeleted, false, "Mensagem do sticker NÃO deve ser deletada");
		console.log(
			"✓ Integração no EventHandler validada: sticker falso positivo preservado com sucesso!"
		);
	}

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("Falha no teste:", err);
	process.exit(1);
});
