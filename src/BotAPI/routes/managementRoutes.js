const path = require("path");
const fs = require("fs").promises;
const { spawn } = require("child_process");
const { upload } = require("../middleware/upload");
const GrupoAgendamentos = require("../../commands/modules/GrupoAgendamentos");
const { validateRegexFilter } = require("../../utils/RegexFilterValidator");

/**
 * Registra rotas de gerenciamento de grupos, comandos personalizados, agendamentos e dossiês
 * Arquivo: src/BotAPI/routes/managementRoutes.js
 *
 * Rotas registradas:
 * - GET    /api/validate-token                       - Valida o token de gerenciamento web
 * - GET    /api/group-dossier-history                - Histórico recente de dossiês de um grupo
 * - GET    /api/groups-dossier                       - Status e média de dossiê de todos os grupos
 * - GET    /api/group                                - Dados completos de configuração de um grupo
 * - POST   /api/update-group                         - Atualiza parâmetros e regras de um grupo
 * - POST   /api/upload-media                         - Upload de mídia (áudio/vídeo/imagem) para o grupo
 * - GET    /api/custom-commands/:groupId             - Lista comandos personalizados do grupo
 * - POST   /api/custom-commands/:groupId             - Cria um novo comando personalizado
 * - PUT    /api/custom-commands/:groupId/:trigger    - Atualiza comando personalizado existente
 * - DELETE /api/custom-commands/:groupId/:trigger    - Remove/desativa comando personalizado
 * - GET    /api/custom-commands/:groupId/export-zip  - Exporta comandos e mídias em arquivo ZIP
 * - POST   /api/custom-commands/:groupId/import-zip  - Importa comandos e mídias a partir de arquivo ZIP
 * - POST   /api/group/check-import-name              - Verifica disponibilidade do nome do grupo
 * - GET    /api/group-schedules/:groupId             - Lista agendamentos (abrir/fechar grupo)
 * - POST   /api/group-schedules/:groupId             - Cria um novo agendamento para o grupo
 * - DELETE /api/group-schedules/:groupId/:id         - Remove um agendamento do grupo
 *
 * @param {Object} api - Instância da BotAPI
 */
