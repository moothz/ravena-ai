/**
 * CoreRepository.js
 *
 * Implements all core.db operations using the synchronous DatabaseMappers
 * (better-sqlite3). Each method preserves the exact same return type and
 * behaviour as the corresponding method in Database.js so no callers change.
 *
 * Database.js delegates to this class; it does not call it directly anywhere else.
 */

"use strict";

const Logger = require("../../Logger");
const GroupMapper = require("../mappers/GroupMapper");
const CommandMapper = require("../mappers/CommandMapper");
const DonationMapper = require("../mappers/DonationMapper");
const PendingJoinMapper = require("../mappers/PendingJoinMapper");
const SoftBlockMapper = require("../mappers/SoftBlockMapper");
const LoadReportMapper = require("../mappers/LoadReportMapper");

class CoreRepository {
	/**
	 * @param {import('../DatabaseMappers')} mappers - DatabaseMappers instance
	 */
	constructor(mappers) {
		this.mappers = mappers;
		this.logger = new Logger("core-repository");

		/** core.db — groups, donations, pending_joins, soft_blocks, blocked_invites */
		this.DB = "core";
		/** custom_commands.db — dedicated file for group commands */
		this.CMD_DB = "custom_commands";
		/** load_reports.db — dedicated file for bot load reports */
		this.REPORTS_DB = "load_reports";

		this._initSchemas();
	}

	/** Ensure schema exists on first open for all databases */
	_initSchemas() {
		// core.db — groups, donations, pending_joins, soft_blocks, blocked_invites
		const coreTables = {
			groups: `CREATE TABLE IF NOT EXISTS groups (
				id TEXT PRIMARY KEY,
				name TEXT,
				titulo TEXT,
				descricao TEXT,
				added_by TEXT,
				removed_by TEXT,
				prefix TEXT,
				custom_ignores_prefix INTEGER,
				invite_code TEXT,
				paused INTEGER,
				additional_admins TEXT,
				filters TEXT,
				twitch TEXT,
				kick TEXT,
				youtube TEXT,
				bot_not_in_group TEXT,
				webhooks TEXT,
				greetings TEXT,
				farewells TEXT,
				interact TEXT,
				auto_translate_to TEXT,
				auto_stt INTEGER,
				ignored_numbers TEXT,
				ignored_users TEXT,
				muted_commands TEXT,
				muted_categories TEXT,
				nicks TEXT,
				warnings TEXT,
				custom_ai_prompt TEXT,
				notifica_grupo_fechado INTEGER DEFAULT 0,
				notifica_grupo_aberto INTEGER DEFAULT 0,
				created_at INTEGER,
				updated_at INTEGER,
				json_data TEXT
			)`,
			donations: `CREATE TABLE IF NOT EXISTS donations (
				name TEXT PRIMARY KEY,
				valor REAL,
				numero TEXT,
				timestamp INTEGER,
				historico TEXT,
				json_data TEXT
			)`,
			pending_joins: `CREATE TABLE IF NOT EXISTS pending_joins (
				code TEXT PRIMARY KEY,
				author_id TEXT,
				author_name TEXT,
				timestamp INTEGER,
				json_data TEXT
			)`,
			soft_blocks: `CREATE TABLE IF NOT EXISTS soft_blocks (
				number TEXT PRIMARY KEY,
				block_invites INTEGER,
				json_data TEXT
			)`,
			blocked_invites: `CREATE TABLE IF NOT EXISTS blocked_invites (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				code TEXT,
				jid TEXT,
				timestamp INTEGER,
				json_data TEXT
			)`,
			local_blocks: `CREATE TABLE IF NOT EXISTS local_blocks (
				number TEXT PRIMARY KEY,
				timestamp INTEGER
			)`,
			invite_history: `CREATE TABLE IF NOT EXISTS invite_history (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				invite_code TEXT,
				group_jid TEXT,
				author_id TEXT,
				author_name TEXT,
				timestamp INTEGER,
				reason TEXT,
				json_data TEXT
			)`,
			group_membership_periods: `CREATE TABLE IF NOT EXISTS group_membership_periods (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				group_jid TEXT,
				group_name TEXT,
				join_timestamp INTEGER,
				leave_timestamp INTEGER,
				duration INTEGER,
				join_responsible TEXT,
				leave_responsible TEXT,
				json_data TEXT
			)`
		};

		for (const [tableName, createSql] of Object.entries(coreTables)) {
			this.mappers.exec(this.DB, createSql);
			this._ensureTableSchema(this.DB, tableName, createSql);
		}

		// Create indexes for performance
		this.mappers.exec(
			this.DB,
			"CREATE INDEX IF NOT EXISTS idx_invite_history_author ON invite_history(author_id)"
		);
		this.mappers.exec(
			this.DB,
			"CREATE INDEX IF NOT EXISTS idx_invite_history_code ON invite_history(invite_code)"
		);
		this.mappers.exec(
			this.DB,
			"CREATE INDEX IF NOT EXISTS idx_invite_history_jid ON invite_history(group_jid)"
		);
		this.mappers.exec(
			this.DB,
			"CREATE INDEX IF NOT EXISTS idx_group_periods_jid ON group_membership_periods(group_jid)"
		);

		// custom_commands.db
		this.mappers.exec(
			this.CMD_DB,
			`CREATE TABLE IF NOT EXISTS custom_commands (
				group_id    TEXT,
				trigger     TEXT,
				responses   TEXT,
				admin_only  INTEGER DEFAULT 0,
				active      INTEGER DEFAULT 1,
				deleted     INTEGER DEFAULT 0,
				count       INTEGER DEFAULT 0,
				last_used   INTEGER,
				created_by  TEXT,
				created_at  INTEGER,
				metadata    TEXT,
				json_data   TEXT,
				PRIMARY KEY (group_id, trigger)
			)`
		);
		this._ensureTableSchema(
			this.CMD_DB,
			"custom_commands",
			`(group_id TEXT, trigger TEXT, responses TEXT, admin_only INTEGER, active INTEGER, deleted INTEGER, count INTEGER, last_used INTEGER, created_by TEXT, created_at INTEGER, metadata TEXT, json_data TEXT)`
		);

		// load_reports.db
		this.mappers.exec(
			this.REPORTS_DB,
			`CREATE TABLE IF NOT EXISTS load_reports (
				id              INTEGER PRIMARY KEY AUTOINCREMENT,
				bot_id          TEXT,
				timestamp_start INTEGER,
				timestamp_end   INTEGER,
				duration        REAL,
				recv_private    INTEGER DEFAULT 0,
				recv_group      INTEGER DEFAULT 0,
				sent_private    INTEGER DEFAULT 0,
				sent_group      INTEGER DEFAULT 0,
				msgs_per_hour   REAL,
				resp_avg        REAL,
				resp_max        REAL,
				resp_count      INTEGER,
				json_data       TEXT
			)`
		);
		this._ensureTableSchema(
			this.REPORTS_DB,
			"load_reports",
			`(id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, timestamp_start INTEGER, timestamp_end INTEGER, duration REAL, recv_private INTEGER, recv_group INTEGER, sent_private INTEGER, sent_group INTEGER, msgs_per_hour REAL, resp_avg REAL, resp_max REAL, resp_count INTEGER, json_data TEXT)`
		);
	}

