process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const axios = require("axios");
const FakeBot = require("./FakeBot");
const { createMessage } = require("./FakeMessage");
const MyInstantsAudioSearch = require("../functions/MyInstantsAudioSearch");

const originalAxiosGet = axios.get;

async function runTests() {
	console.log("=== Iniciando testes de MyInstantsAudioSearch (!audio) ===");

	const bot = new FakeBot({ id: "test-bot" });
	const audioCmd = MyInstantsAudioSearch.commands.find((c) => c.name === "audio");
	assert.ok(audioCmd, "Comando !audio deve estar registrado");

	// -------------------------------------------------------------
	// 1. Validação de argumentos ausentes ou vazios
	// -------------------------------------------------------------
	console.log("\n--- 1. Validação de argumentos ---");
	const msgSemArgs = createMessage({
		content: "!audio",
		group: "123@g.us",
		author: "user@s.whatsapp.net"
	});
	const resSemArgs = await audioCmd.method(bot, msgSemArgs, [], { id: "123@g.us" });
	assert.ok(
		resSemArgs.content.includes("Digite o nome do áudio para buscar"),
		"Deve instruir uso quando não passar argumentos"
	);
	console.log("✓ Sem argumentos validado com sucesso");

	const resArgsVazios = await audioCmd.method(bot, msgSemArgs, ["   "], { id: "123@g.us" });
	assert.ok(
		resArgsVazios.content.includes("Digite o nome do áudio para buscar"),
		"Deve instruir uso quando argumento for apenas espaços"
	);
	console.log("✓ Argumentos vazios validados com sucesso");

	// -------------------------------------------------------------
	// 2. Busca e listagem de resultados (sem número especificado)
	// -------------------------------------------------------------
	console.log("\n--- 2. Listagem de resultados ---");
	const htmlBuscaSucesso = `
		<div class="instant">
			<a class="instant-link" href="/instant/globo-1/">Vinheta Globo 1</a>
			<button class="small-button" onclick="play('/media/sounds/globo1.mp3')"></button>
		</div>
		<div class="instant">
			<a class="instant-link" href="/instant/globo-2/">Vinheta Globo 2</a>
			<button class="small-button" onclick="play('/media/sounds/globo2.mp3')"></button>
		</div>
	`;

	axios.get = async (url) => {
		if (url.includes("/en/search/?name=")) {
			return {
				status: 200,
				data: Buffer.from(htmlBuscaSucesso, "utf8"),
				headers: { "content-type": "text/html; charset=utf-8" }
			};
		}
		throw new Error("URL inesperada: " + url);
	};

	const msgBusca = createMessage({
		content: "!audio vinheta globo",
		group: "123@g.us",
		author: "user@s.whatsapp.net"
	});
	const resLista = await audioCmd.method(bot, msgBusca, ["vinheta", "globo"], { id: "123@g.us" });
	assert.ok(
		resLista.content.includes('Resultados para "vinheta globo":'),
		"Deve incluir cabeçalho de resultados"
	);
	assert.ok(resLista.content.includes("- 1. Vinheta Globo 1"), "Deve listar item 1");
	assert.ok(resLista.content.includes("- 2. Vinheta Globo 2"), "Deve listar item 2");
	assert.ok(
		resLista.content.includes("!audio vinheta globo número_do_áudio"),
		"Deve incluir instruções de seleção"
	);
	console.log("✓ Listagem de resultados validada com sucesso");

	// -------------------------------------------------------------
	// 3. Seleção de áudio válido com download em MP3
	// -------------------------------------------------------------
	console.log("\n--- 3. Seleção e envio de áudio ---");
	const mp3Falso = Buffer.from("ID3FAKEAUDIOSTREAMMOCKDATA");

	axios.get = async (url) => {
		if (url.includes("/en/search/?name=")) {
			return {
				status: 200,
				data: Buffer.from(htmlBuscaSucesso, "utf8"),
				headers: { "content-type": "text/html; charset=utf-8" }
			};
		}
		if (url.includes("/media/sounds/globo1.mp3")) {
			return {
				status: 200,
				data: mp3Falso,
				headers: { "content-type": "audio/mpeg" }
			};
		}
		throw new Error("URL inesperada: " + url);
	};

	const msgEscolha = createMessage({
		content: "!audio vinheta globo 1",
		group: "123@g.us",
		author: "user@s.whatsapp.net"
	});
	const resEscolha = await audioCmd.method(bot, msgEscolha, ["vinheta", "globo", "1"], {
		id: "123@g.us"
	});
	assert.ok(Array.isArray(resEscolha), "Deve retornar array com título e mídia");
	assert.strictEqual(resEscolha.length, 2, "Deve conter 2 mensagens de retorno");
	assert.ok(resEscolha[0].content.includes("Vinheta Globo 1"), "Primeira msg deve ser o título");
	assert.strictEqual(
		resEscolha[1].options.sendAudioAsVoice,
		true,
		"Segunda msg deve ter opção de envio como voz"
	);
	assert.ok(
		resEscolha[1].content.data || resEscolha[1].content.isMessageMedia,
		"Segunda msg deve conter a mídia"
	);
	console.log("✓ Envio de áudio com sucesso validado");

	// -------------------------------------------------------------
	// 4. Seleção de número inválido fora do intervalo
	// -------------------------------------------------------------
	console.log("\n--- 4. Número fora do intervalo ---");
	const resInvalido = await audioCmd.method(bot, msgEscolha, ["vinheta", "globo", "99"], {
		id: "123@g.us"
	});
	assert.ok(
		resInvalido.content.includes(
			"Número inválido, para 'vinheta globo' digite um número entre 1 e 2"
		),
		"Deve avisar que o número escolhido é inválido"
	);
	console.log("✓ Tratamento de índice fora do intervalo validado");

	// -------------------------------------------------------------
	// 5. Bloqueio por Cloudflare na busca (retornando challenge HTML)
	// -------------------------------------------------------------
	console.log("\n--- 5. Tratamento de bloqueio Cloudflare na busca ---");
	const htmlCloudflare =
		"<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>_cf_chl_opt</body></html>";

	// Quando Axios e browser client retornam HTML de challenge
	axios.get = async () => ({
		status: 403,
		data: Buffer.from(htmlCloudflare, "utf8"),
		headers: { "content-type": "text/html; charset=utf-8" }
	});

	const resCloudflare = await audioCmd.method(bot, msgBusca, ["qualquer", "coisa"], {
		id: "123@g.us"
	});
	assert.ok(
		resCloudflare.content.includes("Ocorreu um erro ao buscar o áudio"),
		"Deve exibir erro amigável ao usuário quando houver bloqueio Cloudflare"
	);
	assert.ok(
		!resCloudflare.content.includes("Nenhum áudio encontrado"),
		"Não deve tratar bloqueio Cloudflare como ausência de resultados"
	);
	console.log("✓ Erro amigável em bloqueio Cloudflare validado com sucesso");

	// -------------------------------------------------------------
	// 6. Rejeição de payload HTML no download do MP3
	// -------------------------------------------------------------
	console.log("\n--- 6. Rejeição de HTML no endpoint de áudio MP3 ---");
	axios.get = async (url) => {
		if (url.includes("/en/search/?name=")) {
			return {
				status: 200,
				data: Buffer.from(htmlBuscaSucesso, "utf8"),
				headers: { "content-type": "text/html; charset=utf-8" }
			};
		}
		if (url.includes("/media/sounds/globo1.mp3")) {
			// Cloudflare retornou página HTML em vez de arquivo MP3
			return {
				status: 200,
				data: Buffer.from("<html><body>Error</body></html>", "utf8"),
				headers: { "content-type": "text/html; charset=utf-8" }
			};
		}
		throw new Error("URL inesperada: " + url);
	};

	const resHtmlRejeitado = await audioCmd.method(bot, msgEscolha, ["vinheta", "globo", "1"], {
		id: "123@g.us"
	});
	assert.ok(
		resHtmlRejeitado.content.includes('Não foi possível baixar o áudio "Vinheta Globo 1"'),
		"Deve avisar sobre falha no download e sugerir outro áudio ao usuário"
	);
	console.log("✓ Rejeição de HTML no download de MP3 validada com sucesso");

	// -------------------------------------------------------------
	// 7. Nenhum resultado legítimo (404 ou página vazia sem challenge)
	// -------------------------------------------------------------
	console.log("\n--- 7. Nenhum resultado legítimo ---");
	axios.get = async () => ({
		status: 200,
		data: Buffer.from('<div class="sem-botoes">Nada aqui</div>', "utf8"),
		headers: { "content-type": "text/html; charset=utf-8" }
	});

	const resVazio = await audioCmd.method(bot, msgBusca, ["pesquisanula9999"], {
		id: "123@g.us"
	});
	assert.ok(
		resVazio.content.includes('Nenhum áudio encontrado para "pesquisanula9999"'),
		"Deve informar nenhum áudio encontrado quando a página não possuir resultados legítimos"
	);
	console.log("✓ Tratamento de nenhum áudio encontrado validado");

	// Restaura implementações originais
	axios.get = originalAxiosGet;

	console.log("\n=== TODOS OS TESTES DE MYINSTANTS PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

runTests().catch((err) => {
	console.error("Falha no teste:", err);
	process.exit(1);
});
