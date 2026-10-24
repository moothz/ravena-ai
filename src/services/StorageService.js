const {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	DeleteObjectCommand,
	DeleteObjectsCommand,
	ListObjectsV2Command,
	CreateBucketCommand,
	HeadBucketCommand
} = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const mime = require("mime-types");
const Logger = require("../utils/Logger");

class StorageService {
	constructor(options = {}) {
		this.logger = new Logger("storage-service");

		// Configurações S3 via env ou options
		this.enabled =
			(options.enabled ?? process.env.S3_ENABLED ?? process.env.MINIO_ENABLED ?? "true") === "true";

		const endpointHost =
			options.endpoint || process.env.S3_ENDPOINT || process.env.MINIO_ENDPOINT || "minio:9000";

		this.useSSL =
			(options.useSSL ?? process.env.S3_USE_SSL ?? process.env.MINIO_USE_SSL ?? "false") === "true";
		this.bucket =
			options.bucket || process.env.S3_BUCKET || process.env.MINIO_BUCKET || "zap-media";
		this.region =
			options.region || process.env.S3_REGION || process.env.MINIO_REGION || "us-east-1";

		const accessKeyId =
			options.accessKeyId ||
			process.env.S3_ACCESS_KEY ||
			process.env.MINIO_ACCESS_KEY ||
			"ravenaadmin";

		const secretAccessKey =
			options.secretAccessKey || process.env.S3_SECRET_KEY || process.env.MINIO_SECRET_KEY || "";

		const protocol = this.useSSL ? "https" : "http";
		const rawEndpoint =
			endpointHost.startsWith("http://") || endpointHost.startsWith("https://")
				? endpointHost
				: `${protocol}://${endpointHost}`;

		this.endpoint = rawEndpoint;

		// Diretórios locais para fallback e cache
		this.localMediaDir = path.join(__dirname, "../../data/media");
		this.migrationBackupDir =
			process.env.STORAGE_MIGRATION_PATH || "/home/moothz/ravena_data_migration";
		this.cacheDir = path.join(__dirname, "../../temp/s3-cache");

		// Categorias padrão para resolução por grupo
		this.knownCategories = [
			"custom-commands",
			"livestream",
			"greetings",
			"farewells",
			"group-photos",
			"user-files",
			"lembretes"
		];

		if (this.enabled) {
			this.client = new S3Client({
				endpoint: this.endpoint,
				region: this.region,
				credentials: {
					accessKeyId,
					secretAccessKey
				},
				forcePathStyle: true // Necessário para RustFS / MinIO / S3 compatível
			});
			this.logger.info(
				`StorageService iniciado [S3 Habilitado: ${this.enabled}, Endpoint: ${this.endpoint}, Bucket: ${this.bucket}]`
			);
		} else {
			this.client = null;
			this.logger.warn(`StorageService iniciado em modo LOCAL (S3 desabilitado)`);
		}

		this._initCacheDir().catch((err) => {
			this.logger.warn("Falha ao inicializar pasta de cache:", err.message);
		});
	}

	async _initCacheDir() {
		try {
			await fsPromises.mkdir(this.cacheDir, { recursive: true });
		} catch (err) {
			this.logger.debug("Diretório de cache já existente ou erro ao criar:", err.message);
		}
	}

	/**
	 * Constrói a chave padrão do S3 a partir do nome do arquivo e contexto
	 * Formato: {groupId}/{categoria}/{fileName} ou legacy/{fileName}
	 */
	buildKey(fileName, { groupId, category } = {}) {
		if (!fileName) throw new Error("fileName é obrigatório");

		// Se já contém path completo no bucket (ex: contendo barras)
		if (fileName.includes("/")) {
			return fileName.replace(/^\/+/, "");
		}

		const cleanFileName = path.basename(fileName);

		if (groupId) {
			const cleanCategory = category || "custom-commands";
			return `${groupId}/${cleanCategory}/${cleanFileName}`;
		}

		return `legacy/${cleanFileName}`;
	}

	/**
	 * Garante que o bucket configurado existe
	 */
	async ensureBucket() {
		if (!this.enabled || !this.client) return;

		try {
			await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
		} catch (err) {
			if (err.$metadata?.httpStatusCode === 404 || err.name === "NotFound") {
				this.logger.info(`Bucket '${this.bucket}' não encontrado. Criando...`);
				try {
					await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
					this.logger.info(`Bucket '${this.bucket}' criado com sucesso.`);
				} catch (createErr) {
					this.logger.error(`Erro ao criar bucket '${this.bucket}':`, createErr);
					throw createErr;
				}
			} else {
				this.logger.warn(`Verificação do bucket '${this.bucket}' retornou erro:`, err.message);
			}
		}
	}

