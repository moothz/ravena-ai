#!/bin/bash

# ==============================================================================
# Script de Recuperação Automatizada de Banco de Dados SQLite Corrompido
# ==============================================================================
#
# COMO USAR:
#   1. Recuperar um arquivo que está na raiz ou caminho específico:
#      ./recover-sqlite.sh cmd_usage.db
#      (ou via Makefile: make recover_sql cmd_usage.db)
#
#   2. Recuperar o banco de dados ativo do bot (em data/sqlites/):
#      ./recover-sqlite.sh cmd_usage.db
#      (se o arquivo não existir na raiz, ele buscará em data/sqlites/)
#      (ou via Makefile: make recover_sql cmd_usage.db)
#
# O que o script faz:
#   - Tenta extrair os dados estruturados usando o comando '.recover' do sqlite3.
#   - Corrige os metadados do dump SQL removendo a criação manual da tabela 'sqlite_sequence'.
#   - Reconstrói o banco e valida a integridade com 'PRAGMA integrity_check;'.
#   - Se o banco for o ativo de produção, ele gerencia a parada/inicialização
#     dos containers Docker automaticamente para liberar travas de arquivo.
#
# ==============================================================================

# exit on error
set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

DB_FILE="$1"

if [ -z "$DB_FILE" ]; then
    echo -e "${RED}Erro: Nenhum arquivo de banco de dados especificado.${NC}"
    echo -e "Uso: $0 <caminho_para_banco.db>"
    exit 1
fi

if [ ! -f "$DB_FILE" ]; then
    if [ -f "data/sqlites/$DB_FILE" ]; then
        DB_FILE="data/sqlites/$DB_FILE"
    else
        echo -e "${RED}Erro: Arquivo '$DB_FILE' não encontrado no diretório atual nem em 'data/sqlites/'.${NC}"
        exit 1
    fi
fi

DB_NAME=$(basename "$DB_FILE")
DIR_NAME=$(dirname "$DB_FILE")
TEMP_SQL="temp_recover_${DB_NAME}.sql"
TEMP_DB="temp_recovered_${DB_NAME}"

echo -e "${CYAN}Iniciando recuperação de $DB_FILE...${NC}"

# 1. Tentar recuperar usando sqlite3 .recover
echo -e "${CYAN}Passo 1: Extraindo dados estruturados do banco corrompido...${NC}"
if ! sqlite3 "$DB_FILE" ".recover" > "$TEMP_SQL"; then
    echo -e "${RED}Erro ao extrair dados usando '.recover'. O banco pode estar excessivamente danificado.${NC}"
    rm -f "$TEMP_SQL"
    exit 1
fi

# 2. Corrigir o SQL (remover CREATE TABLE sqlite_sequence se houver)
echo -e "${CYAN}Passo 2: Tratando metadados do dump SQL...${NC}"
sed -i '/CREATE TABLE sqlite_sequence/d' "$TEMP_SQL"

# 3. Importar para um banco temporário
echo -e "${CYAN}Passo 3: Criando banco de dados recuperado...${NC}"
rm -f "$TEMP_DB"
if ! sqlite3 "$TEMP_DB" < "$TEMP_SQL"; then
    echo -e "${RED}Erro ao importar o dump SQL no banco temporário.${NC}"
    rm -f "$TEMP_SQL" "$TEMP_DB"
    exit 1
fi

# 4. Verificar integridade do banco temporário
echo -e "${CYAN}Passo 4: Verificando integridade do banco recuperado...${NC}"
INTEGRITY=$(sqlite3 "$TEMP_DB" "PRAGMA integrity_check;")
if [ "$INTEGRITY" != "ok" ]; then
    echo -e "${RED}Falha na integridade do banco recuperado: $INTEGRITY${NC}"
    rm -f "$TEMP_SQL" "$TEMP_DB"
    exit 1
fi

echo -e "${GREEN}✅ Recuperação concluída com sucesso e integridade verificada!${NC}"
echo -e "Registros na tabela cmd_usage_log: $(sqlite3 "$TEMP_DB" "SELECT COUNT(*) FROM cmd_usage_log;" 2>/dev/null || echo "N/A")"
echo -e "Registros na tabela cmd_usage_fixed: $(sqlite3 "$TEMP_DB" "SELECT COUNT(*) FROM cmd_usage_fixed;" 2>/dev/null || echo "N/A")"

# Limpar SQL temporário
rm -f "$TEMP_SQL"

# 5. Implantação
# Verificar se é o banco ativo em data/sqlites/
IS_ACTIVE=false
TARGET_PATH="data/sqlites/$DB_NAME"

if [ "$DB_FILE" = "$TARGET_PATH" ] || [ "$(realpath "$DB_FILE")" = "$(realpath "$TARGET_PATH" 2>/dev/null)" ]; then
    IS_ACTIVE=true
fi

if [ "$IS_ACTIVE" = "true" ]; then
    echo -e "${YELLOW}Este é o banco de dados ativo do bot. Substituindo com segurança...${NC}"
    
    # Parar container se estiver rodando
    BOT_RUNNING=$(docker compose ps ravena-ai | grep -E 'Up|running' || true)
    if [ -n "$BOT_RUNNING" ]; then
        echo -e "${YELLOW}Parando container do bot (ravena-ai)...${NC}"
        docker compose stop ravena-ai
    fi
    
    # Substituir
    mv "$TEMP_DB" "$TARGET_PATH"
    
    # Remover arquivos de log/journal
    rm -f "${TARGET_PATH}-wal" "${TARGET_PATH}-shm" "${TARGET_PATH}-journal"
    
    echo -e "${GREEN}Banco de dados substituído com sucesso!${NC}"
    
    # Reiniciar bot
    if [ -n "$BOT_RUNNING" ]; then
        echo -e "${GREEN}Reiniciando o container do bot (ravena-ai)...${NC}"
        docker compose start ravena-ai
    fi
else
    # Se não for o banco ativo
    OUTPUT_FILE="recovered_$DB_NAME"
    mv "$TEMP_DB" "$OUTPUT_FILE"
    echo -e "${GREEN}Banco recuperado salvo em: $OUTPUT_FILE${NC}"
    echo -e "Para substituir o banco ativo, rode:"
    echo -e "  ${YELLOW}make stop-bot${NC} (ou docker compose stop ravena-ai)"
    echo -e "  ${YELLOW}cp $OUTPUT_FILE data/sqlites/$DB_NAME${NC}"
    echo -e "  ${YELLOW}rm -f data/sqlites/${DB_NAME}-wal data/sqlites/${DB_NAME}-shm data/sqlites/${DB_NAME}-journal${NC}"
    echo -e "  ${YELLOW}make start-bot${NC} (ou docker compose start ravena-ai)"
fi
