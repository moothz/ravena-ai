.PHONY: help setup generate-secrets up down logs restart build pull ps update-allm update-ytdl update-whatsgoapi logs-cobalt recover_sql skip-check

# Habilita o Docker BuildKit por padrão para builds mais rápidas
export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

# Suporte para argumentos posicionais no comando make recover_sql
ifeq ($(firstword $(MAKECMDGOALS)),recover_sql)
  RUN_ARGS := $(wordlist 2,$(words $(MAKECMDGOALS)),$(MAKECMDGOALS))
  $(eval $(RUN_ARGS):;@:)
endif

# Cores usando escape codes literais para garantir compatibilidade
GREEN  := $(shell printf '\033[0;32m')
YELLOW := $(shell printf '\033[0;33m')
CYAN   := $(shell printf '\033[0;36m')
NC     := $(shell printf '\033[0m')

##@ Ajuda

help: ## Mostra esta mensagem de ajuda
	@printf "$(GREEN)ravena-ai — Docker Compose$(NC)\n"
	@awk 'BEGIN {FS = ":.*##"; printf "\nUso:\n  make $(YELLOW)<alvo>$(NC)\n"} \
		/^[a-zA-Z_-]+:.*?##/ { printf "  $(GREEN)%-20s$(NC) %s\n", $$1, $$2 } \
		/^##@/ { printf "\n$(CYAN)%s$(NC)\n", substr($$0, 5) }' $(MAKEFILE_LIST)

##@ Configuração

setup: ## Configuração inicial interativa: gera segredos e cria o .env
	@if [ -f .env ]; then \
		printf "$(YELLOW)O arquivo .env já existe. Remova-o se desejar gerar novamente.$(NC)\n"; \
	else \
		$(MAKE) generate-secrets; \
	fi

generate-secrets: ## Gera o .env a partir do .env.example com segredos e inputs do usuário
	@printf "$(GREEN)Configurando o arquivo .env...$(NC)\n"
	@cp .env.example .env
	@printf "$(CYAN)Responda as perguntas abaixo (ou pressione ENTER para o valor padrão):$(NC)\n"
	@printf "$(YELLOW)📁 Pasta de downloads no HOST [padrão: /mnt/downloads]: $(NC)"; \
		read -r INPUT_DL_FOLDER; \
		DL_FOLDER=$${INPUT_DL_FOLDER:-/mnt/downloads}; \
		sed -i "s|DL_FOLDER=/mnt/downloads|DL_FOLDER=$$DL_FOLDER|g" .env
	@printf "$(YELLOW)👑 IDs dos Super Admins [padrão: 12345@c.us]: $(NC)"; \
		read -r INPUT_SUPER_ADMINS; \
		SUPER_ADMINS=$${INPUT_SUPER_ADMINS:-12345@c.us}; \
		sed -i "s|SUPER_ADMINS=12345@c.us|SUPER_ADMINS=$$SUPER_ADMINS|g" .env
	@printf "$(YELLOW)🌐 Porta da API [padrão: 5000]: $(NC)"; \
		read -r INPUT_API_PORT; \
		API_PORT=$${INPUT_API_PORT:-5000}; \
		sed -i "s|API_PORT=5000|API_PORT=$$API_PORT|g" .env
	@printf "\n$(GREEN)Gerando segredos aleatórios...$(NC)\n"
	@GLOBAL_API_KEY=$$(tr -dc 'a-zA-Z0-9' < /dev/urandom | fold -w 30 | head -n 1); \
		sed -i "s|GLOBAL_API_KEY=SUA_GLOBAL_API_KEY|GLOBAL_API_KEY=$$GLOBAL_API_KEY|g" .env; \
		printf "$(GREEN)  GLOBAL_API_KEY gerada$(NC)\n"
	@PG_PASS=$$(openssl rand -hex 16); \
		sed -i "s|POSTGRES_PASSWORD=whatsgo_password|POSTGRES_PASSWORD=$$PG_PASS|g" .env; \
		printf "$(GREEN)  POSTGRES_PASSWORD gerada$(NC)\n"
	@MINIO_PASS=$$(openssl rand -hex 16); \
		sed -i "s|MINIO_SECRET_KEY=minioadmin_password|MINIO_SECRET_KEY=$$MINIO_PASS|g" .env; \
		printf "$(GREEN)  MINIO_SECRET_KEY gerada$(NC)\n"
	@printf "\n"
	@printf "$(YELLOW)⚠️  Arquivo .env criado com suas preferências.$(NC)\n"
	@printf "$(CYAN)   Lembre-se de editar o .env para preencher outras chaves de API se necessário.$(NC)\n"
	@printf "\n"

