const path = require("path");
const fs = require("fs").promises;
const { spawn } = require("child_process");

/**
 * Registra rotas de gerenciamento de instâncias, bots e QR codes da BotAPI
 * Arquivo: src/BotAPI/routes/instancesRoutes.js
 *
 * Rotas registradas:
 * - GET  /restart/:botId             - Reinicia um bot específico
 * - GET  /logout/:botId              - Desconecta a sessão de um bot
 * - GET  /recreate/:botId            - Recria a instância na WhatsGoAPI
 * - GET  /reconnect/:botId           - Tenta reconectar sessão existente da instância
 * - POST /passkey/respond/:botId     - Envia resposta de passkey
 * - POST /passkey/confirm/:botId     - Confirma pareamento de passkey
 * - GET  /api/bot-stats              - Estatísticas agregadas e detalhadas dos bots
 * - GET  /qrimg/:botId               - Imagem PNG estática do QR Code do bot
 * - GET  /qrcode-status/:botId       - Status da conexão e existência de instância
 * - GET  /qrcode-initconnect/:botId  - Dispara fluxo de conexão e emparelhamento
 * - GET  /qrcode-stream/:botId       - SSE em tempo real de QR code e pairing code
 * - GET  /qrcode/:botId              - Interface visual HTML de pareamento e conexão
 * - GET  /api/bots                   - Lista instâncias do bots.json enriquecidas com runtime
 * - POST /api/bots                   - Atualiza e persiste bots.json com sincronização ao vivo
 * - GET  /api/logs                   - Stream SSE de logs do processo do bot (PM2)
 * - GET  /api/stream                 - Stream SSE de eventos gerais e status de serviços
 *
 * @param {Object} api - Instância da BotAPI
 */
