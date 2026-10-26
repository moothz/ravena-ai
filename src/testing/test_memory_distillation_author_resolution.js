process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const MemoryService = require("../services/MemoryService");

async function runTests() {
	console.log("==========================================================");
	console.log("🧪 TESTE: RESOLUÇÃO DE AUTOR CANÔNICO POR NÚMERO / ID E NORMALIZAÇÃO");
	console.log("==========================================================\n");

	const memoryService = MemoryService.getInstance();

	// 1. Testes de normalizeAuthorName
	console.log("1. Testando normalizeAuthorName...");
	assert.strictEqual(
		memoryService.normalizeAuthorName("𝔾𝕦𝕚𝕝𝕙𝕖𝕣𝕞𝕖"),
		"guilherme",
		"Deve normalizar caracteres double-struck para latim padrão"
	);
	assert.strictEqual(
		memoryService.normalizeAuthorName("꧁༒☬༒꧂💥 𝔅𝔞𝔨𝔲𝔤𝔬𝔲💥꧁༒☬༒꧂"),
		"bakugou",
		"Deve normalizar fonte Fraktur e remover decorações/emojis"
	);
	assert.strictEqual(
		memoryService.normalizeAuthorName("ﾟ.:｡+ﾟ×𝘭ɑ𝔯𝑦×.:｡+ﾟ"),
		memoryService.normalizeAuthorName("ﾟ.:｡+ﾟ×𝘭ɑ𝘳𝘺×.:｡+ﾟ"),
		"Variantes itálicas e fraktur de Lary devem ter mesma forma normalizada"
	);
	console.log("✓ normalizeAuthorName validado com sucesso!");

	// 2. Simulação de resolução de canonicalId no lote de destilação
	console.log("\n2. Testando resolução por user_id e fallbacks...");
	const sampleRows = [
		{
			author_name: "𝔾𝕦𝕚𝕝𝕙𝕖𝕣𝕞𝕖",
			author_id: "5515997269052@s.whatsapp.net",
			canonical_user_id: "wa_5515997269052"
		},
		{
			author_name: "꧁༒☬༒꧂💥 𝔅𝔞𝔨𝔲𝔤𝔬𝔲💥꧁༒☬༒꧂",
			author_id: "559684218693@s.whatsapp.net",
			canonical_user_id: "wa_559684218693"
		},
		{
			author_name: "ﾟ.:｡+ﾟ×𝘭ɑ𝔯𝑦×.:｡+ﾟ",
			author_id: "5519953243942@s.whatsapp.net",
			canonical_user_id: "wa_5519953243942"
		},
		{
			author_name: ".",
			author_id: "556195068459@s.whatsapp.net",
			canonical_user_id: "wa_556195068459"
		}
	];

	const validCanonicals = new Set(sampleRows.map((r) => r.canonical_user_id).filter(Boolean));

	function resolveId(uFact) {
		let canonicalId = null;

		// 1. Prioridade máxima: ID canônico direto informado pela IA
		if (uFact.user_id && typeof uFact.user_id === "string") {
			const rawUserId = uFact.user_id
				.trim()
				.replace(/^\[(?:ID:\s*)?/i, "")
				.replace(/\]$/, "")
				.trim();

			if (validCanonicals.has(rawUserId)) {
				canonicalId = rawUserId;
			} else {
				const num = memoryService.cleanPhone(rawUserId);
				if (num && num.length >= 8) {
					if (validCanonicals.has(`wa_${num}`)) {
						canonicalId = `wa_${num}`;
					} else if (validCanonicals.has(`user_${num}`)) {
						canonicalId = `wa_${num}`;
					} else {
						canonicalId = `wa_${num}`;
					}
				} else if (rawUserId.startsWith("wa_") || rawUserId.startsWith("tg_")) {
					canonicalId = rawUserId;
				}
			}
		}

		// 2. Fallback: Se não encontrou por user_id, tenta localizar por author_name
		if (!canonicalId && uFact.author_name) {
			const targetNameNorm = memoryService.normalizeAuthorName(uFact.author_name);

			const matchingRow = sampleRows.find((r) => {
				if (!r.author_name) return false;
				if (r.author_name.toLowerCase() === uFact.author_name.toLowerCase()) return true;
				const rowNameNorm = memoryService.normalizeAuthorName(r.author_name);
				if (rowNameNorm && targetNameNorm) {
					if (rowNameNorm === targetNameNorm) return true;
					if (rowNameNorm.length >= 3 && targetNameNorm.length >= 3) {
						return rowNameNorm.includes(targetNameNorm) || targetNameNorm.includes(rowNameNorm);
					}
				}
				return false;
			});

			canonicalId = matchingRow?.canonical_user_id || null;
		}

		if (canonicalId && canonicalId.startsWith("user_")) {
			const num = memoryService.cleanPhone(canonicalId);
			if (num && num.length >= 8) {
				canonicalId = `wa_${num}`;
			}
		}

		if (!canonicalId && uFact.author_name) {
			const num = memoryService.cleanPhone(uFact.author_name);
			if (num && num.length >= 8) {
				canonicalId = `wa_${num}`;
			}
		}

		return canonicalId;
	}

	// Caso A: IA retorna user_id canônico direto
	const resA = resolveId({ user_id: "wa_5515997269052", author_name: "Guilherme" });
	assert.strictEqual(resA, "wa_5515997269052", "Caso A: Deve resolver diretamente pelo user_id");

	// Caso B: IA retorna [ID: wa_5515997269052] (com colchetes copiados da conversa)
	const resB = resolveId({ user_id: "[ID: wa_5515997269052]", author_name: "Guilherme" });
	assert.strictEqual(resB, "wa_5515997269052", "Caso B: Deve extrair ID de dentro de colchetes");

	// Caso C: IA retorna apenas os dígitos do telefone
	const resC = resolveId({ user_id: "5515997269052" });
	assert.strictEqual(resC, "wa_5515997269052", "Caso C: Deve resolver telefone puro para wa_");

	// Caso D: IA não envia user_id, mas envia author_name simplificado para nome com fonte Fraktur/símbolos
	const resD = resolveId({ author_name: "Bakugo" });
	assert.strictEqual(
		resD,
		"wa_559684218693",
		"Caso D: Fallback por nome deve casar 'Bakugo' com '꧁༒☬༒꧂💥 𝔅𝔞𝔨𝔲𝔤𝔬𝔲💥꧁༒☬༒꧂'"
	);

	// Caso E: IA retorna variante itálica de Lary
	const resE = resolveId({ author_name: "ﾟ.:｡+ﾟ×𝘭ɑ𝘳𝘺×.:｡+ﾟ" });
	assert.strictEqual(
		resE,
		"wa_5519953243942",
		"Caso E: Fallback por nome deve casar variantes de Lary"
	);

	// Caso F: IA retorna nome inexistente/interjeição 'Mds'
	const resF = resolveId({ author_name: "Mds" });
	assert.strictEqual(resF, null, "Caso F: 'Mds' sem correspondência real deve retornar null");

	console.log("✓ Todos os casos de resolução por ID canônico e fallbacks passaram com sucesso!");

	console.log("\n==========================================================");
	console.log("🎉 TESTES CONCLUÍDOS COM SUCESSO!");
	console.log("==========================================================");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Erro no teste:", err);
		process.exit(1);
	});
