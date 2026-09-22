process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const LLMService = require("../services/LLMService");
const ReturnMessage = require("../models/ReturnMessage");
const { createMessage } = require("./FakeMessage");

async function main() {
	console.log("=== Testando Invocação e Classificação de Comandos Personalizados via LLM ===");

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
		mutedCategories: ["nsfw"],
		mutedCommands: ["comando_silenciado"]
	};

	// 1. Configura comandos personalizados de teste no CommandHandler
	commandHandler.customCommands[groupId] = [
		{
			startsWith: "custompix",
			description: "Chave PIX para doações ao grupo",
			responses: ["pix@grupo.com"],
			active: true,
			deleted: false,
			count: 10
		},
		{
			startsWith: "customdiscord",
			description: "",
			responses: ["https://discord.gg/ravena {mention}"],
			active: true,
			deleted: false,
			count: 5
		},
		{
			startsWith: "admincmd",
			description: "Comando exclusivo para admins",
			responses: ["Área secreta de administradores"],
			adminOnly: true,
			active: true,
			deleted: false
		},
		{
			startsWith: "cooldowncmd",
			description: "Comando com cooldown longo",
			responses: ["Resposta sob cooldown"],
			cooldown: 60,
			active: true,
			deleted: false
		},
		{
			startsWith: "comando_silenciado",
			description: "Comando silenciado nas configurações do grupo",
			responses: ["Não deve aparecer"],
			active: true,
			deleted: false
		},
		{
			startsWith: "nsfw_cmd",
			description: "Comando de categoria silenciada",
			category: "nsfw",
			responses: ["Não deve aparecer"],
			active: true,
			deleted: false
		},
		{
			startsWith: "inativo",
			description: "Comando inativo",
			responses: ["Não deve aparecer"],
			active: false,
			deleted: false
		}
	];

	// Importa funções do AICommands
	const AICommandsModule = require("../functions/AICommands");
	const aiCmdObj = AICommandsModule.commands.find((c) => c.name === "ai");
	assert(aiCmdObj, "Comando !ai deve existir no módulo AICommands");

	console.log("\n[1] Testando inclusão de comandos personalizados em getCommandLists...");
	const llmService = LLMService.getInstance();
	let capturedPrompt = null;
	const originalGetCompletion = llmService.getCompletion.bind(llmService);

	llmService.getCompletion = async (options) => {
		capturedPrompt = options.prompt;
		// Retorna resposta simulada de classificação
		if (options.response_format?.json_schema?.name === "classify_schema") {
			return JSON.stringify({
				classification: "command",
				command: "custompix",
				args: ""
			});
		}
		return originalGetCompletion(options);
	};

	try {
		const msg = createMessage({
			content: "!ai qual o pix?",
			group: groupId,
			author: "5511999999999@s.whatsapp.net"
		});

		const result = await aiCmdObj.execute(bot, msg, ["qual", "o", "pix?"], group);

		assert(capturedPrompt, "Prompt de classificação deve ter sido enviado ao LLMService");
		assert(
			capturedPrompt.includes("### Comandos Personalizados do Grupo:"),
			"Prompt deve conter a seção de comandos personalizados do grupo"
		);
		assert(
			capturedPrompt.includes("- !custompix: Chave PIX para doações ao grupo"),
			"Prompt deve conter o comando !custompix com sua descrição"
		);
		assert(
			capturedPrompt.includes("- !customdiscord: https://discord.gg/ravena"),
			"Prompt deve extrair preview limpo (sem tags {mention}) para comando sem descrição"
		);
		assert(
			!capturedPrompt.includes("comando_silenciado"),
			"Comando silenciado pelo grupo não deve constar no prompt"
		);
		assert(
			!capturedPrompt.includes("nsfw_cmd"),
			"Comando com categoria silenciada não deve constar no prompt"
		);
		assert(!capturedPrompt.includes("!inativo"), "Comando inativo não deve constar no prompt");
		console.log("✓ Comandos personalizados incluídos corretamente no prompt de classificação!");

		console.log("\n[2] Testando retorno de handleCommandInvocation para comando customizado...");
		assert(result, "Deve haver retorno da execução");
		const returnContent = Array.isArray(result) ? result[0].content : result.content;
		assert(
			returnContent.includes("> 🤖 Usando comando !custompix"),
			"Resposta deve conter banner '> 🤖 Usando comando !custompix'"
		);
		assert(
			returnContent.includes("pix@grupo.com"),
			"Resposta deve conter o conteúdo do comando personalizado (pix@grupo.com)"
		);
		assert.strictEqual(
			bot.capturedMessages.length,
			0,
			"Comando com silent: true não deve enviar mensagens diretamente via bot.sendReturnMessages"
		);
		console.log(
			"✓ handleCommandInvocation executou o comando customizado e formatou o banner perfeitamente!"
		);

		console.log("\n[3] Testando comando customizado com adminOnly para usuário comum...");
		llmService.getCompletion = async () =>
			JSON.stringify({
				classification: "command",
				command: "admincmd",
				args: ""
			});

		const adminTestMsg = createMessage({
			content: "!ai quero usar o admincmd",
			group: groupId,
			author: "5511000000000@s.whatsapp.net"
		});

		const adminResult = await aiCmdObj.execute(
			bot,
			adminTestMsg,
			["quero", "usar", "o", "admincmd"],
			group
		);
		const adminContent = Array.isArray(adminResult) ? adminResult[0].content : adminResult.content;
		assert(
			adminContent.includes("administradores"),
			"Usuário não-admin deve receber aviso que o comando é restrito a administradores"
		);
		console.log("✓ Restrição adminOnly respeitada na invocação pela IA!");

		console.log("\n[4] Testando comando customizado com cooldown...");
		llmService.getCompletion = async () =>
			JSON.stringify({
				classification: "command",
				command: "cooldowncmd",
				args: ""
			});

		// Primeira execução -> registra timestamp
		await aiCmdObj.execute(bot, msg, ["cooldowncmd"], group);

		// Segunda execução imediata -> deve alertar cooldown
		const cdResult = await aiCmdObj.execute(bot, msg, ["cooldowncmd"], group);
		const cdContent = Array.isArray(cdResult) ? cdResult[0].content : cdResult.content;
		assert(
			cdContent.includes("cooldown"),
			"Segunda execução imediata deve retornar mensagem de cooldown"
		);
		console.log("✓ Cooldown respeitado com mensagem amigável!");

		console.log("\n[5] Testando executeBotCommand em LLMService para comando personalizado...");
		const toolMsg = createMessage({
			content: "manda o pix",
			group: groupId,
			author: "5511999999999@s.whatsapp.net"
		});

		const toolResult = await llmService.executeToolCall(
			"execute_bot_command",
			{ command: "custompix" },
			{ bot, message: toolMsg, group }
		);

		assert(
			toolResult.includes("[Resultado da execução de comando personalizado !custompix]"),
			"Deve conter cabeçalho de comando personalizado"
		);
		assert(
			toolResult.includes("pix@grupo.com"),
			"Deve conter o resultado real do comando personalizado"
		);
		console.log(
			"✓ execute_bot_command do LLMService executou o comando personalizado do grupo com sucesso!"
		);
	} finally {
		llmService.getCompletion = originalGetCompletion;
	}

	console.log("\n🎉 TODOS OS TESTES DE COMANDO PERSONALIZADO NO LLM PASSARAM COM SUCESSO!");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro nos testes:", err);
		process.exit(1);
	});
