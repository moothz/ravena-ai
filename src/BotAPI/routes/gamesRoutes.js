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
}

module.exports = { registerGamesRoutes, sendGameNotice };
