# Documentação de Bancos de Dados

Este projeto usa **SQLite** como banco principal, com backup remoto opcional em **MySQL/PostgreSQL**.
Todos os arquivos `.db` ficam em `data/sqlites/`.

---

## Arquitetura de Dados

```
src/utils/
├── Database.js           ← API pública (singleton). Ponto de entrada para TODA a aplicação.
├── DatabaseBackup.js     ← Backup local agendado + sincronização remota MySQL
└── db/
    ├── DatabaseMappers.js           ← Gerenciador de conexões better-sqlite3 (síncrono)
    ├── mappers/
    │   ├── GroupMapper.js           ← Serialização/deserialização de grupos
    │   ├── CommandMapper.js         ← Serialização de comandos customizados
    │   ├── DonationMapper.js        ← Serialização de doações
    │   ├── PendingJoinMapper.js     ← Serialização de convites pendentes
    │   ├── SoftBlockMapper.js       ← Serialização de bloqueios suaves
    │   └── LoadReportMapper.js      ← Serialização de relatórios de carga
    └── repositories/
        └── CoreRepository.js        ← Implementação das operações do core.db,
                                       custom_commands.db e load_reports.db
```

### Dois drivers coexistindo

| Camada | Driver | Uso |
|---|---|---|
| `getSQLiteDb()` | `sqlite3` (async/callback) | Todos os módulos de funções/jogos |
| `CoreRepository` | `better-sqlite3` (síncrono) | Tabelas core + comandos + relatórios |

A camada `Database.js` abstrai tudo — **o código chamador não precisa saber qual driver está por baixo**.

---

## Como implementar um novo banco de dados

### Padrão para módulos de funções (`src/functions/`)

```js
// No topo do arquivo, antes de exportar os comandos:
const Database = require('../utils/Database');
const database = Database.getInstance();

// Inicialização (chamada uma vez, cria o arquivo .db se não existir)
const db = database.getSQLiteDb('meu_modulo', `
  CREATE TABLE IF NOT EXISTS minha_tabela (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    valor       REAL DEFAULT 0,
    criado_em   INTEGER,
    dados_json  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_minha_tabela_user ON minha_tabela(user_id);
`);
// Resultado: cria data/sqlites/meu_modulo.db automaticamente

// Consultas (usar dbRun / dbGet / dbAll de Database.js)
await database.dbRun('meu_modulo', 'INSERT INTO minha_tabela ...', [params]);
const row = await database.dbGet('meu_modulo', 'SELECT * FROM minha_tabela WHERE id = ?', [id]);
const rows = await database.dbAll('meu_modulo', 'SELECT * FROM minha_tabela WHERE user_id = ?', [userId]);
```

### Banco sem backup (caches, dados temporários)

```js
// Passar noBackup = true como terceiro argumento
const db = database.getSQLiteDb('meu_cache', schema, true);
```

### Banco com colunas JSON complexas

Se uma coluna armazena um objeto JSON, crie um Mapper em `src/utils/db/mappers/`:

```js
// src/utils/db/mappers/MeuMapper.js
const MeuMapper = {
  fromRow(row) {
    // row → objeto JS que o resto do código espera
    return {
      id: row.id,
      dados: row.dados_json ? JSON.parse(row.dados_json) : {}
    };
  },
  toRow(obj) {
    // objeto JS → colunas para INSERT/UPDATE
    return {
      id: obj.id,
      dados_json: JSON.stringify(obj.dados)
    };
  }
};
module.exports = MeuMapper;
```

---

## Referência da API pública (`Database.js`)

### Bancos genéricos (módulos/jogos)

```js
database.getSQLiteDb(name, schema, noBackup?)  // Abre/cria banco, retorna conexão sqlite3
database.dbRun(name, sql, params?)             // INSERT / UPDATE / DELETE (assíncrono)
database.dbGet(name, sql, params?)             // Retorna uma linha
database.dbAll(name, sql, params?)             // Retorna todas as linhas
```

### Banco core (grupos, doações, convites)

```js
// Grupos
database.getGroups()
database.getGroup(groupId)
database.getGroupByName(name)
database.saveGroup(groupObj)

// Comandos customizados
database.getCustomCommands(groupId)
database.saveCustomCommand(groupId, commandObj)
database.deleteCustomCommand(groupId, trigger)

// Doações
database.getDonations()
database.addDonation(name, amount, numero?)
database.updateDonationAmount(name, delta)
database.mergeDonors(targetName, sourceName)

// Convites pendentes
database.getPendingJoins()
database.savePendingJoin(code, data)
database.removePendingJoin(code)

// Bloqueios suaves
database.getSoftblocks()
database.toggleUserInvites(number, block)
database.isUserInviteBlocked(number)

// Relatórios de carga
database.getLoadReports(since?)
database.addLoadReport(reportObj)
```

---

## DATABASE_TABLES.md

> **Para LLMs:** Sempre que criar ou modificar tabelas, atualize `DATABASE_TABLES.md` com a descrição
> da tabela, colunas principais e propósito. Use o formato existente naquele arquivo.

---

## Backup

- **Local**: cópias agendadas em `data/backups/` (0h, 6h, 12h, 18h por padrão)
- **Remoto**: sincronização MySQL via `SQLITE_REMOTE_SERVERS` no `.env` (inicia **5 minutos** após o bot subir)
- **Restauração**: em caso de corrupção (`SQLITE_CORRUPT`), o `DatabaseBackup` restaura automaticamente do backup mais recente

Para resetar o banco remoto após migrações de schema:
```bash
node src/utils/db/migrations/reset_remote_backup.js
```