// src/testing/test_telegram_notification_and_invite.js
// Testes para TelegramNotificationService, roteamento de convites (Telegram vs WhatsApp com priorização)
// e detecção de bloqueios (usuário, código e JID) na rota POST /api/invite

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const express = require("express");
const axios = require("axios");
const TelegramNotificationService = require("../services/TelegramNotificationService");
const { registerIndexRoutes } = require("../BotAPI/routes/indexRoutes");

async function runTests() {
	console.log("=== INICIANDO TESTES: TelegramNotificationService & Invites do Site ===\n");

	// Intercepta chamadas do axios para Telegram API
	const originalPost = axios.post;
	const telegramCalls = [];

	axios.post = async (url, data, config) => {
		telegramCalls.push({ url, data, config });
		if (url.includes("/sendMessage")) {
			return {
				data: {
					ok: true,
					result: {
						message_id: 9999,
						chat: { id: data.chat_id },
						text: data.text
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
		if (url.includes("/answerCallbackQuery")) {
			return {
				data: {
					ok: true,
					result: true
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
		// 1. Testes Unitários do TelegramNotificationService
		// =========================================================================
		console.log("1. Testando TelegramNotificationService...");
		const service = TelegramNotificationService.getInstance({
			token: "123456:FAKE_TOKEN",
			chatId: "998877",
			inviteChatId: "-5048016247"
		});

		assert.ok(service, "Instância do serviço deve existir");

		// 1.1 sendAlert
		telegramCalls.length = 0;
		const alertRes = await service.sendAlert("🚨 Teste de Alerta");
		assert.strictEqual(alertRes.success, true, "sendAlert deve ter sucesso");
		assert.strictEqual(telegramCalls.length, 1);
		assert.strictEqual(telegramCalls[0].data.chat_id, "998877");
		assert.ok(telegramCalls[0].data.text.includes("Teste de Alerta"));

		// 1.2 sendInviteNotification com botões inline
		telegramCalls.length = 0;
		const inviteCode = "TestInviteCode12345678";
		const inviteRes = await service.sendInviteNotification({
			inviteCode,
			cleanPhone: "5511999990001",
			formattedContact: "João (5511999990001)",
			cleanReason: "Grupo focado em animes e bate-papo diário",
			chatId: "-5048016247"
		});
		assert.strictEqual(inviteRes.success, true, "sendInviteNotification deve ter sucesso");
		assert.strictEqual(telegramCalls.length, 1);
		const callData = telegramCalls[0].data;
		assert.strictEqual(callData.chat_id, "-5048016247");
		assert.ok(callData.text.includes(inviteCode), "Texto deve conter código de convite");
		assert.ok(callData.text.includes("João (5511999990001)"), "Texto deve conter contato");

		// Valida teclado inline
		const keyboard = callData.reply_markup?.inline_keyboard;
		assert.ok(Array.isArray(keyboard), "reply_markup deve conter inline_keyboard");
		assert.strictEqual(keyboard.length, 3, "Teclado deve ter 3 linhas de botões");

		// Linha 1: ravena13 e ravenavip
		assert.strictEqual(keyboard[0][0].text, "🟢 ravena13");
		assert.strictEqual(keyboard[0][0].callback_data, `join:ravena13:${inviteCode}`);
		assert.strictEqual(keyboard[0][1].text, "💎 ravenavip");
		assert.strictEqual(keyboard[0][1].callback_data, `join:ravenavip:${inviteCode}`);

		// Linha 2: NoxGley, Arkanis e Kingo
		assert.strictEqual(keyboard[1][0].text, "🔴 NoxGley");
		assert.strictEqual(keyboard[1][0].callback_data, `join:noxgley:${inviteCode}`);
		assert.strictEqual(keyboard[1][1].text, "🔴 Arkanis");
		assert.strictEqual(keyboard[1][1].callback_data, `join:rav-arkanis:${inviteCode}`);
		assert.strictEqual(keyboard[1][2].text, "🔴 Kingo");
		assert.strictEqual(keyboard[1][2].callback_data, `join:rav-kingo:${inviteCode}`);

		// Linha 3: Bloquear Número e Bloquear Grupo
		assert.strictEqual(keyboard[2][0].text, "⛔ Bloquear Número");
		assert.strictEqual(keyboard[2][0].callback_data, "blk_num:5511999990001");
		assert.strictEqual(keyboard[2][1].text, "🚫 Bloquear Grupo");
		assert.strictEqual(keyboard[2][1].callback_data, `blk_grp:${inviteCode}`);

		// 1.3 Teste de Hierarquia e Fallback de Token: NOTIFICATIONS_TELEGRAM_BOT_TOKEN > HEALTH_CHECK_TELEGRAM_BOT_TOKEN
		const originalNotifToken = process.env.NOTIFICATIONS_TELEGRAM_BOT_TOKEN;
		const originalHealthToken = process.env.HEALTH_CHECK_TELEGRAM_BOT_TOKEN;
		try {
			service.token = null;
			process.env.NOTIFICATIONS_TELEGRAM_BOT_TOKEN = "token_notif_prioritario";
			process.env.HEALTH_CHECK_TELEGRAM_BOT_TOKEN = "token_health_fallback";
			assert.strictEqual(
				service.getToken(),
				"token_notif_prioritario",
				"Deve priorizar NOTIFICATIONS_TELEGRAM_BOT_TOKEN"
			);

			delete process.env.NOTIFICATIONS_TELEGRAM_BOT_TOKEN;
			assert.strictEqual(
				service.getToken(),
				"token_health_fallback",
				"Deve recorrer a HEALTH_CHECK_TELEGRAM_BOT_TOKEN como fallback"
			);
		} finally {
			if (originalNotifToken !== undefined) {
				process.env.NOTIFICATIONS_TELEGRAM_BOT_TOKEN = originalNotifToken;
			} else {
				delete process.env.NOTIFICATIONS_TELEGRAM_BOT_TOKEN;
			}
			if (originalHealthToken !== undefined) {
				process.env.HEALTH_CHECK_TELEGRAM_BOT_TOKEN = originalHealthToken;
			} else {
				delete process.env.HEALTH_CHECK_TELEGRAM_BOT_TOKEN;
			}
			service.token = "123456:FAKE_TOKEN";
		}

		console.log("✓ Envio e geração de teclado inline validados com sucesso!");

		// =========================================================================
		// 2. Testes de Callback Query (Ações interativas do Telegram)
		// =========================================================================
		console.log("\n2. Testando handleCallbackQuery...");

		let acceptedInviteCode = null;
		let historyAdded = null;
		let userBlockedNum = null;
		let blockedInviteSaved = null;

		const mockDatabase = {
			toggleUserInvites: async (num, block) => {
				userBlockedNum = { num, block };
				return true;
			},
			saveBlockedInvite: async (code, jid) => {
				blockedInviteSaved = { code, jid };
				return true;
			},
			addInviteHistory: async (entry) => {
				historyAdded = entry;
				return true;
			},
			savePendingJoin: async () => true,
			isUserInviteBlocked: async (num) => num === "5511999990002",
			isInviteBlocked: async (code, jid) =>
				code === "BlockedCode1234567890" || jid === "blocked-group@g.us"
		};

		const mockRaven13 = {
			id: "ravena13",
			nome: "ravena13",
			nomeExibir: "Ravena 13",
			isConnected: true,
			client: {
				getInviteInfo: async (code) => ({ JID: "120363999999999999@g.us", code }),
				acceptInvite: async (code) => {
					acceptedInviteCode = code;
					return { accepted: true };
				}
			}
		};

		service.setBots([mockRaven13]);
		service.setDatabase(mockDatabase);

		// 2.1 Ação de Aceite (join:ravena13:code)
		telegramCalls.length = 0;
		const joinQuery = {
			id: "cq_1",
			data: `join:ravena13:${inviteCode}`,
			from: { username: "admin_test", first_name: "Admin" },
			message: {
				message_id: 9999,
				chat: { id: "-5048016247" },
				text: "Texto Original do Convite"
			}
		};

		const joinHandled = await service.handleCallbackQuery(joinQuery);
		assert.strictEqual(joinHandled, true, "handleCallbackQuery deve retornar true");
		assert.strictEqual(acceptedInviteCode, inviteCode, "Bot ravena13 deve ter aceito o convite");
		assert.ok(historyAdded, "Deve ter gravado histórico de convite no banco");
		assert.strictEqual(historyAdded.code, inviteCode);
		assert.strictEqual(historyAdded.groupJid, "120363999999999999@g.us");

		// Verifica se editou a mensagem removendo os botões
		const editCall = telegramCalls.find((c) => c.url.includes("/editMessageText"));
		assert.ok(editCall, "Deve ter chamado editMessageText");
		assert.ok(
			editCall.data.text.includes("Convite aceito com sucesso por Ravena 13"),
			"Texto deve conter confirmação de aceite"
		);
		assert.ok(editCall.data.text.includes("@admin_test"), "Texto deve citar o moderador");
		assert.deepStrictEqual(
			editCall.data.reply_markup.inline_keyboard,
			[],
			"Botões devem ter sido removidos"
		);

		// 2.2 Ação de Bloqueio de Número (blk_num:5511999990001)
		telegramCalls.length = 0;
		const blockNumQuery = {
			id: "cq_2",
			data: "blk_num:5511999990001",
			from: { username: "admin_test", first_name: "Admin" },
			message: {
				message_id: 9999,
				chat: { id: "-5048016247" },
				text: "Texto Original do Convite"
			}
		};
		const blkNumHandled = await service.handleCallbackQuery(blockNumQuery);
		assert.strictEqual(blkNumHandled, true);
		assert.deepStrictEqual(userBlockedNum, { num: "5511999990001", block: true });

		// 2.3 Ação de Bloqueio de Grupo (blk_grp:code)
		telegramCalls.length = 0;
		const blockGrpQuery = {
			id: "cq_3",
			data: `blk_grp:${inviteCode}`,
			from: { username: "admin_test", first_name: "Admin" },
			message: {
				message_id: 9999,
				chat: { id: "-5048016247" },
				text: "Texto Original do Convite"
			}
		};
		const blkGrpHandled = await service.handleCallbackQuery(blockGrpQuery);
		assert.strictEqual(blkGrpHandled, true);
		assert.strictEqual(blockedInviteSaved.code, inviteCode);
		assert.strictEqual(blockedInviteSaved.jid, "120363999999999999@g.us");

		console.log("✓ Ações de callback (join, blk_num, blk_grp) validadas com sucesso!");

		// =========================================================================
		// 3. Testes da rota POST /api/invite (Detecção de Bloqueios e Roteamento)
		// =========================================================================
		console.log("\n3. Testando rota POST /api/invite com detecção de bloqueio e roteamento...");

		const app = express();
		app.use(express.json());

		const zapSentMessages = [];
		const mockNormalBot = {
			id: "ravena-normal",
			nomeExibir: "Ravena Normal",
			isConnected: true,
			comunitario: false,
			vip: false,
			privado: false,
			grupoInvites: "normal-invites@g.us",
			client: {
				getInviteInfo: async (code) => {
					if (code === "JidBlockedCode12345678") {
						return { JID: "blocked-group@g.us", code };
					}
					return { JID: "valid-group@g.us", code };
				}
			},
			sendMessage: async (target, content) => {
				zapSentMessages.push({ target, content });
				return true;
			}
		};

		const mockVipBot = {
			id: "ravenavip",
			nomeExibir: "Ravena VIP",
			isConnected: true,
			comunitario: false,
			vip: true,
			grupoInvites: "vip-invites@g.us",
			sendMessage: async () => true
		};

		const mockComunitarioBot = {
			id: "noxgley",
			nomeExibir: "NoxGley",
			isConnected: true,
			comunitario: true,
			vip: false,
			grupoInvites: "comunitario-invites@g.us",
			sendMessage: async () => true
		};

		const pass = (req, res, next) => next();
		const api = {
			app,
			bots: [mockComunitarioBot, mockVipBot, mockNormalBot], // Ordem propositalmente inversa para testar prioridade
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

		try {
			// 3.1 Recusa de número bloqueado
			const resBlockedUser = await fetch(`${baseUrl}/api/invite`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					link: "https://chat.whatsapp.com/ValidInviteCode12345678",
					contato: "5511999990002", // número bloqueado no mockDatabase
					motivo: "Grupo de teste para convite bloqueado por usuário"
				})
			});
			assert.strictEqual(resBlockedUser.status, 403, "Deve retornar 403 para número bloqueado");
			const dataBlockedUser = await resBlockedUser.json();
			assert.strictEqual(dataBlockedUser.status, "blocked");
			assert.strictEqual(dataBlockedUser.blockType, "user");
			assert.ok(dataBlockedUser.message.includes("não está mais recebendo convites de seu número"));

			// 3.2 Recusa de código de convite bloqueado
			const resBlockedCode = await fetch(`${baseUrl}/api/invite`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					link: "https://chat.whatsapp.com/BlockedCode1234567890", // código bloqueado
					contato: "5511999990003",
					motivo: "Grupo de teste para convite bloqueado por código"
				})
			});
			assert.strictEqual(resBlockedCode.status, 403, "Deve retornar 403 para código bloqueado");
			const dataBlockedCode = await resBlockedCode.json();
			assert.strictEqual(dataBlockedCode.status, "blocked");
			assert.strictEqual(dataBlockedCode.blockType, "group");
			assert.ok(dataBlockedCode.message.includes("não recebe mais convite deste grupo"));

			// 3.3 Recusa de JID bloqueado
			const resBlockedJid = await fetch(`${baseUrl}/api/invite`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					link: "https://chat.whatsapp.com/JidBlockedCode12345678", // JID blocked-group@g.us
					contato: "5511999990003",
					motivo: "Grupo de teste para convite bloqueado por JID"
				})
			});
			assert.strictEqual(resBlockedJid.status, 403, "Deve retornar 403 para JID bloqueado");
			const dataBlockedJid = await resBlockedJid.json();
			assert.strictEqual(dataBlockedJid.status, "blocked");
			assert.strictEqual(dataBlockedJid.blockType, "group");
			assert.ok(dataBlockedJid.message.includes("não recebe mais convite deste grupo"));

			// 3.4 Envio quando GRUPO_INVITES_TELEGRAM está configurado (apenas Telegram, nada no WhatsApp)
			process.env.GRUPO_INVITES_TELEGRAM = "-5048016247";
			telegramCalls.length = 0;
			zapSentMessages.length = 0;

			const resTg = await fetch(`${baseUrl}/api/invite`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					link: "https://chat.whatsapp.com/ValidInviteCode12345678",
					contato: "5511999990003",
					motivo: "Grupo ativo para entrar pelo telegram"
				})
			});
			assert.strictEqual(resTg.status, 200, "Deve retornar 200 ao enviar pelo Telegram");
			const dataTg = await resTg.json();
			assert.strictEqual(dataTg.status, "ok");

			// Deve ter enviado para Telegram e NÃO para WhatsApp
			assert.ok(
				telegramCalls.some((c) => c.url.includes("/sendMessage")),
				"Deve enviar mensagem para o Telegram"
			);
			assert.strictEqual(
				zapSentMessages.length,
				0,
				"NÃO deve enviar nenhuma mensagem no WhatsApp quando Telegram estiver configurado"
			);

			// 3.5 Fallback para WhatsApp quando GRUPO_INVITES_TELEGRAM não está configurado (Prioridade: Normal > VIP > Comunitário)
			delete process.env.GRUPO_INVITES_TELEGRAM;
			telegramCalls.length = 0;
			zapSentMessages.length = 0;

			const resZap = await fetch(`${baseUrl}/api/invite`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					link: "https://chat.whatsapp.com/ValidInviteCode12345678",
					contato: "5511999990003",
					motivo: "Grupo ativo para testar prioridade de bots WhatsApp"
				})
			});
			assert.strictEqual(resZap.status, 200, "Deve retornar 200 ao enviar pelo WhatsApp");
			assert.strictEqual(
				telegramCalls.length,
				0,
				"NÃO deve enviar no Telegram se GRUPO_INVITES_TELEGRAM não estiver configurado"
			);
			assert.ok(zapSentMessages.length > 0, "Deve ter enviado mensagem no WhatsApp");
			// Verifica se priorizou a Ravena Normal apesar da lista ter o comunitário e VIP na frente
			assert.strictEqual(
				zapSentMessages[0].target,
				"normal-invites@g.us",
				"Deve priorizar bot Normal antes de VIP ou Comunitário"
			);

			console.log("✓ Rota /api/invite com bloqueios e roteamento prioritário testada com sucesso!");
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	} finally {
		axios.post = originalPost;
	}

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("❌ Falha nos testes:", err);
		process.exit(1);
	});
