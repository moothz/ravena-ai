/**
 * gamesRoutes.js
 *
 * Integração dos minigames do bot com serviços externos (o bot é o único que credita
 * bônus de jogo; os serviços parceiros apenas avisam que algo aconteceu).
 * Arquivo: src/BotAPI/routes/gamesRoutes.js
 *
 * Rotas registradas:
 * - POST /api/games/fazenda/harvest        - Webhook de colheita da API do Jardim (reconcilia bônus + envia DM)
 * - GET  /api/games/fazenda/bonus/:userId  - Bônus acumulados do jogador (rolls, tickets, iscas)
 *
 * O webhook NÃO transporta valor de bônus: ele só acorda o reconcileHarvestBonus(), que
 * calcula o montante a partir dos totais cumulativos da API do Jardim. Assim, requisições
 * duplicadas, atrasadas ou repetidas nunca creditam em dobro.
 *
 * Autenticação: header `x-api-key` igual a `JARDIM_API_KEY`. Sem chave configurada ou
 * divergente a rota falha fechada (403).
 *
 * @param {Object} api - Instância da BotAPI
 */

const ShadowGardenBonusService = require("../../services/ShadowGardenBonusService");
const FishingGame = require("../../functions/FishingGame");
const bankService = require("../../services/BankService");
const Database = require("../../utils/Database");
const ShadowGardenClient = require("../../services/ShadowGardenClient");

const database = Database.getInstance();
const jardimClient = new ShadowGardenClient();

const NOTICE_HEADER = "🌑 *Jardim das Sombras* — bônus da sua colheita!";

/**
 * Valida a chave do serviço parceiro. Falha fechada: sem JARDIM_API_KEY configurada a
 * rota não aceita nada (evita crédito liberado por engano em ambiente mal configurado).
 * @returns {boolean} true quando a requisição está autorizada
 */
function requirePartnerKey(api, req, res) {
	const expected = process.env.JARDIM_API_KEY;
	if (!expected) {
		api.logger.error(
			"[gamesRoutes] JARDIM_API_KEY não configurada no bot — webhook da fazenda bloqueado."
		);
		res.status(403).json({ ok: false, error: "Webhook desabilitado: chave não configurada." });
		return false;
	}

	const provided = req.headers["x-api-key"];
	if (!provided || provided !== expected) {
		api.logger.warn("[gamesRoutes] x-api-key ausente ou inválida no webhook da fazenda.");
		res.status(403).json({ ok: false, error: "Chave de API inválida." });
		return false;
	}

	return true;
}

/**
 * Envia um aviso no privado do jogador, tentando os bots de WhatsApp conectados e
 * caindo para Telegram/Discord quando o identificador não parece um número de WhatsApp.
 * Nunca lança: a entrega da mensagem é consequência, o crédito já foi feito.
 * @returns {Promise<boolean>} true quando algum bot conseguiu enviar
 */
async function sendGameNotice(api, chatId, text) {
	const isWhatsAppChat =
		chatId.includes("@") || (/^\d+$/.test(chatId) && chatId.length >= 10 && chatId.length <= 15);

	let candidates = [];
	if (isWhatsAppChat) {
		candidates = api.bots.filter((b) => b.isConnected && !b.useTelegram && !b.useDiscord);
		if (candidates.length === 0) {
			const fallbackWa = api.bots.find((b) => !b.useTelegram && !b.useDiscord);
			if (fallbackWa) candidates = [fallbackWa];
		}
	} else if (/^\d{17,20}$/.test(chatId)) {
		candidates = [
			api.bots.find((b) => b.useDiscord && b.isConnected) || api.bots.find((b) => b.useDiscord)
		].filter(Boolean);
	} else {
		candidates = [
			api.bots.find((b) => b.useTelegram && b.isConnected) || api.bots.find((b) => b.useTelegram)
		].filter(Boolean);
	}

	for (const currentBot of candidates) {
		try {
			await currentBot.sendMessage(chatId, text);
			api.logger.info(
				`[gamesRoutes] Aviso enviado para ${chatId} via bot ${currentBot.id || currentBot.botId}`
			);
			return true;
		} catch (err) {
			api.logger.warn(
				`[gamesRoutes] Falha ao enviar para ${chatId} via bot ${currentBot.id || currentBot.botId}: ${err.message || err}`
			);
		}
	}

	api.logger.warn(
		`[gamesRoutes] Nenhum bot disponível para entregar o aviso de bônus para ${chatId}.`
	);
	return false;
}