	/**
	 * Faz upload de dados para o S3
	 * @param {Buffer|ReadableStream|string} data - Dados a serem gravados
	 * @param {string} fileName - Nome do arquivo ou chave completa
	 * @param {Object} options - { groupId, category, mimetype, metadata }
	 * @returns {Promise<{ key: string, bucket: string, size: number, mimetype: string, eTag: string }>}
	 */
	async upload(data, fileName, { groupId, category, mimetype, metadata = {} } = {}) {
		const key = this.buildKey(fileName, { groupId, category });

		let bufferData;
		if (typeof data === "string") {
			// Se for string base64 pura ou dataURI
			const cleanBase64 = data.replace(/^data:[^;]+;base64,/, "");
			bufferData = Buffer.from(cleanBase64, "base64");
		} else if (Buffer.isBuffer(data)) {
			bufferData = data;
		}

		const detectedMime = mimetype || mime.lookup(fileName) || "application/octet-stream";

		if (!this.enabled || !this.client) {
			// Modo local fallback
			const localPath = path.join(this.localMediaDir, path.basename(fileName));
			await fsPromises.mkdir(path.dirname(localPath), { recursive: true });
			if (bufferData) {
				await fsPromises.writeFile(localPath, bufferData);
			}
			return {
				key,
				bucket: "local",
				size: bufferData ? bufferData.length : 0,
				mimetype: detectedMime,
				localPath
			};
		}

		try {
			if (bufferData) {
				const command = new PutObjectCommand({
					Bucket: this.bucket,
					Key: key,
					Body: bufferData,
					ContentType: detectedMime,
					Metadata: {
						groupId: groupId || "",
						category: category || "",
						originalName: path.basename(fileName),
						...metadata
					}
				});

				const response = await this.client.send(command);
				this.logger.debug(`[upload] Objeto salvo no S3: ${key} (${bufferData.length} bytes)`);

				// Opcionalmente atualiza o cache local
				await this._saveToCache(key, bufferData);

				return {
					key,
					bucket: this.bucket,
					size: bufferData.length,
					mimetype: detectedMime,
					eTag: response.ETag
				};
			} else {
				// Upload via streaming com @aws-sdk/lib-storage
				const uploadParallel = new Upload({
					client: this.client,
					params: {
						Bucket: this.bucket,
						Key: key,
						Body: data,
						ContentType: detectedMime,
						Metadata: {
							groupId: groupId || "",
							category: category || "",
							originalName: path.basename(fileName),
							...metadata
						}
					}
				});

				const result = await uploadParallel.done();
				this.logger.debug(`[upload-stream] Objeto salvo no S3: ${key}`);

				return {
					key,
					bucket: this.bucket,
					mimetype: detectedMime,
					eTag: result.ETag
				};
			}
		} catch (error) {
			this.logger.error(`Erro ao fazer upload no S3 (${key}):`, error);
			throw error;
		}
	}

