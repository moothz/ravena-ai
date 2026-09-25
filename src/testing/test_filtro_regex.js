process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const Group = require("../models/Group");
const Management = require("../commands/Management");
const { createMessage } = require("./FakeMessage");
const { validateRegexFilter, buildRegex } = require("../utils/RegexFilterValidator");

async function runTests() {
	console.log("=== INICIANDO TESTES DO FILTRO REGEX ===");

	// ----------------------------------------------------
	// 1. TESTES UNITÁRIOS DE VALIDAÇÃO DE REGEX
	// ----------------------------------------------------
	console.log("\n--- Teste 1: Validação de Regex e Segurança ---");

	// 1.1 Regex válidos e seguros
	const safePatterns = [
		"\\b(cassino|aposta|tigrinho)\\b",
		"/palavr[aã]o/i",
		"t\\.me\\/[a-zA-Z0-9_]+",
		"[0-9]{10,}",
		"chave\\s+pix",
		"badword[0-9]+"
	];
	for (const pattern of safePatterns) {
		const res = validateRegexFilter(pattern);
		assert.strictEqual(
			res.valid,
			true,
			`Esperado padrão "${pattern}" ser considerado válido, erro: ${res.error}`
		);
	}
	console.log("✓ Padrões válidos e seguros foram aceitos com sucesso.");

	// 1.2 Regex perigosos ou muito abrangentes (devem ser rejeitados)
	const dangerousPatterns = [
		"", // vazio
		"a", // muito curto (1 char)
		".", // muito curto (1 char)
		".*", // casa com vazio
		".+", // casa com espaço avulso
		"^", // casa com vazio
		"$", // casa com vazio
		"\\s*", // casa com vazio
		"\\s+", // casa com espaço
		"\\w*", // casa com vazio
		"\\w+", // casa com palavras neutras comuns
		"[a-z]+", // casa com mensagens neutras
		"a*", // casa com vazio
		"spam|", // casa com vazio na alternativa vazia
		"|spam", // casa com vazio
		"(a|b|)", // alternativa vazia
		"[a-z", // sintaxe inválida
		"*invalid" // sintaxe inválida
	];
	for (const pattern of dangerousPatterns) {
		const res = validateRegexFilter(pattern);
		assert.strictEqual(
			res.valid,
			false,
			`Esperado padrão perigoso/inválido "${pattern}" ser rejeitado, mas foi aceito!`
		);
	}
	console.log("✓ Todos os padrões perigosos/abrangentes foram rejeitados corretamente.");

	// ----------------------------------------------------
	// 2. TESTES DE COMANDO (!g-filtro-regex no Management)
	// ----------------------------------------------------
	console.log("\n--- Teste 2: Comando !g-filtro-regex (Management.js) ---");

	const bot = new FakeBot({ id: "test-bot" });
	const management = new Management();
	const groupId = "120363000000000000@g.us";
	const adminId = "5511999990001@s.whatsapp.net";

	const group = new Group({
		id: groupId,
		name: "Grupo Teste Regex",
		additionalAdmins: [adminId],
		filters: {
			words: [],
			regexes: [],
			links: false,
			allowAdmins: false
		}
	});

	await management.database.saveGroup(group);

	// 2.1 Listar quando vazio
	let ret = await management.filterRegex(
		bot,
		createMessage({ author: adminId, group: groupId }),
		[],
		group
	);
	assert.ok(
		ret.content.includes("Nenhum regex filtrado"),
		"Deveria informar que nenhum regex está filtrado"
	);
	console.log("✓ Listagem vazia funcionou.");

	// 2.2 Tentar adicionar regex muito abrangente
	ret = await management.filterRegex(
		bot,
		createMessage({ author: adminId, group: groupId }),
		[".*"],
		group
	);
	assert.ok(
		ret.content.includes("Não foi possível adicionar o regex"),
		"Deveria rejeitar regex abrangente .*"
	);
	assert.strictEqual(group.filters.regexes.length, 0);
	console.log("✓ Rejeição de regex abrangente no comando funcionou.");

	// 2.3 Adicionar regex válido
	ret = await management.filterRegex(
		bot,
		createMessage({ author: adminId, group: groupId }),
		["\\b(cassino|tigrinho)\\b"],
		group
	);
	assert.ok(
		ret.content.includes("Regex adicionado ao filtro"),
		"Deveria confirmar adição do regex"
	);
	assert.strictEqual(group.filters.regexes.length, 1);
	assert.strictEqual(group.filters.regexes[0], "\\b(cassino|tigrinho)\\b");
	console.log("✓ Adição de regex válido funcionou.");

	// 2.4 Listar regexes com 1 item
	ret = await management.filterRegex(
		bot,
		createMessage({ author: adminId, group: groupId }),
		[],
		group
	);
	assert.ok(
		ret.content.includes("\\b(cassino|tigrinho)\\b"),
		"Listagem deve conter o regex cadastrado"
	);
	console.log("✓ Listagem com item funcionou.");

	// 2.5 Remover regex usando o mesmo comando (toggle)
	ret = await management.filterRegex(
		bot,
		createMessage({ author: adminId, group: groupId }),
		["\\b(cassino|tigrinho)\\b"],
		group
	);
	assert.ok(ret.content.includes("Regex removido do filtro"), "Deveria confirmar remoção do regex");
	assert.strictEqual(group.filters.regexes.length, 0);
	console.log("✓ Remoção de regex funcionou.");

	// ----------------------------------------------------
	// 3. TESTES DE FILTRAGEM NO EVENTHANDLER (applyFilters)
	// ----------------------------------------------------
	console.log("\n--- Teste 3: Execução de Filtro no EventHandler ---");

	const eventHandler = new EventHandler();
	const normalUserId = "5511999990003@s.whatsapp.net";

	group.filters.regexes = ["\\b(cassino|tigrinho)\\b", "/pix\\s*:\\s*\\d+/i"];
	group.filters.allowAdmins = false;
	await eventHandler.database.saveGroup(group);

	// 3.1 Mensagem normal sem correspondência -> NÃO deve filtrar
	let wasDeleted = false;
	const msgNormal = createMessage({
		author: normalUserId,
		group: groupId,
		content: "Olá pessoal, bom dia a todos!"
	});
	msgNormal.origin.delete = async () => {
		wasDeleted = true;
	};

	let filtered = await eventHandler.applyFilters(bot, msgNormal, group);
	await new Promise((r) => setTimeout(r, 20));
	assert.strictEqual(filtered, false, "Mensagem normal não deveria ser filtrada");
	assert.strictEqual(wasDeleted, false, "Mensagem normal não deveria ser deletada");
	console.log("✓ Mensagem normal passou sem ser filtrada.");

	// 3.2 Mensagem com padrão proibido 1 -> DEVE filtrar e deletar
	wasDeleted = false;
	const msgCassino = createMessage({
		author: normalUserId,
		group: groupId,
		content: "Venha jogar no cassino online agora!"
	});
	msgCassino.origin.delete = async () => {
		wasDeleted = true;
	};

	filtered = await eventHandler.applyFilters(bot, msgCassino, group);
	await new Promise((r) => setTimeout(r, 20));
	assert.strictEqual(filtered, true, "Mensagem com cassino deveria ser filtrada");
	assert.strictEqual(wasDeleted, true, "Mensagem com cassino deveria ser deletada");
	console.log("✓ Mensagem contendo termo de regex foi filtrada e deletada com sucesso.");

	// 3.3 Mensagem com padrão proibido 2 (notação com flags) -> DEVE filtrar
	wasDeleted = false;
	const msgPix = createMessage({
		author: normalUserId,
		group: groupId,
		content: "Manda o dinheiro no PIX: 12345678"
	});
	msgPix.origin.delete = async () => {
		wasDeleted = true;
	};

	filtered = await eventHandler.applyFilters(bot, msgPix, group);
	await new Promise((r) => setTimeout(r, 20));
	assert.strictEqual(filtered, true, "Mensagem com PIX deveria ser filtrada");
	assert.strictEqual(wasDeleted, true, "Mensagem com PIX deveria ser deletada");
	console.log("✓ Mensagem com regex formato /padrão/flags foi filtrada com sucesso.");

	// 3.4 Isenção para admin quando allowAdmins = true
	group.filters.allowAdmins = true;
	await eventHandler.database.saveGroup(group);

	bot.client.getChatById = async (id) => {
		if (id === groupId) {
			return {
				id: { _serialized: groupId },
				isGroup: true,
				participants: [
					{ id: { _serialized: bot.phoneNumber }, isAdmin: true },
					{ id: { _serialized: adminId }, isAdmin: true },
					{ id: { _serialized: normalUserId }, isAdmin: false }
				]
			};
		}
		return null;
	};

	wasDeleted = false;
	const msgAdmin = createMessage({
		author: adminId,
		group: groupId,
		content: "Admin falando sobre cassino sem problemas"
	});
	msgAdmin.origin.getChat = async () => ({
		participants: [
			{ id: { _serialized: adminId }, isAdmin: true },
			{ id: { _serialized: normalUserId }, isAdmin: false }
		]
	});
	msgAdmin.origin.delete = async () => {
		wasDeleted = true;
	};

	filtered = await eventHandler.applyFilters(bot, msgAdmin, group);
	await new Promise((r) => setTimeout(r, 20));
	assert.strictEqual(
		filtered,
		false,
		"Mensagem de admin com allowAdmins=true não deve ser filtrada"
	);
	assert.strictEqual(wasDeleted, false, "Mensagem de admin não deve ser deletada");
	console.log("✓ Isenção de admin funcionou corretamente.");

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("ERRO NO TESTE:", err);
		process.exit(1);
	});
