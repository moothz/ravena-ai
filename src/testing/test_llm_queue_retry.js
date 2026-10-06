process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const LLMService = require("../services/LLMService");
const Queue = require("../services/Queue");

async function runTests() {
	console.log("=== Iniciando testes de retry e posicionamento de fila no LLMService ===");

	const llmService = LLMService.getInstance();

	// Salva métodos e propriedades originais para restauração posterior
	const originalProviderQueue = [...llmService.providerQueue];
	const originalProviderDefinitions = [...llmService.providerDefinitions];
	const originalQueue = llmService.queue;

	try {
		// --------------------------------------------------------------------------
		// 1. Teste: Pedido que falha 2 vezes e sucede na 3ª tentativa (2 retries na fila)
		// --------------------------------------------------------------------------
		console.log(
			"\n[1] Testando pedido que falha 2 vezes e é atendido no 2º retry (3ª tentativa)..."
		);

		let callCount = 0;
		llmService.providerDefinitions = [
			{
				name: "mock-primary",
				method: async () => {
					callCount++;
					if (callCount < 3) {
						throw new Error(`Falha simulada na tentativa ${callCount}`);
					}
					return "Resposta obtida com sucesso na 3ª tentativa!";
				}
			}
		];
		llmService.providerQueue = [...llmService.providerDefinitions];

		// Cria uma Queue dedicada com concurrency 1 para teste controlado
		llmService.queue = new Queue({ concurrency: 1, taskTimeout: 10000 });

		const startTime = Date.now();
		const result = await llmService.getCompletion({
			prompt: "Teste retry 3 tentativas",
			priority: 5
		});
		const elapsed = Date.now() - startTime;

		assert.strictEqual(
			result,
			"Resposta obtida com sucesso na 3ª tentativa!",
			`Deveria ter obtido a resposta de sucesso, mas obteve: ${result}`
		);
		assert.strictEqual(
			callCount,
			3,
			`Deveria ter executado exatamente 3 vezes, mas executou ${callCount}`
		);
		assert.ok(
			elapsed >= 2500,
			`Deveria ter respeitado os intervalos de backoff (~3000ms), decorrido: ${elapsed}ms`
		);
		console.log("✓ Pedido foi re-enfileirado 2 vezes e completou com sucesso na 3ª execução!");

		// --------------------------------------------------------------------------
		// 2. Teste: Pedido que falha em todas as 3 tentativas é descartado com mensagem amigável
		// --------------------------------------------------------------------------
		console.log(
			"\n[2] Testando pedido que falha em todas as tentativas (esgotando os 2 retries)..."
		);

		let failCallCount = 0;
		llmService.providerDefinitions = [
			{
				name: "mock-always-failing",
				method: async () => {
					failCallCount++;
					throw new Error("Falha persistente do provedor");
				}
			}
		];
		llmService.providerQueue = [...llmService.providerDefinitions];
		llmService.queue = new Queue({ concurrency: 1, taskTimeout: 10000 });

		const failResult = await llmService.getCompletion({
			prompt: "Teste falha definitiva",
			priority: 4
		});

		assert.strictEqual(
			failCallCount,
			3,
			`Deveria ter tentado exatamente 3 vezes (1 inicial + 2 retries), executou ${failCallCount}`
		);
		assert.ok(
			failResult.includes("Não foi possível gerar uma resposta"),
			`Deveria retornar mensagem de erro amigável, obteve: ${failResult}`
		);
		console.log(
			"✓ Pedido parou exatamente após 2 retries na fila e retornou mensagem de erro amigável."
		);

		// --------------------------------------------------------------------------
		// 3. Teste: Posicionamento no final da própria prioridade
		// --------------------------------------------------------------------------
		console.log("\n[3] Testando se o re-enfileiramento entra no final da própria prioridade...");

		const executionOrder = [];
		let p5Attempt = 0;

		llmService.providerDefinitions = [
			{
				name: "mock-priority-provider",
				method: async (options) => {
					const id = options.id;
					if (id === "task-P5-retry") {
						p5Attempt++;
						if (p5Attempt === 1) {
							executionOrder.push(`${id}-attempt1`);
							throw new Error("P5 falha na 1ª tentativa para re-enfileirar");
						}
						executionOrder.push(`${id}-attempt2`);
						return "P5-sucesso";
					}
					executionOrder.push(id);
					return `${id}-sucesso`;
				}
			}
		];
		llmService.providerQueue = [...llmService.providerDefinitions];

		// Controla a Queue com concorrência 1 para garantir ordem estrita
		llmService.queue = new Queue({ concurrency: 1, taskTimeout: 10000 });

		// Enfileira P5-retry primeiro
		const p5RetryPromise = llmService.getCompletion({
			id: "task-P5-retry",
			priority: 5
		});

		// Aguarda para garantir que P5-retry comece e falhe na tentativa 1
		await new Promise((r) => setTimeout(r, 50));

		// Cria uma tarefa de bloqueio que segura o worker da fila enquanto P5-retry está no backoff
		let releaseBlocker;
		const blockerPromise = new Promise((resolve) => {
			releaseBlocker = resolve;
		});

		const slowTaskPromise = llmService.getCompletion({
			id: "task-blocker",
			priority: 5
		});

		// Modifica o provider para segurar task-blocker até liberarmos
		const originalMethod = llmService.providerDefinitions[0].method;
		llmService.providerDefinitions[0].method = async (options) => {
			if (options.id === "task-blocker") {
				executionOrder.push("task-blocker");
				await blockerPromise;
				return "blocker-sucesso";
			}
			return originalMethod(options);
		};

		// Enfileira tarefas enquanto task-blocker segura o worker:
		// - task-P5-outro (Prioridade 5, entrará antes de P5-retry voltar)
		// - task-P3 (Prioridade 3)
		// - task-P1 (Prioridade 1)
		const p5OutroPromise = llmService.getCompletion({
			id: "task-P5-outro",
			priority: 5
		});
		const p3Promise = llmService.getCompletion({
			id: "task-P3",
			priority: 3
		});
		const p1Promise = llmService.getCompletion({
			id: "task-P1",
			priority: 1
		});

		// Aguarda o backoff de P5-retry (1500ms) terminar e ele ser re-enfileirado
		await new Promise((r) => setTimeout(r, 1800));

		// Libera a tarefa bloqueadora para a fila processar os itens pendentes
		releaseBlocker();

		await Promise.all([p5RetryPromise, slowTaskPromise, p5OutroPromise, p3Promise, p1Promise]);

		console.log("Ordem de execução observada:", executionOrder);

		// Esperado:
		// 1. task-P5-retry-attempt1 rodou primeiro e falhou.
		// 2. task-blocker pegou o worker e ficou segurando.
		// 3. Enquanto o worker estava preso, task-P5-outro (P5), task-P3 (P3) e task-P1 (P1) entraram na fila pendente.
		// 4. P5-retry completou o backoff e foi re-enfileirado com P5.
		//    Por ter P5, ele se posicionou após task-P5-outro (P5), mas ANTES de task-P3 e task-P1!
		// 5. Ao liberar o blocker, a ordem DEVE ser: blocker -> P5-outro -> P5-retry-attempt2 -> P3 -> P1!
		assert.strictEqual(executionOrder[0], "task-P5-retry-attempt1");
		assert.strictEqual(executionOrder[1], "task-blocker");
		assert.strictEqual(executionOrder[2], "task-P5-outro");
		assert.strictEqual(
			executionOrder[3],
			"task-P5-retry-attempt2",
			"task-P5-retry re-enfileirado deve executar antes de tarefas com prioridade menor (P3 e P1)"
		);
		assert.strictEqual(executionOrder[4], "task-P3");
		assert.strictEqual(executionOrder[5], "task-P1");
		console.log(
			"✓ Tarefa re-enfileirada respeitou a prioridade e executou à frente de prioridades menores!"
		);

		// --------------------------------------------------------------------------
		// 4. Teste: Fallback entre múltiplos provedores em Prioridade <= 4
		// --------------------------------------------------------------------------
		console.log("\n[4] Testando fallback entre múltiplos provedores para Prioridades <= 4...");

		let p1ProviderAttempt = 0;
		let p2ProviderAttempt = 0;

		llmService.providerDefinitions = [
			{
				name: "mock-primary-failing",
				method: async () => {
					p1ProviderAttempt++;
					throw new Error("Provedor principal caiu");
				}
			},
			{
				name: "mock-secondary-working",
				method: async () => {
					p2ProviderAttempt++;
					return "Resposta do secundário com sucesso!";
				}
			}
		];
		llmService.providerQueue = [...llmService.providerDefinitions];
		llmService.queue = new Queue({ concurrency: 1, taskTimeout: 10000 });

		const p3FallbackResult = await llmService.getCompletion({
			prompt: "Teste fallback P3",
			priority: 3
		});

		assert.strictEqual(
			p3FallbackResult,
			"Resposta do secundário com sucesso!",
			`Prioridade 3 deveria ter feito fallback para o secundário, obteve: ${p3FallbackResult}`
		);
		assert.strictEqual(p1ProviderAttempt, 1, "Provedor principal deveria ter sido tentado");
		assert.strictEqual(
			p2ProviderAttempt,
			1,
			"Provedor secundário deveria ter atendido no fallback"
		);
		console.log("✓ Prioridade <= 4 fez fallback com sucesso para o provedor secundário!");

		console.log("\n🎉 TODOS OS TESTES DE RETRY DA FILA DO LLMSERVICE PASSARAM COM SUCESSO!");
	} finally {
		// Restaura configurações originais do singleton
		llmService.providerQueue = originalProviderQueue;
		llmService.providerDefinitions = originalProviderDefinitions;
		llmService.queue = originalQueue;
	}
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro nos testes:", err);
		process.exit(1);
	});
