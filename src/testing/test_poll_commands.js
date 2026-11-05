process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const ReturnMessage = require("../models/ReturnMessage");
const {
	commands,
	criarEnquete,
	parsePollConfigs,
	parseEndTime
} = require("../functions/PollCommands");
const CustomVariableProcessor = require("../utils/CustomVariableProcessor");

async function runTests() {
	console.log("=== INICIANDO TESTES DE ENQUETE (POLL) ===");

	// 1. Testes de Parsing de Configurações e Datas
	console.log("\n[1] Testando parsePollConfigs e parseEndTime...");
	{
		const c1 = parsePollConfigs("$anonimo $multiplas $hoje");
		assert.strictEqual(c1.hideVoters, true, "Deve ativar hideVoters para $anonimo");
		assert.strictEqual(
			c1.allowMultipleAnswers,
			true,
			"Deve ativar allowMultipleAnswers para $multiplas"
		);
		assert.ok(c1.endTime > Math.floor(Date.now() / 1000), "endTime para $hoje deve ser no futuro");

		const c2 = parsePollConfigs("$anon $mult $amanha");
		assert.strictEqual(c2.hideVoters, true, "Deve ativar hideVoters para $anon");
		assert.strictEqual(
			c2.allowMultipleAnswers,
			true,
			"Deve ativar allowMultipleAnswers para $mult"
		);
		assert.ok(
			c2.endTime > Math.floor(Date.now() / 1000),
			"endTime para $amanha deve ser no futuro"
		);

		const c3 = parsePollConfigs(["$13:30 06/11/2026", "$anon"]);
		assert.strictEqual(c3.hideVoters, true);
		const expectedDate = new Date(2026, 10, 6, 13, 30, 0, 0); // Mês 10 = Novembro
		assert.strictEqual(c3.endTime, Math.floor(expectedDate.getTime() / 1000));

		const c4 = parsePollConfigs("$12:50");
		assert.ok(c4.endTime > 0, "Deve interpretar $12:50 com sucesso");

		const c5 = parsePollConfigs("");
		assert.strictEqual(c5.hideVoters, false);
		assert.strictEqual(c5.allowMultipleAnswers, false);
		assert.strictEqual(c5.endTime, 0);

		console.log("✓ parsePollConfigs validado com sucesso.");
	}

	// 2. Teste do Comando !enquete / !poll
	console.log("\n[2] Testando comando !enquete / !poll...");
	{
		const bot = new FakeBot({ id: "test-bot" });
		const msg = createMessage({
			content:
				"!poll Qual seu framework backend favorito?\n" +
				"Express\n" +
				"Fastify\n" +
				"NestJS\n\n" +
				"$anonimo $multiplas $amanha",
			group: "123456@g.us",
			author: "5511999990001@s.whatsapp.net"
		});

		const res = await criarEnquete(bot, msg, [], { prefix: "!" });
		assert.ok(res instanceof ReturnMessage, "Resultado deve ser uma instância de ReturnMessage");
		assert.ok(res.poll, "ReturnMessage deve conter a propriedade poll");
		assert.strictEqual(res.poll.question, "Qual seu framework backend favorito?");
		assert.deepStrictEqual(res.poll.options, ["Express", "Fastify", "NestJS"]);
		assert.strictEqual(res.poll.hideVoters, true);
		assert.strictEqual(res.poll.allowMultipleAnswers, true);
		assert.ok(res.poll.endTime > 0);

		console.log("✓ Comando !poll validado com sucesso.");
	}

	// 3. Teste de Validações do Comando (!enquete sem opções, menos de 2 opções, etc.)
	console.log("\n[3] Testando validações do comando !enquete...");
	{
		const bot = new FakeBot({ id: "test-bot" });

		// Sem argumentos (help)
		const msgVazia = createMessage({ content: "!enquete", group: "123456@g.us" });
		const resVazia = await criarEnquete(bot, msgVazia, [], { prefix: "!" });
		assert.ok(resVazia.content.includes("Como criar uma enquete"));

		// Apenas 1 opção
		const msgPoucas = createMessage({
			content: "!enquete Pergunta?\nOpção 1\n\n$anonimo",
			group: "123456@g.us"
		});
		const resPoucas = await criarEnquete(bot, msgPoucas, [], { prefix: "!" });
		assert.ok(resPoucas.content.includes("mínimo 2 opções"));

		// Mais de 12 opções
		const muitasOpcoes = Array.from({ length: 13 }, (_, i) => `Opção ${i + 1}`).join("\n");
		const msgMuitas = createMessage({
			content: `!enquete Pergunta?\n${muitasOpcoes}`,
			group: "123456@g.us"
		});
		const resMuitas = await criarEnquete(bot, msgMuitas, [], { prefix: "!" });
		assert.ok(resMuitas.content.includes("máximo 12 opções"));

		console.log("✓ Validações de limites e ajuda validadas.");
	}

	// 4. Teste de Variáveis do CustomVariableProcessor na Pergunta e Opções
	console.log("\n[4] Testando substituição de variáveis na pergunta e opções...");
	{
		const bot = new FakeBot({ id: "test-bot" });
		const msg = createMessage({
			content:
				"!enquete Votação do dia {data}?\n" + "Opção Alpha {hora}\n" + "Opção Beta\n\n" + "$anon",
			group: "123456@g.us"
		});

		const res = await criarEnquete(bot, msg, [], { prefix: "!" });
		assert.ok(res.poll);
		assert.ok(!res.poll.question.includes("{data}"), "Variável {data} deve ter sido substituída");
		assert.ok(!res.poll.options[0].includes("{hora}"), "Variável {hora} deve ter sido substituída");
		assert.strictEqual(res.poll.hideVoters, true);

		console.log("✓ Variáveis substituídas com sucesso.");
	}

	// 5. Teste da Custom Variable {poll-Nome|Op1#Op2|$configs}
	console.log("\n[5] Testando custom variable {poll-...}...");
	{
		const variableProcessor = new CustomVariableProcessor();
		const bot = new FakeBot({ id: "test-bot" });
		const msg = createMessage({ group: "123456@g.us" });
		const context = { message: msg, bot, options: {} };

		const rawVar = "{poll-Quem vence a partida?|Time A#Time B#Empate|$mult,$anon}";
		const resVar = await variableProcessor.process(rawVar, context);

		assert.ok(typeof resVar === "object", "Deve retornar um objeto de enquete");
		assert.strictEqual(resVar.isPoll, true);
		assert.strictEqual(resVar.poll.question, "Quem vence a partida?");
		assert.deepStrictEqual(resVar.poll.options, ["Time A", "Time B", "Empate"]);
		assert.strictEqual(resVar.poll.allowMultipleAnswers, true);
		assert.strictEqual(resVar.poll.hideVoters, true);

		console.log("✓ Custom variable {poll-...} processada com sucesso.");
	}

	// 6. Teste de Custom Command retornando {poll-...} via CommandHandler
	console.log("\n[6] Testando execução de Custom Command com {poll-...} no CommandHandler...");
	{
		const CommandHandler = require("../CommandHandler");
		const handler = new CommandHandler();
		const bot = new FakeBot({ id: "test-bot" });
		const msg = createMessage({ group: "123456@g.us" });
		const command = { startsWith: "!votacao", reply: false };
		const group = { id: "123456@g.us", prefix: "!" };

		const response = await handler.processCustomCommandResponse(
			bot,
			msg,
			"{poll-Qual a melhor linguagem?|JavaScript#TypeScript#Go|$mult}",
			command,
			group,
			[]
		);

		assert.ok(response instanceof ReturnMessage, "Deve gerar ReturnMessage");
		assert.ok(response.poll, "ReturnMessage deve conter objeto poll");
		assert.strictEqual(response.poll.question, "Qual a melhor linguagem?");
		assert.deepStrictEqual(response.poll.options, ["JavaScript", "TypeScript", "Go"]);
		assert.strictEqual(response.poll.allowMultipleAnswers, true);
		assert.strictEqual(response.poll.hideVoters, false);

		console.log("✓ Custom command com {poll-...} integrado com sucesso.");
	}

	// 7. Teste de serialização e integração com ReturnMessage / WhatsAppBotGo
	console.log("\n[7] Testando ReturnMessage.isValid() e toJSON()...");
	{
		const retMsg = new ReturnMessage({
			chatId: "123456@g.us",
			poll: {
				question: "Teste?",
				options: ["Sim", "Não"],
				allowMultipleAnswers: false,
				hideVoters: true,
				endTime: 1785000000
			}
		});

		assert.strictEqual(retMsg.isValid(), true, "ReturnMessage com poll deve ser válida");
		const json = retMsg.toJSON();
		assert.ok(json.poll, "toJSON deve conter a propriedade poll");
		assert.strictEqual(json.poll.question, "Teste?");

		console.log("✓ ReturnMessage validada.");
	}

	// 8. Teste do envio de poll no WhatsAppBotGo (garantir endpoint /send/poll e payload correto)
	console.log("\n[8] Testando seleção de endpoint /send/poll no WhatsAppBotGo.sendMessage...");
	{
		const WhatsAppBotGo = require("../WhatsAppBotGo");
		let calledEndpoint = null;
		let calledPayload = null;

		const mockBot = Object.create(WhatsAppBotGo.prototype);
		mockBot.id = "test-go";
		mockBot.isConnected = true;
		mockBot.isParticipating = () => true;
		mockBot.outboundDedupCache = new Map();
		mockBot._computeOutboundChecksum = WhatsAppBotGo.prototype._computeOutboundChecksum;
		mockBot.getActualMsgId = (id) => id;
		mockBot.getChatDetails = async () => ({ participants: [] });
		mockBot.truncateText = (t) => t;
		mockBot.recoverMsgFromCache = async () => null;
		mockBot.loadReport = { trackSentMessage: () => {} };
		mockBot.logger = {
			warn: () => {},
			debug: () => {},
			error: (...args) => console.error("mockBot.error:", ...args),
			info: () => {}
		};
		mockBot.apiClient = {
			post: async (endpoint, payload) => {
				calledEndpoint = endpoint;
				calledPayload = payload;
				return { data: { Info: { ID: "msg_123" } } };
			}
		};

		// Caso A: content vazio e options.poll presente (exatamente o que ReturnMessage produz)
		await mockBot.sendMessage("123456@g.us", "", {
			poll: {
				question: "Qual o melhor?",
				options: ["Op1", "Op2"],
				allowMultipleAnswers: true,
				hideVoters: true,
				endTime: 1785000000
			}
		});

		assert.strictEqual(
			calledEndpoint,
			"/send/poll",
			"Endpoint DEVE ser /send/poll e NÃO /send/text!"
		);
		assert.strictEqual(calledPayload.question, "Qual o melhor?");
		assert.deepStrictEqual(calledPayload.options, ["Op1", "Op2"]);
		assert.strictEqual(calledPayload.maxAnswer, 0, "maxAnswer deve ser 0 para múltiplas respostas");
		assert.strictEqual(calledPayload.hideVoters, true);
		assert.strictEqual(calledPayload.endTime, 1785000000);

		// Caso B: content nulo e options.poll presente
		await mockBot.sendMessage("123456@g.us", null, {
			poll: {
				question: "Pergunta única?",
				options: ["A", "B"],
				allowMultipleAnswers: false,
				hideVoters: false
			}
		});

		assert.strictEqual(calledEndpoint, "/send/poll");
		assert.strictEqual(calledPayload.maxAnswer, 1, "maxAnswer deve ser 1 para resposta única");
		assert.strictEqual(calledPayload.hideVoters, false);

		console.log("✓ WhatsAppBotGo.sendMessage direciona para /send/poll com sucesso.");
	}

	// 9. Teste do caso real do usuário (!poll e {poll-...} com variáveis e $mult $hoje)
	console.log("\n[9] Testando caso real do usuário (!poll com {pokemonEN} e $mult $hoje)...");
	{
		const WhatsAppBotGo = require("../WhatsAppBotGo");
		let lastEndpoint = null;
		let lastPayload = null;

		const mockBot = Object.create(WhatsAppBotGo.prototype);
		mockBot.id = "test-go-real";
		mockBot.isConnected = true;
		mockBot.isParticipating = () => true;
		mockBot.outboundDedupCache = new Map();
		mockBot._computeOutboundChecksum = WhatsAppBotGo.prototype._computeOutboundChecksum;
		mockBot.getActualMsgId = (id) => id;
		mockBot.getChatDetails = async () => ({ participants: [] });
		mockBot.truncateText = (t) => t;
		mockBot.recoverMsgFromCache = async () => null;
		mockBot.loadReport = { trackSentMessage: () => {} };
		mockBot.logger = {
			warn: () => {},
			debug: () => {},
			error: (...args) => console.error("mockBot.error:", ...args),
			info: () => {}
		};
		mockBot.apiClient = {
			post: async (endpoint, payload) => {
				lastEndpoint = endpoint;
				lastPayload = payload;
				return { data: { Info: { ID: "msg_real_123" } } };
			}
		};

		// A: Via comando !poll
		const userMsg = createMessage({
			content:
				"!poll Qual a melhor coisa dessa lista?\n" +
				"Opcao A\n" +
				"Opcao B\n" +
				"Opcao C\n" +
				"$mult $hoje",
			group: "120363419710757620@g.us"
		});

		const returnMsg = await criarEnquete(mockBot, userMsg, [], { prefix: "!" });
		assert.ok(returnMsg instanceof ReturnMessage);
		assert.ok(returnMsg.isValid(), "ReturnMessage deve ser válida");
		assert.strictEqual(returnMsg.poll.question, "Qual a melhor coisa dessa lista?");
		assert.strictEqual(
			returnMsg.poll.allowMultipleAnswers,
			true,
			"allowMultipleAnswers deve ser true para $mult"
		);
		assert.ok(returnMsg.poll.endTime > 0, "endTime deve ser > 0 para $hoje");

		// Executa sendReturnMessages
		await mockBot.sendReturnMessages([returnMsg]);
		assert.strictEqual(
			lastEndpoint,
			"/send/poll",
			"sendReturnMessages deve chamar /send/poll e NUNCA /send/text!"
		);
		assert.strictEqual(lastPayload.question, "Qual a melhor coisa dessa lista?");
		assert.strictEqual(lastPayload.maxAnswer, 0, "maxAnswer deve ser 0 para $mult");
		assert.ok(lastPayload.endTime > 0, "payload.endTime deve ser > 0");

		// B: Via Custom Command com {poll-...}
		const CommandHandler = require("../CommandHandler");
		const handler = new CommandHandler();
		const customResp = await handler.processCustomCommandResponse(
			mockBot,
			userMsg,
			"{poll-Qual a melhor fruta?|Manga#Banana#Morango|$mult $hoje}",
			{ startsWith: "!fruta", reply: false },
			{ id: "120363419710757620@g.us", prefix: "!" },
			[]
		);

		assert.ok(customResp instanceof ReturnMessage);
		assert.ok(customResp.isValid());
		await mockBot.sendReturnMessages([customResp]);
		assert.strictEqual(lastEndpoint, "/send/poll");
		assert.strictEqual(lastPayload.question, "Qual a melhor fruta?");
		assert.strictEqual(lastPayload.maxAnswer, 0);
		assert.ok(lastPayload.endTime > 0);

		console.log("✓ Pipeline completo do caso real validado com sucesso.");
	}

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("ERRO NOS TESTES:", err);
		process.exit(1);
	});
