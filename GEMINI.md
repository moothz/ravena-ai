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