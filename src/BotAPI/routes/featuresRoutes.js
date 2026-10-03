const path = require("path");
const fs = require("fs").promises;
const axios = require("axios");

// Caches locais para Waifuletes (detalhes de personagens e nomes de grupos)
const waifuDetailsCache = new Map();
const WAIFU_DETAILS_CACHE_TTL = 5 * 60 * 1000;
const waifuGroupCache = new Map();

/**
 * Registra rotas de recursos, jogos e coleções: Waifuletes, Pesca e Analytics
 * Arquivo: src/BotAPI/routes/featuresRoutes.js
 *
 * Rotas registradas:
 * - GET  /api/fishing/legendary              - Histórico e ranking de peixes lendários pescados
 * - GET  /api/fishing/image/:fileName        - Entrega de imagens dos peixes pescados
 * - GET  /api/waifuletes/characters          - Lista personagens do jogo de Waifuletes com filtros e busca
 * - GET  /api/waifuletes/group/:groupId      - Resolução e cache do nome de grupos para o Waifuletes
 * - GET  /api/waifuletes/characters/:id      - Detalhes completos e casamento de um personagem específico
 * - GET  /api/waifuletes/media/*mediaPath    - Proxy de streaming das imagens locais do Waifuletes
 * - GET  /analytics                          - Gráficos analíticos de tráfego de mensagens por período
 *
 * @param {Object} api - Instância da BotAPI
 */
