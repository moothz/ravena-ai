/**
 * run-testes.js
 *
 * Arquivo de testes do bot — edite este arquivo para testar comandos.
 *
 * Fluxo de uso rápido:
 *   1. Edite src/functions/MeuComando.js
 *   2. docker cp src/functions/MeuComando.js <container>:/app/src/functions/MeuComando.js
 *   3. docker compose exec ravena-ai node run-testes.js
 *      (ou: make test-quick FILE=src/functions/MeuComando.js)
 *
 * Helpers disponíveis:
 *   msgTexto(texto, opts?)        → Mensagem de texto simples
 *   msgMedia(legenda, arquivo, opts?) → Mensagem com mídia (imagem, áudio, vídeo)
 *   msgComQuote(texto, quoted, opts?) → Mensagem que responde outra
 *   msgCustom(overrides)          → Mensagem totalmente customizada
 *
 * Arquivos de mídia para testes:
 *   data/test-image.png, data/test-image.jpg
 *   data/test-audio.mp3, data/test-video.mp4
 *
 * Documentação completa: README.md → "Testando sem WhatsApp"
 */

require("dotenv").config();

const { msgTexto, msgMedia, msgComQuote, msgCustom } = require("./src/testing/helpers");
const TestRunner = require("./src/testing/TestRunner");

// =============================================================================
// CONFIGURAÇÃO
// ID do grupo "Gpzuera" — substitua pelo ID real consultando o banco de dados
// Para obter: docker compose exec ravena-ai node -e "
//   const DB = require('./src/utils/Database');
//   DB.getInstance().getGroups().then(gs => gs.forEach(g => console.log(g.name, g.id))).catch(console.error)
// "
// =============================================================================
const GROUP_ID = process.env.TEST_GROUP_ID ?? "SEU_GROUP_ID_AQUI@g.us";
const AUTHOR = process.env.TEST_AUTHOR ?? "5511999999999@s.whatsapp.net";

