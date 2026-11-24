process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";
process.env.BOTAPI_USER = "admin";
process.env.BOTAPI_PASSWORD = "senha-teste";

const assert = require("assert");
const { EventEmitter } = require("events");
const express = require("express");
const Database = require("../utils/Database");
const BotAPI = require("../BotAPI");
const WhatsAppBotGo = require("../WhatsAppBotGo");

const AVISO = "Atualmente nenhuma instância criada, use o botão criar para iniciar";
const CRIAR = "recreate/rav-teste?onlyIfMissing=1";
const ACELERACAO = 600;
const MINUTO = 60 * 1000;
const auth = `Basic ${Buffer.from("admin:senha-teste").toString("base64")}`;
const realSetTimeout = global.setTimeout;
const passar = (minutos) =>
	new Promise((resolve) => realSetTimeout(resolve, (minutos * MINUTO) / ACELERACAO));

let botApi;
let baseUrl;

function escutar(app) {
	return new Promise((resolve) => {
		const server = app.listen(0, "127.0.0.1", () => resolve(server.address().port));
	});
}

function portao() {
	let abrir;
	const fechado = new Promise((resolve) => {
		abrir = resolve;
	});
	return { fechado, abrir };
}

async function novoCenario({ existe, ...opcoes }) {
	const estado = { existe, escritas: [], sessao: { Connected: true, LoggedIn: false }, ...opcoes };
	const app = express();
	app.use((req, res, next) => {
		if (req.method !== "GET") estado.escritas.push(`${req.method} ${req.path}`);
		next();
	});
	app.get("/instance/all", async (req, res) => {
		if (estado.responderLista) return estado.responderLista(res);
		const data = estado.existe ? [{ id: "id-1", name: "rav-teste", jid: "x" }] : [];
		await estado.segurarLista;
		res.json({ message: "success", data });
	});
	app.post("/instance/create", (req, res) => {
		estado.antesDeCriar?.();
		if (estado.falhaAoCriar) return res.status(500).json({ error: estado.falhaAoCriar });
		if (estado.existe) return res.status(500).json({ error: "instance already exists" });
		estado.existe = true;
		res.json({ message: "success" });
	});
	app.use((req, res, next) => {
		if (!estado.existe) return res.status(401).json({ error: "not authorized" });
		next();
	});
	app.delete("/instance/delete/:id", (req, res) => {
		estado.existe = false;
		res.json({ message: "success" });
	});
	app.get("/instance/status", async (req, res) => {
		const { sessao } = estado;
		await estado.segurarStatus;
		if (estado.falhaNoStatus) return res.status(500).json({ error: "erro" });
		res.json({ data: sessao });
	});
	app.post("/instance/pair", (req, res) => res.json({ data: { PairingCode: "ABCD-1234" } }));
	app.get("/instance/qr", (req, res) => res.json({ data: { Code: "2@ficticio" } }));
	app.put("/instance/:id/advanced-settings", (req, res) =>
		res.status(estado.falhaNosAjustes ? 500 : 200).json({ message: "ajustes" })
	);
	app.use((req, res) => res.json({ message: "success", data: {} }));
	const bot = new WhatsAppBotGo({
		id: "rav-teste",
		phoneNumber: "5511999990001",
		whatsgoApiUrl: `http://127.0.0.1:${await escutar(app)}`,
		whatsgoApiKey: "chave-teste",
		webhookHost: "127.0.0.1"
	});
	botApi.bots.splice(0, botApi.bots.length, bot);
	const webhook = (event) => bot._handleWebhook({ body: { event, data: {} } }, { sendStatus() {} });
	return { estado, webhook };
}

async function novoDesconectado() {
	const { estado, webhook } = await novoCenario({
		existe: true,
		sessao: { Connected: false, LoggedIn: false }
	});
	await webhook("Connected");
	await webhook("LoggedOut");
	await passar(0.5);
	estado.escritas.length = 0;
	return estado;
}

