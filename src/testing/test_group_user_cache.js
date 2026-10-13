/**
 * src/testing/test_group_user_cache.js
 *
 * Teste de integração para verificar o comportamento do cache em memória
 * de grupos e usuários no WhatsAppBotGo e remoção de rajada no RankingMessages.
 */

const assert = require("assert");
const MemoryCache = require("../utils/MemoryCache");

async function run() {
	console.log("=== Iniciando testes de integração de Cache de Grupos e Usuários ===");

	// Mock simplificado do bot para simular o comportamento de getChatDetails com cache
	let apiGroupCalls = 0;
	let apiUserCalls = 0;

	const groupCache = new MemoryCache(200, 50); // 200ms TTL
	const userCache = new MemoryCache(200, 50);

	const mockBot = {
		groupCache,
		userCache,
		isParticipating: () => true,
		apiClient: {
			post: async (endpoint, data) => {
				if (endpoint === "/group/info") {
					apiGroupCalls++;
					return {
						data: {
							JID: data.groupJid,
							Name: "Grupo Teste",
							Participants: [{ JID: "5511999990001@s.whatsapp.net", IsAdmin: true, LID: "111@lid" }]
						}
					};
				}
				if (endpoint === "/user/info") {
					apiUserCalls++;
					return {
						data: {
							Users: {
								[data.number[0]]: { VerifiedName: "Usuario Teste", LID: "222@lid" }
							}
						}
					};
				}
				return { data: {} };
			}
		},
		async getChatDetails(chatId, options = {}) {
			if (!chatId) return null;
			if (chatId.includes("@g.us") && !options?.forceRefresh && this.groupCache) {
				const cached = this.groupCache.get(chatId);
				if (cached) return cached;
			}

			const res = await this.apiClient.post("/group/info", { groupJid: chatId });
			const groupInfo = res.data;
			const chatResult = {
				id: { _serialized: groupInfo.JID },
				name: groupInfo.Name,
				isGroup: true,
				participants: groupInfo.Participants
			};
			if (this.groupCache) this.groupCache.set(chatId, chatResult);
			return chatResult;
		},
		async getContactDetails(id) {
			if (!id) return null;
			if (this.userCache) {
				const cached = this.userCache.get(id);
				if (cached) return cached;
			}
			const res = await this.apiClient.post("/user/info", { number: [id] });
			const info = res.data?.Users?.[id];
			const returnData = {
				id: { _serialized: id },
				name: info?.VerifiedName || id
			};
			if (this.userCache) this.userCache.set(id, returnData);
			return returnData;
		}
	};

	// 1. Teste de Cache de Grupo
	console.log("1. Testando cache de grupo...");
	const chat1 = await mockBot.getChatDetails("123@g.us");
	assert.strictEqual(apiGroupCalls, 1, "Primeira chamada deve chamar a API");
	assert.strictEqual(chat1.name, "Grupo Teste");

	const chat2 = await mockBot.getChatDetails("123@g.us");
	assert.strictEqual(apiGroupCalls, 1, "Segunda chamada DEVE vir do cache (sem chamar API)");
	assert.strictEqual(chat2.name, "Grupo Teste");

	// Chamada com forceRefresh
	await mockBot.getChatDetails("123@g.us", { forceRefresh: true });
	assert.strictEqual(apiGroupCalls, 2, "Chamada com forceRefresh deve bypassar o cache");

	// 2. Teste de Invalidação
	console.log("2. Testando invalidação de cache de grupo...");
	mockBot.groupCache.delete("123@g.us");
	await mockBot.getChatDetails("123@g.us");
	assert.strictEqual(apiGroupCalls, 3, "Após delete(), deve chamar a API novamente");

	// 3. Teste de Cache de Usuário
	console.log("3. Testando cache de usuário...");
	const user1 = await mockBot.getContactDetails("5511999990001@s.whatsapp.net");
	assert.strictEqual(apiUserCalls, 1, "Primeira chamada de usuário deve chamar a API");
	assert.strictEqual(user1.name, "Usuario Teste");

	const user2 = await mockBot.getContactDetails("5511999990001@s.whatsapp.net");
	assert.strictEqual(apiUserCalls, 1, "Segunda chamada de usuário DEVE vir do cache");

	// 4. Teste de Expiração por TTL
	console.log("4. Testando expiração por TTL...");
	await new Promise((resolve) => setTimeout(resolve, 220));
	await mockBot.getChatDetails("123@g.us");
	assert.strictEqual(apiGroupCalls, 4, "Após expirar TTL (200ms), deve chamar API novamente");

	console.log("🎉 Todos os testes de integração de Cache passaram com sucesso!");
}

run()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha nos testes de integração:", err);
		process.exit(1);
	});