function registerInstancesRoutes(api) {
	const app = api.app;

	// Endpoint SSE para streaming de eventos gerais e status de serviços
	app.get("/api/stream", (req, res) => {
		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache");
		res.setHeader("Connection", "keep-alive");
		res.flushHeaders();

		if (api.lastServicesStatus) {
			res.write(`event: service-status\n`);
			res.write(`data: ${JSON.stringify(api.lastServicesStatus)}\n\n`);
		}

		api.sseClients.push(res);

		req.on("close", () => {
			api.sseClients = api.sseClients.filter((client) => client !== res);
		});
	});

	// Novo endpoint para reiniciar um bot específico (requer autenticação)
	app.get("/restart/:botId", api.authenticateBasic, api.strictLimiter, async (req, res) => {
		try {
			const { botId } = req.params;
			const { reason } = req.body ?? {};

			if (!botId) {
				return res.status(400).json({
					status: "error",
					message: "ID do bot não especificado"
				});
			}

			const bot = api.bots.find((b) => b.id === botId);
			if (!bot) {
				return res.status(404).json({
					status: "error",
					message: `Bot com ID '${botId}' não encontrado`
				});
			}

			if (typeof bot.restartBot !== "function") {
				return res.status(400).json({
					status: "error",
					message: `Bot '${botId}' não suporta reinicialização`
				});
			}

			const restartReason =
				reason ?? `Reinicialização via API em ${new Date().toLocaleString("pt-BR")}`;

			try {
				api.logger.info(`Reiniciando bot ${botId} via endpoint API`);
				const resp = await bot.restartBot(restartReason);
				res.json({
					status: "ok",
					message: resp,
					timestamp: Date.now()
				});
				api.logger.info(`Bot ${botId} reiniciado com sucesso via API`);
			} catch (error) {
				api.logger.error(`Erro ao reiniciar bot ${botId} via API:`, error);
				res.json({
					status: "error",
					message: error,
					timestamp: Date.now()
				});
			}
		} catch (error) {
			api.logger.error("Erro no endpoint de reinicialização:", error);
			res.status(500).json({
				status: "error",
				message: "Erro interno do servidor"
			});
		}
	});

	// Logout de uma instância
	app.get("/logout/:botId", api.authenticateBasic, api.strictLimiter, async (req, res) => {
		const { botId } = req.params;
		const bot = api.bots.find((b) => b.id === botId);
		if (!bot) {
			return res
				.status(404)
				.json({ status: "error", message: `Bot com ID '${botId}' não encontrado` });
		}
		try {
			api.logger.info(`[API] Executing logout for bot '${botId}'`);
			const result = await bot.logout();
			res.json({ status: "ok", message: "Logout successful", details: result });
		} catch (e) {
			api.logger.error(`[API] Error during logout for bot '${botId}':`, e);
			res.status(500).json({ status: "error", message: e.message, details: e.stack });
		}
	});

	// Recriar instância
	app.get("/recreate/:botId", api.authenticateBasic, api.strictLimiter, async (req, res) => {
		const { botId } = req.params;
		const bot = api.bots.find((b) => b.id === botId);
		if (!bot) {
			return res
				.status(404)
				.json({ status: "error", message: `Bot com ID '${botId}' não encontrado` });
		}
		try {
			api.logger.info(`[API] Executing recreate for bot '${botId}'`);
			const result = await bot.recreateInstance();
			res.json({ status: "ok", message: "Recreation process finished.", details: result });
		} catch (e) {
			api.logger.error(`[API] Error during recreate for bot '${botId}':`, e);
			res.status(500).json({ status: "error", message: e.message, details: e.stack });
		}
	});

	// Tentar reconectar instância (restaura configurações/JID e conecta)
	app.get("/reconnect/:botId", api.authenticateBasic, api.strictLimiter, async (req, res) => {
		const { botId } = req.params;
		const bot = api.bots.find((b) => b.id === botId);
		if (!bot) {
			return res
				.status(404)
				.json({ status: "error", message: `Bot com ID '${botId}' não encontrado` });
		}
		try {
			api.logger.info(`[API] Executing tryReconnect for bot '${botId}'`);
			if (typeof bot.tryReconnect === "function") {
				const result = await bot.tryReconnect();
				res.json({ status: "ok", message: "Tentativa de reconexão concluída.", details: result });
			} else if (typeof bot._checkInstanceStatusAndConnect === "function") {
				const result = await bot._checkInstanceStatusAndConnect(true, false);
				res.json({ status: "ok", message: "Status verificado.", details: result });
			} else {
				res.json({ status: "error", message: "Bot não suporta reconexão automática." });
			}
		} catch (e) {
			api.logger.error(`[API] Error during tryReconnect for bot '${botId}':`, e);
			res.status(500).json({ status: "error", message: e.message, details: e.stack });
		}
	});

	// Responder passkey
	app.post(
		"/passkey/respond/:botId",
		api.authenticateBasic,
		api.strictLimiter,
		async (req, res) => {
			const { botId } = req.params;
			const bot = api.bots.find((b) => b.id === botId);
			if (!bot) {
				return res
					.status(404)
					.json({ status: "error", message: `Bot com ID '${botId}' não encontrado` });
			}
			try {
				const response = await bot.apiClient.post("/instance/passkey/respond", req.body);
				res.json(response.data || response);
			} catch (e) {
				api.logger.error(`[API] Error during passkey respond for bot '${botId}':`, e);
				res.status(500).json({ status: "error", message: e.message, details: e.stack });
			}
		}
	);

	// Confirmar passkey
	app.post(
		"/passkey/confirm/:botId",
		api.authenticateBasic,
		api.strictLimiter,
		async (req, res) => {
			const { botId } = req.params;
			const bot = api.bots.find((b) => b.id === botId);
			if (!bot) {
				return res
					.status(404)
					.json({ status: "error", message: `Bot com ID '${botId}' não encontrado` });
			}
			try {
				const response = await bot.apiClient.post("/instance/passkey/confirm", {});
				res.json(response.data || response);
			} catch (e) {
				api.logger.error(`[API] Error during passkey confirm for bot '${botId}':`, e);
				res.status(500).json({ status: "error", message: e.message, details: e.stack });
			}
		}
	);

	// Endpoint para estatísticas detalhadas dos bots (tabela)
	app.get("/api/bot-stats", api.generalLimiter, async (req, res) => {
		try {
			const now = Date.now();
			if (api.botStatsCache.data.length > 0) {
				res.json(api.botStatsCache.data);

				if (
					now - api.botStatsCache.lastUpdate > api.botStatsCache.cacheTime &&
					!api.isUpdatingBotStats
				) {
					api.updateBotStatsCache().catch((error) => {
						api.logger.error("Erro ao atualizar bot stats em background:", error);
					});
				}
				return;
			}

			await api.updateBotStatsCache();
			res.json(api.botStatsCache.data);
		} catch (error) {
			api.logger.error("Erro ao buscar estatísticas dos bots:", error);
			res.status(500).json({ error: "Erro ao buscar estatísticas" });
		}
	});

	// Endpoint para totais de mensagens agregadas por bot em uma janela de dias (padrão: 3 dias)
	app.get("/api/bot-load-totals", api.generalLimiter, async (req, res) => {
		try {
			const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 3));
			const onlyGroup = req.query.onlyGroup === "true" || req.query.onlyGroup === "1";
			const since = Date.now() - days * 24 * 60 * 60 * 1000;
			const totalsMap = await api.database.getBotsMessageTotals(since, { onlyGroup });
			const result = {};
			for (const [botId, count] of totalsMap.entries()) {
				result[botId] = count;
			}
			res.json({
				days,
				since,
				onlyGroup,
				totals: result
			});
		} catch (error) {
			api.logger.error("Erro ao buscar totais de mensagens dos bots:", error);
			res.status(500).json({ error: "Erro ao buscar totais de mensagens" });
		}
	});

	// Imagem do QR Code
	app.get("/qrimg/:botId", api.authenticateBasic, async (req, res) => {
		const { botId } = req.params;
		const filePath = path.join(api.database.databasePath, "qrcodes", `qrcode_${botId}.png`);

		await fs
			.access(filePath)
			.catch(() => res.status(404).send(`QRCode para '${botId}' não disponível.`));

		res.setHeader("Content-Type", "image/png");
		res.sendFile(filePath);
	});

	// Status do QR Code e conexão
	app.get("/qrcode-status/:botId", api.authenticateBasic, async (req, res) => {
		res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
		res.setHeader("Pragma", "no-cache");
		res.setHeader("Expires", "0");
		const { botId } = req.params;
		const bot = api.bots.find((b) => b.id === botId);
		if (!bot) {
			return res
				.status(404)
				.json({ status: "error", message: `Bot com ID '${botId}' não encontrado` });
		}
		try {
			const instanceStatus = await bot._checkInstanceStatusAndConnect(true, false);
			let instanceExists = false;
			try {
				const goInstance = await bot.getGoInstance(bot.instanceName);
				instanceExists = !!goInstance;
			} catch {
				instanceExists = false;
			}
			res.json({ ...instanceStatus, instanceExists });
		} catch (e) {
			api.logger.error("Error checking qrcode status:", e);
			res.status(500).json({ status: "error", message: e.message });
		}
	});

	// Inicia fluxo de conexão
	app.get("/qrcode-initconnect/:botId", api.authenticateBasic, async (req, res) => {
		res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
		const { botId } = req.params;
		const bot = api.bots.find((b) => b.id === botId);
		if (!bot) {
			return res.status(404).json({ status: "error", message: `Bot '${botId}' não encontrado` });
		}
		try {
			if (bot._disconnectTimer) {
				clearTimeout(bot._disconnectTimer);
				bot._disconnectTimer = null;
			}
			const instanceStatus = await bot._checkInstanceStatusAndConnect(true, true);
			let instanceExists = false;
			try {
				const goInstance = await bot.getGoInstance(bot.instanceName);
				instanceExists = !!goInstance;
			} catch {
				instanceExists = false;
			}
			res.json({ ...instanceStatus, instanceExists });
		} catch (e) {
			api.logger.error("Error initiating connect for bot:", e);
			res.status(500).json({ status: "error", message: e.message });
		}
	});

	// SSE stream de QR code / pairing code
	app.get("/qrcode-stream/:botId", api.authenticateBasic, (req, res) => {
		const { botId } = req.params;
		const bot = api.bots.find((b) => b.id === botId);
		if (!bot) {
			return res.status(404).json({ status: "error", message: `Bot '${botId}' não encontrado` });
		}

		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache");
		res.setHeader("Connection", "keep-alive");
		res.setHeader("X-Accel-Buffering", "no");
		res.flushHeaders();

		if (bot._disconnectTimer) {
			clearTimeout(bot._disconnectTimer);
			bot._disconnectTimer = null;
			api.logger.info(
				`[QR SSE] Timer de apagar instância cancelado para ${botId} (usuário abrindo página)`
			);
		}

		if (bot.connectDataCache?.data) {
			const d = bot.connectDataCache.data;
			res.write(
				`data: ${JSON.stringify({ type: "qr_update", qrCode: d.qrCode || "", code: d.code || "", pairingCode: d.pairingCode || "" })}\n\n`
			);
		}

		const heartbeat = setInterval(() => {
			try {
				res.write(`: heartbeat\n\n`);
			} catch {
				/* ignore */
			}
		}, 20000);

		bot.addQRSseClient(res);

		req.on("close", () => {
			clearInterval(heartbeat);
			bot.removeQRSseClient(res);
			api.logger.info(`[QR SSE] Cliente desconectou de ${botId}`);

			if (!bot.isConnected && bot.qrSseClients.length === 0 && bot.disconnectedAt) {
				const elapsed = Date.now() - bot.disconnectedAt;
				const remaining = 15 * 60 * 1000 - elapsed;
				if (remaining > 0) {
					bot._disconnectTimer = setTimeout(async () => {
						try {
							api.logger.info(
								`[${botId}] Timer reagendado: apagando instância após 15 min desconectado.`
							);
							await bot.deleteInstance();
							bot.connectDataCache = null;
							bot._disconnectTimer = null;
							bot.broadcastQRUpdate({ type: "instance_deleted", botId: bot.id });
						} catch (err) {
							api.logger.error(`[${botId}] Erro ao apagar instância (reagendado):`, err);
						}
					}, remaining);
					api.logger.info(
						`[QR SSE] Timer reagendado para ${botId}: ${Math.round(remaining / 1000)}s restantes`
					);
				} else {
					bot
						.deleteInstance()
						.catch((err) =>
							api.logger.error(`[${botId}] Erro ao apagar instância (imediato):`, err)
						);
				}
			}
		});
	});

	// Página interativa de QR Code e Pairing Code
	app.get("/qrcode/:botId", api.authenticateBasic, async (req, res) => {
		res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
		res.setHeader("Pragma", "no-cache");
		res.setHeader("Expires", "0");
		const { botId } = req.params;

		const bot = api.bots.find((b) => b.id === botId);
		if (!bot) {
			return res.status(404).json({
				status: "error",
				message: `Bot com ID '${botId}' não encontrado`
			});
		}

		const formattedDate = new Date().toLocaleString("pt-BR", {
			timeZone: "America/Sao_Paulo",
			hour12: false,
			year: "numeric",
			month: "long",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit"
		});

		let user = api.apiUser;
		let pass = api.apiPassword;
		if (bot.managementUser && bot.managementPW) {
			user = bot.managementUser;
			pass = bot.managementPW;
		}
		const authRaw = Buffer.from(`${user}:${pass}`).toString("base64");
		const isConnected = bot.isConnected;

		let instanceExists = false;
		try {
			const instanceInfo = await bot.getGoInstance(bot.instanceName);
			instanceExists = !!instanceInfo;
		} catch {
			instanceExists = false;
		}

		const htmlResponse = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${botId} — Conexão WhatsApp</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0f1117; --surface: #1a1d27; --surface2: #22263a; --border: #2d3149;
      --text: #e8eaf6; --text-muted: #8892b0; --green: #25d366; --green-dark: #1a9e4b;
      --yellow: #f6c90e; --red: #ff4d4d; --blue: #4f8ef7; --orange: #f59e42;
    }
    body { font-family: 'Inter', -apple-system, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: flex-start; padding: 2rem 1rem; }
    .card { position: relative; background: var(--surface); border: 1px solid var(--border); border-radius: 1.25rem; padding: 2rem; max-width: 520px; width: 100%; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
    .btn-refresh {
      position: absolute;
      top: 1.5rem;
      right: 1.5rem;
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      font-size: 1.15rem;
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      color: var(--text);
      transition: all 0.2s ease;
      line-height: 1;
    }
    .btn-refresh:hover {
      background: var(--border);
      transform: scale(1.05);
    }
    .btn-refresh.spinning {
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { 100% { transform: rotate(360deg); } }
    .bot-header { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; }
    .bot-icon { width: 48px; height: 48px; background: var(--green); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.5rem; flex-shrink: 0; }
    .bot-title h1 { font-size: 1.2rem; font-weight: 700; }
    .bot-title p { font-size: 0.82rem; color: var(--text-muted); margin-top: 0.2rem; }
    .status-badge { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.3rem 0.75rem; border-radius: 9999px; font-size: 0.8rem; font-weight: 600; margin-bottom: 1.25rem; }
    .status-badge.connected { background: rgba(37,211,102,0.15); color: var(--green); border: 1px solid rgba(37,211,102,0.3); }
    .status-badge.disconnected { background: rgba(255,77,77,0.15); color: var(--red); border: 1px solid rgba(255,77,77,0.3); }
    .status-badge.no-instance { background: rgba(245,158,66,0.15); color: var(--orange); border: 1px solid rgba(245,158,66,0.3); }
    .status-badge.connecting { background: rgba(79,142,247,0.15); color: var(--blue); border: 1px solid rgba(79,142,247,0.3); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; display: inline-block; }
    .dot.pulse { animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
    .info-row { background: var(--surface2); border: 1px solid var(--border); border-radius: 0.75rem; padding: 0.85rem 1rem; margin-bottom: 1rem; font-size: 0.9rem; color: var(--text-muted); display: flex; align-items: flex-start; gap: 0.6rem; }
    .info-row strong { color: var(--text); }
    .qr-section { text-align: center; margin: 1.5rem 0; }
    .qr-section h2 { font-size: 1rem; font-weight: 600; color: var(--text-muted); margin-bottom: 1rem; text-transform: uppercase; letter-spacing: 0.05em; }
    #qr-img { max-width: 250px; height: auto; border-radius: 0.75rem; border: 3px solid var(--border); background: white; padding: 8px; transition: opacity 0.3s; }
    #qr-img.refreshing { opacity: 0.4; }
    .pairing-section h2 { font-size: 1rem; font-weight: 600; color: var(--text-muted); text-align: center; margin-bottom: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
    #pairing-code { font-family: 'Courier New', monospace; font-size: 2.2rem; font-weight: 700; letter-spacing: 0.1em; color: var(--green); text-align: center; padding: 1rem; background: rgba(37,211,102,0.08); border: 1px solid rgba(37,211,102,0.2); border-radius: 0.75rem; min-height: 4rem; display: flex; align-items: center; justify-content: center; }
    .help-box {
      background: rgba(79, 142, 247, 0.08);
      border: 1px solid rgba(79, 142, 247, 0.2);
      border-radius: 0.75rem;
      padding: 0.85rem 1rem;
      margin: 1.25rem 0 0.5rem 0;
      font-size: 0.85rem;
      color: var(--text-muted);
      line-height: 1.45;
      text-align: left;
    }
    .help-box strong {
      color: var(--text);
    }
    #status-msg { text-align: center; font-size: 0.9rem; color: var(--text-muted); margin: 1rem 0; min-height: 1.5rem; }
    .btn-row { display: flex; gap: 0.75rem; flex-wrap: wrap; justify-content: center; margin-top: 1.5rem; }
    button { padding: 0.6rem 1.2rem; border: none; border-radius: 0.5rem; font-size: 0.88rem; font-weight: 600; cursor: pointer; transition: all 0.2s; }
    .btn-primary { background: var(--green); color: #000; }
    .btn-primary:hover { background: var(--green-dark); color: #fff; }
    .btn-secondary { background: var(--surface2); color: var(--text); border: 1px solid var(--border); }
    .btn-secondary:hover { background: var(--border); }
    .btn-warning { background: rgba(245,158,66,0.15); color: var(--orange); border: 1px solid rgba(245,158,66,0.3); }
    .btn-warning:hover { background: var(--orange); color: #000; }
    .btn-danger { background: rgba(255,77,77,0.15); color: var(--red); border: 1px solid rgba(255,77,77,0.3); }
    .btn-danger:hover { background: var(--red); color: #fff; }
    .footer { margin-top: 1.5rem; text-align: center; font-size: 0.78rem; color: var(--text-muted); }
  </style>
</head>
<body>
  <div class="card">
    <button id="btn-refresh" class="btn-refresh" onclick="refreshPage()" title="Atualizar">🔄</button>
    <div class="bot-header">
      <div class="bot-icon">🤖</div>
      <div class="bot-title">
        <h1>${botId}</h1>
        <p>${formattedDate}</p>
      </div>
    </div>
    <div id="badge-container">
      ${
				isConnected
					? '<span class="status-badge connected"><span class="dot"></span> Conectado</span>'
					: !instanceExists
						? '<span class="status-badge no-instance"><span class="dot"></span> Sem Instância</span>'
						: '<span class="status-badge disconnected"><span class="dot"></span> Desconectado</span>'
			}
    </div>
    ${
			isConnected
				? ""
				: `
    <div class="info-row">
      <span>ℹ️</span>
      <div>
        <strong>Importante:</strong> Se desconectado por mais de <strong>15 minutos</strong>, a instância é apagada automaticamente.
      </div>
    </div>
    <div id="connect-area">
      <div class="qr-section">
        <h2>QR Code</h2>
        <img id="qr-img" src="" alt="Carregando QR Code..." style="display:none;" />
        <div id="qr-placeholder" style="color:var(--text-muted); font-size:0.85rem; padding: 2rem 0;">Aguardando QR Code...</div>
      </div>
      <div class="pairing-section">
        <h2>Código de Pareamento</h2>
        <div id="pairing-code">—</div>
      </div>
    </div>`
		}
    <div class="help-box">
      <div>&bull; <strong>Tentar Reconectar:</strong> Tente isto antes de recriar, principalmente quando o bot ficar muitas horas offline.</div>
    </div>
    <div id="status-msg"></div>
    <div class="btn-row">
      ${
				isConnected
					? `
      <button class="btn-danger" onclick="logoutBot()">Desconectar</button>
      <button class="btn-primary" onclick="tryReconnect()">Tentar Reconectar</button>
      <button class="btn-warning" onclick="recreateBot()">Recriar</button>
      `
					: `
      <button class="btn-primary" onclick="tryReconnect()">Tentar Reconectar</button>
      <button class="btn-warning" onclick="recreateBot()">Recriar</button>
      <button class="btn-danger" onclick="logoutBot()">Desconectar</button>
      `
			}
    </div>
  </div>
  <div class="footer">RavenaBot AI &bull; WhatsApp Connection Manager</div>
  <script>
    const botId = "${botId}";
    const authQuery = "?auth=Basic " + "${authRaw}";
    let isConnected = ${isConnected};
    let instanceExists = ${instanceExists};
    const statusBox = document.getElementById('status-msg');

    function applyConnectData(d) {
      if (!d) return;
      const qri = document.getElementById('qr-img');
      const qrp = document.getElementById('qr-placeholder');
      const pc = document.getElementById('pairing-code');
      if (d.qrCode && qri) {
        qri.src = d.qrCode.startsWith('data:') ? d.qrCode : 'data:image/png;base64,' + d.qrCode;
        qri.style.display = 'inline-block';
        if (qrp) qrp.style.display = 'none';
      }
      const code = d.pairingCode || d.code || '';
      if (code && pc) { pc.textContent = code; }
    }

    function startSSE() {
      const es = new EventSource('/qrcode-stream/' + botId + authQuery);
      es.onmessage = function(e) {
        try {
          const d = JSON.parse(e.data);
          if (d.type === 'qr_update') { applyConnectData(d); }
          else if (d.type === 'connected') { window.location.reload(); }
        } catch(err){}
      };
      es.onerror = function() { setTimeout(startSSE, 5000); es.close(); };
    }

    async function checkStatus() {
      try {
        const r = await fetch('/qrcode-status/' + botId + authQuery, { credentials: 'same-origin' });
        const d = await r.json();
        if ((d.connected && !isConnected) || (!d.connected && isConnected)) {
          window.location.reload();
        }
      } catch(e){}
    }

    async function refreshPage() {
      const btn = document.getElementById('btn-refresh');
      if (btn) btn.classList.add('spinning');
      try {
        await checkStatus();
      } catch(e){}
      setTimeout(() => {
        window.location.reload();
      }, 300);
    }

    async function forceConnect() {
      const msg = document.getElementById('status-msg');
      if (msg) msg.textContent = 'Iniciando conexão...';
      try {
        const r = await fetch('/qrcode-initconnect/' + botId + authQuery, { credentials: 'same-origin' });
        const d = await r.json();
        if (d.extra && d.extra.connectData) { applyConnectData(d.extra.connectData); }
        if (msg) msg.textContent = 'Fluxo de conexão iniciado.';
      } catch(e) { if (msg) msg.textContent = 'Erro ao iniciar conexão: ' + e.message; }
    }

    async function tryReconnect() {
      const msg = document.getElementById('status-msg');
      if (msg) msg.textContent = 'Tentando reconectar sessão existente...';
      try {
        const r = await fetch('/reconnect/' + botId + authQuery, { credentials: 'same-origin' });
        const d = await r.json();
        if (d.status === 'ok') {
          if (msg) msg.textContent = 'Comando de reconexão enviado. Verificando status...';
          setTimeout(async () => {
            await checkStatus();
            window.location.reload();
          }, 3000);
        } else {
          if (msg) msg.textContent = 'Erro ao reconectar: ' + (d.message || 'Erro desconhecido');
        }
      } catch(e) {
        if (msg) msg.textContent = 'Erro de rede: ' + e.message;
      }
    }

    async function recreateBot() {
      if (!confirm('Deseja realmente apagar e recriar esta instância? Esta ação apagará a instância atual e criará uma nova.')) return;
      const msg = document.getElementById('status-msg');
      if (msg) msg.textContent = 'Recriando instância na WhatsGoAPI...';
      try {
        const r = await fetch('/recreate/' + botId + authQuery, { credentials: 'same-origin' });
        const d = await r.json();
        if (d.status === 'ok') {
          if (msg) msg.textContent = 'Instância recriada com sucesso! Atualizando página...';
          setTimeout(() => window.location.reload(), 1500);
        } else {
          if (msg) msg.textContent = 'Erro ao recriar: ' + (d.message || 'Erro desconhecido');
        }
      } catch(e) {
        if (msg) msg.textContent = 'Erro de rede: ' + e.message;
      }
    }

    async function logoutBot() {
      if (!confirm('Deseja realmente desconectar esta sessão?')) return;
      const msg = document.getElementById('status-msg');
      if (msg) msg.textContent = 'Desconectando...';
      try {
        const r = await fetch('/logout/' + botId + authQuery, { credentials: 'same-origin' });
        const d = await r.json();
        if (d.status === 'ok') { window.location.reload(); }
        else { if (msg) msg.textContent = 'Erro ao desconectar.'; }
      } catch(e) { if (msg) msg.textContent = 'Erro de rede: ' + e.message; }
    }

    (function init() {
      if (isConnected) {
        setInterval(checkStatus, 5000);
        return;
      }
      if (!instanceExists) {
        if (statusBox) statusBox.textContent = 'Instância não existe na WhatsGoAPI. Clique em "Tentar Reconectar" ou "Recriar".';
        return;
      }
      startSSE();
      setInterval(checkStatus, 4000);
      forceConnect();
    })();
  </script>
</body>
</html>`;

		res.send(htmlResponse);
	});

	// Dashboard / Instances: Get bots configuration enriched with runtime status
	app.get("/api/bots", api.authenticateBasic, async (req, res) => {
		try {
			const botsJsonPath = path.join(__dirname, "../../../bots.json");
			let data = [];
			try {
				const fileContent = await fs.readFile(botsJsonPath, "utf8");
				data = JSON.parse(fileContent);
			} catch (readErr) {
				if (readErr.code === "ENOENT") {
					api.logger.warn("bots.json not found, returning empty array.");
					return res.json([]);
				}
				throw readErr;
			}

			if (!Array.isArray(data)) {
				data = [];
			}

			let runtimeStatusMap = new Map();
			try {
				runtimeStatusMap = await api.getBotsRuntimeStatusMap();
			} catch (statusErr) {
				api.logger.warn("Erro ao obter mapa de status de runtime:", statusErr);
			}

			const enrichedBots = data.map((botConfig) => {
				const liveBot = api.bots.find(
					(b) =>
						b.id === botConfig.nome ||
						(botConfig.numero &&
							b.phoneNumber &&
							String(b.phoneNumber) === String(botConfig.numero))
				);

				const runtime =
					liveBot && runtimeStatusMap.has(liveBot.id)
						? runtimeStatusMap.get(liveBot.id)
						: {
								isLive: false,
								connected: false,
								msgsHr: 0,
								responseTime: { avg: 0, max: 0 },
								groupsCount: 0,
								lastMessageReceived: null
							};

				return {
					...botConfig,
					_runtime: runtime,
					connected: runtime.connected,
					msgsHr: runtime.msgsHr,
					responseTime: runtime.responseTime,
					groupsCount: runtime.groupsCount,
					lastMessageReceived: runtime.lastMessageReceived,
					isLive: runtime.isLive
				};
			});

			const foundNames = new Set(data.map((b) => b.nome));
			api.bots.forEach((liveBot) => {
				if (!foundNames.has(liveBot.id)) {
					const runtime = runtimeStatusMap.get(liveBot.id) || {
						isLive: true,
						connected: Boolean(liveBot.isConnected),
						msgsHr: 0,
						responseTime: { avg: 0, max: 0 },
						groupsCount: 0,
						lastMessageReceived: liveBot.lastMessageReceived ?? null
					};
					enrichedBots.push({
						enabled: liveBot.enabled !== false,
						nome: liveBot.id,
						nomeExibir: liveBot.nomeExibir || liveBot.id,
						numero: liveBot.phoneNumber || (liveBot.numero ? String(liveBot.numero) : ""),
						customPrefix: liveBot.prefix || "!",
						privado: Boolean(liveBot.privado),
						vip: Boolean(liveBot.vip),
						comunitario: Boolean(liveBot.comunitario),
						banido: Boolean(liveBot.banido),
						ignorePV: Boolean(liveBot.ignorePV),
						autoDownloadPV: Boolean(liveBot.autoDownloadPV),
						ignoreInvites: Boolean(liveBot.ignoreInvites),
						pvAI: Boolean(liveBot.pvAI),
						extras: liveBot.extras || {},
						_runtime: runtime,
						connected: runtime.connected,
						msgsHr: runtime.msgsHr,
						responseTime: runtime.responseTime,
						groupsCount: runtime.groupsCount,
						lastMessageReceived: runtime.lastMessageReceived,
						isLive: true
					});
				}
			});

			res.json(enrichedBots);
		} catch (error) {
			api.logger.error("Error reading bots.json:", error);
			res.status(500).json({ status: "error", message: "Failed to read bots configuration." });
		}
	});

	// Dashboard / Instances: Save bots configuration and synchronize in real-time
	app.post("/api/bots", api.authenticateBasic, async (req, res) => {
		const botsData = req.body;
		if (!Array.isArray(botsData)) {
			return res
				.status(400)
				.json({ status: "error", message: "Formato inválido. Esperado um array de instâncias." });
		}

		for (const bot of botsData) {
			if (!bot || typeof bot !== "object") {
				return res.status(400).json({
					status: "error",
					message: "Entrada inválida: cada item deve ser um objeto de configuração."
				});
			}

			if (!bot.nome || typeof bot.nome !== "string" || bot.nome.trim().length === 0) {
				return res.status(400).json({
					status: "error",
					message: "Campo 'nome' é obrigatório para todas as instâncias."
				});
			}

			if (typeof bot.enabled !== "boolean") {
				bot.enabled = Boolean(bot.enabled);
			}

			if (!bot.useDiscord && (!bot.numero || String(bot.numero).trim().length === 0)) {
				return res.status(400).json({
					status: "error",
					message: `Campo 'numero' é obrigatório para a instância '${bot.nome}'.`
				});
			}

			if (bot.extras !== undefined && bot.extras !== null) {
				if (typeof bot.extras !== "object" || Array.isArray(bot.extras)) {
					return res.status(400).json({
						status: "error",
						message: `Campo 'extras' da instância '${bot.nome}' deve ser um objeto.`
					});
				}

				for (const [catKey, catVal] of Object.entries(bot.extras)) {
					if (typeof catVal !== "object" || catVal === null || Array.isArray(catVal)) {
						return res.status(400).json({
							status: "error",
							message: `Categoria '${catKey}' em extras da instância '${bot.nome}' deve ser um objeto.`
						});
					}

					for (const [propKey, propVal] of Object.entries(catVal)) {
						if (typeof propVal === "object" && propVal !== null) {
							return res.status(400).json({
								status: "error",
								message: `Profundidade máxima de 3 níveis excedida em extras -> '${catKey}' -> '${propKey}'. Propriedades devem ser valores primitivos (string, número ou booleano).`
							});
						}
					}
				}
			}
		}

		const botsJsonPath = path.join(__dirname, "../../../bots.json");

		let currentBots = [];
		try {
			const currentData = await fs.readFile(botsJsonPath, "utf8");
			currentBots = JSON.parse(currentData) || [];
		} catch {
			// arquivo pode não existir ainda
		}

		const incomingNames = new Set(botsData.map((b) => b.nome));
		if (Array.isArray(currentBots)) {
			for (const prevBot of currentBots) {
				if (prevBot && prevBot.nome && !incomingNames.has(prevBot.nome)) {
					botsData.push({
						...prevBot,
						enabled: false
					});
					api.logger.warn(
						`[BotAPI] Instância '${prevBot.nome}' foi preservada e marcada como desativada (deleção não permitida).`
					);
				}
			}
		}

		try {
			const cleanBotsData = botsData.map((b) => {
				const copy = { ...b };
				delete copy._runtime;
				delete copy.connected;
				delete copy.msgsHr;
				delete copy.responseTime;
				delete copy.groupsCount;
				delete copy.lastMessageReceived;
				delete copy.isLive;
				return copy;
			});

			await fs.writeFile(botsJsonPath, JSON.stringify(cleanBotsData, null, 2), "utf8");

			let synchronizedCount = 0;
			for (const botConfig of cleanBotsData) {
				const liveBot = api.bots.find(
					(b) =>
						b.id === botConfig.nome ||
						(botConfig.numero &&
							b.phoneNumber &&
							String(b.phoneNumber) === String(botConfig.numero))
				);

				if (liveBot) {
					liveBot.enabled = Boolean(botConfig.enabled);
					liveBot.nomeExibir = botConfig.nomeExibir || botConfig.nome;
					liveBot.prefix = botConfig.customPrefix || (liveBot.useTelegram ? "/" : "!");
					liveBot.privado = Boolean(botConfig.privado);
					liveBot.vip = Boolean(botConfig.vip);
					liveBot.comunitario = Boolean(botConfig.comunitario);
					liveBot.banido = Boolean(botConfig.banido);
					liveBot.ignorePV = Boolean(botConfig.ignorePV);
					liveBot.autoDownloadPV = Boolean(botConfig.autoDownloadPV);
					liveBot.ignoreInvites = Boolean(botConfig.ignoreInvites);
					liveBot.pvAI = Boolean(botConfig.pvAI);
					liveBot.notificarDonate = Boolean(botConfig.notificarDonate);
					liveBot.updateStatus =
						botConfig.updateStatus !== undefined ? Boolean(botConfig.updateStatus) : true;
					liveBot.sendJoinInfo = Boolean(botConfig.sendJoinInfo);
					liveBot.aiPersonality = botConfig.aiPersonality || "";
					liveBot.supportMsg = botConfig.msgSuporte || botConfig.supportMsg || null;
					liveBot.numeroResponsavel = botConfig.numeroResponsavel || null;
					if (botConfig.managementUser) liveBot.managementUser = botConfig.managementUser;
					if (botConfig.managementPW) liveBot.managementPW = botConfig.managementPW;
					if (botConfig.grupoLogs !== undefined) liveBot.grupoLogs = botConfig.grupoLogs;
					if (botConfig.grupoAvisos !== undefined) liveBot.grupoAvisos = botConfig.grupoAvisos;
					if (botConfig.grupoInvites !== undefined) liveBot.grupoInvites = botConfig.grupoInvites;
					if (botConfig.dossieGroups !== undefined) liveBot.dossieGroups = botConfig.dossieGroups;
					if (botConfig.grupoEstabilidade !== undefined)
						liveBot.grupoEstabilidade = botConfig.grupoEstabilidade;
					if (botConfig.linkGrupao !== undefined) liveBot.linkGrupao = botConfig.linkGrupao;
					if (botConfig.linkAvisos !== undefined) liveBot.linkAvisos = botConfig.linkAvisos;
					liveBot.extras = botConfig.extras ? JSON.parse(JSON.stringify(botConfig.extras)) : {};

					synchronizedCount++;
				}
			}

			api.logger.info(
				`[BotAPI] Configuração de ${cleanBotsData.length} instâncias salva e ${synchronizedCount} atualizadas em tempo real.`
			);

			res.json({
				status: "ok",
				message: "Configurações salvas e sincronizadas em tempo real.",
				synchronizedCount,
				total: cleanBotsData.length
			});
		} catch (error) {
			api.logger.error("Error writing to bots.json:", error);
			res.status(500).json({ status: "error", message: "Failed to save bots configuration." });
		}
	});

	// Dashboard: Stream logs
	app.get("/api/logs", api.authenticateBasic, (req, res) => {
		api.logger.info("Starting log stream to dashboard.");
		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache");
		res.setHeader("Connection", "keep-alive");

		const logStream = spawn("pm2", ["logs", "ravena-ai", "--raw"]);

		logStream.stdout.on("data", (data) => {
			res.write(`data: ${data.toString()}\n\n`);
		});

		logStream.stderr.on("data", (data) => {
			res.write(`data: [ERROR] ${data.toString()}\n\n`);
		});

		req.on("close", () => {
			api.logger.info("Closing log stream to dashboard.");
			logStream.kill();
		});
	});
}

module.exports = { registerInstancesRoutes };
