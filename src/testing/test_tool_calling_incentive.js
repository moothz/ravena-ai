process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const LLMService = require("../services/LLMService");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const ReturnMessage = require("../models/ReturnMessage");

async function runTests() {
	console.log("=== Testando Incentivo a Tools, Política Obrigatória e execute_bot_command ===");
	const llm = LLMService.getInstance();

	// 1. Verifica se execute_bot_command está presente em getTools()
	console.log("\n[1] Verificando se execute_bot_command está registrado em getTools()...");
	const tools = llm.getTools();
	const execTool = tools.find((t) => t.function?.name === "execute_bot_command");
	assert(execTool, "Tool 'execute_bot_command' deve estar presente em getTools()");
	assert.strictEqual(execTool.function.parameters.required[0], "command");
	console.log("✓ Tool 'execute_bot_command' registrada corretamente.");

	// 2. Testa injeção da POLÍTICA OBRIGATÓRIA DE USO DE FERRAMENTAS e initialTemperature em openaiCompletion
	console.log(
		"\n[2] Testando injeção de política de ferramentas e temperatura dinâmica em openaiCompletion..."
	);
	let capturedPayload = null;
	const originalPost = require("axios").post;

	// Mock do axios.post
	require("axios").post = async (url, payload) => {
		capturedPayload = payload;
		return {
			data: {
				choices: [
					{
						message: {
							content: "Resposta direta sem tools"
						}
					}
				]
			}
		};
	};

	try {
		// Teste 2.1: Com toolCalling = true e sem temperatura definida -> initialTemperature = 0.1
		await llm.openaiCompletion({
			prompt: "qual a previsão do tempo?",
			apiKey: "dummy-key",
			toolCalling: true
		});

		assert(capturedPayload !== null, "payload deve ter sido gerado");
		assert.strictEqual(
			capturedPayload.temperature,
			0.1,
			"Com toolCalling=true, temperature inicial deve ser reduzida para 0.1"
		);

		const sysMsg = capturedPayload.messages.find((m) => m.role === "system");
		assert(sysMsg, "Mensagem de sistema deve estar presente");
		assert(
			sysMsg.content.includes("POLÍTICA OBRIGATÓRIA DE USO DE FERRAMENTAS"),
			"System context deve conter a POLÍTICA OBRIGATÓRIA DE USO DE FERRAMENTAS"
		);
		console.log(
			"✓ Política injetada e temperatura 0.1 aplicada no primeiro turno com toolCalling!"
		);

		// Teste 2.2: Sem toolCalling -> temperature padrão 0.7 e sem política injetada
		capturedPayload = null;
		await llm.openaiCompletion({
			prompt: "olá, tudo bem?",
			apiKey: "dummy-key",
			toolCalling: false
		});
		assert.strictEqual(
			capturedPayload.temperature,
			0.7,
			"Sem toolCalling, temperature deve manter 0.7"
		);
		const sysMsg2 = capturedPayload.messages.find((m) => m.role === "system");
		assert(
			!sysMsg2.content.includes("POLÍTICA OBRIGATÓRIA DE USO DE FERRAMENTAS"),
			"Sem toolCalling, política não deve ser injetada no system context"
		);
		console.log("✓ Sem toolCalling, mantém temperatura 0.7 e contexto limpo.");
	} finally {
		require("axios").post = originalPost;
	}

	// 3. Testa execução de execute_bot_command via executeToolCall
	console.log("\n[3] Testando execute_bot_command via executeToolCall...");

	// 3.1: Sem contexto de bot/message -> retorna erro amigável
	const noCtxResult = await llm.executeToolCall("execute_bot_command", { command: "pescar" }, {});
	assert(noCtxResult.includes("Erro: Contexto de chat/bot não disponível"));
	console.log("✓ Falha graciosa quando bot/message não estão no contexto.");

	// 3.2: Tentativa de auto-recursão com IA -> bloqueado
	const fakeBot = new FakeBot({ id: "test-bot" });
	const fakeMsg = createMessage({ content: "teste", author: "123@s.whatsapp.net" });

	const aiRecursionResult = await llm.executeToolCall(
		"execute_bot_command",
		{ command: "ai" },
		{ bot: fakeBot, message: fakeMsg }
	);
	assert(aiRecursionResult.includes("Comando de IA não pode ser executado recursivamente"));
	console.log("✓ Auto-recursão para comando de IA prevenida com sucesso.");

	// 3.3: Executando comando real registrado no bot
	const EventHandler = require("../EventHandler");
	const eventHandler = new EventHandler();
	fakeBot.eventHandler = eventHandler;

	// Registra um comando de teste no FixedCommands do FakeBot
	const commandHandler = fakeBot.eventHandler.commandHandler;
	commandHandler.fixedCommands.commands.push({
		name: "testecmd",
		aliases: ["tcmd"],
		caseSensitive: false,
		execute: async (bot, msg, args) =>
			new ReturnMessage({
				chatId: msg.author,
				content: `Comando executado com args: ${args.join(", ")}`
			})
	});

	const successResult = await llm.executeToolCall(
		"execute_bot_command",
		{ command: "testecmd", args: "param1 param2" },
		{ bot: fakeBot, message: fakeMsg }
	);

	assert(
		successResult.includes("[Resultado da execução de !testecmd param1 param2]"),
		"Deve formatar o resultado com cabeçalho de execução"
	);
	assert(
		successResult.includes("Comando executado com args: param1, param2"),
		"Deve conter a resposta emitida pelo comando"
	);
	console.log("✓ execute_bot_command executou o comando real e capturou o resultado!");

	// 3.4: Comando que gera mídia/sticker -> armazena em pendingReturnMessages
	const pendingOpts = { bot: fakeBot, message: fakeMsg, pendingReturnMessages: [] };
	commandHandler.fixedCommands.commands.push({
		name: "testesticker",
		aliases: [],
		caseSensitive: false,
		execute: async (bot, msg) =>
			new ReturnMessage({
				chatId: msg.author,
				options: { sendMediaAsSticker: true }
			})
	});

	await llm.executeToolCall("execute_bot_command", { command: "testesticker" }, pendingOpts);

	assert.strictEqual(
		pendingOpts.pendingReturnMessages.length,
		1,
		"pendingReturnMessages deve conter a mensagem de mídia para envio"
	);
	assert.strictEqual(pendingOpts.pendingReturnMessages[0].options.sendMediaAsSticker, true);
	console.log("✓ Mídias geradas por comandos são preservadas em pendingReturnMessages!");

	console.log("\n🎉 TODOS OS TESTES PASSARAM COM SUCESSO!");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Erro nos testes:", err);
		process.exit(1);
	});
