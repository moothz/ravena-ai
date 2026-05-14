const path = require("path");
const fs = require("fs").promises;
const crypto = require("crypto");

const Logger = require("../utils/Logger");
const Database = require("../utils/Database");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");

const logger = new Logger("file-manager");
const database = Database.getInstance();
const DB_NAME = "files";

// Initialize Database Tables
const db = database.getSQLiteDb(
	DB_NAME,
	`
  CREATE TABLE IF NOT EXISTS files (
    chat_id TEXT,
    file_path TEXT,
    file_info TEXT,
    PRIMARY KEY (chat_id, file_path)
  );
  CREATE TABLE IF NOT EXISTS chat_storage (
    chat_id TEXT PRIMARY KEY,
    total_size INTEGER
  );
`
);

// Configurações de limites
const CONFIG = {
	MAX_FILE_SIZE: 100 * 1024 * 1024, // 100MB
	MAX_GROUP_STORAGE: 1 * 1024 * 1024 * 1024, // 1GB
	MAX_FILENAME_LENGTH: 50,
	MAX_FOLDER_DEPTH: 5,
	VALID_FILENAME_REGEX: /^[a-zA-Z0-9_\-.]+$/
};

/**
 * Helper to get file info from DB
 */
async function getFile(chatId, filePath) {
	const row = await database.dbGet(
		DB_NAME,
		"SELECT file_info FROM files WHERE chat_id = ? AND file_path = ?",
		[chatId, filePath]
	);
	return row ? JSON.parse(row.file_info) : null;
}

/**
 * Helper to get total size
 */
async function getTotalSize(chatId) {
	const row = await database.dbGet(
		DB_NAME,
		"SELECT total_size FROM chat_storage WHERE chat_id = ?",
		[chatId]
	);
	return row ? row.total_size : 0;
}

/**
 * Helper to update total size
 */
async function updateTotalSize(chatId, delta) {
	await database.dbRun(
		DB_NAME,
		`
    INSERT INTO chat_storage (chat_id, total_size) VALUES (?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET total_size = total_size + ?
  `,
		[chatId, delta, delta]
	);
}

/**
 * Helper to list files
 */
async function listFilesFromDb(chatId, prefix = "") {
	let sql = "SELECT file_path, file_info FROM files WHERE chat_id = ?";
	const params = [chatId];

	if (prefix) {
		sql += " AND file_path LIKE ?";
		params.push(`${prefix}%`);
	}

	const rows = await database.dbAll(DB_NAME, sql, params);
	const files = {};
	rows.forEach((row) => {
		files[row.file_path] = JSON.parse(row.file_info);
	});
	return files;
}

/**
 * Obtém o caminho base para armazenar arquivos
 */
function getBasePath(chatId) {
	return path.join(__dirname, "../../media", chatId, "files");
}

/**
 * Normaliza um caminho de arquivo
 */
function normalizePath(filePath) {
	let normalized = filePath ? filePath.trim() : "";
	normalized = normalized.replace(/^[/\\]+|[/\\]+$/g, "");
	normalized = normalized.replaceAll("\\", "/");
	const parts = normalized.split("/").filter((p) => p && p !== "." && p !== "..");
	return parts.join("/");
}

/**
 * Valida um nome de arquivo
 */
function isValidFilename(filename) {
	if (!filename || filename.length > CONFIG.MAX_FILENAME_LENGTH) {
		return false;
	}
	return CONFIG.VALID_FILENAME_REGEX.test(filename);
}

/**
 * Valida um caminho
 */
function isValidPath(path) {
	if (!path) return true;
	const parts = normalizePath(path).split("/");
	return parts.length <= CONFIG.MAX_FOLDER_DEPTH && parts.every(isValidFilename);
}

/**
 * Gera nome de arquivo único
 */
function generateUniqueFilename(originalName) {
	const basename = path.basename(originalName);
	const ext = path.extname(basename);
	let name = path.basename(basename, ext);

	name = name.replace(/[^a-zA-Z0-9_]/g, "");
	if (name.length > CONFIG.MAX_FILENAME_LENGTH) {
		name = name.substring(0, CONFIG.MAX_FILENAME_LENGTH);
	}

	const hash = crypto.randomBytes(2).toString("hex");
	if (!name) name = "file";

	return `${name}_${hash}${ext}`;
}

