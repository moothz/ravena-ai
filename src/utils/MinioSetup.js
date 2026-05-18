const { exec } = require("child_process");
const Logger = require("./Logger");

class MinioSetup {
	constructor() {
		this.logger = new Logger("MinioSetup");
		this.enabled = process.env.MINIO_ENABLED === "true";
		this.endpoint = process.env.MINIO_ENDPOINT || "minio:9000";
		this.accessKey = process.env.MINIO_ACCESS_KEY;
		this.secretKey = process.env.MINIO_SECRET_KEY;
		this.bucket = process.env.MINIO_BUCKET || "zap-media";
		this.retentionDays = parseInt(process.env.MINIO_RETENTION_DAYS) || 0;
		this.storageLimitGb = parseInt(process.env.MINIO_STORAGE_LIMIT_GB) || 0;
	}

	/**
	 * Configura o MinIO com as políticas de retenção e quota
	 */
	async init() {
		if (!this.enabled) {
			this.logger.debug("MinIO está desativado. Pulando configuração.");
			return;
		}

		if (!this.accessKey || !this.secretKey) {
			this.logger.warn("MinIO habilitado mas credenciais não encontradas. Verifique .env");
			return;
		}

		// Pequeno delay para garantir que o container minio já subiu e aceita conexões
		await new Promise((resolve) => setTimeout(resolve, 5000));

		this.logger.info("Verificando políticas do MinIO...");

		try {
			// Validar se o mc está instalado e funcional
			await this.execute("mc --version").catch((e) => {
				throw new Error("MinIO Client (mc) não encontrado ou corrompido: " + e.message);
			});

			// 1. Configurar o alias no 'mc'

			const protocol = process.env.MINIO_USE_SSL === "true" ? "https" : "http";
			const aliasCmd = `mc alias set ravena ${protocol}://${this.endpoint} ${this.accessKey} ${this.secretKey}`;

			await this.execute(aliasCmd);

			// 2. Configurar Retenção (Lifecycle) se habilitado
			if (this.retentionDays > 0) {
				this.logger.info(
					`Configurando retenção de ${this.retentionDays} dias para o bucket ${this.bucket}...`
				);

				// Remove regras anteriores para evitar duplicatas e aplica a nova
				await this.execute(`mc ilm rm --all --force ravena/${this.bucket}`).catch(() => {});
				await this.execute(`mc ilm add --expiry-days ${this.retentionDays} ravena/${this.bucket}`);
			}

			// 3. Configurar Quota se habilitada
			if (this.storageLimitGb > 0) {
				this.logger.info(
					`Configurando limite de ${this.storageLimitGb}GB para o bucket ${this.bucket}...`
				);
				await this.execute(`mc quota set ravena/${this.bucket} --size ${this.storageLimitGb}GB`);
			}

			this.logger.info("Configurações do MinIO aplicadas.");
		} catch (error) {
			// Silenciamos o erro se for apenas "bucket não existe ainda", pois a whatsgoapi cria ele no primeiro upload
			if (error.message.includes("does not exist")) {
				this.logger.debug(
					"Bucket ainda não existe, as políticas serão aplicadas na próxima inicialização."
				);
			} else {
				this.logger.error("Erro ao configurar MinIO:", error.message);
			}
		}
	}

	execute(command) {
		return new Promise((resolve, reject) => {
			exec(command, (error, stdout, stderr) => {
				if (error) {
					reject(new Error(stderr || stdout || error.message));
					return;
				}
				resolve(stdout);
			});
		});
	}
}

module.exports = new MinioSetup();