async function pedir(rota) {
	const caminho = rota.includes("/") ? rota : `${rota}/rav-teste`;
	const res = await fetch(`${baseUrl}/${caminho}`, { headers: { authorization: auth } });
	return { status: res.status, corpo: await res.json() };
}

async function abrirPagina() {
	const res = await fetch(`${baseUrl}/qrcode/rav-teste`, { headers: { authorization: auth } });
	assert.strictEqual(res.status, 200);
	const html = await res.text();
	const tela = html.slice(html.indexOf("<body>"), html.indexOf("<script>"));
	const botoes = [...tela.matchAll(/<button class="btn-(?!refresh)[^>]*>([^<]*)</g)];
	return { tela, botoes: botoes.map((b) => b[1].trim()) };
}

const contar = (estado, trecho) => estado.escritas.filter((e) => e.includes(trecho)).length;
const apagou = (estado) => contar(estado, "DELETE /instance/delete");
const criou = (estado) => contar(estado, "POST /instance/create");

async function conferirRecusa(estado, rota, instanceExists) {
	const existia = estado.existe;
	const { status, corpo } = await pedir(rota);
	assert.deepStrictEqual(estado.escritas, []);
	assert.strictEqual(estado.existe, existia);
	assert.strictEqual(status, 409);
	assert.strictEqual(corpo.instanceExists, instanceExists);
	assert.ok(corpo.message);
	return corpo;
}

async function conferirPedidoDuranteALimpeza(rota) {
	const estado = await novoDesconectado();
	await passar(13);
	const status = portao();
	estado.segurarStatus = status.fechado;
	await passar(3);
	const lista = portao();
	estado.segurarLista = lista.fechado;
	const resposta = pedir(rota);
	await passar(1);
	status.abrir();
	estado.segurarStatus = null;
	await passar(1);
	lista.abrir();
	estado.segurarLista = null;
	const { status: codigo } = await resposta;
	await passar(5);
	assert.strictEqual(apagou(estado), 0, "a limpeza apagou a instância de quem pediu para conectar");
	assert.strictEqual(criou(estado), 0, "outra instância foi criada");
	return codigo;
}

const listasEstranhas = {
	"erro 500": (res) => res.status(500).json({ error: "erro" }),
	"erro 401": (res) => res.status(401).json({ error: "not authorized" }),
	"objeto sem data": (res) => res.json({}),
	"data nulo": (res) => res.json({ message: "success", data: null }),
	"data texto": (res) => res.json({ message: "success", data: "texto" }),
	"data objeto": (res) => res.json({ message: "success", data: {} }),
	html: (res) => res.type("html").send("<html>bad gateway</html>"),
	"corpo vazio": (res) => res.status(200).end()
};

const cenarios = {
	"reconectar sem instância avisa e não escreve na WhatsGoAPI": async () => {
		const { estado } = await novoCenario({ existe: false });
		const corpo = await conferirRecusa(estado, "reconnect", false);
		assert.strictEqual(corpo.message, AVISO);
	},
	"iniciar a conexão sem instância avisa e não escreve na WhatsGoAPI": async () => {
		const { estado } = await novoCenario({ existe: false });
		const corpo = await conferirRecusa(estado, "qrcode-initconnect", false);
		assert.strictEqual(corpo.message, AVISO);
	},
	"reconectar com instância segue reconectando": async () => {
		const { estado } = await novoCenario({ existe: true });
		const { status, corpo } = await pedir("reconnect");
		assert.strictEqual(status, 200);
		assert.strictEqual(corpo.status, "ok");
		assert.ok(estado.escritas.includes("POST /instance/connect"));
	},
	"Criar sem instância cria uma sem apagar, e o pareamento passa a iniciar": async () => {
		const { estado } = await novoCenario({ existe: false });
		const { status, corpo } = await pedir(CRIAR);
		assert.strictEqual(status, 200);
		assert.strictEqual(corpo.status, "ok");
		assert.strictEqual(apagou(estado), 0);
		assert.strictEqual(criou(estado), 1);
		const conexao = await pedir("qrcode-initconnect");
		assert.strictEqual(conexao.status, 200);
		assert.strictEqual(conexao.corpo.instanceExists, true);
		assert.strictEqual(conexao.corpo.extra.connectData.pairingCode, "ABCD-1234");
	},
	"criar com a marca sem valor também não apaga": async () => {
		const { estado } = await novoCenario({ existe: true });
		for (const marca of ["onlyIfMissing=", "onlyIfMissing"]) {
			await conferirRecusa(estado, `recreate/rav-teste?${marca}`, true);
		}
	},
	"Criar com instância na lista é recusado sem apagar": async () => {
		const { estado } = await novoCenario({ existe: true });
		await conferirRecusa(estado, CRIAR, true);
	},
	"Criar com instância na lista é recusado mesmo com erro no status": async () => {
		const { estado } = await novoCenario({ existe: true, falhaNoStatus: true });
		await conferirRecusa(estado, CRIAR, true);
	},
	"Criar com instância fora da lista, mas com status, é recusado sem apagar": async () => {
		const { estado } = await novoCenario({
			existe: true,
			responderLista: (res) => res.json({ data: [] })
		});
		await conferirRecusa(estado, CRIAR, true);
	},
	"Criar com a lista lenta é recusado se a instância apareceu no meio": async () => {
		const lista = portao();
		const { estado } = await novoCenario({ existe: false, segurarLista: lista.fechado });
		const resposta = pedir(CRIAR);
		await passar(1);
		estado.existe = true;
		lista.abrir();
		assert.strictEqual((await resposta).status, 409);
		assert.deepStrictEqual(estado.escritas, []);
		assert.strictEqual(estado.existe, true);
	},
	"Criar mostra o erro e não apaga se a instância apareceu depois da checagem": async () => {
		const { estado } = await novoCenario({ existe: false });
		estado.antesDeCriar = () => {
			estado.existe = true;
		};
		const { status, corpo } = await pedir(CRIAR);
		assert.strictEqual(status, 500);
		assert.match(corpo.message, /already exists/);
		assert.strictEqual(apagou(estado), 0);
		assert.strictEqual(estado.existe, true);
	},
	"Criar mostra o erro quando a criação falha": async () => {
		const { estado } = await novoCenario({ existe: false, falhaAoCriar: "falha fictícia" });
		const { status, corpo } = await pedir(CRIAR);
		assert.strictEqual(status, 500);
		assert.strictEqual(corpo.status, "error");
		assert.match(corpo.message, /falha fictícia/);
		assert.strictEqual(apagou(estado), 0);
	},
	"Criar conta como criada mesmo se os ajustes da instância falharem": async () => {
		const { estado } = await novoCenario({ existe: false, falhaNosAjustes: true });
		assert.strictEqual((await pedir(CRIAR)).corpo.status, "ok");
		assert.strictEqual(estado.existe, true);
	},
	"Criar com erro no status é recusado": async () => {
		const { estado } = await novoCenario({
			existe: true,
			falhaNoStatus: true,
			responderLista: (res) => res.json({ data: [] })
		});
		await conferirRecusa(estado, CRIAR, null);
	},
	"Recriar, com a confirmação da tela, segue apagando e criando": async () => {
		const { estado } = await novoCenario({ existe: true });
		assert.strictEqual((await pedir("recreate")).status, 200);
		assert.strictEqual(apagou(estado), 1);
		assert.strictEqual(criou(estado), 1);
		assert.strictEqual(estado.existe, true);
	},
	"página sem instância mostra o aviso e só o botão Criar": async () => {
		await novoCenario({ existe: false });
		const { tela, botoes } = await abrirPagina();
		assert.ok(tela.includes(AVISO), "faltou o aviso");
		assert.deepStrictEqual(botoes, ["Criar"]);
		assert.strictEqual((await pedir("qrcode-status")).corpo.instanceExists, false);
	},
	"página com instância mantém Recriar, sem o aviso": async () => {
		await novoCenario({ existe: true });
		const { tela, botoes } = await abrirPagina();
		assert.ok(!tela.includes(AVISO));
		assert.deepStrictEqual(botoes, ["Tentar Reconectar", "Recriar", "Desconectar"]);
		assert.strictEqual((await pedir("qrcode-status")).corpo.instanceExists, true);
	},
	"página de bot conectado mantém os botões mesmo se a instância sumir da WhatsGoAPI": async () => {
		const { estado, webhook } = await novoCenario({ existe: true });
		await webhook("Connected");
		await passar(0.5);
		estado.existe = false;
		const { botoes } = await abrirPagina();
		assert.deepStrictEqual(botoes, ["Desconectar", "Tentar Reconectar", "Recriar"]);
	},
	"página com a instância fora da lista, mas com status, mantém Recriar": async () => {
		await novoCenario({ existe: true, responderLista: (res) => res.json({ data: [] }) });
		const { tela, botoes } = await abrirPagina();
		assert.ok(!tela.includes(AVISO));
		assert.ok(botoes.includes("Recriar"));
	},
	...Object.fromEntries(
		Object.entries(listasEstranhas).map(([nome, responderLista]) => [
			`lista com resposta estranha (${nome}) não vira falta de instância`,
			async () => {
				const { estado } = await novoCenario({ existe: true, responderLista });
				assert.strictEqual((await pedir("qrcode-status")).corpo.instanceExists, null);
				const { tela, botoes } = await abrirPagina();
				assert.ok(!tela.includes(AVISO));
				assert.deepStrictEqual(botoes, ["Tentar Reconectar", "Recriar", "Desconectar"]);
				estado.escritas.length = 0;
				await conferirRecusa(estado, CRIAR, null);
				assert.notStrictEqual((await pedir("reconnect")).status, 409);
				assert.strictEqual(apagou(estado), 0);
			}
		])
	),
	"reconectar enquanto a limpeza confere não deixa apagar nem cria outra": async () => {
		assert.strictEqual(await conferirPedidoDuranteALimpeza("reconnect"), 200);
	},
	"iniciar a conexão enquanto a limpeza confere não deixa apagar nem cria outra": async () => {
		assert.strictEqual(await conferirPedidoDuranteALimpeza("qrcode-initconnect"), 200);
	},
	"Criar enquanto a limpeza confere é recusado e não deixa apagar": async () => {
		assert.strictEqual(await conferirPedidoDuranteALimpeza(CRIAR), 409);
	},
	"limpeza que já estava marcada espera 15 min pela instância nova": async () => {
		const estado = await novoDesconectado();
		await passar(8);
		estado.existe = false;
		assert.strictEqual((await pedir(CRIAR)).status, 200);
		await passar(11);
		assert.strictEqual(apagou(estado), 0);
		await passar(12);
		assert.strictEqual(apagou(estado), 1);
	},
	"reconectar recusado não marca limpeza para a instância criada depois": async () => {
		const estado = await novoDesconectado();
		estado.existe = false;
		await passar(20);
		await conferirRecusa(estado, "reconnect", false);
		await conferirRecusa(estado, "qrcode-initconnect", false);
		assert.strictEqual((await pedir(CRIAR)).status, 200);
		await passar(25);
		assert.strictEqual(apagou(estado), 0);
	}
};

async function main() {
	Database.getInstance({ disableBackup: true, testMode: true });
	botApi = new BotAPI({ port: 5986, bots: [], eventHandler: new EventEmitter() });
	await botApi.start();
	baseUrl = "http://127.0.0.1:5986";
	global.setTimeout = (fn, ms = 0, ...args) => realSetTimeout(fn, ms / ACELERACAO, ...args);

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
