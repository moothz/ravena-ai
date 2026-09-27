process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const Queue = require("../services/Queue");
const LLMService = require("../services/LLMService");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");

async function runTests() {
	console.log("=== Iniciando testes de resiliência e desengasgo da fila (Queue & LLMService) ===");

	// --------------------------------------------------------------------------
	// 1. Teste de timeout individual de tarefa no Queue
	// --------------------------------------------------------------------------
	console.log("\n[1] Testando timeout automático por tarefa no Queue...");
	const shortTimeoutQueue = new Queue({ concurrency: 1, taskTimeout: 200 }); // 200ms para teste ágil

	let hungTaskSettled = false;
	let hungTaskError = null;

	// Tarefa 1: Pendura indefinidamente (nunca resolve nem rejeita)
	const p1 = shortTimeoutQueue
		.add(() => new Promise(() => {}), { priority: 5 })
		.then(() => {
			hungTaskSettled = true;
		})
		.catch((err) => {
			hungTaskSettled = true;
			hungTaskError = err;
		});

	// Tarefa 2: Deve executar normalmente APÓS a Tarefa 1 dar timeout
	let task2Executed = false;
	const p2 = shortTimeoutQueue.add(
		async () => {
			task2Executed = true;
			return "ok2";
		},
		{ priority: 5 }
	);

	await Promise.all([p1, p2]);

	assert.strictEqual(hungTaskSettled, true, "Tarefa pendurada deve ser rejeitada após timeout");
	assert.ok(hungTaskError, "Deve ter capturado erro de timeout");
	assert.ok(
		hungTaskError.message.includes("timed out"),
		`Mensagem de erro deve conter 'timed out', obteve: ${hungTaskError.message}`
	);
	assert.strictEqual(
		task2Executed,
		true,
		"Tarefa 2 deve ter sido executada após timeout da Tarefa 1 sem travar a fila"
	);
	assert.strictEqual(shortTimeoutQueue.pending, 0, "Pending deve retornar a zero");
	console.log(
		"✓ Tarefa travada sofreu timeout automático e fila continuou processando perfeitamente!"
	);

	// --------------------------------------------------------------------------
	// 2. Teste do método clear() no Queue
	// --------------------------------------------------------------------------
	console.log("\n[2] Testando método clear() para esvaziar fila em lote...");
	const testClearQueue = new Queue({ concurrency: 1, taskTimeout: 5000 });

	// Ocupa o slot de concorrência com uma tarefa lenta controlada
	let resolveTaskSlot;
	const slotPromise = new Promise((res) => {
		resolveTaskSlot = res;
	});
	testClearQueue.add(() => slotPromise, { priority: 5 });

	// Enfileira 5 itens que ficarão pendentes
	const rejectedErrors = [];
	for (let i = 0; i < 5; i++) {
		testClearQueue
			.add(async () => `item_${i}`, { priority: 5 })
			.catch((err) => rejectedErrors.push(err));
	}

	assert.strictEqual(testClearQueue.size, 5, "Fila deve conter 5 itens pendentes");

	// Limpa a fila
	const clearedCount = testClearQueue.clear("Fila limpa para teste");
	assert.strictEqual(clearedCount, 5, "clear() deve retornar 5 itens cancelados");
	assert.strictEqual(testClearQueue.size, 0, "Fila pendente deve estar zerada após clear()");

	// Aguarda as rejeições das promessas
	await new Promise((r) => setTimeout(r, 50));
	assert.strictEqual(rejectedErrors.length, 5, "Todas as 5 promessas devem ter sido rejeitadas");
	assert.strictEqual(
		rejectedErrors[0].noRetry,
		true,
		"Erro de clear() deve ter noRetry=true para evitar re-enfileiramento"
	);
	assert.ok(rejectedErrors[0].message.includes("Fila limpa para teste"));

	// Libera a tarefa lenta
	resolveTaskSlot();
	await new Promise((r) => setTimeout(r, 50));
	console.log(
		"✓ clear() esvaziou a fila, rejeitou todas as tarefas pendentes com noRetry e registrou falhas!"
	);

	// --------------------------------------------------------------------------
	// 3. Teste de bloqueio de comandos recursivos com IA em executeBotCommand
	// --------------------------------------------------------------------------
	console.log("\n[3] Testando blacklist de comandos recursivos com LLM no executeBotCommand...");
	const llmService = LLMService.getInstance();
	const bot = new FakeBot({ id: "teste-bot" });
	const message = createMessage({ content: "!ia teste", author: "5511999999999@s.whatsapp.net" });

	const recursiveCommandsToTest = [
		"ai",
		"ia",
		"gemini",
		"gpt",
		"ajuda",
		"traduza",
		"resumo",
		"tarot",
		"ocr",
		"stop",
		"anoni"
	];

	for (const cmd of recursiveCommandsToTest) {
		const res = await llmService.executeBotCommand(
			{ command: cmd, args: "parametro teste" },
			{ bot, message }
		);
		assert.ok(
			res.includes("não pode ser executado recursivamente") || res.includes("modelo de linguagem"),
			`Comando '${cmd}' deveria ser bloqueado contra recursão, mas retornou: ${res}`
		);
	}
	console.log(
		`✓ Todos os ${recursiveCommandsToTest.length} comandos com dependência de IA foram bloqueados com sucesso em executeBotCommand!`
	);

	// --------------------------------------------------------------------------
	// 4. Teste de clearQueue e bypassQueue no LLMService
	// --------------------------------------------------------------------------
	console.log("\n[4] Testando clearQueue e bypassQueue no LLMService...");
	const initialCleared = llmService.clearQueue("Teste unitário");
	assert.strictEqual(typeof initialCleared, "number");

	// Testa que getQueueStatus reporta status consistente
	const qStats = llmService.getQueueStatus();
	assert.ok(typeof qStats === "object");
	console.log("✓ clearQueue() e getQueueStatus() validados no LLMService.");

	console.log("\n🎉 TODOS OS TESTES DE RESILIÊNCIA DA FILA PASSARAM COM SUCESSO!");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro nos testes:", err);
		process.exit(1);
	});