##@ Docker

up: ## Inicia todos os serviços em modo background
	@mkdir -p data && echo "Iniciando todos os serviços..." > data/status_motivo.txt
	docker compose up -d

up-build: ## Constrói as imagens e inicia todos os serviços
	@mkdir -p data && echo "Construindo imagens e iniciando os serviços..." > data/status_motivo.txt
	docker compose up -d --build

down: ## Para todos os serviços
	@mkdir -p data && echo "Serviços desligados pelo administrador." > data/status_motivo.txt
	docker compose down

restart: ## Reinicia todos os serviços
	@mkdir -p data && echo "Reiniciando todos os serviços..." > data/status_motivo.txt
	docker compose restart

restart-bot: ## Reinicia apenas o bot ravena-ai
	@mkdir -p data && echo "Reiniciando o contêiner do bot..." > data/status_motivo.txt
	docker compose restart ravena-ai

restart-api: ## Reinicia apenas o whatsgoapi
	docker compose restart whatsgoapi

restart-db: ## Reinicia apenas o banco de dados (postgres)
	docker compose restart postgres

restart-minio: ## Reinicia apenas o storage (minio)
	docker compose restart minio

restart-rembg: ## Reinicia apenas o serviço rembg
	docker compose restart rembg

restart-health: ## Reinicia apenas o monitor de saúde
	docker compose restart health-check

skip-check: ## Alterna (liga/desliga) a pausa da verificação de saúde do health-check
	@if [ -f SKIP_HEALTH_CHECK ]; then \
		rm -f SKIP_HEALTH_CHECK; \
		printf "$(GREEN)✅ SKIP_HEALTH_CHECK removido. Verificação de saúde ATIVADA.$(NC)\n"; \
	else \
		touch SKIP_HEALTH_CHECK; \
		printf "$(YELLOW)⏸️  SKIP_HEALTH_CHECK criado. Verificação de saúde PAUSADA.$(NC)\n"; \
	fi


ravena-ai: ## Faz build e recarrega o código do bot ravena-ai
	@mkdir -p data && echo "Atualizando código e reiniciando o bot..." > data/status_motivo.txt
	docker compose build ravena-ai
	docker compose up -d ravena-ai

build: ## Constrói todas as imagens Docker
	@mkdir -p data && echo "Reconstruindo imagens Docker..." > data/status_motivo.txt
	docker compose build

pull: ## Baixa as imagens base mais recentes
	docker compose pull postgres minio

logs: ## Exibe os logs de todos os serviços
	docker compose logs -f --tail 100

logs-bot: ## Exibe os logs do bot ravena-ai
	docker compose logs -f --tail 100 ravena-ai

logs-cobalt: ## Exibe e une os logs do container cobalt e logs relacionados no bot ravena-ai
	docker compose logs -f --tail 100 cobalt ravena-ai | grep --line-buffered -i cobalt

logs-api: ## Exibe os logs do whatsgoapi
	docker compose logs -f --tail 100 whatsgoapi

logs-db: ## Exibe os logs do banco de dados (postgres)
	docker compose logs -f --tail 100 postgres

logs-minio: ## Exibe os logs do storage (minio)
	docker compose logs -f --tail 100 minio

logs-rembg: ## Exibe os logs do serviço de remoção de fundo (rembg)
	docker compose logs -f --tail 100 rembg

