process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const ReturnMessage = require("../models/ReturnMessage");
const SorteioCommands = require("../functions/SorteioCommands");
const Database = require("../utils/Database");

const db = Database.getInstance();
const DB_NAME = "sorteios";

async function runTests() {
	console.log("=== INICIANDO TESTES DO SORTEIOCOMMANDS ===");

	const bot = new FakeBot({ id: "test-bot", testMode: false });
	db.testMode = false;
	const groupId = "120363000@g.us";
	const adminId = "5511999990001@s.whatsapp.net";
	const mockGroup = {
		id: groupId,
		additionalAdmins: [adminId]
	};

	const cmdSorteio = SorteioCommands.commands.find((c) => c.name === "sorteio");
	const cmdEntrar = SorteioCommands.commands.find((c) => c.name === "sorteio-entrar");
	const cmdSortear = SorteioCommands.commands.find((c) => c.name === "sortear");
	const cmdLimpar = SorteioCommands.commands.find((c) => c.name === "sorteio-limpar");
	const cmdSorteios = SorteioCommands.commands.find((c) => c.name === "sorteios");

	assert.ok(cmdSorteio, "Comando !sorteio deve existir");
	assert.ok(cmdEntrar, "Comando !sorteio-entrar deve existir");
	assert.ok(cmdSortear, "Comando !sortear deve existir");
	assert.ok(cmdLimpar, "Comando !sorteio-limpar deve existir");
	assert.ok(cmdSorteios, "Comando !sorteios deve existir");

	// Limpa tabelas de teste antes de iniciar
	await db.dbRun(DB_NAME, "DELETE FROM sorteio_participants");
	await db.dbRun(DB_NAME, "DELETE FROM sorteios");

	// 1. Criar sorteio e adicionar participantes
	console.log("\n[1] Criando sorteio ativo e cadastrando 5 participantes...");
	{
		const msgCreate = createMessage({
			content: "!sorteio Prêmio Top",
			group: groupId,
			author: adminId
		});
		await cmdSorteio.method(bot, msgCreate, ["Prêmio", "Top"], mockGroup);

		const active = await db.dbGet(
			DB_NAME,
			"SELECT * FROM sorteios WHERE group_id = ? AND status = 'active'",
			[groupId]
		);
		assert.ok(active, "Sorteio ativo deve ter sido criado no banco");
		assert.strictEqual(active.title, "Prêmio Top");

		// Inscreve 5 participantes
		for (let i = 1; i <= 5; i++) {
			const uId = `551199999000${i}@s.whatsapp.net`;
			const uName = `Participante_${i}`;
			const msgJoin = createMessage({
				content: "!sorteio-entrar",
				group: groupId,
				author: uId,
				authorName: uName
			});
			const resJoin = await cmdEntrar.method(bot, msgJoin, [], mockGroup);
			assert.ok(
				resJoin.content.includes("entrou no sorteio"),
				`Participante ${i} deve ter entrado`
			);
		}

		const participants = await db.dbAll(
			DB_NAME,
			"SELECT * FROM sorteio_participants WHERE sorteio_id = ?",
			[active.id]
		);
		assert.strictEqual(participants.length, 5, "Devem haver 5 participantes cadastrados");
		console.log("✓ Sorteio ativo criado e 5 participantes cadastrados com sucesso.");
	}

	// 2. Testando !sorteio-limpar com permissões e remoção de membros que saíram
	console.log("\n[2] Testando !sorteio-limpar...");
	{
		// Participantes 1 e 2 continuam no grupo; 3, 4 e 5 saíram do grupo
		const groupMembersInChat = [
			{ id: { _serialized: adminId }, isAdmin: true },
			{ id: { _serialized: "5511999990001@s.whatsapp.net" }, pushname: "Participante_1" },
			{ id: { _serialized: "5511999990002@s.whatsapp.net" }, pushname: "Participante_2" }
		];

		const mockOriginWithChat = {
			getChat: async () => ({
				isGroup: true,
				id: { _serialized: groupId },
				participants: groupMembersInChat
			})
		};

		// 2a. Usuário não-admin tentando usar !sorteio-limpar
		const nonAdminId = "5511988887777@s.whatsapp.net";
		const msgNonAdmin = createMessage({
			content: "!sorteio-limpar",
			group: groupId,
			author: nonAdminId,
			origin: mockOriginWithChat
		});
		const resNonAdmin = await cmdLimpar.method(bot, msgNonAdmin, [], mockGroup);
		assert.ok(
			resNonAdmin.content.includes("Apenas administradores do grupo ou o criador deste sorteio"),
			"Não-admin deve ser bloqueado"
		);
		console.log("✓ Não-admin bloqueado corretamente.");

		// 2b. Admin executando !sorteio-limpar
		const msgAdmin = createMessage({
			content: "!sorteio-limpar",
			group: groupId,
			author: adminId,
			origin: mockOriginWithChat
		});
		const resAdmin = await cmdLimpar.method(bot, msgAdmin, [], mockGroup);
		assert.ok(resAdmin instanceof ReturnMessage);
		assert.ok(resAdmin.content.includes("Limpeza de Sorteio Concluída!"), "Deve reportar limpeza");
		assert.ok(
			resAdmin.content.includes("Foram removidos *3* participante(s)"),
			"Deve remover 3 participantes"
		);
		assert.ok(
			resAdmin.options?.mentions?.length === 3,
			"Opções de menção devem conter os 3 removidos"
		);

		const remaining = await db.dbAll(
			DB_NAME,
			"SELECT * FROM sorteio_participants WHERE sorteio_id = (SELECT id FROM sorteios WHERE group_id = ? AND status = 'active')",
			[groupId]
		);
		assert.strictEqual(remaining.length, 2, "Devem restar 2 participantes no banco");
		console.log("✓ Limpeza removeu exatamente os 3 membros ausentes.");

		// 2c. Executar novamente quando todos continuam no grupo
		const resCleanAgain = await cmdLimpar.method(bot, msgAdmin, [], mockGroup);
		assert.ok(
			resCleanAgain.content.includes("Nenhum participante inativo encontrado"),
			"Deve informar que todos continuam no grupo"
		);
		console.log("✓ Segunda execução confirmou que ninguém mais precisava ser removido.");
	}

	// 3. Testando !sortear com múltiplos vencedores (2 pessoas)
	console.log("\n[3] Testando !sortear 2 com sorteio ativo...");
	{
		const msgSortear = createMessage({
			content: "!sortear 2",
			group: groupId,
			author: adminId
		});

		const res = await cmdSortear.method(bot, msgSortear, ["2"], mockGroup);
		assert.ok(res instanceof ReturnMessage);
		assert.ok(res.content.includes("SORTEIO REALIZADO!"), "Deve confirmar sorteio realizado");
		assert.ok(res.content.includes("Ganhadores (2):"), "Deve listar 2 ganhadores");
		assert.ok(res.content.includes("🥇 1."), "Deve conter trofeu/ouro 1º lugar");
		assert.ok(res.content.includes("🥈 2."), "Deve conter prata 2º lugar");
		assert.strictEqual(res.options?.mentions?.length, 2, "Deve mencionar os 2 ganhadores");

		// Verifica se o sorteio foi finalizado no banco
		const finished = await db.dbGet(
			DB_NAME,
			"SELECT * FROM sorteios WHERE group_id = ? AND status = 'finished'",
			[groupId]
		);
		assert.ok(finished, "Sorteio deve estar com status 'finished'");
		assert.ok(finished.winner_id.includes(","), "winner_id deve conter múltiplos IDs");
		console.log("✓ Sorteio ativo com 2 pessoas finalizado com sucesso:\n" + res.content);
	}

	// 4. Testando !sortear com ranking 1 a 4 (🥇, 🥈, 🥉, 4.)
	console.log("\n[4] Testando !sortear 4 com numeração 1 a 4 e emojis correspondentes...");
	{
		// Cria outro sorteio
		const msgCreate2 = createMessage({
			content: "!sorteio Grande Torneio",
			group: groupId,
			author: adminId
		});
		await cmdSorteio.method(bot, msgCreate2, ["Grande", "Torneio"], mockGroup);

		const active = await db.dbGet(
			DB_NAME,
			"SELECT * FROM sorteios WHERE group_id = ? AND status = 'active'",
			[groupId]
		);

		// Inscreve 4 participantes
		for (let i = 1; i <= 4; i++) {
			await db.dbRun(
				DB_NAME,
				"INSERT INTO sorteio_participants (sorteio_id, user_id, user_name, joined_at) VALUES (?, ?, ?, ?)",
				[active.id, `551188888000${i}@s.whatsapp.net`, `Membro_${i}`, Date.now()]
			);
		}

		const msgSortear4 = createMessage({
			content: "!sortear 4",
			group: groupId,
			author: adminId
		});
		const res4 = await cmdSortear.method(bot, msgSortear4, ["4"], mockGroup);

		assert.ok(res4.content.includes("🥇 1."), "Deve ter 🥇 1.");
		assert.ok(res4.content.includes("🥈 2."), "Deve ter 🥈 2.");
		assert.ok(res4.content.includes("🥉 3."), "Deve ter 🥉 3.");
		assert.ok(res4.content.includes("4. @"), "Deve ter número normal 4.");
		assert.strictEqual(res4.options?.mentions?.length, 4, "Deve mencionar os 4 ganhadores");
		console.log("✓ Sorteio de 4 pessoas formatado com sucesso:\n" + res4.content);
	}

	// 5. Testando !sortear instantâneo com quantidade e título
	console.log("\n[5] Testando !sortear instantâneo com quantidade (2) e título...");
	{
		const members = [
			{ id: { _serialized: "5511777770001@s.whatsapp.net" }, pushname: "Alice" },
			{ id: { _serialized: "5511777770002@s.whatsapp.net" }, pushname: "Bob" },
			{ id: { _serialized: "5511777770003@s.whatsapp.net" }, pushname: "Carol" }
		];

		const msgInstant = createMessage({
			content: "!sortear 2 Caixa Misteriosa",
			group: groupId,
			author: adminId,
			origin: {
				getChat: async () => ({
					isGroup: true,
					id: { _serialized: groupId },
					participants: members
				})
			}
		});

		const resInstant = await cmdSortear.method(
			bot,
			msgInstant,
			["2", "Caixa", "Misteriosa"],
			mockGroup
		);
		assert.ok(
			resInstant.content.includes("SORTEIO INSTANTÂNEO REALIZADO!"),
			"Deve ser instantâneo"
		);
		assert.ok(
			resInstant.content.includes("Sorteio: *Caixa Misteriosa*"),
			"Título deve ser Caixa Misteriosa"
		);
		assert.ok(resInstant.content.includes("Ganhadores (2):"), "Deve ter 2 ganhadores");
		assert.ok(resInstant.content.includes("🥇 1."), "Deve ter 🥇 1.");
		assert.ok(resInstant.content.includes("🥈 2."), "Deve ter 🥈 2.");
		assert.strictEqual(resInstant.options?.mentions?.length, 2, "Deve mencionar 2 pessoas");
		console.log("✓ Sorteio instantâneo realizado com sucesso:\n" + resInstant.content);
	}

	// 6. Testando !sorteios (histórico)
	console.log("\n[6] Testando !sorteios (histórico com múltiplos ganhadores)...");
	{
		const msgHistorico = createMessage({
			content: "!sorteios",
			group: groupId,
			author: adminId
		});

		const resHistorico = await cmdSorteios.method(bot, msgHistorico, [], mockGroup);
		assert.ok(resHistorico.content.includes("Histórico de Sorteios"), "Deve mostrar histórico");
		assert.ok(
			resHistorico.content.includes("Vencedores:"),
			"Deve conter registro de múltiplos vencedores"
		);
		assert.ok(resHistorico.options?.mentions?.length > 0, "Deve incluir menções no histórico");
		console.log("✓ Histórico exibido com sucesso:\n" + resHistorico.content);
	}

	// 7. Testando !sortear com 1 ganhador padrão (sem argumentos)
	console.log("\n[7] Testando !sortear com 1 ganhador (padrão sem argumentos)...");
	{
		const msgCreate3 = createMessage({
			content: "!sorteio Vaga Individual",
			group: groupId,
			author: adminId
		});
		await cmdSorteio.method(bot, msgCreate3, ["Vaga", "Individual"], mockGroup);

		const active = await db.dbGet(
			DB_NAME,
			"SELECT * FROM sorteios WHERE group_id = ? AND status = 'active'",
			[groupId]
		);

		await db.dbRun(
			DB_NAME,
			"INSERT INTO sorteio_participants (sorteio_id, user_id, user_name, joined_at) VALUES (?, ?, ?, ?)",
			[active.id, "5511999990099@s.whatsapp.net", "Único_Inscrito", Date.now()]
		);

		const msgSortear1 = createMessage({
			content: "!sortear",
			group: groupId,
			author: adminId
		});
		const res1 = await cmdSortear.method(bot, msgSortear1, [], mockGroup);
		assert.ok(res1.content.includes("*Ganhador(a):*"), "Deve usar cabeçalho singular");
		assert.ok(
			res1.content.includes("🥇 1. @5511999990099 (*Único_Inscrito*)"),
			"Deve formatar 1º com 🥇 1."
		);
		assert.strictEqual(res1.options?.mentions?.length, 1, "Deve ter 1 menção");
		console.log("✓ Sorteio de 1 pessoa formatado com sucesso:\n" + res1.content);
	}

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("ERRO NO TESTE:", err);
		process.exit(1);
	});
