const path = require("path");
const fs = require("fs").promises;
const express = require("express");

/**
 * Registra rotas de páginas web estáticas, interfaces e dashboards da BotAPI
 * Arquivo: src/BotAPI/routes/indexRoutes.js
 *
 * Rotas registradas:
 * - GET  /classic, /legado            - Dashboard clássico/legado
 * - GET  /dashboard, /dashboard.html  - Redireciona para /instances
 * - GET  /logout                      - Encerra sessão de admin
 * - GET  /, /os, /index.html          - Homepage desktop OS com suporte a ?admin
 * - GET  /health                      - Verificação de saúde em tempo real dos bots
 * - GET  /502                         - Pré-visualização da página de erro 502/manutenção
 * - GET  /manage/:token               - Painel web de gerenciamento de grupo por token
 * - GET  /discord                     - Redirecionamento para convite do Discord
 * - GET  /telegram                    - Redirecionamento para convite do Telegram
 * - GET  /cmd                         - Visualizador de comandos públicos do bot
 * - GET  /docs, /api/docs             - Documentação visual da API
 * - GET  /ajuda                       - Chat interativo web de ajuda com IA
 * - GET  /stt, /transcrever           - Interface web de transcrição de áudio
 * - GET  /imagine                     - Interface web de geração de imagens
 * - GET  /tts, /falar                 - Interface web de síntese de voz (TTS)
 * - GET  /pesca, /fishing             - Interface web do jogo de pesca
 * - GET  /waifuletes, /waifus         - Atalho para o app de Waifuletes na OS
 * - GET  /groups-dossier              - Visualizador HTML de dossiês de grupos
 * - GET  /service-providers           - Interface de gerenciamento de provedores de IA
 * - GET  /ciclo-ravena                - Redirecionamento do ciclo de vida da Ravena
 * - GET  /getData/:groupId/:variable  - Leitura pública de variáveis temporárias de grupos
 * - GET  /media-direct/:fileName      - Entrega direta e autenticada de mídia de grupo
 *
 * @param {Object} api - Instância da BotAPI
 */
