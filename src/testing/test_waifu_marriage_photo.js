process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const { createMessage } = require("./FakeMessage");
const LLMService = require("../services/LLMService");
const ProfilePictureHelper = require("../utils/ProfilePictureHelper");
const bonsaiModule = require("../functions/BonsaiCommands");
const waifuHelper = require("../utils/WaifuMarriagePhotoHelper");
const waifuModule = require("../functions/WaifuCommands");

async function main() {
	console.log("=== Iniciando Suíte de Testes: Foto de Casamento com BonsaiAPI ===");

	const bot = new FakeBot({ id: "teste-bot" });
	const eventHandler = new EventHandler();

	const testUser = "5511999990001@s.whatsapp.net";
	const otherUser = "5511999990002@s.whatsapp.net";
	const testGroup = "123456789-group@g.us";

	// Cria uma imagem simulada para testes do sharp
	const dummyImageBuffer = await sharp({
		create: {
			width: 1024,
			height: 1024,
			channels: 3,
			background: { r: 120, g: 180, b: 240 }
		}
	})
		.jpeg()
		.toBuffer();
	const dummyBase64 = dummyImageBuffer.toString("base64");

	// ─── TESTE 1: buildMarriagePrompt e Modificadores de Raridade ───────────
	console.log("\n[Teste 1] Validando regras de raridade em buildMarriagePrompt...");
	const charUncommon = { name: "Megumin", series: "Konosuba", baseRarity: "UNCOMMON" };
	const pUncommon = waifuHelper.buildMarriagePrompt(charUncommon, "brunette girl with staff", null);
	assert.ok(pUncommon.includes("Megumin"), "Prompt deve conter o nome do personagem");
	assert.ok(!pUncommon.includes("fireworks"), "Uncommon não deve conter fireworks");
	assert.ok(!pUncommon.includes("sunset"), "Uncommon não deve conter sunset");
	assert.ok(pUncommon.includes("no text"), "Prompt deve conter restrição de sem texto");

	const charCommon = { name: "Aqua", series: "Konosuba", baseRarity: "COMMON" };
	const pCommon = waifuHelper.buildMarriagePrompt(charCommon, "blue haired goddess", null);
	assert.ok(pCommon.toLowerCase().includes("smiles"), "Common deve incluir sorrisos");

	const charRare = { name: "Frieren", series: "Sousou no Frieren", baseRarity: "RARE" };
	const pRare = waifuHelper.buildMarriagePrompt(charRare, "white hair elf", null);
	assert.ok(pRare.toLowerCase().includes("sunset"), "Rare deve incluir entardecer lindo (sunset)");

	const charEpic = { name: "Fern", series: "Sousou no Frieren", baseRarity: "EPIC" };
	const pEpic = waifuHelper.buildMarriagePrompt(charEpic, "purple haired mage", null);
	assert.ok(pEpic.toLowerCase().includes("petals"), "Epic deve incluir pétalas ao vento");

	const charLegendary = { name: "Saber", series: "Fate", baseRarity: "LEGENDARY" };
	const pLegendary = waifuHelper.buildMarriagePrompt(
		charLegendary,
		"blonde knight in armor",
		"tall man with glasses"
	);
	assert.ok(pLegendary.toLowerCase().includes("glow"), "Legendary deve incluir glow");
	assert.ok(
		pLegendary.toLowerCase().includes("golden"),
		"Legendary deve incluir golden highlights"
	);
	assert.ok(pLegendary.toLowerCase().includes("fireworks"), "Legendary deve incluir fireworks");
	assert.ok(pLegendary.includes("tall man with glasses"), "Deve incluir descrição do autor");
	console.log("✓ Teste 1 passou: Todos os modificadores de raridade verificados.");

	// ─── TESTE 2: Composição da borda marriage_border.png ───────────────────
	console.log("\n[Teste 2] Validando composição da moldura (sharp)...");
	const framedBuffer = await waifuHelper.compositeMarriageBorder(dummyImageBuffer);
	assert.ok(Buffer.isBuffer(framedBuffer), "Resultado deve ser um Buffer");
	assert.ok(framedBuffer.length > 1000, "Buffer resultante deve ser válido");
	const metaFramed = await sharp(framedBuffer).metadata();
	assert.strictEqual(metaFramed.format, "jpeg", "Formato final deve ser JPEG");
	console.log("✓ Teste 2 passou: Borda aplicada com sucesso sobre a imagem.");

	// ─── TESTE 3: Fallbacks de descrição da Waifu e do Autor ────────────────
	console.log("\n[Teste 3] Validando fallbacks de LLM e fotos de perfil...");
	// 3.1: Personagem sem foto
	const charSemFoto = { id: "sem-foto", name: "Fantasma", imageUrl: null };
	const resSemFoto = await waifuHelper.describeCharacter(charSemFoto);
	assert.strictEqual(resSemFoto.success, false);
	assert.strictEqual(resSemFoto.fallback, "text", "Sem foto deve dar fallback para texto");

	// 3.2: LLM falha ao descrever personagem -> fallback para original_image
	const origGetCompletion = LLMService.prototype.getCompletion;
	const origDownloadChar = waifuHelper.downloadCharacterImageBuffer;

	waifuHelper.downloadCharacterImageBuffer = async () => dummyImageBuffer;
	LLMService.prototype.getCompletion = async () => {
		throw new Error("Simulated LLM Timeout Error");
	};

	const charComFoto = {
		id: "com-foto",
		name: "Personagem",
		imageUrl: "http://example.com/pic.jpg"
	};
	const resLLMFalha = await waifuHelper.describeCharacter(charComFoto);
	assert.strictEqual(resLLMFalha.success, false);
	assert.strictEqual(
		resLLMFalha.fallback,
		"original_image",
		"Falha de LLM na waifu deve retornar fallback original_image"
	);
	assert.ok(resLLMFalha.originalBase64, "Deve fornecer a imagem original em base64");

	// 3.3: LLM sucesso na waifu, sem avatar do autor
	LLMService.prototype.getCompletion = async () => "Anime girl with green hair and ribbon";
	const origFetchPfp = ProfilePictureHelper.fetchUserProfilePictureMedia;
	ProfilePictureHelper.fetchUserProfilePictureMedia = async () => null;

	const userDescNull = await waifuHelper.describeUser(bot, testUser, null);
	assert.strictEqual(userDescNull, null, "Sem avatar deve retornar null");
	console.log("✓ Teste 3 passou: Fallbacks de LLM e avatar validados.");

	// ─── TESTE 4: Fluxo completo de generateAndSaveMarriageImage ─────────────
	console.log("\n[Teste 4] Validando generateAndSaveMarriageImage com Bonsai mock...");
	const origBonsaiGen = bonsaiModule.generateImage;
	let capturedBonsaiPrompt = null;
	bonsaiModule.generateImage = async (b, msg, prompt) => {
		capturedBonsaiPrompt = prompt;
		return {
			content: {
				mimetype: "image/jpeg",
				data: dummyBase64
			}
		};
	};

	const charCasamento = {
		id: "rem-re-zero",
		name: "Rem",
		series: "Re:Zero",
		baseRarity: "RARE",
		imageUrl: "http://example.com/rem.jpg"
	};

	const genRes = await waifuHelper.generateAndSaveMarriageImage(
		bot,
		{ author: testUser },
		charCasamento,
		testUser,
		"Tester"
	);
	assert.strictEqual(genRes.success, true, "Geração deve ter sucesso");
	assert.ok(capturedBonsaiPrompt, "Prompt deve ter sido repassado ao Bonsai");
	assert.ok(capturedBonsaiPrompt.includes("Rem"), "Prompt deve conter o nome do personagem");
	assert.ok(genRes.photoPath, "Deve retornar caminho da foto salva");
	assert.ok(fs.existsSync(genRes.photoPath), "Arquivo deve existir em disco");

	// Valida persistência no SQLite
	const photoCheck = await waifuHelper.getMarriagePhoto("rem-re-zero");
	assert.strictEqual(photoCheck.exists, true, "Foto deve constar no SQLite e disco");
	assert.strictEqual(photoCheck.record.character_id, "rem-re-zero");
	console.log("✓ Teste 4 passou: Geração, arquivo em disco e registro SQLite validados.");

	// ─── TESTE 5: Integração do casamento (!mu-casar) com foto ─────────────
	console.log("\n[Teste 5] Validando !mu-casar com entrega de imagem...");
	// Mock da API Waifuletes para /marry
	const origApiPost = waifuModule.api.post;
	waifuModule.api.post = async (url, payload) => {
		if (url === "/marry") {
			return {
				data: {
					data: {
						character: charCasamento,
						keys: 1,
						isSoulmate: false,
						kakeraBalance: 500
					}
				}
			};
		}
		if (url === "/divorce") {
			return {
				data: {
					data: {
						character: charCasamento,
						refundedKakera: 100,
						keysLost: 1,
						newKakeraBalance: 600
					}
				}
			};
		}
		return origApiPost.apply(waifuModule.api, [url, payload]);
	};

	async function waitForReply(maxMs = 15000) {
		const start = Date.now();
		while (Date.now() - start < maxMs) {
			if (bot.capturedMessages.length > 0) return bot.capturedMessages;
			await new Promise((r) => setTimeout(r, 100));
		}
		return bot.capturedMessages;
	}

	bot.resetCapture();
	eventHandler.commandHandler.userDebounceMap.clear();

	const msgCasar = createMessage({
		content: "!mu-casar rem-re-zero",
		author: testUser,
		authorName: "Tester",
		group: testGroup
	});

	await eventHandler.processMessage(bot, msgCasar);
	await waitForReply();
	assert.ok(bot.capturedMessages.length > 0, "Deveria responder ao comando !mu-casar");
	const casarReply = bot.capturedMessages[0];
	const casarCaption = casarReply.options?.caption || casarReply.caption || "";
	assert.ok(casarCaption, "Mensagem deve conter caption com texto do casamento");
	assert.ok(casarCaption.includes("Você se casou com *Rem*!"), "Legenda deve parabenizar o casal");
	assert.ok(casarReply.content, "Mensagem deve conter mídia anexada");
	console.log("✓ Teste 5 passou: !mu-casar entregou foto oficial com legenda.");

	// ─── TESTE 6: Comando !mu-foto (Consulta e Casamentos Passados) ──────────
	console.log("\n[Teste 6] Validando comando !mu-foto...");
	const origApiGet = waifuModule.api.get;
	waifuModule.api.get = async (url, config) => {
		if (url.includes("/characters/rem-re-zero") || url.includes("/characters?")) {
			return {
				data: {
					data: {
						...charCasamento,
						isClaimed: true,
						owner: {
							id: "5511999990001",
							name: "Tester"
						}
					}
				}
			};
		}
		return origApiGet.apply(waifuModule.api, [url, config]);
	};

	// 6.1: Consulta normal da foto salva
	bot.resetCapture();
	eventHandler.commandHandler.userDebounceMap.clear();
	const msgFotoConsulta = createMessage({
		content: "!mu-foto rem-re-zero",
		author: testUser,
		authorName: "Tester",
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgFotoConsulta);
	await waitForReply();
	assert.ok(bot.capturedMessages.length > 0, "Deveria responder ao !mu-foto");
	const fotoReply = bot.capturedMessages[0];
	const fotoCaption = fotoReply.options?.caption || fotoReply.caption || "";
	assert.ok(fotoCaption.includes("Álbum de Casamento"), "Deve indicar álbum de casamento");
	assert.ok(fotoCaption.includes("Rem"), "Deve conter nome da noiva");

	// 6.2: Bloqueio para usuário não cônjuge ao tentar !mu-foto nova
	bot.resetCapture();
	eventHandler.commandHandler.userDebounceMap.clear();
	const msgFotoNovaNaoDono = createMessage({
		content: "!mu-foto nova rem-re-zero",
		author: otherUser,
		authorName: "Intruso",
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgFotoNovaNaoDono);
	await waitForReply();
	assert.ok(bot.capturedMessages.length > 0, "Deveria responder ao intruso");
	assert.ok(
		bot.capturedMessages[0].content.includes("Apenas o cônjuge"),
		"Deve bloquear usuário não cônjuge de gerar foto nova"
	);

	// 6.3: Cônjuge chamando !mu-foto nova (gera e substitui)
	bot.resetCapture();
	eventHandler.commandHandler.userDebounceMap.clear();
	const msgFotoNovaDono = createMessage({
		content: "!mu-foto nova rem-re-zero",
		author: testUser,
		authorName: "Tester",
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgFotoNovaDono);
	await waitForReply();
	assert.ok(bot.capturedMessages.length > 0, "Deveria responder à geração de nova foto");
	const novaFotoCaption =
		bot.capturedMessages[0].options?.caption || bot.capturedMessages[0].caption || "";
	assert.ok(
		novaFotoCaption.includes("Nova Foto de Casamento!"),
		"Deve confirmar atualização de nova foto"
	);

	// 6.4: Casamento passado sem foto gerada ainda
	await waifuHelper.removeMarriagePhoto("rem-re-zero");
	const checkVazio = await waifuHelper.getMarriagePhoto("rem-re-zero");
	assert.strictEqual(checkVazio.exists, false, "Foto deve ter sido removida temporariamente");

	// Outro usuário tenta consultar casamento passado sem foto
	bot.resetCapture();
	eventHandler.commandHandler.userDebounceMap.clear();
	const msgPassadoOutro = createMessage({
		content: "!mu-foto rem-re-zero",
		author: otherUser,
		authorName: "Outro",
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgPassadoOutro);
	await waitForReply();
	assert.ok(
		bot.capturedMessages[0].content.includes("ainda não possui uma foto oficial"),
		"Deve avisar que casamento passado ainda não tem foto"
	);

	// O cônjuge consulta casamento passado sem foto: deve gerar na hora!
	bot.resetCapture();
	eventHandler.commandHandler.userDebounceMap.clear();
	const msgPassadoDono = createMessage({
		content: "!mu-foto rem-re-zero",
		author: testUser,
		authorName: "Tester",
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgPassadoDono);
	await waitForReply();
	const passadoCaption =
		bot.capturedMessages[0].options?.caption || bot.capturedMessages[0].caption || "";
	assert.ok(
		passadoCaption.includes("Foto de Casamento Registrada!"),
		"Cônjuge deve gerar a foto retroativa do casamento passado"
	);
	console.log("✓ Teste 6 passou: Comando !mu-foto e regras de permissão validados.");

	// ─── TESTE 7: Limpeza de foto no divórcio (!mu-divorciar) ───────────────
	console.log("\n[Teste 7] Validando remoção da foto ao divorciar...");
	bot.resetCapture();
	eventHandler.commandHandler.userDebounceMap.clear();
	const msgDivorciar = createMessage({
		content: "!mu-divorciar rem-re-zero",
		author: testUser,
		authorName: "Tester",
		group: testGroup
	});
	await eventHandler.processMessage(bot, msgDivorciar);
	await waitForReply();
	assert.ok(bot.capturedMessages.length > 0, "Deveria responder ao divórcio");
	assert.ok(
		bot.capturedMessages[0].content.includes("Divórcio concluído!"),
		"Deve confirmar o divórcio"
	);

	const checkAposDivorcio = await waifuHelper.getMarriagePhoto("rem-re-zero");
	assert.strictEqual(
		checkAposDivorcio.exists,
		false,
		"Foto de casamento deve ser removida após divórcio"
	);
	// ─── TESTE 8: Resolução de Ator em Reações e Proteção Contra Avatar do Bot ───
	console.log("\n[Teste 8] Validando resolução de autor em reações e bloqueio do avatar do bot...");
	bot.phoneNumber = "555599999999";
	bot.id = "555599999999@s.whatsapp.net";

	// 8.1: ProfilePictureHelper.isBotJid
	assert.strictEqual(
		ProfilePictureHelper.isBotJid(bot, "555599999999@s.whatsapp.net"),
		true,
		"Deve identificar JID do bot"
	);
	assert.strictEqual(
		ProfilePictureHelper.isBotJid(bot, "555599999999:2@s.whatsapp.net"),
		true,
		"Deve identificar JID com dispositivo do bot"
	);
	assert.strictEqual(
		ProfilePictureHelper.isBotJid(bot, testUser),
		false,
		"Não deve identificar usuário comum como bot"
	);

	// 8.2: waifuHelper.describeUser prioriza userId e rejeita avatar do bot
	let fetchedJid = null;
	ProfilePictureHelper.fetchUserProfilePictureMedia = async (b, jid) => {
		fetchedJid = jid;
		return { data: dummyBase64 };
	};
	LLMService.prototype.getCompletion = async () => "human avatar description";

	// Cenário onde message.author é a Ravena (bot) e userId é o jogador
	const botMessage = {
		author: "555599999999@s.whatsapp.net",
		fromMe: true
	};
	const descUser = await waifuHelper.describeUser(bot, testUser, botMessage);
	assert.strictEqual(fetchedJid, testUser, "Deve buscar o avatar do jogador e NÃO do bot");
	assert.strictEqual(descUser, "human avatar description", "Deve retornar a descrição do avatar");

	// Cenário onde o targetJid resolvido é o próprio bot
	const descBot = await waifuHelper.describeUser(bot, bot.id, botMessage);
	assert.strictEqual(descBot, null, "Deve recusar gerar descrição se o alvo for o bot");

	// 8.3: ReactionsHandler normaliza formattedMessage.author para reaction.senderId
	const ReactionsHandler = require("../ReactionsHandler");
	const reactionsHandler = new ReactionsHandler();

	let capturedCommandMessage = null;
	const dummyCommand = {
		name: "test-reaction-actor",
		reactions: { trigger: "🎯" },
		method: async (b, msg) => {
			capturedCommandMessage = msg;
			return "OK";
		}
	};
	eventHandler.commandHandler.fixedCommands.commands.push(dummyCommand);
	reactionsHandler.reactionCommands["🎯"] = ["test-reaction-actor"];

	const reactionEvent = {
		reaction: "🎯",
		senderId: "5511888887777@s.whatsapp.net",
		userName: "Reagente",
		msgId: "target-msg-12345"
	};
	bot.client = {
		getMessageById: async () => ({
			id: "target-msg-12345",
			author: "555599999999@s.whatsapp.net",
			authorName: "Ravena",
			fromMe: true,
			type: "text",
			content: "Mensagem do bot que recebeu reação",
			origin: {
				id: { _serialized: "target-msg-12345" }
			}
		})
	};
	bot.eventHandler = eventHandler;

	const handled = await reactionsHandler.processReaction(bot, reactionEvent);
	assert.strictEqual(handled, true, "ReactionsHandler deve tratar a reação");
	assert.ok(capturedCommandMessage, "Comando deve ter sido executado");
	assert.strictEqual(
		capturedCommandMessage.author,
		"5511888887777@s.whatsapp.net",
		"message.author deve ser o usuário reagente"
	);
	assert.strictEqual(
		capturedCommandMessage.authorName,
		"Reagente",
		"message.authorName deve ser o nome do usuário reagente"
	);
	assert.strictEqual(
		capturedCommandMessage.fromMe,
		false,
		"message.fromMe deve ser false quando um usuário reagiu"
	);
	assert.strictEqual(
		capturedCommandMessage.targetAuthor,
		"555599999999@s.whatsapp.net",
		"message.targetAuthor deve preservar o autor da mensagem alvo"
	);
	console.log("✓ Teste 8 passou: Normalização de ator em reações e trava de bot validados.");

	// ─── TESTE 9: Mecanismo de Retry (máx 3x) no Bonsai ─────────────────────
	console.log("\n[Teste 9] Validando retry de até 3x na geração via Bonsai...");
	let attemptsMade = 0;
	bonsaiModule.generateImage = async () => {
		attemptsMade++;
		if (attemptsMade === 1) {
			return null; // Primeira tentativa falha
		}
		return {
			content: {
				mimetype: "image/jpeg",
				data: dummyBase64
			}
		};
	};

	const charRetry = {
		id: "retry-char-success",
		name: "Retry Girl",
		series: "Anime",
		baseRarity: "RARE",
		imageUrl: "http://example.com/retry.jpg"
	};

	const retryResSuccess = await waifuHelper.generateAndSaveMarriageImage(
		bot,
		{ author: testUser },
		charRetry,
		testUser,
		"Tester"
	);
	assert.strictEqual(retryResSuccess.success, true, "Deve ter sucesso após retry");
	assert.strictEqual(attemptsMade, 2, "Deve ter realizado exatamente 2 tentativas");

	// Cenário onde todas as 3 tentativas falham
	attemptsMade = 0;
	bonsaiModule.generateImage = async () => {
		attemptsMade++;
		throw new Error("HTTP 500 Internal Server Error");
	};

	const charRetryFail = {
		id: "retry-char-fail",
		name: "Fail Girl",
		series: "Anime",
		baseRarity: "COMMON",
		imageUrl: "http://example.com/fail.jpg"
	};

	const retryResFail = await waifuHelper.generateAndSaveMarriageImage(
		bot,
		{ author: testUser },
		charRetryFail,
		testUser,
		"Tester"
	);
	assert.strictEqual(retryResFail.success, false, "Deve falhar após 3 tentativas");
	assert.strictEqual(retryResFail.fallback, "text", "Deve retornar fallback text");
	assert.strictEqual(attemptsMade, 3, "Deve ter tentado exatamente 3 vezes");
	console.log(
		"✓ Teste 9 passou: Retry na 2ª tentativa e fallback após 3 falhas validados com sucesso."
	);

	// Restaura mocks
	LLMService.prototype.getCompletion = origGetCompletion;
	ProfilePictureHelper.fetchUserProfilePictureMedia = origFetchPfp;
	waifuHelper.downloadCharacterImageBuffer = origDownloadChar;
	bonsaiModule.generateImage = origBonsaiGen;
	waifuModule.api.post = origApiPost;
	waifuModule.api.get = origApiGet;

	console.log("\n=======================================================");
	console.log("🎉 TODOS OS TESTES PASSARAM COM SUCESSO! 🎉");
	console.log("=======================================================");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro nos testes:", err);
		process.exit(1);
	});
