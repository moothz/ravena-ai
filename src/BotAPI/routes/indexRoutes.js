const path = require("path");
const fs = require("fs").promises;
const express = require("express");
const storageService = require("../../services/StorageService");

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
 * - GET  /status                      - Página pública de status das instâncias e canais de aviso
 * - GET  /admin, /admin.html          - Painel de admin unificado (experimental, Basic Auth)
 * - (middleware) telas antigas de admin  - 302 para /admin#/<área> quando estão em
 *                                          LEGACY_ADMIN_REDIRECTS (?legado=1 mantém a antiga)
 * - GET  /waifuletes, /waifus         - Atalho para o app de Waifuletes na OS
 * - GET  /groups-dossier              - Visualizador HTML de dossiês de grupos
 * - GET  /service-providers           - Interface de gerenciamento de provedores de IA
 * - GET  /ciclo-ravena                - Redirecionamento do ciclo de vida da Ravena
 * - GET  /getData/:groupId/:variable  - Leitura pública de variáveis temporárias de grupos
 * - GET  /media-direct/:fileName      - Entrega direta e autenticada de mídia de grupo
 *
 * @param {Object} api - Instância da BotAPI
 */
const PUBLIC_DIR = path.join(__dirname, "../../../public");
const ONE_WEEK_SECONDS = 7 * 24 * 60 * 60;
/** HTML do painel /admin, fora de public/ para só sair pela rota autenticada */
const ADMIN_VIEW = path.join(__dirname, "../views/admin.html");

/**
 * Política de cache dos arquivos estáticos (express.static):
 * - HTML: "no-cache" (sempre revalida via ETag), para que referências novas com ?v= sejam vistas
 *   imediatamente após um deploy em vez de servir a página antiga por até 1 dia;
 * - assets versionados (URL com ?v=...): 7 dias, já que qualquer mudança troca a URL;
 * - demais assets: mantém o maxAge padrão (1 dia) definido nas opções.
 * @param {import("express").Response} res
 * @param {string} filePath
 */
function setStaticCacheHeaders(res, filePath) {
	if (filePath.endsWith(".html")) {
		res.setHeader("Cache-Control", "no-cache");
		return;
	}
	const query = (res.req?.originalUrl || res.req?.url || "").split("?")[1] || "";
	if (/(^|&)v=/.test(query)) {
		res.setHeader("Cache-Control", `public, max-age=${ONE_WEEK_SECONDS}`);
	}
}

const STATIC_OPTIONS = { maxAge: "1d", etag: true, setHeaders: setStaticCacheHeaders };

/**
 * Telas antigas de admin que já têm área nativa no /admin: caminho canônico → rota interna
 * do painel (o que vem depois de "#/"). COMEÇA VAZIO; cada área nativa acrescenta a sua
 * entrada quando ficar pronta, por exemplo:
 *   "/banco/admin": "banco",
 *   "/dossies": "pessoas",
 *   "/groups-dossier": "pessoas/grupos",
 * Os apelidos de cada tela (LEGACY_ADMIN_ALIASES) seguem a entrada do caminho canônico.
 * Saída de emergência: ?legado=1 continua servindo a tela antiga (e ?embed=1 também, para
 * nunca abrir o painel dentro dele mesmo num iframe).
 * @type {Object<string, string>}
 */
const LEGACY_ADMIN_REDIRECTS = {};

/** Outros endereços da mesma tela antiga → caminho canônico usado em LEGACY_ADMIN_REDIRECTS. */
const LEGACY_ADMIN_ALIASES = {
	"/instances.html": "/instances",
	"/banco-admin.html": "/banco/admin",
	"/ravenabank/admin": "/banco/admin",
	"/eventos-admin.html": "/eventos/admin",
	"/events/admin": "/eventos/admin",
	"/service-providers.html": "/service-providers",
	"/dossies.html": "/dossies",
	"/dossier": "/dossies",
	"/dossie": "/dossies",
	"/groups-dossier.html": "/groups-dossier"
};

/**
 * Middleware: GET/HEAD numa tela antiga do mapa → 302 para /admin#/<área>, preservando ?auth=
 * (o /admin cria a sessão e tira a credencial da barra de endereço).
 * @param {Object<string, string>} [map] - padrão: LEGACY_ADMIN_REDIRECTS (lido a cada pedido)
 * @returns {import("express").RequestHandler}
 */