	/**
	 * Detect and add missing columns to an existing table (synchronous)
	 */
	_ensureTableSchema(dbName, tableName, schemaSql) {
		const columnMatches = schemaSql.match(/\(([\s\S]*)\)/);
		if (!columnMatches) return;

		const columns = columnMatches[1]
			.split(",")
			.map((c) => c.trim().split(/\s+/)[0])
			.filter(
				(c) =>
					c &&
					!["PRIMARY", "FOREIGN", "CHECK", "UNIQUE", "CONSTRAINT"].includes(c.toUpperCase()) &&
					!c.startsWith("(")
			);

		try {
			const rows = this.mappers.all(dbName, `PRAGMA table_info(${tableName})`);
			const existingColumns = rows.map((r) => r.name);
			const missingColumns = columns.filter((c) => !existingColumns.includes(c));

			if (missingColumns.length > 0) {
				this.logger.info(
					`Adding missing columns to ${tableName} in ${dbName}: ${missingColumns.join(", ")}`
				);
				for (const col of missingColumns) {
					// Extract full column definition
					const colDefMatch = schemaSql.match(new RegExp(`${col}\\s+([^,)]+)`, "i"));
					const colDef = colDefMatch ? colDefMatch[1] : "TEXT";
					try {
						this.mappers.exec(dbName, `ALTER TABLE ${tableName} ADD COLUMN ${col} ${colDef}`);
					} catch (e) {
						this.logger.error(`Error adding column ${col} to ${tableName} in ${dbName}:`, e);
					}
				}
			}
		} catch (error) {
			this.logger.error(`Error in _ensureTableSchema for ${tableName} in ${dbName}:`, error);
		}
	}

	// ===========================================================================
	// Groups
	// ===========================================================================

	async getGroups() {
		try {
			const rows = this.mappers.all(this.DB, "SELECT * FROM groups");
			return rows.map(GroupMapper.fromRow);
		} catch (error) {
			this.logger.error("Error in getGroups:", error);
			return [];
		}
	}

	async getGroup(groupId) {
		try {
			const row = this.mappers.get(this.DB, "SELECT * FROM groups WHERE id = ?", [groupId]);
			return row ? GroupMapper.fromRow(row) : null;
		} catch (error) {
			this.logger.error("Error in getGroup:", error);
			return null;
		}
	}

