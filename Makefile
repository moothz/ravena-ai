.PHONY: help setup generate-secrets up down logs restart build pull ps update-allm update-ytdl update-whatsgoapi

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
	docker compose up -d

up-build: ## Constrói as imagens e inicia todos os serviços
	docker compose up -d --build

down: ## Para todos os serviços
	docker compose down

restart: ## Reinicia todos os serviços
	docker compose restart

restart-bot: ## Reinicia apenas o bot ravena-ai
	docker compose restart ravena-ai

ravena-ai: ## Faz lint, build e recarrega o código do bot ravena-ai
	npm run lint:fix && docker compose up -d --build ravena-ai

restart-api: ## Reinicia apenas o whatsgoapi
	docker compose restart whatsgoapi

build: ## Constrói todas as imagens Docker
	docker compose build

pull: ## Baixa as imagens base mais recentes
	docker compose pull postgres minio

logs: ## Exibe os logs de todos os serviços
	docker compose logs -f

logs-bot: ## Exibe os logs do bot ravena-ai
	docker compose logs -f ravena-ai

logs-api: ## Exibe os logs do whatsgoapi
	docker compose logs -f whatsgoapi

ps: ## Mostra o status de todos os containers
	docker compose ps

update-allm: ## Atualiza a documentação de comandos para o AnythingLLM no container
	docker compose exec ravena-ai node update-allm-cmds.js

update-ytdl: ## Atualiza o binário yt-dlp dentro do container
	docker compose exec ravena-ai bash update-ytdl.sh

update-whatsgoapi: ## Sincroniza o submódulo whatsgoapi e reconstrói o container
	@printf "$(CYAN)Sincronizando submódulo whatsgoapi...$(NC)\n"
	@git submodule update --init --recursive
	@cd whatsgoapi && git fetch origin && git reset --hard origin/main
	@printf "$(GREEN)Submódulo atualizado com sucesso.$(NC)\n"
	@printf "$(CYAN)Reconstruindo imagem do whatsgoapi...$(NC)\n"
	docker compose up -d --build whatsgoapi
	@printf "$(GREEN)✅ WhatsGoAPI atualizado e reiniciado!$(NC)\n"

##@ Manutenção

clean: ## Remove containers parados e imagens órfãs
	docker compose down --remove-orphans
	docker image prune -f

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
