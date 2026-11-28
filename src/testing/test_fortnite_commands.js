process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";
process.env.TZ = "America/Sao_Paulo";
delete process.env.FORTNITE_API_KEY;

const assert = require("assert");
const axios = require("axios");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const Fortnite = require("../functions/FortniteCommands");

const ACCOUNT_ID = "0000aaaa1111bbbb2222cccc3333dddd";
const GROUP = "120363000000000099@g.us";
const USER = "5511999990001@s.whatsapp.net";

const STATS = {
	accountId: ACCOUNT_ID,
	stats: {
		br_placetop1_keyboardmouse_m0_playlist_defaultsolo: 10,
		br_kills_keyboardmouse_m0_playlist_defaultsolo: 150,
		br_matchesplayed_keyboardmouse_m0_playlist_defaultsolo: 60,
		br_minutesplayed_keyboardmouse_m0_playlist_defaultsolo: 600,
		br_placetop1_gamepad_m0_playlist_nobuildbr_solo: 2,
		br_kills_gamepad_m0_playlist_nobuildbr_solo: 30,
		br_matchesplayed_gamepad_m0_playlist_nobuildbr_solo: 20,
		br_placetop1_keyboardmouse_m0_playlist_defaultsquad: 5,
		br_kills_keyboardmouse_m0_playlist_defaultsquad: 40,
		br_matchesplayed_keyboardmouse_m0_playlist_defaultsquad: 25,
		br_placetop10_keyboardmouse_m0_playlist_defaultsolo: 99,
		br_kills_keyboardmouse_m0_playlist_playgroundv2: 7,
		br_matchesplayed_keyboardmouse_m0_playlist_playgroundv2: 3,
		s34_social_bp_level: 4512
	}
};

const SHOP = {
	refreshIntervalHrs: 1,
	expiration: new Date(Date.now() + 3600 * 1000).toISOString(),
	storefronts: [
		{
			name: "BRDailyStorefront",
			catalogEntries: [
				{
					devName: "dev-peely",
					sectionDisplayName: "Em destaque",
					sectionPriority: 10,
					prices: [{ currencyType: "MtxCurrency", regularPrice: 1500, finalPrice: 1200 }],
					itemGrants: [
						{
							templateId: "AthenaCharacter:cid_test_peely",
							cosmetic: {
								type: "Traje",
								displayName: "Peely Ação",
								rarity: "Épico",
								images: { icon: "https://cdn.example.com/peely.png" }
							}
						}
					]
				},
				{
					devName: "dev-pickaxe",
					title: "Picareta Banana",
					sectionDisplayName: "Diário",
					sectionPriority: 1,
					prices: [{ currencyType: "MtxCurrency", regularPrice: 800, finalPrice: 800 }],
					itemGrants: [{ templateId: "AthenaPickaxe:test", cosmetic: { type: "Picareta" } }]
				}
			]
		}
	]
};

const SEASON = {
	seasonNumber: 38,
	seasonDateBegin: new Date(Date.now() - 10 * 86400000).toISOString(),
	seasonDateEnd: new Date(Date.now() + 20 * 86400000 - 3600000).toISOString(),
	exTime: 0
};

const calls = [];
let routes = {};

function httpError(status) {
	return Object.assign(new Error(`Request failed with status code ${status}`), {
		response: { status, data: { title: "erro", status } }
	});
}

axios.get = async (url, options = {}) => {
	calls.push({ url, options });
	const path = url.replace("https://prod.api-fortnite.com/api", "");
	const route = routes[path];
	if (route === undefined) throw httpError(404);
	if (typeof route === "number") throw httpError(route);
	return { status: 200, data: route };
};

function reset(newRoutes) {
	Fortnite.clearCache();
	calls.length = 0;
	routes = newRoutes;
}

function msg(content) {
	return createMessage({ content, group: GROUP, author: USER });
}

