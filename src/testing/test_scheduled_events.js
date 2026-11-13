process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const http = require("http");
const express = require("express");
const bodyParser = require("body-parser");
const BetterSqlite3 = require("better-sqlite3");

// Evita conexões de banco reais em /app/data usando adapter better-sqlite3 em memória para os testes unitários/integração
const memCoreDb = new BetterSqlite3(":memory:");
const memSlotsDb = new BetterSqlite3(":memory:");
const memFishingDb = new BetterSqlite3(":memory:");

memSlotsDb.exec(
	"CREATE TABLE IF NOT EXISTS slots_users (user_id TEXT PRIMARY KEY, coins INTEGER DEFAULT 0)"
);
memSlotsDb.run = undefined;
memSlotsDb.prepare("INSERT INTO slots_users (user_id, coins) VALUES ('u1', 100)").run();

memFishingDb.exec(
	"CREATE TABLE IF NOT EXISTS fishing_users (user_id TEXT PRIMARY KEY, baits INTEGER DEFAULT 0, last_bait_regen INTEGER)"
);
memFishingDb.exec(
	"CREATE TABLE IF NOT EXISTS fishing_buffs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, effect_type TEXT, is_debuff INTEGER, value REAL, min_value REAL, max_value REAL, remaining_uses INTEGER, original_name TEXT)"
);
memFishingDb
	.prepare("INSERT INTO fishing_users (user_id, baits, last_bait_regen) VALUES ('u1', 5, 0)")
	.run();

const CoreRepository = require("../utils/db/repositories/CoreRepository");
const Database = require("../utils/Database");

function createMemoryMappers() {
	const dbs = {
		core: memCoreDb,
		custom_commands: new BetterSqlite3(":memory:"),
		load_reports: new BetterSqlite3(":memory:"),
		slots: memSlotsDb,
		fishing: memFishingDb
	};
	function getOrCreateDb(dbName) {
		if (!dbs[dbName]) {
			dbs[dbName] = new BetterSqlite3(":memory:");
		}
		return dbs[dbName];
	}
	return {
		_dbs: dbs,
		getOrCreateDb,
		exec(dbName, sql) {
			return getOrCreateDb(dbName).exec(sql);
		},
		run(dbName, sql, params = []) {
			const info = getOrCreateDb(dbName)
				.prepare(sql)
				.run(...params);
			return {
				lastInsertRowid: info.lastInsertRowid,
				lastID: info.lastInsertRowid,
				changes: info.changes
			};
		},
		get(dbName, sql, params = []) {
			return getOrCreateDb(dbName)
				.prepare(sql)
				.get(...params);
		},
		all(dbName, sql, params = []) {
			return getOrCreateDb(dbName)
				.prepare(sql)
				.all(...params);
		}
	};
}

function httpRequest(port, method, reqPath, { body = null, headers = {} } = {}) {
	return new Promise((resolve, reject) => {
		const payload = body !== null ? JSON.stringify(body) : null;
		const reqHeaders = { ...headers };
		if (payload) {
			reqHeaders["Content-Type"] = "application/json";
			reqHeaders["Content-Length"] = Buffer.byteLength(payload);
		}
		const req = http.request(
			{
				hostname: "127.0.0.1",
				port,
				path: reqPath,
				method,
				headers: reqHeaders
			},
			(res) => {
				let raw = "";
				res.on("data", (c) => {
					raw += c;
				});
				res.on("end", () => {
					let json = null;
					try {
						json = JSON.parse(raw);
					} catch (_e) {}
					resolve({ status: res.statusCode, body: raw, json, headers: res.headers });
				});
			}
		);
		req.on("error", reject);
		if (payload) req.write(payload);
		req.end();
	});
}

