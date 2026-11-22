process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const Group = require("../models/Group");

async function main() {
	console.log("=== Testando Delay Orgânico de Boas-vindas e Despedidas ===");

	const eventHandler = new EventHandler();

	// 1. Teste da geração de delay aleatório
	console.log("1. Testando intervalo do getGreetingDelay (10s a 45s)...");
	const testBot = new FakeBot({ id: "delay-test" });

	// Com testMode ativo e sem enableGreetingDelay -> deve ser 0
	const zeroDelay = eventHandler.getGreetingDelay(testBot);
	assert.strictEqual(zeroDelay, 0, "Deveria retornar 0 delay para bot em testMode");

	// Sem testMode ou com enableGreetingDelay -> deve ser entre 10000 e 45000 ms
	testBot.enableGreetingDelay = true;
	for (let i = 0; i < 100; i++) {
		const delay = eventHandler.getGreetingDelay(testBot);
		assert(delay >= 10000 && delay <= 45000, `Delay fora do intervalo de 10s a 45s: ${delay}ms`);
	}
	// Com bot = null (comportamento de produção)
	for (let i = 0; i < 100; i++) {
		const delay = eventHandler.getGreetingDelay(null);
		assert(delay >= 10000 && delay <= 45000, `Delay com bot=null fora do intervalo: ${delay}ms`);
	}
	console.log("✓ getGreetingDelay gera valores estritamente entre 10.000ms e 45.000ms.");

	// 2. Teste do cálculo de tempo restante em waitRemainingGreetingDelay
	console.log("2. Testando waitRemainingGreetingDelay com tempo decorrido...");
	const start = Date.now() - 50; // 50ms já decorridos
	const target = 100; // alvo de 100ms
	const t0 = Date.now();
	testBot.enableGreetingDelay = true;
	await eventHandler.waitRemainingGreetingDelay(start, target, testBot);
	const elapsed = Date.now() - t0;
	// Deve esperar cerca de 50ms (100 - 50)
	assert(
		elapsed >= 40 && elapsed < 200,
		`Tempo de espera incorreto: esperado ~50ms, medido ${elapsed}ms`
	);
	console.log(`✓ waitRemainingGreetingDelay aguardou ${elapsed}ms correspondente ao restante.`);

	// 3. Teste quando o tempo decorrido já excedeu o targetDelay
	const pastStart = Date.now() - 200;
	const pastTarget = 100;
	const tPast0 = Date.now();
	await eventHandler.waitRemainingGreetingDelay(pastStart, pastTarget, testBot);
	const elapsedPast = Date.now() - tPast0;
	assert(elapsedPast < 20, `Não deveria esperar quando já expirou: ${elapsedPast}ms`);
	console.log("✓ waitRemainingGreetingDelay não espera se o tempo já tiver expirado.");

	// 4. Teste de integração: Bot entra no grupo com delay orgânico
	console.log("4. Testando delay no join do bot...");
	{
		const bot = new FakeBot({ id: "ravenabot", phoneNumber: "5511999990001" });
		bot.enableGreetingDelay = true;
		// Configuramos delay customizado curto para teste rápido (100 a 150ms)
		eventHandler.greetingDelayMin = 100;
		eventHandler.greetingDelayMax = 150;

		const groupId = `test_delay_bot_${Date.now()}@g.us`;
		const eventData = {
			group: { id: groupId, name: "Grupo Teste Delay Bot" },
			user: { id: "5511999990001@s.whatsapp.net", name: "ravenabot" },
			responsavel: { id: "5511999990002@s.whatsapp.net", name: "Admin" },
			isBotJoining: true,
			origin: {
				getChat: async () => ({
					id: { _serialized: groupId },
					name: "Grupo Teste Delay Bot",
					participants: []
				})
			}
		};

		const joinStart = Date.now();
		await eventHandler.processGroupJoin(bot, eventData);
		const joinElapsed = Date.now() - joinStart;

		const sent = bot.capturedMessages.filter((m) => m.chatId === groupId);
		assert(sent.length >= 1, "Mensagem de boas-vindas do bot não foi enviada");
		assert(
			joinElapsed >= 90,
			`Boas-vindas do bot enviadas sem delay esperado: decorreu ${joinElapsed}ms`
		);
		console.log(`✓ Boas-vindas do bot enviadas após ${joinElapsed}ms de delay orgânico.`);
	}

	// 5. Teste de integração: Membro entra no grupo com boas-vindas configuradas
	console.log("5. Testando delay nas boas-vindas de membro...");
	{
		const bot = new FakeBot({ id: "ravenabot", phoneNumber: "5511999990001" });
		bot.enableGreetingDelay = true;
		eventHandler.greetingDelayMin = 100;
		eventHandler.greetingDelayMax = 150;

		const groupId = `test_delay_member_${Date.now()}@g.us`;
		const group = new Group({
			id: groupId,
			name: "Grupo Teste Membro",
			prefix: "!",
			greetings: {
				text: "Seja bem-vindo(a) {pessoa} ao grupo {nomeGrupo}!"
			}
		});
		eventHandler.groups[groupId] = group;

		const eventData = {
			group: { id: groupId, name: "Grupo Teste Membro" },
			user: { id: "5511999990003@s.whatsapp.net", name: "NovoMembro" },
			responsavel: { id: "5511999990002@s.whatsapp.net", name: "Admin" },
			isBotJoining: false,
			origin: {
				getChat: async () => ({
					id: { _serialized: groupId },
					name: "Grupo Teste Membro",
					participants: []
				})
			}
		};

		const memberStart = Date.now();
		await eventHandler.processGroupJoin(bot, eventData);
		const memberElapsed = Date.now() - memberStart;

		const sent = bot.capturedMessages.filter((m) => m.chatId === groupId);
		assert(sent.length >= 1, "Boas-vindas de membro não foram enviadas");
		assert(sent[0].content.includes("Seja bem-vindo"), `Conteúdo inesperado: ${sent[0].content}`);
		assert(memberElapsed >= 90, `Boas-vindas enviadas sem delay: decorreu ${memberElapsed}ms`);
		console.log(`✓ Boas-vindas de membro enviadas após ${memberElapsed}ms de delay orgânico.`);
	}

	// 6. Teste de integração: Membro sai do grupo com despedida configurada
	console.log("6. Testando delay na despedida de membro...");
	{
		const bot = new FakeBot({ id: "ravenabot", phoneNumber: "5511999990001" });
		bot.enableGreetingDelay = true;
		eventHandler.greetingDelayMin = 100;
		eventHandler.greetingDelayMax = 150;

		const groupId = `test_delay_leave_${Date.now()}@g.us`;
		const group = new Group({
			id: groupId,
			name: "Grupo Teste Despedida",
			prefix: "!",
			farewells: {
				text: "Adeus {pessoa}, sentiremos sua falta!"
			}
		});
		eventHandler.groups[groupId] = group;

		const eventData = {
			group: { id: groupId, name: "Grupo Teste Despedida" },
			user: { id: "5511999990004@s.whatsapp.net", name: "MembroSaindo" },
			responsavel: { id: "5511999990004@s.whatsapp.net", name: "MembroSaindo" },
			isBotLeaving: false,
			origin: {
				getChat: async () => ({
					id: { _serialized: groupId },
					name: "Grupo Teste Despedida",
					participants: []
				})
			}
		};

		const leaveStart = Date.now();
		await eventHandler.processGroupLeave(bot, eventData);
		const leaveElapsed = Date.now() - leaveStart;

		const sent = bot.capturedMessages.filter((m) => m.chatId === groupId);
		assert(sent.length >= 1, "Despedida de membro não foi enviada");
		assert(sent[0].content.includes("Adeus"), `Conteúdo inesperado: ${sent[0].content}`);
		assert(leaveElapsed >= 90, `Despedida enviada sem delay: decorreu ${leaveElapsed}ms`);
		console.log(`✓ Despedida de membro enviada após ${leaveElapsed}ms de delay orgânico.`);
	}

	// Restaura valores padrão para o EventHandler
	eventHandler.greetingDelayMin = 10000;
	eventHandler.greetingDelayMax = 45000;

	console.log("=== Todos os testes de delay orgânico passaram com sucesso! ===");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro no teste:", err);
		process.exit(1);
	});
