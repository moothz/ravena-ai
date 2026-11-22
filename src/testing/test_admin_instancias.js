// src/testing/test_admin_instancias.js
// Regras puras da área Instâncias do /admin (public/admin/areas/instancias/modelo.js, módulo ES
// sem DOM): estado e filtros, formulário ⇄ bots.json (as mesmas regras da tela antiga
// /instances), extras, validação, nova instância, respostas das ações e markup do WhatsApp.

const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

async function runTests() {
	console.log("=== Teste da área Instâncias do /admin (modelo.js) ===");
	const m = await import(
		pathToFileURL(path.join(__dirname, "../../public/admin/areas/instancias/modelo.js")).href
	);

	// Estado
	const on = { nome: "a", enabled: true, connected: true, isLive: true };
	const desc = { nome: "b", enabled: true, connected: false, isLive: true };
	const parada = { nome: "c", connected: false, isLive: false };
	const off = { nome: "d", enabled: false, connected: true };
	const ban = { nome: "e", enabled: true, banido: true, connected: true, useTelegram: true };
	assert.strictEqual(m.botState(on).key, "online");
	assert.strictEqual(m.botState(desc).key, "desconectada");
	assert.strictEqual(m.botState(desc).lamp, "attention");
	assert.strictEqual(m.botState(parada).key, "parada");
	assert.strictEqual(m.botState(off).key, "desativada");
	assert.strictEqual(m.botState(ban).key, "banida");
	assert.strictEqual(m.isOnline(ban), false, "banida conectada não conta como online");
	assert.strictEqual(m.platformOf(ban), "telegram");
	assert.strictEqual(m.platformOf({ useDiscord: true }), "discord");
	assert.strictEqual(m.platformOf({}), "whatsapp");
	console.log("✓ estado (online, desconectada, parada, desativada, banida) e plataforma.");

	// Filtros e busca
	const all = [on, desc, parada, off, ban];
	const names = (o) => m.filterBots(all, o).map((b) => b.nome);
	assert.deepStrictEqual(names({ filtro: "online" }), ["a"]);
	assert.deepStrictEqual(names({ filtro: "paradas" }), ["b", "c", "e"]);
	assert.deepStrictEqual(names({ filtro: "desativadas" }), ["d"]);
	assert.deepStrictEqual(names({ filtro: "ativas" }), ["a", "b", "c", "e"]);
	assert.deepStrictEqual(names({ filtro: "offline" }), ["b", "c", "d", "e"]);
	assert.deepStrictEqual(names({ plataforma: "telegram" }), ["e"]);
	assert.deepStrictEqual(names({ filtro: "xyz" }), ["a", "b", "c", "d", "e"]);
	assert.ok(m.matchesSearch({ nome: "rav-1", numero: "5511999" }, "5511"));
	assert.ok(m.matchesSearch({ nome: "x", nomeExibir: "Ravena VIP" }, "vip"));
	assert.ok(m.matchesSearch({ nome: "x", telegramBotName: "RavenoBot" }, "raveno"));
	assert.ok(!m.matchesSearch({ nome: "x" }, "y"));
	const s = m.summarize([
		{ ...on, groupsCount: 3, msgsHr: 10.4, privado: true },
		{ ...off, groupsCount: 2, msgsHr: 1.6 }
	]);
	assert.deepStrictEqual(s, {
		total: 2,
		enabled: 1,
		disabled: 1,
		online: 1,
		offline: 1,
		privado: 1,
		groups: 5,
		msgsHr: 12
	});
	console.log("✓ filtros da tela antiga + do mock, busca e resumo.");

	// Texto
	assert.strictEqual(m.formatPhone("5511987654321"), "+55 (11) 98765-4321");
	assert.strictEqual(m.formatPhone("551187654321"), "+55 (11) 8765-4321");
	assert.strictEqual(m.formatPhone(""), "—");
	assert.strictEqual(m.chatUrl({ numero: "+55 11 9" }), "https://wa.me/55119");
	assert.strictEqual(
		m.chatUrl({ numero: "1", useTelegram: true, telegramBotName: "rb" }),
		"https://t.me/rb"
	);
	assert.strictEqual(m.chatUrl({ nome: "x" }), null);
	console.log("✓ telefone e link de conversa.");

	// Formulário ⇄ bots.json
	const bot = {
		nome: "rav-1",
		numero: "55119",
		enabled: true,
		privado: true,
		linkGrupao: "https://chat.whatsapp.com/x",
		supportMsg: "antigo",
		telegramBotToken: "sobra",
		extras: { stickers: { maxFiga: 3 } },
		_runtime: {},
		connected: true,
		msgsHr: 4
	};
	const v = m.formValues(bot);
	assert.strictEqual(v.plataforma, "whatsapp");
	assert.strictEqual(v.customPrefix, "!");
	assert.strictEqual(v.updateStatus, true, "updateStatus vem ligado por padrão");
	assert.strictEqual(v.msgSuporte, "antigo", "msgSuporte cai para supportMsg");
	assert.strictEqual(v.delayMax, "0", "privado: delayMax padrão 0");
	assert.strictEqual(m.formValues({}).delayMax, "2");
	assert.strictEqual(v.deleteMessagesInterval, "false");
	let out = m.applyConfig(bot, v, undefined);
	assert.strictEqual(out.linkGrupao, bot.linkGrupao, "campo desconhecido preservado");
	assert.deepStrictEqual(out.extras, bot.extras, "extras mantidos quando não passados");
	assert.ok(!("telegramBotToken" in out), "campos do Telegram somem fora do Telegram");
	for (const k of m.RUNTIME_KEYS) assert.ok(!(k in out), `sem ${k}`);
	assert.strictEqual(out.grupoLogs, null);
	assert.strictEqual(out.webhookPort, null);
	assert.strictEqual(out.deleteMessagesInterval, false);
	assert.strictEqual(out.useTelegram, false);
	out = m.applyConfig(bot, {
		...v,
		plataforma: "telegram",
		telegramBotName: " rb ",
		webhookHost: "",
		nomeExibir: "",
		customPrefix: "",
		ratelimit: "900",
		delayMin: "-1",
		delayMax: "7",
		deleteMessagesInterval: "7",
		webhookPort: "6200",
		dataMorte: "20/11/2026"
	});
	assert.strictEqual(out.useTelegram, true);
	assert.strictEqual(out.telegramBotName, "rb");
	assert.strictEqual(out.webhookHost, null);
	assert.strictEqual(out.nomeExibir, "rav-1", "nomeExibir vazio vira o nome");
	assert.strictEqual(out.customPrefix, "!");
	assert.strictEqual(out.ratelimit, 600);
	assert.strictEqual(out.delayMin, 0);
	assert.strictEqual(out.delayMax, 5);
	assert.strictEqual(out.deleteMessagesInterval, 7);
	assert.strictEqual(out.webhookPort, 6200);
	assert.strictEqual(out.dataMorte, "20/11/2026");
	assert.ok(!("dataNascimento" in out));
	assert.strictEqual(
		m.applyConfig(bot, { ...v, deleteMessagesInterval: "abc" }).deleteMessagesInterval,
		false
	);
	assert.strictEqual(
		m.applyConfig({}, { plataforma: "discord", discordToken: "t" }).discordToken,
		"t"
	);
	assert.ok(m.showsCemiterio({ banido: true, enabled: false }));
	assert.ok(!m.showsCemiterio({ banido: true, enabled: true }));
	console.log("✓ formValues/applyConfig com as regras da tela antiga.");

	// Extras
	const rows = m.extrasToRows({ a: { s: "x", n: 2, b: true }, vazia: {} });
	assert.deepStrictEqual(
		rows[0].props.map((p) => p.type),
		["string", "number", "boolean"]
	);
	rows[0].props.push({ key: " ", type: "string", value: "descartada" });
	rows[0].props[1].type = "string";
	assert.deepStrictEqual(m.rowsToExtras(rows), { a: { s: "x", n: "2", b: true }, vazia: {} });
	assert.strictEqual(m.cleanExtraKey(" jo gos!*"), "jogos");
	assert.strictEqual(m.castExtra("abc", "number"), 0);
	assert.strictEqual(m.castExtra("true", "boolean"), true);
	assert.strictEqual(m.castExtra(3, "string"), "3");
	console.log("✓ extras em 3 níveis.");

	// Validação e lista do POST
	assert.strictEqual(m.validateBots([{ nome: "a", numero: "1" }]), null);
	assert.match(m.validateBots([{ nome: "" }]), /identificador/);
	assert.match(m.validateBots([{ nome: "a" }]), /número/);
	assert.strictEqual(m.validateBots([{ nome: "a", useDiscord: true }]), null);
	assert.match(
		m.validateBots([
			{ nome: "a", numero: "1" },
			{ nome: "a", numero: "2" }
		]),
		/duas/
	);
	const list = m.buildSaveList(
		[
			{ nome: "a", connected: true, x: 1 },
			{ nome: "b", isLive: true }
		],
		new Map([["b", { nome: "b", y: 2 }]]),
		[{ nome: "novo" }]
	);
	assert.deepStrictEqual(list, [{ nome: "novo" }, { nome: "a", x: 1 }, { nome: "b", y: 2 }]);
	console.log("✓ validação e montagem do POST /api/bots.");

	// Nova instância
	let i = 0;
	const seq = [0, 0, 5]; // 1ª tentativa colide com rav-1000
	const rand = (n) => (i < seq.length ? seq[i++] : 0) % n;
	const nb = m.newBot([{ nome: "rav-1000", webhookPort: 6200 }, { webhookPort: "x" }], rand);
	assert.strictEqual(nb.nome, "rav-1005");
	assert.strictEqual(nb.enabled, false);
	assert.strictEqual(nb.webhookPort, 6201);
	assert.strictEqual(nb.managementPW.length, 16);
	assert.ok(nb.pvAI && nb.updateStatus && nb.sendJoinInfo);
	assert.strictEqual(m.nextWebhookPort([]), 14000);
	assert.strictEqual(
		m.generatePassword(8, () => 0),
		"aaaaaaaa"
	);
	assert.ok([...m.generatePassword(64)].every((c) => m.PW_CHARS.includes(c)));
	console.log("✓ nova instância com os padrões da tela antiga.");

	// Respostas das ações
	assert.deepStrictEqual(m.actionOutcome({ status: "ok", message: "Reiniciado" }), {
		ok: true,
		message: "Reiniciado"
	});
	assert.deepStrictEqual(m.actionOutcome({ status: "error", message: {} }), {
		ok: false,
		message: ""
	});
	assert.strictEqual(
		m.actionOutcome({ status: "error", message: { message: "sem ws" } }).message,
		"sem ws"
	);
	assert.strictEqual(m.actionOutcome(null).ok, true);
	const rec = m.actionOutcome({
		status: "ok",
		message: "Recreation process finished.",
		details: [
			{ action: "delete", status: "error", error: "ECONNREFUSED" },
			{ action: "create", status: "error", attempt: 1, error: "ECONNREFUSED" },
			{ action: "create", status: "error", attempt: 2, error: "ECONNREFUSED" }
		]
	});
	assert.deepStrictEqual(rec, {
		ok: false,
		message: "delete: ECONNREFUSED; create (2×): ECONNREFUSED"
	});
	const rec2 = m.actionOutcome({
		status: "ok",
		message: "fim",
		details: [
			{ action: "delete", status: "error", error: "404" },
			{ action: "create", status: "success" }
		]
	});
	assert.deepStrictEqual(rec2, { ok: true, message: "fim (com avisos: delete: 404)" });
	console.log(
		"✓ /restart com status error e /recreate com todos os passos falhos contam como falha."
	);

	// Avisos
	const now = Date.UTC(2026, 10, 21, 15);
	assert.strictEqual(m.validateAnnouncement(" ", "x", now).field, "message");
	assert.strictEqual(m.validateAnnouncement("oi", "", now).field, "expires");
	assert.strictEqual(m.validateAnnouncement("oi", "2020-01-01T00:00", now).field, "expires");
	assert.ok(m.validateAnnouncement("oi", "2099-01-01T00:00", now).expiresAt > now);
	assert.deepStrictEqual(m.insertAround("ab", 0, 2, "*", "*"), { value: "*ab*", cursor: 4 });
	assert.deepStrictEqual(m.insertAround("ab", 1, 1, "_", "_"), { value: "a__b", cursor: 2 });
	assert.match(m.toDatetimeLocal(Date.now()), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
	console.log("✓ validação do aviso, inserção no cursor e datetime-local.");

	// Markup do WhatsApp
	assert.deepStrictEqual(m.parseWaMarkup("*oi* _a_ ~b~"), [
		{ t: "b", c: ["oi"] },
		" ",
		{ t: "i", c: ["a"] },
		" ",
		{ t: "s", c: ["b"] }
	]);
	assert.deepStrictEqual(
		m.parseWaMarkup("2*3*4"),
		["2*3*4"],
		"asterisco no meio de palavra não é negrito"
	);
	assert.deepStrictEqual(m.parseWaMarkup("a\nb"), ["a", { t: "br" }, "b"]);
	assert.deepStrictEqual(m.parseWaMarkup("> x\n> *y*\nz"), [
		{ t: "quote", c: ["x", { t: "br" }, { t: "b", c: ["y"] }] },
		"z"
	]);
	assert.deepStrictEqual(m.parseWaMarkup("```*n*```"), [{ t: "pre", text: "*n*" }]);
	assert.deepStrictEqual(m.parseWaMarkup("ver `*x*` em https://a.b/c"), [
		"ver ",
		{ t: "code", text: "*x*" },
		" em ",
		{ t: "a", href: "https://a.b/c", text: "https://a.b/c" }
	]);
	assert.deepStrictEqual(m.parseWaMarkup("<b>"), ["<b>"], "HTML fica como texto");
	assert.deepStrictEqual(m.parseWaMarkup("*_ab_*"), [{ t: "b", c: [{ t: "i", c: ["ab"] }] }]);
	assert.deepStrictEqual(m.parseWaMarkup(""), []);
	console.log("✓ markup do WhatsApp sem HTML.");

	console.log("=== Instâncias: tudo certo ===");
}

runTests().catch((err) => {
	console.error(err);
	process.exit(1);
});