/**
 * Formata tamanho em bytes
 */
function formatSize(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * Lista os arquivos e pastas de um chat
 */
async function listFiles(bot, message, args, group) {
	try {
		const chatId = message.group ?? message.author;
		let targetDir = "";
		if (args.length > 0) {
			targetDir = normalizePath(args.join(" "));
		}

		// Check if targetDir exists (unless root)
		if (targetDir) {
			const dirInfo = await getFile(chatId, targetDir);
			// Also check if any file starts with targetDir/ (implicit folder check)
			const hasChildren = await database.dbGet(
				DB_NAME,
				"SELECT 1 FROM files WHERE chat_id = ? AND file_path LIKE ? LIMIT 1",
				[chatId, `${targetDir}/%`]
			);

			if (!dirInfo && !hasChildren) {
				return new ReturnMessage({
					chatId,
					content: `❌ Pasta não encontrada: ${targetDir}`
				});
			}
		}

		const allFiles = await listFilesFromDb(chatId);

		let chatName = group ? group.name || "Grupo" : "Chat";
		if (!group) {
			try {
				const contact = await bot.client.getContactById(message.author);
				chatName = contact.pushname || contact.name || "Contato";
			} catch (e) {}
		}

		let messageContent = targetDir
			? `📂 *Conteúdo da pasta: ${targetDir}*\n_${chatName}_\n\n`
			: `📂 *Arquivos e Pastas*\n_${chatName}_\n\n`;

		if (targetDir) {
			const parentDir = targetDir.split("/").slice(0, -1).join("/");
			messageContent += `📁 [..] (Pasta pai: ${parentDir || "raiz"})

`;

			const fileEntries = [];
			const folderEntries = new Set();

			for (const [filePath, fileInfo] of Object.entries(allFiles)) {
				if (filePath === targetDir) continue;

				if (filePath.startsWith(`${targetDir}/`)) {
					const relativePath = filePath.substring(targetDir.length + 1);
					const parts = relativePath.split("/");

					if (parts.length === 1) {
						if (fileInfo.isFolder) folderEntries.add(parts[0]);
						else fileEntries.push({ name: parts[0], size: fileInfo.size || 0 });
					} else {
						folderEntries.add(parts[0]);
					}
				}
			}

			const folders = Array.from(folderEntries).sort();
			fileEntries.sort((a, b) => a.name.localeCompare(b.name));

			if (folders.length > 0) {
				messageContent += "*Pastas:*\n";
				folders.forEach((f) => (messageContent += `📁 [${f}]\n`));
				messageContent += "\n";
			}

			let totalSize = 0;
			if (fileEntries.length > 0) {
				messageContent += "*Arquivos:*\n";
				fileEntries.forEach((f) => {
					messageContent += `📄 ${f.name} (${formatSize(f.size)})\n`;
					totalSize += f.size;
				});
				messageContent += `\n*Total:* ${fileEntries.length} arquivo(s), ${formatSize(totalSize)}\n`;
			} else if (folders.length === 0) {
				messageContent += "_Nenhum arquivo ou pasta encontrado._\n\n";
			}
		} else {
			// Root view
			const allFolders = [];
			const filesByFolder = { raiz: [] };
			let totalFileCount = 0;
			let totalSize = 0;

			for (const [filePath, fileInfo] of Object.entries(allFiles)) {
				if (fileInfo.isFolder) {
					allFolders.push(filePath);
				} else {
					totalFileCount++;
					totalSize += fileInfo.size || 0;

					const lastSlashIndex = filePath.lastIndexOf("/");
					let folder = "raiz";
					if (lastSlashIndex !== -1) {
						folder = filePath.substring(0, lastSlashIndex);
						if (!filesByFolder[folder]) filesByFolder[folder] = [];
					}
					filesByFolder[folder].push({
						name: filePath.substring(lastSlashIndex + 1),
						size: fileInfo.size || 0
					});
				}
			}

			allFolders.sort();

			if (filesByFolder["raiz"].length > 0) {
				messageContent += "*Arquivos na raiz:*\n";
				filesByFolder["raiz"].sort((a, b) => a.name.localeCompare(b.name));
				filesByFolder["raiz"].forEach(
					(f) => (messageContent += `📄 ${f.name} (${formatSize(f.size)})\n`)
				);
				messageContent += "\n";
			}

			messageContent += "*Arquivos em Pastas:*\n";

			function getHierarchyPrefix(depth) {
				return "  ".repeat(depth);
			}

			function listFoldersRecursively(currentPath, depth) {
				const foldersInPath = allFolders.filter((folder) => {
					const parts = folder.split("/");
					return (
						parts.length === depth + 1 && (depth === 0 || folder.startsWith(currentPath + "/"))
					);
				});
				foldersInPath.sort();

				for (const folder of foldersInPath) {
					const folderName = folder.split("/").pop();
					const prefix = getHierarchyPrefix(depth);
					messageContent += `${prefix}📁 [${folderName}]\n`;

					if (filesByFolder[folder]) {
						filesByFolder[folder].sort((a, b) => a.name.localeCompare(b.name));
						filesByFolder[folder].forEach((f) => {
							messageContent += `${prefix}  └─ ${f.name} (${formatSize(f.size)})\n`;
						});
					}
					listFoldersRecursively(folder, depth + 1);
				}
			}

			listFoldersRecursively("", 0);
			messageContent += `\n*Total:* ${totalFileCount} arquivo(s), ${formatSize(totalSize)}\n`;
			if (totalFileCount === 0 && allFolders.length === 0) {
				messageContent += "_Nenhum arquivo ou pasta encontrado._\n\n";
			}
		}

		const usage = await getTotalSize(chatId);
		messageContent += `\n*Espaço usado:* ${formatSize(usage)} de ${formatSize(CONFIG.MAX_GROUP_STORAGE)}`;
		messageContent += `\n\n💡 Use *!pastas [nome_da_pasta]* para ver apenas o conteúdo de uma pasta específica.`;

		return new ReturnMessage({ chatId, content: messageContent });
	} catch (error) {
		logger.error("Erro ao listar arquivos:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao listar arquivos. Por favor, tente novamente."
		});
	}
}

