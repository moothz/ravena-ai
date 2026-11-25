process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const sharp = require("sharp");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const Stickers = require("../functions/Stickers");

async function main() {
	console.log("1. Testando resolveQuotedSenderInfo...");

	const groupWithNick = {
		id: "120363000000000099@g.us",
		name: "Grupo Teste",
		nicks: [{ numero: "5511999990001@s.whatsapp.net", apelido: "Cabrito Mestre" }]
	};

	// Caso 1: apelido na ravena tem prioridade sobre pushname
	const fromNick = Stickers.resolveQuotedSenderInfo(
		{
			author: "5511999990001@s.whatsapp.net",
			authorName: "Nome Original",
			pushname: "Nome Original"
		},
		groupWithNick
	);
	assert.strictEqual(fromNick.displayName, "Cabrito Mestre");
	assert.strictEqual(fromNick.formattedPhone, "+55 (11) 99999-0001");

	// Caso 2: sem apelido, usa nome da mensagem
	const fromName = Stickers.resolveQuotedSenderInfo(
		{
			author: "5511999990002@s.whatsapp.net",
			authorName: "Fulano Teste"
		},
		groupWithNick
	);
	assert.strictEqual(fromName.displayName, "Fulano Teste");
	assert.strictEqual(fromName.formattedPhone, "+55 (11) 99999-0002");

	// Caso 3: fallback de cache ("Usuario") cai no número formatado
	const fromFallback = Stickers.resolveQuotedSenderInfo(
		{
			author: "555599999999@s.whatsapp.net",
			authorName: "Usuario",
			pushname: "Usuario"
		},
		groupWithNick
	);
	assert.strictEqual(fromFallback.displayName, "+55 (55) 9999-9999");
	assert.strictEqual(fromFallback.formattedPhone, "");

	console.log("2. Testando renderTextBubblePng (curto, médio e longo)...");
	for (const [label, text] of [
		["curto", "oi tudo bem?"],
		["medio", "Essa é uma mensagem média com acentuação: é, ç, ã, õ e quebra\nde linha!"],
		[
			"longo",
			"Texto bem longo para testar o limite de caracteres e o ajuste de fonte automática no bubble do WhatsApp. ".repeat(
				5
			)
		]
	]) {
		const png = Stickers.renderTextBubblePng({
			displayName: "Cabrito Mestre",
			formattedPhone: "+55 (11) 99999-0001",
			text,
			dateTime: "25/11/2026 12:15"
		});
		const meta = await sharp(png).metadata();
		assert.strictEqual(meta.width, 512, `${label}: largura deve ser 512`);
		assert.strictEqual(meta.height, 512, `${label}: altura deve ser 512`);
		assert.strictEqual(meta.hasAlpha, true, `${label}: deve ter canal alpha`);

		// Verifica transparência no pixel (0,0) fora do bubble
		const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		assert.strictEqual(data[3], 0, `${label}: canto superior esquerdo deve ser transparente`);
	}

	console.log("3. Testando comando !s em reply de mensagem de texto...");
	const bot = new FakeBot({ id: "teste", nomeExibir: "ravena" });
	const sCmd = Stickers.commands.find((c) => c.name === "s");
	assert.ok(sCmd, "Comando !s deve existir");

	const msg = createMessage({
		content: "!s",
		group: "120363000000000099@g.us",
		author: "5511999990003@s.whatsapp.net"
	});
	msg.origin.getQuotedMessage = async () => ({
		type: "text",
		content: "Bom dia grupo, bora testar o sticker de texto!",
		author: "5511999990001@s.whatsapp.net",
		authorName: "Nome Original",
		timestamp: 1795619700
	});

	const res = await sCmd.method(bot, msg, [], groupWithNick);
	assert.ok(Array.isArray(res) && res.length === 1, "Deve retornar array com 1 ReturnMessage");
	assert.strictEqual(res[0].options.sendMediaAsSticker, true);
	assert.strictEqual(res[0].content.mimetype, "image/webp");

	const webpBuffer = Buffer.from(res[0].content.data, "base64");
	const webpMeta = await sharp(webpBuffer).metadata();
	assert.strictEqual(webpMeta.format, "webp");
	assert.strictEqual(webpMeta.width, 512);
	assert.strictEqual(webpMeta.height, 512);
	assert.strictEqual(webpMeta.hasAlpha, true);

	console.log("4. Testando comando !s em reply de mensagem de texto vazia...");
	let reacted = null;
	const emptyMsg = createMessage({
		content: "!s",
		group: "120363000000000099@g.us",
		author: "5511999990003@s.whatsapp.net"
	});
	emptyMsg.origin.react = async (emoji) => {
		reacted = emoji;
	};
	emptyMsg.origin.getQuotedMessage = async () => ({
		type: "text",
		content: "   ",
		author: "5511999990001@s.whatsapp.net"
	});

	const emptyRes = await sCmd.method(bot, emptyMsg, [], groupWithNick);
	assert.strictEqual(reacted, "❌");
	assert.ok(String(emptyRes.content).includes("vazia"));

	console.log("Todos os testes de sticker de texto passaram!");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
