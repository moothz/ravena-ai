const path = require("path");
const fs = require("fs").promises;
const axios = require("axios");
const FishingGame = require("../../functions/FishingGame");
const ShadowGardenClient = require("../../services/ShadowGardenClient");
const bankService = require("../../services/BankService");
const { getMarriagePhoto } = require("../../utils/WaifuMarriagePhotoHelper");
const jardimClient = new ShadowGardenClient();

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
 * - GET  /api/waifuletes/marriage-photo/:characterId - Streaming de fotos de casamento geradas
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

	// Streaming de foto de casamento gerada
	app.get("/api/waifuletes/marriage-photo/:characterId", async (req, res) => {
		const { characterId } = req.params;
		if (
			!characterId ||
			typeof characterId !== "string" ||
			characterId.includes("..") ||
			characterId.includes("/") ||
			characterId.includes("\\")
		) {
			return res.status(400).send("ID de personagem inválido");
		}

		try {
			const photo = await getMarriagePhoto(characterId);
			if (!photo || !photo.exists) {
				return res.status(404).send("Foto de casamento não encontrada");
			}

			res.setHeader("Content-Type", "image/jpeg");
			res.setHeader("Cache-Control", "public, max-age=3600");

			if (photo.buffer) {
				return res.send(photo.buffer);
			} else if (photo.photoPath) {
				return res.sendFile(photo.photoPath);
			}

			return res.status(404).send("Foto de casamento não encontrada");
		} catch (error) {
			api.logger.error("Erro ao entregar foto de casamento:", error);
			return res.status(500).send("Erro interno ao buscar foto de casamento");
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

	// Endpoint de Inventário ao Vivo para o Mercado de Classificados
	app.get("/api/market/user-inventory/:userId", async (req, res) => {
		try {
			const { userId } = req.params;
			if (!userId) {
				return res.status(400).json({ success: false, error: "userId obrigatório" });
			}

			const cleanUser = String(userId).replace(/\D/g, "") || String(userId);

			// 1. Runas e Cotações do Banco
			let runas = 0;
			let rates = { runasPerZinthos: 0.2857, runasPerJardimCoin: 0.125 };
			try {
				const account = await bankService.getAccount(cleanUser);
				runas = account?.runas || 0;
				const bankRates = await bankService.getRates();
				if (bankRates) {
					rates = {
						runasPerZinthos: bankRates.runasPerZinthos,
						runasPerJardimCoin: bankRates.runasPerJardimCoin
					};
				}
			} catch (bankErr) {
				api.logger.warn(`Erro ao carregar saldo de Runas/taxas para ${userId}: ${bankErr.message}`);
			}

			// 2. Buffs de Pesca Permanentes (com normalização de JID)
			let fishingBuffs = [];
			try {
				const userIds = typeof FishingGame.getAllFishingUserIds === "function"
					? FishingGame.getAllFishingUserIds(userId)
					: [userId, cleanUser, `${cleanUser}@c.us`, `${cleanUser}:54@c.us`];
				const placeholders = userIds.map(() => "?").join(",");

				const rows = await api.database.dbAll(
					"fishing",
					`SELECT id, effect_type as type, original_name as originalName, remaining_uses as remainingUses, description 
					 FROM fishing_buffs 
					 WHERE user_id IN (${placeholders}) 
					   AND is_debuff = 0 
					   AND effect_type IN ('inventory_slot', 'max_baits')
					 ORDER BY id ASC`,
					userIds
				);

				fishingBuffs = (rows || []).map((r) => ({
					id: r.id,
					type: r.type,
					originalName: r.originalName || (r.type === 'inventory_slot' ? 'Slot de Inventário' : 'Iscas Extras'),
					remainingUses: r.remainingUses,
					description: r.description || ''
				}));
			} catch (fishErr) {
				api.logger.warn(`Erro ao buscar buffs de pesca para ${userId}: ${fishErr.message}`);
			}

			// 3. Fazenda (Jardim das Sombras) - Moeda (Petalitas) + Consumíveis / Decorações
			let farm = null;
			let farmUnavailable = false;
			try {
				const [statusRes, invRes] = await Promise.all([
					jardimClient.getStatus(cleanUser),
					jardimClient.getInventory(cleanUser)
				]);

				const coins = Number(statusRes?.coins || 0);
				const rawItems = Array.isArray(invRes?.items) ? invRes.items : [];

				// Filtra apenas consumíveis e decorações
				const filteredItems = rawItems
					.filter((it) => it.type === "consumable" || it.type === "decoration")
					.map((it) => ({
						itemId: it.itemId,
						name: it.name || it.itemId,
						type: it.type,
						quantity: Number(it.quantity) || 1
					}));

				farm = {
					coins,
					items: filteredItems
				};
			} catch (farmErr) {
				api.logger.warn(`Jardim indisponível para consulta de inventário de ${userId}: ${farmErr.message}`);
				farmUnavailable = true;
			}

			return res.json({
				success: true,
				runas,
				rates,
				fishingBuffs,
				farm,
				farmUnavailable
			});
		} catch (error) {
			api.logger.error("Erro geral no endpoint /api/market/user-inventory/:userId:", error);
			return res.status(500).json({ success: false, error: "Erro interno ao buscar inventário" });
		}
	});

	// Transferência de Itens do Mercado (Runas, Buffs & Fazenda com Rollback Atômico)
	app.post("/api/market/transfer", async (req, res) => {
		try {
			const {
				fromUserId,
				toUserId,
				runas = 0,
				fishingBuffIds = [],
				buffs = [],
				farmItems = [],
				petalitas = 0
			} = req.body;

			if (!fromUserId || !toUserId) {
				return res
					.status(400)
					.json({ success: false, reason: "fromUserId e toUserId são obrigatórios" });
			}

			const cleanFrom = String(fromUserId).replace(/\D/g, "") || String(fromUserId);
			const cleanTo = String(toUserId).replace(/\D/g, "") || String(toUserId);

			const runasAmount = Number(runas) || 0;
			const petalitasAmount = Number(petalitas) || 0;

			// Coleta lista de IDs de buffs (compatível com fishingBuffIds e buffs [{id}])
			const targetBuffIds = (Array.isArray(fishingBuffIds) && fishingBuffIds.length > 0)
				? fishingBuffIds.map(b => typeof b === "object" ? b.id : Number(b)).filter(Boolean)
				: (Array.isArray(buffs) && buffs.length > 0)
					? buffs.map(b => typeof b === "object" ? b.id : Number(b)).filter(Boolean)
					: [];

			// JIDs normalizados para checagem de pesca
			const fromUserIds = typeof FishingGame.getAllFishingUserIds === "function"
				? FishingGame.getAllFishingUserIds(fromUserId)
				: [fromUserId, cleanFrom, `${cleanFrom}@c.us`, `${cleanFrom}:54@c.us`];

			// ==========================================
			// 1. PRÉ-VALIDAÇÃO ESTREITA (NENHUM WRITE ANTES)
			// ==========================================

			// 1.1. Valida Runas
			if (runasAmount > 0) {
				const fromAccount = await bankService.getAccount(cleanFrom);
				if (!fromAccount || fromAccount.runas < runasAmount) {
					return res.status(400).json({
						success: false,
						reason: `Saldo insuficiente de Runas do ofertante (${fromAccount?.runas || 0} / ${runasAmount} ᚱ).`
					});
				}
			}

			// 1.2. Valida Buffs no SQLite
			if (targetBuffIds.length > 0) {
				const placeholders = fromUserIds.map(() => "?").join(",");
				for (const buffId of targetBuffIds) {
					const row = await api.database.dbGet(
						"fishing",
						`SELECT id, effect_type FROM fishing_buffs WHERE id = ? AND user_id IN (${placeholders})`,
						[buffId, ...fromUserIds]
					);
					if (!row) {
						return res.status(400).json({
							success: false,
							reason: `Buff de pesca (ID: ${buffId}) não encontrado no inventário do ofertante.`
						});
					}
				}
			}

			// 1.3. Valida Farm (Petalitas e Itens) no Jardim
			if (petalitasAmount > 0 || (Array.isArray(farmItems) && farmItems.length > 0)) {
				try {
					if (petalitasAmount > 0) {
						const status = await jardimClient.getStatus(cleanFrom);
						if (!status || Number(status.coins || 0) < petalitasAmount) {
							return res.status(400).json({
								success: false,
								reason: `Saldo insuficiente de Petalitas do ofertante (${status?.coins || 0} / ${petalitasAmount}).`
							});
						}
					}

					if (Array.isArray(farmItems) && farmItems.length > 0) {
						const inv = await jardimClient.getInventory(cleanFrom);
						const itemsMap = new Map((inv?.items || []).map(it => [it.itemId, Number(it.quantity) || 0]));
						for (const reqItem of farmItems) {
							const currentQty = itemsMap.get(reqItem.itemId) || 0;
							const needQty = Number(reqItem.amount || reqItem.quantity) || 1;
							if (currentQty < needQty) {
								return res.status(400).json({
									success: false,
									reason: `Item da fazenda insuficiente (${reqItem.name || reqItem.itemId}: possui ${currentQty}, requer ${needQty}).`
								});
							}
						}
					}
				} catch (farmValErr) {
					return res.status(400).json({
						success: false,
						reason: `Falha ao validar inventário do Jardim das Sombras: ${farmValErr.message}`
					});
				}
			}

			// ==========================================
			// 2. EXECUÇÃO COM SUPORTE A COMPENSAÇÃO/ROLLBACK
			// ==========================================

			let runasTransferred = false;
			let buffsTransferred = [];
			let farmTransferred = false;

			try {
				// 2.1. Transfere Runas
				if (runasAmount > 0) {
					await bankService.transferRunas(cleanFrom, cleanTo, runasAmount, "MARKET_OFFER_ACCEPTED");
					runasTransferred = true;
				}

				// 2.2. Transfere Buffs
				if (targetBuffIds.length > 0) {
					for (const buffId of targetBuffIds) {
						await FishingGame.transferBuff(fromUserId, toUserId, buffId);
						buffsTransferred.push(buffId);
					}
				}

				// 2.3. Transfere Fazenda (Petalitas + Itens)
				if (petalitasAmount > 0 || (Array.isArray(farmItems) && farmItems.length > 0)) {
					const itemsToTransfer = (farmItems || []).map(it => ({
						itemId: it.itemId,
						amount: Number(it.amount || it.quantity) || 1
					}));
					await jardimClient.transferItems(cleanFrom, cleanTo, itemsToTransfer, petalitasAmount);
					farmTransferred = true;
				}

				return res.json({
					success: true,
					runas: runasAmount,
					buffsCount: targetBuffIds.length,
					farmTransferred
				});
			} catch (execErr) {
				api.logger.error("Erro durante execução da transferência de mercado, iniciando reversão:", execErr);

				// REVERSÃO CASO ALGUM PASSO POSTERIOR TENHA FALHADO
				if (buffsTransferred.length > 0) {
					for (const buffId of buffsTransferred) {
						try {
							await FishingGame.transferBuff(toUserId, fromUserId, buffId);
						} catch (revBuffErr) {
							api.logger.error(`Falha crítica ao reverter buff ${buffId}: ${revBuffErr.message}`);
						}
					}
				}

				if (runasTransferred) {
					try {
						await bankService.transferRunas(cleanTo, cleanFrom, runasAmount, "MARKET_TRANSFER_ROLLBACK");
					} catch (revRunasErr) {
						api.logger.error(`Falha crítica ao reverter Runas (${runasAmount}): ${revRunasErr.message}`);
					}
				}

				return res.status(500).json({
					success: false,
					reason: `Erro na transferência de itens externos: ${execErr.message}. Alterações prévias foram revertidas.`
				});
			}
		} catch (error) {
			api.logger.error("Erro geral na rota /api/market/transfer:", error);
			return res
				.status(500)
				.json({ success: false, reason: error.message || "Erro interno de transferência" });
		}
	});
}

module.exports = { registerFeaturesRoutes };