	async getGroupByName(groupName) {
		try {
			const row = this.mappers.get(this.DB, "SELECT * FROM groups WHERE name = ?", [groupName]);
			return row ? GroupMapper.fromRow(row) : null;
		} catch (error) {
			this.logger.error("Error in getGroupByName:", error);
			return null;
		}
	}

	async saveGroup(group) {
		try {
			const row = GroupMapper.toRow(group);
			// Keep json_data in sync as safety net until Phase 4
			const jsonData = JSON.stringify(group);

			this.mappers.run(
				this.DB,
				`INSERT INTO groups (
          id, name, titulo, descricao, added_by, removed_by, prefix,
          custom_ignores_prefix, invite_code, paused, additional_admins,
          filters, twitch, kick, youtube, bot_not_in_group, webhooks,
          greetings, farewells, interact, auto_translate_to, auto_stt,
          ignored_numbers, ignored_users, muted_commands, muted_categories,
          nicks, warnings, custom_ai_prompt, notifica_grupo_fechado, notifica_grupo_aberto, created_at, updated_at, json_data
        ) VALUES (
          @id, @name, @titulo, @descricao, @added_by, @removed_by, @prefix,
          @custom_ignores_prefix, @invite_code, @paused, @additional_admins,
          @filters, @twitch, @kick, @youtube, @bot_not_in_group, @webhooks,
          @greetings, @farewells, @interact, @auto_translate_to, @auto_stt,
          @ignored_numbers, @ignored_users, @muted_commands, @muted_categories,
          @nicks, @warnings, @custom_ai_prompt, @notifica_grupo_fechado, @notifica_grupo_aberto, @created_at, @updated_at, @json_data
        )
        ON CONFLICT(id) DO UPDATE SET
          name                  = excluded.name,
          titulo                = excluded.titulo,
          descricao             = excluded.descricao,
          added_by              = excluded.added_by,
          removed_by            = excluded.removed_by,
          prefix                = excluded.prefix,
          custom_ignores_prefix = excluded.custom_ignores_prefix,
          invite_code           = excluded.invite_code,
          paused                = excluded.paused,
          additional_admins     = excluded.additional_admins,
          filters               = excluded.filters,
          twitch                = excluded.twitch,
          kick                  = excluded.kick,
          youtube               = excluded.youtube,
          bot_not_in_group      = excluded.bot_not_in_group,
          webhooks              = excluded.webhooks,
          greetings             = excluded.greetings,
          farewells             = excluded.farewells,
          interact              = excluded.interact,
          auto_translate_to     = excluded.auto_translate_to,
          auto_stt              = excluded.auto_stt,
          ignored_numbers       = excluded.ignored_numbers,
          ignored_users         = excluded.ignored_users,
          muted_commands        = excluded.muted_commands,
          muted_categories      = excluded.muted_categories,
          nicks                 = excluded.nicks,
          warnings              = excluded.warnings,
          custom_ai_prompt      = excluded.custom_ai_prompt,
          notifica_grupo_fechado = excluded.notifica_grupo_fechado,
          notifica_grupo_aberto  = excluded.notifica_grupo_aberto,
          updated_at            = excluded.updated_at,
          json_data             = excluded.json_data`,
				{ ...row, json_data: jsonData }
			);
			return true;
		} catch (error) {
			this.logger.error("Error saving group:", error);
			return false;
		}
	}

	/**
	 * Persists only the `interact` field of a group (lightweight update).
	 * Used to save lastInteraction timestamp without writing the whole group.
	 * @param {string} groupId
	 * @param {Object} interact - The interact object to persist
	 */
	updateGroupInteract(groupId, interact) {
		try {
			this.mappers.run(this.DB, "UPDATE groups SET interact = ?, updated_at = ? WHERE id = ?", [
				JSON.stringify(interact),
				Date.now(),
				groupId
			]);
			return true;
		} catch (error) {
			this.logger.error("Error in updateGroupInteract:", error);
			return false;
		}
	}

	// ===========================================================================
	// Custom Commands
	// ===========================================================================

	async getCustomCommands(groupId) {
		try {
			const rows = this.mappers.all(
				this.CMD_DB,
				"SELECT * FROM custom_commands WHERE group_id = ?",
				[groupId]
			);
			return rows.map(CommandMapper.fromRow);
		} catch (error) {
			this.logger.error("Error in getCustomCommands:", error);
			return [];
		}
	}

