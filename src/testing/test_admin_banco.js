// src/testing/test_admin_banco.js
// Funções puras da área Banco do /admin (public/admin/areas/banco/lib.js, módulo ES sem DOM):
// rótulos, sinal das Runas, regra e valor sugerido do desfazer, leitura do ajuste de saldo,
// variável do Grafana, paginação e consulta de transações.

const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

async function runTests() {
	console.log("=== Teste da área Banco do /admin (banco/lib.js) ===");
	const lib = await import(
		pathToFileURL(path.join(__dirname, "../../public/admin/areas/banco/lib.js")).href
	);

	// Telefone e valores
	assert.strictEqual(lib.formatPhone("5511912345678"), "+55 (11) 91234-5678");
	assert.strictEqual(lib.formatPhone("551112345678"), "+55 (11) 1234-5678");
	assert.strictEqual(lib.formatPhone("383125189821002"), "383125189821002");
	assert.strictEqual(lib.formatPhone(""), "Desconhecido");
	assert.strictEqual(lib.money(1234.5), "1.234,50");
	assert.strictEqual(lib.money("x"), "—");
	console.log("✓ formatPhone e money.");

	// Operação, jogo e quantidade (como a tela antiga)
	assert.strictEqual(lib.opLabel("DEPOSIT"), "Venda");
	assert.strictEqual(lib.opLabel("UNDO_TRADE"), "Estorno");
	assert.strictEqual(lib.opLabel("NOVO_TIPO"), "NOVO_TIPO");
	assert.deepStrictEqual(lib.gameInfo("pesca", 12.5), { label: "Pesca", amount: "12,5 kg" });
	assert.deepStrictEqual(lib.gameInfo("waifu", 1500), { label: "Waifus (Z)", amount: "1.500 Z" });
	assert.deepStrictEqual(lib.gameInfo("jardim", 40), {
		label: "Petalitas (Ptl)",
		amount: "40 Ptl"
	});
	assert.deepStrictEqual(lib.gameInfo("slots", 3), { label: "Slots (moedas)", amount: "3 un." });
	assert.deepStrictEqual(lib.gameInfo("fishing", 2), { label: "Pesca (iscas)", amount: "2 un." });
	assert.strictEqual(lib.gameInfo("outro", 1).label, "outro");
	console.log("✓ opLabel e gameInfo.");

	// Sinal das Runas
	assert.strictEqual(lib.runasSigned({ type: "DEPOSIT", runas_amount: 216.02 }), "+216,02");
	assert.strictEqual(lib.runasSigned({ type: "WITHDRAW", runas_amount: 50 }), "−50,00");
	assert.strictEqual(lib.runasSigned({ type: "STORE_BUY", runas_amount: 73.09 }), "−73,09");
	assert.strictEqual(lib.runasSigned({ type: "BONUS", runas_amount: 10 }), "+10,00");
	assert.strictEqual(lib.runasSigned({ type: "ADMIN_ADJUST", runas_amount: -200 }), "−200,00");
	assert.strictEqual(lib.runasSigned({ type: "ADMIN_ADJUST", runas_amount: 500 }), "+500,00");
	assert.strictEqual(
		lib.runasSigned({
			type: "UNDO_TRADE",
			runas_amount: 105,
			details_json: '{"originalType":"DEPOSIT"}'
		}),
		"−105,00",
		"estorno de venda tira Runas"
	);
	assert.strictEqual(
		lib.runasSigned({
			type: "UNDO_TRADE",
			runas_amount: 95,
			details_json: '{"originalType":"WITHDRAW"}'
		}),
		"+95,00",
		"estorno de compra devolve Runas"
	);
	assert.strictEqual(
		lib.runasSigned({ type: "UNDO_TRADE", runas_amount: 1, details_json: "{x" }),
		"+1,00"
	);
	console.log("✓ runasSigned.");

	// Desfazer: mesma regra e mesmo valor sugerido da tela antiga
	assert.ok(lib.canUndo({ type: "DEPOSIT", status: "COMPLETED" }));
	assert.ok(lib.canUndo({ type: "STORE_BUY", status: null }));
	assert.ok(!lib.canUndo({ type: "DEPOSIT", status: "UNDONE" }));
	assert.ok(!lib.canUndo({ type: "BONUS", status: "COMPLETED" }));
	assert.ok(!lib.canUndo({ type: "ADMIN_ADJUST" }));
	assert.ok(!lib.canUndo({ type: "UNDO_TRADE" }));
	assert.deepStrictEqual(lib.undoDefault({ type: "DEPOSIT", runas_amount: 100 }), {
		fee: 5,
		final: 105,
		debit: true
	});
	assert.deepStrictEqual(lib.undoDefault({ type: "WITHDRAW", runas_amount: 73.09 }), {
		fee: 3.65,
		final: 69.44,
		debit: false
	});
	assert.strictEqual(lib.undoDefault({ type: "STORE_BUY", runas_amount: 0 }).final, 0);
	console.log("✓ canUndo e undoDefault.");

	// Números digitados e ajuste de saldo (a rota recebe o saldo final)
	assert.strictEqual(lib.parseNumber("1.234,5"), 1234.5);
	assert.strictEqual(lib.parseNumber("1234.5"), 1234.5);
	assert.strictEqual(lib.parseNumber("−20"), -20);
	assert.ok(Number.isNaN(lib.parseNumber("abc")));
	assert.ok(Number.isNaN(lib.parseNumber("")));
	assert.deepStrictEqual(lib.parseAdjust("1500", 1000), {
		ok: true,
		target: 1500,
		diff: 500,
		relative: false
	});
	assert.deepStrictEqual(lib.parseAdjust("+500", 1000), {
		ok: true,
		target: 1500,
		diff: 500,
		relative: true
	});
	assert.deepStrictEqual(lib.parseAdjust("−200", 1000.5), {
		ok: true,
		target: 800.5,
		diff: -200,
		relative: true
	});
	assert.deepStrictEqual(lib.parseAdjust("-0,01", 0.01), {
		ok: true,
		target: 0,
		diff: -0.01,
		relative: true
	});
	assert.strictEqual(lib.parseAdjust("-2000", 1000).ok, false, "não deixa negativo");
	assert.strictEqual(lib.parseAdjust("dez", 1000).ok, false);
	assert.strictEqual(
		lib.parseAdjust("11.498,35", 11498.35).diff,
		0,
		"valor pré-preenchido não muda nada"
	);
	console.log("✓ parseNumber e parseAdjust.");

	// Variável var-jogador do painel do Grafana (pessoa do analytics)
	assert.strictEqual(lib.grafanaPerson("5511912345678"), "5511912345678");
	assert.strictEqual(lib.grafanaPerson("551112345678"), "5511912345678", "celular ganha o 9");
	assert.strictEqual(lib.grafanaPerson("5511912345678@c.us"), "5511912345678");
	assert.strictEqual(lib.grafanaPerson("383125189821002"), "lid:383125189821002");
	assert.strictEqual(lib.grafanaPerson("3083867774"), "3083867774");
	console.log("✓ grafanaPerson.");

	// Paginação e consulta de transações pelo endereço
	assert.deepStrictEqual(lib.pageWindow(1, 1), [1]);
	assert.deepStrictEqual(lib.pageWindow(1, 20), [1, 2, 3, 4, 5]);
	assert.deepStrictEqual(lib.pageWindow(7, 20), [5, 6, 7, 8, 9]);
	assert.deepStrictEqual(lib.pageWindow(20, 20), [16, 17, 18, 19, 20]);
	assert.deepStrictEqual(lib.pageWindow(2, 3), [1, 2, 3]);
	assert.strictEqual(lib.pageOf(new URLSearchParams("p=3")), 3);
	assert.strictEqual(lib.pageOf(new URLSearchParams("p=-1")), 1);
	assert.strictEqual(lib.pageOf(new URLSearchParams("")), 1);
	const q = lib.txQuery(new URLSearchParams("q=5511&tipo=DEPOSIT&jogo=hack&status=UNDONE&p=2"));
	assert.strictEqual(
		q.toString(),
		"page=2&limit=20&q=5511&type=DEPOSIT&game=ALL&status=UNDONE",
		"valor fora da lista vira ALL"
	);
	assert.strictEqual(
		lib.txQuery(new URLSearchParams("")).toString(),
		"page=1&limit=20&q=&type=ALL&game=ALL&status=ALL"
	);
	console.log("✓ pageWindow, pageOf e txQuery.");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha no teste da área Banco do /admin:", err);
		process.exit(1);
	});
