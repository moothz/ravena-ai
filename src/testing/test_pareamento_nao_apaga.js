process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";
process.env.BOTAPI_USER = "admin";
process.env.BOTAPI_PASSWORD = "senha-teste";

const assert = require("assert");
const { EventEmitter } = require("events");
const http = require("http");
const express = require("express");
const Database = require("../utils/Database");
const BotAPI = require("../BotAPI");
const WhatsAppBotGo = require("../WhatsAppBotGo");

const ACELERACAO = 600;
const MINUTO = 60 * 1000;
const realSetTimeout = global.setTimeout;
const realNow = Date.now;
const passar = (minutos) =>
	new Promise((resolve) => realSetTimeout(resolve, (minutos * MINUTO) / ACELERACAO));

function acelerarRelogio() {
	const inicio = realNow();
	Date.now = () => inicio + (realNow() - inicio) * ACELERACAO;
	global.setTimeout = (fn, ms = 0, ...args) => realSetTimeout(fn, ms / ACELERACAO, ...args);
}

function escutar(app) {
	return new Promise((resolve) => {
		const server = app.listen(0, "127.0.0.1", () => resolve(server.address().port));
	});
}

async function criarWhatsgoFalsa() {
	const estado = {
		existe: true,
		sessao: { Connected: true, LoggedIn: true },
		apagou: 0,
		conectou: 0,
		reconectou: 0
	};
	const app = express();
	app.use(express.json());
	app.get("/instance/all", (req, res) =>
		res.json({ data: estado.existe ? [{ id: "id-1", name: "rav-teste" }] : [] })
	);
	app.get("/instance/status", (req, res) =>
		estado.existe ? res.json({ data: estado.sessao }) : res.status(401).json({ message: "sem" })
	);
	app.delete("/instance/delete/:id", (req, res) => {
		estado.apagou++;
		estado.existe = false;
		res.json({ message: "success" });
	});
	app.post("/instance/connect", (req, res) => {
		estado.conectou++;
		res.json({ message: "success" });
	});
	app.post("/instance/reconnect", (req, res) => {
		estado.reconectou++;
		res.json({ message: "success" });
	});
	app.use((req, res) => res.json({ message: "success", data: {} }));
	return { estado, url: `http://127.0.0.1:${await escutar(app)}` };
}

let botApi;
let baseUrl;
const auth = `Basic ${Buffer.from("admin:senha-teste").toString("base64")}`;

async function novoCenario() {
	const { estado, url } = await criarWhatsgoFalsa();
	const bot = new WhatsAppBotGo({
		id: "rav-teste",
		phoneNumber: "5511999990001",
		whatsgoApiUrl: url,
		whatsgoApiKey: "chave-teste",
		webhookHost: "127.0.0.1"
	});
	botApi.bots.splice(0, botApi.bots.length, bot);
	const webhook = (event) => bot._handleWebhook({ body: { event, data: {} } }, { sendStatus() {} });
	await webhook("Connected");
	estado.sessao = { Connected: false, LoggedIn: false };
	await webhook("LoggedOut");
	return { estado, webhook };
}

async function abrirTela() {
	const req = http.get(`${baseUrl}/qrcode-stream/rav-teste`, { headers: { authorization: auth } });
	const res = await new Promise((resolve, reject) =>
		req.on("response", resolve).on("error", reject)
	);
	assert.strictEqual(res.statusCode, 200);
	res.on("error", () => {});
	res.resume();
	return async () => {
		req.destroy();
		await passar(0.2);
	};
}

async function iniciarPareamento() {
	const res = await fetch(`${baseUrl}/qrcode-initconnect/rav-teste`, {
		headers: { authorization: auth }
	});
	assert.strictEqual(res.status, 200);
}

function conferirApagadas({ apagou }, esperado) {
	assert.strictEqual(apagou, esperado, `DELETE na whatsgoapi: ${apagou}, esperado ${esperado}`);
}

const cenarios = {
	"fechar a tela depois de 15 min desconectada não apaga a instância": async () => {
		const { estado } = await novoCenario();
		await passar(1);
		const fechar = await abrirTela();
		await iniciarPareamento();
		await passar(20);
		await fechar();
		await passar(5);
		conferirApagadas(estado, 0);
		assert.ok(estado.conectou > 0, "o pareamento iniciou a conexão");
	},
	"recarregar a tela depois de 15 min não apaga a instância": async () => {
		const { estado } = await novoCenario();
		const fechar = await abrirTela();
		await passar(20);
		await fechar();
		const fecharDeNovo = await abrirTela();
		await passar(20);
		conferirApagadas(estado, 0);
		await fecharDeNovo();
	},
	"abrir e fechar a tela não apaga uma sessão autenticada": async () => {
		const { estado } = await novoCenario();
		estado.sessao = { Connected: false, LoggedIn: true };
		const fechar = await abrirTela();
		await passar(1);
		await fechar();
		await passar(25);
		conferirApagadas(estado, 0);
		assert.ok(estado.reconectou > 0, "a limpeza tentou reconectar a sessão");
	},
	"abrir e fechar a tela sem limpeza pendente não apaga a instância": async () => {
		const { estado } = await novoCenario();
		estado.sessao = { Connected: false, LoggedIn: true };
		await passar(25);
		estado.sessao = { Connected: false, LoggedIn: false };
		const fechar = await abrirTela();
		await iniciarPareamento();
		await fechar();
		await passar(25);
		conferirApagadas(estado, 0);
	},
	"sem ninguém na tela, 15 min sem sessão apagam a instância uma vez": async () => {
		const { estado } = await novoCenario();
		await passar(13);
		conferirApagadas(estado, 0);
		await passar(25);
		conferirApagadas(estado, 1);
	},
	"quem saiu da tela sem parear tem a instância limpa 15 min depois": async () => {
		const { estado } = await novoCenario();
		const fechar = await abrirTela();
		await iniciarPareamento();
		await passar(10);
		await fechar();
		await passar(12);
		conferirApagadas(estado, 0);
		await passar(6);
		conferirApagadas(estado, 1);
	},
	"iniciar o pareamento sem o stream adia a limpeza, sem cancelar": async () => {
		const { estado } = await novoCenario();
		await passar(10);
		await iniciarPareamento();
		await passar(12);
		conferirApagadas(estado, 0);
		await passar(6);
		conferirApagadas(estado, 1);
	},
	"parear com a tela aberta cancela a limpeza": async () => {
		const { estado, webhook } = await novoCenario();
		const fechar = await abrirTela();
		await passar(20);
		estado.sessao = { Connected: true, LoggedIn: true };
		await webhook("Connected");
		await fechar();
		estado.sessao = { Connected: false, LoggedIn: false };
		await passar(25);
		conferirApagadas(estado, 0);
	}
};

async function main() {
	Database.getInstance({ disableBackup: true, testMode: true });
	botApi = new BotAPI({ port: 5987, bots: [], eventHandler: new EventEmitter() });
	await botApi.start();
	baseUrl = "http://127.0.0.1:5987";
	acelerarRelogio();

	let falhas = 0;
	for (const [nome, cenario] of Object.entries(cenarios)) {
		try {
			await cenario();
			console.log(`✓ ${nome}`);
		} catch (err) {
			falhas++;
			console.error(`✗ ${nome}: ${err.message}`);
		}
	}
	console.log(`${Object.keys(cenarios).length - falhas} passaram, ${falhas} falharam`);
	process.exit(falhas ? 1 : 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