	async saveCustomCommand(groupId, command) {
		try {
			const row = CommandMapper.toRow(groupId, command);
			const jsonData = JSON.stringify(command);

			this.mappers.run(
				this.CMD_DB,
				`INSERT INTO custom_commands
          (group_id, trigger, responses, admin_only, active, deleted, count,
           last_used, created_by, created_at, metadata, json_data)
         VALUES
          (@group_id, @trigger, @responses, @admin_only, @active, @deleted, @count,
           @last_used, @created_by, @created_at, @metadata, @json_data)
         ON CONFLICT(group_id, trigger) DO UPDATE SET
          responses  = excluded.responses,
          admin_only = excluded.admin_only,
          active     = excluded.active,
          deleted    = excluded.deleted,
          count      = excluded.count,
          last_used  = excluded.last_used,
          metadata   = excluded.metadata,
          json_data  = excluded.json_data`,
				{ ...row, json_data: jsonData }
			);
			return true;
		} catch (error) {
			this.logger.error("Error saving custom command:", error);
			return false;
		}
	}

	async updateCustomCommand(groupId, command) {
		return this.saveCustomCommand(groupId, command);
	}

	async deleteCustomCommand(groupId, commandStart) {
		try {
			const row = this.mappers.get(
				this.CMD_DB,
				"SELECT * FROM custom_commands WHERE group_id = ? AND trigger = ?",
				[groupId, commandStart]
			);
			if (row) {
				const command = CommandMapper.fromRow(row);
				command.deleted = true;
				command.active = false;
				await this.saveCustomCommand(groupId, command);
				return true;
			}
			return false;
		} catch (error) {
			this.logger.error("Error deleting custom command:", error);
			return false;
		}
	}

	// ===========================================================================
	// Donations
	// ===========================================================================

	async getDonations() {
		try {
			const rows = this.mappers.all(this.DB, "SELECT * FROM donations");
			return rows.map(DonationMapper.fromRow);
		} catch (error) {
			this.logger.error("Error getting donations:", error);
			return [];
		}
	}

	async saveDonations(donations) {
		try {
			this.mappers.transaction(this.DB, () => {
				const conn = this.mappers.getConnection(this.DB);
				conn.prepare("DELETE FROM donations").run();
				const stmt = conn.prepare(
					"INSERT INTO donations (name, valor, numero, timestamp, historico, json_data) VALUES (@name, @valor, @numero, @timestamp, @historico, @json_data)"
				);
				for (const d of donations) {
					const row = DonationMapper.toRow(d);
					stmt.run({ ...row, json_data: JSON.stringify(d) });
				}
			});
			return true;
		} catch (error) {
			this.logger.error("Error saving donations:", error);
			return false;
		}
	}

	async addDonation(name, amount, numero = undefined) {
		try {
			const row = this.mappers.get(
				this.DB,
				"SELECT * FROM donations WHERE name = ? COLLATE NOCASE",
				[name]
			);

			let donor;
			const now = Date.now();
			const historyEntry = { ts: now, valor: amount };
			let donationTotal;

			if (row) {
				donor = DonationMapper.fromRow(row);
				donor.valor += amount;
				donor.timestamp = now;
				if (!donor.historico) donor.historico = [];
				donor.historico.push(historyEntry);
				if (numero) donor.numero = numero;
				donationTotal = donor.valor;
			} else {
				donor = {
					nome: name,
					valor: amount,
					numero,
					timestamp: now,
					historico: [historyEntry]
				};
				donationTotal = amount;
			}

			const r = DonationMapper.toRow(donor);
			this.mappers.run(
				this.DB,
				"INSERT OR REPLACE INTO donations (name, valor, numero, timestamp, historico, json_data) VALUES (@name, @valor, @numero, @timestamp, @historico, @json_data)",
				{ ...r, json_data: JSON.stringify(donor) }
			);

			return donationTotal === 0 ? true : donationTotal;
		} catch (error) {
			this.logger.error("Error adding donation:", error);
			return false;
		}
	}

	async updateDonorNumber(name, numero) {
		try {
			const row = this.mappers.get(
				this.DB,
				"SELECT * FROM donations WHERE name = ? COLLATE NOCASE",
				[name]
			);
			if (!row) {
				this.logger.warn(`Donor "${name}" not found`);
				return false;
			}
			const donor = DonationMapper.fromRow(row);
			donor.numero = numero;
			const r = DonationMapper.toRow(donor);
			this.mappers.run(
				this.DB,
				"INSERT OR REPLACE INTO donations (name, valor, numero, timestamp, historico, json_data) VALUES (@name, @valor, @numero, @timestamp, @historico, @json_data)",
				{ ...r, json_data: JSON.stringify(donor) }
			);
			return true;
		} catch (error) {
			this.logger.error("Error updating donor number:", error);
			return false;
		}
	}

