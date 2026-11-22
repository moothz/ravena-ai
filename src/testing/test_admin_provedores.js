// src/testing/test_admin_provedores.js
// Regras puras da área Provedores de IA do /admin (public/admin/areas/provedores/logic.js,
// módulo ES sem DOM): estado por provedor, operações na config, formulário → provedor,
// serviços, fila e simulador de custos.

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

async function runTests() {
	console.log("=== Teste da área Provedores de IA do /admin (logic.js) ===");
	const L = await import(
		pathToFileURL(path.join(__dirname, "../../public/admin/areas/provedores/logic.js")).href
	);

	const config = {
		llm: [
			{ name: "a", url: "http://a", model: "m1", enabled: true, temperature: 0.7, top_k: 64 },
			{ name: "b", url: "http://b", enabled: false },
			{ name: "c", url: "http://c", enabled: true },
			{ name: "d", url: "http://d" }
		],
		whisper: [
			{ name: "w1", url: "http://w1", enabled: true },
			{ name: "w2", url: "http://w2", enabled: true }
		],
		sdwebui: [{ name: "sd", url: "http://sd", width: 1200, steps: 40, enabled: true }],
		"kokoro-tts": [{ name: "velho", url: "http://k" }]
	};
	const frozen = JSON.stringify(config);

	// Categorias: as 9 conhecidas e as listas extras da config
	const cats = L.categoriesOf(config);
	assert.strictEqual(cats.length, 10);
	assert.deepStrictEqual(
		cats.slice(0, 9).map((c) => c.id),
		["llm", "laya", "whisper", "comfyui", "bonsai", "sdwebui", "kokorotts", "nudenet", "rembg"]
	);
	assert.deepStrictEqual(cats[9], { id: "kokoro-tts", name: "kokoro-tts", known: false });
	console.log("✓ categorias conhecidas e extras.");

	// Estado por provedor
	let st = L.providerStates("llm", config.llm, {
		llm: { status: "up", model: "a", isPrimary: true, resetSeconds: 0 }
	});
	assert.deepStrictEqual(
		st.map((s) => [s.state, s.word, s.role, s.rank]),
		[
			["ok", "no ar", "principal", 1],
			["off", "desligado", null, null],
			["ok", "ligado", "reserva", 2],
			["ok", "ligado", "reserva", 3]
		]
	);
	assert.strictEqual(st[0].active, true);
	st = L.providerStates("llm", config.llm, { llm: { status: "backup", model: "c" } });
	assert.deepStrictEqual(
		st.map((s) => s.word),
		["fora", "desligado", "atendendo", "ligado"]
	);
	assert.strictEqual(st[2].active, true);
	st = L.providerStates("llm", config.llm, { llm: { status: "down", model: "Nenhum" } });
	assert.deepStrictEqual(
		st.map((s) => s.state),
		["down", "off", "down", "down"]
	);
	st = L.providerStates("whisper", config.whisper, { whisper: "backup" });
	assert.deepStrictEqual(
		st.map((s) => s.word),
		["fora", "ligado"]
	);
	// Sem verificação (laya/rembg) ou sem dado: "ligado", nunca "no ar"
	st = L.providerStates("rembg", [{ name: "r" }], { whisper: "up" });
	assert.deepStrictEqual([st[0].state, st[0].word], ["ok", "ligado"]);
	st = L.providerStates("whisper", config.whisper, null);
	assert.deepStrictEqual(
		st.map((s) => s.word),
		["ligado", "ligado"]
	);
	assert.deepStrictEqual(L.categorySummary("whisper", config.whisper, { whisper: "down" }), {
		text: "fora do ar",
		kind: "bad"
	});
	assert.strictEqual(L.categorySummary("laya", [], {}).text, "nenhum cadastrado");
	assert.strictEqual(L.categorySummary("llm", [{ name: "x", enabled: false }], {}).kind, "att");
	console.log("✓ estado por provedor (no ar, atendendo, fora, desligado, sem verificação).");

	// Serviços: fora primeiro, f5tts igual ao kokoro vira uma linha
	const rows = L.serviceRows(
		{
			whatsgoapi: "up",
			llm: { status: "backup", model: "c", resetSeconds: 40 },
			whisper: "down",
			kokorotts: "up",
			f5tts: "up",
			x: "unknown"
		},
		{ kokorotts: "Kokoro TTS", f5tts: "F5 TTS", whisper: "Whisper (STT)" }
	);
	assert.deepStrictEqual(
		rows.map((r) => [r.key, r.status]),
		[
			["whisper", "down"],
			["llm", "backup"],
			["x", "unknown"],
			["whatsgoapi", "up"],
			["kokorotts", "up"]
		]
	);
	assert.strictEqual(rows.find((r) => r.key === "kokorotts").name, "Kokoro TTS / F5 TTS");
	assert.strictEqual(rows[1].model, "c");
	assert.strictEqual(rows[1].resetSeconds, 40);
	assert.strictEqual(rows[0].category, "whisper");
	assert.strictEqual(rows.find((r) => r.key === "whatsgoapi").category, null);
	assert.deepStrictEqual(L.serviceRows(null), []);
	console.log("✓ serviços ordenados, f5tts junto do kokoro.");

	// Operações: não mutam a entrada
	let next = L.toggleProvider(config, "llm", 1);
	assert.strictEqual(next.llm[1].enabled, true);
	next = L.toggleProvider(config, "llm", 3);
	assert.strictEqual(next.llm[3].enabled, false, "sem 'enabled' conta como ligado");
	next = L.moveProvider(config, "llm", 2, -1);
	assert.deepStrictEqual(
		next.llm.map((p) => p.name),
		["a", "c", "b", "d"]
	);
	assert.deepStrictEqual(
		L.moveProvider(config, "llm", 0, -1).llm.map((p) => p.name),
		["a", "b", "c", "d"]
	);
	assert.deepStrictEqual(
		L.moveProvider(config, "llm", 3, 1).llm.map((p) => p.name),
		["a", "b", "c", "d"]
	);
	next = L.removeProvider(config, "whisper", 0);
	assert.deepStrictEqual(
		next.whisper.map((p) => p.name),
		["w2"]
	);
	next = L.upsertProvider(config, "laya", -1, { name: "novo", url: "u" });
	assert.deepStrictEqual(next.laya, [{ name: "novo", url: "u" }]);
	next = L.upsertProvider(config, "llm", -1, { name: "e", url: "u" });
	assert.strictEqual(next.llm[4].name, "e", "novo entra no fim (menor prioridade)");
	assert.throws(() => L.removeProvider(config, "llm", 9));
	assert.throws(() => L.upsertProvider(config, "llm", 9, {}));
	assert.ok(next["kokoro-tts"], "listas extras continuam na config");
	assert.strictEqual(JSON.stringify(config), frozen, "a config original não muda");
	assert.strictEqual(L.isLastEnabled(config.whisper, 0), false);
	assert.strictEqual(L.isLastEnabled(config.sdwebui, 0), true);
	console.log("✓ ligar/desligar, reordenar, criar e apagar sem mutar a entrada.");

	// Formulário → provedor
	let v = L.formValues("llm", null);
	assert.strictEqual(v.type, "ollama");
	assert.strictEqual(v.enabled, true);
	v = L.formValues("laya", null);
	assert.strictEqual(v.model, "ravena-bgem3");
	assert.strictEqual(v.timeoutMs, "3000");
	v = L.formValues("nudenet", { name: "n", circuitBreakerDuration: 20000, threshold: 0.75 });
	assert.strictEqual(v.circuitBreakerSeconds, "20");
	assert.strictEqual(v.threshold, "0.75");
	assert.strictEqual(L.formValues("nudenet", null).circuitBreakerSeconds, "15");
	assert.strictEqual(L.formValues("laya", { timeout: 5000 }).timeoutMs, "5000");

	let p = L.buildProvider(
		"llm",
		{
			name: " a ",
			url: "http://a2",
			apiKey: "",
			enabled: true,
			type: "openai",
			model: "m2",
			timeout_multiplier: "1,5",
			textOnly: true,
			ignoreVideo: false,
			toolCalling: true,
			contextLength: "32768",
			maxTokens: ""
		},
		{ ...config.llm[0], maxTokens: 4096, extra: "fica" }
	);
	assert.strictEqual(p.name, "a");
	assert.strictEqual(p.url, "http://a2");
	assert.strictEqual(p.temperature, 0.7, "parâmetros de amostragem continuam");
	assert.strictEqual(p.top_k, 64);
	assert.strictEqual(p.extra, "fica", "campo desconhecido continua");
	assert.strictEqual(p.timeout_multiplier, 1.5);
	assert.strictEqual(p.contextLength, 32768);
	assert.ok(!("maxTokens" in p), "número vazio sai");
	assert.ok(!("apiKey" in p), "chave vazia não é criada");
	assert.strictEqual(p.toolCalling, true);

	p = L.buildProvider(
		"sdwebui",
		{ name: "sd", url: "http://sd2", apiKey: "", enabled: false },
		config.sdwebui[0]
	);
	assert.strictEqual(p.width, 1200);
	assert.strictEqual(p.steps, 40);
	assert.strictEqual(p.enabled, false);

	p = L.buildProvider(
		"nudenet",
		{
			name: "n",
			url: "u",
			apiKey: "k",
			enabled: true,
			threshold: "0.7",
			circuitBreakerSeconds: "30",
			debug: true,
			detectAll: false
		},
		{ name: "n", url: "u", videoFps: 1, circuitBreakerDuration: 15000 }
	);
	assert.strictEqual(p.circuitBreakerDuration, 30000);
	assert.strictEqual(p.threshold, 0.7);
	assert.strictEqual(p.videoFps, 1);
	assert.strictEqual(p.apiKey, "k");
	assert.strictEqual(p.debug, true);

	p = L.buildProvider("laya", { name: "l", url: "u", model: "", timeoutMs: "abc" }, null);
	assert.strictEqual(p.model, "ravena-bgem3");
	assert.ok(!("timeoutMs" in p));

	assert.strictEqual(L.validateProvider("llm", { name: "", url: "u" }), "Dê um nome ao provedor.");
	assert.strictEqual(
		L.validateProvider("llm", { name: "x", url: "" }),
		"Informe a URL do provedor."
	);
	assert.ok(L.validateProvider("nudenet", { name: "x", url: "u", threshold: 2 }));
	assert.strictEqual(L.validateProvider("llm", { name: "x", url: "u" }), null);
	console.log("✓ formulário preserva campos não editados e descarta números vazios.");

	// Fila do LLM
	assert.deepStrictEqual(
		L.queueRows({
			1: { pending: 1, processing: 0, fulfilled: 4, failed: 0 },
			5: { pending: 2, processing: 1 }
		}).map((r) => [r.priority, r.pending, r.processing, r.fulfilled, r.failed]),
		[
			["5", 2, 1, 0, 0],
			["1", 1, 0, 4, 0]
		]
	);
	assert.deepStrictEqual(L.queueRows(null), []);
	console.log("✓ fila por prioridade, a maior primeiro.");

	// Uso e custos
	assert.strictEqual(L.failPercent({ total_requests: 75, total_failures: 25 }), 25);
	assert.strictEqual(L.failPercent({}), 0);
	const stats = {
		by_provider: {
			a: {
				by_type: {
					text: { requests: 2, failures: 1, input_tokens: 1e6, output_tokens: 5e5 },
					video: { requests: 1, failures: 0, input_tokens: 1e6, output_tokens: 5e5 },
					stt: { requests: 3, failures: 0, input_tokens: 0, output_tokens: 0 }
				}
			}
		}
	};
	const pt = L.providerTypeRows(stats);
	assert.deepStrictEqual(
		pt.map((r) => [r.provider, r.type, r.requests, r.input_tokens]),
		[
			["a", "text", 3, 2e6],
			["a", "stt", 3, 0]
		]
	);
	assert.strictEqual(L.rowCost("text", pt[0], { input: 2.5, output: 10 }), 2 * 2.5 + 1 * 10);
	assert.strictEqual(L.rowCost("stt", pt[1], { price_per_minute: 0.006 }), 0.5 * 0.006);
	assert.strictEqual(L.rowCost("image", { requests: 10 }, { price: 0.04 }), 0.4);
	assert.strictEqual(
		L.rowCost("tts", { output_tokens: 2e6, requests: 1 }, { price_per_1m_chars: 15 }),
		30
	);
	assert.strictEqual(L.rowCost("text", pt[0], null), 0);

	const costData = JSON.parse(
		fs.readFileSync(path.join(__dirname, "../../public/llm-cost-estimate.json"), "utf8")
	);
	const textModels = L.costModels(costData, "text");
	assert.strictEqual(textModels.length, costData.text.length);
	for (let i = 1; i < textModels.length; i++) {
		const avg = (m) => (m.input + m.output) / 2;
		assert.ok(avg(textModels[i - 1]) <= avg(textModels[i]), "do mais barato ao mais caro");
	}
	assert.deepStrictEqual(L.costModels(null, "text"), []);
	assert.deepStrictEqual(
		L.USO_PERIODS.map((t) => [t.id, t.ms]),
		[
			["1h", 3600000],
			["24h", 86400000],
			["7d", 604800000],
			["15d", 1296000000],
			["30d", 2592000000],
			["tudo", 0]
		]
	);
	console.log("✓ uso por provedor e tipo, custos e períodos da tela antiga.");

	console.log("Todos os testes da área Provedores passaram.");
}

runTests().catch((err) => {
	console.error(err);
	process.exit(1);
});
