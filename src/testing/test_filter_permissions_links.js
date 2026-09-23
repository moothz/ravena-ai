process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const Group = require("../models/Group");
const { createMessage } = require("./FakeMessage");

async function runTests() {
	console.log("=== INICIANDO TESTES DE FILTROS (ADMIN E LINKS) ===");

	const bot = new FakeBot({ id: "test-bot" });
	const eventHandler = new EventHandler();

	const groupId = "120363000000000000@g.us";
	const adminId = "5511999990001@s.whatsapp.net";
	const additionalAdminId = "5511999990002@s.whatsapp.net";
	const normalUserId = "5511999990003@s.whatsapp.net";

	// Cria o grupo de teste
	const group = new Group({
		id: groupId,
		name: "Grupo Teste Filtros",
		additionalAdmins: [additionalAdminId],
		filters: {
			words: ["palavraproibida"],
			links: true,
			allowedLinks: [],
			allowAdmins: false
		}
	});

	await eventHandler.database.saveGroup(group);

	// Mock para simular que bot é admin e adminId é admin no grupo
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

	// ----------------------------------------------------
	// TESTE 1: Isenção de Administradores (allowAdmins)
	// ----------------------------------------------------
	console.log("\n--- Teste 1: Isenção de Administradores ---");

	// 1.1: Usuário comum envia palavra proibida com allowAdmins = false -> DEVE FILTRAR
	let deletedCount = 0;
	const msgNormalPalavra = createMessage({
		author: normalUserId,
		group: groupId,
		content: "Olá, aqui tem palavraproibida no meio"
	});
	msgNormalPalavra.origin.delete = async () => {
		deletedCount++;
	};

	let filtered = await eventHandler.applyFilters(bot, msgNormalPalavra, group);
	assert.strictEqual(
		filtered,
		true,
		"Mensagem de usuário comum com palavra proibida deve ser filtrada"
	);
	assert.strictEqual(deletedCount, 1, "Mensagem deve ter sido deletada");
	console.log("✓ Usuário comum com palavra proibida filtrado com sucesso");

	// 1.2: Admin envia palavra proibida com allowAdmins = false -> DEVE FILTRAR
	deletedCount = 0;
	const msgAdminPalavraBloqueada = createMessage({
		author: adminId,
		group: groupId,
		content: "Admin falando palavraproibida"
	});
	msgAdminPalavraBloqueada.origin.delete = async () => {
		deletedCount++;
	};

	filtered = await eventHandler.applyFilters(bot, msgAdminPalavraBloqueada, group);
	assert.strictEqual(filtered, true, "Com allowAdmins = false, admin deve ser filtrado");
	assert.strictEqual(
		deletedCount,
		1,
		"Mensagem do admin deve ser deletada quando allowAdmins = false"
	);
	console.log("✓ Admin filtrado normalmente quando allowAdmins = false");

	// Helper para executar comandos simulando o EventHandler
	async function executeCmd(cmdMsg, grp) {
		const textWithoutPrefix = cmdMsg.content.replace(/^[!]/, "").trim();
		const [command, ...args] = textWithoutPrefix.split(/\s+/);
		cmdMsg.groupChat = {
			isGroup: true,
			id: { _serialized: grp.id },
			participants: [
				{ id: { _serialized: bot.phoneNumber }, isAdmin: true },
				{ id: { _serialized: adminId }, isAdmin: true },
				{ id: { _serialized: additionalAdminId }, isAdmin: true },
				{ id: { _serialized: normalUserId }, isAdmin: false }
			]
		};
		cmdMsg.origin.getChat = async () => cmdMsg.groupChat;
		return await eventHandler.commandHandler.processCommand(bot, cmdMsg, command, args, grp);
	}

	// 1.3: Ativa allowAdmins via comando !g-filtro-permitirAdm
	const cmdPermitirAdm = createMessage({
		author: adminId,
		group: groupId,
		content: "!g-filtro-permitirAdm"
	});
	const respPermitirAdm = await executeCmd(cmdPermitirAdm, group);
	assert.ok(respPermitirAdm, "Comando !g-filtro-permitirAdm deve retornar resposta");
	const updatedGroup1 = await eventHandler.database.getGroup(groupId);
	assert.strictEqual(
		updatedGroup1.filters.allowAdmins,
		true,
		"allowAdmins deve ser true após comando"
	);
	console.log("✓ Comando !g-filtro-permitirAdm ativou a flag no banco de dados");

	// 1.4: Admin nativo envia palavra proibida com allowAdmins = true -> NÃO DEVE FILTRAR
	deletedCount = 0;
	const msgAdminPalavraLivre = createMessage({
		author: adminId,
		group: groupId,
		content: "Admin falando palavraproibida livremente"
	});
	msgAdminPalavraLivre.origin.delete = async () => {
		deletedCount++;
	};

	filtered = await eventHandler.applyFilters(bot, msgAdminPalavraLivre, updatedGroup1);
	assert.strictEqual(filtered, false, "Com allowAdmins = true, admin nativo NÃO deve ser filtrado");
	assert.strictEqual(deletedCount, 0, "Mensagem do admin não deve ser deletada");
	console.log("✓ Admin nativo isento de filtros com allowAdmins = true");

	// 1.5: Admin adicional envia link proibido com allowAdmins = true -> NÃO DEVE FILTRAR
	deletedCount = 0;
	const msgAddAdminLink = createMessage({
		author: additionalAdminId,
		group: groupId,
		content: "Admin adicional mandando https://site-aleatorio.com"
	});
	msgAddAdminLink.origin.delete = async () => {
		deletedCount++;
	};

	filtered = await eventHandler.applyFilters(bot, msgAddAdminLink, updatedGroup1);
	assert.strictEqual(
		filtered,
		false,
		"Com allowAdmins = true, admin adicional NÃO deve ser filtrado"
	);
	assert.strictEqual(deletedCount, 0, "Mensagem do admin adicional não deve ser deletada");
	console.log("✓ Admin adicional isento de filtros com allowAdmins = true");

	// 1.6: Usuário comum continua sendo filtrado mesmo com allowAdmins = true
	deletedCount = 0;
	filtered = await eventHandler.applyFilters(bot, msgNormalPalavra, updatedGroup1);
	assert.strictEqual(filtered, true, "Usuário comum continua sendo filtrado");
	assert.strictEqual(deletedCount, 1, "Mensagem do usuário comum deve ser deletada");
	console.log("✓ Usuário comum continua filtrado com allowAdmins = true");

	// ----------------------------------------------------
	// TESTE 2: Filtro de Links, Wildcards e Domínios
	// ----------------------------------------------------
	console.log("\n--- Teste 2: Filtro de Links e Permissões ---");

	// 2.1: Link proibido quando allowedLinks = []
	deletedCount = 0;
	const msgLinkComum = createMessage({
		author: normalUserId,
		group: groupId,
		content: "Confira esse link: https://www.youtube.com/watch?v=123"
	});
	msgLinkComum.origin.delete = async () => {
		deletedCount++;
	};

	filtered = await eventHandler.applyFilters(bot, msgLinkComum, updatedGroup1);
	assert.strictEqual(filtered, true, "Sem allowedLinks, YouTube deve ser filtrado");
	assert.strictEqual(deletedCount, 1, "Mensagem com link deve ser deletada");
	console.log("✓ Link filtrado quando allowedLinks está vazio");

	// 2.2: Adiciona wildcard *youtube* via !g-filtro-permitirLink
	const cmdAddYoutube = createMessage({
		author: adminId,
		group: groupId,
		content: "!g-filtro-permitirLink *youtube*"
	});
	await executeCmd(cmdAddYoutube, updatedGroup1);
	const groupComYoutube = await eventHandler.database.getGroup(groupId);
	assert.ok(
		groupComYoutube.filters.allowedLinks.includes("*youtube*"),
		"allowedLinks deve conter *youtube*"
	);
	console.log("✓ *youtube* adicionado aos links permitidos");

	// 2.3: YouTube agora passa pelo filtro
	deletedCount = 0;
	filtered = await eventHandler.applyFilters(bot, msgLinkComum, groupComYoutube);
	assert.strictEqual(filtered, false, "Mensagem com YouTube deve ser permitida com *youtube*");
	assert.strictEqual(deletedCount, 0, "Mensagem com YouTube permitido não deve ser deletada");
	console.log("✓ Link do YouTube permitido com sucesso via *youtube*");

	// 2.4: Domínio falso com termo 'youtube' na query string NÃO deve passar (segurança!)
	deletedCount = 0;
	const msgAtaqueQuery = createMessage({
		author: normalUserId,
		group: groupId,
		content: "Acesse https://site-malicioso.com/?redirecionar=youtube"
	});
	msgAtaqueQuery.origin.delete = async () => {
		deletedCount++;
	};
	filtered = await eventHandler.applyFilters(bot, msgAtaqueQuery, groupComYoutube);
	assert.strictEqual(
		filtered,
		true,
		"Link com youtube apenas nos parâmetros da URL DEVE ser filtrado"
	);
	assert.strictEqual(deletedCount, 1, "Mensagem com ataque na query string deve ser deletada");
	console.log("✓ Segurança verificada: query parameter malicioso bloqueado");

	// 2.5: Adiciona domínio terra.com.br via URL completa: https://www.terra.com.br/noticias
	const cmdAddTerraUrl = createMessage({
		author: adminId,
		group: groupId,
		content: "!g-filtro-permitirLink https://www.terra.com.br/noticias/hoje"
	});
	const respTerra = await executeCmd(cmdAddTerraUrl, groupComYoutube);
	assert.ok(
		respTerra.content.includes("terra.com.br"),
		"Resposta deve mencionar o domínio terra.com.br extraído"
	);
	const groupComTerra = await eventHandler.database.getGroup(groupId);
	assert.ok(
		groupComTerra.filters.allowedLinks.includes("terra.com.br"),
		"allowedLinks deve conter terra.com.br"
	);
	console.log("✓ URL completa convertida inteligentemente em terra.com.br");

	// 2.6: Subdomínio de terra.com.br (noticias.terra.com.br) deve passar
	deletedCount = 0;
	const msgSubdominioTerra = createMessage({
		author: normalUserId,
		group: groupId,
		content: "Leia em https://noticias.terra.com.br/brasil"
	});
	msgSubdominioTerra.origin.delete = async () => {
		deletedCount++;
	};
	filtered = await eventHandler.applyFilters(bot, msgSubdominioTerra, groupComTerra);
	assert.strictEqual(filtered, false, "Subdomínio legítimo de terra.com.br deve ser permitido");
	assert.strictEqual(deletedCount, 0, "Subdomínio legítimo não deve ser deletado");
	console.log("✓ Subdomínio legítimo permitido");

	// 2.7: Domínio falso (terra.com.br.atacante.com) DEVE ser filtrado
	deletedCount = 0;
	const msgFalsoTerra = createMessage({
		author: normalUserId,
		group: groupId,
		content: "Golpe em https://terra.com.br.atacante.com/login"
	});
	msgFalsoTerra.origin.delete = async () => {
		deletedCount++;
	};
	filtered = await eventHandler.applyFilters(bot, msgFalsoTerra, groupComTerra);
	assert.strictEqual(
		filtered,
		true,
		"Domínio falso que termina com atacante.com deve ser filtrado"
	);
	assert.strictEqual(deletedCount, 1, "Domínio falso deve ser deletado");
	console.log("✓ Golpe de domínio falso (terra.com.br.atacante.com) bloqueado");

	// 2.8: Mensagem com múltiplos links (um permitido e um proibido) DEVE ser filtrada
	deletedCount = 0;
	const msgMista = createMessage({
		author: normalUserId,
		group: groupId,
		content: "Veja esse vídeo https://youtube.com/watch?v=1 e entre no https://cassino-golpe.com"
	});
	msgMista.origin.delete = async () => {
		deletedCount++;
	};
	filtered = await eventHandler.applyFilters(bot, msgMista, groupComTerra);
	assert.strictEqual(filtered, true, "Mensagem com ao menos um link proibido deve ser filtrada");
	assert.strictEqual(deletedCount, 1, "Mensagem mista deve ser deletada");
	console.log("✓ Mensagem mista com link confiável + link proibido devidamente bloqueada");

	// ----------------------------------------------------
	// TESTE 3: Comando !g-filtro-linksConfiaveis
	// ----------------------------------------------------
	console.log("\n--- Teste 3: Sites Confiáveis (!g-filtro-linksConfiaveis) ---");

	const cmdLinksConfiaveis = createMessage({
		author: adminId,
		group: groupId,
		content: "!g-filtro-linksConfiaveis"
	});
	const respConfiaveis = await executeCmd(cmdLinksConfiaveis, groupComTerra);
	assert.ok(
		respConfiaveis.content.includes("Mercado Livre"),
		"Resposta deve mencionar Mercado Livre"
	);
	assert.ok(respConfiaveis.content.includes("OLX"), "Resposta deve mencionar OLX");
	assert.ok(respConfiaveis.content.includes("Instagram"), "Resposta deve mencionar Instagram");

	const groupComConfiaveis = await eventHandler.database.getGroup(groupId);
	assert.ok(
		groupComConfiaveis.filters.allowedLinks.includes("mercadolivre.com.br"),
		"allowedLinks deve ter mercadolivre.com.br"
	);
	assert.ok(
		groupComConfiaveis.filters.allowedLinks.includes("olx.com.br"),
		"allowedLinks deve ter olx.com.br"
	);
	assert.ok(
		groupComConfiaveis.filters.allowedLinks.includes("instagram.com"),
		"allowedLinks deve ter instagram.com"
	);
	console.log("✓ Sites confiáveis adicionados em lote com sucesso");

	// Testar permissão de link do Instagram
	deletedCount = 0;
	const msgInstagram = createMessage({
		author: normalUserId,
		group: groupId,
		content: "Olha essa foto https://instagram.com/p/Cxyz123"
	});
	msgInstagram.origin.delete = async () => {
		deletedCount++;
	};
	filtered = await eventHandler.applyFilters(bot, msgInstagram, groupComConfiaveis);
	assert.strictEqual(
		filtered,
		false,
		"Instagram deve ser permitido após !g-filtro-linksConfiaveis"
	);
	assert.strictEqual(deletedCount, 0, "Instagram não deve ser deletado");
	console.log("✓ Link do Instagram permitido após linksConfiaveis");

	// Remover sites confiáveis via !g-filtro-linksConfiaveis remover
	const cmdRemoverConfiaveis = createMessage({
		author: adminId,
		group: groupId,
		content: "!g-filtro-linksConfiaveis remover"
	});
	const respRemover = await executeCmd(cmdRemoverConfiaveis, groupComConfiaveis);
	assert.ok(respRemover.content.includes("removidos"), "Resposta deve confirmar remoção");

	const groupAposRemocao = await eventHandler.database.getGroup(groupId);
	assert.strictEqual(
		groupAposRemocao.filters.allowedLinks.includes("instagram.com"),
		false,
		"instagram.com não deve mais estar na lista"
	);
	console.log("✓ !g-filtro-linksConfiaveis remover removeu sites confiáveis com sucesso");

	// ----------------------------------------------------
	// TESTE 4: Mensagem informativa do !g-filtro-links
	// ----------------------------------------------------
	console.log("\n--- Teste 4: Sugestões ao ativar !g-filtro-links ---");

	// Desativa primeiro
	const cmdToggle1 = createMessage({ author: adminId, group: groupId, content: "!g-filtro-links" });
	await executeCmd(cmdToggle1, groupAposRemocao);
	const gDesativado = await eventHandler.database.getGroup(groupId);
	assert.strictEqual(gDesativado.filters.links, false, "Filtro deve estar desativado");

	// Reativa
	const cmdToggle2 = createMessage({ author: adminId, group: groupId, content: "!g-filtro-links" });
	const respAtivado = await executeCmd(cmdToggle2, gDesativado);
	const gReativado = await eventHandler.database.getGroup(groupId);
	assert.strictEqual(gReativado.filters.links, true, "Filtro deve estar reativado");
	assert.ok(
		respAtivado.content.includes("!g-filtro-permitirLink"),
		"Deve sugerir !g-filtro-permitirLink"
	);
	assert.ok(
		respAtivado.content.includes("!g-filtro-linksConfiaveis"),
		"Deve sugerir !g-filtro-linksConfiaveis"
	);
	assert.ok(
		respAtivado.content.includes("!g-filtro-permitirAdm"),
		"Deve sugerir !g-filtro-permitirAdm"
	);
	console.log("✓ Sugestões exibidas corretamente ao ativar !g-filtro-links");

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("Erro no teste:", err);
	process.exit(1);
});
