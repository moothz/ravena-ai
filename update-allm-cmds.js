const fs = require("fs").promises;
const path = require("path");

// Mocking some parts to avoid side effects and errors
process.env.SUPPRESS_LOGS = "true";

const FixedCommands = require("./src/commands/FixedCommands");
const Management = require("./src/commands/Management");
const SuperAdmin = require("./src/commands/SuperAdmin");

async function generateDocs() {
	console.log("🚀 Iniciando geração de documentação consolidada para Ravena LLM Helper...");

	const fixedCmds = new FixedCommands();
	await fixedCmds.loadCommands();

	const management = new Management();
	const superAdmin = new SuperAdmin();

	// 1. Load Base Information
	const BASE_INFO = `# Ravena - Informações Base

Este documento contém informações fundamentais sobre o bot Ravena, seu funcionamento, recursos e como auxiliar os usuários.

---

## 🤖 Sobre a Ravena
A **Ravena** é um bot de WhatsApp gratuito e de código aberto, desenvolvido por **moothz**. Seu código está disponível no GitHub: https://github.com/moothz/ravena-ai.
O objetivo principal é auxiliar streamers, gerenciar comunidades e aumentar a interação através de jogos e utilidades.

### Recursos Principais
- **Mídia**: Criação de figurinhas, download de vídeos/músicas, conversão de formatos.
- **IA**: Processamento de mensagens com LLMs, geração de imagens, tradução e transcrição de áudio.
- **Jogos**: Pescaria (!pesca), Roleta Russa (!roleta), Slots (!slots), Anagrama, Tarot e mais.
- **Utilidades**: Clima, Notícias, Horóscopo, Pesquisas Google/Wikipedia.
- **Streaming**: Notificações de lives (Twitch, Kick, YouTube).
- **Gerenciamento**: Painel Web (!g-painel), filtros de links/NSFW, mensagens de boas-vindas.

### Adicionar ravena em um grupo
Se o usuário enviar um link de convite como "https://chat.whatsapp.com/abcd1234" ou pedir "adicionar no grupo", "entrar no grupo", "colocar no grupo"
Informe ele que o link deve ser enviada para um dos números da ravena diretamente no whatsapp, e envie os números do bot
Envie as instruções de convite

---

## 📞 Contatos e Números
- **Criador/Dono**: (55) 99642-4307
- **ravena2**: (98) 98771-5450
- **ravena4**: (55) 98102-4412
- **ravena5**: (55) 99153-7296
- **ravena10**: (55) 98102-4412
- **Bot Oficial (Lobby)**: Disponível via https://chat.whatsapp.com/GMtTi1V6XIBChCBgkQC9g0 ou no site https://ravena.moothz.win

### Instruções de Convite
Pra começar, envie o *LINK*, apenas o _LINK_ do seu grupo  para uma das ravenas (não pode ser aqui no chat de suporte nem para as vips)
Se você tentar adicionar a ravena no grupo, não vai dar certo.
Após o link, siga as instruções do bot, enviando uma mensagem explicando o motivo de querer o bot no seu grupo.

Não consigo colocar em todos os grupos devido a capacidade do _WhatsAppWeb+Celular_, então isto serve como uma forma de *seleção*, um filtro pra evitar dores de cabeça e gente que não sabe ler as instruções.
Me reservo no direito de remover o bot do seu grupo caso ache necessário.

🏆 *No geral, dou essas prioridades:*
- *Doadores*: Pessoas que contribuem com os custos da ravena (!doar)
- *Streamers/Produtores de conteúdo*: Vão usar as principais funções da ravena, que são as integrações com Twitch, Kick e Youtube
- *Organização*: Grupos com descrições boas e organizados

🙅‍ *E também evito o seguinte:*
- *Jamais aceito:* Nome/descrição com coisas _racistas, xenofóbicas, homofóbicas e machistas_ em geral (aqui não é chat do lol)
- *Underage*: Grupos claramente de crianças/adolescentes (principalmente os que usam 𝒸𝒶𝓇𝒶𝒸𝓉ℯ𝓇ℯ𝓈 𝒶𝓈𝓈𝒾𝓂)
- *Só casos específicos:* Grupos apenas de figurinhas, grupos de colégio/turmas
- *Penso bem antes*: Grupos que removem o bot, grupos de teste, convites mal escritos ou por IA (oh, a ironia!)

⚠️ *Atenção*: Se o bot for removido logo após entrar  no grupo, você será *bloqueado* _(considerarei que não tinha permissão ou pouco interesse)_.

### Ravena Comunitária
Iniciativa onde membros doam chips para rodar o bot. O dono da instância comunitária tem acesso aos logs técnicos. Se a privacidade total for uma preocupação, recomenda-se usar as instâncias oficiais ou hospedar sua própria.

---

## 💖 Doações
O projeto é mantido por doações voluntárias que ajudam nos custos de servidores e APIs.
- **Link**: https://tipa.ai/moothz

---

## 💡 Como Auxiliar o Usuário (Diretrizes)
Você (AnythingLLM) deve atuar como uma assistente proativa. Siga estas regras:

1.  **Sugira Comandos Específicos**: Quando o usuário perguntar "como fazer X", identifique o comando correspondente na lista abaixo e mostre como usar.
    *   *Exemplo:* "Como vejo o tempo?" -> "Use o comando \`!clima [cidade]\`. Exemplo: \`!clima Porto Alegre\`"
2.  **Criação de Comandos Personalizados**: Auxilie na criação de comandos usando \`!g-addCmd\`.
    *   Sempre sugira o uso de **Variáveis** para tornar o comando dinâmico.
    *   *Exemplo:* "Quero um comando que mande um pokemon aleatório" -> "Você pode criar assim: \`!g-addCmd poke Você capturou um *{pokemonEN}*!\`"
3.  **Explique Variáveis**: Se o usuário mencionar algo aleatório (peixes, carros, países), verifique se existe uma variável correspondente (ex: \`{peixe}\`, \`{carro2024}\`, \`{emojiBandeiraPais}\`) e sugira seu uso.
4.  **Workarounds**: Se o usuário quiser "editar" um comando fixo, explique que ele deve criar um alias com \`{cmd-nome}\` e silenciar o original com \`!g-mute\`.

---

## 🛠️ Dicas de Gerenciamento
- **Painel Web**: Sempre sugira o \`!g-painel\` para configurações complexas, é mais fácil que comandos de chat.
- **Prefixo**: Grupos podem ter prefixos personalizados.
- **Mute**: Se um comando estiver incomodando, use \`!g-mute [comando]\`.

---

## ⚙️ Visão Técnica (Para Referência)
- **Banco de Dados**: SQLite (\`data/sqlites/\`). Tabelas principais: \`groups\`, \`custom_commands\`, \`donations\`.
- **Logs**: O uso de comandos é registrado em \`cmd_usage.db\`.
- **Media**: Arquivos temporários ficam em \`data/media/\`.`;

	let finalMd = BASE_INFO + "\n\n---\n\n";

	// --- 2. Generate Command List ---
	finalMd += "# 📚 Referência de Comandos\n\n";
	finalMd += "Abaixo está a lista de todos os comandos que você pode sugerir aos usuários.\n\n";

	// 2.1 Fixed Commands (Comuns)
	finalMd += "## 🛠️ Comandos Comuns (Fixed Commands)\n";
	finalMd += "Estes comandos podem ser usados por qualquer membro.\n\n";

	const allFixed = fixedCmds.getAllCommands();
	const categorized = {};

	for (const cmd of allFixed) {
		if (cmd.hidden) continue;
		const cat = cmd.category || "Geral";
		if (!categorized[cat]) categorized[cat] = [];
		categorized[cat].push(cmd);
	}

	for (const [cat, cmds] of Object.entries(categorized)) {
		finalMd += `### Categoria: ${cat}\n`;
		for (const cmd of cmds) {
			finalMd += `#### !${cmd.name}\n`;
			finalMd += `**Descrição:** ${cmd.description || "Sem descrição."}\n\n`;
			if (cmd.usage) {
				finalMd += `**Uso:** \`!${cmd.name} ${cmd.usage}\`\n\n`;
			}
			if (cmd.example) {
				finalMd += `**Exemplo:** \`!${cmd.name} ${cmd.example}\`\n\n`;
			} else if (cmd.usage) {
				finalMd += `**Exemplo:** \`!${cmd.name} ${cmd.usage.split("|")[0].trim()}\`\n\n`;
			}
			finalMd += "---\n\n";
		}
	}

	// 2.2 Management Commands (Gerência)
	finalMd += "## ⚙️ Comandos de Gerenciamento\n";
	finalMd += "Começam com `!g-` e são restritos a administradores.\n\n";

	const manageCmdMap = management.commandMap;
	for (const [cmdName, cmdData] of Object.entries(manageCmdMap)) {
		finalMd += `#### !g-${cmdName}\n`;
		finalMd += `**Descrição:** ${cmdData.description || "Sem descrição."}\n\n`;
		finalMd += "---\n\n";
	}

	// 2.3 SuperAdmin Commands
	finalMd += "## 👑 Comandos de Super Admin\n";
	finalMd += "Começam com `!sa-` e são exclusivos do dono do bot.\n\n";

	const saCmdMap = superAdmin.commandMap;
	for (const [cmdName, cmdData] of Object.entries(saCmdMap)) {
		finalMd += `#### !sa-${cmdName}\n`;
		finalMd += `**Descrição:** ${cmdData.description || "Sem descrição."}\n\n`;
		finalMd += "---\n\n";
	}

	// --- 3. Generate Variable List ---
	finalMd += "# 🎲 Variáveis para Comandos Personalizados\n\n";
	finalMd += "Use estas variáveis ao sugerir a criação de comandos com `!g-addCmd`.\n\n";

	const sections = {
		"🚪 Boas vindas/despedidas": [
			{ name: "{pessoa}", description: "Nome da pessoa" },
			{ name: "{tituloGrupo}", description: "Título do grupo" }
		],
		"🕐 Variáveis de Sistema": [
			{ name: "{day}", description: "Nome do dia (ex: Segunda-feira)" },
			{ name: "{date}", description: "Data atual" },
			{ name: "{time}", description: "Hora atual" },
			{ name: "{data-hora}", description: "Hora (HH)" },
			{ name: "{data-dia}", description: "Dia (DD)" },
			{ name: "{data-mes}", description: "Mês (MM)" },
			{ name: "{data-ano}", description: "Ano (YYYY)" }
		],
		"🎲 Números Aleatórios": [
			{ name: "{randomPequeno}", description: "1 a 10" },
			{ name: "{randomMedio}", description: "1 a 100" },
			{ name: "{randomGrande}", description: "1 a 1000" },
			{ name: "{rndDado-X}", description: "Dado de X lados" },
			{ name: "{rndDadoRange-X-Y}", description: "Aleatório entre X e Y" }
		],
		"👤 Contexto e Menções": [
			{ name: "{pessoa}", description: "Nome do autor" },
			{ name: "{group}", description: "Nome do grupo" },
			{ name: "{contador}", description: "Contagem de execuções" },
			{ name: "{mention}", description: "Marca alguém (mencionado ou aleatório)" },
			{ name: "{singleMention}", description: "Marca a mesma pessoa em todas as ocorrências" },
			{ name: "{mentionOuEu}", description: "Marca alguém ou o autor se não houver menção" },
			{ name: "{membroRandom}", description: "Nome de um membro aleatório" }
		],
		"🌐 APIs e Web": [
			{ name: "{weather:cidade}", description: "Clima atual na cidade" },
			{ name: "{reddit-subreddit}", description: "Mídia aleatória de um subreddit" },
			{ name: "{API#GET#TEXT#url}", description: "Resultado de texto de uma API" }
		],
		"📁 Outros": [
			{ name: "{file-nome}", description: "Envia arquivo de 'data/media/'" },
			{ name: "{cmd-comando}", description: "Executa outro comando (alias)" }
		]
	};

	for (const [sectionName, vars] of Object.entries(sections)) {
		finalMd += `### ${sectionName}\n`;
		for (const v of vars) {
			finalMd += `- \`${v.name}\`: ${v.description}\n`;
		}
		finalMd += "\n";
	}

	// --- 4. Extra: Random Variables from JSON ---
	try {
		const customVarsData = JSON.parse(
			await fs.readFile(path.join(__dirname, "data", "custom-variables.json"), "utf-8")
		);
		const randomKeys = Object.keys(customVarsData);
		if (randomKeys.length > 0) {
			finalMd += "### 🎭 Variáveis de Sorteio (Aleatórias)\n";
			finalMd +=
				"Estas variáveis escolhem um item aleatório de uma lista pré-definida. Sugira-as para comandos divertidos.\n\n";
			for (const key of randomKeys) {
				finalMd += `- \`{${key}}\`\n`;
			}
			finalMd += "\n";
		}
	} catch (err) {
		console.warn(
			"⚠️ Não foi possível carregar custom-variables.json para a lista de variáveis aleatórias."
		);
	}

	await fs.writeFile(path.join(__dirname, "ravena-llm-helper.md"), finalMd);
	console.log("✅ Arquivo ravena-llm-helper.md gerado com sucesso!");

	console.log("\n✨ Processo concluído!");

	// Tenta fechar o banco de dados graciosamente, mas força a saída
	try {
		const Database = require("./src/utils/Database");
		const db = Database.getInstance();
		if (db && typeof db.closeAll === "function") {
			await db.closeAll();
		}
	} catch (e) {
		// Ignora erros ao fechar
	}

	process.exit(0);
}

generateDocs().catch((err) => {
	console.error("❌ Erro durante a geração:", err);
	process.exit(1);
});
