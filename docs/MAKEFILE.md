# 🛠️ Automação e Comandos do Makefile

Este documento fornece a referência completa de todos os comandos de automação disponíveis via `Makefile` na **RavenaBot AI**.

O `Makefile` abstrai a complexidade do Docker Compose, facilitando inicialização, compilação, testes com mocks, sincronização em tempo real e tarefas de manutenção e banco de dados.

---

## 📋 Sumário
1. [Ajuda e Referência Rápida](#-ajuda-e-referência-rápida)
2. [Configuração Inicial e Segredos](#-configuração-inicial-e-segredos)
3. [Ciclo de Vida dos Containers (Docker Compose)](#-ciclo-de-vida-dos-containers-docker-compose)
4. [Logs e Monitoramento](#-logs-e-monitoramento)
5. [Testes e Validação](#-testes-e-validação)
6. [Sincronização e Atualizações](#-sincronização-e-atualizações)
7. [Administração de Usuários de API e Doadores](#-administração-de-usuários-de-api-e-doadores)
8. [Manutenção, Banco de Dados e Recuperação](#-manutenção-banco-de-dados-e-recuperação)

---

## ❓ Ajuda e Referência Rápida

| Comando | Descrição |
| :--- | :--- |
| `make help` | Exibe o menu formatado no terminal com todas as categorias de comandos disponíveis. |

---

## 🔑 Configuração Inicial e Segredos

| Comando | Descrição |
| :--- | :--- |
| `make setup` | Executa o assistente de configuração inicial se o arquivo `.env` ainda não existir. Pergunta parâmetros essenciais e gera credenciais criptográficas. |
| `make generate-secrets` | Cria o arquivo `.env` a partir do `.env.example`, solicitando interativamente:<br>• **Pasta de downloads no Host** (`DL_FOLDER`)<br>• **Número dos Super Admins** (`SUPER_ADMINS`)<br>• **Porta da API web** (`API_PORT`)<br>E gera senhas aleatórias seguras para `GLOBAL_API_KEY`, `POSTGRES_PASSWORD` e `S3_SECRET_KEY`. |

---

## 🐳 Ciclo de Vida dos Containers (Docker Compose)

### Inicialização e Encerramento
| Comando | Descrição |
| :--- | :--- |
| `make up` | Inicia todos os serviços em segundo plano (`docker compose up -d`) e registra o motivo de status. |
| `make up-build` | Constrói todas as imagens Docker locais e sobe a stack completa (`docker compose up -d --build`). |
| `make down` | Para e remove todos os containers em execução. |
| `make restart` | Reinicia todos os containers da aplicação de uma só vez. |
| `make build` | Constrói/recompila todas as imagens Docker sem iniciar os containers. |
| `make pull` | Baixa as versões mais recentes das imagens base externas (`postgres`, `rustfs`). |
| `make ps` | Lista o status de execução de todos os containers da stack. |

### Gerenciamento Granular por Serviço
| Comando | Descrição |
| :--- | :--- |
| `make restart-bot` | Reinicia apenas o container principal da Ravena (`ravena-ai`). |
| `make up-bot` | Executa build incremental apenas do container do bot com `--no-deps`, recriando-o sem derrubar bancos ou storage. |
| `make ravena-ai` | Executa build e recarrega o container `ravena-ai`. |
| `make restart-api` | Reinicia apenas o container da API em Go (`whatsgoapi`). |
| `make restart-db` | Reinicia apenas o container do PostgreSQL (`postgres`). |
| `make restart-storage` | Reinicia apenas o container do storage S3 (`rustfs`). |
| `make restart-rembg` | Reinicia apenas o microserviço de remoção de fundo (`rembg`). |
| `make restart-health` | Reinicia apenas o container do monitor de saúde (`health-check`). |

---

## 📜 Logs e Monitoramento

| Comando | Descrição |
| :--- | :--- |
| `make logs` | Exibe o stream contínuo de logs de todos os containers (`docker compose logs -f --tail 100`). |
| `make logs-bot` | Logs em tempo real exclusivos do container `ravena-ai`. |
| `make logs-api` | Logs em tempo real da `whatsgoapi`. |
| `make logs-db` | Logs do PostgreSQL. |
| `make logs-storage` | Logs do serviço de armazenamento S3 (`rustfs`). |
| `make logs-rembg` | Logs do serviço de remoção de fundo. |
| `make logs-health` | Logs do serviço de verificação de integridade (`health-check`). |
| `make logs-cobalt` | Logs unificados do downloader `cobalt` correlacionados com chamadas da Ravena. |
| `make skip-check` | Alterna (liga/desliga) a pausa temporária do `health-check` (cria/remove o arquivo `SKIP_HEALTH_CHECK`), útil para evitar alertas durante janelas de manutenção. |
| `make debug-ratelimit [ARGS="..."]` | Executa o script de auditoria de chamadas externas e erros HTTP 429 / rate-overlimit.<br>Exemplo: `make debug-ratelimit ARGS="--recent 20"`. |

---

## 🧪 Testes e Validação

| Comando | Descrição |
| :--- | :--- |
| `make test` | Copia os arquivos de teste para dentro do container e executa a suíte de testes sintéticos com `FakeBot` e `FakeMessage` (sem precisar conectar ao WhatsApp real). |
| `make test-quick FILE=<caminho>` | Copia rapidamente um único arquivo alterado para o container e roda os testes imediatamente.<br>Exemplo: `make test-quick FILE=src/functions/MinhaFunc.js`. |
| `make test-providers` | Testa conectividade e autenticação de todos os provedores de IA configurados no `service-providers.json`. |
| `make validate` | Valida a sintaxe e a interpolação de variáveis do `docker-compose.yml`. |

---

## 🔄 Sincronização e Atualizações

| Comando | Descrição |
| :--- | :--- |
| `make sync` | Executa `./scripts/sync-to-docker.sh` para sincronizar arquivos do host diretamente no container `ravena-ai` sem necessidade de rebuild. |
| `make update-whatsgoapi` | Atualiza e inicializa os submódulos git do `whatsgoapi`, busca a última versão de `origin/main` e reconstrói o container da API Go. |
| `make update-allm` | Executa `scripts/update-allm-cmds.js` no container para atualizar a documentação de comandos e contexto para o AnythingLLM. |
| `make update-ytdl` | Atualiza o binário do `yt-dlp` para a versão *nightly* mais recente dentro do container da Ravena. |
| `make update-donates` | Executa `./scripts/update-donates.sh` para puxar e atualizar a lista de doadores no repositório. |

---

## 👥 Administração de Usuários de API e Doadores

| Comando | Descrição |
| :--- | :--- |
| `make get-doador <termo>` | Consulta o histórico e informações de doadores por nome ou telefone.<br>Exemplo: `make get-doador 5511999999999` ou `make get-doador Carlos`. |
| `make add-api-user <nome>` | Cadastra um novo usuário para acesso à API externa do bot e gera sua chave de autorização. |
| `make del-api-user <nome>` | Revoga o acesso e remove um usuário de API externa. |
| `make list-api-users` | Lista todos os usuários de API externa registrados no sistema. |

---

## 🧹 Manutenção, Banco de Dados e Recuperação

| Comando | Descrição |
| :--- | :--- |
| `make regenerate-rarefish` | Executa script no container para regenerar fotos e placeholders de peixes raros capturados no minigame de pescaria. |
| `make recover_sql <banco.db>` | Executa rotina de recuperação para bancos SQLite corrompidos através de dump e reindexação.<br>Exemplo: `make recover_sql data/databases/groups.db`. |
| `make migrate-group <oldId> <newId>` | Migra todas as permissões, parâmetros e dados de um grupo do WhatsApp para outro (ex: após banimento de grupo ou troca de sala).<br>Exemplo: `make migrate-group 120363424022939146@g.us 120363427984421447@g.us`. |
| `make clean` | Limpeza segura de disco: remove containers parados, imagens sem uso há mais de 48h e cache do BuildKit com mais de 24h. |
| `make clean-all` | ⚠️ **Ação destrutiva:** Remove todos os containers, imagens e volumes de dados (perda total de dados!). Exige confirmação explícita digitando `y`. |
