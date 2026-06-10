#!/bin/bash

# sync-to-docker.sh
# Script para sincronizar arquivos modificados/não rastreados com o container Docker ravena-ai.
# Este script lista arquivos alterados (git status), permite a seleção via interface CLI (whiptail)
# e copia os arquivos selecionados para dentro do container em execução, facilitando o desenvolvimento.

# Cores para saída
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m' # Sem cor

# Verifica se o container está em execução
CONTAINER_ID=$(docker compose ps -q ravena-ai 2>/dev/null)

if [ -z "$CONTAINER_ID" ]; then
    echo -e "${RED}Erro: o container ravena-ai não está em execução.${NC}"
    echo "Certifique-se de que iniciou os serviços com 'make up'."
    exit 1
fi

# Verifica se o whiptail está instalado
if ! command -v whiptail &> /dev/null; then
    echo -e "${RED}Erro: whiptail não está instalado.${NC}"
    echo "Por favor, instale o pacote 'newt' ou 'whiptail'."
    exit 1
fi

# Obtém arquivos do git status (modificados, adicionados, não rastreados e ignorados)
# Redireciona stderr para /dev/null para ignorar avisos de permissão negada
files_raw=$(git -c core.quotepath=false status --porcelain --ignored 2>/dev/null)

if [ -z "$files_raw" ]; then
    echo -e "${YELLOW}Nenhum arquivo modificado, não rastreado ou ignorado encontrado para sincronizar.${NC}"
    exit 0
fi

# Arquivo temporário para armazenar metadados para ordenação
TEMP_DATA=$(mktemp)
trap 'rm -f "$TEMP_DATA"' EXIT

while IFS= read -r line; do
    [ -z "$line" ] && continue
    
    # Porcelain v1: Status nos primeiros 2 caracteres, depois espaço, depois o arquivo
    status_code="${line:0:2}"
    file_path="${line:3}"
    
    # Pula arquivos deletados
    if [[ "$status_code" == *"D"* ]]; then
        continue
    fi

    # Trata renomeações (old -> new)
    if [[ "$status_code" == "R"* ]]; then
        file_path=$(echo "$file_path" | sed 's/.* -> //')
    fi

    # Verifica se o arquivo existe localmente
    if [ -e "$file_path" ]; then
        # Obtém metadados
        mtime=$(stat -c %Y "$file_path")
        size_bytes=$(stat -c %s "$file_path")
        size_human=$(numfmt --to=iec --suffix=B "$size_bytes")
        mdate=$(stat -c %y "$file_path" | cut -d'.' -f1 | cut -d' ' -f1,2)
        
        # Formato: timestamp | status | tamanho | data | caminho
        echo "$mtime|$status_code|$size_human|$mdate|$file_path" >> "$TEMP_DATA"
    fi
done <<< "$files_raw"

if [ ! -s "$TEMP_DATA" ]; then
    echo -e "${YELLOW}Nenhum arquivo existente encontrado para sincronizar.${NC}"
    exit 0
fi

# Ordena por timestamp (primeiro campo) decrescente (mais recentes primeiro)
args=()
while IFS='|' read -r mtime status size mdate file; do
    # Estado padrão: ON para modificados/não rastreados, OFF para ignorados ou .gitignore
    state="ON"
    
    if [[ "$status" == "!!" ]]; then
        state="OFF"
    fi
    
    if [[ "$file" == *".gitignore" ]]; then
        state="OFF"
    fi
    
    # Formata a string de exibição com colunas
    clean_status=$(echo "$status" | xargs)
    item_display=$(printf "[%-2s] %-8s %-16s %s" "$clean_status" "$size" "$mdate" "$file")
    
    args+=("$file" "$item_display" "$state")
done <<< "$(sort -t'|' -k1,1rn "$TEMP_DATA")"

# Mostra o checklist do whiptail
SELECTED_FILES=$(whiptail --title "Sincronizar com Docker (ravena-ai)" \
    --separate-output \
    --ok-button "Sincronizar" \
    --cancel-button "Cancelar" \
    --checklist "Selecione os arquivos para copiar para /app/:\n\n$(printf "%-6s %-8s %-16s %s" "Status" "Tam" "Data Modif." "Caminho do Arquivo")" 24 120 14 \
    "${args[@]}" 3>&1 1>&2 2>&3)

# Verifica se o usuário cancelou
if [ $? -ne 0 ]; then
    echo -e "${YELLOW}Sincronização cancelada pelo usuário.${NC}"
    exit 0
fi

if [ -z "$SELECTED_FILES" ]; then
    echo -e "${YELLOW}Nenhum arquivo selecionado para sincronização.${NC}"
    exit 0
fi

# Sincroniza arquivos selecionados
echo -e "${GREEN}Iniciando sincronização...${NC}"
count=0
while read -r file; do
    if [ -n "$file" ]; then
        echo -e "  Copiando ${YELLOW}$file${NC}..."
        docker cp "$file" "$CONTAINER_ID:/app/$file"
        if [ $? -eq 0 ]; then
            ((count++))
        else
            echo -e "  ${RED}Falha ao copiar $file${NC}"
        fi
    fi
done <<< "$SELECTED_FILES"

echo -e "${GREEN}✅ $count itens sincronizados com sucesso no ravena-ai.${NC}"
