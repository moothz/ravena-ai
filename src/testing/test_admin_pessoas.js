// src/testing/test_admin_pessoas.js
// Funções puras da área "Pessoas e grupos" do /admin (public/admin/areas/pessoas/lib.js):
// faixa de risco, tópicos, junção das duas fontes de grupos (memória RME e análises antigas),
// busca nas análises e escolha da conta do RavenaBank para "Abrir no Banco".
// Dados sintéticos.

const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

async function runTests() {
	console.log("=== Teste da área Pessoas e grupos do /admin ===");
	const lib = await import(
		pathToFileURL(path.join(__dirname, "../../public/admin/areas/pessoas/lib.js")).href
	);

	// Faixa de risco igual às telas antigas: ≥ 7 alta, ≥ 4 média, senão baixa.
	assert.deepStrictEqual(lib.riskLevel(7), { level: "alto", kind: "bad" });
	assert.deepStrictEqual(lib.riskLevel(6.9), { level: "médio", kind: "att" });
	assert.deepStrictEqual(lib.riskLevel(4), { level: "médio", kind: "att" });
	assert.deepStrictEqual(lib.riskLevel(0), { level: "baixo", kind: "ok" });
	assert.deepStrictEqual(lib.riskLevel(null), { level: null, kind: "" });
	assert.deepStrictEqual(lib.riskLevel("x"), { level: null, kind: "" });
	assert.strictEqual(lib.scoreText(7.25), "7,3");
	assert.strictEqual(lib.scoreText(0), "0,0");
	assert.strictEqual(lib.scoreText(undefined), "—");
	console.log("✓ riskLevel e scoreText.");

	// Tópicos: JSON em texto, lista pronta, inválido.
	assert.deepStrictEqual(lib.parseTopics('["jogos","memes"]'), ["jogos", "memes"]);
	assert.deepStrictEqual(lib.parseTopics(["a", "", "b"]), ["a", "b"]);
	assert.deepStrictEqual(lib.parseTopics("{quebrado"), []);
	assert.deepStrictEqual(lib.parseTopics(null), []);
	assert.deepStrictEqual(lib.parseTopics('{"a":1}'), []);
	console.log("✓ parseTopics.");

	// Estatística do histórico (como a /groups-dossier calculava).
	assert.deepStrictEqual(lib.historyStats([{ problematic_score: 2 }, { problematic_score: 8 }]), {
		max: 8,
		avg: 5
	});
	assert.deepStrictEqual(lib.historyStats([]), { max: null, avg: null });
	console.log("✓ historyStats.");

	// Junção das fontes.
	const profiles = [
		{
			group_id: "g1@g.us",
			title: "Clube do Livro",
			average_problematic_score: 2,
			dossiers_count: 3,
			problematic_reports_count: 0
		},
		{
			group_id: "g2@g.us",
			title: null,
			average_problematic_score: 8.5,
			dossiers_count: 1,
			problematic_reports_count: 1
		}
	];
	const analyses = [
		{
			id: "g1@g.us",
			name: "Clube do Livro (antigo)",
			bot_id: "ravena-1",
			avg_score: 5,
			total_chars: 12000,
			pending_chars: 300,
			history: [
				{ type: "leitura", summary: "Discussões sobre romances", problematic_score: 6 },
				{ type: "leitura", summary: "Clube calmo", problematic_score: 4 }
			]
		},
		{
			id: "g3@g.us",
			name: "Grupo Desconhecido",
			bot_id: "-",
			avg_score: 1,
			history: [{ type: "jogos", summary: "Partidas de xadrez", problematic_score: 1 }]
		}
	];
	const merged = lib.mergeGroups(profiles, analyses);
	assert.deepStrictEqual(
		merged.map((g) => g.id),
		["g2@g.us", "g1@g.us", "g3@g.us"],
		"ordena pela maior nota primeiro"
	);
	const g1 = merged.find((g) => g.id === "g1@g.us");
	assert.strictEqual(g1.name, "Clube do Livro", "nome do perfil da memória tem prioridade");
	assert.strictEqual(g1.bot, "ravena-1");
	assert.strictEqual(g1.score, 5, "nota para ordenar = maior entre perfil e média das análises");
	assert.strictEqual(g1.profileScore, 2);
	assert.strictEqual(g1.max, 6);
	assert.strictEqual(g1.avg, 5);
	assert.strictEqual(g1.dossiers, 3);
	assert.strictEqual(g1.analysesCount, 2);
	const g2 = merged.find((g) => g.id === "g2@g.us");
	assert.strictEqual(g2.name, "g2@g.us", "sem título usa o id");
	assert.strictEqual(g2.analyses, null);
	assert.strictEqual(g2.analysesCount, null);
	assert.strictEqual(g2.reports, 1);
	const g3 = merged.find((g) => g.id === "g3@g.us");
	assert.strictEqual(g3.name, "g3@g.us", "'Grupo Desconhecido' não vira nome");
	assert.strictEqual(g3.bot, null, "bot '-' some");
	assert.strictEqual(g3.profile, null);
	assert.strictEqual(g3.dossiers, null);
	assert.deepStrictEqual(lib.mergeGroups(null, undefined), []);
	console.log("✓ mergeGroups junta pelo id e ordena por risco.");

	// Busca nas análises antigas (a rota não tem busca): nome, id, bot, tipo, resumo, sem acento.
	assert.strictEqual(lib.filterAnalyses(analyses, "").length, 2);
	assert.deepStrictEqual(
		lib.filterAnalyses(analyses, "XADREZ").map((a) => a.id),
		["g3@g.us"]
	);
	assert.deepStrictEqual(
		lib.filterAnalyses(analyses, "discussoes").map((a) => a.id),
		["g1@g.us"]
	);
	assert.deepStrictEqual(
		lib.filterAnalyses(analyses, "ravena-1").map((a) => a.id),
		["g1@g.us"]
	);
	assert.deepStrictEqual(lib.filterAnalyses(analyses, "nada-disso"), []);
	console.log("✓ filterAnalyses.");

	// Conta no RavenaBank: candidatos e escolha exata.
	const d = {
		canonical_user_id: "wa_5511900000001",
		identities: [
			{ platform: "whatsapp", platform_id: "123456789012345@lid" },
			{ platform: "whatsapp", platform_id: "5511900000001@s.whatsapp.net" },
			{ platform: "telegram", platform_id: "987654321" },
			{ platform: "whatsapp", platform_id: "12@lid" }
		]
	};
	assert.deepStrictEqual(lib.bankCandidates(d), ["5511900000001", "123456789012345"]);
	assert.deepStrictEqual(lib.bankCandidates({ canonical_user_id: "user_fulano" }), []);
	assert.deepStrictEqual(lib.bankCandidates(null), []);
	const users = [
		{ userId: "551190000000199", updatedAt: 1 },
		{ userId: "123456789012345", updatedAt: null },
		{ userId: "5511900000001", updatedAt: 1700000000000 }
	];
	assert.strictEqual(lib.pickBankAccount(users, ["5511900000001"]).userId, "5511900000001");
	assert.strictEqual(
		lib.pickBankAccount(users, ["123456789012345"]),
		null,
		"quem só casa pelo apelido (sem conta) não conta"
	);
	assert.strictEqual(lib.pickBankAccount(users, ["5511"]), null, "precisa ser igual, não parecido");
	assert.strictEqual(lib.pickBankAccount(null, ["1"]), null);
	console.log("✓ bankCandidates e pickBankAccount.");

	// Pequenos auxiliares.
	assert.strictEqual(lib.platformLabel("whatsapp"), "WhatsApp");
	assert.strictEqual(lib.platformLabel("telegram"), "Telegram");
	assert.strictEqual(lib.personId({ canonical_user_id: "wa_1", platform_id: "x" }), "wa_1");
	assert.strictEqual(lib.personId({ platform_id: "x@lid" }), "x@lid");
	assert.strictEqual(lib.toMs("2026-11-21 15:00:00"), Date.UTC(2026, 10, 21, 15, 0, 0));
	assert.strictEqual(lib.toMs(1763737200), 1763737200000, "segundos viram ms");
	assert.strictEqual(lib.toMs(1763737200000), 1763737200000);
	assert.strictEqual(lib.toMs(0), null);
	assert.strictEqual(lib.toMs(""), null);
	assert.strictEqual(lib.toMs("não é data"), null);
	console.log("✓ platformLabel, personId e toMs.");

	console.log("Todos os testes da área Pessoas e grupos passaram.");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("✗ Falhou:", err);
		process.exit(1);
	});