function registerFeaturesRoutes(api) {
	const app = api.app;

	// Fishing API - Histórico de lendários
	app.get("/api/fishing/legendary", async (req, res) => {
		try {
			const rows = await api.database.dbAll(
				"fishing",
				"SELECT * FROM fishing_legendary_history ORDER BY weight DESC;"
			);
			res.json(rows);
		} catch (error) {
			api.logger.error("Erro ao buscar histórico de pesca:", error);
			res.status(500).json({ error: "Erro ao buscar histórico de pesca" });
		}
	});

	// Fishing API - Imagens de peixes
	app.get("/api/fishing/image/:fileName", async (req, res) => {
		const { fileName } = req.params;
		if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
			return res.status(400).send("Nome de arquivo inválido");
		}
		const filePath = path.join(api.database.databasePath, "media", fileName);
		try {
			await fs.access(filePath);
			res.setHeader("Cache-Control", "public, max-age=86400, immutable");
			res.sendFile(filePath);
		} catch {
			res.status(404).send("Imagem não encontrada");
		}
	});

	// Waifuletes API - Lista de personagens
	app.get("/api/waifuletes/characters", api.generalLimiter, async (req, res) => {
		const waifuletesUrl = process.env.WAIFULETES_API_URL || "http://host.docker.internal:3030";
		const waifuletesKey = process.env.WAIFULETES_API_KEY;

		if (!waifuletesKey) {
			return res
				.status(503)
				.json({ success: false, error: "Serviço Waifuletes não configurado no servidor." });
		}

		try {
			const { search, gender, rarity, page, limit, sortBy, order, maritalStatus, status } =
				req.query;
			const params = {};
			if (search) params.search = search.toString().trim();
			if (gender) params.gender = gender.toString().trim();
			if (rarity) params.rarity = rarity.toString().trim();
			const rawStatus = maritalStatus || status;
			if (
				rawStatus &&
				["single", "married", "all"].includes(rawStatus.toString().toLowerCase().trim())
			) {
				params.maritalStatus = rawStatus.toString().toLowerCase().trim();
			}
			if (page) params.page = parseInt(page, 10) || 1;
			if (limit) params.limit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

			const response = await axios.get(`${waifuletesUrl}/characters`, {
				params,
				headers: {
					Authorization: `Bearer ${waifuletesKey}`,
					"Content-Type": "application/json"
				},
				timeout: 10000
			});

			const resultData = response.data?.data;
			if (!resultData) {
				return res.json(response.data);
			}

			if (Array.isArray(resultData.data)) {
				resultData.data = resultData.data.map((c) => {
					let img = c.imageUrl;
					if (
						img &&
						(img.startsWith("/") ||
							img.includes("localhost:") ||
							img.includes("host.docker.internal:"))
					) {
						const pathPart = img.replace(/^https?:\/\/[^/]+/, "");
						const cleanPath = pathPart.startsWith("/media/")
							? pathPart.slice(7)
							: pathPart.startsWith("/")
								? pathPart.slice(1)
								: pathPart;
						img = `/api/waifuletes/media/${cleanPath}`;
					}
					return { ...c, imageUrl: img };
				});

				await Promise.all(
					resultData.data.map(async (c) => {
						let details = null;
						const now = Date.now();
						const cached = waifuDetailsCache.get(c.id);
						if (cached && now - cached.timestamp < WAIFU_DETAILS_CACHE_TTL) {
							details = cached.data;
						} else {
							try {
								const detailRes = await axios.get(
									`${waifuletesUrl}/characters/${encodeURIComponent(c.id)}`,
									{
										headers: {
											Authorization: `Bearer ${waifuletesKey}`,
											"Content-Type": "application/json"
										},
										timeout: 5000
									}
								);
								if (detailRes.data?.data) {
									details = detailRes.data.data;
									waifuDetailsCache.set(c.id, { timestamp: now, data: details });
									if (waifuDetailsCache.size > 2000) {
										const oldestKey = waifuDetailsCache.keys().next().value;
										waifuDetailsCache.delete(oldestKey);
									}
								}
							} catch {
								/* Silencioso */
							}
						}

						const haremEntry = details?.haremEntries?.[0] || c.haremEntries?.[0];
						const owner = details?.owner || c.owner || haremEntry?.user;
						const groupId =
							haremEntry?.claimedInGroup || details?.claimedInGroup || c.claimedInGroup;
						let marriage = null;
						if (haremEntry || (owner && groupId)) {
							const spouse = haremEntry?.user?.name || owner?.name || "Jogador";
							let groupName = "Grupo";
							if (groupId) {
								const cachedGroupName = waifuGroupCache.get(groupId);
								if (cachedGroupName) {
									groupName = cachedGroupName;
								} else {
									try {
										const g = await api.database.getGroup(groupId);
										groupName = g?.titulo || g?.name || `Grupo ${groupId.replace(/@.*$/, "")}`;
										waifuGroupCache.set(groupId, groupName);
									} catch {
										groupName = `Grupo ${groupId.replace(/@.*$/, "")}`;
									}
								}
							}
							marriage = {
								spouse,
								groupId,
								groupName
							};
						}

						c.isClaimed = !!haremEntry || details?.isClaimed || c.isClaimed || false;
						c.wishlistCount =
							details?._count?.wishlists ?? c._count?.wishlists ?? c.wishlistCount ?? 0;
						c.marriage = marriage;
					})
				);

				if (sortBy === "name") {
					const isDesc = order === "desc";
					resultData.data.sort((a, b) => {
						const comp = (a.name || "").localeCompare(b.name || "", "pt-BR", {
							sensitivity: "base"
						});
						return isDesc ? -comp : comp;
					});
				}
			}

			res.json({ success: true, data: resultData });
		} catch (error) {
			api.logger.error("Erro ao consultar personagens do Waifuletes:", error.message);
			const status = error.response?.status || 500;
			const message =
				error.response?.data?.message || error.message || "Erro ao consultar personagens.";
			res.status(status).json({ success: false, error: message });
		}
	});

	// Waifuletes Group Name Resolution
	app.get(["/api/waifuletes/group/:groupId", "/api/waifuletes/group"], async (req, res) => {
		try {
			const groupId = req.params.groupId || req.query.id;
			if (!groupId) {
				return res.status(400).json({ success: false, error: "ID do grupo não informado" });
			}
			let name = waifuGroupCache.get(groupId);
			if (!name) {
				const g = await api.database.getGroup(groupId);
				name = g?.titulo || g?.name || `Grupo ${groupId.replace(/@.*$/, "")}`;
				waifuGroupCache.set(groupId, name);
			}
			res.json({ success: true, id: groupId, name });
		} catch (err) {
			res.status(500).json({ success: false, error: err.message });
		}
	});

	// Waifuletes Single Character Detail Proxy
	app.get("/api/waifuletes/characters/:id", async (req, res) => {
		const waifuletesUrl = process.env.WAIFULETES_API_URL || "http://host.docker.internal:3030";
		const waifuletesKey = process.env.WAIFULETES_API_KEY;

		if (!waifuletesKey) {
			return res
				.status(503)
				.json({ success: false, error: "Serviço Waifuletes não configurado no servidor." });
		}

		const { id } = req.params;

		try {
			const response = await axios.get(`${waifuletesUrl}/characters/${encodeURIComponent(id)}`, {
				headers: {
					Authorization: `Bearer ${waifuletesKey}`,
					"Content-Type": "application/json"
				},
				timeout: 5000
			});
			const charData = response.data?.data;
			if (charData) {
				const haremEntry = charData.haremEntries?.[0];
				const owner = charData.owner || haremEntry?.user;
				const groupId = haremEntry?.claimedInGroup || charData.claimedInGroup;
				let marriage = null;
				if (haremEntry || (owner && groupId)) {
					const spouse = haremEntry?.user?.name || owner?.name || "Jogador";
					let groupName = "Grupo";
					if (groupId) {
						let name = waifuGroupCache.get(groupId);
						if (!name) {
							const g = await api.database.getGroup(groupId);
							name = g?.titulo || g?.name || `Grupo ${groupId.replace(/@.*$/, "")}`;
							waifuGroupCache.set(groupId, name);
						}
						groupName = name;
					}
					marriage = {
						spouse,
						groupId,
						groupName
					};
				}
				charData.isClaimed = !!haremEntry || charData.isClaimed || false;
				charData.wishlistCount = charData._count?.wishlists || 0;
				charData.marriage = marriage;
			}
			res.json(response.data);
		} catch (err) {
			const status = err.response?.status || 500;
			res.status(status).json({ success: false, error: err.message });
		}
	});

	// Proxy de Mídia do Waifuletes
	app.get("/api/waifuletes/media/*mediaPath", async (req, res) => {
		const waifuletesUrl = process.env.WAIFULETES_API_URL || "http://host.docker.internal:3030";
		const rawPath = req.params.mediaPath;
		const mediaPath = Array.isArray(rawPath) ? rawPath.join("/") : rawPath;
		if (!mediaPath || mediaPath.includes("..")) {
			return res.status(400).send("Caminho de mídia inválido");
		}

		try {
			const targetUrl = `${waifuletesUrl}/media/${mediaPath}`;
			const response = await axios({
				method: "get",
				url: targetUrl,
				responseType: "stream",
				timeout: 10000
			});

			res.setHeader("Content-Type", response.headers["content-type"] || "image/jpeg");
			res.setHeader("Cache-Control", "public, max-age=86400");
			response.data.pipe(res);
		} catch {
			res.status(404).send("Imagem não encontrada");
		}
	});

	// Endpoint para obter dados analíticos
	app.get("/analytics", api.generalLimiter, (req, res) => {
		try {
			const period = req.query.period ?? "today";
			let selectedBots = req.query["bots[]"];

			if (!Array.isArray(selectedBots)) {
				selectedBots = selectedBots ? [selectedBots] : [];
			}

			if (selectedBots.length === 0) {
				selectedBots = Object.keys(api.analyticsCache.daily);
			}

			const now = Date.now();
			if (api.analyticsCache.lastUpdate > 0) {
				res.json(api.filterAnalyticsData(period, selectedBots));

				if (
					now - api.analyticsCache.lastUpdate > api.analyticsCache.cacheTime &&
					!api.isUpdatingAnalytics
				) {
					api.updateAnalyticsCache().catch((error) => {
						api.logger.error("Erro ao atualizar cache analítico em background:", error);
					});
				}
				return;
			}

			api
				.updateAnalyticsCache()
				.then(() => {
					res.json(api.filterAnalyticsData(period, selectedBots));
				})
				.catch((error) => {
					api.logger.error("Erro ao atualizar cache para análise:", error);
					res.status(500).json({
						status: "error",
						message: "Erro ao processar dados analíticos"
					});
				});
		} catch (error) {
			api.logger.error("Erro no endpoint de análise:", error);
			res.status(500).json({
				status: "error",
				message: "Erro interno do servidor"
			});
		}
	});
}

module.exports = { registerFeaturesRoutes };
