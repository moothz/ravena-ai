// src/testing/test_invite_enrichment_and_routing.js
// Valida enriquecimento de dados em até 3 instâncias online, roteamento exclusivo site->telegram e whatsapp->whatsapp,
// envio com foto/caption, botões dinâmicos e resolução de conflito de webhook.

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const express = require("express");
const axios = require("axios");
const TelegramNotificationService = require("../services/TelegramNotificationService");
const { registerIndexRoutes } = require("../BotAPI/routes/indexRoutes");
const InviteSystem = require("../InviteSystem");

async function runTests() {
	console.log("=== INICIANDO TESTES: Enriquecimento de Convites, Roteamento e Botões Telegram ===");

	const telegramCalls = [];
	const originalPost = axios.post;

	axios.post = async (url, data, config) => {
		telegramCalls.push({ url, data, config });
		if (url.includes("/sendMessage")) {
			return {
				data: {
					ok: true,
					result: {
						message_id: 1001,
						chat: { id: data.chat_id },
						text: data.text
					}
				}
			};
		}
		if (url.includes("/sendPhoto")) {
			return {
				data: {
					ok: true,
					result: {
						message_id: 1002,
						chat: { id: data.chat_id },
						photo: [{ file_id: "photo123" }],
						caption: data.caption
					}
				}
			};
		}
		if (url.includes("/editMessageText")) {
			return {
				data: {
					ok: true,
					result: {
						message_id: data.message_id,
						chat: { id: data.chat_id },
						text: data.text
					}
				}
			};
		}
		if (url.includes("/editMessageCaption")) {
			return {
				data: {
					ok: true,
					result: {
						message_id: data.message_id,
						chat: { id: data.chat_id },
						caption: data.caption
					}
				}
			};
		}
		if (url.includes("/answerCallbackQuery")) {
			return {
				data: {
					ok: true,
					result: true
				}
			};
		}
		if (url.includes("/deleteWebhook")) {
			return {
				data: {
					ok: true,
					result: true,
					description: "Webhook was deleted"
				}
			};
		}
		if (url.includes("/getUpdates")) {
			return {
				data: {
					ok: true,
					result: []
				}
			};
		}
		return originalPost(url, data, config);
	};

	try {
		// =========================================================================
		// 1. WhatsApp PV: Convite recebido deve ir APENAS para grupoInvites WhatsApp
		// =========================================================================
		console.log("\n1. Testando que convites recebidos pelo WhatsApp NÃO vão para o Telegram...");
		telegramCalls.length = 0;
		const waSentMessages = [];

		const mockWaBot = {
			id: "ravena14",
			nome: "ravena14",
			nomeExibir: "Ravena 14",
			isConnected: true,
			useTelegram: false,
			useDiscord: false,
			grupoInvites: "120363999999999999@g.us",
			grupoLogs: "120363888888888888@g.us",
			client: {
				getInviteInfo: async (code) => ({
					JID: "120363111111111111@g.us",
					Name: "Grupo WhatsApp Teste",
					ParticipantCount: 25
				})
			},
			sendMessage: async (target, content) => {
				waSentMessages.push({ target, content });
				return true;
			}
		};

		const mockDatabase = {
			databasePath: "/app/data",
			getManualGroupLeave: async () => null,
			getGroup: async () => null,
			isUserInviteBlocked: async () => false,
			isInviteBlocked: async () => false,
			getInviteHistoryByAuthor: async () => [{ code: "old1" }],
			getInviteHistoryByGroup: async () => [],
			getGroupMembershipPeriods: async () => [
				{
					bot_id: "ravena14",
					join_timestamp: Date.now() - 3600000,
					leave_timestamp: Date.now() - 1800000,
					duration: 1800000
				}
			],
			getDonations: async () => [{ numero: "5511999990001", valor: "50.00" }],
			wasInGroupBefore: async () => true,
			toggleUserInvites: async () => true,
			saveBlockedInvite: async () => true,
			addInviteHistory: async () => true,
			updateInviteHistoryGroupJid: async () => true,
			savePendingJoin: async () => true
		};

		const inviteSys = new InviteSystem(mockWaBot);
		inviteSys.database = mockDatabase;

		process.env.GRUPO_INVITES_TELEGRAM = "-5048016247";

		// Simula processamento de convite recebido no WhatsApp PV
		const authorId = "5511999990001@s.whatsapp.net";
		const inviteCode = "AbCdEfGhIjKlMnOpQrStUv";
		const mockMessage = {
			name: "Carlos",
			author: authorId,
			origin: { react: async () => true }
		};

		await inviteSys.handleInviteRequest(
			authorId,
			inviteCode,
			`https://chat.whatsapp.com/${inviteCode}`,
			"Motivo válido com mais de cinco caracteres para testes",
			mockMessage,
			null,
			null
		);

		// Valida que foi enviado para o grupoInvites do WhatsApp
		assert.ok(
			waSentMessages.some((m) => m.target === "120363999999999999@g.us"),
			"Convite do WhatsApp deve ter sido enviado para o grupoInvites do WhatsApp"
		);

		// Valida que NENHUMA notificação de convite foi enviada para o Telegram pelo InviteSystem
		const telegramInviteNotifs = telegramCalls.filter(
			(c) => c.url.includes("/sendMessage") && c.data.chat_id === "-5048016247"
		);
		assert.strictEqual(
			telegramInviteNotifs.length,
			0,
			"Convite recebido pelo WhatsApp NÃO deve gerar notificação no Telegram"
		);
		console.log("✓ Convite do WhatsApp encaminhado exclusivamente ao grupo de WhatsApp!");

		// =========================================================================
		// 2. Site /api/invite: Enriquecimento tentando em até 3 instâncias online
		// =========================================================================
		console.log("\n2. Testando enriquecimento do convite do site usando até 3 instâncias...");

		const attempts = [];
		const botFail1 = {
			id: "bot-fail-1",
			isConnected: true,
			useTelegram: false,
			useDiscord: false,
			client: {
				getInviteInfo: async (code) => {
					attempts.push("bot-fail-1");
					throw new Error("Timeout na primeira tentativa");
				}
			}
		};

		const botFail2 = {
			id: "bot-fail-2",
			isConnected: true,
			useTelegram: false,
			useDiscord: false,
			client: {
				getInviteInfo: async (code) => {
					attempts.push("bot-fail-2");
					throw new Error("Erro de conexão na segunda tentativa");
				}
			}
		};

		const botSuccess3 = {
			id: "bot-success-3",
			nomeExibir: "Bot Sucesso 3",
			isConnected: true,
			useTelegram: false,
			useDiscord: false,
			client: {
				getInviteInfo: async (code) => {
					attempts.push("bot-success-3");
					return {
						JID: "120363999999999999@g.us",
						Name: "Grupo do Site Incrível",
						ParticipantCount: 42
					};
				},
				getProfilePictureUrl: async (jid) => "https://s3.example.com/groupphoto.jpg"
			}
		};

		const botNeverCalled = {
			id: "bot-never-called",
			isConnected: true,
			useTelegram: false,
			useDiscord: false,
			client: {
				getInviteInfo: async () => {
					attempts.push("bot-never-called");
					return null;
				}
			}
		};

		const app = express();
		app.use(express.json());
		const pass = (req, res, next) => next();

		const api = {
			app,
			bots: [botFail1, botFail2, botSuccess3, botNeverCalled],
			authenticateBasic: pass,
			strictLimiter: pass,
			isAdmin: () => false,
			setAdminSessionCookie: () => {},
			clearAdminSessionCookie: () => {},
			readWebManagementToken: () => null,
			logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
			database: mockDatabase
		};

		registerIndexRoutes(api);

		const server = await new Promise((resolve) => {
			const s = app.listen(0, "127.0.0.1", () => resolve(s));
		});
		const baseUrl = `http://127.0.0.1:${server.address().port}`;

		telegramCalls.length = 0;
		attempts.length = 0;

		const resSite = await fetch(`${baseUrl}/api/invite`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				link: "https://chat.whatsapp.com/SiteInviteCode12345678",
				contato: "5511999990001",
				motivo: "Grupo de desenvolvimento e jogos da comunidade"
			})
		});

		assert.strictEqual(resSite.status, 200, "POST /api/invite deve retornar 200");
		const dataSite = await resSite.json();
		assert.strictEqual(dataSite.status, "ok");

		// Verifica que tentou os bots 1, 2 e obteve sucesso no 3 (sem chamar o 4º)
		assert.deepStrictEqual(
			attempts,
			["bot-fail-1", "bot-fail-2", "bot-success-3"],
			"Deve tentar em até 3 bots online e parar no primeiro sucesso"
		);

		// Verifica que a notificação foi enviada ao Telegram como photo com caption rica
		const photoCall = telegramCalls.find((c) => c.url.includes("/sendPhoto"));
		assert.ok(photoCall, "Deve ter enviado foto do grupo com caption");
		assert.strictEqual(photoCall.data.photo, "https://s3.example.com/groupphoto.jpg");
		const caption = photoCall.data.caption;
		assert.ok(caption.includes("Grupo do Site Incrível"), "Deve conter nome do grupo");
		assert.ok(caption.includes("42"), "Deve conter quantidade de membros");
		assert.ok(caption.includes("Doador: R$50"), "Deve identificar que o usuário é doador");
		assert.ok(
			caption.includes("Já esteve neste grupo anteriormente!"),
			"Deve avisar permanência prévia"
		);
		assert.ok(
			caption.includes("Histórico de Estadia no Grupo"),
			"Deve incluir histórico de estadia"
		);

		console.log("✓ Enriquecimento em até 3 instâncias com foto e dados validado com sucesso!");

		// =========================================================================
		// 3. Testes de Botões Inline do Telegram e Webhook
		// =========================================================================
		console.log("\n3. Testando botões do Telegram e edição de caption...");

		const tgService = TelegramNotificationService.getInstance({
			bots: [botSuccess3],
			database: mockDatabase
		});

		// 3.1 deleteWebhook
		telegramCalls.length = 0;
		const delWh = await tgService.deleteWebhook();
		assert.strictEqual(delWh, true, "deleteWebhook deve retornar true");
		assert.ok(telegramCalls.some((c) => c.url.includes("/deleteWebhook")));

		// 3.2 handleCallbackQuery em mensagem com caption (foto)
		telegramCalls.length = 0;
		let acceptedCode = null;
		botSuccess3.client.acceptInvite = async (code) => {
			acceptedCode = code;
			return { accepted: true };
		};

		const callbackJoin = {
			id: "query-join-1",
			data: "join:bot-success-3:SiteInviteCode12345678",
			from: { username: "admin_tester" },
			message: {
				message_id: 1002,
				chat: { id: "-5048016247" },
				caption,
				photo: [{ file_id: "photo123" }]
			}
		};

		const joinHandled = await tgService.handleCallbackQuery(callbackJoin);
		assert.strictEqual(joinHandled, true, "handleCallbackQuery deve processar join com sucesso");
		assert.strictEqual(
			acceptedCode,
			"SiteInviteCode12345678",
			"Bot deve aceitar o código do convite"
		);

		// Verifica que editou o caption (não o text)
		const editCaptionCall = telegramCalls.find((c) => c.url.includes("/editMessageCaption"));
		assert.ok(editCaptionCall, "Deve usar editMessageCaption para mensagens com foto");
		assert.ok(
			editCaptionCall.data.caption.includes("Convite aceito com sucesso por Bot Sucesso 3")
		);
		assert.ok(editCaptionCall.data.caption.includes("@admin_tester"));

		// 3.3 Endpoint POST /api/telegram/webhook da BotAPI
		telegramCalls.length = 0;
		const resWebhook = await fetch(`${baseUrl}/api/telegram/webhook`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				callback_query: {
					id: "query-blk-1",
					data: "blk_grp:SiteInviteCode12345678",
					from: { username: "mod_tester" },
					message: {
						message_id: 1002,
						chat: { id: "-5048016247" },
						caption,
						photo: [{ file_id: "photo123" }]
					}
				}
			})
		});
		assert.strictEqual(resWebhook.status, 200, "POST /api/telegram/webhook deve retornar 200");
		const dataWebhook = await resWebhook.json();
		assert.strictEqual(dataWebhook.ok, true);

		const editBlockCall = telegramCalls.find((c) => c.url.includes("/editMessageCaption"));
		assert.ok(editBlockCall, "Webhook deve executar ação de bloqueio de grupo");
		assert.ok(editBlockCall.data.caption.includes("Grupo bloqueado para convites"));

		console.log("✓ Botões do Telegram e endpoint de webhook validados com sucesso!");

		await new Promise((resolve) => server.close(resolve));
	} finally {
		axios.post = originalPost;
	}

	console.log("\n=== TODOS OS TESTES PASSARAM COM 100% DE SUCESSO! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha nos testes:", err);
		process.exit(1);
	});