logs-health: ## Exibe os logs do monitor de saúde (health-check)
	docker compose logs -f --tail 100 health-check

ps: ## Mostra o status de todos os containers
	docker compose ps

update-allm: ## Atualiza a documentação de comandos para o AnythingLLM no container
	docker compose exec ravena-ai node update-allm-cmds.js

update-ytdl: ## Atualiza o yt-dlp para nightly dentro do container ravena-ai
	docker compose exec ravena-ai bash update-ytdl.sh

update-donates: ## Atualiza o ranking de doadores no README.md
	@./update-donates.sh

test: ## Roda o arquivo run-testes.js dentro do container (sem WhatsApp)
	docker cp run-testes.js $$(docker compose ps -q ravena-ai):/app/run-testes.js
	docker cp src/testing $$(docker compose ps -q ravena-ai):/app/src/
	docker compose exec ravena-ai node run-testes.js

test-quick: ## Copia um arquivo alterado e roda os testes (uso: make test-quick FILE=src/functions/MinhaFunc.js)
	@if [ -z "$(FILE)" ]; then printf "$(YELLOW)Uso: make test-quick FILE=caminho/do/arquivo.js$(NC)\n"; exit 1; fi
	docker cp $(FILE) $$(docker compose ps -q ravena-ai):/app/$(FILE)
	docker compose exec ravena-ai node run-testes.js

test-providers: ## Testa todos os provedores de IA do service-providers.json
	@node test-providers.js

regenerate-rarefish: ## Regenera imagens de capturas raras perdidas ou placeholders
	docker compose exec ravena-ai node regenerate-rarefish.js

sync: ## Sincroniza arquivos modificados com o container ravena-ai
	@./sync-to-docker.sh

update-whatsgoapi: ## Sincroniza o submódulo whatsgoapi e reconstrói o container
	@printf "$(CYAN)Sincronizando submódulo whatsgoapi...$(NC)\n"
	@git submodule update --init --recursive
	@cd whatsgoapi && git fetch origin && git reset --hard origin/main
	@printf "$(GREEN)Submódulo atualizado com sucesso.$(NC)\n"
	@printf "$(CYAN)Reconstruindo imagem do whatsgoapi...$(NC)\n"
	docker compose up -d --build whatsgoapi
	@printf "$(GREEN)✅ WhatsGoAPI atualizado e reiniciado!$(NC)\n"

##@ Manutenção

clean: ## Remove containers parados, imagens não utilizadas (>48h) e cache do BuildKit (>24h)
	docker compose down --remove-orphans
	docker image prune -a -f --filter "until=48h"
	docker builder prune -a -f --filter "until=24h"

clean-all: ## PERIGO: Remove TODOS os containers, imagens e volumes (perda de dados!)
	@printf "$(YELLOW)⚠️  Isso irá APAGAR todos os volumes de dados. Tem certeza? [y/N]$(NC)\n"
	@read -r CONFIRM; if [ "$$CONFIRM" = "y" ]; then \
		docker compose down --volumes --remove-orphans; \
		docker image prune -af; \
		printf "$(GREEN)Concluído.$(NC)\n"; \
	else \
		printf "Abortado.\n"; \
	fi

validate: ## Valida a sintaxe do arquivo docker-compose.yml
	@docker compose config --quiet && printf "$(GREEN)✅ docker-compose.yml é válido$(NC)\n" || printf "$(YELLOW)❌ docker-compose.yml inválido$(NC)\n"

recover_sql: ## Recupera banco SQLite corrompido (Uso: make recover_sql <banco.db> ou make recover_sql DB=<banco.db>)
	@DB_PATH="$(RUN_ARGS)"; \
	if [ -z "$$DB_PATH" ]; then DB_PATH="$(DB)"; fi; \
	if [ -z "$$DB_PATH" ]; then printf "$(YELLOW)Uso: make recover_sql <caminho/do/banco.db> ou make recover_sql DB=<caminho/do/banco.db>$(NC)\n"; exit 1; fi; \
	./recover-sqlite.sh "$$DB_PATH"