	/**
	 * Recupera mídia do S3 com resolução inteligente, cache local e fallback
	 * @param {string} fileNameOrKey - Nome do arquivo ou chave completa
	 * @param {Object} options - { groupId, category }
	 * @returns {Promise<{ buffer: Buffer, mimetype: string, size: number, key: string, source: string }>}
	 */
	async get(fileNameOrKey, { groupId, category } = {}) {
		if (!fileNameOrKey) throw new Error("fileNameOrKey é obrigatório");

		const cleanFileName = path.basename(fileNameOrKey);
		const targetCategory = category || "custom-commands";

		// 1. Checa o cache efêmero local primeiro
		const cachedBuffer = await this._getFromCache(fileNameOrKey, groupId);
		if (cachedBuffer) {
			const detectedMime = mime.lookup(cleanFileName) || "application/octet-stream";
			return {
				buffer: cachedBuffer,
				mimetype: detectedMime,
				size: cachedBuffer.length,
				key: fileNameOrKey,
				source: "cache"
			};
		}

		// 2. Se o S3 estiver habilitado, tenta buscar
		if (this.enabled && this.client) {
			// Se já for uma chave com caminho completo
			if (fileNameOrKey.includes("/")) {
				const s3Obj = await this._fetchFromS3(fileNameOrKey);
				if (s3Obj) {
					await this._saveToCache(fileNameOrKey, s3Obj.buffer);
					return { ...s3Obj, key: fileNameOrKey, source: "s3" };
				}
			} else {
				// Se groupId for fornecido, tenta na categoria solicitada: {groupId}/{categoria}/{fileName}
				if (groupId) {
					const primaryKey = `${groupId}/${targetCategory}/${cleanFileName}`;
					const s3Obj = await this._fetchFromS3(primaryKey);
					if (s3Obj) {
						await this._saveToCache(primaryKey, s3Obj.buffer);
						return { ...s3Obj, key: primaryKey, source: "s3" };
					}

					// Tenta outras categorias do mesmo grupo
					for (const cat of this.knownCategories) {
						if (cat === targetCategory) continue;
						const candidateKey = `${groupId}/${cat}/${cleanFileName}`;
						const candidateObj = await this._fetchFromS3(candidateKey);
						if (candidateObj) {
							await this._saveToCache(candidateKey, candidateObj.buffer);
							return { ...candidateObj, key: candidateKey, source: "s3" };
						}
					}
				}

				// Tenta na pasta legacy/
				const legacyKey = `legacy/${cleanFileName}`;
				const legacyObj = await this._fetchFromS3(legacyKey);
				if (legacyObj) {
					await this._saveToCache(legacyKey, legacyObj.buffer);
					return { ...legacyObj, key: legacyKey, source: "s3-legacy" };
				}
			}
		}

		// 3. Fallback: Disco local (data/media ou pasta de migração)
		const localPathsToTry = [
			path.join(this.localMediaDir, cleanFileName),
			path.join(this.migrationBackupDir, cleanFileName),
			path.join(this.localMediaDir, fileNameOrKey),
			path.join(this.migrationBackupDir, fileNameOrKey)
		];

		for (const candidatePath of localPathsToTry) {
			try {
				if (fs.existsSync(candidatePath)) {
					const fileBuffer = await fsPromises.readFile(candidatePath);
					const detectedMime = mime.lookup(candidatePath) || "application/octet-stream";

					this.logger.debug(
						`[get] Mídia encontrada no disco local: ${candidatePath} (${fileBuffer.length} bytes)`
					);

					// Lazy Upload em background para o S3 se habilitado
					if (this.enabled && this.client) {
						const targetKey = this.buildKey(cleanFileName, { groupId, category: targetCategory });
						this.upload(fileBuffer, cleanFileName, {
							groupId,
							category: targetCategory,
							mimetype: detectedMime
						}).catch((uploadErr) => {
							this.logger.warn(
								`[lazy-upload] Falha ao sincronizar ${targetKey} para o S3:`,
								uploadErr.message
							);
						});
					}

					await this._saveToCache(cleanFileName, fileBuffer);

					return {
						buffer: fileBuffer,
						mimetype: detectedMime,
						size: fileBuffer.length,
						key: cleanFileName,
						source: "disk"
					};
				}
			} catch (diskErr) {
				this.logger.debug(
					`Erro ao tentar ler arquivo do disco (${candidatePath}):`,
					diskErr.message
				);
			}
		}

		throw new Error(`Arquivo de mídia não encontrado no S3 nem no disco local: ${fileNameOrKey}`);
	}

