"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const SuperAdmin = require("../commands/SuperAdmin");

async function main() {
	console.log("=== Iniciando teste de sa-waifuCasar ===");

	const superAdmin = new SuperAdmin();
	const bot = new FakeBot({ id: "teste", grupoLogs: "123@g.us" });

	// 1. Validar mapeamentos de comando
	console.log("[Teste 1] Validando mapeamento do comando...");
	assert.strictEqual(
		superAdmin.getCommandMethod("waifuCasar"),
		"waifuCasar",
		"waifuCasar deve apontar para o método waifuCasar"
	);
	assert.strictEqual(
		superAdmin.getCommandMethod("waifucasar"),
		"waifuCasar",
		"waifucasar deve apontar para o método waifuCasar"
	);
	assert.strictEqual(
		superAdmin.getCommandMethod("waifu-casar"),
		"waifuCasar",
		"waifu-casar deve apontar para o método waifuCasar"
	);
	console.log("✓ Mapeamentos de comando OK");

	// 2. Validar bloqueio de usuário não-superadmin
	console.log("[Teste 2] Validando bloqueio para não-superadmin...");
	const msgNonAdmin = createMessage({
		content: "!sa-waifuCasar 5511888888888 yuuki-yoshino-shokugeki-no-souma",
		group: "group123@g.us",
		author: "551100000000@s.whatsapp.net"
	});
	const resNonAdmin = await superAdmin.waifuCasar(bot, msgNonAdmin, [
		"5511888888888",
		"yuuki-yoshino-shokugeki-no-souma"
	]);
	assert.ok(
		resNonAdmin.content.includes("exclusivo para SuperAdministradores"),
		"Deve bloquear usuário não autorizado"
	);
	console.log("✓ Bloqueio de não-superadmin OK");

	// Simula superadmin autorizando o autor
	superAdmin.isSuperAdmin = () => true;

	// 3. Validar validação de argumentos ausentes
	console.log("[Teste 3] Validando argumentos ausentes...");
	const msgAdmin = createMessage({
		content: "!sa-waifuCasar",
		group: "group123@g.us",
		author: "5511999999999@s.whatsapp.net"
	});
	const resMissing = await superAdmin.waifuCasar(bot, msgAdmin, []);
	assert.ok(resMissing.content.includes("Uso correto"), "Deve exibir uso correto");

	// 4. Validar número de telefone inválido
	console.log("[Teste 4] Validando telefone inválido...");
	const resInvalidNum = await superAdmin.waifuCasar(bot, msgAdmin, ["abc", "personagem"]);
	assert.ok(
		resInvalidNum.content.includes("Número de usuário inválido"),
		"Deve rejeitar telefone inválido"
	);

	// 5. Validar resposta de sucesso da API
	console.log("[Teste 5] Validando fluxo com resposta da API...");
	const WaifuCommands = require("../functions/WaifuCommands");
	const originalPost = WaifuCommands.api.post;

	WaifuCommands.api.post = async (url, payload) => {
		assert.strictEqual(url, "/admin/marry", "Endpoint deve ser /admin/marry");
		assert.strictEqual(payload.userId, "5511999999999");
		assert.strictEqual(payload.characterId, "izumi-blue-archive");
		return {
			data: {
				success: true,
				data: {
					message: "Casamento administrativo realizado com sucesso com Izumi! 💍",
					character: {
						id: "izumi-blue-archive",
						name: "Izumi",
						series: "Blue Archive",
						rarity: "COMMON"
					},
					keys: 1,
					user: { id: "5511999999999", name: "Usuário Teste" }
				}
			}
		};
	};

	try {
		// Testando sintaxe com "casar com"
		const resSuccess = await superAdmin.waifuCasar(bot, msgAdmin, [
			"5511999999999",
			"casar",
			"com",
			"izumi-blue-archive"
		]);
		assert.ok(
			resSuccess.content.includes("Casamento Administrativo Realizado com Sucesso"),
			"Deve conter mensagem de sucesso"
		);
		assert.ok(resSuccess.content.includes("Izumi"), "Deve conter nome da waifu");
		assert.ok(resSuccess.content.includes("5511999999999"), "Deve conter número do usuário");
		console.log("✓ Fluxo de sucesso com parsing de 'casar com' OK");
	} finally {
		WaifuCommands.api.post = originalPost;
	}

	console.log("=== Todos os testes de sa-waifuCasar passaram com sucesso! ===");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Erro no teste:", err);
		process.exit(1);
	});
