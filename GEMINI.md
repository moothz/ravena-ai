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

### Prevenção Crítica de Processos Órfãos e Travamento de Servidor (OBRIGATÓRIO)
1. **`process.exit(...)` OBRIGATÓRIO EM TODOS OS SCRIPTS E TESTES:**
   - **NUNCA** confie no encerramento natural do event loop do Node.js. Diversos módulos do projeto (como `Database`, `StickerScraper`, pools SQLite, serviços HTTP) mantêm conexões abertas e timers ativos que impedem o Node de encerrar sozinho.
   - **SEMPRE** termine qualquer script de teste, debug ou utilitário com `process.exit(0)` em caso de sucesso e `process.exit(1)` em caso de erro:
     ```javascript
     main()
         .then(() => process.exit(0))
         .catch((err) => {
             console.error(err);
             process.exit(1);
         });
     ```
2. **Comandos `node -e` (One-liners) SEMPRE com `process.exit(0)`:**
   - Se for rodar um comando inline com `node -e`, inclua **obrigatoriamente** `; process.exit(0);` no final:
     ```bash
     docker exec ravena-ai node -e "const db = ...; console.log(...); process.exit(0);"
     ```
   - Comandos `node -e` sem `process.exit(0)` ficam rodando indefinidamente em segundo plano no container, consumindo 20-30% de CPU e gigabytes de RAM.
3. **Desativação de Timers em Módulos Importados (`DISABLE_STICKER_SCRAPER_TIMER="true"`):**
   - Módulos como `StickerScraper` disparam timers automáticos ao serem importados (`require`).
   - Em scripts efêmeros, passe a variável de ambiente ou defina no topo do script:
     ```javascript
     process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
     process.env.DISABLE_ACTIVITY = "true";
     ```
4. **Verificação de Processos Órfãos Após Execuções:**
   - Se uma tarefa der timeout ou for cancelada no assistente, o processo filho dentro do container Docker pode continuar rodando no kernel.
   - Verifique com `docker top ravena-ai` e, caso haja processos `node` órfãos (que não sejam o PID 1 `node index.js`), encerre-os imediatamente:
     ```bash
     # Listar processos dentro do container
     docker exec ravena-ai bash -c 'for p in /proc/[0-9]*; do if [ -f "$p/cmdline" ]; then echo "$p: $(tr "\0" " " < "$p/cmdline")"; fi; done'
     ```

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

## Privacidade e Proteção de Dados de Usuários em Commits (OBRIGATÓRIO)
- **NUNCA** inclua números de telefone reais de usuários, JIDs reais (`@s.whatsapp.net`, `@c.us`), nomes de usuários ou dados pessoais em arquivos versionados no git (testes, documentações, logs, fixtures, mocks ou código).
- **SEMPRE** utilize dados sintéticos e fictícios para testes e exemplos (ex.: `5511999990001`, `5511999991111@s.whatsapp.net`, `logs@g.us`, `120363000000000099@g.us`).
- **Verificação obrigatória pré-commit:** Antes de qualquer commit, analise o `git diff` e garanta que nenhum identificador real de usuário ou grupo privado real seja exposto.

## Telemetria OpenTelemetry (OBRIGATÓRIO em todo PR)
Todo comando, rota, serviço ou fluxo novo (ou alterado) deve sair instrumentado. Referência completa: `OBSERVABILITY.md`. Helpers em `src/telemetry/index.js` (no-op com a telemetria desligada, então não precisa de `if`).
- **Comandos:** o `CommandHandler` já cria o span `command <nome>`. Acrescente os atributos de negócio relevantes com `telemetry.setAttrs({ "ravena.<domínio>.<campo>": valor })` e, quando o comando recusar algo esperado (saldo, cooldown, limite), marque `app.outcome: "rejected"` e `app.reject.reason: "<motivo_curto>"`. Recusa de negócio **não** é erro.
- **Etapas que podem ser lentas** (imagem, LLM, chamada externa, laço pesado, SQLite grande): envolva em `telemetry.withSpan("<área> <etapa>", { attributes }, () => ...)`.
- **Trabalho fora da mensagem** (`setTimeout`, cron, fila, retry agendado, webhook recebido): abra um trace próprio com `telemetry.withSpan`/`telemetry.withCommandSpan(nome, { root: true, links: [{ context: spanOrigem.spanContext() }] }, fn)`. HTTP de saída sem span pai é descartado, então sem isso a chamada some.
- **Rotas da BotAPI:** o Express já gera o span SERVER; `:userId`/`:groupId` já viram atributo. Para outros campos de usuário no corpo, use `telemetry.userIdAttr()`.
- **IDs:** usuário só via `telemetry.userIdAttr(id)` em `*.user.id`; grupo/chat via `telemetry.chatIdAttr(id)` em `*.chat.id`. **Nunca** no nome do span.
- **Nunca** em span, atributo ou evento: nome/apelido, texto de mensagem, argumentos de comando, prompt/resposta de LLM, tokens, chaves, headers de auth.
- **Nome de span:** baixa cardinalidade (`<área> <operação>`, ex.: `fazenda harvest.reconcile`), sem IDs nem valores, porque vira dimensão de métrica.
- **Erro inesperado:** `telemetry.recordError(span, err)` (marca ERROR e grava a exceção).
- **Documentação:** acrescente o span novo na tabela "Spans de negócio" do `OBSERVABILITY.md`.
- **Validar:** com `OTEL_EXPORTER_OTLP_ENDPOINT` ligado localmente, gere tráfego (`src/testing/otel_traffic.js` ou FakeBot) e confira o span no Jaeger (`http://localhost:16686`).