	async updateDonationAmount(name, amount) {
		try {
			const row = this.mappers.get(
				this.DB,
				"SELECT * FROM donations WHERE name = ? COLLATE NOCASE",
				[name]
			);
			let donor;
			const now = Date.now();
			const historyEntry = { ts: now, valor: amount };

			if (!row) {
				if (amount > 0) {
					donor = { nome: name, valor: amount, timestamp: now, historico: [historyEntry] };
				} else {
					return false;
				}
			} else {
				donor = DonationMapper.fromRow(row);
				donor.valor += amount;
				donor.timestamp = now;
				if (!donor.historico) donor.historico = [];
				donor.historico.push(historyEntry);
			}

			if (donor.valor <= 0) {
				this.mappers.run(this.DB, "DELETE FROM donations WHERE name = ?", [donor.nome]);
				this.logger.warn(`Donor "${name}" removed.`);
			} else {
				const r = DonationMapper.toRow(donor);
				this.mappers.run(
					this.DB,
					"INSERT OR REPLACE INTO donations (name, valor, numero, timestamp, historico, json_data) VALUES (@name, @valor, @numero, @timestamp, @historico, @json_data)",
					{ ...r, json_data: JSON.stringify(donor) }
				);
			}
			return true;
		} catch (error) {
			this.logger.error("Error updating donation amount:", error);
			return false;
		}
	}

	async mergeDonors(targetName, sourceName) {
		try {
			const targetRow = this.mappers.get(
				this.DB,
				"SELECT * FROM donations WHERE name = ? COLLATE NOCASE",
				[targetName]
			);
			const sourceRow = this.mappers.get(
				this.DB,
				"SELECT * FROM donations WHERE name = ? COLLATE NOCASE",
				[sourceName]
			);
			if (!targetRow || !sourceRow) return false;

			const target = DonationMapper.fromRow(targetRow);
			const source = DonationMapper.fromRow(sourceRow);

			target.valor += source.valor;
			const srcHistory = source.historico || [];
			const tgtHistory = target.historico || [];
			target.historico = [...tgtHistory, ...srcHistory].sort((a, b) => a.ts - b.ts);
			if (!target.numero && source.numero) target.numero = source.numero;
			if (target.historico.length > 0) {
				target.timestamp = target.historico[target.historico.length - 1].ts;
			}

			this.mappers.transaction(this.DB, () => {
				const conn = this.mappers.getConnection(this.DB);
				conn.prepare("DELETE FROM donations WHERE name = ?").run(source.nome);
				const r = DonationMapper.toRow(target);
				conn
					.prepare(
						"INSERT OR REPLACE INTO donations (name, valor, numero, timestamp, historico, json_data) VALUES (@name, @valor, @numero, @timestamp, @historico, @json_data)"
					)
					.run({ ...r, json_data: JSON.stringify(target) });
			});
			return true;
		} catch (error) {
			this.logger.error("Error merging donors:", error);
			return false;
		}
	}

	// ===========================================================================
	// Pending Joins
	// ===========================================================================

	async getPendingJoins() {
		try {
			const rows = this.mappers.all(this.DB, "SELECT * FROM pending_joins");
			return rows.map(PendingJoinMapper.fromRow);
		} catch (error) {
			this.logger.error("Error getting pending joins:", error);
			return [];
		}
	}

	async savePendingJoin(inviteCode, data) {
		try {
			const joinData = {
				code: inviteCode,
				authorId: data.authorId,
				authorName: data.authorName,
				timestamp: Date.now()
			};
			const row = PendingJoinMapper.toRow(joinData);
			this.mappers.run(
				this.DB,
				"INSERT OR REPLACE INTO pending_joins (code, author_id, author_name, timestamp, json_data) VALUES (@code, @author_id, @author_name, @timestamp, @json_data)",
				{ ...row, json_data: JSON.stringify(joinData) }
			);
			return true;
		} catch (error) {
			this.logger.error("Error saving pending join:", error);
			return false;
		}
	}

	async savePendingJoins(joins) {
		try {
			this.mappers.transaction(this.DB, () => {
				const conn = this.mappers.getConnection(this.DB);
				conn.prepare("DELETE FROM pending_joins").run();
				const stmt = conn.prepare(
					"INSERT INTO pending_joins (code, author_id, author_name, timestamp, json_data) VALUES (@code, @author_id, @author_name, @timestamp, @json_data)"
				);
				for (const j of joins) {
					const row = PendingJoinMapper.toRow(j);
					stmt.run({ ...row, json_data: JSON.stringify(j) });
				}
			});
			return true;
		} catch (error) {
			this.logger.error("Error saving pending joins:", error);
			return false;
		}
	}

	async removePendingJoin(inviteCode) {
		try {
			this.mappers.run(this.DB, "DELETE FROM pending_joins WHERE code = ?", [inviteCode]);
			return true;
		} catch (error) {
			this.logger.error("Error removing pending join:", error);
			return false;
		}
	}

	// ===========================================================================
	// Soft Blocks
	// ===========================================================================

	async getSoftblocks() {
		try {
			const rows = this.mappers.all(this.DB, "SELECT * FROM soft_blocks");
			return rows.map(SoftBlockMapper.fromRow);
		} catch (error) {
			this.logger.error("Error getting softblocks:", error);
			return [];
		}
	}