function registerIndexRoutes(api) {
	const app = api.app;

	// Rota para o dashboard clássico legado
	app.get(["/classic", "/legado"], (req, res) => {
		res.sendFile(path.join(__dirname, "../../../public/classic.html"));
	});

	// Redireciona /dashboard e /dashboard.html para o novo /instances moderno
	app.get(["/dashboard", "/dashboard.html"], (req, res) => {
		res.redirect("/instances");
	});

	// Rota para encerrar sessão de administrador
	app.get("/logout", (req, res) => {
		api.clearAdminSessionCookie(res);
		res.redirect("/");
	});

	// Handler para index com suporte a parâmetro ?admin e manutenção de sessão
	const handleIndex = (req, res, next) => {
		if (req.query && "logout" in req.query) {
			api.clearAdminSessionCookie(res);
			return res.redirect(req.path || "/");
		}

		const wantsAdmin = req.query && "admin" in req.query;

		if (wantsAdmin) {
			if (!api.isAdmin(req)) {
				res.set("WWW-Authenticate", 'Basic realm="RavenaBot API"');
				return res.status(401).send("Autenticação requerida");
			}

			api.setAdminSessionCookie(res);
			res.set("Cache-Control", "no-cache");
			return res.sendFile(path.join(__dirname, "../../../public/os/index.html"));
		}

		if (api.isAdmin(req)) {
			api.setAdminSessionCookie(res);
		}

		return next();
	};

	app.get(["/", "/os", "/os/", "/index.html", "/os/index.html"], handleIndex);

	// Entrega da interface Desktop OS como homepage principal (/)
	app.use(
		express.static(path.join(__dirname, "../../../public/os"), {
			maxAge: "1d",
			etag: true
		})
	);

	// Mantém compatibilidade com a rota /os
	app.use(
		"/os",
		express.static(path.join(__dirname, "../../../public/os"), {
			maxAge: "1d",
			etag: true
		})
	);

	// Entrega de arquivos estáticos gerais com cache de 1 dia e ETag
	app.use(
		express.static(path.join(__dirname, "../../../public"), {
			maxAge: "1d",
			etag: true
		})
	);

	// Endpoint de verificação de saúde (100% em memória, ultra-rápido)
	app.get("/health", (req, res) => {
		try {
			const isAdmin = api.isAdmin(req);

			res.json({
				status: "ok",
				timestamp: Date.now(),
				isAdmin,
				bots: api.bots
					.filter((bot) => (!bot.privado || isAdmin) && !bot.useTelegram && !bot.useDiscord)
					.map((bot) => {
						const metrics = bot.loadReport
							? bot.loadReport.getLiveMetrics()
							: { msgsHr: 0, responseTime: { avg: 0, max: 0 } };

						return {
							id: bot.id,
							phoneNumber: bot.phoneNumber,
							supportNumber: bot.supportNumber,
							connected: bot.isConnected,
							lastMessageReceived: bot.lastMessageReceived ?? null,
							msgsHr: metrics.msgsHr,
							responseTime: metrics.responseTime,
							semPV: bot.ignorePV ?? false,
							semConvites: bot.ignoreInvites ?? false,
							banido: bot.banido ?? false,
							comunitario: bot.comunitario ?? false,
							numeroResponsavel: bot.numeroResponsavel ?? false,
							supportMsg: bot.supportMsg ?? false,
							vip: bot.vip ?? false,
							privado: bot.privado ?? false
						};
					})
			});
		} catch (error) {
			api.logger.error("Erro ao processar dados de health:", error);
			const isAdmin = api.isAdmin(req);
			res.json({
				status: "error",
				timestamp: Date.now(),
				isAdmin,
				message: "Erro ao processar dados",
				bots: []
			});
		}
	});

	// Endpoint para testar o layout da página 502
	app.get("/502", async (req, res) => {
		try {
			const fallbackPath = path.join(__dirname, "../../../fallback-proxy/fallback.html");
			let html = await fs.readFile(fallbackPath, "utf8");

			const reasonHtml = `<div class="reason-box">
				<span class="reason-title"><i class="fas fa-info-circle"></i> Modo de Teste:</span>
				<p class="reason-text">Esta é uma demonstração do layout da página de indisponibilidade (Erro 502) acionada para testes pelo administrador.</p>
			</div>`;

			html = html.replace("{{MOTIVO}}", reasonHtml);
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.status(200).send(html);
		} catch (error) {
			api.logger.error("Erro ao carregar página de teste 502:", error);
			res.status(500).send("Erro interno ao carregar a página de teste 502.");
		}
	});

	// Página de gerenciamento por token
	app.get("/manage/:token", (req, res) => {
		const { token } = req.params;
		const filePath = path.join(__dirname, "../../../public/management.html");
		api.logger.info(`[management] => '${token}'`);
		res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
		res.setHeader("Pragma", "no-cache");
		res.setHeader("Expires", "0");
		res.sendFile(filePath);
	});

	// Redireciona para o convite do Discord
	app.get("/discord", (req, res) => {
		if (process.env.DISCORD_INVITE_LINK) {
			return res.redirect(process.env.DISCORD_INVITE_LINK);
		}
		res.redirect("/");
	});

	// Redireciona para o convite do Telegram
	app.get("/telegram", (req, res) => {
		if (process.env.TELEGRAM_INVITE_LINK) {
			return res.redirect(process.env.TELEGRAM_INVITE_LINK);
		}
		res.redirect("/");
	});

	// Serve página de comandos públicos
	app.get(["/cmd", "/comandos"], (req, res) => {
		res.sendFile(path.join(__dirname, "../../../public/cmd.html"));
	});

	// Serve API Docs
	const serveDocs = (req, res) => {
		res.sendFile(path.join(__dirname, "../../../public/api-docs.html"));
	};
	app.get("/api/docs", serveDocs);
	app.get("/docs", serveDocs);

	// Serve página de chat de ajuda
	app.get("/ajuda", (req, res) => {
		res.sendFile(path.join(__dirname, "../../../public/ajuda.html"));
	});

	// Serve página de STT
	const serveSTT = (req, res) => {
		const providers = api.serviceProviderService.getProviders("whisper");
		if (providers.length === 0) {
			return res
				.status(503)
				.send("Serviço de transcrição não disponível (nenhum provider configurado).");
		}
		res.sendFile(path.join(__dirname, "../../../public/stt.html"));
	};
	app.get("/stt", serveSTT);
	app.get("/transcrever", serveSTT);

	// Serve página de Imagine
	const serveImagine = (req, res) => {
		const providers = api.serviceProviderService.getProviders("bonsai");
		if (providers.length === 0) {
			return res
				.status(503)
				.send("Serviço de geração de imagens não disponível (nenhum provider configurado).");
		}
		res.sendFile(path.join(__dirname, "../../../public/imagine.html"));
	};
	app.get("/imagine", serveImagine);

	// Serve página de TTS
	const serveTTS = (req, res) => {
		const providers = api.serviceProviderService.getProviders("f5tts");
		if (providers.length === 0) {
			return res.status(503).send("Serviço de TTS não disponível (nenhum provider configurado).");
		}
		res.sendFile(path.join(__dirname, "../../../public/tts.html"));
	};
	app.get("/tts", serveTTS);
	app.get("/falar", serveTTS);

	// Serve página de Pesca
	const servePesca = (req, res) => {
		res.sendFile(path.join(__dirname, "../../../public/pesca.html"));
	};
	app.get("/pesca", servePesca);
	app.get("/fishing", servePesca);

	// Atalho para o aplicativo Waifuletes na OS
	app.get(["/waifuletes", "/waifus"], (req, res) => {
		res.redirect("/?app=waifuletes");
	});

	// Página de Dossier dos Grupos (HTML)
	app.get("/groups-dossier", api.authenticateBasic, (req, res) => {
		res.sendFile(path.join(__dirname, "../../../public/groups-dossier.html"));
	});

	// Página de Provedores de Serviço (HTML)
	app.get("/service-providers", api.authenticateBasic, (req, res) => {
		res.sendFile(path.join(__dirname, "../../../public/service-providers.html"));
	});

	// Ciclo de vida da Ravena
	app.get("/ciclo-ravena", async (req, res) => {
		res.redirect("https://gemini.google.com/share/a03e1fe297de");
	});

	// Leitura de dados temporários de grupos (!enviar)
	app.get("/getData/:groupId/:variable", (req, res) => {
		const { groupId, variable } = req.params;

		res.setHeader("Content-Type", "application/json");
		api.logger.info(`[getData] => '${variable}'@'${groupId}'`);

		if (groupId.length > 10 && groupId.endsWith("@g.us")) {
			const filePath = path.join(api.database.databasePath, `data-share`, `${groupId}.json`);

			fs.access(filePath)
				.then(async () => {
					fs.readFile(filePath, "utf8").then((data) => {
						const groupDataShare = JSON.parse(data);

						if (groupDataShare[variable]) {
							const dados = groupDataShare[variable][0];

							if (dados) {
								setTimeout(
									(gds, vari, fP) => {
										gds[vari].shift();
										if (gds[vari].length === 0) {
											delete gds[vari];
										}
										fs.writeFile(fP, JSON.stringify(gds ?? {}, null, "\t"), "utf8");
									},
									30000,
									groupDataShare,
									variable,
									filePath
								);

								return res
									.status(200)
									.send(
										JSON.stringify({ restantes: groupDataShare[variable]?.length ?? 0, dados })
									);
							} else {
								return res.status(200).send(JSON.stringify({ restantes: 0, dados: null }));
							}
						} else {
							return res
								.status(404)
								.send(JSON.stringify({ erro: `'${variable}' indisponivel para '${groupId}'` }));
						}
					});
				})
				.catch(() =>
					res.status(404).send(JSON.stringify({ erro: `Nenhum dado disponível para '${groupId}'` }))
				);
		} else {
			return res.status(400).send(JSON.stringify({ erro: `'${groupId}' não é válido` }));
		}
	});

	// Entrega autenticada de mídia direta para o painel de gerenciamento
	app.get("/media-direct/:fileName", async (req, res) => {
		const { fileName } = req.params;
		const token = req.query.token;

		if (!token) {
			return res.status(400).send("Token not provided");
		}

		try {
			const webManagementData = await api.readWebManagementToken(token);

			if (!webManagementData) {
				return res.status(401).send("Unauthorized");
			}

			if (new Date() > new Date(webManagementData.expiresAt)) {
				return res.status(401).send("Token expired");
			}

			const groupData = await api.database.getGroup(webManagementData.groupId);
			if (!groupData) {
				return res.status(404).send("Group not found");
			}

			const groupStr = JSON.stringify(groupData);
			let found = groupStr.includes(fileName);

			if (!found) {
				const commands = await api.database.getCustomCommands(webManagementData.groupId);
				const commandsStr = JSON.stringify(commands);
				found = commandsStr.includes(fileName);
			}

			if (!found) {
				api.logger.warn(
					`[security] Unauthenticated access attempt to file ${fileName} by group ${groupData.id}`
				);
				return res.status(403).send("Forbidden");
			}

			const filePath = path.join(api.database.databasePath, "media", fileName);

			try {
				await fs.access(filePath);
			} catch {
				return res.status(404).send("File not found");
			}

			const ext = path.extname(fileName).toLowerCase();
			let contentType = "application/octet-stream";

			switch (ext) {
				case ".jpg":
				case ".jpeg":
					contentType = "image/jpeg";
					break;
				case ".png":
					contentType = "image/png";
					break;
				case ".gif":
					contentType = "image/gif";
					break;
				case ".mp4":
					contentType = "video/mp4";
					break;
				case ".mp3":
					contentType = "audio/mpeg";
					break;
				case ".wav":
					contentType = "audio/wav";
					break;
				case ".webp":
					contentType = "image/webp";
					break;
			}

			res.setHeader("Content-Type", contentType);
			res.sendFile(filePath);
		} catch (error) {
			api.logger.error("Error serving direct media:", error);
			return res.status(500).send("Server error");
		}
	});
}

module.exports = { registerIndexRoutes };