## Mudanças de balanceamento da economia: registrar depois do deploy (OBRIGATÓRIO)
O painel da economia (Grafana, aba **Mudanças**) compara os 7 dias antes e depois de cada mudança. Para isso, toda mudança que altere quanto de Runas (ou, por comando da ravena, Zinthos e Petalitas) entra ou sai precisa estar registrada **no instante em que passou a valer em produção**.
- **O que conta:** recompensa, preço, taxa, limite diário, chance, cotação, multiplicador, cooldown que limita ganho, evento com prêmio, compensação, give-all e script retroativo que credita ou debita moeda.
- **Prefira constante a número solto no código.** Nas Runas, os valores de câmbio, cotas e loja ficam no `BankService` e saem em `getEconomyParams()`; valor novo de economia deve entrar ali. Constante que está na rota `GET /internal/economy/params` é registrada sozinha pela ravena no deploy, com o valor antigo e o novo. Constante nova nos arquivos cobertos precisa entrar na rota ou na lista de ignoradas, ou o teste de guarda falha.
- **Registre depois do deploy, nunca no commit nem na abertura do PR.** O commit pode levar dias para ir ao ar, e a ficha mediria a semana errada.
- **No PR**, inclua uma seção "Registro pós-deploy" com o comando pronto para quem fizer o deploy:
  `docker exec ravena-ai node scripts/economy-annotate.js "<o que mudou e por quê>" <zinthos|petalitas|runas|todas> [hora ISO do deploy]`
  Sem a hora, o registro vale para agora. Se o deploy já aconteceu, passe a hora dele.
- **Se você fizer ou acompanhar o deploy**, rode o comando assim que a versão nova estiver no ar. Antes, confira com `docker exec ravena-ai node scripts/economy-annotate.js --listar` se a mudança já entrou como automática. Se entrou, não registre de novo: o porquê fica no PR.
- **Script retroativo, compensação ou give-all:** registre depois da execução, com a hora em que rodou.
- **Possíveis mudanças** (marca âmbar, detectadas nos dados): decida com `--confirmar <ts> "texto"` ou `--descartar <ts> "texto"` (o `ts` sai do `--listar`).

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
- **SEMPRE SUGERIR REBUILD (`--build`) PARA ALTERAÇÕES DE CÓDIGO (OBRIGATÓRIO):**
  - **`docker restart` NÃO APLICA MUDANÇAS DE CÓDIGO** em containers sem volume vivo mapeado ou com compilação interna (TypeScript, Go, Rust, etc.).
  - Em `ravena-ai`, os volumes de código (`./src` e `./index.js`) estão comentados por padrão no `docker-compose.yml` para isolamento de produção. Qualquer alteração de código ou dependência EXIGE rebuild da imagem:
    ```bash
    docker compose up -d --build ravena-ai
    ```
  - Em `waifuletes`, a API roda em TypeScript compilado no Docker multi-stage (`RUN npm run build` -> `dist/`) e não mapeia `src/` nem `dist/`. Qualquer alteração de backend EXIGE rebuild:
    ```bash
    docker compose -f /home/moothz/waifuletes/docker-compose.yml up -d --build api
    ```
  - Em `whatsgoapi`, a aplicação é compilada em binário Go. Qualquer alteração em Go EXIGE rebuild:
    ```bash
    docker compose up -d --build whatsgoapi
    ```
  - **REGRA DE OURO:** NUNCA sugira apenas `docker restart` quando arquivos de código, serviços, rotas ou dependências forem modificados. Sempre forneça diretamente os comandos completos com `--build`, evitando que o usuário precise intervir para questionar se precisa de rebuild.

# Commands
## SuperAdmin
Only for the bot owner, useful commands like join group
- **CRÍTICO:** Comandos de Super Admin (`!sa-` / `src/commands/SuperAdmin.js`) NUNCA devem ser incluídos no `docs/LLM-HELPER.md` nem expostos para usuários ou documentações da IA. Eles são de uso estritamente exclusivo do dono do bot e devem permanecer FORA do `LLM-HELPER.md`.

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