async function main() {
	const runner = new TestRunner({
		groupId: GROUP_ID,
		author: AUTHOR,
		authorName: "Testador",
		verbose: true
	});

	// ===========================================================================
	// 1 — COMANDOS BÁSICOS
	// Verifica se o pipeline básico está funcionando
	// ===========================================================================

	runner.run("!ping", () => msgTexto("!ping"));

	runner.run("!status", () => msgTexto("!status"));

	runner.run("!help", () => msgTexto("!help"));

	runner.run("!uptime", () => msgTexto("!uptime"));

	// ===========================================================================
	// 2 — COMANDOS DE IA (LLM)
	// Testam a integração com o serviço LLM. Podem ser lentos.
	// ===========================================================================

	runner.run("!chat - conversa simples", () => msgTexto("!chat Olá, como vai?"), {
		timeout: 45000
	});

	runner.run(
		"!resumo - com quoted",
		async () => {
			const quoted = msgTexto(
				"O rato roeu a roupa do rei de Roma. O rei ficou bravo com o rato. O rato foi embora e nunca mais voltou para o castelo do rei."
			);
			return msgComQuote("!resumo", quoted);
		},
		{ timeout: 45000 }
	);

	runner.run(
		"!traduza - com texto",
		() => msgTexto("!traduza Hello, how are you? en pt"),
		{ timeout: 45000 }
	);

	// ===========================================================================
	// 3 — COMANDOS DE MÍDIA
	// Testam download de mídia, geração de stickers, etc.
	// ===========================================================================

	// YouTube — busca e download (espera 2 mensagens: busca + mídia)
	runner.run("!yt - busca texto", () => msgTexto("!yt receita pudim"), {
		expectedMessages: 2,
		timeout: 60000
	});

	// Sticker de imagem (requer data/test-image.png)
	runner.run("!s - sticker de imagem", () =>
		msgMedia("!s", "./data/test-image.png", { type: "image" })
	);

	// Sticker de áudio (requer data/test-audio.mp3)
	runner.run("!s - sticker de áudio", () =>
		msgMedia("!s", "./data/test-audio.mp3", { type: "audio" })
	);

	// ===========================================================================
	// 4 — MANIPULAÇÃO DE IMAGEM
	// Testam geração e edição de imagens
	// ===========================================================================

	// Meme (requer data/test-image.png)
	runner.run("!meme - sticker meme", () =>
		msgMedia("!meme Topo:Teste|Baixo:Ravena", "./data/test-image.png", { type: "image" }),
		{ timeout: 30000 }
	);

	// ===========================================================================
	// 5 — COMANDOS DE BUSCA
	// Testam integrações com APIs externas
	// ===========================================================================

	runner.run("!google - busca", () => msgTexto("!google Ravena AI"), {
		timeout: 20000
	});

	runner.run("!wiki - wikipedia", () => msgTexto("!wiki Brasil"), {
		timeout: 20000
	});

	runner.run("!imdb - busca filme", () => msgTexto("!imdb Inception"), {
		timeout: 20000
	});

	// ===========================================================================
	// 6 — COMANDOS DE GRUPO
	// Testam gerenciamento de grupos (ban, mute, promover, rebaixar)
	// OBS: alguns comandos só funcionam com permissões reais de admin do grupo
	// ===========================================================================

	// runner.run("!ban - listar banidos", () =>
	// 	msgTexto("!ban")
	// );

	// runner.run("!mute - listar mutados", () =>
	// 	msgTexto("!mute")
	// );

	// ===========================================================================
	// 7 — COMANDOS DE JOGOS
	// Testam lógica de jogos
	// ===========================================================================

	runner.run("!dado - rolar dado", () => msgTexto("!dado"));

	runner.run("!roleta - roleta russa", () => msgTexto("!roleta"));

	runner.run("!slot - caça-níqueis", () => msgTexto("!slot"));

	runner.run("!anagrama - iniciar jogo", () => msgTexto("!anagrama"));

	runner.run("!pinto - iniciar jogo", () => msgTexto("!pinto"));

	runner.run("!coringa - carta coringa", () => msgTexto("!coringa"));

	// ===========================================================================
	// 8 — TESTES DE REAÇÃO
	// Testam envio de reações via mensagens quoted
	// ===========================================================================

	runner.run(
		"!reage - reação com emoji",
		async () => {
			const quoted = msgTexto("Mensagem para reagir");
			return msgComQuote("!reage 👍", quoted);
		}
	);

	// ===========================================================================
	// 9 — TESTES DE MENSAGEM PRIVADA (PV)
	// Testam comportamento específico de mensagens privadas
	// (ignorePV, pvAI, whitelist)
	// ===========================================================================

	runner.run("!help - no privado", () =>
		msgCustom({
			content: "!help",
			type: "text",
			group: null, // null = mensagem privada
			author: "5511000000001@s.whatsapp.net"
		})
	);

	runner.run("!ping - no privado", () =>
		msgCustom({
			content: "!ping",
			type: "text",
			group: null,
			author: AUTHOR
		})
	);

	// ===========================================================================
	// 10 — TRATAMENTO DE ERROS
	// Testam comandos malformados, mídia ausente, etc.
	// ===========================================================================

	// Comando inexistente
	runner.run("comando inexistente", () => msgTexto("!comando_que_nao_existe_12345"));

	// Comando sem parâmetros obrigatórios
	runner.run("!yt sem parâmetros", () => msgTexto("!yt"));

	// ===========================================================================
	// 11 — COMANDOS ADICIONAIS
	// Outros comandos úteis para teste
	// ===========================================================================

	// Clima
	runner.run("!tempo - clima", () => msgTexto("!tempo São Paulo"));

	// Moeda
	runner.run("!moeda - cotação", () => msgTexto("!moeda USD BRL"));

	// QR Code
	runner.run("!qr - gerar QR code", () => msgTexto("!qr https://exemplo.com"));

	// Biscoito da sorte
	runner.run("!biscoito - fortune cookie", () => msgTexto("!biscoito"));

	// Horóscopo
	runner.run("!horoscopo - signo", () => msgTexto("!horoscopo áries"));

	// Dice
	runner.run("!dice - dado emoji", () => msgTexto("!dice"));

	// Cantada
	runner.run("!cantada", () => msgTexto("!cantada"));

	// ===========================================================================
	// Executa e encerra
	// ===========================================================================
	await runner.runAll();
}

main().catch((err) => {
	console.error("❌ Erro fatal no run-testes.js:", err);
	process.exit(1);
});