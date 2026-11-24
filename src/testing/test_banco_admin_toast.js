const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const cheerio = require("cheerio");

const PUBLIC_DIR = path.join(__dirname, "../../public");
const HTML = fs.readFileSync(path.join(PUBLIC_DIR, "banco-admin.html"), "utf-8");
const SCRIPT = fs.readFileSync(path.join(PUBLIC_DIR, "banco-admin.js"), "utf-8");

const USER_ID = "5511999990001@s.whatsapp.net";
const PAYLOAD = `<img src=x onerror="alert(1)"> & <b>negrito</b>`;

const API = "/api/games/bank/admin";
const OK = {
	[`${API}/users`]: {
		ok: true,
		data: {
			users: [{ userId: USER_ID, name: PAYLOAD, runas: 100 }],
			total: 1,
			totalPages: 1
		}
	},
	[`${API}/user-runas`]: { ok: true },
	[`${API}/impersonate`]: { ok: true, redirectUrl: "/banco?token=ficticio" },
	[`${API}/config`]: { ok: true, data: { rates: {} } },
	[`${API}/recalculate-rates`]: { ok: true },
	[`${API}/transactions`]: {
		ok: true,
		data: {
			transactions: [
				{
					id: 7,
					user_id: USER_ID,
					type: "DEPOSIT",
					game: "pesca",
					game_amount: 1,
					runas_amount: 100
				}
			],
			total: 1,
			totalPages: 1
		}
	},
	[`${API}/undo-transaction`]: { ok: true },
	"/api/economy/admin/status": { enabled: false },
	"/api/economy/admin/schedule": { ok: true }
};