	async toggleUserInvites(phoneNumber, block) {
		try {
			if (block) {
				const user = { numero: phoneNumber, invites: true };
				const row = SoftBlockMapper.toRow(user);
				this.mappers.run(
					this.DB,
					"INSERT OR REPLACE INTO soft_blocks (number, block_invites, json_data) VALUES (@number, @block_invites, @json_data)",
					{ ...row, json_data: JSON.stringify(user) }
				);
			} else {
				this.mappers.run(this.DB, "DELETE FROM soft_blocks WHERE number = ?", [phoneNumber]);
			}
			return true;
		} catch (error) {
			this.logger.error("Error toggling user invites:", error);
			return false;
		}
	}

	async isUserInviteBlocked(phoneNumber) {
		try {
			const row = this.mappers.get(
				this.DB,
				"SELECT block_invites FROM soft_blocks WHERE number = ?",
				[phoneNumber]
			);
			return row ? !!row.block_invites : false;
		} catch (error) {
			this.logger.error("Error checking user invite block:", error);
			return false;
		}
	}

	// ===========================================================================
	// Blocked Invites
	// ===========================================================================

	async saveBlockedInvite(code, jid) {
		try {
			const existing = this.mappers.get(
				this.DB,
				"SELECT id FROM blocked_invites WHERE (code = ? AND code IS NOT NULL) OR (jid = ? AND jid IS NOT NULL)",
				[code, jid]
			);
			if (existing) {
				this.mappers.run(
					this.DB,
					"UPDATE blocked_invites SET code = COALESCE(?, code), jid = COALESCE(?, jid) WHERE id = ?",
					[code, jid, existing.id]
				);
			} else {
				this.mappers.run(
					this.DB,
					"INSERT INTO blocked_invites (code, jid, timestamp, json_data) VALUES (?, ?, ?, ?)",
					[code, jid, Date.now(), JSON.stringify({ timestamp: Date.now() })]
				);
			}
			return true;
		} catch (error) {
			this.logger.error("Error saving blocked invite:", error);
			return false;
		}
	}

	async isInviteBlocked(code, jid) {
		try {
			if (code) {
				const row = this.mappers.get(this.DB, "SELECT 1 FROM blocked_invites WHERE code = ?", [
					code
				]);
				if (row) return true;
			}
			if (jid) {
				const row = this.mappers.get(this.DB, "SELECT 1 FROM blocked_invites WHERE jid = ?", [jid]);
				if (row) return true;
			}
			return false;
		} catch (error) {
			this.logger.error("Error checking if invite is blocked:", error);
			return false;
		}
	}

	// ===========================================================================
	// Load Reports
	// ===========================================================================

	async getLoadReports(since = 0) {
		try {
			const rows = this.mappers.all(
				this.REPORTS_DB,
				"SELECT * FROM load_reports WHERE timestamp_end > ?",
				[since]
			);
			return rows.map(LoadReportMapper.fromRow);
		} catch (error) {
			this.logger.error("Error getting load reports:", error);
			return [];
		}
	}

	/**
	 * Obtém dados agregados de relatórios de carga para analytics
	 * @param {number} since - Timestamp inicial
	 * @returns {Promise<Array>} - Dados agregados por bot e dia
	 */
	async getAggregatedLoadReports(since = 0) {
		try {
			const sql = `
				SELECT 
					bot_id as botId,
					strftime('%Y-%m-%dT%H:00:00.000Z', datetime(timestamp_start/1000, 'unixepoch')) as hourKey,
					strftime('%Y-%m-%d', datetime(timestamp_start/1000, 'unixepoch')) as dateKey,
					strftime('%w', datetime(timestamp_start/1000, 'unixepoch')) as dayOfWeek,
					strftime('%d', datetime(timestamp_start/1000, 'unixepoch')) as dayOfMonth,
					SUM(recv_private + recv_group + sent_private + sent_group) as totalMessages
				FROM load_reports 
				WHERE timestamp_start > ?
				GROUP BY botId, hourKey
			`;
			return this.mappers.all(this.REPORTS_DB, sql, [since]);
		} catch (error) {
			this.logger.error("Error getting aggregated load reports:", error);
			return [];
		}
	}

	async addLoadReport(report) {
		try {
			const row = LoadReportMapper.toRow(report);
			this.mappers.run(
				this.REPORTS_DB,
				`INSERT INTO load_reports
          (bot_id, timestamp_start, timestamp_end, duration,
           recv_private, recv_group, sent_private, sent_group, msgs_per_hour,
           resp_avg, resp_max, resp_count, json_data)
         VALUES
          (@bot_id, @timestamp_start, @timestamp_end, @duration,
           @recv_private, @recv_group, @sent_private, @sent_group, @msgs_per_hour,
           @resp_avg, @resp_max, @resp_count, @json_data)`,
				{ ...row, json_data: JSON.stringify(report) }
			);
			return true;
		} catch (error) {
			this.logger.error("Error adding load report:", error);
			return false;
		}
	}

