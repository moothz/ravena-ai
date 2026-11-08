process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";
process.env.TZ = "America/Sao_Paulo";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const ReturnMessage = require("../models/ReturnMessage");
const LembretesCommands = require("../functions/LembretesCommands");

async function runTests() {
	console.log("=== INICIANDO TESTES DE LEMBRETES E FUSO HORÁRIO ===");

	const bot = new FakeBot({ id: "test-bot" });

	// 1. Teste de criação de lembrete com duração relativa ("em 10 minutos")
	console.log("\n[1] Testando !lembrar com duração relativa ('em 10 minutos')...");
	{
		const msg = createMessage({
			content: "!lembrar em 10 minutos tirar o lixo",
			group: "120363000@g.us",
			author: "5511999990001@s.whatsapp.net"
		});

		const res = await LembretesCommands.commands[1].method(
			bot,
			msg,
			["em", "10", "minutos", "tirar", "o", "lixo"],
			{}
		);

		assert.ok(res instanceof ReturnMessage, "Deve retornar ReturnMessage");
		assert.ok(res.content.includes("✅ Lembrete configurado para"), "Deve confirmar agendamento");
		console.log("✓ Resposta recebida:", res.content);
	}

	// 2. Teste de criação de lembrete com 'amanhã as 14h' (popular sem crase)
	console.log("\n[2] Testando !lembrar com 'amanhã as 14h reuniao'...");
	{
		const msg = createMessage({
			content: "!lembrar amanha as 14h reuniao importante",
			group: "120363000@g.us",
			author: "5511999990001@s.whatsapp.net"
		});

		const res = await LembretesCommands.commands[1].method(
			bot,
			msg,
			["amanha", "as", "14h", "reuniao", "importante"],
			{}
		);

		assert.ok(res instanceof ReturnMessage, "Deve retornar ReturnMessage");
		assert.ok(
			res.content.includes("14:00"),
			`Data formatada deve conter 14:00. Conteúdo: ${res.content}`
		);
		console.log("✓ Resposta recebida:", res.content);
	}

	// 3. Teste de criação de lembrete com horário absoluto hoje/amanhã ("15:30")
	console.log("\n[3] Testando !lembrar com horário '15:30'...");
	{
		const msg = createMessage({
			content: "!lembrar 15:30 ligar para cliente",
			group: "120363000@g.us",
			author: "5511999990001@s.whatsapp.net"
		});

		const res = await LembretesCommands.commands[1].method(
			bot,
			msg,
			["15:30", "ligar", "para", "cliente"],
			{}
		);

		assert.ok(res instanceof ReturnMessage, "Deve retornar ReturnMessage");
		assert.ok(
			res.content.includes("15:30"),
			`Data formatada deve conter 15:30. Conteúdo: ${res.content}`
		);
		console.log("✓ Resposta recebida:", res.content);
	}

	// 4. Teste de timezone e formatação em America/Sao_Paulo
	console.log("\n[4] Testando timezone no processo...");
	{
		assert.strictEqual(process.env.TZ, "America/Sao_Paulo", "TZ deve ser America/Sao_Paulo");
		const now = new Date();
		const dateStr = now.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
		assert.ok(dateStr.length > 0, "Deve formatar data local corretamente");
		console.log("✓ Data local:", dateStr);
	}

	console.log("\n=== TODOS OS TESTES DE LEMBRETES PASSARAM COM SUCESSO! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("ERRO NOS TESTES DE LEMBRETES:", err);
		process.exit(1);
	});
