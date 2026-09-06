The project in this folder is a whatsapp bot, developed using 3rd party APIs

# Main
bots.json - defines the bots
index.js - initialize the bots
src/WhatsAppBotGo.js - currently used API wrapper
src/EventHandler - Handle received events from the multiple APIs
src/CommandHandler - processes commands and prepares responses

## whatsgoapi (Go / whatsmeow)
- **CRITICAL:** `whatsgoapi/go.mod` and `whatsgoapi/go.sum` MUST be tracked and NOT ignored. They are essential for the Docker build.
- If they are missing, the Dockerfile will attempt to initialize them, but it's preferred to keep them in the repo.
- The module name is `whatsgo` and it uses a `replace` directive for the `whatsmeow-lib` submodule.

# Docker & Execution Environment
Este projeto é executado inteiramente dentro de containers Docker. O container principal da aplicação é `ravena-ai` (com working directory em `/app`).

## Regras Obrigatórias para Testes e Execução de Scripts
- **NUNCA** execute scripts de teste, debug ou novas rotinas diretamente no host local. Todas as dependências (Node 20, canvas, ffmpeg, pacotes npm, etc.) e o ambiente de runtime estão no container Docker.
- **SEMPRE** copie os scripts para dentro do container `ravena-ai` e execute-os lá dentro via `docker exec`.

### Comandos para Cópia e Execução:
1. **Copiar o script ou arquivo para o container:**
   ```bash
   docker cp <caminho/do/script.js> ravena-ai:/app/<caminho/do/script.js>
   ```
2. **Executar o script dentro do container:**
   ```bash
   docker exec ravena-ai node /app/<caminho/do/script.js>
   ```
3. **Limpeza pós-teste (se for um script efêmero/temporário):**
   ```bash
   docker exec ravena-ai rm /app/<caminho/do/script.js>
   ```

## Lint e Padronização de Código (OBRIGATÓRIO)
- **SEMPRE execute `npm run lint:fix`** antes de concluir qualquer tarefa, ao finalizar alterações e antes de commits.
- O script roda o ESLint com `--fix` para corrigir e garantir a padronização de formatação, regras de código e estilo do projeto:
  ```bash
  npm run lint:fix
  ```

## Harness de Testes e Mocks (`src/testing/`)
O projeto conta com uma infraestrutura própria para testes em `src/testing/`, permitindo testar comandos e regras do `EventHandler` sem abrir conexões reais de rede:

- **`FakeBot.js`**: Stub dos bots (`WhatsAppBotGo`, etc.) que simula a interface esperada pelo pipeline (`EventHandler` → `CommandHandler` → comandos/funções):
  - Captura as mensagens enviadas em `bot.capturedMessages` via `sendReturnMessages`.
  - Inicia o banco de dados em `testMode: true` (evita escrita persistente acidental durante os testes).
  - Possui `resetCapture()` para limpar as mensagens capturadas entre asserções.
  - Implementa stubs de suporte como `dossieGroups`, `isDossieGroup(groupId)`, `grupoLogs`, etc.
- **`FakeMessage.js`**: Construtor de mensagens sintéticas:
  - `createMessage(overrides)`: Constrói um objeto `message` idêntico ao gerado pelos wrappers de WhatsApp/Telegram/Discord (`author`, `authorName`, `content`, `group`, `type`, `origin.react()`, `origin.getQuotedMessage()`, etc.).
  - `loadMediaFile(absPath)`: Carrega arquivo de mídia do disco em base64 para testar comandos de mídia/figurinhas.
- **`helpers.js`**: Funções rápidas para montar mensagens de teste:
  - `msgTexto(texto, opts)`: Mensagem de texto simples.
  - `msgMedia(texto, filePath, opts)`: Mensagem com mídia anexada.
  - `msgComQuote(texto, quotedMsg, opts)`: Mensagem citando outra mensagem.
  - `msgCustom(overrides)`: Mensagem com propriedades customizadas.
- **`TestRunner.js`**: Executor de suíte de testes com gerenciamento de timeouts e relatório visual.
- **`test_dossie_groups.js`**: Exemplo prático de teste unitário/integração usando `FakeBot` e `createMessage`.

### Exemplo Rápido de Teste com FakeBot e FakeMessage:
```javascript
const FakeBot = require("./src/testing/FakeBot");
const EventHandler = require("./src/EventHandler");
const { createMessage } = require("./src/testing/FakeMessage");

async function test() {
    const bot = new FakeBot({ id: "teste", grupoLogs: "123@g.us", dossieGroups: "dossie@g.us" });
    const eventHandler = new EventHandler();

    const msg = createMessage({
        content: "!ping",
        group: "123@g.us",
        author: "5511999999999@s.whatsapp.net"
    });

    await eventHandler.processMessage(bot, msg);
    console.log("Mensagens capturadas:", bot.capturedMessages);
    process.exit(0);
}
test();
```

## Reinicialização e Rebuild de Containers (REGRA ESTRITA)
- **NUNCA execute restart ou rebuild automaticamente:** Comandos como `docker restart`, `docker compose restart`, `docker compose down`, `docker compose up --build`, rebuild de imagens ou reinício de containers NUNCA devem ser executados pelo assistente.
- **SEMPRE SOLICITAR AO USUÁRIO:** Qualquer necessidade de reiniciar ou reconstruir containers deve SEMPRE ser solicitada ao usuário, explicando o motivo e sugerindo o comando adequado para que o usuário execute por conta própria.

# Commands
## SuperAdmin
Only for the bot owner, useful commands like join group

## Management
Only for group admins, defined in src/commands/Management.js
CRUD commands, set group parameters and more


## FixedComands
Loads implemented commands from src/function folders (autoload), all of them export their commands:
module.exports = { commands };

They receive messages from the CommandHandler and reply by returning a single or array of ReturnMessages (defined in src/models). They can also directly send messages or reactions using bot client object

## CustomCommands
Create by group admins using management commands

# More
Will be specified in the prompts

For database schema and structure, see: DATABASES.md