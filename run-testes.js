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
	// TESTES — adicione/remova/comente conforme necessário
	// ===========================================================================

	// Ajuda AnythingLLM
	runner.run("!ajuda - teste", () => msgTexto("!ajuda como criar comandos"), {
		expectedMessages: 1,
		timeout: 45000
	});

	// ===========================================================================
	// Executa e encerra
	// ===========================================================================
	await runner.runAll();
}

main().catch((err) => {
	console.error("❌ Erro fatal no run-testes.js:", err);
	process.exit(1);
});
