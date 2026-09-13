const assert = require("assert");
const { msgTexto, msgComQuote, msgCustom } = require("./helpers");

// Isola serviços com efeitos colaterais antes de carregar o pipeline real.
const savedModules = new Map();
function stubModule(name, exports) {
	const id = require.resolve(name);
	savedModules.set(id, require.cache[id]);
	require.cache[id] = { id, filename: id, loaded: true, exports };
}

const logger = { debug() {}, info() {}, warn() {}, error() {} };
stubModule(
	"../utils/Logger",
	class {
		constructor() {
			return logger;
		}
	}
);
stubModule("../utils/Database", { getInstance: () => ({}) });
for (const name of [
	"../commands/FixedCommands",
	"../commands/Management",
	"../commands/SuperAdmin",
	"../utils/AdminUtils",
	"../services/CacheManager",
	"../utils/CmdUsage",
	"../utils/ProfilePictureHelper",
	"../functions/FileManager"
])
	stubModule(name, {});

const CommandHandler = require("../CommandHandler");
const CustomVariableProcessor = require("../utils/CustomVariableProcessor");
const axios = require("axios").default;

async function runTests() {
	const requests = [];
	const originalGet = axios.get;
	const originalPost = axios.post;
	const originalRandom = Math.random;
	axios.get = async (url, config) => {
		requests.push({ method: "GET", url, ...config });
		return { data: { resultado: "ok" } };
	};
	axios.post = async (url, data, config) => {
		requests.push({ method: "POST", url, data, ...config });
		return { data: "ok" };
	};
	try {
		const handler = Object.create(CommandHandler.prototype);
		handler.logger = logger;
		handler.variableProcessor = new CustomVariableProcessor();
		handler.variableProcessor.cache = { variables: {}, lastFetch: Date.now() };
		handler.checkCooldown = async () => ({ inCooldown: false });
		handler.updateCooldown = () => {};
		handler.cmdUsage = { logCommand() {} };
		handler.database = {
			updateCustomCommand: async (id, saved) => assert.ok(!Object.hasOwn(saved, "args"))
		};
		const bot = { id: "teste", sendReturnMessages: async () => {} };
		const group = { id: "teste@g.us", prefix: "!" };
		const message = msgTexto("teste olá mundo", { group: group.id });
		const command = { startsWith: "teste", count: 7 };
		const originalCommand = { ...command };
		const matched = handler.findCustomCommand("teste", [command], ["olá", "mundo"]);
		assert.strictEqual(matched.customCommand, command);
		assert.deepStrictEqual(matched.newArgs, ["olá", "mundo"]);
		const run = (text, args = ["olá", "mundo"], msg = message) =>
			handler.processCustomCommandResponse(bot, msg, text, command, group, args);

		await run("{API#POST#TEXT#https://httpbin.org/post?texto=arg1}");
		assert.strictEqual(requests.at(-1).method, "POST");
		assert.strictEqual(requests.at(-1).url, "https://httpbin.org/post");
		assert.deepStrictEqual(requests.at(-1).data, { texto: "olá" });
		console.log("OK: arg1 vira POST com { texto: 'olá' }");

		await run("{API#POST#TEXT#https://httpbin.org/post?texto=arg3&segundo=arg2}");
		assert.deepStrictEqual(requests.at(-1).data, { segundo: "mundo" });
		await run("{API#POST#TEXT#https://httpbin.org/post?texto=arg1}", []);
		assert.deepStrictEqual(requests.at(-1).data, {});
		assert.strictEqual((await run("{contador}")).content, "7");
		assert.deepStrictEqual(command, originalCommand);
		console.log("OK: argumentos ausentes somem; contador e comando salvo preservados");

		Math.random = () => 0.75;
		for (const sendAllResponses of [false, true]) {
			const saved = {
				startsWith: "teste",
				count: 7,
				sendAllResponses,
				responses: [
					"{API#POST#TEXT#https://httpbin.org/post?texto=arg1} {contador}",
					"{API#POST#TEXT#https://httpbin.org/post?texto=arg2} {contador}"
				]
			};
			const requestCount = requests.length;
			const result = await handler.executeCustomCommand(
				bot,
				message,
				saved,
				matched.newArgs,
				group,
				true
			);
			assert.strictEqual((Array.isArray(result) ? result[0] : result).content, "ok 8");
			assert.strictEqual(requests.length - requestCount, sendAllResponses ? 2 : 1);
			assert.deepStrictEqual(requests.at(-1).data, { texto: "mundo" });
			if (sendAllResponses) assert.deepStrictEqual(requests.at(-2).data, { texto: "olá" });
			assert.ok(!Object.hasOwn(saved, "args"));
		}
		let embedded;
		handler.processCommand = async (...params) => {
			embedded = params;
			return null;
		};
		await run("{cmd-!ping extra}");
		assert.deepStrictEqual(embedded[3], ["extra", "olá", "mundo"]);
		assert.deepStrictEqual(embedded[5], { skipCustom: true, silent: true });
		console.log("OK: respostas aleatórias/todas e argumentos de comandos embutidos");
		handler.customCommands = {
			[group.id]: [
				{
					startsWith: "teste",
					ignorePrefix: true,
					responses: ["{API#POST#TEXT#https://httpbin.org/post?texto=arg1&segundo=arg2}"]
				}
			]
		};
		await handler.processCustomIgnoresPrefix("teste olá mundo", bot, message, group);
		assert.deepStrictEqual(requests.at(-1).data, { texto: "olá", segundo: "mundo" });
		const executeCustomCommand = handler.executeCustomCommand;
		let automaticExecution;
		handler.executeCustomCommand = (...params) => {
			automaticExecution = executeCustomCommand.call(handler, ...params);
			return automaticExecution;
		};
		await handler.checkAutoTriggeredCommands(bot, message, "antes teste olá mundo", group);
		assert.ok(automaticExecution instanceof Promise);
		await automaticExecution;
		assert.deepStrictEqual(requests.at(-1).data, { texto: "olá", segundo: "mundo" });
		automaticExecution = null;
		await handler.checkAutoTriggeredCommands(bot, message, "teste", group);
		assert.ok(automaticExecution instanceof Promise);
		await automaticExecution;
		assert.deepStrictEqual(requests.at(-1).data, {});
		handler.executeCustomCommand = executeCustomCommand;
		console.log("OK: comandos sem prefixo e gatilhos ignorePrefix preservam argumentos");

		const quoted = msgTexto("Olá & texto=arg2 #HEADER#X=injetado {cmd-!ping}", {
			author: "autor-citado"
		});
		const withQuote = msgComQuote("teste", quoted, { author: "autor-atual", group: group.id });
		let downloads = 0;
		const getQuotedMessage = withQuote.origin.getQuotedMessage;
		withQuote.origin.getQuotedMessage = async () => ({
			...(await getQuotedMessage()),
			downloadMedia: async () => {
				downloads++;
				return null;
			}
		});
		await run(
			"{API#POST#TEXT#https://httpbin.org/post?texto={mensagemCitada}&autor={autor}&citado={autorCitado}#HEADER#Authorization=Bearer%20token}",
			[],
			withQuote
		);
		assert.deepStrictEqual(requests.at(-1).data, {
			texto: quoted.content,
			autor: "autor-atual",
			citado: "autor-citado"
		});
		assert.strictEqual(requests.at(-1).headers.authorization, "Bearer token");
		assert.strictEqual(downloads, 0);
		assert.strictEqual((await run("{mensagemCitada}", [], withQuote)).content, quoted.content);
		const quotedDirective = "{document-../../package.json}";
		const directiveMessage = msgComQuote("teste", msgTexto(quotedDirective), { group: group.id });
		assert.strictEqual(
			(await run("{mensagemCitada}", [], directiveMessage)).content,
			quotedDirective
		);
		await run(
			"{API#POST#TEXT#https://httpbin.org/post?texto={mensagemCitada}&autor={autorCitado}&media={midiaCitada}}",
			[]
		);
		assert.deepStrictEqual(requests.at(-1).data, {});
		console.log("OK: texto citado, autores, headers e ausência de citação");

		assert.strictEqual(
			(
				await run(
					"{API#GET#JSON#https://httpbin.org/get?texto=arg1#HEADER#X-Teste=arg2\n[resultado]}"
				)
			).content,
			"ok"
		);
		assert.strictEqual(requests.at(-1).url, "https://httpbin.org/get?texto=ol%C3%A1");
		assert.strictEqual(requests.at(-1).headers["x-teste"], "mundo");
		await run(
			"{API#FORM#TEXT#https://httpbin.org/post?texto=arg1&ausente=arg9#HEADER#X-Teste=valor}"
		);
		assert.strictEqual(requests.at(-1).data.get("texto"), "olá");
		assert.strictEqual(requests.at(-1).data.has("ausente"), false);
		assert.strictEqual(
			requests.at(-1).headers["content-type"],
			"application/x-www-form-urlencoded"
		);
		const beforeInvalidHeader = requests.length;
		await run("{API#GET#TEXT#https://httpbin.org/get#HEADER#X-Teste=arg1}", [
			"valor\r\nInjected: true"
		]);
		assert.strictEqual(requests.length, beforeInvalidHeader);
		const invalidResult = await run(
			"{API#GET#TEXT#https://httpbin.org/get#HEADER#Authorization=segredo#HEADER#inválido} {API#POST#TEXT#https://httpbin.org/post?texto=arg1}"
		);
		assert.strictEqual(invalidResult.content, "Erro na requisição API ok");
		assert.deepStrictEqual(requests.at(-1).data, { texto: "olá" });
		console.log("OK: GET/JSON, FORM e rejeição de quebra de linha em header");

		for (const [type, mimetype] of [
			["image", "image/png"],
			["video", "video/mp4"]
		]) {
			const media = { data: "YWJjZA==", mimetype, filename: `teste.${type}` };
			const mediaMessage = msgComQuote(
				"teste",
				msgCustom({ type, content: media, caption: "Legenda" }),
				{ group: group.id }
			);
			await run(
				"{API#POST#TEXT#https://httpbin.org/post?media={midiaCitada}&texto={mensagemCitada}}",
				[],
				mediaMessage
			);
			assert.deepStrictEqual(requests.at(-1).data, {
				media: `data:${mimetype};base64,YWJjZA==`,
				texto: "Legenda"
			});
			assert.deepStrictEqual((await run("{midiaCitada}", [], mediaMessage)).content, media);
		}
		console.log("OK: imagem e vídeo citados como data URI e como resposta de mídia");
		const unavailable = msgComQuote("teste", msgTexto("legenda"));
		unavailable.origin.getQuotedMessage = async () => {
			throw new Error("Citação expirada");
		};
		unavailable.quotedMsg = null;
		assert.strictEqual(
			(await run("{mensagemCitada}|{autorCitado}|{midiaCitada}", [], unavailable)).content,
			"||"
		);
		const audio = msgComQuote(
			"teste",
			msgCustom({ type: "audio", content: { data: "YWJj", mimetype: "audio/ogg" } })
		);
		assert.strictEqual((await run("{midiaCitada}", [], audio)).content, "");
		console.log("OK: citação indisponível e mídia não suportada ficam vazias");
		console.log("Todos os testes passaram (sem WhatsApp e sem rede).");
	} finally {
		axios.get = originalGet;
		axios.post = originalPost;
		Math.random = originalRandom;
		for (const [id, original] of savedModules) {
			if (original) require.cache[id] = original;
			else delete require.cache[id];
		}
	}
}

runTests()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error("FALHOU:", error);
		process.exit(1);
	});
