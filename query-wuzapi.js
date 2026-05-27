/**
 * query-wuzapi.js
 *
 * Utilitário para testar chamadas HTTP ao wuzapi.
 * Uso: node query-wuzapi.js <acao> [parametros...]
 *
 * Exemplos:
 *   node query-wuzapi.js status
 *   node query-wuzapi.js send 120363023456789012@g.us "Olá!"
 *   node query-wuzapi.js send-media 120363023456789012@g.us ./data/test-image.png image
 *   node query-wuzapi.js groups
 *   node query-wuzapi.js profiles 5511999999999@s.whatsapp.net
 *   node query-wuzapi.js presence 120363023456789012@g.us composing
 *   node query-wuzapi.js mark-read 120363023456789012@g.us msg-id
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");

const WUZAPI_URL = process.env.WUZAPI_URL || "http://localhost:3000";
const WUZAPI_TOKEN = process.env.WUZAPI_TOKEN || "bot-user-token-1";
const WUZAPI_USER = process.env.WUZAPI_USER || "ravena-bot";

function makeRequest(method, endpoint, body = null) {
	return new Promise((resolve, reject) => {
		const fullUrl = `${WUZAPI_URL}${endpoint}`;
		const parsedUrl = new URL(fullUrl);

		const options = {
			hostname: parsedUrl.hostname,
			port: parsedUrl.port,
			path: parsedUrl.pathname + parsedUrl.search,
			method,
			headers: {
				"X-User-Token": WUZAPI_TOKEN,
				"X-User-Name": WUZAPI_USER
			}
		};

		const client = parsedUrl.protocol === "https:" ? https : http;
		const req = client.request(options, (res) => {
			let data = "";
			res.on("data", (chunk) => (data += chunk));
			res.on("end", () => {
				console.log(`\n[${res.statusCode}] ${method} ${endpoint}`);
				try {
					console.log(JSON.stringify(JSON.parse(data), null, 2));
					resolve(JSON.parse(data));
				} catch {
					console.log(data);
					resolve(data);
				}
			});
		});

		req.on("error", (err) => {
			console.error(`Erro: ${err.message}`);
			reject(err);
		});

		if (body) {
			const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
			options.headers["Content-Type"] = "application/json";
			req.write(bodyStr);
		}

		req.end();
	});
}

async function status() {
	return makeRequest("GET", "/api/status");
}

async function send(remoteJid, content) {
	const body = {
		remoteJid,
		content,
		options: {
			delay: 1200,
			linkPreview: false
		}
	};
	return makeRequest("POST", "/api/send-message", body);
}

async function sendMedia(remoteJid, filePath, type) {
	if (!fs.existsSync(filePath)) {
		console.error(`Arquivo não encontrado: ${filePath}`);
		return;
	}

	const data = fs.readFileSync(filePath);
	const base64 = data.toString("base64");
	const filename = path.basename(filePath);

	const body = {
		remoteJid,
		type,
		content: "",
		options: {
			base64,
			filename,
			caption: `Enviado via query-wuzapi.js`
		}
	};
	return makeRequest("POST", "/api/send-media", body);
}

async function reply(remoteJid, content, quotedMessageJid) {
	const body = {
		remoteJid,
		content,
		options: {
			delay: 1200,
			quotedMessage: {
				jid: quotedMessageJid
			}
		}
	};
	return makeRequest("POST", "/api/send-message", body);
}

async function groups() {
	return makeRequest("GET", "/api/groups");
}

async function profiles(participant) {
	return makeRequest("GET", `/api/profiles?participant=${participant}`);
}

async function presence(remoteJid, state) {
	const body = {
		remoteJid,
		state
	};
	return makeRequest("POST", "/api/presence", body);
}

async function markRead(remoteJid, messageKey) {
	const body = {
		remoteJid,
		keys: [
			{
				remoteJid,
				id: messageKey,
				fromMe: false
			}
		]
	};
	return makeRequest("POST", "/api/mark-read", body);
}

async function react(remoteJid, keyId, reaction) {
	const body = {
		remoteJid,
		keyId,
		reaction
	};
	return makeRequest("POST", "/api/react", body);
}

async function main() {
	const action = process.argv[2];
	const args = process.argv.slice(3);

	if (!action) {
		console.log(`
query-wuzapi.js — Utilitário para testar chamadas ao wuzapi

Uso: node query-wuzapi.js <acao> [parametros...]

Ações disponíveis:
  status                                     Status do wuzapi
  send <remoteJid> <texto>                   Enviar mensagem de texto
  send-media <remoteJid> <caminho> <tipo>    Enviar mídia (image, audio, video, document)
  reply <remoteJid> <texto> <quotedJid>      Responder mensagem
  groups                                     Listar grupos
  profiles <participant>                     Buscar perfis
  presence <remoteJid> <state>               Enviar presença (composing, paused)
  mark-read <remoteJid> <messageKey>         Marcar mensagem como lida
  react <remoteJid> <keyId> <emoji>          Reagir a mensagem

Variáveis de ambiente:
  WUZAPI_URL  URL base do wuzapi (padrão: http://localhost:3000)
  WUZAPI_TOKEN  Token do usuário (padrão: bot-user-token-1)
  WUZAPI_USER   Nome do usuário (padrão: ravena-bot)
`);
		return;
	}

	switch (action) {
		case "status":
			await status();
			break;
		case "send":
			if (args.length < 2) {
				console.error("Uso: node query-wuzapi.js send <remoteJid> <texto>");
				process.exit(1);
			}
			await send(args[0], args.slice(1).join(" "));
			break;
		case "send-media":
			if (args.length < 3) {
				console.error("Uso: node query-wuzapi.js send-media <remoteJid> <caminho> <tipo>");
				process.exit(1);
			}
			await sendMedia(args[0], args[1], args[2]);
			break;
		case "reply":
			if (args.length < 3) {
				console.error("Uso: node query-wuzapi.js reply <remoteJid> <texto> <quotedJid>");
				process.exit(1);
			}
			await reply(args[0], args.slice(1, -1).join(" "), args[args.length - 1]);
			break;
		case "groups":
			await groups();
			break;
		case "profiles":
			if (args.length < 1) {
				console.error("Uso: node query-wuzapi.js profiles <participant>");
				process.exit(1);
			}
			await profiles(args[0]);
			break;
		case "presence":
			if (args.length < 2) {
				console.error("Uso: node query-wuzapi.js presence <remoteJid> <state>");
				process.exit(1);
			}
			await presence(args[0], args[1]);
			break;
		case "mark-read":
			if (args.length < 2) {
				console.error("Uso: node query-wuzapi.js mark-read <remoteJid> <messageKey>");
				process.exit(1);
			}
			await markRead(args[0], args[1]);
			break;
		case "react":
			if (args.length < 3) {
				console.error("Uso: node query-wuzapi.js react <remoteJid> <keyId> <emoji>");
				process.exit(1);
			}
			await react(args[0], args[1], args[2]);
			break;
		default:
			console.error(`Ação desconhecida: ${action}`);
			process.exit(1);
	}
}

main().catch(console.error);