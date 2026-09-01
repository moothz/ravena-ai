#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

// Localiza o diretório de dados
const dataDir = path.join(__dirname, "data", "sqlites");
const coreDbPath = path.join(dataDir, "core.db");
const customCmdDbPath = path.join(dataDir, "custom_commands.db");
const copaDbPath = path.join(dataDir, "copa_seguir.db");
const skipGroupsDbPath = path.join(dataDir, "skip_groups.db");

// Tenta importar better-sqlite3
let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	console.error("❌ Erro ao carregar better-sqlite3:", e.message);
	console.error("Execute este script dentro do container Docker ou rode 'make migrate-group'.");
	process.exit(1);
}

// Tratamento de argumentos
const rawArgs = process.argv.slice(2);
let oldArg = null;
let newArg = null;
let autoYes = false;

for (const arg of rawArgs) {
	if (arg === "-y" || arg === "--yes" || arg === "-f" || arg === "--force") {
		autoYes = true;
	} else if (!oldArg) {
		oldArg = arg.trim();
	} else if (!newArg) {
		newArg = arg.trim();
	}
}

if (!oldArg || !newArg) {
	console.log(`
Uso:
  make migrate-group <oldId|oldName> <newId|newName>
  node migrate-group.js <oldId|oldName> <newId|newName> [-y]

Exemplo:
  make migrate-group 120363424022939146@g.us 120363427984421447@g.us
`);
	process.exit(1);
}

if (!fs.existsSync(coreDbPath)) {
	console.error(`❌ Banco de dados core.db não encontrado em: ${coreDbPath}`);
	process.exit(1);
}

const coreDb = new Database(coreDbPath);

function findGroup(identifier) {
	const stmt = coreDb.prepare(`
		SELECT * FROM groups
		WHERE id = ? OR LOWER(name) = LOWER(?)
	`);
	return stmt.get(identifier, identifier);
}

const oldGroupRow = findGroup(oldArg);
const newGroupRow = findGroup(newArg);

if (!oldGroupRow) {
	console.error(`❌ Grupo de origem '${oldArg}' não foi encontrado no banco de dados.`);
	coreDb.close();
	process.exit(1);
}

if (!newGroupRow) {
	console.error(`❌ Grupo de destino '${newArg}' não foi encontrado no banco de dados.`);
	coreDb.close();
	process.exit(1);
}

if (oldGroupRow.id === newGroupRow.id) {
	console.error(`❌ O grupo de origem e o de destino são o mesmo (${oldGroupRow.id}).`);
	coreDb.close();
	process.exit(1);
}

const parseJson = (val, fallback) => {
	if (!val) return fallback;
	try {
		return JSON.parse(val);
	} catch {
		return fallback;
	}
};

const oldName = oldGroupRow.name || "sem_nome";
const oldTitle = oldGroupRow.titulo || "sem_titulo";
const newNameCurrent = newGroupRow.name || "sem_nome";
const newTitle = newGroupRow.titulo || "sem_titulo";

const targetOldName = oldName.endsWith("_antigo") ? oldName : `${oldName}_antigo`;
const targetNewName = oldName.endsWith("_antigo") ? oldName.replace(/_antigo$/, "") : oldName;

console.log("\n=======================================================");
console.log("            MIGRAÇÃO DE CONFIGURAÇÕES DE GRUPO         ");
console.log("=======================================================");
console.log(`📌 ORIGEM:`);
console.log(`   - ID:        ${oldGroupRow.id}`);
console.log(`   - Nome:      ${oldName} ➜ será alterado para: ${targetOldName}`);
console.log(`   - Título:    ${oldTitle}`);
console.log(`   - Prefixo:   ${oldGroupRow.prefix || "!"}`);
console.log(
	`   - AI Prompt: ${oldGroupRow.custom_ai_prompt ? "Configurado (" + oldGroupRow.custom_ai_prompt.length + " chars)" : "Nenhum"}`
);
console.log(`   - Despedida: ${oldGroupRow.farewells ? "Configurada" : "Nenhuma"}`);
console.log(`   - Boas-Vindas: ${oldGroupRow.greetings ? "Configurada" : "Nenhuma"}`);
console.log(`   - Interação: ${oldGroupRow.interact || "Padrão"}`);
console.log(`   - Filtros:   ${oldGroupRow.filters || "Padrão"}`);
console.log(`\n📌 DESTINO:`);
console.log(`   - ID:        ${newGroupRow.id}`);
console.log(`   - Nome:      ${newNameCurrent} ➜ será alterado para: ${targetNewName}`);
console.log(`   - Título:    ${newTitle}`);
console.log(
	`   - Prefixo:   ${newGroupRow.prefix || "!"} ➜ será atualizado para: ${oldGroupRow.prefix || "!"}`
);
console.log("=======================================================\n");