	async saveLoadReports(reports) {
		try {
			this.mappers.transaction(this.REPORTS_DB, () => {
				const conn = this.mappers.getConnection(this.REPORTS_DB);
				conn.prepare("DELETE FROM load_reports").run();
				const stmt = conn.prepare(
					`INSERT INTO load_reports
            (bot_id, timestamp_start, timestamp_end, duration,
             recv_private, recv_group, sent_private, sent_group, msgs_per_hour,
             resp_avg, resp_max, resp_count, json_data)
           VALUES
            (@bot_id, @timestamp_start, @timestamp_end, @duration,
             @recv_private, @recv_group, @sent_private, @sent_group, @msgs_per_hour,
             @resp_avg, @resp_max, @resp_count, @json_data)`
				);
				for (const report of reports) {
					const row = LoadReportMapper.toRow(report);
					stmt.run({ ...row, json_data: JSON.stringify(report) });
				}
			});
			return true;
		} catch (error) {
			this.logger.error("Error saving load reports:", error);
			return false;
		}
	}

	// --- Local Blocks ---

	async addLocalBlock(phoneNumber) {
		try {
			this.mappers.run(
				this.DB,
				"INSERT OR REPLACE INTO local_blocks (number, timestamp) VALUES (?, ?)",
				[phoneNumber, Date.now()]
			);
			return true;
		} catch (error) {
			this.logger.error("Error adding local block:", error);
			return false;
		}
	}

	async removeLocalBlock(phoneNumber) {
		try {
			this.mappers.run(this.DB, "DELETE FROM local_blocks WHERE number = ?", [phoneNumber]);
			return true;
		} catch (error) {
			this.logger.error("Error removing local block:", error);
			return false;
		}
	}

	async isLocalBlocked(phoneNumber) {
		try {
			const row = this.mappers.get(this.DB, "SELECT number FROM local_blocks WHERE number = ?", [
				phoneNumber
			]);
			return !!row;
		} catch (error) {
			this.logger.error("Error checking local block:", error);
			return false;
		}
	}

	async getLocalBlocks() {
		try {
			const rows = this.mappers.all(this.DB, "SELECT * FROM local_blocks");
			return rows;
		} catch (error) {
			this.logger.error("Error getting local blocks:", error);
			return [];
		}
	}

	// --- Invite History ---

	async addInviteHistory(invite) {
		try {
			const row = {
				invite_code: invite.code || null,
				group_jid: invite.groupJid || null,
				author_id: invite.authorId || null,
				author_name: invite.authorName || null,
				timestamp: invite.timestamp || Date.now(),
				reason: invite.reason || null,
				json_data: JSON.stringify(invite)
			};
			this.mappers.run(
				this.DB,
				"INSERT INTO invite_history (invite_code, group_jid, author_id, author_name, timestamp, reason, json_data) VALUES (@invite_code, @group_jid, @author_id, @author_name, @timestamp, @reason, @json_data)",
				row
			);
			return true;
		} catch (error) {
			this.logger.error("Error adding invite history:", error);
			return false;
		}
	}

	async getInviteHistoryByAuthor(authorId) {
		try {
			const cleanAuthorId = authorId.replace(/[^0-9]/g, "");
			return this.mappers.all(
				this.DB,
				"SELECT * FROM invite_history WHERE REPLACE(REPLACE(author_id, '@c.us', ''), '@s.whatsapp.net', '') = ?",
				[cleanAuthorId]
			);
		} catch (error) {
			this.logger.error("Error getting invite history by author:", error);
			return [];
		}
	}

	async getInviteHistoryByGroup(groupJid, inviteCode) {
		try {
			let query = "SELECT * FROM invite_history WHERE 1=0";
			const params = [];
			if (groupJid && inviteCode) {
				query = "SELECT * FROM invite_history WHERE group_jid = ? OR invite_code = ?";
				params.push(groupJid, inviteCode);
			} else if (groupJid) {
				query = "SELECT * FROM invite_history WHERE group_jid = ?";
				params.push(groupJid);
			} else if (inviteCode) {
				query = "SELECT * FROM invite_history WHERE invite_code = ?";
				params.push(inviteCode);
			}
			return this.mappers.all(this.DB, query, params);
		} catch (error) {
			this.logger.error("Error getting invite history by group:", error);
			return [];
		}
	}