function createLegacyAdminRedirect(map = LEGACY_ADMIN_REDIRECTS) {
	return (req, res, next) => {
		if (req.method !== "GET" && req.method !== "HEAD") return next();
		const raw = req.path.length > 1 ? req.path.replace(/\/+$/, "") : req.path;
		const canonical = LEGACY_ADMIN_ALIASES[raw] || raw;
		if (!Object.prototype.hasOwnProperty.call(map, canonical)) return next();
		const q = req.query || {};
		if (q.legado === "1" || q.embed === "1") return next();
		const target = String(map[canonical]).replace(/^#?\/?/, "");
		const auth = typeof q.auth === "string" && q.auth ? `?auth=${encodeURIComponent(q.auth)}` : "";
		res.setHeader("Cache-Control", "no-store");
		return res.redirect(302, `/admin${auth}#/${target}`);
	};
}

/**
 * Versão de cache-busting baseada no mtime do arquivo em public/.
 * Muda somente quando o arquivo muda (deploy), permitindo que o navegador reutilize o cache
 * entre visitas — ao contrário de Date.now(), que forçava novo download a cada acesso.
 * @param {string} relPath - Caminho relativo a public/
 * @returns {Promise<string>}
 */
async function assetVersion(relPath) {
	try {
		const stat = await fs.stat(path.join(PUBLIC_DIR, relPath));
		return Math.floor(stat.mtimeMs).toString(36);
	} catch {
		return Date.now().toString(36);
	}
}

let cachedCemiterio = null;
let lastCemiterioCheck = 0;

function parseDateForSort(val) {
	if (!val) return 0;
	if (typeof val === "number") return val;
	const s = String(val).trim();
	const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
	if (dmy) {
		const t = new Date(
			parseInt(dmy[3], 10),
			parseInt(dmy[2], 10) - 1,
			parseInt(dmy[1], 10)
		).getTime();
		return isNaN(t) ? 0 : t;
	}
	const t = new Date(s).getTime();
	return isNaN(t) ? 0 : t;
}

async function getCemiterioBots() {
	const now = Date.now();
	if (cachedCemiterio && now - lastCemiterioCheck < 15000) {
		return cachedCemiterio;
	}
	try {
		const botsJsonPath = path.join(__dirname, "../../../bots.json");
		const raw = await fs.readFile(botsJsonPath, "utf8");
		const all = JSON.parse(raw) || [];
		cachedCemiterio = all
			.filter((b) => b && b.banido === true && b.enabled === false)
			.map((b) => ({
				id: b.nome,
				nomeExibir: b.nomeExibir || b.nome,
				dataNascimento: b.dataNascimento || null,
				dataMorte: b.dataMorte || null
			}))
			.sort((a, b) => {
				const timeA = parseDateForSort(a.dataMorte);
				const timeB = parseDateForSort(b.dataMorte);
				if (timeB !== timeA) return timeB - timeA;
				return parseDateForSort(b.dataNascimento) - parseDateForSort(a.dataNascimento);
			});
		lastCemiterioCheck = now;
		return cachedCemiterio;
	} catch {
		return cachedCemiterio || [];
	}
}

function registerIndexRoutes(api) {
	const app = api.app;

	api.invalidateCemiterioCache = () => {
		cachedCemiterio = null;
		lastCemiterioCheck = 0;
	};

	// Telas antigas que já viraram área nativa do /admin (ver LEGACY_ADMIN_REDIRECTS). Antes de
	// tudo: as rotas explícitas abaixo e o express.static de public/ também servem essas telas.
	app.use(createLegacyAdminRedirect());

	// Rota para o dashboard clássico legado
	app.get(["/classic", "/legado"], (req, res) => {
		res.sendFile(path.join(__dirname, "../../../public/classic.html"));
	});

	// Redireciona /dashboard e /dashboard.html para o novo /instances moderno
	app.get(["/dashboard", "/dashboard.html"], (req, res) => {
		res.redirect("/instances");
	});

	// Painel moderno de gestão de instâncias
	app.get(["/instances", "/instances.html"], (req, res) => {
		if (api.isAdmin(req)) {
			api.setAdminSessionCookie(res);
		}
		res.sendFile(path.join(__dirname, "../../../public/instances.html"));
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

	// Serve página de Status das Ravenas. Registrada ANTES do express.static para que o
	// alias /status.html também passe por aqui (renovação da sessão de admin e no-cache).
	app.get(["/status", "/status.html"], (req, res) => {
		if (api.isAdmin(req)) {
			api.setAdminSessionCookie(res);
		}
		res.setHeader("Cache-Control", "no-cache");
		res.sendFile(path.join(__dirname, "../../../public/status.html"));
	});

	// Painel de admin unificado (experimental). O HTML fica fora de public/ (em
	// src/BotAPI/views), então só esta rota autenticada o entrega: caminhos codificados como
	// /%61dmin.html ou //admin.html não chegam a ele pelo express.static. Os assets em
	// public/admin/ continuam estáticos (não têm dados). As telas antigas seguem como estão.
	app.get(["/admin", "/admin/", "/admin.html"], api.authenticateBasic, async (req, res) => {
		if (api.isAdmin(req)) {
			api.setAdminSessionCookie(res);
		}
		res.setHeader("Cache-Control", "no-cache");
		try {
			const rawHtml = await fs.readFile(ADMIN_VIEW, "utf-8");
			const [vTokens, vCss, vJs] = await Promise.all([
				assetVersion("admin/tokens.css"),
				assetVersion("admin/admin.css"),
				assetVersion("admin/admin.js")
			]);
			const html = rawHtml
				.replace(/tokens\.css\?v=[^"']+/g, `tokens.css?v=${vTokens}`)
				.replace(/admin\.css\?v=[^"']+/g, `admin.css?v=${vCss}`)
				.replace(/admin\.js\?v=[^"']+/g, `admin.js?v=${vJs}`);
			return res.type("html").send(html);
		} catch {
			return res.sendFile(ADMIN_VIEW);
		}
	});

	// Entrega da interface Desktop OS como homepage principal (/)
	app.use(express.static(path.join(PUBLIC_DIR, "os"), STATIC_OPTIONS));

	// Mantém compatibilidade com a rota /os
	app.use("/os", express.static(path.join(PUBLIC_DIR, "os"), STATIC_OPTIONS));

	// Entrega de arquivos estáticos gerais (HTML revalida; assets com cache de 1 dia, ou 7 com ?v=)
	app.use(express.static(PUBLIC_DIR, STATIC_OPTIONS));

	// Endpoint de verificação de saúde (100% em memória, ultra-rápido)
	app.get("/health", async (req, res) => {
		try {
			const isAdmin = api.isAdmin(req);
			let announcements = [];
			try {
				if (api.database?.getActiveStatusAnnouncements) {
					announcements = await api.database.getActiveStatusAnnouncements();
				}
			} catch (annErr) {
				api.logger.warn("Erro ao buscar avisos de status no /health:", annErr);
			}

			const cemiterio = await getCemiterioBots();

			res.json({
				status: "ok",
				timestamp: Date.now(),
				isAdmin,
				announcements,
				cemiterio,
				bots: api.bots
					.filter((bot) => (!bot.privado || isAdmin) && !bot.useTelegram && !bot.useDiscord)
					.map((bot) => {
						const metrics = bot.loadReport
							? bot.loadReport.getLiveMetrics()
							: { msgsHr: 0, responseTime: { avg: 0, max: 0 } };

						return {
							id: bot.id,
							nomeExibir: bot.nomeExibir || bot.id,
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
							privado: bot.privado ?? false,
							throttle: bot.throttler
								? bot.throttler.getMetrics()
								: { loadPercent: 0, delayMs: 0, queueSize: 0, rateLimit: 0, windowCost: 0 }
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
				cemiterio: [],
				bots: []
			});
		}
	});

	// Endpoint para solicitação ativa de convite via mini app "Quero Uma!"
	const limiter = api.strictLimiter || ((req, res, next) => next());
	app.post("/api/invite", limiter, async (req, res) => {
		try {
			const { link, contato, motivo } = req.body || {};
			if (!link || !contato || !motivo) {
				return res.status(400).json({
					status: "error",
					message: "Todos os campos (link, contato e motivo) são obrigatórios."
				});
			}

			const cleanLink = String(link).trim();
			const cleanContact = String(contato).trim();
			const cleanReason = String(motivo).trim();

			const match = cleanLink.match(/(?:https?:\/\/)?chat\.whatsapp\.com\/([0-9A-Za-z_-]{20,26})/i);
			if (!match) {
				return res.status(400).json({
					status: "error",
					message:
						"Link de grupo do WhatsApp inválido. Formato esperado: https://chat.whatsapp.com/..."
				});
			}
			const inviteCode = match[1];

			if (cleanReason.length < 5) {
				return res.status(400).json({
					status: "error",
					message: "O motivo é muito curto. Por favor, descreva melhor o propósito do seu grupo."
				});
			}

			const cleanPhone = cleanContact.replace(/\D/g, "");
			const formattedContact = cleanPhone ? `${cleanContact} (${cleanPhone})` : cleanContact;

			// 1. Verificação prévia de bloqueio de número do usuário
			if (cleanPhone && api.database && typeof api.database.isUserInviteBlocked === "function") {
				const isUserBlocked = await api.database.isUserInviteBlocked(cleanPhone);
				if (isUserBlocked) {
					api.logger.info(`[BotAPI] Convite recusado pelo site: número ${cleanPhone} bloqueado.`);
					return res.status(403).json({
						status: "blocked",
						blocked: true,
						blockType: "user",
						message:
							"🛑 A RavenaBot não está mais recebendo convites de seu número, pois você foi bloqueado."
					});
				}
			}

			// 2. Verificação prévia de código de convite bloqueado
			if (api.database && typeof api.database.isInviteBlocked === "function") {
				const isCodeBlocked = await api.database.isInviteBlocked(inviteCode, null);
				if (isCodeBlocked) {
					api.logger.info(
						`[BotAPI] Convite recusado pelo site: código de convite ${inviteCode} bloqueado.`
					);
					return res.status(403).json({
						status: "blocked",
						blocked: true,
						blockType: "group",
						message: "🛑 A RavenaBot não recebe mais convite deste grupo, pois ele foi bloqueado."
					});
				}
			}

			// 3. Verificação prévia de JID de grupo bloqueado (via getInviteInfo)
			let inviteInfoData = null;
			const onlineWaBot =
				(api.bots || []).find(
					(b) =>
						!b.useTelegram &&
						!b.useDiscord &&
						b.isConnected &&
						b.client &&
						typeof b.client.getInviteInfo === "function"
				) || (api.bots || []).find((b) => !b.useTelegram && !b.useDiscord && b.isConnected);
			if (
				onlineWaBot &&
				onlineWaBot.client &&
				typeof onlineWaBot.client.getInviteInfo === "function"
			) {
				try {
					inviteInfoData = await onlineWaBot.client.getInviteInfo(inviteCode);
				} catch (e) {
					api.logger.debug(
						`[BotAPI] Não foi possível consultar JID prévio do convite ${inviteCode}: ${e.message}`
					);
				}
			}

			if (
				inviteInfoData?.JID &&
				api.database &&
				typeof api.database.isInviteBlocked === "function"
			) {
				const isJidBlocked = await api.database.isInviteBlocked(null, inviteInfoData.JID);
				if (isJidBlocked) {
					api.logger.info(
						`[BotAPI] Convite recusado pelo site: JID de grupo ${inviteInfoData.JID} bloqueado.`
					);
					return res.status(403).json({
						status: "blocked",
						blocked: true,
						blockType: "group",
						message: "🛑 A RavenaBot não recebe mais convite deste grupo, pois ele foi bloqueado."
					});
				}
			}

			// 4. Roteamento: Enviar exclusivamente OU no Telegram OU no WhatsApp
			const telegramInvitesGroup = process.env.GRUPO_INVITES_TELEGRAM;

			if (telegramInvitesGroup) {
				const TelegramNotificationService = require("../../services/TelegramNotificationService");
				const telegramNotifier = TelegramNotificationService.getInstance({
					bots: api.bots,
					database: api.database
				});

				const tgResult = await telegramNotifier.sendInviteNotification({
					inviteCode,
					cleanPhone,
					formattedContact,
					cleanReason,
					chatId: telegramInvitesGroup
				});

				if (!tgResult || !tgResult.success) {
					api.logger.error(
						`[BotAPI] Falha ao encaminhar convite para o Telegram (${telegramInvitesGroup}): ${tgResult?.error}`
					);
					return res.status(503).json({
						status: "error",
						message:
							"Serviço temporariamente indisponível para entrega da solicitação no canal de moderação. Tente novamente mais tarde."
					});
				}

				api.logger.info(
					`[BotAPI] Convite recebido pelo site encaminhado com sucesso para o Telegram (${telegramInvitesGroup}) com botões interativos (código: ${inviteCode})`
				);

				return res.json({
					status: "ok",
					message:
						"Sua solicitação foi enviada com sucesso! Ela foi encaminhada para a equipe de moderação."
				});
			}

			// Fallback: Envio para WhatsApp priorizando: normais > vips > comunitárias
			const isWhatsApp = (b) => !b.useTelegram && !b.useDiscord && b.isConnected;
			const waBots = (api.bots || []).filter(isWhatsApp);

			const isNormal = (b) => !b.comunitario && !b.vip && !b.privado;
			const isVip = (b) => b.vip || b.id === "ravenavip";
			const isComunitario = (b) => Boolean(b.comunitario);

			const findBotInTier = (filterFn) => {
				const tierBots = waBots.filter(filterFn);
				return tierBots.find((b) => b.grupoInvites) || tierBots[0] || null;
			};

			const onlineBot =
				findBotInTier(isNormal) ||
				findBotInTier(isVip) ||
				findBotInTier(isComunitario) ||
				api.bots.find((b) => b.isConnected && b.grupoInvites) ||
				api.bots.find((b) => b.isConnected);

			const targetGroup =
				onlineBot?.grupoInvites || api.bots.find((b) => b.grupoInvites)?.grupoInvites;

			if (!onlineBot || !targetGroup) {
				api.logger.warn(
					"Tentativa de envio de convite via site, mas nenhum bot conectado ou grupoInvites configurado."
				);
				return res.status(503).json({
					status: "error",
					message:
						"Serviço temporariamente indisponível. Nenhuma instância conectada para entregar o convite. Tente novamente mais tarde."
				});
			}

			const infoMsg =
				`🌐 *[Recebido pelo Site - Quero Uma!]*\n\n` +
				`🔗 *Link:* https://chat.whatsapp.com/${inviteCode}\n` +
				`👤 *Solicitante / Contato:* ${formattedContact}\n` +
				`💬 *Motivo:*\n${cleanReason}\n\n` +
				`🤖 *Entregue por:* ${onlineBot.nomeExibir || onlineBot.id}`;

			await onlineBot.sendMessage(targetGroup, infoMsg);

			// Comandos rápidos para SuperAdmin
			const joinCmd = `!sa-joinGrupo ${inviteCode} ${cleanPhone || "site"} Site`;
			await onlineBot.sendMessage(targetGroup, joinCmd);

			const inspectCmd = `!sa-inviteInfo ${inviteCode}`;
			await onlineBot.sendMessage(targetGroup, inspectCmd);

			if (cleanPhone) {
				const blockCmd = `!sa-blockInvites ${cleanPhone} ${inviteCode}`;
				await onlineBot.sendMessage(targetGroup, blockCmd);
			}

			api.logger.info(
				`[BotAPI] Convite recebido pelo site encaminhado para ${targetGroup} pelo bot ${onlineBot.id} (código: ${inviteCode})`
			);

			return res.json({
				status: "ok",
				message:
					"Sua solicitação foi enviada com sucesso! Ela foi encaminhada para a equipe de moderação."
			});
		} catch (err) {
			api.logger.error("Erro ao processar convite via site:", err);
			return res.status(500).json({
				status: "error",
				message: "Erro interno ao processar sua solicitação."
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
		const providers = api.serviceProviderService.getProviders("kokorotts");
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

	// Página do RavenaBank (HTML e Web App com cache buster ativo)
	const serveBanco = async (req, res) => {
		res.set({
			"Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
			Pragma: "no-cache",
			Expires: "0",
			"Surrogate-Control": "no-store"
		});
		try {
			const htmlPath = path.join(__dirname, "../../../public/banco.html");
			let html = await fs.readFile(htmlPath, "utf-8");
			const [vJs, vCmd, vAjuda] = await Promise.all([
				assetVersion("banco.js"),
				assetVersion("cmd.css"),
				assetVersion("ajuda.css")
			]);
			html = html.replace(/banco\.js\?v=[^"']+/g, `banco.js?v=${vJs}`);
			html = html.replace(/cmd\.css\?v=[^"']+/g, `cmd.css?v=${vCmd}`);
			html = html.replace(/ajuda\.css\?v=[^"']+/g, `ajuda.css?v=${vAjuda}`);
			return res.type("html").send(html);
		} catch (_) {
			return res.sendFile(path.join(__dirname, "../../../public/banco.html"));
		}
	};
	app.get(["/ravenabank", "/banco"], serveBanco);

	// Painel Administrativo do RavenaBank (HTML)
	const serveBancoAdmin = async (req, res) => {
		if (api.isAdmin(req)) {
			api.setAdminSessionCookie(res);
		}
		res.set({
			"Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
			Pragma: "no-cache",
			Expires: "0",
			"Surrogate-Control": "no-store"
		});
		try {
			const htmlPath = path.join(__dirname, "../../../public/banco-admin.html");
			let html = await fs.readFile(htmlPath, "utf-8");
			const [vJs, vCmd, vAjuda] = await Promise.all([
				assetVersion("banco-admin.js"),
				assetVersion("cmd.css"),
				assetVersion("ajuda.css")
			]);
			html = html.replace(/banco-admin\.js\?v=[^"']+/g, `banco-admin.js?v=${vJs}`);
			html = html.replace(/cmd\.css\?v=[^"']+/g, `cmd.css?v=${vCmd}`);
			html = html.replace(/ajuda\.css\?v=[^"']+/g, `ajuda.css?v=${vAjuda}`);
			return res.type("html").send(html);
		} catch (_) {
			return res.sendFile(path.join(__dirname, "../../../public/banco-admin.html"));
		}
	};
	app.get(["/ravenabank/admin", "/banco/admin"], api.authenticateBasic, serveBancoAdmin);

	// Eventos Programados (Público e Admin)
	app.get(["/eventos", "/events"], async (req, res) => {
		try {
			const htmlPath = path.join(__dirname, "../../../public/eventos.html");
			const [rawHtml, vJs] = await Promise.all([
				fs.readFile(htmlPath, "utf-8"),
				assetVersion("eventos.js")
			]);
			const html = rawHtml.replace(/eventos\.js\?v=[^"']+/g, `eventos.js?v=${vJs}`);
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			return res.send(html);
		} catch (err) {
			return res.sendFile(path.join(__dirname, "../../../public/eventos.html"));
		}
	});

	app.get(["/eventos/admin", "/events/admin"], api.authenticateBasic, async (req, res) => {
		if (api.isAdmin(req)) api.setAdminSessionCookie(res);
		try {
			const htmlPath = path.join(__dirname, "../../../public/eventos-admin.html");
			const [rawHtml, vJs] = await Promise.all([
				fs.readFile(htmlPath, "utf-8"),
				assetVersion("eventos-admin.js")
			]);
			const html = rawHtml.replace(/eventos-admin\.js\?v=[^"']+/g, `eventos-admin.js?v=${vJs}`);
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			return res.send(html);
		} catch (err) {
			return res.sendFile(path.join(__dirname, "../../../public/eventos-admin.html"));
		}
	});

	// Página de Dossier dos Grupos (HTML)
	app.get("/groups-dossier", api.authenticateBasic, (req, res) => {
		res.sendFile(path.join(__dirname, "../../../public/groups-dossier.html"));
	});

	// Painel Completo de Dossiês e Inteligência (Grupos & Usuários - RME)
	app.get(["/dossies", "/dossier", "/dossie"], api.authenticateBasic, (req, res) => {
		res.sendFile(path.join(__dirname, "../../../public/dossies.html"));
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

			let mediaBuffer = null;
			let contentType = "application/octet-stream";

			try {
				const storageItem = await storageService.get(fileName, {
					groupId: webManagementData.groupId
				});
				mediaBuffer = storageItem.buffer;
				contentType = storageItem.mimetype || contentType;
			} catch (storageErr) {
				const filePath = path.join(api.database.databasePath, "media", fileName);
				try {
					await fs.access(filePath);
					return res.sendFile(filePath);
				} catch {
					return res.status(404).send("File not found");
				}
			}

			res.setHeader("Content-Type", contentType);
			res.setHeader("Cache-Control", "public, max-age=86400, immutable");
			return res.send(mediaBuffer);
		} catch (error) {
			api.logger.error("Error serving direct media:", error);
			return res.status(500).send("Server error");
		}
	});
}

module.exports = {
	registerIndexRoutes,
	createLegacyAdminRedirect,
	LEGACY_ADMIN_REDIRECTS,
	LEGACY_ADMIN_ALIASES
};
