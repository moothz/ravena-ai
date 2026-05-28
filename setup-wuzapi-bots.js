/**
 * setup-wuzapi-bots.js
 * Cria e configura instâncias no wuzapi a partir de bots.json.
 *
 * Uso:
 *   node setup-wuzapi-bots.js [modo]
 *
 * Modos:
 *   create   — Cria instâncias que ainda não existem (padrão)
 *   qr       — Mostra QR code para instâncias pendentes
 *   webhook  — Configura webhooks nas instâncias conectadas
 *   all      — Executa create + webhook em sequência
 *
 * Requisitos:
 *   - WUZAPI_URL no .env (ex: http://wuzapi:8080 ou http://localhost:9810)
 *   - WUZAPI_ADMIN_TOKEN no .env
 *   - API_PORT no .env (porta do ravena-ai para webhooks)
 *   - bots.json no diretório raiz
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ────────────────────────────────────────────────────────────
// Configuração
// ────────────────────────────────────────────────────────────

const botsPath = path.join(__dirname, "bots.json");
const envPath = path.join(__dirname, ".env");

// Carrega .env manualmente (sem dotenv, para funcionar sem dependências extras)
function loadEnv() {
	if (!fs.existsSync(envPath)) {
		console.error("⚠️  Arquivo .env não encontrado. Copie .env.example para .env.");
		process.exit(1);
	}

	const content = fs.readFileSync(envPath, "utf-8");
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIndex = trimmed.indexOf("=");
		if (eqIndex === -1) continue;
		const key = trimmed.slice(0, eqIndex).trim();
		let value = trimmed.slice(eqIndex + 1).trim();
		// Remove aspas se presentes
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (!process.env[key]) {
			process.env[key] = value;
		}
	}
}

loadEnv();

const WUZAPI_URL = process.env.WUZAPI_URL || "http://wuzapi:8080";
const WUZAPI_ADMIN_TOKEN = process.env.WUZAPI_ADMIN_TOKEN;
const API_PORT = process.env.API_PORT || "5000";
const HOSTNAME = process.env.WUZAPI_WEBHOOK_HOST || "ravena-ai";
// Webhook global: todas as instâncias usam a mesma URL.
// O campo 'instanceName' no payload identifica de qual instância veio o evento.
const GLOBAL_WEBHOOK_URL = `http://${HOSTNAME}:${API_PORT}/wuzapi/webhook`;

if (!WUZAPI_ADMIN_TOKEN) {
	console.error("⚠️  WUZAPI_ADMIN_TOKEN não configurado no .env");
	process.exit(1);
}

// Carrega bots.json
let bots = [];
if (fs.existsSync(botsPath)) {
	bots = JSON.parse(fs.readFileSync(botsPath, "utf-8"));
}

// Filtra apenas bots WhatsApp habilitados
const whatsappBots = bots.filter((b) => b.enabled && !b.useDiscord && !b.useTelegram);

// ────────────────────────────────────────────────────────────
// Cliente HTTP genérico para wuzapi
// ────────────────────────────────────────────────────────────

function wuzapiRequest(method, endpoint, body = null) {
	return new Promise((resolve, reject) => {
		const url = new URL(endpoint, WUZAPI_URL);
		const isHttps = url.protocol === "https:";
		const lib = isHttps ? https : http;

		const options = {
			hostname: url.hostname,
			port: url.port || (isHttps ? 443 : 80),
			path: url.pathname + url.search,
			method,
			headers: {
				"X-Auth-Token": WUZAPI_ADMIN_TOKEN,
				"Content-Type": "application/json"
			}
		};

		const req = lib.request(options, (res) => {
			let data = "";
			res.on("data", (chunk) => (data += chunk));
			res.on("end", () => {
				try {
					const json = JSON.parse(data);
					resolve({ status: res.statusCode, body: json });
				} catch {
					resolve({ status: res.statusCode, body: data });
				}
			});
		});

		req.on("error", reject);
		req.setTimeout(30000, () => {
			req.destroy(new Error("Timeout"));
		});

		if (body) {
			req.write(JSON.stringify(body));
		}
		req.end();
	});
}

// ────────────────────────────────────────────────────────────
// Helper: gerar webhook secret
// ────────────────────────────────────────────────────────────

function generateSecret(length = 32) {
	return crypto.randomBytes(length).toString("hex");
}

// ────────────────────────────────────────────────────────────
// Modo: create — Cria instâncias
// ────────────────────────────────────────────────────────────

async function modeCreate() {
	console.log("\n📦 Modo: CREATE — Criando instâncias no wuzapi\n");

	for (const bot of whatsappBots) {
		const instanceName = bot.nome;

		console.log(`\n🔹 Instância: ${instanceName}`);

		// Verifica se já existe
		const check = await wuzapiRequest("GET", "/api/instances").catch(() => null);
		if (check?.body?.instances) {
			const exists = check.body.instances.find(
				(i) => i.name === instanceName || i.Name === instanceName
			);
			if (exists) {
				console.log(`  ⏭️  Instância '${instanceName}' já existe. Pulando.`);
				continue;
			}
		}

		// Cria instância
		console.log("  📡 Criando instância...");
		const result = await wuzapiRequest("POST", "/api/create-instance", {
			name: instanceName
		}).catch((err) => {
			console.error(`  ❌ Erro ao criar instância:`, err.message);
			return null;
		});

		if (result?.status === 200 || result?.status === 201) {
			console.log("  ✅ Instância criada com sucesso!");
		} else {
			console.error("  ❌ Falha ao criar instância:", result);
		}
	}

	console.log("\n✅ Modo create concluído.");
}

// ────────────────────────────────────────────────────────────
// Modo: qr — Mostra QR code
// ────────────────────────────────────────────────────────────

async function modeQr() {
	console.log("\n📱 Modo: QR — Verificando QR codes pendentes\n");

	for (const bot of whatsappBots) {
		const instanceName = bot.nome;

		console.log(`\n🔹 Instância: ${instanceName}`);

		// Busca QR code
		const result = await wuzapiRequest(
			"GET",
			`/api/get-qr?name=${encodeURIComponent(instanceName)}`
		).catch(() => null);

		if (result?.body?.qr) {
			console.log("  📱 QR Code disponível! Escaneie com o WhatsApp:");
			console.log(`  ${result.body.qr}`);
		} else if (result?.body?.code) {
			console.log(`  🔑 Código de pareamento: ${result.body.code}`);
		} else {
			console.log("  ℹ️  Nenhum QR code pendente.");
		}
	}

	console.log("\n✅ Modo qr concluído.");
}

// ────────────────────────────────────────────────────────────
// Modo: webhook — Configura webhooks
// ────────────────────────────────────────────────────────────

async function modeWebhook() {
	console.log("\n🪝 Modo: WEBHOOK — Configurando webhook global\n");
	console.log(`  Todas as instâncias usarão a mesma URL:`);
	console.log(`  ${GLOBAL_WEBHOOK_URL}`);
	console.log(`  O campo 'instanceName' no payload identifica a instância.\n`);

	// Configura webhook global via wuzapi
	// Isso define o webhook padrão para todas as instâncias existentes e futuras
	const result = await wuzapiRequest("POST", "/webhook", {
		webhookURL: GLOBAL_WEBHOOK_URL
	}).catch((err) => {
		console.error(`  ❌ Erro ao configurar webhook global:`, err.message);
		return null;
	});

	if (result?.status === 200) {
		console.log("  ✅ Webhook global configurado!");
	} else {
		console.error("  ❌ Falha ao configurar webhook global:", result);
	}

	// Também configura webhook individual por instância (caso o global não se aplique a instâncias já criadas)
	for (const bot of whatsappBots) {
		const instanceName = bot.nome;

		console.log(`\n🔹 Instância: ${instanceName}`);

		// Configura webhook por instância usando o mesmo endpoint global
		const result = await wuzapiRequest("POST", "/webhook", {
			webhookURL: GLOBAL_WEBHOOK_URL
		}).catch((err) => {
			console.error(`  ❌ Erro ao configurar webhook para '${instanceName}':`, err.message);
			return null;
		});

		if (result?.status === 200) {
			console.log(`  ✅ Webhook configurado para '${instanceName}'!`);
		} else {
			console.error(`  ❌ Falha ao configurar webhook para '${instanceName}':`, result);
		}
	}

	console.log("\n✅ Modo webhook concluído.");
}

// ────────────────────────────────────────────────────────────
// Modo: all — create + webhook
// ────────────────────────────────────────────────────────────

async function modeAll() {
	await modeCreate();
	await sleep(2000);
	await modeWebhook();
}

// ────────────────────────────────────────────────────────────
// Utilitários
// ────────────────────────────────────────────────────────────

function saveBots() {
	fs.writeFileSync(botsPath, JSON.stringify(bots, null, 2), "utf-8");
	console.log("  💾 bots.json atualizado.");
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────

const MODES = {
	create: modeCreate,
	qr: modeQr,
	webhook: modeWebhook,
	all: modeAll
};

async function main() {
	const mode = process.argv[2]?.toLowerCase() || "create";

	console.log("╔══════════════════════════════════════════╗");
	console.log("║   Setup Wuzapi Bots                      ║");
	console.log("╚══════════════════════════════════════════╝");
	console.log(`  WUZAPI_URL: ${WUZAPI_URL}`);
	console.log(`  Instâncias WhatsApp: ${whatsappBots.length}`);
	console.log(`  Modo: ${mode}`);

	if (whatsappBots.length === 0) {
		console.log("\n⚠️  Nenhuma instância WhatsApp habilitada no bots.json.");
		console.log("    Adicione entradas com 'enabled': true e sem useDiscord/useTelegram.");
		return;
	}

	const handler = MODES[mode];
	if (!handler) {
		console.error(`\n❌ Modo desconhecido: ${mode}`);
		console.log("   Modos disponíveis: create, qr, webhook, all");
		process.exit(1);
	}

	await handler();
}

main().catch((err) => {
	console.error("\n❌ Erro inesperado:", err);
	process.exit(1);
});
