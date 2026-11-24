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
		falharStatus: false,
		falharDelete: false,
		esperarStatus: null,
		apagou: 0,
		conectou: 0,
		reconectou: 0
	};
	const app = express();
	app.use(express.json());
	app.get("/instance/all", (req, res) =>
		res.json({ data: estado.existe ? [{ id: "id-1", name: "rav-teste" }] : [] })
	);
	app.get("/instance/status", async (req, res) => {
		const { sessao } = estado;
		await estado.esperarStatus;
		if (estado.falharStatus) return res.status(500).json({ message: "erro" });
		if (!estado.existe) return res.status(401).json({ message: "sem" });
		res.json({ data: sessao });
	});
	app.delete("/instance/delete/:id", (req, res) => {
		if (estado.falharDelete) return res.status(500).json({ message: "erro" });
		estado.apagou++;
		estado.existe = false;
		res.json({ message: "success" });
	});
	app.post("/instance/create", (req, res) => {
		estado.existe = true;
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

function segurarStatus(estado) {
	let soltar;
	estado.esperarStatus = new Promise((resolve) => {
		soltar = resolve;
	});
	return async () => {
		estado.esperarStatus = null;
		soltar();
		await passar(0.5);
	};
}

async function abrirTela(corpo) {
	const req = http.request(`${baseUrl}/qrcode-stream/rav-teste`, {
		headers: {
			authorization: auth,
			...(corpo && { "content-type": "application/json", "content-length": corpo.length })
		}
	});
	req.end(corpo);
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

async function abrirTelaQueCaiAntesDeCarregar() {
	const [atender] = botApi.server.listeners("request");
	botApi.server.off("request", atender);
	const atendida = new Promise((resolve) => {
		botApi.server.once("request", (req, res) => {
			res.once("close", () => {
				atender(req, res);
				resolve();
			});
			res.socket.destroy();
		});
	});
	const cliente = http.get(`${baseUrl}/qrcode-stream/rav-teste`, {
		headers: { authorization: auth },
		agent: false
	});
	cliente.on("error", () => {});
	await atendida;
	botApi.server.on("request", atender);
}

async function pedir(rota) {
	const res = await fetch(`${baseUrl}/${rota}/rav-teste`, { headers: { authorization: auth } });
	assert.strictEqual(res.status, 200);
}

const iniciarPareamento = () => pedir("qrcode-initconnect");

function conferirApagadas({ apagou }, esperado) {
	assert.strictEqual(apagou, esperado, `DELETE na whatsgoapi: ${apagou}, esperado ${esperado}`);
}

async function esperarLimpeza(estado, esperado, minutos) {
	for (let i = 0; i < minutos && estado.apagou < esperado; i++) await passar(1);
	conferirApagadas(estado, esperado);
}

async function conferirLimpezaAos15Min(estado) {
	const antes = estado.apagou;
	await passar(12);
	conferirApagadas(estado, antes);
	await esperarLimpeza(estado, antes + 1, 15);
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
	"sem limpeza pendente, sair da tela sem parear limpa 15 min depois": async () => {
		const { estado } = await novoCenario();
		estado.sessao = { Connected: false, LoggedIn: true };
		await passar(25);
		estado.sessao = { Connected: false, LoggedIn: false };
		const fechar = await abrirTela();
		await iniciarPareamento();
		await fechar();
		await conferirLimpezaAos15Min(estado);
	},
	"sem limpeza pendente, sair da tela não apaga uma sessão autenticada": async () => {
		const { estado } = await novoCenario();
		estado.sessao = { Connected: false, LoggedIn: true };
		await passar(25);
		const fechar = await abrirTela();
		await fechar();
		const reconexoes = estado.reconectou;
		await passar(25);
		conferirApagadas(estado, 0);
		assert.ok(estado.reconectou > reconexoes, "a limpeza tentou reconectar a sessão");
	},
	"mais de 15 min na tela e sair sem parear limpa 15 min depois": async () => {
		const { estado } = await novoCenario();
		const fechar = await abrirTela();
		await iniciarPareamento();
		await passar(40);
		await fechar();
		await conferirLimpezaAos15Min(estado);
	},
	"tentar reconectar na tela e sair sem parear limpa 15 min depois": async () => {
		const { estado } = await novoCenario();
		const fechar = await abrirTela();
		await iniciarPareamento();
		await pedir("reconnect");
		await fechar();
		await conferirLimpezaAos15Min(estado);
	},
	"recriar a instância já limpa e sair sem parear limpa de novo 15 min depois": async () => {
		const { estado } = await novoCenario();
		await esperarLimpeza(estado, 1, 28);
		await pedir("recreate");
		const fechar = await abrirTela();
		await iniciarPareamento();
		await fechar();
		await conferirLimpezaAos15Min(estado);
	},
	"reconectar a instância já limpa e sair sem parear limpa de novo 15 min depois": async () => {
		const { estado } = await novoCenario();
		await esperarLimpeza(estado, 1, 28);
		await pedir("reconnect");
		const fechar = await abrirTela();
		await iniciarPareamento();
		await fechar();
		await conferirLimpezaAos15Min(estado);
	},
	"tela que caiu antes de carregar não segura a limpeza": async () => {
		const { estado } = await novoCenario();
		await abrirTelaQueCaiAntesDeCarregar();
		await conferirLimpezaAos15Min(estado);
	},
	"tela que caiu antes de carregar agenda a limpeza que faltava": async () => {
		const { estado } = await novoCenario();
		await esperarLimpeza(estado, 1, 28);
		await pedir("recreate");
		await abrirTelaQueCaiAntesDeCarregar();
		await conferirLimpezaAos15Min(estado);
	},
	"tela aberta por requisição com corpo conta como aberta até sair": async () => {
		const { estado } = await novoCenario();
		const fechar = await abrirTela("{}");
		await passar(40);
		conferirApagadas(estado, 0);
		await fechar();
		await conferirLimpezaAos15Min(estado);
	},
	"status com erro no disparo não apaga e tenta de novo 15 min depois": async () => {
		const { estado } = await novoCenario();
		estado.falharStatus = true;
		await passar(40);
		conferirApagadas(estado, 0);
		estado.falharStatus = false;
		await esperarLimpeza(estado, 1, 28);
	},
	"status sem resposta no disparo não apaga e tenta de novo 15 min depois": async () => {
		const { estado } = await novoCenario();
		await passar(13);
		const soltar = segurarStatus(estado);
		await passar(10);
		estado.esperarStatus = null;
		await esperarLimpeza(estado, 1, 20);
		await pedir("recreate");
		await soltar();
		await passar(10);
		conferirApagadas(estado, 1);
	},
	"tela aberta durante a consulta do status não apaga": async () => {
		const { estado } = await novoCenario();
		await passar(13);
		const soltar = segurarStatus(estado);
		await passar(5);
		const fechar = await abrirTela();
		await soltar();
		conferirApagadas(estado, 0);
		await fechar();
		await conferirLimpezaAos15Min(estado);
	},
	"tela aberta e fechada durante a consulta do status recomeça a contagem": async () => {
		const { estado } = await novoCenario();
		await passar(13);
		const soltar = segurarStatus(estado);
		await passar(5);
		const fechar = await abrirTela();
		await fechar();
		await soltar();
		await conferirLimpezaAos15Min(estado);
	},
	"parear durante a consulta do status não apaga": async () => {
		const { estado, webhook } = await novoCenario();
		await passar(13);
		const soltar = segurarStatus(estado);
		await passar(5);
		estado.sessao = { Connected: true, LoggedIn: true };
		await webhook("Connected");
		await soltar();
		await passar(25);
		conferirApagadas(estado, 0);
	},
	"falha ao apagar tenta de novo 15 min depois": async () => {
		const { estado } = await novoCenario();
		estado.falharDelete = true;
		await passar(17);
		estado.falharDelete = false;
		await esperarLimpeza(estado, 1, 25);
	},
	"instância limpa e recriada sem passar pela tela não é apagada de novo": async () => {
		const { estado } = await novoCenario();
		await esperarLimpeza(estado, 1, 28);
		await pedir("recreate");
		await passar(40);
		conferirApagadas(estado, 1);
	},
	"instância que já não existe encerra a limpeza": async () => {
		const { estado } = await novoCenario();
		estado.existe = false;
		await passar(20);
		estado.existe = true;
		await passar(40);
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
		await conferirLimpezaAos15Min(estado);
	},
	"iniciar o pareamento sem o stream adia a limpeza, sem cancelar": async () => {
		const { estado } = await novoCenario();
		await passar(10);
		await iniciarPareamento();
		await conferirLimpezaAos15Min(estado);
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