	async _fetchFromS3(key) {
		try {
			const command = new GetObjectCommand({
				Bucket: this.bucket,
				Key: key
			});
			const response = await this.client.send(command);

			const chunks = [];
			for await (const chunk of response.Body) {
				chunks.push(chunk);
			}
			const buffer = Buffer.concat(chunks);
			const mimetype = response.ContentType || mime.lookup(key) || "application/octet-stream";

			return {
				buffer,
				mimetype,
				size: buffer.length
			};
		} catch (err) {
			if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
				return null;
			}
			this.logger.debug(`Erro ao buscar chave S3 (${key}):`, err.message);
			return null;
		}
	}

	/**
	 * Verifica existência de um objeto no S3
	 */
	async exists(fileNameOrKey, { groupId, category } = {}) {
		if (!this.enabled || !this.client) {
			const cleanFileName = path.basename(fileNameOrKey);
			return (
				fs.existsSync(path.join(this.localMediaDir, cleanFileName)) ||
				fs.existsSync(path.join(this.migrationBackupDir, cleanFileName))
			);
		}

		const key = this.buildKey(fileNameOrKey, { groupId, category });
		try {
			await this.client.send(
				new HeadObjectCommand({
					Bucket: this.bucket,
					Key: key
				})
			);
			return true;
		} catch (err) {
			if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
				return false;
			}
			return false;
		}
	}

	/**
	 * Remove um objeto do S3
	 */
	async delete(fileNameOrKey, { groupId, category } = {}) {
		const key = this.buildKey(fileNameOrKey, { groupId, category });

		if (this.enabled && this.client) {
			try {
				await this.client.send(
					new DeleteObjectCommand({
						Bucket: this.bucket,
						Key: key
					})
				);
				this.logger.debug(`[delete] Objeto removido do S3: ${key}`);
			} catch (err) {
				this.logger.warn(`Erro ao deletar objeto do S3 (${key}):`, err.message);
			}
		}

		// Remove também do cache se existir
		await this._removeFromCache(key);
	}

	/**
	 * Deleta todos os arquivos sob o prefixo de um grupo no S3
	 * @param {string} groupId
	 */
	async deleteGroup(groupId) {
		if (!this.enabled || !this.client || !groupId) return 0;

		const prefix = `${groupId}/`;
		this.logger.info(`[deleteGroup] Deletando todos os objetos do grupo: ${prefix}`);

		let deletedCount = 0;
		let continuationToken = null;

		try {
			do {
				const listCmd = new ListObjectsV2Command({
					Bucket: this.bucket,
					Prefix: prefix,
					ContinuationToken: continuationToken
				});
				const listRes = await this.client.send(listCmd);

				if (listRes.Contents && listRes.Contents.length > 0) {
					const objectsToDelete = listRes.Contents.map((obj) => ({ Key: obj.Key }));
					await this.client.send(
						new DeleteObjectsCommand({
							Bucket: this.bucket,
							Delete: { Objects: objectsToDelete }
						})
					);
					deletedCount += objectsToDelete.length;
				}

				continuationToken = listRes.NextContinuationToken;
			} while (continuationToken);

			this.logger.info(`[deleteGroup] Total de ${deletedCount} objetos removidos para ${groupId}`);
			return deletedCount;
		} catch (err) {
			this.logger.error(`Erro ao deletar grupo ${groupId} do S3:`, err);
			throw err;
		}
	}

	/**
	 * Calcula o total de bytes e objetos consumidos por um grupo no S3
	 * @param {string} groupId
	 */
	async getGroupUsage(groupId) {
		if (!this.enabled || !this.client || !groupId) {
			return { bytes: 0, count: 0 };
		}

		const prefix = `${groupId}/`;
		let totalBytes = 0;
		let count = 0;
		let continuationToken = null;

		try {
			do {
				const listCmd = new ListObjectsV2Command({
					Bucket: this.bucket,
					Prefix: prefix,
					ContinuationToken: continuationToken
				});
				const listRes = await this.client.send(listCmd);

				if (listRes.Contents) {
					for (const obj of listRes.Contents) {
						totalBytes += obj.Size || 0;
						count++;
					}
				}

				continuationToken = listRes.NextContinuationToken;
			} while (continuationToken);

			return { bytes: totalBytes, count };
		} catch (err) {
			this.logger.error(`Erro ao calcular uso do grupo ${groupId}:`, err);
			return { bytes: 0, count: 0 };
		}
	}

	// ── Métodos de Cache Efêmero ──

	_cacheKey(keyOrFileName) {
		return keyOrFileName.replace(/[^a-zA-Z0-9._-]/g, "_");
	}

	async _getFromCache(fileNameOrKey) {
		try {
			const safeName = this._cacheKey(fileNameOrKey);
			const cacheFilePath = path.join(this.cacheDir, safeName);
			if (fs.existsSync(cacheFilePath)) {
				const stat = await fsPromises.stat(cacheFilePath);
				// TTL de 2 horas no cache local
				if (Date.now() - stat.mtimeMs < 2 * 60 * 60 * 1000) {
					return await fsPromises.readFile(cacheFilePath);
				}
			}
		} catch {
			// Ignora falhas no cache
		}
		return null;
	}

	async _saveToCache(fileNameOrKey, buffer) {
		try {
			if (!buffer || buffer.length > 50 * 1024 * 1024) return; // Limite de 50MB por item no cache
			const safeName = this._cacheKey(fileNameOrKey);
			const cacheFilePath = path.join(this.cacheDir, safeName);
			await fsPromises.writeFile(cacheFilePath, buffer);
		} catch {
			// Ignora falhas no cache
		}
	}

	async _removeFromCache(fileNameOrKey) {
		try {
			const safeName = this._cacheKey(fileNameOrKey);
			const cacheFilePath = path.join(this.cacheDir, safeName);
			if (fs.existsSync(cacheFilePath)) {
				await fsPromises.unlink(cacheFilePath);
			}
		} catch {
			// Ignora falhas
		}
	}
}

// Exporta instância singleton e classe
const storageService = new StorageService();
module.exports = storageService;
module.exports.StorageService = StorageService;