/**
 * Baixa um arquivo ou pasta
 */
async function downloadFile(bot, message, args, group) {
	try {
		const chatId = message.group ?? message.author;
		if (args.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "Por favor, forneça o caminho do arquivo ou pasta a ser baixado."
			});
		}

		const filePath = normalizePath(args.join(" "));
		const fileInfo = await getFile(chatId, filePath);

		if (!fileInfo) {
			return new ReturnMessage({
				chatId,
				content: `❌ Arquivo ou pasta não encontrado: ${filePath}`
			});
		}

		const returnMessages = [];

		if (fileInfo.isFolder) {
			const allFiles = await listFilesFromDb(chatId, filePath);
			const filesInFolder = Object.entries(allFiles)
				.filter(([path, info]) => !info.isFolder && path.startsWith(`${filePath}/`))
				.map(([path, info]) => ({ path, info }));

			if (filesInFolder.length === 0) {
				return new ReturnMessage({ chatId, content: `❌ A pasta está vazia: ${filePath}` });
			}

			returnMessages.push(
				new ReturnMessage({
					chatId,
					content: `📤 Enviando ${filesInFolder.length} arquivo(s) da pasta: ${filePath}`
				})
			);

			const maxFiles = Math.min(5, filesInFolder.length);
			for (let i = 0; i < maxFiles; i++) {
				const { path: folderFilePath, info } = filesInFolder[i];
				try {
					const physicalPath = info.path || path.join(getBasePath(chatId), folderFilePath);
					const fileBuffer = await fs.readFile(physicalPath);
					const media = {
						mimetype: info.type || "application/octet-stream",
						data: fileBuffer.toString("base64"),
						filename: path.basename(folderFilePath),
						isMessageMedia: true
					};
					media.filename = path.basename(folderFilePath);

					returnMessages.push(
						new ReturnMessage({
							chatId,
							content: media,
							options: {
								sendMediaAsDocument: true,
								fileName: path.basename(folderFilePath),
								caption: `Arquivo: ${folderFilePath} (${formatSize(info.size || fileBuffer.length)})`
							}
						})
					);
				} catch (e) {
					logger.error(`Erro ao enviar: ${folderFilePath}`, e);
				}
			}

			if (filesInFolder.length > maxFiles) {
				returnMessages.push(
					new ReturnMessage({
						chatId,
						content: `⚠️ Só foram enviados ${maxFiles} de ${filesInFolder.length} arquivos para evitar spam.`
					})
				);
			}
		} else {
			try {
				const physicalPath = fileInfo.path || path.join(getBasePath(chatId), filePath);
				const fileBuffer = await fs.readFile(physicalPath);
				const media = {
					mimetype: fileInfo.type || "application/octet-stream",
					data: fileBuffer.toString("base64"),
					filename: path.basename(filePath),
					isMessageMedia: true
				};
				return new ReturnMessage({
					chatId,
					content: media,
					options: {
						sendMediaAsDocument: true,
						fileName: path.basename(filePath),
						caption: `Arquivo: ${filePath} (${formatSize(fileInfo.size || fileBuffer.length)})`
					}
				});
			} catch (e) {
				logger.error(`Erro ao enviar: ${filePath}`, e);
				return new ReturnMessage({
					chatId,
					content: `⚠️ Erro ao enviar arquivo: ${filePath}`
				});
			}
		}

		return returnMessages;
	} catch (error) {
		logger.error("Erro ao baixar arquivo/pasta:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao baixar arquivo/pasta. Por favor, tente novamente."
		});
	}
}

