process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const axios = require("axios").default;
const FakeBot = require("./FakeBot");
const EventHandler = require("../EventHandler");
const Management = require("../commands/Management");
const Group = require("../models/Group");
const telemetry = require("../telemetry");
const { msgTexto } = require("./helpers");

async function main() {
	const originalRandom = Math.random;
	const originalPost = axios.post;
	const originalSetAttrs = telemetry.setAttrs;
	const requests = [];
	const attrs = [];
	axios.post = async (url, data) => {
		requests.push(data);
		return { data: "ok" };
	};
	telemetry.setAttrs = (values, span) => {
		attrs.push(values);
		return originalSetAttrs(values, span);
	};
	Math.random = () => 0;

	try {
		const bot = new FakeBot({ id: "teste-argpick" });
		const eventHandler = new EventHandler();
		bot.eventHandler = eventHandler;
		const handler = eventHandler.commandHandler;
		handler.cmdDebounceTime = 0;

		const groupId = "120363000000000099@g.us";
		const group = new Group({ id: groupId, name: "Grupo Teste", prefix: "!" });
		eventHandler.groups[groupId] = group;

		const frases = {
			startsWith: "frases",
			responses: ["um", "dois", "três"],
			active: true,
			reply: false
		};
		const api = {
			startsWith: "api",
			responses: [
				"{API#POST#TEXT#https://httpbin.org/post?primeira=arg1}",
				"{API#POST#TEXT#https://httpbin.org/post?segunda=arg1}"
			],
			active: true,
			argPick: true
		};
		const saved = [frases, api];

		const management = new Management();
		management.database.getCustomCommands = async () => saved;
		management.database.updateCustomCommand = async () => true;
		management.database.saveCustomCommand = async () => true;
		handler.customCommands[groupId] = saved;

		const send = async (cmd, args) => {
			bot.resetCapture();
			const text = ["!" + cmd, ...args].join(" ");
			await handler.processCommand(bot, msgTexto(text, { group: groupId }), cmd, args, group);
			return bot.capturedMessages.map((m) => m.content);
		};

		assert.deepStrictEqual(await send("frases", ["3"]), ["um"]);
		console.log("OK: sem argPick, o número é ignorado e a resposta é sorteada");

		const toggleOn = await management.toggleArgPick(bot, msgTexto("x"), ["frases"], group);
		assert.strictEqual(frases.argPick, true);
		assert.ok(toggleOn.content.includes("*!frases 3*"), toggleOn.content);
		assert.ok(toggleOn.content.includes("tem 3"), toggleOn.content);

		attrs.length = 0;
		assert.deepStrictEqual(await send("frases", ["3"]), ["três"]);
		assert.ok(
			attrs.some(
				(a) =>
					a["ravena.custom.arg_pick"] === true &&
					a["ravena.custom.response_index"] === 3 &&
					a["ravena.custom.response_count"] === 3
			),
			JSON.stringify(attrs)
		);
		assert.deepStrictEqual(await send("frases", ["2"]), ["dois"]);
		assert.deepStrictEqual(await send("frases", ["1"]), ["um"]);
		console.log("OK: com argPick, !frases N envia a N-ésima resposta e grava a telemetria");

		attrs.length = 0;
		for (const args of [[], ["0"], ["-1"], ["4"], ["99"], ["2.5"], ["abc"], ["dois"]]) {
			assert.deepStrictEqual(await send("frases", args), ["um"], `args ${args}`);
		}
		assert.ok(!attrs.some((a) => "ravena.custom.arg_pick" in a));
		console.log("OK: sem número, 0, negativo, fora do intervalo, decimal e texto caem no sorteio");

		frases.sendAllResponses = true;
		assert.deepStrictEqual(await send("frases", []), ["um", "dois", "três"]);
		assert.deepStrictEqual(await send("frases", ["5"]), ["um", "dois", "três"]);
		assert.deepStrictEqual(await send("frases", ["2"]), ["dois"]);
		frases.sendAllResponses = false;
		console.log("OK: com enviar todas, o número válido envia só uma; sem número envia todas");

		await send("api", ["2", "valor"]);
		assert.deepStrictEqual(requests.at(-1), { segunda: "valor" });
		await send("api", ["7", "valor"]);
		assert.deepStrictEqual(requests.at(-1), { primeira: "7" });
		console.log("OK: o número escolhido sai dos argumentos; inválido continua como arg1");

		const outro = { startsWith: "outro", responses: ["{cmd-!frases 2}"], active: true };
		assert.strictEqual(
			(
				await handler.processCustomCommandResponse(
					bot,
					msgTexto("!outro"),
					outro.responses[0],
					outro,
					group,
					[]
				)
			).content,
			"dois"
		);
		console.log("OK: comando embutido {cmd-!frases 2} respeita a escolha");

		const toggleOff = await management.toggleArgPick(bot, msgTexto("x"), ["frases"], group);
		assert.strictEqual(frases.argPick, false);
		assert.ok(toggleOff.content.includes("não escolhe mais"), toggleOff.content);
		assert.deepStrictEqual(await send("frases", ["3"]), ["um"]);
		console.log("OK: desligar volta ao sorteio");

		const missing = await management.toggleArgPick(bot, msgTexto("x"), ["nada"], group);
		assert.ok(missing.content.includes("não encontrado"));

		console.log("--- TODOS OS TESTES DE argPick PASSARAM ---");
	} finally {
		Math.random = originalRandom;
		axios.post = originalPost;
		telemetry.setAttrs = originalSetAttrs;
	}
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("FALHOU:", err);
		process.exit(1);
	});
