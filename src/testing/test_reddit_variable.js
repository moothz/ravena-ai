"use strict";

process.env.NODE_ENV = "test";
process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const CustomVariableProcessor = require("../utils/CustomVariableProcessor");
const FakeBot = require("./FakeBot");

async function main() {
	console.log("Iniciando testes de CustomVariableProcessor para variáveis Reddit...");
	const processor = new CustomVariableProcessor();
	const bot = new FakeBot({ id: "test-bot" });

	const context = {
		bot,
		group: { id: "123456@g.us", filters: { nsfw: false } },
		message: {
			author: "5511999999999@s.whatsapp.net",
			group: "123456@g.us"
		},
		options: {}
	};

	// Teste 1: Processamento de {reddit-catpictures}
	console.log("Teste 1: Processando {reddit-catpictures}...");
	const result = await processor.process("{reddit-catpictures}", context);

	assert.ok(result, "O resultado não deve ser nulo ou vazio");
	assert.ok(typeof result === "object", "O resultado deve ser um objeto de mídia");
	assert.ok(result.isMessageMedia, "O resultado deve ser um MessageMedia");
	assert.ok(result.url, "O resultado deve conter a URL da mídia");
	assert.ok(context.options.caption, "A legenda deve estar definida em context.options.caption");
	assert.match(
		context.options.caption,
		/📷 \[r\/catpictures\]/i,
		"A legenda deve conter o nome do subreddit"
	);
	console.log("Teste 1 passou! URL:", result.url, "| Legenda:", context.options.caption);

	// Teste 2: Cache de posts
	console.log("Teste 2: Verificando cache de posts...");
	const cachedPosts = processor.redditCache["123456@g.us"]?.["catpictures"];
	assert.ok(Array.isArray(cachedPosts), "Deve existir array de cache para catpictures");
	assert.ok(cachedPosts.length > 0, "O cache deve conter pelo menos 1 post");
	console.log("Teste 2 passou! Posts no cache:", cachedPosts.length);

	// Teste 3: Subreddit inexistente
	console.log("Teste 3: Processando subreddit inexistente...");
	const context2 = { bot, group: { id: "123456@g.us" }, options: {} };
	const resultNotFound = await processor.process(
		"{reddit-this_subreddit_does_not_exist_xyz123_test}",
		context2
	);
	assert.ok(
		typeof resultNotFound === "string",
		"Deve retornar texto quando não encontra subreddit"
	);
	assert.match(
		resultNotFound,
		/não foi encontrado ou não possui posts/i,
		"Deve conter mensagem informativa amigável"
	);
	console.log("Teste 3 passou! Mensagem retornada:", resultNotFound);

	// Teste 4: Subreddit com prefixo r/ (ex: {reddit-r/catpictures})
	console.log("Teste 4: Processando subreddit com prefixo r/...");
	const context3 = { bot, group: { id: "123456@g.us" }, options: {} };
	const resultWithR = await processor.process("{reddit-r/catpictures}", context3);
	assert.ok(resultWithR && typeof resultWithR === "object" && resultWithR.isMessageMedia);
	console.log("Teste 4 passou! Prefixo r/ tratado corretamente.");

	console.log("Todos os testes do Reddit passaram com sucesso!");
	process.exit(0);
}

main().catch((err) => {
	console.error("Falha nos testes:", err);
	process.exit(1);
});
