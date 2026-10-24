const crypto = require("crypto");
const axios = require("axios");
const Logger = require("./Logger");

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

/**
 * Configura o storage S3 de mídia da whatsgoapi (RustFS, ou qualquer servidor compatível com S3).
 * Usa a API S3 diretamente (assinatura SigV4), sem depender de binários externos (mc, aws-cli).
 * As variáveis S3_* têm prioridade; MINIO_* são aceitas como fallback para retrocompatibilidade
 * com a whatsgoapi (que usa o cliente minio-go e lê MINIO_*).
 */
class S3Setup {
	constructor() {
		this.logger = new Logger("S3Setup");
		// S3_* tem prioridade; cai para MINIO_* se não definido (retrocompatibilidade com whatsgoapi)
		this.enabled = (process.env.S3_ENABLED ?? process.env.MINIO_ENABLED) === "true";
		this.endpoint = process.env.S3_ENDPOINT || process.env.MINIO_ENDPOINT || "rustfs:9000";
		this.accessKey = process.env.S3_ACCESS_KEY || process.env.MINIO_ACCESS_KEY;
		this.secretKey = process.env.S3_SECRET_KEY || process.env.MINIO_SECRET_KEY;
		this.bucket = process.env.S3_BUCKET || process.env.MINIO_BUCKET || "zap-media";
		this.region = process.env.S3_REGION || process.env.MINIO_REGION || "us-east-1";
		this.protocol = (process.env.S3_USE_SSL || process.env.MINIO_USE_SSL) === "true" ? "https" : "http";
		this.retentionDays = parseInt(process.env.S3_RETENTION_DAYS || process.env.MINIO_RETENTION_DAYS) || 0;
		this.storageLimitGb = parseInt(process.env.S3_STORAGE_LIMIT_GB || process.env.MINIO_STORAGE_LIMIT_GB) || 0;
	}

	/**
	 * Garante que o bucket existe e aplica a política de retenção (lifecycle)
	 */
	async init() {
		if (!this.enabled) {
			this.logger.debug("Storage S3 está desativado. Pulando configuração.");
			return;
		}

		if (!this.accessKey || !this.secretKey) {
			this.logger.warn("Storage S3 habilitado mas credenciais não encontradas. Verifique .env");
			return;
		}

		// Pequeno delay para garantir que o container do storage já subiu e aceita conexões
		await new Promise((resolve) => setTimeout(resolve, 5000));

		this.logger.info("Verificando políticas do storage S3...");

		try {
			const head = await this.request("HEAD", "");
			if (head.status === 404) {
				// A whatsgoapi também cria o bucket no primeiro upload; criar aqui permite aplicar a retenção já
				const created = await this.request("PUT", "");
				if (created.status >= 300)
					throw new Error(`criar bucket: HTTP ${created.status} ${created.data}`);
				this.logger.info(`Bucket ${this.bucket} criado.`);
			} else if (head.status >= 300) {
				throw new Error(`verificar bucket: HTTP ${head.status}`);
			}

			if (this.retentionDays > 0) {
				this.logger.info(
					`Configurando retenção de ${this.retentionDays} dias para o bucket ${this.bucket}...`
				);
				const body =
					'<?xml version="1.0" encoding="UTF-8"?>' +
					'<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
					"<Rule><ID>ravena-expiry</ID><Status>Enabled</Status><Filter><Prefix></Prefix></Filter>" +
					`<Expiration><Days>${this.retentionDays}</Days></Expiration></Rule>` +
					"</LifecycleConfiguration>";
				// PUT substitui a configuração inteira, então não acumula regras duplicadas
				const res = await this.request("PUT", "lifecycle=", body, {
					"content-md5": crypto.createHash("md5").update(body).digest("base64"),
					"content-type": "application/xml"
				});
				if (res.status >= 300) throw new Error(`lifecycle: HTTP ${res.status} ${res.data}`);
			}

			if (this.storageLimitGb > 0) {
				// Quota não faz parte da API S3; cada servidor configura do seu jeito
				this.logger.warn(
					"S3_STORAGE_LIMIT_GB não é aplicado automaticamente: configure a quota no próprio storage."
				);
			}

			this.logger.info("Configurações do storage S3 aplicadas.");
		} catch (error) {
			this.logger.error("Erro ao configurar storage S3:", error.message);
		}
	}

	/**
	 * Requisição S3 path-style assinada com AWS Signature V4
	 * @param {string} method
	 * @param {string} query - query string canônica (ex: "lifecycle=")
	 * @param {string} [body]
	 * @param {Object} [extraHeaders] - nomes em minúsculo
	 */
	async request(method, query, body = "", extraHeaders = {}) {
		const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
		const day = amzDate.slice(0, 8);
		const uri = `/${encodeURIComponent(this.bucket)}`;
		const headers = {
			...extraHeaders,
			host: this.endpoint,
			"x-amz-content-sha256": sha256(body),
			"x-amz-date": amzDate
		};
		const names = Object.keys(headers).sort();
		const canonicalRequest = [
			method,
			uri,
			query,
			names.map((n) => `${n}:${String(headers[n]).trim()}\n`).join(""),
			names.join(";"),
			headers["x-amz-content-sha256"]
		].join("\n");
		const scope = `${day}/${this.region}/s3/aws4_request`;
		const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
		let key = hmac(`AWS4${this.secretKey}`, day);
		for (const part of [this.region, "s3", "aws4_request"]) key = hmac(key, part);
		const signature = crypto.createHmac("sha256", key).update(stringToSign).digest("hex");

		const { host, ...sendHeaders } = headers;
		sendHeaders.authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;

		return axios({
			method,
			url: `${this.protocol}://${host}${uri}${query ? `?${query}` : ""}`,
			data: body || undefined,
			headers: sendHeaders,
			timeout: 15000,
			responseType: "text",
			transformRequest: [(d) => d],
			validateStatus: () => true
		});
	}
}

module.exports = new S3Setup();