function createCheerioDocument(html) {
	const $ = cheerio.load(html);
	const known = new WeakMap();
	const wrap = (node) => {
		if (!node) return null;
		if (!known.has(node)) known.set(node, new El(node));
		return known.get(node);
	};
	const toNode = (child) =>
		child instanceof El ? child.node : $("<i>").text(`${child}`).contents();

	class El {
		constructor(node) {
			this.node = node;
			this.style = {};
			this.listeners = {};
			this.disabled = false;
			this.dataset = new Proxy(
				{},
				{
					get: (_, key) => this.getAttribute(El.dataAttr(key)) ?? undefined,
					set: (_, key, val) => {
						this.setAttribute(El.dataAttr(key), val);
						return true;
					}
				}
			);
			this.classList = {
				add: (c) => $(node).addClass(c),
				remove: (c) => $(node).removeClass(c),
				contains: (c) => $(node).hasClass(c),
				toggle: (c, force) => $(node).toggleClass(c, force)
			};
		}
		static dataAttr(key) {
			return `data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
		}
		get className() {
			return this.getAttribute("class") || "";
		}
		set className(v) {
			this.setAttribute("class", v);
		}
		get innerHTML() {
			return $(this.node).html();
		}
		set innerHTML(v) {
			$(this.node).html(String(v));
		}
		get textContent() {
			return $(this.node).text();
		}
		set textContent(v) {
			$(this.node).text(String(v ?? ""));
		}
		get value() {
			return this.getAttribute("value") ?? "";
		}
		set value(v) {
			this.setAttribute("value", v);
		}
		getAttribute(name) {
			return $(this.node).attr(name) ?? null;
		}
		setAttribute(name, v) {
			$(this.node).attr(name, String(v));
		}
		querySelector(sel) {
			return wrap($(this.node).find(sel)[0]);
		}
		querySelectorAll(sel) {
			return $(this.node).find(sel).toArray().map(wrap);
		}
		append(...children) {
			for (const c of children) $(this.node).append(toNode(c));
		}
		appendChild(child) {
			this.append(child);
			return child;
		}
		replaceChildren(...children) {
			$(this.node).empty();
			this.append(...children);
		}
		remove() {
			$(this.node).remove();
		}
		addEventListener(type, fn) {
			(this.listeners[type] ||= []).push(fn);
		}
		focus() {}
		select() {}
		async click() {
			const ev = { target: this, stopPropagation() {}, preventDefault() {} };
			for (const fn of this.listeners.click || []) await fn(ev);
			await settle();
		}
	}

	const root = wrap($.root()[0]);
	return Object.assign(root, {
		getElementById: (id) => wrap($(`[id="${id}"]`)[0]),
		createElement: (tag) => wrap($(`<${tag}>`)[0]),
		createTextNode: (text) => String(text)
	});
}

const settle = async () => {
	for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

async function openPage(overrides = {}) {
	const document = createCheerioDocument(HTML);
	const timers = [];
	const api = { ...OK, ...overrides };
	vm.runInNewContext(SCRIPT, {
		document,
		window: { open() {}, location: { reload() {} } },
		navigator: { clipboard: { writeText: async () => {} } },
		confirm: () => true,
		console: { ...console, error() {} },
		setTimeout: (fn) => timers.push(fn),
		clearTimeout() {},
		URLSearchParams,
		fetch: async (url) => {
			const response = api[url.split("?")[0]];
			assert.ok(response, `rota sem resposta no teste: ${url}`);
			const { httpStatus = 200, ...body } = response;
			return { ok: httpStatus < 400, status: httpStatus, json: async () => body };
		}
	});
	for (const fn of document.listeners.DOMContentLoaded) fn();
	await settle();
	return {
		$: (sel) => document.querySelector(sel),
		toasts: () => document.querySelectorAll("#bank-toast-container .bank-toast"),
		runTimers: () => timers.splice(0).forEach((fn) => fn())
	};
}

const FAIL = { ok: false, error: PAYLOAD };
const visibleText = (el) => el.textContent.replace(/\s+/g, " ").trim();

function assertOnlyToast(page, kind, text, tags = []) {
	const toasts = page.toasts();
	assert.strictEqual(toasts.length, 1, `esperado 1 toast, veio ${toasts.length}`);
	const [toast] = toasts;
	assert.ok(toast.classList.contains(`toast-${kind}`), `toast deveria ser ${kind}`);
	assert.deepStrictEqual(
		toast.querySelectorAll("*").map((el) => el.node.tagName),
		["i", "div", ...tags, "button"],
		"elementos dentro do toast"
	);
	assert.strictEqual(visibleText(toast), `${text} ×`);
	return toast;
}

const openTab = (page, name) => page.$(`#btn-tab-${name}`).click();
async function saveRunas(page, value) {
	await page.$(".btn-edit-trigger").click();
	if (value !== undefined) page.$(".runas-edit-input").value = value;
	await page.$(".btn-inline-save").click();
}

const CASES = [
	[
		"erro ao carregar usuários",
		async () => {
			const page = await openPage({ [`${API}/users`]: FAIL });
			assertOnlyToast(page, "error", `Erro ao carregar usuários: ${PAYLOAD}`);
		}
	],
	[
		"erro ao salvar saldo",
		async () => {
			const page = await openPage({ [`${API}/user-runas`]: FAIL });
			await saveRunas(page);
			assertOnlyToast(page, "error", `Erro ao salvar: ${PAYLOAD}`);
		}
	],
	[
		"erro ao acessar como usuário",
		async () => {
			const page = await openPage({ [`${API}/impersonate`]: FAIL });
			await page.$(".btn-impersonate").click();
			assertOnlyToast(page, "error", `Falha ao acessar como usuário: ${PAYLOAD}`);
		}
	],
	[
		"erro nos dados macroeconômicos",
		async () => {
			const page = await openPage({ [`${API}/config`]: FAIL });
			await openTab(page, "config");
			assertOnlyToast(page, "error", `Falha ao obter dados macroeconômicos: ${PAYLOAD}`);
		}
	],
	[
		"erro ao recalcular cotações",
		async () => {
			const page = await openPage({ [`${API}/recalculate-rates`]: FAIL });
			await page.$("#btn-recalculate-rates").click();
			assertOnlyToast(page, "error", `Erro ao recalcular cotações: ${PAYLOAD}`);
		}
	],
	[
		"erro numa ação da carga da economia",
		async () => {
			const page = await openPage({
				"/api/economy/admin/schedule": { httpStatus: 400, message: PAYLOAD }
			});
			await page.$("#econ-btn-schedule").click();
			assertOnlyToast(page, "error", PAYLOAD);
		}
	],
	[
		"erro ao carregar transações",
		async () => {
			const page = await openPage({ [`${API}/transactions`]: FAIL });
			await openTab(page, "transactions");
			assertOnlyToast(page, "error", `Erro ao carregar transações: ${PAYLOAD}`);
		}
	],
	[
		"erro ao desfazer transação",
		async () => {
			const page = await openPage({ [`${API}/undo-transaction`]: FAIL });
			await openTab(page, "transactions");
			await page.$(".btn-admin-undo").click();
			await page.$("#btn-admin-modal-confirm").click();
			assertOnlyToast(page, "error", `Erro ao desfazer transação: ${PAYLOAD}`);
		}
	],
	[
		"ID copiado aparece como texto",
		async () => {
			const users = {
				...OK[`${API}/users`].data,
				users: [{ userId: PAYLOAD, name: "x", runas: 1 }]
			};
			const page = await openPage({ [`${API}/users`]: { ok: true, data: users } });
			await page.$(".btn-copy-id").click();
			assertOnlyToast(page, "success", `ID ${PAYLOAD} copiado para a área de transferência!`);
		}
	],
	[
		"acesso concedido: apelido em negrito e como texto",
		async () => {
			const page = await openPage();
			await page.$(".btn-impersonate").click();
			const toast = assertOnlyToast(
				page,
				"success",
				`Acesso concedido para ${PAYLOAD}! Abrindo em nova aba...`,
				["strong"]
			);
			assert.strictEqual(toast.querySelector("strong").textContent, PAYLOAD);
		}
	],
	[
		"saldo inválido e saldo salvo seguem com o mesmo texto",
		async () => {
			const bad = await openPage();
			await saveRunas(bad, "-1");
			assertOnlyToast(bad, "warning", "O saldo deve ser um número válido maior ou igual a zero.");
			const good = await openPage();
			await saveRunas(good);
			assertOnlyToast(good, "success", "Saldo de Runas atualizado: 100,00 ᚱ");
		}
	],
	[
		"o botão × fecha o toast",
		async () => {
			const page = await openPage({ [`${API}/users`]: { ok: false, error: "fora do ar" } });
			const toast = assertOnlyToast(page, "error", "Erro ao carregar usuários: fora do ar");
			await toast.querySelector(".toast-close").click();
			page.runTimers();
			assert.strictEqual(page.toasts().length, 0);
		}
	]
];

async function runTests() {
	console.log("=== Teste dos toasts do banco-admin (public/banco-admin.js) ===");
	let failed = 0;
	for (const [name, fn] of CASES) {
		try {
			await fn();
			console.log(`✓ ${name}`);
		} catch (err) {
			failed++;
			console.error(`✗ ${name}\n${err.message}\n`);
		}
	}
	console.log(`${CASES.length - failed}/${CASES.length} casos passaram.`);
	if (failed) throw new Error(`${failed} caso(s) falharam`);
}

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
