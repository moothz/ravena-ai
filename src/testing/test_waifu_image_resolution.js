process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const sharp = require("sharp");
const WaifuCommands = require("../functions/WaifuCommands");

async function runTests() {
	console.log("=== Iniciando Testes de Resolução de Imagens e Placeholders de Waifu ===");

	// ─── TESTE 1: escapeXml ───────────────────────────────────────────────────
	console.log("\n[Teste 1] Validando escapeXml...");
	assert.strictEqual(
		WaifuCommands.escapeXml("Tom & Jerry"),
		"Tom &amp; Jerry",
		"Deveria escapar '&' para '&amp;'"
	);
	assert.strictEqual(
		WaifuCommands.escapeXml("<anime> \"novo\" 'teste'"),
		"&lt;anime&gt; &quot;novo&quot; &apos;teste&apos;",
		"Deveria escapar tags e aspas"
	);
	assert.strictEqual(WaifuCommands.escapeXml(null), "", "Null deve retornar string vazia");
	assert.strictEqual(
		WaifuCommands.escapeXml(undefined),
		"",
		"Undefined deve retornar string vazia"
	);
	console.log("✓ Teste 1 passou: escapeXml funcionando corretamente.");

	// ─── TESTE 2: resolveWaifuImageUrl ───────────────────────────────────────
	console.log("\n[Teste 2] Validando resolveWaifuImageUrl...");
	const baseUrl = process.env.WAIFULETES_API_URL || "http://host.docker.internal:3030";
	const cleanBase = baseUrl.replace(/\/+$/, "");

	// 2.1 URL com none.png deve retornar null
	assert.strictEqual(
		WaifuCommands.resolveWaifuImageUrl("https://waifuletes.example.com/media//images/none.png"),
		null,
		"none.png deve retornar null imediatamente"
	);
	assert.strictEqual(
		WaifuCommands.resolveWaifuImageUrl("/images/none.png"),
		null,
		"caminho relativo com none.png deve retornar null"
	);
	assert.strictEqual(WaifuCommands.resolveWaifuImageUrl(""), null, "Vazio deve retornar null");
	assert.strictEqual(WaifuCommands.resolveWaifuImageUrl(null), null, "Null deve retornar null");

	// 2.2 Caminho relativo deve ser prefixado com a base interna da API
	assert.strictEqual(
		WaifuCommands.resolveWaifuImageUrl("/media/characters/hong-ryun/default.png"),
		`${cleanBase}/media/characters/hong-ryun/default.png`,
		"Caminho relativo deve usar a base interna"
	);

	// 2.3 URL com localhost ou host.docker.internal deve ser normalizada
	assert.strictEqual(
		WaifuCommands.resolveWaifuImageUrl(
			"http://localhost:3030/media/characters/hong-ryun/default.png"
		),
		`${cleanBase}/media/characters/hong-ryun/default.png`,
		"localhost deve ser convertido para a base interna"
	);
	assert.strictEqual(
		WaifuCommands.resolveWaifuImageUrl(
			"http://host.docker.internal:3030/media/characters/hong-ryun/default.png"
		),
		`${cleanBase}/media/characters/hong-ryun/default.png`,
		"host.docker.internal deve ser convertido para a base interna"
	);

	// 2.4 URL com o domínio público configurado no env deve ser roteada internamente
	if (process.env.WAIFULETES_WEB_URL) {
		const webUrl = process.env.WAIFULETES_WEB_URL.replace(/\/+$/, "");
		const testPublicUrl = `${webUrl}/media/characters/hong-ryun/default.png`;
		assert.strictEqual(
			WaifuCommands.resolveWaifuImageUrl(testPublicUrl),
			`${cleanBase}/media/characters/hong-ryun/default.png`,
			"Domínio público configurado no .env deve ser reescrito para a base interna"
		);
	}

	// 2.5 URL externa genérica (CDN/Imgur) deve ser mantida
	const externalUrl = "https://images.example.com/anime/char.png";
	assert.strictEqual(
		WaifuCommands.resolveWaifuImageUrl(externalUrl),
		externalUrl,
		"URL externa genérica deve ser preservada"
	);
	console.log("✓ Teste 2 passou: resolveWaifuImageUrl resolve rotas internas e bloqueia none.png.");

	// ─── TESTE 3: generateSingleRollPlaceholderBuffer ────────────────────────
	console.log("\n[Teste 3] Validando geração de placeholder visual para single roll...");
	const mockCharSpecial = {
		name: "Dungeons & Dragons Guy <Hero>",
		series: "Anime & Mangá Special '2026'",
		rarity: "LEGENDARY",
		gender: "FEMALE"
	};

	const placeholderBuf = await WaifuCommands.generateSingleRollPlaceholderBuffer(mockCharSpecial);
	assert.ok(Buffer.isBuffer(placeholderBuf), "Deve retornar um Buffer válido");
	assert.ok(placeholderBuf.length > 500, "Buffer gerado deve conter imagem renderizada");

	const meta = await sharp(placeholderBuf).metadata();
	assert.strictEqual(meta.format, "jpeg", "Deve ser gerado como JPEG");
	assert.strictEqual(meta.width, 500, "Largura deve ser 500px");
	assert.strictEqual(meta.height, 700, "Altura deve ser 700px");
	console.log("✓ Teste 3 passou: cartão visual gerado com sucesso mesmo com '&' e tags.");

	// ─── TESTE 4: buildRollGridImage com caracteres especiais ────────────────
	console.log("\n[Teste 4] Validando buildRollGridImage sem quebrar com '&' no XML...");
	const gridItems = [
		{
			slot: 1,
			character: {
				name: "Tom & Jerry & Spike",
				series: "Warner Bros & Friends",
				rarity: "EPIC"
			},
			imageBuffer: null
		},
		{
			slot: 2,
			character: {
				name: "Alice <In Wonderland>",
				series: "Lewis & Carroll",
				rarity: "RARE"
			},
			imageBuffer: null
		}
	];

	const gridBuf = await WaifuCommands.buildRollGridImage(gridItems);
	assert.ok(Buffer.isBuffer(gridBuf), "Grid com '&' deve retornar Buffer sem lançar XML error");
	const gridMeta = await sharp(gridBuf).metadata();
	assert.strictEqual(gridMeta.width, 640);
	assert.strictEqual(gridMeta.height, 320);
	console.log("✓ Teste 4 passou: grid com '&' construído perfeitamente sem erros XML.");

	console.log("\n=== Todos os testes de imagens passaram com 100% de SUCESSO! ===");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("❌ Falha no teste de imagens:", err);
	process.exit(1);
});
