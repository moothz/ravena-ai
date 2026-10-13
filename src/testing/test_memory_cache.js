/**
 * src/testing/test_memory_cache.js
 *
 * Teste unitário para a classe MemoryCache.
 */

const assert = require("assert");
const MemoryCache = require("../utils/MemoryCache");

async function run() {
	console.log("=== Iniciando testes de MemoryCache ===");

	// 1. Inserção e recuperação básica
	const cache = new MemoryCache(1000, 10);
	cache.set("chave1", { nome: "Teste 1" });
	assert.strictEqual(cache.has("chave1"), true, "Deveria ter chave1");
	assert.deepStrictEqual(cache.get("chave1"), { nome: "Teste 1" });
	console.log("✓ Inserção e recuperação básica OK");

	// 2. Chave inexistente retorna null
	assert.strictEqual(cache.get("inexistente"), null, "Chave inexistente deve retornar null");
	assert.strictEqual(cache.has("inexistente"), false, "has() para inexistente deve retornar false");
	console.log("✓ Chave inexistente OK");

	// 3. Remoção pontual
	cache.set("chave2", "valor2");
	assert.strictEqual(cache.delete("chave2"), true);
	assert.strictEqual(cache.get("chave2"), null);
	assert.strictEqual(cache.delete("chave2"), false);
	console.log("✓ Deleção de chave OK");

	// 4. Expiração por TTL
	const shortCache = new MemoryCache(50, 10); // 50ms TTL
	shortCache.set("temp", "expira-logo");
	assert.strictEqual(shortCache.get("temp"), "expira-logo");
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.strictEqual(shortCache.get("temp"), null, "Item expirado deve retornar null");
	assert.strictEqual(shortCache.has("temp"), false, "Item expirado deve retornar false no has()");
	console.log("✓ Expiração por TTL OK");

	// 5. TTL customizado por item
	cache.set("custom", "valor-custom", 50); // 50ms TTL customizado
	assert.strictEqual(cache.get("custom"), "valor-custom");
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.strictEqual(cache.get("custom"), null, "Item com TTL customizado expirou corretamente");
	console.log("✓ TTL customizado por item OK");

	// 6. Política de limite de capacidade (LRU / FIFO)
	const smallCache = new MemoryCache(10000, 3); // máximo de 3 itens
	smallCache.set("k1", "v1");
	smallCache.set("k2", "v2");
	smallCache.set("k3", "v3");
	assert.strictEqual(smallCache.size(), 3);

	// Acessa k1 para torná-lo recentemente acessado (k2 vira o mais antigo)
	smallCache.get("k1");

	// Insere k4, deve descartar o mais antigo (k2)
	smallCache.set("k4", "v4");
	assert.strictEqual(smallCache.size(), 3, "Capacidade deve permanecer limitada em 3");
	assert.strictEqual(smallCache.get("k2"), null, "k2 deve ter sido descartado por LRU");
	assert.strictEqual(smallCache.get("k1"), "v1", "k1 deve ter sido mantido pois foi acessado");
	assert.strictEqual(smallCache.get("k3"), "v3");
	assert.strictEqual(smallCache.get("k4"), "v4");
	console.log("✓ Política de capacidade máxima (LRU) OK");

	// 7. Limpeza total (clear)
	smallCache.clear();
	assert.strictEqual(smallCache.size(), 0);
	assert.strictEqual(smallCache.get("k1"), null);
	console.log("✓ Limpeza total (clear) OK");

	console.log("🎉 Todos os testes de MemoryCache passaram com sucesso!");
}

run()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha nos testes de MemoryCache:", err);
		process.exit(1);
	});
