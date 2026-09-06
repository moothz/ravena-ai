const assert = require("assert");
const ProfilePictureHelper = require("../utils/ProfilePictureHelper");
const LLMService = require("../services/LLMService");
const bonsaiModule = require("../functions/BonsaiCommands");
const { generateRareFishImage } = require("../functions/FishingGame");

async function runTests() {
	console.log("--- Iniciando testes de descrição física em generateRareFishImage ---");

	const fakeBot = {
		id: "teste-bot"
	};
	const fakeUser = "5511999999999@s.whatsapp.net";
	const fakeMessage = {
		author: fakeUser,
		authorName: "PescadorLenda"
	};

	let capturedPrompt = null;
	// Mock bonsaiModule.generateImage para capturar o prompt gerado
	const originalGenerateImage = bonsaiModule.generateImage;
	bonsaiModule.generateImage = async (bot, msg, prompt, opts, b, extra) => {
		capturedPrompt = prompt;
		return {
			content: {
				mimetype: "image/jpeg",
				data: "fake-image-base64"
			}
		};
	};

	const originalFetchPfp = ProfilePictureHelper.fetchUserProfilePictureMedia;
	const originalGetCompletion = LLMService.prototype.getCompletion;

	try {
		// Teste 1: Avatar disponível e LLM responde com descrição física
		ProfilePictureHelper.fetchUserProfilePictureMedia = async (bot, jid) => {
			assert.strictEqual(jid, fakeUser);
			return {
				url: "https://example.com/pfp.jpg",
				mimetype: "image/jpeg",
				data: "fake-base64-avatar"
			};
		};

		let llmPromptCaptured = null;
		let llmImageCaptured = null;
		LLMService.prototype.getCompletion = async function (opts) {
			llmPromptCaptured = opts.prompt;
			llmImageCaptured = opts.image;
			return "Jovem pescador de pele morena, cabelo cacheado escuro, usando jaqueta jeans azul.";
		};

		await generateRareFishImage(
			fakeBot,
			"PescadorLenda",
			"Cthulhu",
			26665,
			"cosmic horror tentacles",
			fakeUser,
			fakeMessage
		);

		assert.ok(capturedPrompt, "Prompt deveria ter sido gerado");
		assert.strictEqual(llmImageCaptured, "fake-base64-avatar", "LLM deve receber a foto em base64");
		assert.ok(
			capturedPrompt.includes(
				"Descrição Física do Pescador: Jovem pescador de pele morena, cabelo cacheado escuro, usando jaqueta jeans azul."
			),
			"Prompt deve incluir a 'Descrição Física do Pescador: {respostaLLM}'"
		);
		console.log("✓ Teste 1 passou: Descrição do avatar pela LLM incluída no prompt com sucesso.");

		// Teste 2: Avatar NÃO disponível (retorna null)
		capturedPrompt = null;
		ProfilePictureHelper.fetchUserProfilePictureMedia = async () => null;

		await generateRareFishImage(
			fakeBot,
			"PescadorLenda",
			"Cthulhu",
			26665,
			"cosmic horror tentacles",
			fakeUser,
			fakeMessage
		);

		assert.ok(capturedPrompt, "Prompt deveria ter sido gerado");
		assert.strictEqual(
			capturedPrompt.includes("Descrição Física do Pescador:"),
			false,
			"Sem avatar, prompt NÃO deve conter Descrição Física do Pescador"
		);
		assert.ok(
			capturedPrompt.includes(
				"Person named 'PescadorLenda' fishing an epically rare monstrous creature (fantasy) fish known as \"Cthulhu\", cosmic horror tentacles"
			),
			"Sem avatar, deve usar a descrição padrão apenas com o nome"
		);
		console.log("✓ Teste 2 passou: Fallback padrão quando não há foto de perfil.");

		// Teste 3: Avatar disponível mas LLM falha/retorna erro
		capturedPrompt = null;
		ProfilePictureHelper.fetchUserProfilePictureMedia = async () => ({
			url: "https://example.com/pfp.jpg",
			mimetype: "image/jpeg",
			data: "fake-base64-avatar"
		});
		LLMService.prototype.getCompletion = async () => {
			throw new Error("LLM Timeout or failure");
		};

		await generateRareFishImage(
			fakeBot,
			"PescadorLenda",
			"Cthulhu",
			26665,
			"cosmic horror tentacles",
			fakeUser,
			fakeMessage
		);

		assert.ok(capturedPrompt, "Prompt deveria ter sido gerado mesmo com erro no LLM");
		assert.strictEqual(
			capturedPrompt.includes("Descrição Física do Pescador:"),
			false,
			"Com falha no LLM, prompt NÃO deve conter Descrição Física do Pescador"
		);
		assert.ok(
			capturedPrompt.includes(
				"Person named 'PescadorLenda' fishing an epically rare monstrous creature (fantasy) fish known as \"Cthulhu\", cosmic horror tentacles"
			),
			"Com falha no LLM, deve usar a descrição padrão apenas com o nome"
		);
		console.log("✓ Teste 3 passou: Fallback padrão quando o LLM falha.");

		console.log("--- Todos os testes de generateRareFishImage passaram! ---");
		process.exit(0);
	} finally {
		bonsaiModule.generateImage = originalGenerateImage;
		ProfilePictureHelper.fetchUserProfilePictureMedia = originalFetchPfp;
		LLMService.prototype.getCompletion = originalGetCompletion;
	}
}

runTests().catch((err) => {
	console.error("Erro no teste:", err);
	process.exit(1);
});
