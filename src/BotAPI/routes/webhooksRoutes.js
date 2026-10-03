const DonorBonusService = require("../../services/DonorBonusService");

/**
 * Registra rotas de webhooks externos, doações, monitoramento de energia (UPS), carga e Copa
 * Arquivo: src/BotAPI/routes/webhooksRoutes.js
 *
 * Rotas registradas:
 * - POST /donate_tipa            - Webhook de doação recebida pelo Tipa.ai
 * - GET  /top-donates            - Lista pública dos maiores doadores de todos os tempos
 * - GET  /recent-top-donates     - Maiores doadores dos últimos 3 meses
 * - GET  /api/donates/detail/:name - Detalhes históricos de doações de um doador específico
 * - POST /UPS/powerChange        - Notificação de mudança de status da rede elétrica/Nobreak
 * - POST /UPS/powerCritical      - Notificação crítica de bateria esgotando do Nobreak
 * - POST /getLoad                - Retorna relatórios de carga a partir de um timestamp
 * - POST /copa                   - Webhook com atualizações de partidas e gols da Copa 2026
 *
 * @param {Object} api - Instância da BotAPI
 */
function registerWebhooksRoutes(api) {
	const app = api.app;

	// Webhook de doação do Tipa.ai
	app.post("/donate_tipa", api.strictLimiter, async (req, res) => {
		try {
			api.logger.info("Recebido webhook de doação do Tipa.ai");

			const donateData = {
				headers: req.headers,
				body: req.body
			};

			api.logger.debug("Dados da doação:", donateData);

			const headerTipa = req.headers["x-tipa-webhook-secret-token"] ?? false;
			const expectedToken = process.env.TIPA_TOKEN;

			if (!headerTipa || headerTipa !== expectedToken) {
				api.logger.warn("Token webhook inválido:", headerTipa);
				return res.status(403).send("-");
			}

			let nome = req.body.payload.tip.name ?? "Alguém";
			const valor = parseFloat(req.body.payload.tip.amount) ?? 0;
			const msg = req.body.payload.tip.message ?? "";

			nome = nome.trim();

			if (valor <= 0) {
				api.logger.warn(`Valor de doação inválido: ${valor}`);
				return res.send("ok");
			}

			const donationTotal = await api.database.addDonation(nome, valor, undefined, msg);

			let donor = null;
			try {
				donor = await api.database.getDonorByName(nome);
				if (donor && donor.numero) {
					const bonusResult = await DonorBonusService.awardDonorBonuses(
						donor,
						donationTotal,
						donor.bonusesProcessedAmount || 0
					);
					api.logger.info(
						`[donate_tipa] Bônus automáticos de doação processados para ${nome} (${donor.numero}):`,
						bonusResult
					);
				} else {
					api.logger.info(
						`[donate_tipa] Doador ${nome} ainda não possui número cadastrado. Bônus serão concedidos ao vincular o número.`
					);
				}
			} catch (bonusError) {
				api.logger.error("[donate_tipa] Erro ao processar bônus do doador:", bonusError);
			}

			await api.notifyGroupsAboutDonation(nome, valor, msg, donationTotal, donor);
			res.send("ok");
		} catch (error) {
			api.logger.error("Erro ao processar webhook de doação:", error);
			res.status(500).send("error");
		}
	});

	// UPS Power Change Endpoint
	app.post("/UPS/powerChange", api.authenticateUPS, api.strictLimiter, async (req, res) => {
		try {
			const { status } = req.body;
			api.logger.info(`UPS power change: ${status}`);

			if (api.lastUpsStatus === status) {
				return res.send("ok - status unchanged");
			}

			if (status === "OB") {
				if (api.upsTimeout) clearTimeout(api.upsTimeout);

				api.upsTimeout = setTimeout(async () => {
					const message =
						"🚨⚡️ *URGENTE*: _queda de energia_ ⚡️🚨\nO servidor está atualmente sendo suportado pelo Nobreak. Se a energia não retornar em alguns segundos, todos os serviços serão desligados por segurança";
					api.lastUpsStatus = "OB";
					api.powerOutageNotified = true;
					api.upsTimeout = null;
					await api.notifyPowerStatus(message);
				}, api.powerOutageMinTime);

				return res.send(`ok - debounce started (${api.powerOutageMinTime / 1000}s)`);
			} else if (status === "OL") {
				if (api.upsTimeout) {
					clearTimeout(api.upsTimeout);
					api.upsTimeout = null;
					api.lastUpsStatus = "OL";
					return res.send("ok - outage cancelled (debounced)");
				}

				if (api.powerOutageNotified) {
					const message = "⚡️✅ *Energia restabelecida*: _podemos relaxar (por enquanto)_";
					api.lastUpsStatus = "OL";
					api.powerOutageNotified = false;
					await api.notifyPowerStatus(message);
					return res.send("ok - restoration notified");
				}

				api.lastUpsStatus = "OL";
				return res.send("ok - status updated to OL");
			}

			res.send("ok - ignored status");
		} catch (error) {
			api.logger.error("Error processing UPS powerChange:", error);
			res.status(500).send("error");
		}
	});

	// UPS Power Critical Endpoint
	app.post("/UPS/powerCritical", api.authenticateUPS, api.strictLimiter, async (req, res) => {
		try {
			const { level } = req.body;
			api.logger.info(`UPS power CRITICAL: ${level}%`);

			if (api.lastUpsStatus === "CRITICAL") {
				return res.send("ok - status unchanged");
			}

			if (api.upsTimeout) {
				clearTimeout(api.upsTimeout);
				api.upsTimeout = null;
			}

			const message =
				"🚨⚡️🚨 *URGENTE*: _desligamento_ 🚨⚡️🚨\nA energia não retornou, então o servidor será desligado agora - voltando apenas de forma manual.";

			api.lastUpsStatus = "CRITICAL";
			api.powerOutageNotified = true;
			await api.notifyPowerStatus(message);
			res.send("ok");
		} catch (error) {
			api.logger.error("Error processing UPS powerCritical:", error);
			res.status(500).send("error");
		}
	});

	// Endpoint para obter relatórios de carga
	app.post("/getLoad", api.strictLimiter, async (req, res) => {
		try {
			const { timestamp } = req.body;

			if (!timestamp || isNaN(parseInt(timestamp, 10))) {
				return res.status(400).json({
					status: "error",
					message: "Timestamp inválido ou ausente"
				});
			}

			const reports = await api.database.getLoadReports(parseInt(timestamp, 10));

			res.json({
				status: "ok",
				timestamp: Date.now(),
				reports
			});
		} catch (error) {
			api.logger.error("Erro ao obter relatórios de carga:", error);
			res.status(500).json({
				status: "error",
				message: "Erro interno do servidor"
			});
		}
	});

	// Endpoint para Top Donates
	app.get("/top-donates", async (req, res) => {
		try {
			const donations = await api.database.getDonations();
			const publicDonations = donations.map(({ nome, valor }) => ({ nome, valor }));
			res.json(publicDonations);
		} catch (error) {
			if (error.code === "ENOENT") {
				res.status(404).json({ error: "Arquivo de doações não encontrado" });
			} else {
				api.logger.error("Erro ao ler ou processar o arquivo de doações:", error);
				res.status(500).json({ error: "Erro interno ao buscar doações" });
			}
		}
	});

	// Endpoint para detalhes de doações de um doador específico
	app.get("/api/donates/detail/:name", api.generalLimiter, async (req, res) => {
		try {
			const name = req.params.name;
			if (!name) {
				return res.status(400).json({ error: "Nome não informado" });
			}

			const donor = await api.database.getDonorByName(name);
			if (!donor) {
				return res.status(404).json({ error: "Doador não encontrado" });
			}

			res.json({
				nome: donor.nome,
				valor: donor.valor,
				timestamp: donor.timestamp,
				historico: (donor.historico || []).map((h) => ({
					ts: h.ts,
					valor: h.valor,
					msg: h.msg || ""
				}))
			});
		} catch (error) {
			api.logger.error("Erro ao buscar detalhes do doador:", error);
			res.status(500).json({ error: "Erro interno ao buscar detalhes do doador" });
		}
	});

	// Endpoint para Top Donates dos últimos 3 meses
	app.get("/recent-top-donates", async (req, res) => {
		try {
			const donations = await api.database.getDonations();

			const threeMonthsAgo = new Date();
			threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
			const threeMonthsAgoTs = threeMonthsAgo.getTime();

			let totalRecentAmount = 0;
			const recentDonorsSummary = {};

			donations.forEach((donor) => {
				const recentAmount = (donor.historico ?? [])
					.filter((h) => h.ts > threeMonthsAgoTs)
					.reduce((sum, h) => sum + h.valor, 0);

				if (
					recentAmount === 0 &&
					(!donor.historico || donor.historico.length === 0) &&
					donor.timestamp &&
					donor.timestamp > threeMonthsAgoTs
				) {
					const fallbackAmount = donor.valor;
					if (fallbackAmount > 0) {
						totalRecentAmount += fallbackAmount;
						recentDonorsSummary[donor.nome] = { nome: donor.nome, valor: fallbackAmount };
					}
				} else if (recentAmount > 0) {
					totalRecentAmount += recentAmount;
					recentDonorsSummary[donor.nome] = { nome: donor.nome, valor: recentAmount };
				}
			});

			const topRecentDonors = Object.values(recentDonorsSummary)
				.sort((a, b) => b.valor - a.valor)
				.slice(0, 15);

			res.json({
				totalRecentAmount,
				topRecentDonors
			});
		} catch (error) {
			api.logger.error("Erro ao processar doações recentes:", error);
			res.status(500).json({ error: "Erro ao processar doações recentes" });
		}
	});

	// Copa 2026 notifications endpoint
	app.post("/copa", api.strictLimiter, async (req, res) => {
		api.logger.info("[Copa Webhook] Request received at /copa", {
			headers: req.headers,
			body: req.body
		});

		try {
			const { event, match, goalDetails } = req.body;

			if (!event || !match) {
				api.logger.warn("[Copa Webhook] Invalid payload structure. event or match missing.", {
					body: req.body
				});
				return res
					.status(400)
					.json({ status: "error", message: "Payload inválido. Requer 'event' e 'match'." });
			}

			if (!api.bots || api.bots.length === 0) {
				api.logger.warn("[Copa Webhook] No bots available to process Copa notifications.");
				return res.status(503).json({ status: "error", message: "Nenhum bot disponível." });
			}

			const CopaHelpers = require("../../functions/Copa2026");
			let teamsMap = {};
			try {
				teamsMap = await CopaHelpers.fetchTeamsMap();
				api.logger.info(
					`[Copa Webhook] Loaded teams map. Total teams: ${Object.keys(teamsMap).length}`
				);
			} catch (e) {
				api.logger.error("Erro ao buscar mapa de times na notificação da Copa:", e.message);
			}

			const homeTeamId = String(match.home_team_id);
			const awayTeamId = String(match.away_team_id);
			api.logger.info(
				`[Copa Webhook] Event: '${event}', HomeTeamId: ${homeTeamId}, AwayTeamId: ${awayTeamId}`
			);

			const followers = await api.database.dbAll(
				"copa_seguir",
				"SELECT chat_id, team_id, team_name_pt, fifa_code FROM copa_seguindo WHERE team_id = ? OR team_id = ?",
				[homeTeamId, awayTeamId]
			);

			api.logger.info(
				`[Copa Webhook] Database followers count: ${followers ? followers.length : 0}`,
				{ followers }
			);

			if (!followers || followers.length === 0) {
				api.logger.info(
					`[Copa Webhook] No chats are following home_team_id ${homeTeamId} or away_team_id ${awayTeamId}`
				);
				return res.json({ status: "ok", message: "Nenhum chat seguindo estes times." });
			}

			const chatIds = [...new Set(followers.map((f) => f.chat_id))];
			const homeTeam = teamsMap[homeTeamId] || {
				namePt: match.home_team_name_en || "Casa",
				flagEmoji: CopaHelpers.flag(match.home_fifa_code || "")
			};
			const awayTeam = teamsMap[awayTeamId] || {
				namePt: match.away_team_name_en || "Fora",
				flagEmoji: CopaHelpers.flag(match.away_fifa_code || "")
			};
			api.logger.info(
				`[Copa Webhook] Teams resolved. Home: ${homeTeam.namePt} (${homeTeamId}), Away: ${awayTeam.namePt} (${awayTeamId}). Chats to notify: ${chatIds.join(", ")}`
			);

			for (const chatId of chatIds) {
				const chatFollows = followers.filter((f) => f.chat_id === chatId);
				const followedNames = chatFollows.map((f) => f.team_name_pt).join(" e ");

				const rndToken = () =>
					Math.random().toString(36).substring(2, 6) + Math.random().toString(36).substring(2, 6);

				let messageText = "";

				if (event === "match_start") {
					messageText =
						`⚽ *A BOLA ROLOU na Copa 2026!* ⚽\n\n` +
						`🏆 O jogo começou!\n` +
						`⚔️ ${homeTeam.flagEmoji} *${homeTeam.namePt}* vs ${awayTeam.flagEmoji} *${awayTeam.namePt}*\n\n` +
						`📌 Grupo/Fase: *${match.group || match.type || "—"}*\n` +
						`🏟️ Estádio ID: ${match.stadium_id || "—"}\n\n` +
						`Acompanhe com a gente! 🔴\n\n` +
						`_${rndToken()}_`;
				} else if (event === "goal") {
					const details = goalDetails || {};
					const scoringTeam = teamsMap[details.scoringTeamId] ||
						Object.values(teamsMap).find((t) => t.name_en === details.scoringTeamNameEn) || {
							namePt: details.scoringTeamNameEn || "Autor do Gol",
							flagEmoji: "⚽"
						};

					const rawPlayer = details.player;
					const playerClean =
						rawPlayer && String(rawPlayer).toLowerCase() !== "null" ? rawPlayer.trim() : "";
					const playerStr = playerClean ? ` (${playerClean})` : "";

					const rawMinute = details.minute || match.time_elapsed || "";
					const minuteNumMatch = rawMinute.toString().match(/^(\d+)'?$/);
					const displayMinute = minuteNumMatch
						? `${Math.max(0, Number(minuteNumMatch[1]) - 3)}'`
						: rawMinute;
					const minuteStr = displayMinute ? ` aos ${displayMinute}` : "";

					const rawElapsed = match.time_elapsed || "";
					const elapsedNumMatch = rawElapsed.toString().match(/^(\d+)'?$/);
					const displayElapsed = elapsedNumMatch
						? `${Math.max(0, Number(elapsedNumMatch[1]) - 3)}'`
						: rawElapsed;

					messageText =
						`⚽ *GOOOOL DA COPA 2026!* ⚽\n\n` +
						`${scoringTeam.flagEmoji} *Gol do(a) ${scoringTeam.namePt}!*${playerStr}${minuteStr}\n\n` +
						`⚔️ Placar Atual: ${homeTeam.flagEmoji} *${homeTeam.namePt}* ${match.home_score} x ${match.away_score} ${awayTeam.flagEmoji} *${awayTeam.namePt}*\n\n` +
						`⏱️ Tempo de jogo: ${displayElapsed || "—"}\n\n` +
						`_${rndToken()}_`;
				} else if (event === "match_end") {
					let resultMessage = "";
					const chatFollowsHome = chatFollows.some((f) => String(f.team_id) === homeTeamId);
					const chatFollowsAway = chatFollows.some((f) => String(f.team_id) === awayTeamId);

					const homeScore = Number(match.home_score) || 0;
					const awayScore = Number(match.away_score) || 0;

					if (homeScore === awayScore) {
						resultMessage = "🤝 Partida terminada em empate!";
					} else if (chatFollowsHome && !chatFollowsAway) {
						if (homeScore > awayScore) {
							resultMessage = `🥳 *Vitória!* O(A) ${homeTeam.flagEmoji} *${homeTeam.namePt}* venceu a partida! 🏆`;
						} else {
							resultMessage = `😢 *Derrota.* O(A) ${homeTeam.flagEmoji} *${homeTeam.namePt}* perdeu a partida.`;
						}
					} else if (chatFollowsAway && !chatFollowsHome) {
						if (awayScore > homeScore) {
							resultMessage = `🥳 *Vitória!* O(A) ${awayTeam.flagEmoji} *${awayTeam.namePt}* venceu a partida! 🏆`;
						} else {
							resultMessage = `😢 *Derrota.* O(A) ${awayTeam.flagEmoji} *${awayTeam.namePt}* perdeu a partida.`;
						}
					} else {
						const winner = homeScore > awayScore ? homeTeam : awayTeam;
						resultMessage = `🏁 Fim de papo! Vitória do(a) ${winner.flagEmoji} *${winner.namePt}*!`;
					}

					messageText =
						`🏁 *FIM DE PARTIDA na Copa 2026!* 🏁\n\n` +
						`O jogo do(a) *${followedNames}* terminou.\n\n` +
						`⚔️ Placar Final: ${homeTeam.flagEmoji} *${homeTeam.namePt}* ${homeScore} x ${awayScore} ${awayTeam.flagEmoji} *${awayTeam.namePt}*\n\n` +
						`${resultMessage}\n\n` +
						`_${rndToken()}_`;
				}

				if (messageText) {
					try {
						const isWhatsAppChat =
							chatId.includes("@") ||
							(/^\d+$/.test(chatId) && chatId.length >= 10 && chatId.length <= 15);

						if (isWhatsAppChat) {
							const waBots = api.bots.filter(
								(b) => b.isConnected && !b.useTelegram && !b.useDiscord
							);
							if (waBots.length === 0) {
								const fallbackWa = api.bots.find((b) => !b.useTelegram && !b.useDiscord);
								if (fallbackWa) waBots.push(fallbackWa);
							}

							if (waBots.length === 0) {
								throw new Error(`Nenhum bot do WhatsApp encontrado para o chat: ${chatId}`);
							}

							let sent = false;
							let lastError = null;
							for (const currentBot of waBots) {
								try {
									api.logger.info(
										`[Copa Webhook] Sending notification to chat ${chatId} using bot ${currentBot.id || currentBot.botId}. Message: "${messageText.replace(/\n/g, "\\n")}"`
									);
									await currentBot.sendMessage(chatId, messageText);
									api.logger.info(
										`[Copa Webhook] Notification sent successfully to chat ${chatId} using bot ${currentBot.id || currentBot.botId}`
									);
									sent = true;
									break;
								} catch (err) {
									lastError = err;
									api.logger.warn(
										`[Copa Webhook] Failed to send using bot ${currentBot.id || currentBot.botId}: ${err.message || err}. Trying next WhatsApp bot if available.`
									);
								}
							}
							if (!sent) {
								throw (
									lastError || new Error("Todos os bots de WhatsApp falharam ao enviar a mensagem.")
								);
							}
						} else {
							let targetBot = null;
							if (/^\d{17,20}$/.test(chatId)) {
								targetBot =
									api.bots.find((b) => b.useDiscord && b.isConnected) ||
									api.bots.find((b) => b.useDiscord);
							} else {
								targetBot =
									api.bots.find((b) => b.useTelegram && b.isConnected) ||
									api.bots.find((b) => b.useTelegram);
							}

							if (!targetBot) {
								throw new Error(`Nenhum bot compatível encontrado para o chat: ${chatId}`);
							}

							api.logger.info(
								`[Copa Webhook] Sending notification to chat ${chatId} using bot ${targetBot.id || targetBot.botId}. Message: "${messageText.replace(/\n/g, "\\n")}"`
							);
							await targetBot.sendMessage(chatId, messageText);
							api.logger.info(`[Copa Webhook] Notification sent successfully to chat ${chatId}`);
						}
					} catch (error) {
						api.logger.error(
							`Erro ao enviar notificação da Copa para o chat ${chatId}:`,
							error.message
						);
					}
				} else {
					api.logger.warn(
						`[Copa Webhook] Empty message text generated for event '${event}' to chat ${chatId}`
					);
				}
			}

			res.json({ status: "ok", message: "Notificações enviadas." });
		} catch (error) {
			api.logger.error("Erro no endpoint /copa:", error);
			res.status(500).json({ status: "error", message: error.message });
		}
	});
}

module.exports = { registerWebhooksRoutes };
