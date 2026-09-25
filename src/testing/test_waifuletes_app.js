process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const axios = require("axios");
const BotAPI = require("../BotAPI");

async function main() {
	console.log("=== Iniciando Testes do Aplicativo Waifuletes (BotAPI) ===");

	const testPort = 5994;
	const botApi = new BotAPI({ port: testPort });
	await botApi.start();
	const baseUrl = `http://localhost:${testPort}`;

	try {
		// Teste 1: Rota /waifuletes deve redirecionar para /?app=waifuletes
		console.log("\n[Teste 1] Redirecionamento da rota /waifuletes");
		const redirectRes = await axios.get(`${baseUrl}/waifuletes`, {
			maxRedirects: 0,
			validateStatus: (status) => status >= 200 && status < 400
		});
		assert.strictEqual(redirectRes.status, 302, "Status deve ser 302");
		assert.ok(
			redirectRes.headers.location.includes("?app=waifuletes"),
			`Location deve conter ?app=waifuletes, recebido: ${redirectRes.headers.location}`
		);
		console.log("✓ Rota /waifuletes redirecionou corretamente para /?app=waifuletes");

		// Teste 2: GET /api/waifuletes/characters básico
		console.log("\n[Teste 2] Consulta básica de personagens (/api/waifuletes/characters?limit=5)");
		const charRes = await axios.get(`${baseUrl}/api/waifuletes/characters?limit=5`);
		assert.strictEqual(charRes.status, 200, "Status deve ser 200");
		assert.strictEqual(charRes.data.success, true, "Response deve ter success=true");
		const charData = charRes.data.data;
		assert.ok(Array.isArray(charData.data), "data.data deve ser um array de personagens");
		assert.ok(charData.total > 0, "total deve ser maior que 0");
		console.log(
			`✓ Retornou ${charData.data.length} personagens (Total no banco: ${charData.total})`
		);

		// Teste 3: Normalização de URLs de imagem
		console.log("\n[Teste 3] Verificação da normalização de URLs de imagem");
		const sampleChar = charData.data[0];
		assert.ok(sampleChar.id, "Personagem deve conter id");
		assert.ok(sampleChar.name, "Personagem deve conter name");
		assert.ok(sampleChar.imageUrl, "Personagem deve conter imageUrl");
		assert.ok(
			!sampleChar.imageUrl.includes("localhost:3000"),
			`imageUrl não deve apontar para localhost:3000 direto no cliente: ${sampleChar.imageUrl}`
		);
		console.log(`✓ Exemplo de imagem normalizada para o cliente: ${sampleChar.imageUrl}`);

		// Teste 4: Filtro por busca (search)
		console.log("\n[Teste 4] Filtro por busca (search=rem)");
		const searchRes = await axios.get(`${baseUrl}/api/waifuletes/characters?search=rem&limit=3`);
		assert.strictEqual(searchRes.status, 200);
		const searchList = searchRes.data.data.data;
		console.log(`✓ Busca por 'rem' retornou ${searchList.length} resultados.`);

		// Teste 5: Filtro por gênero e raridade
		console.log("\n[Teste 5] Filtro combinado (gender=FEMALE&rarity=EPIC)");
		const filterRes = await axios.get(
			`${baseUrl}/api/waifuletes/characters?gender=FEMALE&rarity=EPIC&limit=3`
		);
		assert.strictEqual(filterRes.status, 200);
		const filterList = filterRes.data.data.data;
		if (filterList.length > 0) {
			assert.strictEqual(filterList[0].gender, "FEMALE", "Gênero deve ser FEMALE");
			assert.strictEqual(
				filterList[0].baseRarity || filterList[0].rarity,
				"EPIC",
				"Raridade deve ser EPIC"
			);
		}
		console.log(`✓ Filtro por FEMALE e EPIC funcionou corretamente.`);

		// Teste 6: Ordenação client-side por nome (sortBy=name)
		console.log("\n[Teste 6] Ordenação por nome (sortBy=name&order=asc)");
		const sortRes = await axios.get(
			`${baseUrl}/api/waifuletes/characters?sortBy=name&order=asc&limit=10`
		);
		assert.strictEqual(sortRes.status, 200);
		const sortList = sortRes.data.data.data;
		if (sortList.length >= 2) {
			for (let i = 0; i < sortList.length - 1; i++) {
				const comp = sortList[i].name.localeCompare(sortList[i + 1].name, "pt-BR", {
					sensitivity: "base"
				});
				assert.ok(
					comp <= 0,
					`Nomes devem estar em ordem alfabética: ${sortList[i].name} <= ${sortList[i + 1].name}`
				);
			}
		}
		console.log(`✓ Ordenação alfabética por nome verificada com sucesso.`);

		// Teste 7: Proxy de mídia /api/waifuletes/media/...
		console.log("\n[Teste 7] Verificação de segurança no proxy de mídia");
		try {
			await axios.get(`${baseUrl}/api/waifuletes/media/../secret`);
			assert.fail("Deveria bloquear path traversal com ..");
		} catch (err) {
			assert.ok(
				err.response?.status === 400 || err.response?.status === 404,
				"Path traversal deve retornar 400 ou 404"
			);
		}
		console.log("✓ Bloqueio de path traversal no proxy de mídia verificado.");

		// Teste 8: Badges (isClaimed, wishlistCount, marriage)
		console.log("\n[Teste 8] Verificação dos dados de Badges (Casada(o) e # Wishes)");
		const badgesRes = await axios.get(`${baseUrl}/api/waifuletes/characters?limit=12`);
		assert.strictEqual(badgesRes.status, 200);
		const badgesList = badgesRes.data.data.data;
		assert.ok(badgesList.length > 0, "Lista de personagens não pode estar vazia");

		const sampleBadgeChar = badgesList[0];
		assert.ok(
			typeof sampleBadgeChar.wishlistCount === "number",
			"wishlistCount deve ser um número"
		);
		assert.ok(typeof sampleBadgeChar.isClaimed === "boolean", "isClaimed deve ser booleano");
		console.log(
			`✓ Exemplo: ${sampleBadgeChar.name} - isClaimed: ${sampleBadgeChar.isClaimed}, wishlistCount: ${sampleBadgeChar.wishlistCount}`
		);

		// Busca personagem conhecido como casado (touji-fushiguro)
		const marriedRes = await axios.get(
			`${baseUrl}/api/waifuletes/characters?search=touji-fushiguro&limit=1`
		);
		const marriedChar = marriedRes.data.data.data[0];
		if (marriedChar && marriedChar.id === "touji-fushiguro") {
			assert.strictEqual(marriedChar.isClaimed, true, "touji-fushiguro deve ter isClaimed=true");
			assert.ok(marriedChar.marriage, "touji-fushiguro deve ter objeto marriage");
			assert.ok(marriedChar.marriage.spouse, "marriage deve conter nome do cônjuge");
			assert.ok(marriedChar.marriage.groupName, "marriage deve conter nome do grupo");
			console.log(
				`✓ Casamento verificado: ${marriedChar.name} casado(a) com ${marriedChar.marriage.spouse} no grupo '${marriedChar.marriage.groupName}'`
			);
		}

		// Busca personagem conhecido na wishlist (maomao ou frieren)
		const wishRes = await axios.get(`${baseUrl}/api/waifuletes/characters?search=maomao&limit=1`);
		const wishChar = wishRes.data.data.data[0];
		if (wishChar && wishChar.id === "maomao") {
			assert.ok(wishChar.wishlistCount >= 1, "maomao deve ter wishlistCount >= 1");
			console.log(
				`✓ Wishlists verificadas: ${wishChar.name} está em ${wishChar.wishlistCount} wishlists`
			);
		}

		// Teste 9: Endpoint de resolução de grupo
		console.log("\n[Teste 9] Resolução de nome de grupo (/api/waifuletes/group)");
		const testGroupId = "120363139279597528@g.us";
		const groupRes = await axios.get(
			`${baseUrl}/api/waifuletes/group?id=${encodeURIComponent(testGroupId)}`
		);
		assert.strictEqual(groupRes.status, 200);
		assert.strictEqual(groupRes.data.success, true);
		assert.ok(groupRes.data.name, "Grupo deve ter nome retornado");
		console.log(`✓ Grupo ${testGroupId} resolvido com sucesso: '${groupRes.data.name}'`);

		// Teste 10: Endpoint de detalhe de personagem
		console.log("\n[Teste 10] Detalhe de personagem (/api/waifuletes/characters/:id)");
		const detailCharRes = await axios.get(`${baseUrl}/api/waifuletes/characters/maomao`);
		assert.strictEqual(detailCharRes.status, 200);
		assert.strictEqual(detailCharRes.data.success, true);
		assert.strictEqual(detailCharRes.data.data.id, "maomao");
		assert.ok(typeof detailCharRes.data.data.wishlistCount === "number");
		console.log(
			`✓ Detalhes de ${detailCharRes.data.data.name} carregados com wishlistCount: ${detailCharRes.data.data.wishlistCount}`
		);

		// Teste 11: Filtro de estado civil (maritalStatus)
		console.log("\n[Teste 11] Filtro por estado civil (maritalStatus)");
		const marriedFilterRes = await axios.get(
			`${baseUrl}/api/waifuletes/characters?maritalStatus=married&limit=5`
		);
		assert.strictEqual(marriedFilterRes.status, 200);
		const marriedFilterList = marriedFilterRes.data.data.data;
		console.log(
			`✓ Consulta com maritalStatus=married retornou ${marriedFilterList.length} personagens (Total: ${marriedFilterRes.data.data.total}).`
		);
		if (marriedFilterList.length > 0) {
			assert.strictEqual(
				marriedFilterList[0].isClaimed,
				true,
				"Personagem retornado no filtro 'married' deve ser casado"
			);
			assert.ok(marriedFilterList[0].marriage, "Personagem deve conter dados de casamento");
			console.log(
				`✓ Personagem casado verificado: ${marriedFilterList[0].name} (Cônjuge: ${marriedFilterList[0].marriage.spouse})`
			);
		}

		const singleFilterRes = await axios.get(
			`${baseUrl}/api/waifuletes/characters?maritalStatus=single&limit=5`
		);
		assert.strictEqual(singleFilterRes.status, 200);
		const singleFilterList = singleFilterRes.data.data.data;
		console.log(
			`✓ Consulta com maritalStatus=single retornou ${singleFilterList.length} personagens (Total: ${singleFilterRes.data.data.total}).`
		);
		if (singleFilterList.length > 0) {
			assert.strictEqual(
				singleFilterList[0].isClaimed,
				false,
				"Personagem retornado no filtro 'single' deve ser solteiro"
			);
		}

		console.log("\n🎉 TODOS OS TESTES PASSARAM COM SUCESSO! 🎉");
	} finally {
		await botApi.stop();
	}
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("ERRO NO TESTE:", err);
		process.exit(1);
	});