	async saveInviteHistories(invites) {
		try {
			this.mappers.transaction(this.DB, () => {
				const conn = this.mappers.getConnection(this.DB);
				const stmt = conn.prepare(
					"INSERT INTO invite_history (invite_code, group_jid, author_id, author_name, timestamp, reason, json_data) VALUES (@invite_code, @group_jid, @author_id, @author_name, @timestamp, @reason, @json_data)"
				);
				for (const invite of invites) {
					const row = {
						invite_code: invite.code || null,
						group_jid: invite.groupJid || null,
						author_id: invite.authorId || null,
						author_name: invite.authorName || null,
						timestamp: invite.timestamp || Date.now(),
						reason: invite.reason || null,
						json_data: JSON.stringify(invite)
					};
					stmt.run(row);
				}
			});
			return true;
		} catch (error) {
			this.logger.error("Error saving invite histories in bulk:", error);
			return false;
		}
	}

	// --- Group Membership Periods ---

	async recordGroupJoin(groupJid, groupName, timestamp, responsible) {
		try {
			const ts = timestamp || Date.now();
			const respStr = responsible
				? typeof responsible === "object"
					? JSON.stringify(responsible)
					: String(responsible)
				: null;

			// Close any existing open periods
			this.mappers.run(
				this.DB,
				"UPDATE group_membership_periods SET leave_timestamp = ?, duration = ? - join_timestamp WHERE group_jid = ? AND leave_timestamp IS NULL",
				[ts, ts, groupJid]
			);

			// Insert new period
			this.mappers.run(
				this.DB,
				"INSERT INTO group_membership_periods (group_jid, group_name, join_timestamp, join_responsible, json_data) VALUES (?, ?, ?, ?, ?)",
				[
					groupJid,
					groupName,
					ts,
					respStr,
					JSON.stringify({ groupJid, groupName, join_timestamp: ts, join_responsible: responsible })
				]
			);
			return true;
		} catch (error) {
			this.logger.error("Error recording group join:", error);
			return false;
		}
	}

	async recordGroupLeave(groupJid, timestamp, responsible) {
		try {
			const ts = timestamp || Date.now();
			const respStr = responsible
				? typeof responsible === "object"
					? JSON.stringify(responsible)
					: String(responsible)
				: null;

			// Find open period
			const openPeriod = this.mappers.get(
				this.DB,
				"SELECT id, join_timestamp FROM group_membership_periods WHERE group_jid = ? AND leave_timestamp IS NULL ORDER BY join_timestamp DESC LIMIT 1",
				[groupJid]
			);

			if (openPeriod) {
				const duration = ts - openPeriod.join_timestamp;
				this.mappers.run(
					this.DB,
					"UPDATE group_membership_periods SET leave_timestamp = ?, duration = ?, leave_responsible = ? WHERE id = ?",
					[ts, duration, respStr, openPeriod.id]
				);
			} else {
				// No open period, insert a leave-only period
				this.mappers.run(
					this.DB,
					"INSERT INTO group_membership_periods (group_jid, leave_timestamp, leave_responsible, json_data) VALUES (?, ?, ?, ?)",
					[
						groupJid,
						ts,
						respStr,
						JSON.stringify({ groupJid, leave_timestamp: ts, leave_responsible: responsible })
					]
				);
			}
			return true;
		} catch (error) {
			this.logger.error("Error recording group leave:", error);
			return false;
		}
	}

	async getGroupMembershipPeriods(groupJid) {
		try {
			return this.mappers.all(
				this.DB,
				"SELECT * FROM group_membership_periods WHERE group_jid = ? ORDER BY join_timestamp ASC, leave_timestamp ASC",
				[groupJid]
			);
		} catch (error) {
			this.logger.error("Error getting group membership periods:", error);
			return [];
		}
	}

	async saveGroupMembershipPeriods(periods) {
		try {
			this.mappers.transaction(this.DB, () => {
				const conn = this.mappers.getConnection(this.DB);
				const stmt = conn.prepare(
					"INSERT INTO group_membership_periods (group_jid, group_name, join_timestamp, leave_timestamp, duration, join_responsible, leave_responsible, json_data) VALUES (@group_jid, @group_name, @join_timestamp, @leave_timestamp, @duration, @join_responsible, @leave_responsible, @json_data)"
				);
				for (const p of periods) {
					const row = {
						group_jid: p.groupJid || null,
						group_name: p.groupName || null,
						join_timestamp: p.joinTimestamp || null,
						leave_timestamp: p.leaveTimestamp || null,
						duration: p.duration || null,
						join_responsible: p.joinResponsible
							? typeof p.joinResponsible === "object"
								? JSON.stringify(p.joinResponsible)
								: String(p.joinResponsible)
							: null,
						leave_responsible: p.leaveResponsible
							? typeof p.leaveResponsible === "object"
								? JSON.stringify(p.leaveResponsible)
								: String(p.leaveResponsible)
							: null,
						json_data: JSON.stringify(p)
					};
					stmt.run(row);
				}
			});
			return true;
		} catch (error) {
			this.logger.error("Error saving group membership periods in bulk:", error);
			return false;
		}
	}
}

module.exports = CoreRepository;
