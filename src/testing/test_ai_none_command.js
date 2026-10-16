"use strict";

process.env.NODE_ENV = "test";
process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const LLMService = require("../services/LLMService");
const ReturnMessage = require("../models/ReturnMessage");
const { createMessage } = require("./FakeMessage");
const { commands, aiCommand } = require("../functions/AICommands");

async function main() {
	console.log("=== INICIANDO TESTES DO COMANDO IA (TRATAMENTO DE 'NONE') ===");

	const bot = new FakeBot({ id: "test-bot", grupoLogs: "logs@g.us" });
	const eventHandler = new EventHandler();
	bot.eventHandler = eventHandler;
	const commandHandler = eventHandler.commandHandler;
	commandHandler.cmdDebounceTime = 0;

	const groupId = "123456789@g.us";
	const group = {
		id: groupId,
		prefix: "!",
		name: "Grupo Teste",
		mutedCategories: [],
		mutedCommands: []
	};

	// Mock de comando personalizado para teste de controle
	commandHandler.customCommands[groupId] = [
		{
			startsWith: "custompix",
			description: "Chave PIX do grupo",
			responses: ["pix@grupo.com"],
			active: true,
			deleted: false
		}
	];

	const llmService = LLMService.getInstance();
	const originalGetCompletion = llmService.getCompletion.bind(llmService);

	try {
		// -----------------------------------------------------------------------
		// Teste 1: Classificador retorna command: "none"
		// -----------------------------------------------------------------------
		console.log("\n[1] Testando aiCommand quando classificador retorna command: 'none'...");
		let completionCalledWithSystemContext = false;

		llmService.getCompletion = async (options) => {
			if (options.response_format?.json_schema?.name === "classify_schema") {
				return JSON.stringify({
					classification: "command",
					command: "none",
					args: ""
				});
			}

			// Se chegou aqui, caiu no fluxo geral de geração de resposta!
			completionCalledWithSystemContext = true;
			return "Olá! Eu sou a Ravena, assistente virtual do grupo.";
		};

		const msg1 = createMessage({
			content: "!ai quem é você?",
			group: groupId,
			author: "5511999999999@s.whatsapp.net"
		});

		const result1 = await aiCommand(bot, msg1, ["quem", "é", "você?"], group);
		const content1 = Array.isArray(result1) ? result1[0].content : result1.content;

		assert.ok(
			!content1.includes('comando "none"'),
			`Resposta NÃO deve conter mensagem de erro de comando 'none'. Recebido: "${content1}"`
		);
		assert.ok(
			completionCalledWithSystemContext,
			"Deve ter acionado a geração de resposta geral pelo LLM"
		);
		assert.ok(
			content1.includes("Ravena"),
			`Resposta deve conter a mensagem gerada pela IA. Recebido: "${content1}"`
		);
		console.log(
			"✓ Quando classificador retorna 'none', bot não executa comando e responde normalmente!"
		);

		// -----------------------------------------------------------------------
		// Teste 2: Classificador retorna command: "!none" com aspas ou maiúsculas
		// -----------------------------------------------------------------------
		console.log("\n[2] Testando aiCommand quando classificador retorna '!None'...");
		completionCalledWithSystemContext = false;

		llmService.getCompletion = async (options) => {
			if (options.response_format?.json_schema?.name === "classify_schema") {
				return JSON.stringify({
					classification: "command",
					command: "!None",
					args: ""
				});
			}

			completionCalledWithSystemContext = true;
			return "Tudo ótimo por aqui, e com você?";
		};

		const msg2 = createMessage({
			content: "!ai tudo bem?",
			group: groupId,
			author: "5511999999999@s.whatsapp.net"
		});

		const result2 = await aiCommand(bot, msg2, ["tudo", "bem?"], group);
		const content2 = Array.isArray(result2) ? result2[0].content : result2.content;

		assert.ok(
			!content2.includes('comando "!None"') && !content2.includes('comando "none"'),
			`Resposta NÃO deve conter erro de comando. Recebido: "${content2}"`
		);
		assert.ok(completionCalledWithSystemContext, "Deve ter gerado resposta geral");
		console.log("✓ Variação '!None' tratada corretamente como ausência de comando!");

		// -----------------------------------------------------------------------
		// Teste 3: Classificador retorna command: "null" ou "nenhum"
		// -----------------------------------------------------------------------
		console.log("\n[3] Testando aiCommand quando classificador retorna command: 'null'...");
		completionCalledWithSystemContext = false;

		llmService.getCompletion = async (options) => {
			if (options.response_format?.json_schema?.name === "classify_schema") {
				return JSON.stringify({
					classification: "command",
					command: "null",
					args: ""
				});
			}

			completionCalledWithSystemContext = true;
			return "Brasília é a capital do Brasil.";
		};

		const msg3 = createMessage({
			content: "!ai qual a capital do brasil?",
			group: groupId,
			author: "5511999999999@s.whatsapp.net"
		});

		const result3 = await aiCommand(bot, msg3, ["qual", "a", "capital", "do", "brasil?"], group);
		const content3 = Array.isArray(result3) ? result3[0].content : result3.content;

		assert.ok(!content3.includes('comando "null"'), "Não deve tentar executar comando 'null'");
		assert.ok(content3.includes("Brasília"), "Deve responder com conteúdo da IA");
		console.log("✓ Variação 'null' tratada com sucesso!");

		// -----------------------------------------------------------------------
		// Teste 4: Controle - Quando classificador retorna um comando real válido
		// -----------------------------------------------------------------------
		console.log("\n[4] Testando aiCommand quando classificador retorna um comando válido real...");

		llmService.getCompletion = async (options) => {
			if (options.response_format?.json_schema?.name === "classify_schema") {
				return JSON.stringify({
					classification: "command",
					command: "custompix",
					args: ""
				});
			}
			throw new Error("Não deve chamar getCompletion geral para comando válido");
		};

		const msg4 = createMessage({
			content: "!ai qual o pix?",
			group: groupId,
			author: "5511999999999@s.whatsapp.net"
		});

		const result4 = await aiCommand(bot, msg4, ["qual", "o", "pix?"], group);
		const content4 = Array.isArray(result4) ? result4[0].content : result4.content;

		assert.ok(
			content4.includes("> 🤖 Usando comando !custompix"),
			`Comando real deve ser auto-invocado. Recebido: "${content4}"`
		);
		console.log("✓ Comandos válidos continuam sendo executados normalmente!");

		// -----------------------------------------------------------------------
		// Teste 5: Comando inexistente real (ex: 'comandoque_nao_existe')
		// -----------------------------------------------------------------------
		console.log("\n[5] Testando comando inexistente real...");

		llmService.getCompletion = async (options) => {
			if (options.response_format?.json_schema?.name === "classify_schema") {
				return JSON.stringify({
					classification: "command",
					command: "comandoque_nao_existe",
					args: ""
				});
			}
			return "Fallback";
		};

		const msg5 = createMessage({
			content: "!ai roda aí",
			group: groupId,
			author: "5511999999999@s.whatsapp.net"
		});

		const result5 = await aiCommand(bot, msg5, ["roda", "aí"], group);
		const content5 = Array.isArray(result5) ? result5[0].content : result5.content;

		assert.ok(
			content5.includes('Entendi que você quer usar o comando "comandoque_nao_existe"'),
			`Comando inexistente real deve informar que não encontrou. Recebido: "${content5}"`
		);
		console.log("✓ Comandos inexistentes reais continuam retornando o aviso explicativo!");
	} finally {
		llmService.getCompletion = originalGetCompletion;
	}

	console.log("\n🎉 TODOS OS TESTES PASSARAM COM SUCESSO!");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro nos testes:", err);
		process.exit(1);
	});