/**
 * Cria uma nova pasta
 */
async function createFolder(bot, message, args, group) {
	try {
		const chatId = message.group ?? message.author;
		if (args.length === 0)
			return new ReturnMessage({ chatId, content: "Por favor, forneça o nome da pasta." });

		const folderPath = normalizePath(args.join(" "));
		if (!isValidPath(folderPath))
			return new ReturnMessage({ chatId, content: `❌ Caminho inválido.` });

		const existing = await getFile(chatId, folderPath);
		if (existing)
			return new ReturnMessage({
				chatId,
				content: `❌ Já existe um arquivo ou pasta com o nome: ${folderPath}`
			});

		// Check parent
		const parts = folderPath.split("/");
		if (parts.length > 1) {
			const parentPath = parts.slice(0, -1).join("/");
			const parent = await getFile(chatId, parentPath);
			if (!parent || !parent.isFolder) {
				return new ReturnMessage({
					chatId,
					content: `❌ Pasta pai não existe: ${parentPath}`
				});
			}
		}

		const physicalBasePath = getBasePath(chatId);
		const physicalPath = path.join(physicalBasePath, folderPath);
		await fs.mkdir(physicalPath, { recursive: true });

		const info = {
			isFolder: true,
			createdAt: Date.now(),
			createdBy: message.author
		};

		await database.dbRun(
			DB_NAME,
			"INSERT INTO files (chat_id, file_path, file_info) VALUES (?, ?, ?)",
			[chatId, folderPath, JSON.stringify(info)]
		);

		return new ReturnMessage({ chatId, content: `✅ Pasta criada: ${folderPath}` });
	} catch (error) {
		logger.error("Erro ao criar pasta:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao criar pasta."
		});
	}
}

/**
 * Envia um arquivo para uma pasta
 */
