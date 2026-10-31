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
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { Upload } = require("@aws-sdk/lib-storage");
const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const mime = require("mime-types");
const Logger = require("../utils/Logger");
const urlShortenerService = require("./UrlShortenerService");

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

		this.bucketMedia =
			options.bucketMedia ||
			options.bucket ||
			process.env.S3_BUCKET_MEDIA ||
			process.env.S3_BUCKET ||
			process.env.MINIO_BUCKET ||
			"zap-media";

		this.bucketDownloads =
			options.bucketDownloads || process.env.S3_BUCKET_DOWNLOADS || "downloads";

		this.bucketBackups = options.bucketBackups || process.env.S3_BUCKET_BACKUPS || "backups";

		// Retrocompatibilidade: this.bucket aponta para o bucket principal de mídia
		this.bucket = this.bucketMedia;

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

		this.publicDomain = (
			options.publicDomain ||
			process.env.S3_PUBLIC_DOMAIN ||
			"https://s3-ravena.moothz.win"
		).replace(/\/+$/, "");

		this.presignedExpiresIn = parseInt(
			options.presignedExpiresIn || process.env.S3_PRESIGNED_EXPIRES_IN || "21600",
			10
		);

		this.downloadsRetentionHours = parseInt(
			options.downloadsRetentionHours || process.env.S3_DOWNLOADS_RETENTION_HOURS || "48",
			10
		);

		this.backupsRetentionDays = parseInt(
			options.backupsRetentionDays || process.env.S3_BACKUPS_RETENTION_DAYS || "30",
			10
		);

		// Cache local em disco (desabilitado por padrão se S3 for local)
		this.localCacheEnabled =
			(options.localCacheEnabled ?? process.env.S3_LOCAL_CACHE ?? "false") === "true";
		this.localCacheTtlHours = parseInt(
			options.localCacheTtlHours || process.env.S3_LOCAL_CACHE_TTL_HOURS || "2",
			10
		);
		this.localCacheMaxMb = parseInt(
			options.localCacheMaxMb || process.env.S3_LOCAL_CACHE_MAX_MB || "500",
			10
		);

		// Diretórios locais para fallback e cache
		this.localMediaDir = path.join(__dirname, "../../data/media");
		this.migrationBackupDir =
			process.env.STORAGE_MIGRATION_PATH ||
			(fs.existsSync("/app/downloads/ravena_data_migration")
				? "/app/downloads/ravena_data_migration"
				: fs.existsSync("/mnt/ks500gb/ravena_data_migration")
					? "/mnt/ks500gb/ravena_data_migration"
					: "/home/moothz/ravena_data_migration");
		this.cacheDir = path.join(__dirname, "../../temp/s3-cache");

		// Categorias padrão para resolução por grupo
		this.knownCategories = [
			"custom-commands",
			"livestream",
			"greetings",
			"farewells",
			"group-photos",
			"user-files",
			"lembretes",
			"marriages",
			"raffles",
			"yt",
			"social",
			"attachments"
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

			// Client dedicado para geração de URLs assinadas compatíveis com o domínio público da Cloudflare
			this.publicClient = new S3Client({
				endpoint: this.publicDomain,
				region: this.region,
				credentials: {
					accessKeyId,
					secretAccessKey
				},
				forcePathStyle: true
			});

			this.logger.info(
				`StorageService iniciado [S3 Habilitado: ${this.enabled}, Endpoint: ${this.endpoint}, Domínio Público: ${this.publicDomain}, Buckets: media='${this.bucketMedia}', dl='${this.bucketDownloads}', bk='${this.bucketBackups}']`
			);
		} else {
			this.client = null;
			this.publicClient = null;
			this.logger.warn("StorageService iniciado em modo LOCAL (S3 desabilitado)");
		}

		this._initCacheDir().catch((err) => {
			this.logger.warn("Falha ao inicializar pasta de cache:", err.message);
		});

		// Agendamento periódico de expurgo de downloads S3 expirados (TTL 48h)
		if (
			this.enabled &&
			process.env.DISABLE_ACTIVITY !== "true" &&
			process.env.DISABLE_STICKER_SCRAPER_TIMER !== "true" &&
			!this.downloadsCleanupTimer
		) {
			const initialTimer = setTimeout(
				() => {
					this.cleanupExpiredDownloads().catch((err) => {
						this.logger.warn(
							`[StorageService] Falha na limpeza inicial de downloads expirados: ${err.message}`
						);
					});
				},
				2 * 60 * 1000
			);
			if (initialTimer.unref) initialTimer.unref();

			this.downloadsCleanupTimer = setInterval(
				() => {
					this.cleanupExpiredDownloads().catch((err) => {
						this.logger.warn(
							`[StorageService] Falha na limpeza periódica de downloads expirados: ${err.message}`
						);
					});
				},
				6 * 60 * 60 * 1000
			);
			if (this.downloadsCleanupTimer.unref) this.downloadsCleanupTimer.unref();
		}
	}

	async _initCacheDir() {
		try {
			await fsPromises.mkdir(this.cacheDir, { recursive: true });
			if (this.localCacheEnabled) {
				await this.pruneExpiredCache().catch(() => {});
				if (
					process.env.DISABLE_ACTIVITY !== "true" &&
					process.env.DISABLE_STICKER_SCRAPER_TIMER !== "true" &&
					!this.cachePruneTimer
				) {
					this.cachePruneTimer = setInterval(
						() => {
							this.pruneExpiredCache().catch(() => {});
						},
						60 * 60 * 1000
					);
					if (this.cachePruneTimer.unref) this.cachePruneTimer.unref();
				}
			}
		} catch (err) {
			this.logger.debug("Diretório de cache já existente ou erro ao criar:", err.message);
		}
	}

	/**
	 * Constrói a chave padrão do S3 a partir do nome do arquivo e contexto
	 * Formato: {groupId}/{categoria}/{fileName}, {categoria}/{fileName} ou legacy/{fileName}
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

		if (category) {
			return `${category}/${cleanFileName}`;
		}

		return `legacy/${cleanFileName}`;
	}

	/**
	 * Garante que o bucket configurado existe
	 */
	async ensureBucket(bucketName) {
		if (!this.enabled || !this.client) return;
		const targetBucket = bucketName || this.bucket;

		try {
			await this.client.send(new HeadBucketCommand({ Bucket: targetBucket }));
		} catch (err) {
			if (err.$metadata?.httpStatusCode === 404 || err.name === "NotFound") {
				this.logger.info(`Bucket '${targetBucket}' não encontrado. Criando...`);
				try {
					await this.client.send(new CreateBucketCommand({ Bucket: targetBucket }));
					this.logger.info(`Bucket '${targetBucket}' criado com sucesso.`);
				} catch (createErr) {
					this.logger.error(`Erro ao criar bucket '${targetBucket}':`, createErr);
					throw createErr;
				}
			} else {
				this.logger.warn(`Verificação do bucket '${targetBucket}' retornou erro:`, err.message);
			}
		}
	}

	/**
	 * Garante a criação de todos os buckets do sistema
	 */
	async ensureAllBuckets() {
		if (!this.enabled || !this.client) return;
		await this.ensureBucket(this.bucketMedia);
		await this.ensureBucket(this.bucketDownloads);
		await this.ensureBucket(this.bucketBackups);
	}

	/**
	 * Faz upload de dados para o S3
	 * @param {Buffer|ReadableStream|string} data - Dados a serem gravados
	 * @param {string} fileName - Nome do arquivo ou chave completa
	 * @param {Object} options - { groupId, category, mimetype, metadata, bucket }
	 * @returns {Promise<{ key: string, bucket: string, size: number, mimetype: string, eTag: string }>}
	 */
	async upload(data, fileName, { groupId, category, mimetype, metadata = {}, bucket } = {}) {
		const targetBucket = bucket || this.bucket;
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
					Bucket: targetBucket,
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
				this.logger.debug(
					`[upload] Objeto salvo no S3 (${targetBucket}): ${key} (${bufferData.length} bytes)`
				);

				// Opcionalmente atualiza o cache local
				await this._saveToCache(key, bufferData, targetBucket);

				return {
					key,
					bucket: targetBucket,
					size: bufferData.length,
					mimetype: detectedMime,
					eTag: response.ETag
				};
			} else {
				// Upload via streaming com @aws-sdk/lib-storage
				const uploadParallel = new Upload({
					client: this.client,
					params: {
						Bucket: targetBucket,
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
				this.logger.debug(`[upload-stream] Objeto salvo no S3 (${targetBucket}): ${key}`);

				return {
					key,
					bucket: targetBucket,
					mimetype: detectedMime,
					eTag: result.ETag
				};
			}
		} catch (error) {
			this.logger.error(`Erro ao fazer upload no S3 (${targetBucket}/${key}):`, error);
			throw error;
		}
	}

	/**
	 * Recupera mídia do S3 com resolução inteligente, cache local e fallback
	 * @param {string} fileNameOrKey - Nome do arquivo ou chave completa
	 * @param {Object} options - { groupId, category, bucket }
	 * @returns {Promise<{ buffer: Buffer, mimetype: string, size: number, key: string, source: string, bucket: string }>}
	 */
	async get(fileNameOrKey, { groupId, category, bucket } = {}) {
		if (!fileNameOrKey) throw new Error("fileNameOrKey é obrigatório");

		const targetBucket = bucket || this.bucket;
		const cleanFileName = path.basename(fileNameOrKey);
		const targetCategory = category || "custom-commands";

		// 1. Checa o cache efêmero local primeiro
		const cachedBuffer = await this._getFromCache(fileNameOrKey, targetBucket);
		if (cachedBuffer) {
			const detectedMime = mime.lookup(cleanFileName) || "application/octet-stream";
			return {
				buffer: cachedBuffer,
				mimetype: detectedMime,
				size: cachedBuffer.length,
				key: fileNameOrKey,
				source: "cache",
				bucket: targetBucket
			};
		}

		// 2. Se o S3 estiver habilitado, tenta buscar
		if (this.enabled && this.client) {
			// Se já for uma chave com caminho completo
			if (fileNameOrKey.includes("/")) {
				const s3Obj = await this._fetchFromS3(fileNameOrKey, targetBucket);
				if (s3Obj) {
					await this._saveToCache(fileNameOrKey, s3Obj.buffer, targetBucket);
					return { ...s3Obj, key: fileNameOrKey, source: "s3", bucket: targetBucket };
				}
			} else {
				// Se groupId for fornecido, tenta na categoria solicitada: {groupId}/{categoria}/{fileName}
				if (groupId) {
					const primaryKey = `${groupId}/${targetCategory}/${cleanFileName}`;
					const s3Obj = await this._fetchFromS3(primaryKey, targetBucket);
					if (s3Obj) {
						await this._saveToCache(primaryKey, s3Obj.buffer, targetBucket);
						return { ...s3Obj, key: primaryKey, source: "s3", bucket: targetBucket };
					}

					// Tenta outras categorias do mesmo grupo
					for (const cat of this.knownCategories) {
						if (cat === targetCategory) continue;
						const candidateKey = `${groupId}/${cat}/${cleanFileName}`;
						const candidateObj = await this._fetchFromS3(candidateKey, targetBucket);
						if (candidateObj) {
							await this._saveToCache(candidateKey, candidateObj.buffer, targetBucket);
							return { ...candidateObj, key: candidateKey, source: "s3", bucket: targetBucket };
						}
					}
				} else if (category) {
					// Categoria sem grupo (ex: marriages/characterId.jpg, lembretes/123.jpg)
					const categoryKey = `${category}/${cleanFileName}`;
					const s3Obj = await this._fetchFromS3(categoryKey, targetBucket);
					if (s3Obj) {
						await this._saveToCache(categoryKey, s3Obj.buffer, targetBucket);
						return { ...s3Obj, key: categoryKey, source: "s3", bucket: targetBucket };
					}
				}

				// Tenta na pasta legacy/
				const legacyKey = `legacy/${cleanFileName}`;
				const legacyObj = await this._fetchFromS3(legacyKey, targetBucket);
				if (legacyObj) {
					await this._saveToCache(legacyKey, legacyObj.buffer, targetBucket);
					return { ...legacyObj, key: legacyKey, source: "s3-legacy", bucket: targetBucket };
				}
			}
		}

		// 3. Fallback: Disco local (data/media ou pasta de migração)
		const migrationDirs = [
			this.migrationBackupDir,
			"/app/downloads/ravena_data_migration",
			"/mnt/ks500gb/ravena_data_migration",
			"/home/moothz/ravena_data_migration"
		].filter((dir, idx, arr) => dir && arr.indexOf(dir) === idx && fs.existsSync(dir));

		const localPathsToTry = [
			path.join(this.localMediaDir, cleanFileName),
			path.join(this.localMediaDir, fileNameOrKey)
		];

		for (const mDir of migrationDirs) {
			localPathsToTry.push(path.join(mDir, cleanFileName));
			localPathsToTry.push(path.join(mDir, fileNameOrKey));
		}

		if (category) {
			localPathsToTry.unshift(path.join(this.localMediaDir, category, cleanFileName));
			for (const mDir of migrationDirs) {
				localPathsToTry.unshift(path.join(mDir, category, cleanFileName));
			}
		}

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
							mimetype: detectedMime,
							bucket: targetBucket
						}).catch((uploadErr) => {
							this.logger.warn(
								`[lazy-upload] Falha ao sincronizar ${targetKey} para o S3:`,
								uploadErr.message
							);
						});
					}

					await this._saveToCache(cleanFileName, fileBuffer, targetBucket);

					return {
						buffer: fileBuffer,
						mimetype: detectedMime,
						size: fileBuffer.length,
						key: cleanFileName,
						source: "disk",
						bucket: targetBucket
					};
				}
			} catch (diskErr) {
				this.logger.debug(
					`Erro ao tentar ler arquivo do disco (${candidatePath}):`,
					diskErr.message
				);
			}
		}

		throw new Error(
			`Arquivo de mídia não encontrado no S3 (${targetBucket}) nem no disco local: ${fileNameOrKey}`
		);
	}

	async _fetchFromS3(key, bucket) {
		const targetBucket = bucket || this.bucket;
		try {
			const command = new GetObjectCommand({
				Bucket: targetBucket,
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
			this.logger.debug(`Erro ao buscar chave S3 (${targetBucket}/${key}):`, err.message);
			return null;
		}
	}

	/**
	 * Gera uma Presigned URL para download direto no navegador / WhatsApp
	 * @param {string} fileNameOrKey - Nome do arquivo ou chave completa
	 * @param {Object} options - { bucket, expiresIn, groupId, category, shorten }
	 * @returns {Promise<string>} URL assinada válida para download
	 */
	async getPresignedUrl(
		fileNameOrKey,
		{ bucket, expiresIn, groupId, category, shorten = false } = {}
	) {
		if (!fileNameOrKey) throw new Error("fileNameOrKey é obrigatório para presigned URL");

		const targetBucket = bucket || this.bucketDownloads;
		const key = this.buildKey(fileNameOrKey, { groupId, category });
		const ttl = typeof expiresIn === "number" ? expiresIn : this.presignedExpiresIn;

		if (!this.enabled || !this.client) {
			const fallbackUrl = `${this.publicDomain}/${targetBucket}/${key}`;
			if (shorten) {
				return await urlShortenerService.shorten(fallbackUrl);
			}
			return fallbackUrl;
		}

		try {
			const command = new GetObjectCommand({
				Bucket: targetBucket,
				Key: key
			});

			// Usa publicClient para que o cabeçalho Host na assinatura seja s3-ravena.moothz.win
			const signer = this.publicClient || this.client;
			const signedUrl = await getSignedUrl(signer, command, { expiresIn: ttl });
			this.logger.debug(`[presigned-url] Gerada URL para ${targetBucket}/${key} (TTL ${ttl}s)`);
			if (shorten) {
				return await urlShortenerService.shorten(signedUrl);
			}
			return signedUrl;
		} catch (err) {
			this.logger.error(`Erro ao gerar presigned URL para ${targetBucket}/${key}:`, err);
			const fallbackUrl = `${this.publicDomain}/${targetBucket}/${key}`;
			if (shorten) {
				return await urlShortenerService.shorten(fallbackUrl);
			}
			return fallbackUrl;
		}
	}

	/**
	 * Gera uma Presigned URL já encurtada via Sink (https://s.moothz.win)
	 * @param {string} fileNameOrKey - Nome do arquivo ou chave completa
	 * @param {Object} options - { bucket, expiresIn, groupId, category }
	 * @returns {Promise<string>} URL encurtada ou presigned original
	 */
	async getShortPresignedUrl(fileNameOrKey, options = {}) {
		return this.getPresignedUrl(fileNameOrKey, { ...options, shorten: true });
	}

	/**
	 * Remove downloads expirados do HD secundário no bucket downloads
	 * @param {number} maxAgeHours
	 * @returns {Promise<number>} Quantidade de arquivos removidos
	 */
	async cleanupExpiredDownloads(maxAgeHours = this.downloadsRetentionHours) {
		if (!this.enabled || !this.client) return 0;

		const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
		const now = Date.now();
		let deletedCount = 0;
		let continuationToken = null;

		try {
			do {
				const listCmd = new ListObjectsV2Command({
					Bucket: this.bucketDownloads,
					ContinuationToken: continuationToken
				});
				const listRes = await this.client.send(listCmd);

				if (listRes.Contents && listRes.Contents.length > 0) {
					const expiredObjects = listRes.Contents.filter(
						(obj) => obj.LastModified && now - new Date(obj.LastModified).getTime() > maxAgeMs
					).map((obj) => ({ Key: obj.Key }));

					if (expiredObjects.length > 0) {
						await this.client.send(
							new DeleteObjectsCommand({
								Bucket: this.bucketDownloads,
								Delete: { Objects: expiredObjects }
							})
						);
						deletedCount += expiredObjects.length;
					}
				}

				continuationToken = listRes.NextContinuationToken;
			} while (continuationToken);

			if (deletedCount > 0) {
				this.logger.info(
					`[cleanupExpiredDownloads] ${deletedCount} arquivos expirados removidos de ${this.bucketDownloads}`
				);
			}
			return deletedCount;
		} catch (err) {
			this.logger.warn(
				`Erro na limpeza de downloads expirados (${this.bucketDownloads}):`,
				err.message
			);
			return 0;
		}
	}

	/**
	 * Verifica existência de um objeto no S3
	 */
	async exists(fileNameOrKey, { groupId, category, bucket } = {}) {
		const targetBucket = bucket || this.bucket;

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
					Bucket: targetBucket,
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
	async delete(fileNameOrKey, { groupId, category, bucket } = {}) {
		const targetBucket = bucket || this.bucket;
		const key = this.buildKey(fileNameOrKey, { groupId, category });

		if (this.enabled && this.client) {
			try {
				await this.client.send(
					new DeleteObjectCommand({
						Bucket: targetBucket,
						Key: key
					})
				);
				this.logger.debug(`[delete] Objeto removido do S3 (${targetBucket}): ${key}`);
			} catch (err) {
				this.logger.warn(`Erro ao deletar objeto do S3 (${targetBucket}/${key}):`, err.message);
			}
		}

		// Remove também do cache se existir
		await this._removeFromCache(key, targetBucket);
	}

	/**
	 * Deleta todos os arquivos sob o prefixo de um grupo no S3
	 * @param {string} groupId
	 * @param {string} bucket
	 */
	async deleteGroup(groupId, bucket) {
		const targetBucket = bucket || this.bucket;
		if (!this.enabled || !this.client || !groupId) return 0;

		const prefix = `${groupId}/`;
		this.logger.info(
			`[deleteGroup] Deletando todos os objetos do grupo: ${prefix} (${targetBucket})`
		);

		let deletedCount = 0;
		let continuationToken = null;

		try {
			do {
				const listCmd = new ListObjectsV2Command({
					Bucket: targetBucket,
					Prefix: prefix,
					ContinuationToken: continuationToken
				});
				const listRes = await this.client.send(listCmd);

				if (listRes.Contents && listRes.Contents.length > 0) {
					const objectsToDelete = listRes.Contents.map((obj) => ({ Key: obj.Key }));
					await this.client.send(
						new DeleteObjectsCommand({
							Bucket: targetBucket,
							Delete: { Objects: objectsToDelete }
						})
					);
					deletedCount += objectsToDelete.length;
				}

				continuationToken = listRes.NextContinuationToken;
			} while (continuationToken);

			this.logger.info(
				`[deleteGroup] Total de ${deletedCount} objetos removidos para ${groupId} em ${targetBucket}`
			);
			return deletedCount;
		} catch (err) {
			this.logger.error(`Erro ao deletar grupo ${groupId} do S3 (${targetBucket}):`, err);
			throw err;
		}
	}

	/**
	 * Calcula o total de bytes e objetos consumidos por um grupo no S3
	 * @param {string} groupId
	 * @param {string} bucket
	 */
	async getGroupUsage(groupId, bucket) {
		const targetBucket = bucket || this.bucket;
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
					Bucket: targetBucket,
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
			this.logger.error(`Erro ao calcular uso do grupo ${groupId} em ${targetBucket}:`, err);
			return { bytes: 0, count: 0 };
		}
	}

	/**
	 * Lista todos os objetos sob um determinado prefixo no bucket
	 * @param {string} prefix
	 * @param {string} bucket
	 * @returns {Promise<Array<{ key: string, size: number, lastModified: Date }>>}
	 */
	async listObjects(prefix = "", bucket) {
		const targetBucket = bucket || this.bucket;
		if (!this.enabled || !this.client) return [];

		const results = [];
		let continuationToken = null;

		try {
			do {
				const listCmd = new ListObjectsV2Command({
					Bucket: targetBucket,
					Prefix: prefix,
					ContinuationToken: continuationToken
				});
				const listRes = await this.client.send(listCmd);

				if (listRes.Contents) {
					for (const obj of listRes.Contents) {
						results.push({
							key: obj.Key,
							size: obj.Size || 0,
							lastModified: obj.LastModified
						});
					}
				}

				continuationToken = listRes.NextContinuationToken;
			} while (continuationToken);

			return results;
		} catch (err) {
			this.logger.error(`Erro ao listar objetos no S3 (${targetBucket}/${prefix}):`, err);
			return [];
		}
	}

	/**
	 * Remove múltiplos objetos de uma vez do S3
	 * @param {string[]} keys
	 * @param {string} bucket
	 * @returns {Promise<number>}
	 */
	async deleteObjects(keys = [], bucket) {
		const targetBucket = bucket || this.bucket;
		if (!this.enabled || !this.client || !keys || keys.length === 0) return 0;

		try {
			const chunks = [];
			for (let i = 0; i < keys.length; i += 1000) {
				chunks.push(keys.slice(i, i + 1000));
			}

			let totalDeleted = 0;
			for (const chunk of chunks) {
				const deleteCmd = new DeleteObjectsCommand({
					Bucket: targetBucket,
					Delete: { Objects: chunk.map((k) => ({ Key: k })) }
				});
				await this.client.send(deleteCmd);
				totalDeleted += chunk.length;
			}
			return totalDeleted;
		} catch (err) {
			this.logger.error(`Erro ao deletar múltiplos objetos no S3 (${targetBucket}):`, err);
			return 0;
		}
	}

	// ── Métodos de Cache Efêmero ──

	_cacheKey(keyOrFileName, bucket) {
		const prefix = bucket && bucket !== this.bucketMedia ? `${bucket}_` : "";
		return `${prefix}${keyOrFileName}`.replace(/[^a-zA-Z0-9._-]/g, "_");
	}

	async _getFromCache(fileNameOrKey, bucket) {
		if (!this.localCacheEnabled) return null;
		try {
			const safeName = this._cacheKey(fileNameOrKey, bucket);
			const cacheFilePath = path.join(this.cacheDir, safeName);
			if (fs.existsSync(cacheFilePath)) {
				const stat = await fsPromises.stat(cacheFilePath);
				// TTL no cache local configurável
				if (Date.now() - stat.mtimeMs < this.localCacheTtlHours * 60 * 60 * 1000) {
					return await fsPromises.readFile(cacheFilePath);
				}
			}
		} catch {
			// Ignora falhas no cache
		}
		return null;
	}

	async _saveToCache(fileNameOrKey, buffer, bucket) {
		if (!this.localCacheEnabled) return;
		try {
			if (!buffer || buffer.length > 50 * 1024 * 1024) return; // Limite de 50MB por item no cache
			const safeName = this._cacheKey(fileNameOrKey, bucket);
			const cacheFilePath = path.join(this.cacheDir, safeName);
			await fsPromises.writeFile(cacheFilePath, buffer);
		} catch {
			// Ignora falhas no cache
		}
	}

	async _removeFromCache(fileNameOrKey, bucket) {
		try {
			const safeName = this._cacheKey(fileNameOrKey, bucket);
			const cacheFilePath = path.join(this.cacheDir, safeName);
			if (fs.existsSync(cacheFilePath)) {
				await fsPromises.unlink(cacheFilePath);
			}
		} catch {
			// Ignora falhas
		}
	}

	/**
	 * Remove arquivos expirados ou além da cota máxima do cache efêmero local
	 */
	async pruneExpiredCache() {
		try {
			if (!fs.existsSync(this.cacheDir)) return 0;
			const files = await fsPromises.readdir(this.cacheDir);
			if (files.length === 0) return 0;

			const now = Date.now();
			const maxAgeMs = this.localCacheTtlHours * 60 * 60 * 1000;
			const maxSizeBytes = this.localCacheMaxMb * 1024 * 1024;
			let totalSize = 0;
			let prunedCount = 0;
			const fileStats = [];

			for (const file of files) {
				const filePath = path.join(this.cacheDir, file);
				try {
					const stat = await fsPromises.stat(filePath);
					if (now - stat.mtimeMs > maxAgeMs) {
						await fsPromises.unlink(filePath).catch(() => {});
						prunedCount++;
					} else {
						totalSize += stat.size;
						fileStats.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs });
					}
				} catch {
					// Ignora arquivos já deletados
				}
			}

			// Se ainda exceder a cota máxima em MB, elimina os mais antigos (LRU)
			if (totalSize > maxSizeBytes && fileStats.length > 0) {
				fileStats.sort((a, b) => a.mtimeMs - b.mtimeMs);
				for (const item of fileStats) {
					if (totalSize <= maxSizeBytes) break;
					await fsPromises.unlink(item.filePath).catch(() => {});
					totalSize -= item.size;
					prunedCount++;
				}
			}

			if (prunedCount > 0) {
				this.logger.info(`[pruneExpiredCache] ${prunedCount} arquivos purgados do cache S3 local`);
			}
			return prunedCount;
		} catch (err) {
			this.logger.warn("Erro ao purgar cache local:", err.message);
			return 0;
		}
	}
}

// Exporta instância singleton e classe
const storageService = new StorageService();
module.exports = storageService;
module.exports.StorageService = StorageService;