function registerManagementRoutes(api) {
	const app = api.app;

	// Helper para recarregar comandos personalizados na memória dos bots
	const reloadGroupCommands = async (groupId) => {
		for (const bot of api.bots) {
			if (bot.eventHandler && bot.eventHandler.commandHandler) {
				await bot.eventHandler.commandHandler.loadCustomCommandsForGroup(groupId).catch(() => {});
			}
		}
	};

	// Helper para verificar limites de grupo (armazenamento, comandos, streams)
	const checkGroupLimits = async (groupId, checkType, data = null) => {
		const MAX_STORAGE = (parseInt(process.env.LIMIT_STORAGE_MB, 10) || 1024) * 1024 * 1024;
		const MAX_COMMANDS = parseInt(process.env.LIMIT_COMMANDS, 10) || 100;
		const MAX_STREAMS = parseInt(process.env.LIMIT_STREAMS, 10) || 20;

		if (checkType === "storage") {
			let totalSize = 0;
			const groupData = await api.database.getGroup(groupId);
			const commands = await api.database.getCustomCommands(groupId);
			const mediaPath = path.join(api.database.databasePath, "media");

			const addFileSize = async (filename) => {
				if (!filename) return;
				try {
					const stats = await fs.stat(path.join(mediaPath, filename));
					totalSize += stats.size;
				} catch {
					/* ignore missing files */
				}
			};

			const scanMediaObj = async (obj) => {
				if (!obj) return;
				for (const val of Object.values(obj)) {
					if (val && val.file) await addFileSize(val.file);
				}
			};

			if (groupData) {
				await scanMediaObj(groupData.greetings);
				await scanMediaObj(groupData.farewells);

				["twitch", "kick", "youtube"].forEach((platform) => {
					if (groupData[platform]) {
						groupData[platform].forEach((stream) => {
							if (stream.videoConfig?.media) {
								stream.videoConfig.media.forEach((m) => {
									if (m.type !== "text") addFileSize(m.content);
								});
							}
							if (stream.onConfig?.media) {
								stream.onConfig.media.forEach((m) => {
									if (m.type !== "text") addFileSize(m.content);
								});
							}
							if (stream.offConfig?.media) {
								stream.offConfig.media.forEach((m) => {
									if (m.type !== "text") addFileSize(m.content);
								});
							}
						});
					}
				});
			}

			if (commands) {
				for (const cmd of commands) {
					if (cmd.responses) {
						for (const resp of cmd.responses) {
							if (resp.startsWith("{") && resp.includes("-")) {
								const end = resp.indexOf("}");
								if (end > 1) {
									const firstDash = resp.indexOf("-");
									const filename = resp.substring(firstDash + 1, end);
									await addFileSize(filename);
								}
							}
						}
					}
				}
			}

			if (data && data.fileSize) {
				totalSize += data.fileSize;
			}

			if (totalSize > MAX_STORAGE) {
				throw new Error(
					`Limite de armazenamento excedido (1GB). Uso atual: ${(totalSize / 1024 / 1024).toFixed(2)} MB`
				);
			}
		}

		if (checkType === "commands") {
			const commands = await api.database.getCustomCommands(groupId);
			if (commands && commands.length >= MAX_COMMANDS) {
				if (data && data.isNew) {
					throw new Error(`Limite de comandos excedido (${MAX_COMMANDS}).`);
				}
			}
		}

		if (checkType === "streams") {
			if (data && data.groupData) {
				const g = data.groupData;
				let totalStreams = 0;
				totalStreams += (g.twitch || []).length;
				totalStreams += (g.kick || []).length;
				totalStreams += (g.youtube || []).length;

				if (totalStreams > MAX_STREAMS) {
					throw new Error(`Limite de streams excedido (${MAX_STREAMS}).`);
				}
			}
		}
	};

	// Validação de token de gerenciamento web
	app.get("/api/validate-token", async (req, res) => {
		const token = req.query.token;
		if (!token) {
			return res.status(400).json({ valid: false, message: "Token not provided" });
		}

		try {
			const webManagementData = await api.readWebManagementToken(token);
			if (!webManagementData) {
				return res.status(401).json({ valid: false, message: "Invalid token" });
			}

			const expiresAt = new Date(webManagementData.expiresAt);
			const now = new Date();

			if (now > expiresAt) {
				return res.status(401).json({ valid: false, message: "Token expired" });
			}

			return res.json({
				valid: true,
				requestNumber: webManagementData.requestNumber,
				authorName: webManagementData.authorName,
				groupId: webManagementData.groupId,
				groupName: webManagementData.groupName,
				expiresAt: webManagementData.expiresAt
			});
		} catch (error) {
			api.logger.error("Error validating token:", error);
			return res.status(500).json({ valid: false, message: "Server error" });
		}
	});

	// Histórico de dossiês de um grupo específico
	app.get("/api/group-dossier-history", async (req, res) => {
		const { groupId, token } = req.query;

		if (!groupId || !token) {
			return res.status(400).json({ message: "Missing required parameters" });
		}

		try {
			const webManagementData = await api.readWebManagementToken(token);
			if (!webManagementData || webManagementData.groupId !== groupId) {
				return res.status(401).json({ message: "Unauthorized" });
			}

			if (new Date() > new Date(webManagementData.expiresAt)) {
				return res.status(401).json({ message: "Token expired" });
			}

			const historyList = await api.database.dbAll(
				"summaries",
				"SELECT dossier_json, created_at FROM group_dossiers WHERE group_id = ? ORDER BY created_at DESC LIMIT 15",
				[groupId]
			);

			const parsedHistory = historyList.map((h) => {
				let dossier = {};
				try {
					dossier = JSON.parse(h.dossier_json);
				} catch {
					// Ignora
				}
				return {
					...dossier,
					created_at: h.created_at
				};
			});

			res.json(parsedHistory);
		} catch (error) {
			api.logger.error("Error fetching group dossier history:", error);
			res.status(500).json({ message: "Internal server error" });
		}
	});

	// Endpoint para Dossier dos Grupos (API)
	app.get("/api/groups-dossier", api.authenticateBasic, api.strictLimiter, async (req, res) => {
		try {
			const statusList = await api.database.dbAll(
				"summaries",
				"SELECT group_id, total_length_recorded, pending_text FROM group_dossier_status"
			);

			const historyList = await api.database.dbAll(
				"summaries",
				"SELECT group_id, dossier_json, created_at FROM group_dossiers ORDER BY created_at DESC"
			);

			const allGroupsData = await api.database.getGroups();
			const groupNames = {};
			const groupBots = {};
			allGroupsData.forEach((g) => {
				groupNames[g.id] = g.name;
				groupBots[g.id] = g.botId || "-";
			});

			const historyMap = {};
			historyList.forEach((h) => {
				if (!historyMap[h.group_id]) historyMap[h.group_id] = [];
				let parsedDossier = null;
				try {
					parsedDossier = JSON.parse(h.dossier_json);
				} catch {
					// Ignorar erro
				}
				if (parsedDossier) {
					historyMap[h.group_id].push({
						...parsedDossier,
						created_at: h.created_at
					});
				}
			});

			const result = statusList.map((s) => {
				const history = historyMap[s.group_id] || [];
				const latestDossier = history[0] || {
					type: "-",
					summary: "Nenhuma análise feita ainda.",
					problematic_score: 0
				};

				const scores = history.map((h) => h.problematic_score);
				const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

				return {
					id: s.group_id,
					name: groupNames[s.group_id] || "Grupo Desconhecido",
					bot_id: groupBots[s.group_id] || "-",
					type: latestDossier.type,
					summary: latestDossier.summary,
					problematic_score: latestDossier.problematic_score,
					avg_score: avgScore,
					total_chars: s.total_length_recorded,
					pending_chars: s.pending_text ? s.pending_text.length : 0,
					hasDossier: history.length > 0,
					history
				};
			});

			const filteredResult = result.filter((r) => r.hasDossier);
			filteredResult.sort((a, b) => b.avg_score - a.avg_score);

			res.json(filteredResult);
		} catch (error) {
			api.logger.error("Erro ao buscar dossiês dos grupos:", error);
			res.status(500).json({ status: "error", message: "Erro interno ao buscar dossiês" });
		}
	});

	// Dados de configuração de um grupo
	app.get("/api/group", async (req, res) => {
		const { id, token } = req.query;

		if (!id || !token) {
			return res.status(400).json({ message: "Missing required parameters" });
		}

		try {
			const webManagementData = await api.readWebManagementToken(token);
			if (!webManagementData || webManagementData.groupId !== id) {
				return res.status(401).json({ message: "Unauthorized" });
			}

			if (new Date() > new Date(webManagementData.expiresAt)) {
				return res.status(401).json({ message: "Token expired" });
			}

			const groupData = await api.database.getGroup(id);
			if (!groupData) {
				return res.status(404).json({ message: "Group not found" });
			}

			let participants = [];
			try {
				let bot = api.bots.find((b) => b.id === webManagementData.botId && b.isConnected);
				if (!bot) {
					bot = api.bots.find((b) => b.isConnected);
				}

				if (bot) {
					const chat = await bot.client.getChatById(id);
					if (chat && chat.participants) {
						participants = chat.participants.map((p) => {
							const pn =
								p.phoneNumber || (p.id?._serialized ? p.id._serialized.split("@")[0] : "0000");
							const lid = p.lid || (p.id?._serialized ? p.id._serialized : "");
							const name = `Membro ${pn.slice(-4)}`;

							return {
								lid,
								pn,
								name,
								admin: p.isAdmin || p.isSuperAdmin
							};
						});
					}
				}
			} catch (e) {
				api.logger.error("Error fetching participants:", e);
			}
			groupData.participants = participants;

			try {
				const followedChannels = await api.database.dbAll(
					"canais",
					"SELECT canal_jid, apelido, apelido_normalizado FROM canal_grupos WHERE group_id = ?",
					[id]
				);
				groupData.followedChannels = followedChannels || [];
			} catch (e) {
				api.logger.error("Error fetching followed channels for group management:", e);
				groupData.followedChannels = [];
			}

			api.logger.info(`[management][${token}][${id}] Group ${groupData.name}`);
			return res.json(groupData);
		} catch (error) {
			api.logger.error("Error getting group data:", error);
			return res.status(500).json({ message: "Server error" });
		}
	});

	// Atualização dos parâmetros do grupo
	app.post("/api/update-group", api.strictLimiter, async (req, res) => {
		const { token, groupId, changes } = req.body;

		if (!token || !groupId || !changes) {
			return res.status(400).json({ success: false, message: "Missing required parameters" });
		}

		try {
			const webManagementData = await api.readWebManagementToken(token);
			if (!webManagementData || webManagementData.groupId !== groupId) {
				return res.status(401).json({ success: false, message: "Unauthorized" });
			}

			if (new Date() > new Date(webManagementData.expiresAt)) {
				return res.status(401).json({ success: false, message: "Token expired" });
			}

			const groupData = await api.database.getGroup(groupId);
			if (!groupData) {
				return res.status(404).json({ success: false, message: "Group not found" });
			}

			if (changes.name) {
				changes.name = changes.name.trim().toLowerCase();
				if (!/^[a-zA-Z0-9_\-.]{1,30}$/.test(changes.name)) {
					return res.status(400).json({
						success: false,
						message: `O nome do grupo deve conter apenas letras, números, _, - e ., sem espaços, com no máximo 30 caracteres.`
					});
				}
				const existingGroup = await api.database.getGroupByName(changes.name);
				if (existingGroup && existingGroup.id !== groupId) {
					return res.status(400).json({
						success: false,
						message: `O nome "${changes.name}" já está em uso por outro grupo. Escolha um nome diferente.`
					});
				}
			}

			if (changes.prefix && changes.prefix.length > 1) {
				return res.status(400).json({
					success: false,
					message: "O prefixo deve ter no máximo 1 caractere."
				});
			}

			await checkGroupLimits(groupId, "streams", { groupData: changes });

			if (changes.autoTranslateTo) {
				const SUPPORTED_LANGUAGES = [
					"English (EN)",
					"Spanish (ES)",
					"Russian (RU)",
					"French (FR)",
					"German (DE)",
					"Italian (IT)",
					"Japanese (JA)",
					"Chinese (ZH)",
					"Korean (KO)",
					"Arabic (AR)",
					"Hindi (HI)",
					"Turkish (TR)",
					"Dutch (NL)",
					"Polish (PL)",
					"Indonesian (ID)",
					"Vietnamese (VI)",
					"Thai (TH)"
				];
				if (!SUPPORTED_LANGUAGES.includes(changes.autoTranslateTo)) {
					return res
						.status(400)
						.json({ success: false, message: "Idioma para tradução não suportado." });
				}
			}

			if (changes.filters?.regexes && Array.isArray(changes.filters.regexes)) {
				for (const pattern of changes.filters.regexes) {
					const validation = validateRegexFilter(pattern);
					if (!validation.valid) {
						return res.status(400).json({
							success: false,
							message: `Regex inválido "${pattern}": ${validation.error}`
						});
					}
				}
			}

			api.logger.info(
				`[management][${token}][${groupId}] UPDATED Group data:\n${JSON.stringify(changes, null, 2)}`
			);

			Object.entries(changes).forEach(([key, value]) => {
				groupData[key] = value;
			});

			groupData.lastUpdated = new Date().toISOString();
			await api.database.saveGroup(groupData);

			if (api.eventHandler && typeof api.eventHandler.loadGroups === "function") {
				api.eventHandler.loadGroups();
			}

			return res.json({ success: true });
		} catch (error) {
			api.logger.error("Error updating group:", error);
			return res.status(500).json({ success: false, message: "Server error" });
		}
	});

	// Upload de mídia de grupo
	app.post(
		"/api/upload-media",
		api.strictLimiter,
		(req, res, next) => {
			upload.single("file")(req, res, (err) => {
				if (err) {
					api.logger.warn(`[management] Upload multer error: ${err.message}`);
					return res.status(400).json({
						success: false,
						message: `Erro no upload do arquivo: ${err.message}`
					});
				}
				next();
			});
		},
		async (req, res) => {
			const { token, groupId, type, name, caption } = req.body;
			const file = req.file;

			if (!token || !groupId || !type || !name || !file) {
				api.logger.warn(
					`[management] Upload rejeitado - parâmetros ausentes: token=${!!token}, groupId=${groupId || "none"}, type=${type || "none"}, name=${name || "none"}, file=${!!file}`
				);
				return res
					.status(400)
					.json({ success: false, message: "Parâmetros obrigatórios ausentes." });
			}

			try {
				const webManagementData = await api.readWebManagementToken(token);
				if (!webManagementData || webManagementData.groupId !== groupId) {
					api.logger.warn(`[management][${token}][${groupId}] Upload rejeitado: Não autorizado`);
					return res.status(401).json({ success: false, message: "Acesso não autorizado." });
				}

				if (new Date() > new Date(webManagementData.expiresAt)) {
					api.logger.warn(
						`[management][${token}][${groupId}] Upload rejeitado: Token expirado (expirou em ${webManagementData.expiresAt})`
					);
					return res.status(401).json({
						success: false,
						message: "Token expirado. Por favor, gere um novo link usando !g-painel no grupo."
					});
				}

				const groupData = await api.database.getGroup(groupId);
				if (!groupData) {
					api.logger.warn(
						`[management][${token}][${groupId}] Upload rejeitado: Grupo não encontrado`
					);
					return res.status(404).json({ success: false, message: "Grupo não encontrado." });
				}

				await checkGroupLimits(groupId, "storage", { fileSize: file.size });

				const fileName = `${Date.now()}-${file.originalname}`;
				const mediaPath = path.join(api.database.databasePath, "media");

				await fs.mkdir(mediaPath, { recursive: true }).catch(() => {});

				const filePath = path.join(mediaPath, fileName);
				await fs.copyFile(file.path, filePath);

				if (!groupData[type]) {
					groupData[type] = {};
				}

				groupData[type][name] = {
					file: fileName,
					caption: caption ? caption.trim() : undefined,
					uploadedAt: new Date().toISOString(),
					uploadedBy: webManagementData.requestNumber
				};

				groupData.lastUpdated = new Date().toISOString();
				await api.database.saveGroup(groupData);

				api.logger.info(
					`[management][${token}][${groupId}] Media '${type}' enviada com sucesso: ${fileName} (${(file.size / 1024).toFixed(1)} KB)`
				);

				return res.json({ success: true, fileName });
			} catch (error) {
				api.logger.error(`[management][${token}][${groupId}] Erro no upload de mídia:`, error);
				return res
					.status(500)
					.json({ success: false, message: error.message || "Erro interno do servidor." });
			} finally {
				if (req.file) {
					fs.unlink(req.file.path).catch((error) => {
						api.logger.error("Error removing temp file:", error);
					});
				}
			}
		}
	);

	// GET Custom Commands
	app.get("/api/custom-commands/:groupId", async (req, res) => {
		const { groupId } = req.params;
		const { token } = req.query;

		try {
			const webManagementData = await api.readWebManagementToken(token);
			if (!webManagementData || webManagementData.groupId !== groupId) {
				return res.status(401).json({ message: "Unauthorized" });
			}
			if (new Date() > new Date(webManagementData.expiresAt)) {
				return res.status(401).json({ message: "Token expired" });
			}

			const commands = await api.database.getCustomCommands(groupId);
			res.json(commands || []);
		} catch (e) {
			api.logger.error("Error fetching commands:", e);
			res.status(500).json({ message: "Server error" });
		}
	});

	// POST New Custom Command
	app.post("/api/custom-commands/:groupId", async (req, res) => {
		const { groupId } = req.params;
		const { token, command } = req.body;

		try {
			const webManagementData = await api.readWebManagementToken(token);
			if (!webManagementData || webManagementData.groupId !== groupId) {
				return res.status(401).json({ message: "Unauthorized" });
			}

			const groupData = await api.database.getGroup(groupId);
			const prefix = (groupData && groupData.prefix ? groupData.prefix : "!").trim();

			if (command && typeof command.startsWith === "string") {
				let triggerClean = command.startsWith.trim().toLowerCase();
				if (triggerClean.startsWith(prefix)) {
					triggerClean = triggerClean.substring(prefix.length).trim();
				} else if (prefix !== "!" && triggerClean.startsWith("!")) {
					triggerClean = triggerClean.substring(1).trim();
				}
				command.startsWith = triggerClean;
			}

			if (!command.startsWith) {
				return res.status(400).json({ message: "Gatilho de comando inválido" });
			}

			await checkGroupLimits(groupId, "commands", { isNew: true });
			await api.database.saveCustomCommand(groupId, command);

			api.database.clearCache(`commands:${groupId}`);
			await reloadGroupCommands(groupId);

			res.json({ success: true });
		} catch (e) {
			api.logger.error("Error creating command:", e);
			res.status(500).json({ message: e.message });
		}
	});

	// PUT Update Custom Command
	app.put("/api/custom-commands/:groupId/:trigger", async (req, res) => {
		const { groupId, trigger } = req.params;
		const { token, command } = req.body;

		try {
			const webManagementData = await api.readWebManagementToken(token);
			if (!webManagementData || webManagementData.groupId !== groupId) {
				return res.status(401).json({ message: "Unauthorized" });
			}

			const groupData = await api.database.getGroup(groupId);
			const prefix = (groupData && groupData.prefix ? groupData.prefix : "!").trim();

			if (command && typeof command.startsWith === "string") {
				let triggerClean = command.startsWith.trim().toLowerCase();
				if (triggerClean.startsWith(prefix)) {
					triggerClean = triggerClean.substring(prefix.length).trim();
				} else if (prefix !== "!" && triggerClean.startsWith("!")) {
					triggerClean = triggerClean.substring(1).trim();
				}
				command.startsWith = triggerClean;
			}

			if (!command.startsWith) {
				return res.status(400).json({ message: "Gatilho de comando inválido" });
			}

			const oldTrigger = decodeURIComponent(trigger);
			const newTrigger = command.startsWith;

			if (oldTrigger !== newTrigger) {
				const cmds = await api.database.getCustomCommands(groupId);
				const oldCmd = cmds.find((c) => c.startsWith === oldTrigger);
				if (oldCmd) {
					oldCmd.deleted = true;
					await api.database.updateCustomCommand(groupId, oldCmd);
				}
				await api.database.saveCustomCommand(groupId, command);
			} else {
				await api.database.updateCustomCommand(groupId, command);
			}

			api.database.clearCache(`commands:${groupId}`);
			await reloadGroupCommands(groupId);

			res.json({ success: true });
		} catch (e) {
			api.logger.error("Error updating command:", e);
			res.status(500).json({ message: "Server error" });
		}
	});

	// DELETE Custom Command
	app.delete("/api/custom-commands/:groupId/:trigger", async (req, res) => {
		const { groupId, trigger } = req.params;
		const { token } = req.query;

		try {
			const webManagementData = await api.readWebManagementToken(token);
			if (!webManagementData || webManagementData.groupId !== groupId) {
				return res.status(401).json({ message: "Unauthorized" });
			}

			const targetTrigger = decodeURIComponent(trigger);
			const cmds = await api.database.getCustomCommands(groupId);
			const cmd = cmds.find((c) => c.startsWith === targetTrigger && !c.deleted);

			if (cmd) {
				cmd.deleted = true;
				cmd.active = false;
				await api.database.updateCustomCommand(groupId, cmd);
			}

			api.database.clearCache(`commands:${groupId}`);
			await reloadGroupCommands(groupId);

			res.json({ success: true });
		} catch (e) {
			api.logger.error("Error deleting command:", e);
			res.status(500).json({ message: "Server error" });
		}
	});

	// Export Custom Commands as ZIP
	app.get("/api/custom-commands/:groupId/export-zip", async (req, res) => {
		const { groupId } = req.params;
		const { token } = req.query;

		try {
			const webManagementData = await api.readWebManagementToken(token);
			if (!webManagementData || webManagementData.groupId !== groupId) {
				return res.status(401).json({ message: "Unauthorized" });
			}

			const groupData = await api.database.getGroup(groupId);
			const groupName = (groupData?.name || groupId.split("@")[0] || "grupo").replace(
				/[^a-zA-Z0-9_-]/g,
				"_"
			);
			const commands = (await api.database.getCustomCommands(groupId)) || [];

			const tempJsonPath = path.join(__dirname, `../../../temp/cmds_${groupId}_${Date.now()}.json`);
			const tempZipPath = path.join(__dirname, `../../../temp/export_${groupId}_${Date.now()}.zip`);
			const mediaDir = path.join(api.database.databasePath, "media");
			const helperScript = path.join(__dirname, "../../../scripts/zip_commands_helper.py");

			await fs.mkdir(path.join(__dirname, "../../../temp"), { recursive: true }).catch(() => {});
			await fs.writeFile(tempJsonPath, JSON.stringify(commands, null, 2), "utf-8");

			await new Promise((resolve, reject) => {
				const child = spawn("python3", [
					helperScript,
					"export",
					tempJsonPath,
					mediaDir,
					tempZipPath
				]);
				let errOutput = "";
				child.stderr.on("data", (d) => {
					errOutput += d.toString();
				});
				child.on("close", (code) => {
					if (code === 0) resolve();
					else reject(new Error(errOutput || `Python script exited with code ${code}`));
				});
			});

			res.setHeader("Content-Type", "application/zip");
			res.setHeader("Content-Disposition", `attachment; filename="${groupName}_comandos.zip"`);

			const fileData = await fs.readFile(tempZipPath);
			res.send(fileData);

			await fs.unlink(tempJsonPath).catch(() => {});
			await fs.unlink(tempZipPath).catch(() => {});
		} catch (e) {
			api.logger.error("Erro ao exportar comandos em zip:", e);
			res.status(500).json({ message: "Erro ao exportar comandos: " + e.message });
		}
	});

	// GET Group Schedules
	app.get("/api/group-schedules/:groupId", async (req, res) => {
		const { groupId } = req.params;
		const { token } = req.query;

		try {
			const webManagementData = await api.readWebManagementToken(token);
			if (!webManagementData || webManagementData.groupId !== groupId) {
				return res.status(401).json({ message: "Unauthorized" });
			}

			const schedules = await GrupoAgendamentos.listarAgendamentos(groupId);
			res.json(schedules || []);
		} catch (e) {
			api.logger.error("Error fetching schedules:", e);
			res.status(500).json({ message: "Server error" });
		}
	});

	// POST New Group Schedule
	app.post("/api/group-schedules/:groupId", async (req, res) => {
		const { groupId } = req.params;
		const { token, tipo, hora, minuto, diaSemana, frase } = req.body;

		try {
			const webManagementData = await api.readWebManagementToken(token);
			if (!webManagementData || webManagementData.groupId !== groupId) {
				return res.status(401).json({ message: "Unauthorized" });
			}

			if (tipo !== "fechar" && tipo !== "abrir") {
				return res.status(400).json({ message: "Tipo inválido. Escolha 'fechar' ou 'abrir'." });
			}

			const h = parseInt(hora, 10);
			const m = parseInt(minuto, 10);
			if (isNaN(h) || h < 0 || h > 23 || isNaN(m) || m < 0 || m > 59) {
				return res.status(400).json({ message: "Horário inválido." });
			}

			let d = null;
			if (diaSemana !== null && diaSemana !== undefined && diaSemana !== "") {
				d = parseInt(diaSemana, 10);
				if (isNaN(d) || d < 0 || d > 6) {
					return res.status(400).json({ message: "Dia da semana inválido." });
				}
			}

			if (frase && frase.trim().length > 0 && frase.trim().length < 5) {
				return res
					.status(400)
					.json({ message: "A frase personalizada deve ter no mínimo 5 caracteres." });
			}

			let bot = api.bots.find((b) => b.id === webManagementData.botId);
			if (!bot || !bot.isConnected) {
				bot = api.bots.find((b) => b.isConnected);
			}

			const result = await GrupoAgendamentos.criarAgendamento(
				bot,
				groupId,
				tipo,
				h,
				m,
				d,
				frase && frase.trim().length >= 5 ? frase : null
			);

			res.json({ success: true, agendamento: result.agendamento });
		} catch (e) {
			api.logger.error("Error creating schedule:", e);
			res.status(400).json({ message: e.message || "Erro ao criar agendamento" });
		}
	});

	// DELETE Group Schedule
	app.delete("/api/group-schedules/:groupId/:id", async (req, res) => {
		const { groupId, id } = req.params;
		const { token } = req.query;

		try {
			const webManagementData = await api.readWebManagementToken(token);
			if (!webManagementData || webManagementData.groupId !== groupId) {
				return res.status(401).json({ message: "Unauthorized" });
			}

			const deleted = await GrupoAgendamentos.deletarAgendamento(groupId, id);
			if (!deleted) {
				return res.status(404).json({ message: "Agendamento não encontrado ou já inativo." });
			}

			res.json({ success: true, id: deleted.id });
		} catch (e) {
			api.logger.error("Error deleting schedule:", e);
			res.status(500).json({ message: "Erro ao excluir agendamento: " + e.message });
		}
	});

	// Import Custom Commands from ZIP
	app.post("/api/custom-commands/:groupId/import-zip", upload.single("file"), async (req, res) => {
		const { groupId } = req.params;
		const { token } = req.body;

		if (!req.file) {
			return res.status(400).json({ success: false, message: "Nenhum arquivo zip enviado." });
		}

		try {
			const webManagementData = await api.readWebManagementToken(token);
			if (!webManagementData || webManagementData.groupId !== groupId) {
				if (req.file) await fs.unlink(req.file.path).catch(() => {});
				return res.status(401).json({ message: "Unauthorized" });
			}

			const zipFilePath = req.file.path;
			const tempOutJson = path.join(
				__dirname,
				`../../../temp/imported_cmds_${groupId}_${Date.now()}.json`
			);
			const mediaDir = path.join(api.database.databasePath, "media");
			const helperScript = path.join(__dirname, "../../../scripts/zip_commands_helper.py");

			await fs.mkdir(path.join(__dirname, "../../../temp"), { recursive: true }).catch(() => {});

			const pythonResult = await new Promise((resolve, reject) => {
				const child = spawn("python3", [
					helperScript,
					"import",
					zipFilePath,
					mediaDir,
					tempOutJson
				]);
				let stdOutput = "";
				let errOutput = "";
				child.stdout.on("data", (d) => {
					stdOutput += d.toString();
				});
				child.stderr.on("data", (d) => {
					errOutput += d.toString();
				});
				child.on("close", (code) => {
					if (code === 0) {
						try {
							resolve(JSON.parse(stdOutput.trim()));
						} catch {
							resolve({ success: true });
						}
					} else {
						let errorMsg = errOutput.trim();
						if (!errorMsg && stdOutput.trim()) {
							try {
								const parsed = JSON.parse(stdOutput.trim());
								if (parsed && parsed.error) errorMsg = parsed.error;
							} catch {}
						}
						reject(new Error(errorMsg || `Python script exited with code ${code}`));
					}
				});
			});

			const rawCmds = await fs.readFile(tempOutJson, "utf-8");
			const importedCommands = JSON.parse(rawCmds);

			const existingCmds = (await api.database.getCustomCommands(groupId)) || [];
			let importedCount = 0;

			for (const cmd of importedCommands) {
				if (!cmd.startsWith) continue;
				cmd.deleted = false;
				cmd.groupId = groupId;
				const exists = existingCmds.find((c) => c.startsWith === cmd.startsWith);
				if (exists) {
					await api.database.updateCustomCommand(groupId, cmd);
				} else {
					await api.database.saveCustomCommand(groupId, cmd);
				}
				importedCount++;
			}

			api.database.clearCache(`commands:${groupId}`);
			await reloadGroupCommands(groupId);

			await fs.unlink(tempOutJson).catch(() => {});
			await fs.unlink(zipFilePath).catch(() => {});

			res.json({
				success: true,
				importedCount,
				mediaCount: pythonResult.media_count || 0
			});
		} catch (e) {
			api.logger.error("Erro ao importar comandos via zip:", e);
			if (req.file) await fs.unlink(req.file.path).catch(() => {});
			res.status(500).json({ success: false, message: e.message });
		}
	});

	// Checar disponibilidade do nome do grupo
	app.post("/api/group/check-import-name", async (req, res) => {
		const { token, groupId, name } = req.body;
		if (!token || !groupId || !name) {
			return res.status(400).json({ success: false, message: "Parâmetros ausentes." });
		}
		try {
			const webManagementData = await api.readWebManagementToken(token);
			if (!webManagementData || webManagementData.groupId !== groupId) {
				return res.status(401).json({ success: false, message: "Unauthorized" });
			}
			const cleanName = name.trim().toLowerCase();
			const existing = await api.database.getGroupByName(cleanName);
			if (existing && existing.id !== groupId) {
				return res.json({
					available: false,
					message: `O nome "${cleanName}" já está em uso por outro grupo.`
				});
			}
			return res.json({ available: true });
		} catch (e) {
			api.logger.error("Erro ao verificar nome do grupo:", e);
			return res.status(500).json({ success: false, message: e.message });
		}
	});
}

module.exports = { registerManagementRoutes };