async function uploadFile(bot, message, args, group) {
	try {
		const chatId = message.group ?? message.author;
		const destination = args.length > 0 ? normalizePath(args.join(" ")) : "";

		if (destination && !isValidPath(destination))
			return new ReturnMessage({ chatId, content: `❌ Caminho inválido.` });

		const quotedMsg = await message.origin.getQuotedMessage();
		if (!quotedMsg || !quotedMsg.hasMedia)
			return new ReturnMessage({
				chatId,
				content: "❌ Por favor, mencione uma mensagem com arquivo."
			});

		const media = await quotedMsg.downloadMedia();
		if (!media || !media.data)
			return new ReturnMessage({
				chatId,
				content: "❌ Não foi possível baixar o arquivo."
			});

		const fileBuffer = Buffer.from(media.data, "base64");
		const fileSize = fileBuffer.length;

		if (fileSize > CONFIG.MAX_FILE_SIZE)
			return new ReturnMessage({
				chatId,
				content: `❌ O arquivo excede o tamanho máximo.`
			});

		const currentSize = await getTotalSize(chatId);
		if (currentSize + fileSize > CONFIG.MAX_GROUP_STORAGE) {
			return new ReturnMessage({ chatId, content: `❌ Espaço insuficiente.` });
		}

		let targetPath = destination;
		let fileName = "";

		if (path.extname(destination)) {
			const parts = destination.split("/");
			fileName = parts.pop();
			targetPath = parts.join("/");
		} else {
			if (media.filename) fileName = generateUniqueFilename(media.filename);
			else {
				let ext = ".bin";
				if (media.mimetype) {
					const mimeExt = media.mimetype.split("/")[1];
					if (mimeExt) ext = `.${mimeExt}`;
				}
				fileName = generateUniqueFilename(`file${ext}`);
			}
		}

		if (targetPath) {
			const parent = await getFile(chatId, targetPath);
			if (!parent || !parent.isFolder)
				return new ReturnMessage({
					chatId,
					content: `❌ Pasta de destino não existe: ${targetPath}`
				});
		}

		const dbFilePath = targetPath ? `${targetPath}/${fileName}` : fileName;
		const existing = await getFile(chatId, dbFilePath);
		if (existing)
			return new ReturnMessage({
				chatId,
				content: `❌ Já existe um arquivo com este nome: ${dbFilePath}`
			});

		const physicalBasePath = getBasePath(chatId);
		const targetFolder = path.join(physicalBasePath, targetPath);
		const physicalFilePath = path.join(targetFolder, fileName);

		await fs.mkdir(targetFolder, { recursive: true });
		await fs.writeFile(physicalFilePath, fileBuffer);

		const info = {
			path: physicalFilePath,
			size: fileSize,
			name: fileName,
			type: media.mimetype || "application/octet-stream",
			createdAt: Date.now(),
			createdBy: message.author,
			isFolder: false
		};

		await database.dbRun(
			DB_NAME,
			"INSERT INTO files (chat_id, file_path, file_info) VALUES (?, ?, ?)",
			[chatId, dbFilePath, JSON.stringify(info)]
		);

		await updateTotalSize(chatId, fileSize);

		const displayPath = targetPath ? `${targetPath}/${fileName}` : fileName;
		return new ReturnMessage({
			chatId,
			content: `✅ Arquivo salvo: ${displayPath} (${formatSize(fileSize)})

📥 
\`\`\`!p-baixar ${displayPath}\`\`\`
🔗 
\`\`\`{file-${displayPath}}\`\`\``
		});
	} catch (error) {
		logger.error("Erro ao enviar arquivo:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao enviar arquivo."
		});
	}
}

/**
 * Apaga um arquivo ou pasta
 */
async function deleteFile(bot, message, args, group) {
	try {
		const chatId = message.group ?? message.author;
		if (args.length === 0) return new ReturnMessage({ chatId, content: "Forneça o caminho." });

		const filePath = normalizePath(args.join(" "));
		const fileInfo = await getFile(chatId, filePath);

		if (!fileInfo) return new ReturnMessage({ chatId, content: `❌ Não encontrado: ${filePath}` });

		if (fileInfo.isFolder) {
			const hasChildren = await database.dbGet(
				DB_NAME,
				"SELECT 1 FROM files WHERE chat_id = ? AND file_path LIKE ? AND file_path != ? LIMIT 1",
				[chatId, `${filePath}/%`, filePath]
			);

			if (hasChildren) return new ReturnMessage({ chatId, content: `❌ A pasta não está vazia.` });

			const physicalPath = path.join(getBasePath(chatId), filePath);
			try {
				await fs.rmdir(physicalPath);
			} catch (e) {}

			await database.dbRun(DB_NAME, "DELETE FROM files WHERE chat_id = ? AND file_path = ?", [
				chatId,
				filePath
			]);
			return new ReturnMessage({ chatId, content: `✅ Pasta excluída: ${filePath}` });
		} else {
			const fileSize = fileInfo.size || 0;
			try {
				if (fileInfo.path) await fs.unlink(fileInfo.path);
				else await fs.unlink(path.join(getBasePath(chatId), filePath));
			} catch (e) {}

			await database.dbRun(DB_NAME, "DELETE FROM files WHERE chat_id = ? AND file_path = ?", [
				chatId,
				filePath
			]);
			await updateTotalSize(chatId, -fileSize);

			return new ReturnMessage({ chatId, content: `✅ Arquivo excluído: ${filePath}` });
		}
	} catch (error) {
		logger.error("Erro ao excluir:", error);
		return new ReturnMessage({
			chatId: message.group ?? message.author,
			content: "Erro ao excluir."
		});
	}
}