function registerGamesRoutes(api) {
	const app = api.app;

	// POST /api/games/fazenda/harvest — colheita registrada pela API do Jardim (painel web ou bot)
	// generalLimiter: as chamadas vêm todas do mesmo IP (o container da API do Jardim), então o
	// limite restrito de 10/min estouraria com poucos jogadores colhendo no painel no mesmo minuto.
	app.post("/api/games/fazenda/harvest", api.generalLimiter, async (req, res) => {
		if (!requirePartnerKey(api, req, res)) return;

		try {
			const userId = String(req.body?.userId || "").replace(/\D/g, "");
			if (!userId) {
				return res.status(422).json({ ok: false, error: "userId é obrigatório." });
			}

			const harvested = Array.isArray(req.body?.harvested) ? req.body.harvested : [];
			api.logger.info(
				`[gamesRoutes] Colheita do Jardim para ${userId} (${harvested.length} tipo(s) de planta). Reconciliando bônus.`
			);

			const credited = await ShadowGardenBonusService.reconcileHarvestBonus(userId);

			if (credited.length > 0) {
				const delivered = await sendGameNotice(
					api,
					userId,
					`${NOTICE_HEADER}\n\n${credited.join("\n")}`
				);
				if (!delivered) {
					api.logger.warn(
						`[gamesRoutes] Bônus de ${userId} creditado mas sem entrega por mensagem (bots offline).`
					);
				}
			}

			return res.json({ ok: true, credited });
		} catch (error) {
			api.logger.error("[gamesRoutes] Erro ao processar colheita do Jardim:", error);
			return res.status(500).json({ ok: false, error: "Falha ao processar a colheita." });
		}
	});

	// GET /api/games/fazenda/bonus/:userId — leitura dos bônus acumulados
	app.get("/api/games/fazenda/bonus/:userId", api.generalLimiter, async (req, res) => {
		if (!requirePartnerKey(api, req, res)) return;

		try {
			const userId = String(req.params?.userId || "").replace(/\D/g, "");
			if (!userId) {
				return res.status(422).json({ ok: false, error: "userId é obrigatório." });
			}

			const [waifu, fishing] = await Promise.all([
				ShadowGardenBonusService.getWaifuBonus(userId, false),
				FishingGame.getUserData(userId).catch(() => null)
			]);

			return res.json({
				ok: true,
				userId,
				rolls: waifu?.rolls ?? 0,
				tickets: waifu?.tickets ?? 0,
				baits: fishing?.baits ?? 0
			});
		} catch (error) {
			api.logger.error("[gamesRoutes] Erro ao consultar bônus da fazenda:", error);
			return res.status(500).json({ ok: false, error: "Falha ao consultar os bônus." });
		}
	});

	// =========================================================================
	// ROTAS DO RAVENABANK
	// =========================================================================

	// GET /api/games/bank/public — dados macroeconômicos e cotações públicas
	app.get("/api/games/bank/public", api.generalLimiter, async (req, res) => {
		try {
			const macro = await bankService.getMacroEconomics();
			return res.json({ ok: true, data: macro });
		} catch (error) {
			api.logger.error("[gamesRoutes] Erro ao carregar dados do banco:", error);
			return res.status(500).json({ ok: false, error: "Falha ao carregar dados do banco." });
		}
	});

	// GET /api/games/bank/session — valida e renova sessão por 3 dias
	app.get("/api/games/bank/session", api.generalLimiter, async (req, res) => {
		const token = req.query.token || req.headers["x-bank-token"];
		if (!token) {
			return res.json({ ok: true, authenticated: false });
		}

		try {
			const session = await bankService.verifyAndExtendSession(token);
			if (!session) {
				return res.json({ ok: true, authenticated: false, reason: "Sessão expirada ou inválida." });
			}

			const userId = session.userId;
			const [account, quota, txs, balanceSnapshot] = await Promise.all([
				bankService.getAccount(userId),
				bankService.getDailyQuota(userId),
				bankService.getTransactions(userId, 100),
				bankService.getDailyBalanceSnapshot(userId)
			]);

			// Saldos nos jogos
			let fishWeight = 0;
			let fishCount = 0;
			try {
				const fishRow = await database.dbGet(
					"fishing",
					"SELECT COUNT(*) as c, SUM(weight) as w FROM fishing_inventory WHERE user_id = ? AND (is_rare = 0 OR is_rare IS NULL)",
					[userId]
				);
				fishWeight = fishRow?.w || 0;
				fishCount = fishRow?.c || 0;
			} catch (e) {}

			let zinthos = 0;
			try {
				const axios = require("axios");
				const wUrl = (process.env.WAIFULETES_API_URL || "http://host.docker.internal:3030").replace(
					/\/+$/,
					""
				);
				const { data } = await axios.get(`${wUrl}/kakera/${userId}`, {
					headers: { Authorization: `Bearer ${process.env.WAIFULETES_API_KEY || ""}` },
					timeout: 4000
				});
				zinthos = data?.data?.balance ?? data?.data?.kakera ?? 0;
			} catch (e) {}

			let gardenCoins = 0;
			try {
				const status = await jardimClient.getStatus(userId);
				gardenCoins = status?.coins || 0;
			} catch (e) {}

			let slotsCoins = 0;
			try {
				const SlotsGame = require("../../functions/SlotsGame");
				slotsCoins = await SlotsGame.getUserCoins(userId);
			} catch (e) {}

			let baits = 0;
			let maxBaits = 5;
			try {
				const FishingGame = require("../../functions/FishingGame");
				const baitInfo = await FishingGame.getUserBaitsInfo(userId);
				baits = baitInfo.baits;
				maxBaits = baitInfo.maxBaits;
			} catch (e) {}

			return res.json({
				ok: true,
				authenticated: true,
				user: {
					userId,
					expiresAt: session.expiresAt,
					account,
					quota,
					balanceSnapshot,
					transactions: txs,
					holdings: {
						fishWeight,
						fishCount,
						zinthos,
						gardenCoins,
						slotsCoins,
						baits,
						maxBaits
					}
				}
			});
		} catch (error) {
			api.logger.error("[gamesRoutes] Erro na sessão do banco:", error);
			return res.status(500).json({ ok: false, error: "Falha ao validar sessão." });
		}
	});

	// POST /api/games/bank/logout — encerra sessão
	app.post("/api/games/bank/logout", api.generalLimiter, async (req, res) => {
		const token = req.body?.token || req.headers["x-bank-token"];
		if (!token) return res.json({ ok: true });

		try {
			await bankService.destroySession(token);
			return res.json({ ok: true });
		} catch (error) {
			return res.status(500).json({ ok: false, error: "Falha ao encerrar sessão." });
		}
	});

	// POST /api/games/bank/trade — executa câmbio a partir da web autenticada
	app.post("/api/games/bank/trade", api.generalLimiter, async (req, res) => {
		const token = req.body?.token || req.headers["x-bank-token"];
		if (!token) {
			return res.status(401).json({ ok: false, error: "Sessão não autenticada." });
		}

		try {
			const session = await bankService.verifyAndExtendSession(token);
			if (!session) {
				return res
					.status(401)
					.json({ ok: false, error: "Sessão expirada. Solicite novo link via !banco-adm." });
			}

			const userId = session.userId;
			const { operation, game, amount } = req.body;

			if (!operation || !game) {
				return res
					.status(400)
					.json({ ok: false, error: "Parâmetros 'operation' e 'game' são obrigatórios." });
			}

			let result;
			const op = String(operation).toLowerCase().trim();
			const g = String(game).toLowerCase().trim();

			if (op === "deposit" || op === "venda" || op === "vender") {
				if (g === "pesca" || g === "peixe" || g === "peixes") {
					result = await bankService.depositFish(userId, amount);
				} else if (g === "zinthos" || g === "waifu" || g === "waifus") {
					result = await bankService.depositZinthos(userId, amount);
				} else if (g === "jardim" || g === "fazenda" || g === "petalita" || g === "petalitas") {
					result = await bankService.depositJardim(userId, amount);
				} else {
					return res.status(400).json({ ok: false, error: "Jogo inválido para venda." });
				}
			} else if (
				op === "withdraw" ||
				op === "compra" ||
				op === "comprar" ||
				op === "loja" ||
				op === "store"
			) {
				if (g === "zinthos" || g === "waifu" || g === "waifus") {
					result = await bankService.withdrawZinthos(userId, amount);
				} else if (g === "jardim" || g === "fazenda" || g === "petalita" || g === "petalitas") {
					result = await bankService.withdrawJardim(userId, amount);
				} else if (
					g === "moedas" ||
					g === "moeda" ||
					g === "slots" ||
					g === "ficha" ||
					g === "fichas"
				) {
					result = await bankService.buySlotsCoins(userId, amount);
				} else if (g === "iscas" || g === "isca") {
					result = await bankService.buyFishingBaits(userId, amount);
				} else if (g === "pesca" || g === "peixe" || g === "peixes") {
					return res
						.status(400)
						.json({ ok: false, error: "Não é permitido comprar peixes com Runas." });
				} else {
					return res.status(400).json({ ok: false, error: "Destino inválido para compra." });
				}
			} else {
				return res
					.status(400)
					.json({ ok: false, error: "Operação inválida. Use 'venda' ou 'compra'." });
			}

			return res.json({ ok: true, result });
		} catch (error) {
			api.logger.warn(`[gamesRoutes] Falha no trade do banco: ${error.message}`);
			return res.status(400).json({ ok: false, error: error.message });
		}
	});

	// =========================================================================
	// ROTAS ADMINISTRATIVAS DO RAVENABANK (/ravenabank/admin)
	// =========================================================================

	// GET /api/games/bank/admin/users — listagem paginada e busca por apelido/número
	app.get(
		"/api/games/bank/admin/users",
		api.authenticateBasic,
		api.strictLimiter,
		async (req, res) => {
			try {
				const { q = "", page = 1, limit = 20, sort = "runas_desc" } = req.query;
				const data = await bankService.adminGetUsers({
					query: q,
					page,
					limit,
					sort
				});
				return res.json({ ok: true, data });
			} catch (error) {
				api.logger.error("[gamesRoutes] Erro ao listar usuários do banco:", error);
				return res
					.status(500)
					.json({ ok: false, error: "Falha ao listar usuários do RavenaBank." });
			}
		}
	);

	// POST /api/games/bank/admin/user-runas — edição direta de saldo de Runas
	app.post(
		"/api/games/bank/admin/user-runas",
		api.authenticateBasic,
		api.strictLimiter,
		async (req, res) => {
			try {
				const { userId, runas } = req.body || {};
				if (!userId) {
					return res.status(400).json({ ok: false, error: "Parâmetro 'userId' é obrigatório." });
				}
				if (runas === undefined || runas === null || isNaN(Number(runas))) {
					return res
						.status(400)
						.json({ ok: false, error: "Parâmetro 'runas' deve ser um número válido." });
				}

				const updatedAccount = await bankService.adminSetUserRunas(
					userId,
					Number(runas),
					req.headers.authorization ? "basic_admin" : "session_admin"
				);

				return res.json({
					ok: true,
					data: {
						userId: updatedAccount.user_id,
						runas: updatedAccount.runas,
						updatedAt: updatedAccount.updated_at
					}
				});
			} catch (error) {
				api.logger.error("[gamesRoutes] Erro ao atualizar Runas do usuário:", error);
				return res.status(400).json({ ok: false, error: error.message });
			}
		}
	);

	// POST /api/games/bank/admin/impersonate — gera sessão e link transparente [Acessar]
	app.post(
		"/api/games/bank/admin/impersonate",
		api.authenticateBasic,
		api.strictLimiter,
		async (req, res) => {
			try {
				const { userId } = req.body || {};
				if (!userId) {
					return res.status(400).json({ ok: false, error: "Parâmetro 'userId' é obrigatório." });
				}

				const session = await bankService.createSession(userId);
				const redirectUrl = `/ravenabank?token=${session.token}&_cb=${Date.now()}`;

				api.logger.info(
					`[gamesRoutes] Admin impersonando usuário ${userId} via token ${session.token.slice(0, 8)}...`
				);

				return res.json({
					ok: true,
					token: session.token,
					expiresAt: session.expiresAt,
					redirectUrl
				});
			} catch (error) {
				api.logger.error("[gamesRoutes] Erro ao gerar impersonação no banco:", error);
				return res.status(500).json({ ok: false, error: "Falha ao gerar sessão de acesso." });
			}
		}
	);

	// GET /api/games/bank/admin/config — estatísticas macroeconômicas e configurações
	app.get(
		"/api/games/bank/admin/config",
		api.authenticateBasic,
		api.strictLimiter,
		async (req, res) => {
			try {
				const config = await bankService.adminGetConfigAndStats();
				return res.json({ ok: true, data: config });
			} catch (error) {
				api.logger.error("[gamesRoutes] Erro ao carregar configurações do banco:", error);
				return res
					.status(500)
					.json({ ok: false, error: "Falha ao carregar configurações do banco." });
			}
		}
	);

	// POST /api/games/bank/admin/recalculate-rates — força recálculo diário sob demanda
	app.post(
		"/api/games/bank/admin/recalculate-rates",
		api.authenticateBasic,
		api.strictLimiter,
		async (req, res) => {
			try {
				const rates = await bankService.getRates(true);
				api.logger.info(
					"[gamesRoutes] Cotações diárias do RavenaBank recalculadas manualmente pelo admin."
				);
				return res.json({ ok: true, data: rates });
			} catch (error) {
				api.logger.error("[gamesRoutes] Erro ao recalcular cotações do banco:", error);
				return res.status(500).json({ ok: false, error: error.message });
			}
		}
	);
}

module.exports = { registerGamesRoutes, sendGameNotice };