async function runTests() {
	const bot = new FakeBot({ id: "teste", grupoLogs: "logs@g.us" });

	console.log("[1] summarizeStats agrega por modo e ignora chaves fora do padrão");
	const totals = Fortnite.summarizeStats(STATS.stats);
	assert.deepStrictEqual(totals.geral, { wins: 17, kills: 227, matches: 108, minutes: 600 });
	assert.deepStrictEqual(totals.solo, { wins: 12, kills: 180, matches: 80, minutes: 600 });
	assert.deepStrictEqual(totals.squad, { wins: 5, kills: 40, matches: 25, minutes: 0 });
	assert.deepStrictEqual(totals.duo, { wins: 0, kills: 0, matches: 0, minutes: 0 });

	console.log("[2] Sem FORTNITE_API_KEY: avisa que falta configurar e não chama a API");
	reset({});
	let res = await Fortnite.fortnitePlayerCommand(bot, msg("!fortnite Teste"), ["Teste"]);
	assert.ok(res.content.includes("configurados pelo administrador"), res.content);
	res = await Fortnite.fortniteShopCommand(bot, msg("!fortnite-loja"), []);
	assert.ok(res.content.includes("configurados pelo administrador"), res.content);
	assert.strictEqual(calls.length, 0);

	process.env.FORTNITE_API_KEY = "chave-sintetica";

	console.log("[3] !fortnite sem nick pede o nome Epic");
	res = await Fortnite.fortnitePlayerCommand(bot, msg("!fortnite"), []);
	assert.ok(res.content.includes("Informe o nome Epic"), res.content);

	console.log("[4] !fortnite com nick: conta Epic, depois estatísticas");
	reset({
		"/v1/account/displayName/Jogador%20Teste": { id: ACCOUNT_ID, displayName: "Jogador Teste" },
		[`/v2/stats/${ACCOUNT_ID}`]: STATS
	});
	res = await Fortnite.fortnitePlayerCommand(bot, msg("!fortnite Jogador Teste"), [
		"Jogador",
		"Teste"
	]);
	assert.strictEqual(res.chatId, GROUP);
	assert.strictEqual(calls.length, 2);
	assert.strictEqual(calls[0].options.headers["x-api-key"], "chave-sintetica");
	const text = res.content;
	assert.ok(text.includes("*Fortnite - Jogador Teste*"), text);
	assert.ok(text.includes("Vitórias: *17* (15,74%)"), text);
	assert.ok(text.includes("Partidas: *108*"), text);
	assert.ok(text.includes("Abates: *227* | K/D: *2,49*"), text);
	assert.ok(text.includes("Tempo jogado: *10 h*"), text);
	assert.ok(text.includes("👤 Solo: 12 vitórias em 80 partidas, 180 abates (K/D 2,65)"), text);
	assert.ok(text.includes("🪖 Esquadrão: 5 vitórias em 25 partidas, 40 abates (K/D 2,00)"), text);
	assert.ok(!text.includes("Dupla"), "modo sem partidas não aparece");
	console.log(text);

	console.log("[5] Segunda consulta do mesmo nick sai do cache");
	await Fortnite.fortnitePlayerCommand(bot, msg("!fortnite jogador teste"), ["jogador", "teste"]);
	assert.strictEqual(calls.length, 2);

	console.log("[6] Erros da API viram mensagens claras");
	reset({});
	res = await Fortnite.fortnitePlayerCommand(bot, msg("!fortnite Ninguem"), ["Ninguem"]);
	assert.ok(res.content.includes("Jogador não encontrado"), res.content);
	reset({
		"/v1/account/displayName/Privado": { id: ACCOUNT_ID },
		[`/v2/stats/${ACCOUNT_ID}`]: 403
	});
	res = await Fortnite.fortnitePlayerCommand(bot, msg("!fortnite Privado"), ["Privado"]);
	assert.ok(res.content.includes("estão privadas"), res.content);
	reset({ "/v1/account/displayName/Muito": 429 });
	res = await Fortnite.fortnitePlayerCommand(bot, msg("!fortnite Muito"), ["Muito"]);
	assert.ok(res.content.includes("Muitas consultas"), res.content);
	reset({ "/v1/account/displayName/Chave": 401 });
	res = await Fortnite.fortnitePlayerCommand(bot, msg("!fortnite Chave"), ["Chave"]);
	assert.ok(res.content.includes("chave da API"), res.content);
	reset({ "/v1/account/displayName/Caiu": 500 });
	res = await Fortnite.fortnitePlayerCommand(bot, msg("!fortnite Caiu"), ["Caiu"]);
	assert.ok(res.content.includes("Não consegui falar"), res.content);

	console.log("[7] !fortnite-loja lista por seção com preço e desconto");
	reset({ "/v1/shop": SHOP });
	res = await Fortnite.fortniteShopCommand(bot, msg("!fortnite-loja"), []);
	assert.strictEqual(calls[0].options.params.lang, "pt-BR");
	assert.ok(res.content.includes("Loja do Fortnite de hoje* (2 ofertas)"), res.content);
	assert.ok(
		res.content.includes("*Em destaque*\n• Peely Ação - 1.200 V-Bucks ~1.500~"),
		res.content
	);
	assert.ok(res.content.includes("*Diário*\n• Picareta Banana - 800 V-Bucks\n"), res.content);
	assert.ok(
		res.content.indexOf("Em destaque") < res.content.indexOf("Diário"),
		"seção de maior prioridade primeiro"
	);
	console.log(res.content);

	console.log("[8] !fortnite-loja <item> manda a imagem com a legenda, buscando no cache");
	res = await Fortnite.fortniteShopCommand(bot, msg("!fortnite-loja peely acao"), [
		"peely",
		"acao"
	]);
	assert.strictEqual(calls.length, 1);
	assert.strictEqual(res.content.url, "https://cdn.example.com/peely.png");
	assert.ok(res.options.caption.includes("*Peely Ação* - 1.200 V-Bucks"), res.options.caption);
	assert.ok(res.options.caption.includes("Traje, Épico"), res.options.caption);
	res = await Fortnite.fortniteShopCommand(bot, msg("!fortnite-loja picareta"), ["picareta"]);
	assert.strictEqual(typeof res.content, "string", "sem imagem vai só o texto");
	assert.ok(res.content.includes("*Picareta Banana* - 800 V-Bucks"), res.content);
	res = await Fortnite.fortniteShopCommand(bot, msg("!fortnite-loja dragao"), ["dragao"]);
	assert.ok(res.content.includes('Nada com "dragao"'), res.content);

	console.log("[9] !fortnite-temporada");
	reset({ "/v1/season": SEASON });
	res = await Fortnite.fortniteSeasonCommand(bot, msg("!fortnite-temporada"), []);
	assert.ok(res.content.includes("Temporada: *38*"), res.content);
	assert.ok(res.content.includes("(faltam 20 dias)"), res.content);
	console.log(res.content);

	console.log("[10] Pipeline: !fn-temporada chega ao comando pelo alias");
	const EventHandler = require("../EventHandler");
	const eventHandler = new EventHandler();
	await new Promise((r) => setTimeout(r, 1500));
	reset({ "/v1/season": SEASON });
	bot.resetCapture();
	await eventHandler.processMessage(bot, msg("!fn-temporada"));
	await new Promise((r) => setTimeout(r, 1500));
	const sent = bot.capturedMessages.map((m) => (typeof m.content === "string" ? m.content : ""));
	assert.ok(
		sent.some((c) => c.includes("Temporada: *38*")),
		`resposta do pipeline: ${JSON.stringify(sent)}`
	);

	console.log("\n✅ Todos os testes de Fortnite passaram.");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha:", err);
		process.exit(1);
	});
