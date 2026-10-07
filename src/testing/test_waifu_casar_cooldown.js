"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const WaifuCommands = require("../functions/WaifuCommands");

async function main() {
	console.log("=== Iniciando teste de tratamento de Cooldown no Casamento Waifuletes ===");

	const bot = new FakeBot({ id: "teste", grupoLogs: "123@g.us" });

	const msgCasar = createMessage({
		content: "!mu-casar izumi-blue-archive",
		group: "group123@g.us",
		author: "5511999999999@s.whatsapp.net"
	});

	// Mock do handleApiError testando diretamente os comportamentos
	// 1. Simulação do erro retornado da API de casamento quando usuário está em claim cooldown
	const marryCooldownError = {
		response: {
			data: {
				success: false,
				error: {
					code: "COOLDOWN_ACTIVE",
					message: "Você precisa aguardar 1h 45min para realizar outro casamento.",
					remainingSeconds: 6355,
					retryAfter: new Date(Date.now() + 6355 * 1000).toISOString()
				}
			}
		}
	};

	// 2. Simulação do erro retornado com código novo CLAIM_COOLDOWN_ACTIVE
	const marryExplicitCooldownError = {
		response: {
			data: {
				success: false,
				error: {
					code: "CLAIM_COOLDOWN_ACTIVE",
					message: "Você precisa aguardar 2h 10min para realizar outro casamento.",
					remainingSeconds: 7800
				}
			}
		}
	};

	// 3. Simulação de erro real de roll (falta de rolls)
	const rollCooldownError = {
		response: {
			data: {
				success: false,
				error: {
					code: "COOLDOWN_ACTIVE",
					message: "Você não possui rolls disponíveis!",
					remainingSeconds: 180,
					currentRolls: 0,
					maxRolls: 10,
					fullRechargeSeconds: 1800
				}
			}
		}
	};

	// Teste 1: Marry Cooldown com código genérico COOLDOWN_ACTIVE (legado)
	console.log("[Teste 1] Testando marry cooldown com COOLDOWN_ACTIVE...");
	const retMarryLegacy = WaifuCommands.handleApiError(
		marryCooldownError,
		"group123@g.us",
		"Erro ao realizar casamento."
	);
	console.log("Resposta:", retMarryLegacy.content);
	assert.ok(
		!retMarryLegacy.content.includes("Sem rolls disponíveis"),
		"Mensagem de casamento em cooldown NÃO pode falar de rolls!"
	);
	assert.ok(
		retMarryLegacy.content.includes("Cooldown de Casamento"),
		"Mensagem deve informar Cooldown de Casamento!"
	);
	assert.ok(
		retMarryLegacy.content.includes("1h 45min"),
		"Mensagem deve conter o tempo restante do casamento!"
	);

	// Teste 2: Marry Cooldown com código explícito CLAIM_COOLDOWN_ACTIVE
	console.log("[Teste 2] Testando marry cooldown com CLAIM_COOLDOWN_ACTIVE...");
	const retMarryExplicit = WaifuCommands.handleApiError(
		marryExplicitCooldownError,
		"group123@g.us",
		"Erro ao realizar casamento."
	);
	console.log("Resposta:", retMarryExplicit.content);
	assert.ok(
		!retMarryExplicit.content.includes("Sem rolls disponíveis"),
		"Mensagem NÃO pode falar de rolls!"
	);
	assert.ok(
		retMarryExplicit.content.includes("Cooldown de Casamento"),
		"Mensagem deve conter Cooldown de Casamento!"
	);

	// Teste 3: Roll Cooldown deve continuar exibindo 'Sem rolls disponíveis!'
	console.log("[Teste 3] Testando roll cooldown (0/10 rolls)...");
	const retRoll = WaifuCommands.handleApiError(
		rollCooldownError,
		"group123@g.us",
		"Erro ao sortear."
	);
	console.log("Resposta:", retRoll.content);
	assert.ok(
		retRoll.content.includes("Sem rolls disponíveis!"),
		"Roll cooldown deve avisar sobre falta de rolls!"
	);
	assert.ok(
		retRoll.content.includes("0/10"),
		"Roll cooldown deve conter contagem de rolls (0/10)!"
	);

	console.log("=== Todos os testes de Cooldown passaram com sucesso! ===");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Erro no teste:", err);
		process.exit(1);
	});