async function runTests() {
	console.log("=== Iniciando Testes: Eventos Programados + Fazenda Auto-Daily ===");

	const memMappers = createMemoryMappers();
	const memCoreRepo = new CoreRepository(memMappers);

	// Injeta database isolado em memória antes de inicializar serviços
	const fakeDatabase = {
		coreRepo: memCoreRepo,
		mappers: memMappers,
		botInstances: [],
		triggerBackupStart() {},
		getSQLiteDb(dbName, schemaSql = null) {
			memMappers.getOrCreateDb(dbName);
			if (schemaSql) {
				try {
					memMappers.exec(dbName, schemaSql);
				} catch (_e) {}
			}
			return {
				run(sql, params, cb) {
					if (typeof params === "function") {
						cb = params;
						params = [];
					}
					try {
						const r = memMappers.run(dbName, sql, params || []);
						cb?.call({ lastID: r.lastInsertRowid, changes: r.changes }, null);
					} catch (e) {
						cb?.(e);
					}
				},
				get(sql, params, cb) {
					if (typeof params === "function") {
						cb = params;
						params = [];
					}
					try {
						cb?.(null, memMappers.get(dbName, sql, params || []));
					} catch (e) {
						cb?.(e);
					}
				},
				all(sql, params, cb) {
					if (typeof params === "function") {
						cb = params;
						params = [];
					}
					try {
						cb?.(null, memMappers.all(dbName, sql, params || []));
					} catch (e) {
						cb?.(e);
					}
				},
				exec(sql, cb) {
					try {
						memMappers.exec(dbName, sql);
						cb?.(null);
					} catch (e) {
						cb?.(e);
					}
				},
				serialize(fn) {
					fn?.();
				},
				close(cb) {
					cb?.(null);
				}
			};
		},
		async dbRun(dbName, sql, params = []) {
			return memMappers.run(dbName, sql, params);
		},
		async dbGet(dbName, sql, params = []) {
			return memMappers.get(dbName, sql, params);
		},
		async dbAll(dbName, sql, params = []) {
			return memMappers.all(dbName, sql, params);
		},
		async saveGameEvent(ev) {
			return memCoreRepo.saveGameEvent(ev);
		},
		async deleteGameEvent(g, t) {
			return memCoreRepo.deleteGameEvent(g, t);
		},
		async getActiveGameEvents() {
			return memCoreRepo.getActiveGameEvents();
		},
		async getScheduledEvents(opts) {
			return memCoreRepo.getScheduledEvents(opts);
		},
		async getScheduledEventById(id) {
			return memCoreRepo.getScheduledEventById(id);
		},
		async createScheduledEvent(data) {
			return memCoreRepo.createScheduledEvent(data);
		},
		async updateScheduledEvent(id, data, opts) {
			return memCoreRepo.updateScheduledEvent(id, data, opts);
		},
		async deleteScheduledEvent(id) {
			return memCoreRepo.deleteScheduledEvent(id);
		},
		async getActiveScheduledEvents(now) {
			return memCoreRepo.getActiveScheduledEvents(now);
		},
		async getPendingStartScheduledEvents(now) {
			return memCoreRepo.getPendingStartScheduledEvents(now);
		},
		async claimScheduledEventStart(id, ts) {
			return memCoreRepo.claimScheduledEventStart(id, ts);
		}
	};

	Database.instance = fakeDatabase;

	const ScheduledEventService = require("../services/ScheduledEventService");
	const GameEventService = require("../services/GameEventService");
	const ShadowGardenClient = require("../services/ShadowGardenClient");
	const WaifuCommands = require("../functions/WaifuCommands");
	const FazendaCommands = require("../functions/FazendaCommands");

	const scheduledService = ScheduledEventService.getInstance();
	scheduledService.database = fakeDatabase;

	// 1. Validação rigorosa de payload
	console.log("1. Testando validação de payload e geração de mensagem...");
	assert.throws(
		() =>
			ScheduledEventService.validateEventPayload({
				name: "",
				startTime: "2026-11-20T10:00",
				endTime: "2026-11-21T10:00"
			}),
		/obrigatório/
	);
	assert.throws(
		() =>
			ScheduledEventService.validateEventPayload({
				name: "Teste Inválido",
				startTime: "2026-11-20T10:00",
				endTime: "2026-11-19T10:00"
			}),
		/posterior/
	);
	assert.throws(
		() =>
			ScheduledEventService.validateEventPayload({
				name: "Buff Negativo",
				startTime: "2026-11-20T10:00",
				endTime: "2026-11-21T10:00",
				ongoingBuffs: { "pesca.peso": -10 }
			}),
		/fora do limite/
	);
	assert.throws(
		() =>
			ScheduledEventService.validateEventPayload({
				name: "Buff Decimal",
				startTime: "2026-11-20T10:00",
				endTime: "2026-11-21T10:00",
				startGrants: { "slots.moedas": "12.5" }
			}),
		/inválido/
	);
	assert.throws(
		() =>
			ScheduledEventService.validateEventPayload({
				name: "Buff Desconhecido",
				startTime: "2026-11-20T10:00",
				endTime: "2026-11-21T10:00",
				ongoingBuffs: { "inexistente.x": 10 }
			}),
		/desconhecido/
	);

	const generatedMsg = ScheduledEventService.generateWhatsAppMessage({
		name: "Semana do Pescador",
		startTime: Date.parse("2026-11-20T12:00:00-03:00"),
		endTime: Date.parse("2026-11-22T18:00:00-03:00"),
		startGrants: { "pesca.iscas": 15, "slots.moedas": 50 },
		ongoingBuffs: { "pesca.peso": 40, "waifu.raros": 25 }
	});
	assert(generatedMsg.includes("EVENTO PROGRAMADO INICIADO"), "Deve conter header de início");
	assert(generatedMsg.includes("Semana do Pescador"), "Deve conter nome do evento");
	assert(generatedMsg.includes("2 dias e 6 horas"), "Deve conter duração em dias/horas");
	assert(generatedMsg.includes("22/11/2026 às 18:00"), "Deve conter data final em BRT");
	assert(generatedMsg.includes("+15 iscas"), "Deve listar bônus inicial");
	assert(generatedMsg.includes("+40%"), "Deve listar buff contínuo");
	console.log("✓ Validação e formatação da mensagem passaram!");

	// 2. Classificação de status (passado=cinza, ativo=verde, proximo=amarelo, outros=normal)
	console.log("2. Testando classificação de status (passado, ativo, proximo, normal)...");
	const refNow = Date.parse("2026-06-15T12:00:00-03:00");
	const classified = ScheduledEventService.classifyEvents(
		[
			{
				id: 4,
				name: "Natal Futuro",
				startTime: Date.parse("2026-12-20T00:00:00-03:00"),
				endTime: Date.parse("2026-12-26T00:00:00-03:00"),
				startGrants: {},
				ongoingBuffs: {}
			},
			{
				id: 1,
				name: "Carnaval Passado",
				startTime: Date.parse("2026-02-10T00:00:00-03:00"),
				endTime: Date.parse("2026-02-14T00:00:00-03:00"),
				startGrants: {},
				ongoingBuffs: {}
			},
			{
				id: 3,
				name: "São João Próximo",
				startTime: Date.parse("2026-06-24T00:00:00-03:00"),
				endTime: Date.parse("2026-06-26T00:00:00-03:00"),
				startGrants: {},
				ongoingBuffs: {}
			},
			{
				id: 2,
				name: "Junho Ativo",
				startTime: Date.parse("2026-06-14T00:00:00-03:00"),
				endTime: Date.parse("2026-06-16T00:00:00-03:00"),
				startGrants: {},
				ongoingBuffs: {}
			}
		],
		refNow
	);
	assert.deepStrictEqual(
		classified.map((e) => [e.name, e.status]),
		[
			["Carnaval Passado", "passado"],
			["Junho Ativo", "ativo"],
			["São João Próximo", "proximo"],
			["Natal Futuro", "normal"]
		]
	);
	console.log("✓ Classificação de status cronológica 100% correta!");

	// 3. Scheduler + Start Grants + GameEventService + Broadcast GRUPO_AVISOS (@newsletter) e GRUPO_ANUNCIOS (@g.us)
	console.log("3. Testando scheduler, aplicação de buffs/itens e envio WhatsApp...");
	process.env.GRUPO_AVISOS = "120363425083483471@newsletter";
	process.env.GRUPO_ANUNCIOS = "120363424275235658@g.us";

	const sentCalls = [];
	const mockBot = {
		id: "mock-wa-bot",
		useTelegram: false,
		isConnected: true,
		notificarDonate: true,
		async sendReturnMessages(msgs) {
			for (const m of msgs) sentCalls.push(m);
		}
	};

	let zinthosGranted = null;
	const adminGiveAllCalls = [];
	const origGrantZinthos = WaifuCommands.grantZinthosAll;
	const origAdminGiveAll = ShadowGardenClient.prototype.adminGiveAll;
	WaifuCommands.grantZinthosAll = async (amount) => {
		zinthosGranted = amount;
		return { count: 10 };
	};
	ShadowGardenClient.prototype.adminGiveAll = async (payload) => {
		adminGiveAllCalls.push(payload);
		return { playersAffected: 10 };
	};

	try {
		const tStart = Date.now() - 60000;
		const tEnd = Date.now() + 3600000;
		const created = await fakeDatabase.createScheduledEvent({
			name: "Evento Madrugada Ativo",
			startTime: tStart,
			endTime: tEnd,
			startGrants: {
				"slots.moedas": 50,
				"pesca.iscas": 12,
				"pesca.buff": 2,
				"waifu.zinthos": 300,
				"fazenda.moedas": 400
			},
			ongoingBuffs: {
				"pesca.peso": 35,
				"fazenda.fortuna": 50
			},
			message: ScheduledEventService.generateWhatsAppMessage({
				name: "Evento Madrugada Ativo",
				startTime: tStart,
				endTime: tEnd,
				startGrants: {
					"slots.moedas": 50,
					"pesca.iscas": 12,
					"pesca.buff": 2,
					"waifu.zinthos": 300,
					"fazenda.moedas": 400
				},
				ongoingBuffs: {
					"pesca.peso": 35,
					"fazenda.fortuna": 50
				}
			})
		});

		const activatedFirst = await scheduledService.processPendingStarts(Date.now(), {
			botOverride: mockBot
		});
		assert.strictEqual(activatedFirst.length, 1, "Deve iniciar exatamente 1 evento");

		// Segunda execução NÃO deve disparar novamente
		const activatedSecond = await scheduledService.processPendingStarts(Date.now(), {
			botOverride: mockBot
		});
		assert.strictEqual(activatedSecond.length, 0, "Não deve repetir início já processado");

		// Valida ganhos aplicados
		const slotsRow = memSlotsDb.prepare("SELECT coins FROM slots_users WHERE user_id = 'u1'").get();
		assert.strictEqual(slotsRow.coins, 150, "Slots deve receber +50 moedas (100 -> 150)");
		const fishRow = memFishingDb
			.prepare("SELECT baits FROM fishing_users WHERE user_id = 'u1'")
			.get();
		assert.strictEqual(fishRow.baits, 17, "Pesca deve receber +12 iscas (5 -> 17)");
		const buffRow = memFishingDb
			.prepare("SELECT remaining_uses FROM fishing_buffs WHERE user_id = 'u1'")
			.get();
		assert.strictEqual(buffRow.remaining_uses, 2, "Pesca deve receber buff com 2 usos");
		assert.strictEqual(zinthosGranted, 300, "Waifuletes deve receber +300 Zinthos");
		assert.strictEqual(adminGiveAllCalls[0].coins, 400, "Fazenda deve receber +400 Petalitas");

		// Valida buffs contínuos via GameEventService
		await GameEventService.init();
		assert.strictEqual(GameEventService.getMultiplier("pesca", "peso"), 1.35);
		assert.strictEqual(GameEventService.getMultiplier("fazenda", "fortuna"), 1.5);
		assert.ok(
			GameEventService.getEventBanner("pesca").includes("+35% peso nos peixes"),
			"Banner deve incluir buff do evento programado"
		);
		assert.ok(
			GameEventService.getActiveEvents().some((e) => e.game === "pesca" && e.type === "peso"),
			"!eventos deve incluir buffs do evento programado"
		);

		// Valida envio para GRUPO_AVISOS (@newsletter) e GRUPO_ANUNCIOS (@g.us)
		const sentChats = sentCalls.map((m) => m.chatId).sort();
		assert.deepStrictEqual(
			sentChats,
			["120363424275235658@g.us", "120363425083483471@newsletter"],
			"Deve enviar exatamente para GRUPO_ANUNCIOS e GRUPO_AVISOS (inclusive @newsletter)"
		);
		assert(sentCalls[0].content.includes("Evento Madrugada Ativo"));

		// Limpa evento do teste antes da suite HTTP
		await fakeDatabase.deleteScheduledEvent(created.id);
		await scheduledService.refreshActiveCache();
		console.log("✓ Scheduler, idempotência, buffs contínuos e broadcasts aprovados!");
	} finally {
		WaifuCommands.grantZinthosAll = origGrantZinthos;
		ShadowGardenClient.prototype.adminGiveAll = origAdminGiveAll;
	}

	// 4. Rotas BotAPI (/eventos, /eventos/admin, /api/events/*)
	console.log("4. Testando endpoints HTTP (/eventos, /eventos/admin, /api/events/*)...");
	const path = require("path");
	const {
		getAdminSessionSecret,
		createAdminSessionToken,
		isValidAdminSession,
		getCookie,
		setAdminSessionCookie,
		clearAdminSessionCookie,
		isAdmin,
		createAuthenticateBasic
	} = require("../BotAPI/middleware/auth");
	const { registerIndexRoutes } = require("../BotAPI/routes/indexRoutes");
	const registerEventsRoutes = require("../BotAPI/routes/eventsRoutes");

	const app = express();
	app.use(bodyParser.json());
	app.use(express.static(path.join(__dirname, "../../public")));

	process.env.BOTAPI_USER = "testadmin";
	process.env.BOTAPI_PASSWORD = "testsecretpassword";

	const apiMock = {
		app,
		bots: [],
		apiUser: "testadmin",
		apiPassword: "testsecretpassword",
		adminSessionSecret: "unit-test-secret",
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		getAdminSessionSecret: () => getAdminSessionSecret(apiMock),
		createAdminSessionToken: () => createAdminSessionToken(apiMock),
		isValidAdminSession: (t) => isValidAdminSession(apiMock, t),
		getCookie,
		setAdminSessionCookie: (res) => setAdminSessionCookie(apiMock, res),
		clearAdminSessionCookie,
		isAdmin: (req) => isAdmin(apiMock, req),
		getAvailableBots: () => [],
		checkServices: async () => ({})
	};
	apiMock.authenticateBasic = createAuthenticateBasic(apiMock);
	registerIndexRoutes(apiMock);
	registerEventsRoutes(apiMock);

	const server = await new Promise((resolve) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s));
	});
	const port = server.address().port;
	const authHeader = "Basic " + Buffer.from("testadmin:testsecretpassword").toString("base64");

	try {
		const pubHtml = await httpRequest(port, "GET", "/eventos");
		assert.strictEqual(pubHtml.status, 200);
		assert(pubHtml.body.includes("Calendário de Eventos Programados"));

		const admUnauth = await httpRequest(port, "GET", "/eventos/admin");
		assert.strictEqual(admUnauth.status, 401);

		const admAuth = await httpRequest(port, "GET", "/eventos/admin", {
			headers: { Authorization: authHeader }
		});
		assert.strictEqual(admAuth.status, 200);
		assert(admAuth.body.includes("Eventos Programados"));

		const apiUnauth = await httpRequest(port, "GET", "/api/events/admin");
		assert.strictEqual(apiUnauth.status, 401);

		const invalidCreate = await httpRequest(port, "POST", "/api/events/admin", {
			headers: { Authorization: authHeader },
			body: {
				name: "Inválido",
				startTime: "2026-12-10T10:00",
				endTime: "2026-12-12T10:00",
				ongoingBuffs: { "pesca.peso": 0 }
			}
		});
		assert.strictEqual(invalidCreate.status, 400);

		const validCreate = await httpRequest(port, "POST", "/api/events/admin", {
			headers: { Authorization: authHeader },
			body: {
				name: "Virada Ravena 2026",
				startTime: "2026-12-30T18:00",
				endTime: "2027-01-01T18:00",
				startGrants: { "waifu.rolls": 5, "fazenda.bags": 3 },
				ongoingBuffs: { "slots.vitoria": 30 }
			}
		});
		assert.strictEqual(validCreate.status, 201);
		const evId = validCreate.json.event.id;
		assert(validCreate.json.event.message.includes("Virada Ravena 2026"));
		assert(validCreate.json.event.message.includes("2 dias"));

		const genRes = await httpRequest(port, "POST", "/api/events/admin/generate-message", {
			headers: { Authorization: authHeader },
			body: { id: evId, save: false }
		});
		assert.strictEqual(genRes.status, 200);
		assert(genRes.json.message.includes("Virada Ravena 2026"));

		const pubApi = await httpRequest(port, "GET", "/api/events/public?year=2026");
		assert.strictEqual(pubApi.status, 200);
		assert.strictEqual(pubApi.json.ok, true);
		assert(pubApi.json.events.some((e) => e.id === evId && e.status === "proximo"));

		const updRes = await httpRequest(port, "PUT", `/api/events/admin/${evId}`, {
			headers: { Authorization: authHeader },
			body: {
				name: "Virada Ravena Editado",
				startTime: "2026-12-30T18:00",
				endTime: "2027-01-01T18:00",
				startGrants: { "waifu.rolls": 10 },
				ongoingBuffs: { "slots.vitoria": 40 },
				message: ""
			}
		});
		assert.strictEqual(updRes.status, 200);
		assert.strictEqual(updRes.json.event.name, "Virada Ravena Editado");
		assert(updRes.json.event.message.includes("Virada Ravena Editado"));

		const delRes = await httpRequest(port, "DELETE", `/api/events/admin/${evId}`, {
			headers: { Authorization: authHeader }
		});
		assert.strictEqual(delRes.status, 200);
		assert.strictEqual(delRes.json.ok, true);
		console.log("✓ Endpoints BotAPI CRUD + Auth + Status públicos aprovados!");
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}

	// 5. FazendaCommands: qualquer comando coleta o bônus diário automaticamente
	console.log("5. Testando auto-coleta diária em todos os comandos de FazendaCommands...");
	const origClaimDaily = ShadowGardenClient.prototype.claimDaily;
	const origGetShop = ShadowGardenClient.prototype.getShop;
	const origGetInventory = ShadowGardenClient.prototype.getInventory;
	const origAdminGive = ShadowGardenClient.prototype.adminGive;

	let claimCallCount = 0;
	let fortunaBonusCredited = 0;
	ShadowGardenClient.prototype.claimDaily = async () => {
		claimCallCount++;
		// Simula 1º comando do dia coletando diário e demais comandos retornando claimed: false
		if (claimCallCount === 1) {
			return {
				claimed: true,
				coinsWon: 200,
				itemsWon: [{ name: "Semente Teste", count: 2 }]
			};
		}
		return { claimed: false };
	};
	ShadowGardenClient.prototype.adminGive = async (_u, payload) => {
		fortunaBonusCredited += payload.coins || 0;
		return { ok: true };
	};
	ShadowGardenClient.prototype.getShop = async () => ({ items: [] });
	ShadowGardenClient.prototype.getInventory = async () => ({
		coins: 200,
		items: [],
		buffs: []
	});

	try {
		// Cria um evento programado ativo de Fazenda Fortuna (+50%) para validar bônus no diário automático
		const fortunaEv = await fakeDatabase.createScheduledEvent({
			name: "Fortuna Teste",
			startTime: Date.now() - 60000,
			endTime: Date.now() + 3600000,
			startGrants: {},
			ongoingBuffs: { "fazenda.fortuna": 50 },
			message: ""
		});
		await scheduledService.refreshActiveCache();

		const fakeMsg = {
			author: "5511999998888@c.us",
			from: "5511999998888@c.us",
			group: "123456@g.us",
			content: "!faz-ajuda",
			origin: {}
		};
		const cmdAjuda = FazendaCommands.commands.find((c) => c.name === "faz-ajuda");
		const cmdLoja = FazendaCommands.commands.find((c) => c.name === "faz-loja");
		const cmdInv = FazendaCommands.commands.find((c) => c.name === "faz-inventario");

		assert(cmdAjuda && cmdLoja && cmdInv, "Comandos da fazenda devem existir");

		// Primeiro comando (!faz-ajuda) deve coletar diário + bônus Fortuna (+100) + retornar [ajuda, sacola diária]
		const ajudaRes = await cmdAjuda.method({}, fakeMsg, [], null);
		assert(
			Array.isArray(ajudaRes) && ajudaRes.length === 2,
			"!faz-ajuda deve anexar sacola diária"
		);
		assert(ajudaRes[0].content.includes("GUIA"), "1ª mensagem deve ser o comando normal");
		assert(
			ajudaRes[1].content.includes("SACOLA DO COVEIRO RESGATADA"),
			"2ª mensagem deve ser a sacola diária"
		);
		assert.strictEqual(
			fortunaBonusCredited,
			100,
			"Deve creditar +50% bônus Fortuna (100 Petalitas)"
		);

		await fakeDatabase.deleteScheduledEvent(fortunaEv.id);
		await scheduledService.refreshActiveCache();

		// Segundo comando (!faz-loja) deve chamar claimDaily também (e como já foi resgatado, retorna apenas resposta normal)
		await cmdLoja.method({}, { ...fakeMsg, content: "!faz-loja" }, [], null);
		// Terceiro comando (!faz-inventario) idem
		await cmdInv.method({}, { ...fakeMsg, content: "!faz-inventario" }, [], null);

		assert.strictEqual(
			claimCallCount,
			3,
			"TODOS os comandos da Fazenda testados devem tentar coletar o diário"
		);
		assert.strictEqual(
			FazendaCommands.commands.every((c) => c.method.name === "wrappedFazendaCommand"),
			true,
			"Todos os 16 comandos da Fazenda devem estar envolvidos por withAutoDailyClaim"
		);
		console.log("✓ FazendaCommands auto-daily validado em todos os comandos!");
	} finally {
		ShadowGardenClient.prototype.claimDaily = origClaimDaily;
		ShadowGardenClient.prototype.getShop = origGetShop;
		ShadowGardenClient.prototype.getInventory = origGetInventory;
		ShadowGardenClient.prototype.adminGive = origAdminGive;
	}

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO ===");
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("FALHA NO TESTE:", err);
		process.exit(1);
	});