function askConfirmation(question) {
	return new Promise((resolve) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout
		});
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

async function run() {
	if (!autoYes) {
		const promptText = `Deseja copiar de ${oldGroupRow.id} (${oldName}) para ${newGroupRow.id} (${newNameCurrent})? (s/N): `;
		const response = await askConfirmation(promptText);
		const normalized = response.toLowerCase();
		if (normalized !== "s" && normalized !== "sim" && normalized !== "y" && normalized !== "yes") {
			console.log("\n❌ Operação cancelada pelo usuário.\n");
			coreDb.close();
			process.exit(0);
		}
	}

	console.log("\n⏳ Aplicando alterações...");

	// 1. Atualizar groups no core.db dentro de uma transação
	const updateOldGroupStmt = coreDb.prepare(`
		UPDATE groups
		SET name = @name,
		    updated_at = @updated_at,
		    json_data = @json_data
		WHERE id = @id
	`);

	const updateNewGroupStmt = coreDb.prepare(`
		UPDATE groups
		SET name = @name,
		    prefix = @prefix,
		    custom_ignores_prefix = @custom_ignores_prefix,
		    paused = @paused,
		    additional_admins = @additional_admins,
		    filters = @filters,
		    twitch = @twitch,
		    kick = @kick,
		    youtube = @youtube,
		    bot_not_in_group = @bot_not_in_group,
		    webhooks = @webhooks,
		    greetings = @greetings,
		    farewells = @farewells,
		    interact = @interact,
		    auto_translate_to = @auto_translate_to,
		    auto_stt = @auto_stt,
		    ignored_numbers = @ignored_numbers,
		    ignored_users = @ignored_users,
		    muted_commands = @muted_commands,
		    muted_categories = @muted_categories,
		    nicks = @nicks,
		    warnings = @warnings,
		    custom_ai_prompt = @custom_ai_prompt,
		    notifica_grupo_fechado = @notifica_grupo_fechado,
		    notifica_grupo_aberto = @notifica_grupo_aberto,
		    updated_at = @updated_at,
		    json_data = @json_data
		WHERE id = @id
	`);

	const now = Date.now();

	// Prepara json_data do grupo antigo renomeado
	const oldJsonObj = parseJson(oldGroupRow.json_data, {});
	oldJsonObj.name = targetOldName;
	oldJsonObj.updatedAt = now;

	// Prepara json_data do novo grupo com as configs copiadas
	const newJsonObj = parseJson(newGroupRow.json_data, {});
	const copiedJsonObj = {
		...newJsonObj,
		id: newGroupRow.id,
		name: targetNewName,
		titulo: newGroupRow.titulo || oldGroupRow.titulo,
		descricao: newGroupRow.descricao || oldGroupRow.descricao,
		addedBy: newGroupRow.added_by || oldGroupRow.added_by,
		removedBy: newGroupRow.removed_by,
		prefix: oldGroupRow.prefix ?? "!",
		customIgnoresPrefix: !!oldGroupRow.custom_ignores_prefix,
		inviteCode: newGroupRow.invite_code || oldGroupRow.invite_code,
		paused: !!oldGroupRow.paused,
		additionalAdmins: parseJson(oldGroupRow.additional_admins, []),
		filters: parseJson(oldGroupRow.filters, { nsfw: false, links: false, words: [], people: [] }),
		twitch: parseJson(oldGroupRow.twitch, []),
		kick: parseJson(oldGroupRow.kick, []),
		youtube: parseJson(oldGroupRow.youtube, []),
		botNotInGroup: parseJson(oldGroupRow.bot_not_in_group, []),
		webhooks: parseJson(oldGroupRow.webhooks, []),
		greetings: parseJson(oldGroupRow.greetings, {}),
		farewells: parseJson(oldGroupRow.farewells, {}),
		interact: parseJson(oldGroupRow.interact, {
			enabled: true,
			useCmds: true,
			lastInteraction: 0,
			cooldown: 30,
			chance: 100,
			proporcao: 50
		}),
		autoTranslateTo: oldGroupRow.auto_translate_to || false,
		autoStt: !!oldGroupRow.auto_stt,
		ignoredNumbers: parseJson(oldGroupRow.ignored_numbers, []),
		ignoredUsers: parseJson(oldGroupRow.ignored_users, []),
		mutedCommands: parseJson(oldGroupRow.muted_commands, []),
		mutedCategories: parseJson(oldGroupRow.muted_categories, []),
		nicks: parseJson(oldGroupRow.nicks, []),
		warnings: parseJson(oldGroupRow.warnings, []),
		customAIPrompt: parseJson(oldGroupRow.custom_ai_prompt, oldGroupRow.custom_ai_prompt),
		notificaGrupoFechado: !!oldGroupRow.notifica_grupo_fechado,
		notificaGrupoAberto: !!oldGroupRow.notifica_grupo_aberto,
		createdAt: newGroupRow.created_at || now,
		updatedAt: now
	};

	const transaction = coreDb.transaction(() => {
		// 1. Atualiza grupo antigo
		updateOldGroupStmt.run({
			id: oldGroupRow.id,
			name: targetOldName,
			updated_at: now,
			json_data: JSON.stringify(oldJsonObj)
		});

		// 2. Atualiza grupo novo
		updateNewGroupStmt.run({
			id: newGroupRow.id,
			name: targetNewName,
			prefix: oldGroupRow.prefix ?? "!",
			custom_ignores_prefix: oldGroupRow.custom_ignores_prefix ? 1 : 0,
			paused: oldGroupRow.paused ? 1 : 0,
			additional_admins: oldGroupRow.additional_admins || "[]",
			filters: oldGroupRow.filters || "{}",
			twitch: oldGroupRow.twitch || "[]",
			kick: oldGroupRow.kick || "[]",
			youtube: oldGroupRow.youtube || "[]",
			bot_not_in_group: oldGroupRow.bot_not_in_group || "[]",
			webhooks: oldGroupRow.webhooks || "[]",
			greetings: oldGroupRow.greetings || "{}",
			farewells: oldGroupRow.farewells || "{}",
			interact: oldGroupRow.interact || "{}",
			auto_translate_to: oldGroupRow.auto_translate_to || null,
			auto_stt: oldGroupRow.auto_stt ? 1 : 0,
			ignored_numbers: oldGroupRow.ignored_numbers || "[]",
			ignored_users: oldGroupRow.ignored_users || "[]",
			muted_commands: oldGroupRow.muted_commands || "[]",
			muted_categories: oldGroupRow.muted_categories || "[]",
			nicks: oldGroupRow.nicks || "[]",
			warnings: oldGroupRow.warnings || "[]",
			custom_ai_prompt: oldGroupRow.custom_ai_prompt || null,
			notifica_grupo_fechado: oldGroupRow.notifica_grupo_fechado ? 1 : 0,
			notifica_grupo_aberto: oldGroupRow.notifica_grupo_aberto ? 1 : 0,
			updated_at: now,
			json_data: JSON.stringify(copiedJsonObj)
		});
	});

	transaction();
	coreDb.close();
	console.log(`✅ core.db atualizado com sucesso:`);
	console.log(`   - Grupo Antigo (${oldGroupRow.id}): renomeado para '${targetOldName}'`);
	console.log(
		`   - Grupo Novo   (${newGroupRow.id}): renomeado para '${targetNewName}' e configs aplicadas`
	);

	// 2. Copiar comandos customizados em custom_commands.db
	if (fs.existsSync(customCmdDbPath)) {
		try {
			const cmdDb = new Database(customCmdDbPath);
			const cmds = cmdDb
				.prepare("SELECT * FROM custom_commands WHERE group_id = ?")
				.all(oldGroupRow.id);
			if (cmds && cmds.length > 0) {
				const insertCmdStmt = cmdDb.prepare(`
					INSERT INTO custom_commands
						(group_id, trigger, responses, admin_only, active, deleted, count, last_used, created_by, created_at, metadata, json_data)
					VALUES
						(@group_id, @trigger, @responses, @admin_only, @active, @deleted, @count, @last_used, @created_by, @created_at, @metadata, @json_data)
					ON CONFLICT(group_id, trigger) DO UPDATE SET
						responses  = excluded.responses,
						admin_only = excluded.admin_only,
						active     = excluded.active,
						deleted    = excluded.deleted,
						count      = excluded.count,
						last_used  = excluded.last_used,
						metadata   = excluded.metadata,
						json_data  = excluded.json_data
				`);

				const cmdTx = cmdDb.transaction(() => {
					for (const cmd of cmds) {
						insertCmdStmt.run({
							...cmd,
							group_id: newGroupRow.id
						});
					}
				});
				cmdTx();
				console.log(`✅ custom_commands.db: ${cmds.length} comandos customizados copiados.`);
			} else {
				console.log(`ℹ️  custom_commands.db: Nenhum comando customizado para copiar.`);
			}
			cmdDb.close();
		} catch (e) {
			console.warn(`⚠️  Aviso ao copiar custom_commands: ${e.message}`);
		}
	}

	// 3. Copiar times seguidos da copa em copa_seguir.db
	if (fs.existsSync(copaDbPath)) {
		try {
			const copaDb = new Database(copaDbPath);
			const teams = copaDb
				.prepare("SELECT * FROM copa_seguindo WHERE chat_id = ?")
				.all(oldGroupRow.id);
			if (teams && teams.length > 0) {
				const insertTeamStmt = copaDb.prepare(`
					INSERT OR IGNORE INTO copa_seguindo (chat_id, team_id, team_name_en, team_name_pt, fifa_code, created_at)
					VALUES (@chat_id, @team_id, @team_name_en, @team_name_pt, @fifa_code, @created_at)
				`);
				const copaTx = copaDb.transaction(() => {
					for (const team of teams) {
						insertTeamStmt.run({
							...team,
							chat_id: newGroupRow.id
						});
					}
				});
				copaTx();
				console.log(`✅ copa_seguir.db: ${teams.length} times seguidos copiados.`);
			}
			copaDb.close();
		} catch (e) {
			console.warn(`⚠️  Aviso ao copiar copa_seguindo: ${e.message}`);
		}
	}

	// 4. Copiar skip_groups em skip_groups.db
	if (fs.existsSync(skipGroupsDbPath)) {
		try {
			const skipDb = new Database(skipGroupsDbPath);
			const skips = skipDb
				.prepare("SELECT * FROM skipped_groups WHERE group_id = ?")
				.all(oldGroupRow.id);
			if (skips && skips.length > 0) {
				const insertSkipStmt = skipDb.prepare(`
					INSERT OR IGNORE INTO skipped_groups (bot_id, group_id)
					VALUES (@bot_id, @group_id)
				`);
				const skipTx = skipDb.transaction(() => {
					for (const sk of skips) {
						insertSkipStmt.run({
							bot_id: sk.bot_id,
							group_id: newGroupRow.id
						});
					}
				});
				skipTx();
				console.log(`✅ skip_groups.db: ${skips.length} registros de skip copiados.`);
			}
			skipDb.close();
		} catch (e) {
			console.warn(`⚠️  Aviso ao copiar skip_groups: ${e.message}`);
		}
	}

	console.log("\n🎉 Migração concluída com sucesso!");
	console.log(
		"💡 Se o bot estiver rodando, execute 'make restart-bot' para recarregar o cache em memória se necessário.\n"
	);
}

run().catch((err) => {
	console.error("❌ Erro fatal durante a migração:", err);
	process.exit(1);
});