/**
 * Processa variável de arquivo
 */
async function processFileVariable(filePath, bot, chatId) {
	try {
		const filePathMatch = filePath.match(/^\{file-(.*?)\}$/);
		if (!filePathMatch) return null;

		const normalizedPath = normalizePath(filePathMatch[1]);
		const fileInfo = await getFile(chatId, normalizedPath);
		if (!fileInfo) return null;

		if (fileInfo.isFolder) {
			// Return first 5 files
			const allFiles = await listFilesFromDb(chatId, normalizedPath);
			const filesInFolder = Object.entries(allFiles)
				.filter(([path, info]) => !info.isFolder && path.startsWith(`${normalizedPath}/`))
				.map(([path, info]) => ({ path, info }))
				.slice(0, 5);

			if (filesInFolder.length === 0) return null;

			const mediaFiles = [];
			for (const { path: fPath, info } of filesInFolder) {
				try {
					const physicalPath = info.path || path.join(getBasePath(chatId), fPath);
					const fileBuffer = await fs.readFile(physicalPath);
					const media = {
						mimetype: info.type || "application/octet-stream",
						data: fileBuffer.toString("base64"),
						filename: path.basename(fPath),
						isMessageMedia: true
					};
					mediaFiles.push({
						media,
						caption: `Arquivo: ${fPath} (${formatSize(info.size || fileBuffer.length)})`
					});
				} catch (e) {}
			}
			return mediaFiles.length > 0 ? mediaFiles : null;
		} else {
			try {
				const physicalPath = fileInfo.path || path.join(getBasePath(chatId), normalizedPath);
				const fileBuffer = await fs.readFile(physicalPath);
				return {
					mimetype: fileInfo.type || "application/octet-stream",
					data: fileBuffer.toString("base64"),
					filename: path.basename(normalizedPath),
					isMessageMedia: true
				};
			} catch (e) {
				return null;
			}
		}
	} catch (error) {
		return null;
	}
}

// Ensure base directories
(async () => {
	try {
		const rows = await database.dbAll(DB_NAME, "SELECT chat_id FROM chat_storage");
		for (const row of rows) {
			await fs.mkdir(getBasePath(row.chat_id), { recursive: true });
		}
	} catch (e) {}
})();

// Commands
const commands = [
	new Command({
		name: "pastas",
		category: "arquivos",
		description: "Lista as pastas e arquivos",
		reactions: { before: process.env.LOADING_EMOJI ?? "⌛️", after: "📂" },
		method: listFiles
	}),
	new Command({
		name: "p-criar",
		description: "Cria nova pasta",
		category: "arquivos",
		reactions: { before: process.env.LOADING_EMOJI ?? "⌛️", after: "📁" },
		method: createFolder
	}),
	new Command({
		name: "p-enviar",
		description: "Envia arquivo para a pasta",
		category: "arquivos",
		reactions: { before: process.env.LOADING_EMOJI ?? "⌛️", after: "📤" },
		method: uploadFile
	}),
	new Command({
		name: "p-excluir",
		description: "Apaga arquivo ou pasta",
		category: "arquivos",
		reactions: { before: process.env.LOADING_EMOJI ?? "⌛️", after: "🧹" },
		method: deleteFile
	}),
	new Command({
		name: "p-baixar",
		description: "Baixa arquivo ou pasta",
		category: "arquivos",
		reactions: { before: process.env.LOADING_EMOJI ?? "⌛️", after: "📥" },
		method: downloadFile
	})
];

module.exports = { commands, processFileVariable };
