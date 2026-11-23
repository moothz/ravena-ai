process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const axios = require("axios");
const LLMService = require("../services/LLMService");

async function runTests() {
	console.log("=== Iniciando testes de limitação de imagens e frames de visão no LLMService ===");

	const llmService = LLMService.getInstance();

	// --------------------------------------------------------------------------
	// 1. Teste direto do método utilitário _sampleImages
	// --------------------------------------------------------------------------
	console.log("\n[1] Testando método _sampleImages...");

	// Array com tamanho menor que maxCount
	const threeImages = ["img1", "img2", "img3"];
	const resSmall = llmService._sampleImages(threeImages, 4);
	assert.strictEqual(resSmall.length, 3, "Deve retornar todas as 3 imagens quando maxCount=4");
	assert.deepStrictEqual(resSmall, threeImages);

	// Array com exatamente 4 imagens
	const fourImages = ["img1", "img2", "img3", "img4"];
	const resExact = llmService._sampleImages(fourImages, 4);
	assert.strictEqual(resExact.length, 4, "Deve retornar as 4 imagens");
	assert.deepStrictEqual(resExact, fourImages);

	// Array com 12 imagens (antigo valor de SummaryCommands)
	const twelveImages = Array.from({ length: 12 }, (_, i) => `frame_${i}`);
	const resTwelve = llmService._sampleImages(twelveImages, 4);
	assert.strictEqual(resTwelve.length, 4, "Deve reduzir 12 imagens para 4");
	assert.strictEqual(resTwelve[0], "frame_0", "Primeiro frame deve ser o inicial");
	assert.strictEqual(resTwelve[3], "frame_11", "Último frame deve ser o final");
	console.log("    Frames amostrados de 12:", resTwelve);

	// Array com 75 imagens (antigo valor de AICommands)
	const seventyFiveImages = Array.from({ length: 75 }, (_, i) => `frame_${i}`);
	const resSeventyFive = llmService._sampleImages(seventyFiveImages, 4);
	assert.strictEqual(resSeventyFive.length, 4, "Deve reduzir 75 imagens para 4");
	assert.strictEqual(resSeventyFive[0], "frame_0", "Primeiro frame deve ser o inicial");
	assert.strictEqual(resSeventyFive[3], "frame_74", "Último frame deve ser o final");
	console.log("    Frames amostrados de 75:", resSeventyFive);

	// maxCount = 1
	const resSingle = llmService._sampleImages(twelveImages, 1);
	assert.strictEqual(resSingle.length, 1);
	assert.strictEqual(resSingle[0], "frame_0");

	// maxCount = 2
	const resTwo = llmService._sampleImages(twelveImages, 2);
	assert.strictEqual(resTwo.length, 2);
	assert.strictEqual(resTwo[0], "frame_0");
	assert.strictEqual(resTwo[1], "frame_11");

	console.log("✓ _sampleImages distribuiu frames uniformemente e respeitou limites");

	// --------------------------------------------------------------------------
	// 2. Teste de openaiCompletion com interceptação do payload
	// --------------------------------------------------------------------------
	console.log("\n[2] Testando openaiCompletion com amostragem e teto de imagens...");

	const originalAxiosPost = axios.post;
	let capturedPayload = null;

	axios.post = async (url, data, config) => {
		capturedPayload = data;
		return {
			data: {
				choices: [{ message: { content: "Análise visual simulada com sucesso" } }],
				usage: { prompt_tokens: 150, completion_tokens: 20 }
			}
		};
	};

	try {
		// Cenário A: Envio de 12 imagens sem especificar maxImages (deve limitar a 4)
		await llmService.openaiCompletion({
			apiKey: "fake_test_key",
			prompt: "Descreva o vídeo",
			images: twelveImages,
			customEndpoint: "https://mock.api/v1"
		});

		assert(capturedPayload, "Deveria ter enviado payload via axios");
		const userMsgA = capturedPayload.messages.find((m) => m.role === "user");
		assert(Array.isArray(userMsgA.content), "user message content deve ser array para vision");

		const imageItemsA = userMsgA.content.filter((item) => item.type === "image_url");
		assert.strictEqual(imageItemsA.length, 4, "openaiCompletion deve enviar no máximo 4 imagens");
		assert.strictEqual(imageItemsA[0].image_url.url, "data:image/jpeg;base64,frame_0");
		assert.strictEqual(imageItemsA[3].image_url.url, "data:image/jpeg;base64,frame_11");
		console.log(`    ✓ Cenário A: 12 imagens reduzidas para ${imageItemsA.length} image_url items`);

		// Cenário B: Envio com ignoreVideo: true
		capturedPayload = null;
		await llmService.openaiCompletion({
			apiKey: "fake_test_key",
			prompt: "Descreva o vídeo",
			images: twelveImages,
			ignoreVideo: true,
			customEndpoint: "https://mock.api/v1"
		});

		const userMsgB = capturedPayload.messages.find((m) => m.role === "user");
		const imageItemsB = userMsgB.content.filter((item) => item.type === "image_url");
		assert.strictEqual(
			imageItemsB.length,
			1,
			"Com ignoreVideo=true deve enviar exatamente 1 imagem"
		);
		assert.strictEqual(imageItemsB[0].image_url.url, "data:image/jpeg;base64,frame_0");
		console.log(`    ✓ Cenário B: ignoreVideo resultou em ${imageItemsB.length} imagem`);

		// Cenário C: Envio com maxImages explicitamente definido como 2
		capturedPayload = null;
		await llmService.openaiCompletion({
			apiKey: "fake_test_key",
			prompt: "Descreva o vídeo",
			images: twelveImages,
			maxImages: 2,
			customEndpoint: "https://mock.api/v1"
		});

		const userMsgC = capturedPayload.messages.find((m) => m.role === "user");
		const imageItemsC = userMsgC.content.filter((item) => item.type === "image_url");
		assert.strictEqual(imageItemsC.length, 2, "Com maxImages=2 deve enviar exatamente 2 imagens");
		console.log(`    ✓ Cenário C: maxImages=2 resultou em ${imageItemsC.length} imagens`);

		// Cenário D: openrouterCompletion (usado para Hyperion vLLM customEndpoint)
		capturedPayload = null;
		await llmService.openrouterCompletion({
			apiKey: "fake_test_key",
			prompt: "Descreva o vídeo vLLM",
			images: seventyFiveImages,
			customEndpoint: "https://ai.moothz.com/vllm/v1"
		});

		const userMsgD = capturedPayload.messages.find((m) => m.role === "user");
		const imageItemsD = userMsgD.content.filter((item) => item.type === "image_url");
		assert.strictEqual(
			imageItemsD.length,
			4,
			"openrouterCompletion deve enviar no máximo 4 imagens"
		);
		assert.strictEqual(imageItemsD[0].image_url.url, "data:image/jpeg;base64,frame_0");
		assert.strictEqual(imageItemsD[3].image_url.url, "data:image/jpeg;base64,frame_74");
		console.log(
			`    ✓ Cenário D: 75 imagens reduzidas para ${imageItemsD.length} image_url items em openrouterCompletion`
		);
	} finally {
		axios.post = originalAxiosPost;
	}

	console.log("\n=== Todos os testes de limitação de visão passaram com sucesso! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("\n❌ Falha nos testes de visão:", err);
		process.exit(1);
	});
