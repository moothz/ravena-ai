const path = require("path");
const Logger = require("../utils/Logger");
const ReturnMessage = require("../models/ReturnMessage");
const Command = require("../models/Command");
const Database = require("../utils/Database");
const fs = require("fs").promises;
const mysql = require("mysql2/promise");
const AdminUtils = require("../utils/AdminUtils");

const logger = new Logger("ragnarok-commands");
const database = Database.getInstance();
const adminUtils = AdminUtils.getInstance();

// Database configuration
const dbConfig = {
	host: process.env.RAGNAROK_HOST,
	user: process.env.RAGNAROK_USER,
	password: process.env.RAGNAROK_PASSWORD,
	database: process.env.RAGNAROK_DATABASE
};

/**
 * Sanitizes strings to alphanumeric only
 */
function sanitize(str) {
	return str ? str.replace(/[^a-zA-Z0-9]/g, "") : "";
}

/**
 * Generates a random password
 */
function generatePassword(length = 8) {
	const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	let retVal = "";
	for (let i = 0; i < length; ++i) {
		retVal += charset.charAt(Math.floor(Math.random() * charset.length));
	}
	return retVal;
}

async function ragnarokInfoCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	try {
		const ragnaPath = path.join(database.databasePath, "textos", "ragnarok.txt");
		const ragnaContent = await fs.readFile(ragnaPath, "utf8");

		return new ReturnMessage({
			chatId,
			content: ragnaContent.trim()
		});
	} catch (error) {
		logger.warn("Erro ao ler ragnarok.txt:", error);
		return new ReturnMessage({
			chatId,
			content: `Erro buscando as infos do Ragnavena!`
		});
	}
}

async function ragnarokCommand(bot, message, args, group) {
	logger.debug(`[ragnarokCommand] `, { message, args });
	const chatId = message.author;
	const authorId = message.author ?? message.authorAlt;
	const sanitizedUser = sanitize(authorId.split("@")[0]);

	let user, pass;
	let isNew = false;

	// 1. Check Super Admin
	if (adminUtils.isSuperAdmin(authorId)) {
		user = "admin";
		pass = "admin";
	} else {
		const connection = await mysql.createConnection(dbConfig);
		try {
			// Check if account exists
			const [rows] = await connection.execute(
				"SELECT account_id, userid, user_pass FROM login WHERE userid = ?",
				[sanitizedUser]
			);

			if (rows.length > 0) {
				user = rows[0].userid;
				pass = rows[0].user_pass;
			} else {
				// Create new account
				isNew = true;
				user = sanitizedUser;
				pass = generatePassword();

				const [result] = await connection.execute(
					'INSERT INTO login (userid, user_pass, sex, email, group_id) VALUES (?, ?, "M", ?, 0)',
					[user, pass, `${user}@ravenabot.com`]
				);

				const accountId = result.insertId;

				// Create initial character
				const rawName = message.name ?? message.pushName ?? message.pushname ?? message.authorName;
				let charName = sanitize(rawName);

				if (!charName || charName.length <= 3 || charName.length === 0) {
					logger.info(`[ragnarokCommand] '${rawName}' -> '${charName}' invalido?`);
					charName = sanitize("Player_" + user).substring(0, 23);
				}

				charName = charName.substring(0, 23);

				try {
					await connection.execute(
						'INSERT INTO `char` (account_id, name, char_num, class, base_level, job_level, hair, hair_color, last_map, last_x, last_y, save_map, save_x, save_y, max_hp, hp, max_sp, sp) VALUES (?, ?, 0, 0, 1, 1, 1, 1, "darkmall", 100, 98, "darkmall", 100, 98, 40, 40, 11, 11)',
						[accountId, charName]
					);
				} catch (charErr) {
					logger.error("Failed to create character: " + charErr.message);
					// Character creation might fail if name is taken, we continue anyway as account is created
				}
			}
		} finally {
			await connection.end();
		}
	}

	// 2. Generate Auth Link
	const authPayload = Buffer.from(`${user}:${pass}`).toString("base64");
	const loginLink = `${process.env.RAGNAROK_URL}/?auth=${authPayload}`;

	let responseText = isNew
		? "*Sua conta foi criada com sucesso!* ⚔️\n\n"
		: "*Aqui estão seus dados de acesso:* 🛡️\n\n";
	responseText += `- *Usuário:* ${user}
- *Senha:* ${pass}

- *Link de Acesso Direto:*
- ${loginLink}
> ⚠️ *ATENÇÃO:* Nunca compartilhe este link com ninguém. Ele permite acesso direto à sua conta e personagens.

Para saber, envie: \`!rag-info\`
`;

	return new ReturnMessage({
		chatId,
		content: responseText,
		options: {
			quotedMessageId: message.origin.id._serialized,
			goReply: message.origin
		}
	});
}

async function ragnarokResetCommand(bot, message, args, group) {
	const chatId = message.author;
	const authorId = message.author ?? message.authorAlt;
	const sanitizedUser = sanitize(authorId.split("@")[0]);

	if (adminUtils.isSuperAdmin(authorId)) {
		return new ReturnMessage({ chatId, content: "Admins não podem ser resetados via bot." });
	}

	const connection = await mysql.createConnection(dbConfig);
	try {
		if (args[0] === "full") {
			// Get account ID
			const [rows] = await connection.execute("SELECT account_id FROM login WHERE userid = ?", [
				sanitizedUser
			]);
			if (rows.length > 0) {
				const accId = rows[0].account_id;
				await connection.execute("DELETE FROM `char` WHERE account_id = ?", [accId]);
				await connection.execute("DELETE FROM login WHERE account_id = ?", [accId]);
			}
			await connection.end();
			return ragnarokCommand(bot, message, args, group);
		} else {
			const newPass = generatePassword();
			const [result] = await connection.execute("UPDATE login SET user_pass = ? WHERE userid = ?", [
				newPass,
				sanitizedUser
			]);

			if (result.affectedRows === 0) {
				await connection.end();
				return new ReturnMessage({
					chatId,
					content: "Conta não encontrada. Use !ragnarok primeiro."
				});
			}

			await connection.end();
			return ragnarokCommand(bot, message, args, group);
		}
	} catch (e) {
		await connection.end();
		logger.error("Reset failed: " + e.message);
		return new ReturnMessage({ chatId, content: "Erro ao processar reset." });
	}
}

const commands = [
	new Command({
		name: "rag-info",
		description: "Ragnarok da ravena, no navegador!",
		category: "jogos",
		hidden: true,
		reactions: { after: "🛡️" },
		method: ragnarokInfoCommand
	}),
	new Command({
		name: "ragnavena",
		description: "Ragnarok da ravena, no navegador!",
		category: "jogos",
		reactions: { before: "⚔️", after: "🛡️" },
		method: ragnarokCommand
	}),
	new Command({
		name: "ragnavena-reset",
		description: 'Reseta sua senha ou conta (use "full" para apagar tudo)',
		category: "jogos",
		hidden: true,
		reactions: { before: "🔄", after: "✅" },
		method: ragnarokResetCommand
	})
];

module.exports = { commands };
