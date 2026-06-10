#!/bin/bash

# Script para atualizar o ranking de doadores no CONTRIBUTING.md

# Configurações
DB_PATH="data/sqlites/core.db"
CONTRIB_PATH="CONTRIBUTING.md"
TEMP_FILE="donors_table.tmp"

# Verifica se o banco existe
if [ ! -f "$DB_PATH" ]; then
    echo "Erro: Banco de dados não encontrado em $DB_PATH"
    exit 1
fi

# Gera a tabela de doadores em Markdown
echo "| Rank | Doador | Valor |" > "$TEMP_FILE"
echo "|------|--------|-------|" >> "$TEMP_FILE"

# Query SQLite para pegar doadores com valor >= 5
# Usamos .mode list e um separador simples para evitar aspas automáticas do modo CSV
sqlite3 "$DB_PATH" <<EOF >> "$TEMP_FILE"
.mode list
.separator " | "
SELECT 
    (SELECT COUNT(*) FROM donations d2 WHERE d2.valor > d1.valor) + 1 as rank,
    name, 
    'R$' || printf("%.2f", valor)
FROM donations d1
WHERE valor >= 5
ORDER BY valor DESC;
EOF

# Formata as linhas do SQLite para o padrão Markdown (adicionando pipes nas extremidades)
# Começamos da linha 3 para ignorar o cabeçalho manual que já tem pipes
sed -i '3,$s/^/| /; 3,$s/$/ |/' "$TEMP_FILE"

# Limpeza: remove aspas duplas que o SQLite pode ter inserido em nomes com caracteres especiais
sed -i 's/"//g' "$TEMP_FILE"

# Remove o arquivo temporário se algo der errado na query
if [ ! -s "$TEMP_FILE" ]; then
    echo "Erro ao gerar lista de doadores."
    rm "$TEMP_FILE"
    exit 1
fi

# Substitui o bloco entre os marcadores no CONTRIBUTING.md
sed -i '/<!-- DONORS_LIST_START -->/,/<!-- DONORS_LIST_END -->/{//!d}' "$CONTRIB_PATH"
sed -i '/<!-- DONORS_LIST_START -->/r '"$TEMP_FILE" "$CONTRIB_PATH"

# Limpeza
rm "$TEMP_FILE"

echo "Ranking de doadores atualizado com sucesso no CONTRIBUTING.md!"
