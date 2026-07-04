// src/functions/RelacionamentoCommands.js
const Logger = require("../utils/Logger");
const ReturnMessage = require("../models/ReturnMessage");
const Command = require("../models/Command");
const Database = require("../utils/Database");

const logger = new Logger("relacionamentos");
const database = Database.getInstance();
const dbName = "relacionamentos";

// Inicializa o banco de dados de relacionamentos
database.getSQLiteDb(
	dbName,
	`
	CREATE TABLE IF NOT EXISTS relacionamentos (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		group_id TEXT NOT NULL,
		user1 TEXT NOT NULL,         -- clean number
		user2 TEXT NOT NULL,         -- clean number
		user1_jid TEXT NOT NULL,     -- full JID (e.g. including @s.whatsapp.net or @lid)
		user2_jid TEXT NOT NULL,     -- full JID (e.g. including @s.whatsapp.net or @lid)
		tipo TEXT NOT NULL,          -- 'namoro', 'casamento', 'separar'
		status TEXT NOT NULL,        -- 'pendente', 'ativo', 'terminado'
		criado_em INTEGER,
		terminado_em INTEGER,
		coisas_count INTEGER DEFAULT 0,
		traicoes_count INTEGER DEFAULT 0
	);
	CREATE INDEX IF NOT EXISTS idx_relacionamentos_group ON relacionamentos(group_id);
	`
);

function getCleanNumber(jid) {
	if (!jid) return "";
	return jid.split("@")[0];
}

function getSenderJid(message) {
	if (message.authorAlt && message.authorAlt.includes("@")) {
		return message.authorAlt;
	}
	if (message.goMessageData?.Info?.Sender) {
		return message.goMessageData.Info.Sender;
	}
	const authorClean = getCleanNumber(message.author);
	if (authorClean.startsWith("3") && authorClean.length >= 14) {
		return `${authorClean}@lid`;
	}
	return `${authorClean}@s.whatsapp.net`;
}

function formatDuration(ms) {
	if (!ms || ms < 0) return "0 segundos";
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (days > 0) {
		const remainingHours = hours % 24;
		return `${days} dia(s) e ${remainingHours} hora(s)`;
	}
	if (hours > 0) {
		const remainingMinutes = minutes % 60;
		return `${hours} hora(s) e ${remainingMinutes} minuto(s)`;
	}
	if (minutes > 0) {
		const remainingSeconds = seconds % 60;
		return `${minutes} minuto(s) e ${remainingSeconds} segundo(s)`;
	}
	return `${seconds} segundo(s)`;
}

function getMentionStr(jid) {
	return `@${getCleanNumber(jid)}`;
}

async function namorarCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	// Só funciona em grupo
	if (!message.group) {
		return new ReturnMessage({
			chatId,
			content: "❌ Este comando só funciona em grupos! 👥",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}

	const groupId = message.group;
	const authorJid = getSenderJid(message);
	const authorId = getCleanNumber(authorJid);

	// Pegar mentions
	const mentions = message.mentions ?? message.origin?.mentionedIds ?? [];
	if (mentions.length === 0) {
		return new ReturnMessage({
			chatId,
			content: "❌ Você precisa mencionar alguém para pedir em namoro! Ex: *!namorar @pessoa* 😉",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}

	const targetJid = mentions[0];
	const targetId = getCleanNumber(targetJid);

	if (targetId === authorId) {
		return new ReturnMessage({
			chatId,
			content: "❌ Você não pode namorar consigo mesmo(a)! Procure alguém especial no grupo. 😉💖",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}

	// Verificar se já tem algum relacionamento ativo entre eles
	const activeRel = await database.dbGet(
		dbName,
		`
		SELECT * FROM relacionamentos 
		WHERE group_id = ? 
		  AND ((user1 = ? AND user2 = ?) OR (user1 = ? AND user2 = ?))
		  AND status = 'ativo'
		  AND tipo IN ('namoro', 'casamento')
		`,
		[groupId, authorId, targetId, targetId, authorId]
	);

	if (activeRel) {
		const relTypeStr = activeRel.tipo === "casamento" ? "casados(as) 💍" : "namorando 💖";
		return new ReturnMessage({
			chatId,
			content: `❌ Vocês já estão ${relTypeStr}! Não precisa pedir de novo. 🥰`,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin,
				mentions: [targetJid]
			}
		});
	}

	// Verificar se há uma proposta pendente do targetId para o authorId
	const pendingProposal = await database.dbGet(
		dbName,
		`
		SELECT * FROM relacionamentos 
		WHERE group_id = ? 
		  AND user1 = ? AND user2 = ? 
		  AND tipo = 'namoro' 
		  AND status = 'pendente'
		`,
		[groupId, targetId, authorId]
	);

	if (pendingProposal) {
		// Aceitar o pedido!
		await database.dbRun(
			dbName,
			`
			UPDATE relacionamentos 
			SET status = 'ativo', criado_em = ? 
			WHERE id = ?
			`,
			[Date.now(), pendingProposal.id]
		);

		// Deleta qualquer outra proposta de namoro pendente entre eles
		await database.dbRun(
			dbName,
			`
			DELETE FROM relacionamentos 
			WHERE group_id = ? 
			  AND user1 = ? AND user2 = ? 
			  AND tipo = 'namoro' 
			  AND status = 'pendente'
			`,
			[groupId, authorId, targetId]
		);

		return new ReturnMessage({
			chatId,
			content: `🎉 *OFICIALIZADO!* 🎉\n\n💖 ${getMentionStr(authorJid)} aceitou o pedido de namoro de ${getMentionStr(pendingProposal.user1_jid)}! Agora vocês estão oficialmente namorando! 😍💑\n\nQue essa união seja repleta de momentos felizes e muitas coisadas! 🔥😉`,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin,
				mentions: [authorJid, pendingProposal.user1_jid]
			}
		});
	}

	// Verificar se o authorId já tem um pedido pendente para o targetId
	const existingProposal = await database.dbGet(
		dbName,
		`
		SELECT * FROM relacionamentos 
		WHERE group_id = ? 
		  AND user1 = ? AND user2 = ? 
		  AND tipo = 'namoro' 
		  AND status = 'pendente'
		`,
		[groupId, authorId, targetId]
	);

	if (existingProposal) {
		return new ReturnMessage({
			chatId,
			content: `⌛ Você já pediu ${getMentionStr(targetJid)} em namoro! Aguarde a resposta dele(a). 😉`,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin,
				mentions: [targetJid]
			}
		});
	}

	// Criar novo pedido de namoro
	await database.dbRun(
		dbName,
		`
		INSERT INTO relacionamentos (group_id, user1, user2, user1_jid, user2_jid, tipo, status, criado_em)
		VALUES (?, ?, ?, ?, ?, 'namoro', 'pendente', ?)
		`,
		[groupId, authorId, targetId, authorJid, targetJid, Date.now()]
	);

	return new ReturnMessage({
		chatId,
		content: `💖 ${getMentionStr(targetJid)}, você foi pedida(o) em namoro pelo(a) ${getMentionStr(authorJid)}!\n\nSe aceita, envie também:\n!namorar ${getMentionStr(authorJid)}\n\nSe recusa, envie:\n!recusar ${getMentionStr(authorJid)}`,
		options: {
			quotedMessageId: message.origin.id._serialized,
			goReply: message.origin,
			mentions: [authorJid, targetJid]
		}
	});
}

async function casarCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	// Só funciona em grupo
	if (!message.group) {
		return new ReturnMessage({
			chatId,
			content: "❌ Este comando só funciona em grupos! 👥",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}

	const groupId = message.group;
	const authorJid = getSenderJid(message);
	const authorId = getCleanNumber(authorJid);

	// Pegar mentions
	const mentions = message.mentions ?? message.origin?.mentionedIds ?? [];
	if (mentions.length === 0) {
		return new ReturnMessage({
			chatId,
			content: "❌ Você precisa mencionar alguém para pedir em casamento! Ex: *!casar @pessoa* 😉",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}

	const targetJid = mentions[0];
	const targetId = getCleanNumber(targetJid);

	if (targetId === authorId) {
		return new ReturnMessage({
			chatId,
			content: "❌ Você não pode se casar com você mesmo(a)! 👰🤵",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}

	// Verificar se já estão casados
	const activeCasamento = await database.dbGet(
		dbName,
		`
		SELECT * FROM relacionamentos 
		WHERE group_id = ? 
		  AND ((user1 = ? AND user2 = ?) OR (user1 = ? AND user2 = ?))
		  AND status = 'ativo'
		  AND tipo = 'casamento'
		`,
		[groupId, authorId, targetId, targetId, authorId]
	);

	if (activeCasamento) {
		return new ReturnMessage({
			chatId,
			content: `❌ Vocês já estão casados! 💍 Que esse amor continue forte! 🥰`,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin,
				mentions: [targetJid]
			}
		});
	}

	// Verificar se estão namorando (requisito de casamento)
	const activeNamoro = await database.dbGet(
		dbName,
		`
		SELECT * FROM relacionamentos 
		WHERE group_id = ? 
		  AND ((user1 = ? AND user2 = ?) OR (user1 = ? AND user2 = ?))
		  AND status = 'ativo'
		  AND tipo = 'namoro'
		`,
		[groupId, authorId, targetId, targetId, authorId]
	);

	if (!activeNamoro) {
		return new ReturnMessage({
			chatId,
			content: `❌ Ops! Só é permitido casar depois de namorar! Você precisa estar namorando com ${getMentionStr(targetJid)} primeiro. 💔`,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin,
				mentions: [targetJid]
			}
		});
	}

	// Verificar se há uma proposta de casamento pendente do targetId para o authorId
	const pendingProposal = await database.dbGet(
		dbName,
		`
		SELECT * FROM relacionamentos 
		WHERE group_id = ? 
		  AND user1 = ? AND user2 = ? 
		  AND tipo = 'casamento' 
		  AND status = 'pendente'
		`,
		[groupId, targetId, authorId]
	);

	if (pendingProposal) {
		// Aceitar o pedido de casamento! Upgrade namoro -> casamento
		await database.dbRun(
			dbName,
			`
			UPDATE relacionamentos 
			SET tipo = 'casamento', criado_em = ?
			WHERE id = ?
			`,
			[Date.now(), activeNamoro.id]
		);

		// Deletamos as propostas pendentes de casamento entre eles
		await database.dbRun(
			dbName,
			`
			DELETE FROM relacionamentos 
			WHERE group_id = ? 
			  AND ((user1 = ? AND user2 = ?) OR (user1 = ? AND user2 = ?))
			  AND tipo = 'casamento' 
			  AND status = 'pendente'
			`,
			[groupId, authorId, targetId, targetId, authorId]
		);

		return new ReturnMessage({
			chatId,
			content: `💍 *OFICIALMENTE CASADOS!* 💍\n\n🎉 Que momento lindo! ${getMentionStr(activeNamoro.user1_jid)} e ${getMentionStr(activeNamoro.user2_jid)} subiram ao altar e agora estão oficialmente casados! 🤵👰💐\n\nDesejamos uma vida inteira de cumplicidade, muito amor e coisadas sem fim! 🥂❤️`,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin,
				mentions: [activeNamoro.user1_jid, activeNamoro.user2_jid]
			}
		});
	}

	// Verificar se o authorId já tem um pedido pendente para o targetId
	const existingProposal = await database.dbGet(
		dbName,
		`
		SELECT * FROM relacionamentos 
		WHERE group_id = ? 
		  AND user1 = ? AND user2 = ? 
		  AND tipo = 'casamento' 
		  AND status = 'pendente'
		`,
		[groupId, authorId, targetId]
	);

	if (existingProposal) {
		return new ReturnMessage({
			chatId,
			content: `⌛ Você já pediu ${getMentionStr(targetJid)} em casamento! Aguarde a resposta dele(a). 💍`,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin,
				mentions: [targetJid]
			}
		});
	}

	// Criar novo pedido de casamento pendente
	await database.dbRun(
		dbName,
		`
		INSERT INTO relacionamentos (group_id, user1, user2, user1_jid, user2_jid, tipo, status, criado_em)
		VALUES (?, ?, ?, ?, ?, 'casamento', 'pendente', ?)
		`,
		[groupId, authorId, targetId, authorJid, targetJid, Date.now()]
	);

	return new ReturnMessage({
		chatId,
		content: `💍 ${getMentionStr(targetJid)}, você foi pedida(o) em casamento pelo(a) ${getMentionStr(authorJid)}!\n\nSe aceita, envie também:\n!casar ${getMentionStr(authorJid)}\n\nSe recusa, envie:\n!recusar ${getMentionStr(authorJid)}`,
		options: {
			quotedMessageId: message.origin.id._serialized,
			goReply: message.origin,
			mentions: [authorJid, targetJid]
		}
	});
}

async function separarCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	// Só funciona em grupo
	if (!message.group) {
		return new ReturnMessage({
			chatId,
			content: "❌ Este comando só funciona em grupos! 👥",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}

	const groupId = message.group;
	const authorJid = getSenderJid(message);
	const authorId = getCleanNumber(authorJid);

	// Pegar mentions
	const mentions = message.mentions ?? message.origin?.mentionedIds ?? [];
	if (mentions.length === 0) {
		return new ReturnMessage({
			chatId,
			content: "❌ Você precisa mencionar quem deseja se separar! Ex: *!separar @pessoa* 🧐",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}

	const targetJid = mentions[0];
	const targetId = getCleanNumber(targetJid);

	if (targetId === authorId) {
		return new ReturnMessage({
			chatId,
			content: "❌ Como você vai se separar de si mesmo(a)? 🤔",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}

	// Verificar se estão namorando ou casados
	const activeRel = await database.dbGet(
		dbName,
		`
		SELECT * FROM relacionamentos 
		WHERE group_id = ? 
		  AND ((user1 = ? AND user2 = ?) OR (user1 = ? AND user2 = ?))
		  AND status = 'ativo'
		  AND tipo IN ('namoro', 'casamento')
		`,
		[groupId, authorId, targetId, targetId, authorId]
	);

	if (!activeRel) {
		return new ReturnMessage({
			chatId,
			content: `❌ Ops! Você não tem nenhum relacionamento ativo (namoro ou casamento) com ${getMentionStr(targetJid)}! 🧐`,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin,
				mentions: [targetJid]
			}
		});
	}

	// Terminar o relacionamento imediatamente!
	await database.dbRun(
		dbName,
		`
		UPDATE relacionamentos 
		SET status = 'terminado', terminado_em = ? 
		WHERE id = ?
		`,
		[Date.now(), activeRel.id]
	);

	// Limpar qualquer pedido/proposta pendente entre eles
	await database.dbRun(
		dbName,
		`
		DELETE FROM relacionamentos 
		WHERE group_id = ? 
		  AND ((user1 = ? AND user2 = ?) OR (user1 = ? AND user2 = ?))
		  AND status = 'pendente'
		`,
		[groupId, authorId, targetId, targetId, authorId]
	);

	const relTypeStr = activeRel.tipo === "casamento" ? "casamento 💍" : "namoro 💖";

	return new ReturnMessage({
		chatId,
		content: `💔 *FIM DE RELACIONAMENTO!* 💔\n\nÉ oficial: o ${relTypeStr} entre ${getMentionStr(activeRel.user1_jid)} e ${getMentionStr(activeRel.user2_jid)} chegou ao fim. 👋🚶‍♂️🚶‍♀️`,
		options: {
			quotedMessageId: message.origin.id._serialized,
			goReply: message.origin,
			mentions: [activeRel.user1_jid, activeRel.user2_jid]
		}
	});
}

async function recusarCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	if (!message.group) {
		return new ReturnMessage({
			chatId,
			content: "❌ Este comando só funciona em grupos! 👥",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}

	const groupId = message.group;
	const authorJid = getSenderJid(message);
	const authorId = getCleanNumber(authorJid);

	const mentions = message.mentions ?? message.origin?.mentionedIds ?? [];
	if (mentions.length === 0) {
		return new ReturnMessage({
			chatId,
			content:
				"❌ Você precisa mencionar quem pediu você em namoro/casamento/separação para recusar! Ex: *!recusar @pessoa* 🧐",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}

	const targetJid = mentions[0];
	const targetId = getCleanNumber(targetJid);

	// Buscar qualquer proposta pendente de targetId para authorId
	const pending = await database.dbGet(
		dbName,
		`
		SELECT * FROM relacionamentos 
		WHERE group_id = ? 
		  AND user1 = ? AND user2 = ? 
		  AND status = 'pendente'
		`,
		[groupId, targetId, authorId]
	);

	if (!pending) {
		return new ReturnMessage({
			chatId,
			content: `❌ Não há nenhum pedido pendente de ${getMentionStr(targetJid)} para você! 🧐`,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin,
				mentions: [targetJid]
			}
		});
	}

	// Deletar a proposta pendente
	await database.dbRun(
		dbName,
		`
		DELETE FROM relacionamentos WHERE id = ?
		`,
		[pending.id]
	);

	let contentText = "";
	const u1Jid = pending.user1_jid;
	const u2Jid = pending.user2_jid;

	if (pending.tipo === "namoro") {
		contentText = `💔 *PEDIDO RECUSADO!* ${getMentionStr(u2Jid)} recusou o pedido de namoro de ${getMentionStr(u1Jid)}! O coração foi partido em pedacinhos... 😭`;
	} else if (pending.tipo === "casamento") {
		contentText = `💔 *PEDIDO RECUSADO!* ${getMentionStr(u2Jid)} deixou ${getMentionStr(u1Jid)} esperando no altar e recusou o casamento! 👰🤵💥`;
	} else if (pending.tipo === "separar") {
		contentText = `❤️ *SEPARAÇÃO RECUSADA!* ${getMentionStr(u2Jid)} não aceitou se separar de ${getMentionStr(u1Jid)}! Ainda existe esperança para o amor de vocês! 🥰`;
	} else {
		contentText = `💔 *RECUSADO!* ${getMentionStr(u2Jid)} recusou o pedido de ${pending.tipo} de ${getMentionStr(u1Jid)}.`;
	}

	return new ReturnMessage({
		chatId,
		content: contentText,
		options: {
			quotedMessageId: message.origin.id._serialized,
			goReply: message.origin,
			mentions: [u1Jid, u2Jid]
		}
	});
}

const COISAR_FRASES = [
	"🔥 Eita! {autor} e {pessoa} foram vistos saindo de um motel de beira de estrada com cara de sapecas! 😏",
	"🛏️ O colchão rangeu! {autor} e {pessoa} coisaram gostoso hoje! 😳",
	"🔥 Que calor! {autor} e {pessoa} deram aquela coisada violenta nos bastidores do grupo! 🤫",
	"❤️ Amor está no ar (e outras coisas mais)! {autor} coisou com {pessoa} atrás da moita! 🌿",
	"💥 PÁ! {autor} e {pessoa} fizeram o terremoto acontecer na cama! 🥵",
	"🍿 Assistindo de camarote: {autor} coisou com {pessoa} com direito a performance! 🎭",
	"🐱 Huumm... {autor} coisou com {pessoa} e saíram miando! 🐈",
	"🍩 Com direito a cobertura: {autor} e {pessoa} coisaram bem doce hoje! 🤤",
	"⚡ Sintonia elétrica! {autor} coisou com {pessoa} e saíram faíscas para todo lado! 🔋"
];

async function coisarCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	// Só funciona em grupo
	if (!message.group) {
		return new ReturnMessage({
			chatId,
			content: "❌ Este comando só funciona em grupos! 👥",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}

	const groupId = message.group;
	const authorJid = getSenderJid(message);
	const authorId = getCleanNumber(authorJid);

	// Pegar mentions
	const mentions = message.mentions ?? message.origin?.mentionedIds ?? [];
	let targetJid = mentions.length > 0 ? mentions[0] : null;
	let targetId = targetJid ? getCleanNumber(targetJid) : null;

	let rel = null;

	if (targetId) {
		if (targetId === authorId) {
			return new ReturnMessage({
				chatId,
				content: "❌ Coisar consigo mesmo(a) é solitário demais! Chame seu parceiro(a). 😉",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		// Verificar se estão namorando ou casados
		rel = await database.dbGet(
			dbName,
			`
			SELECT * FROM relacionamentos 
			WHERE group_id = ? 
			  AND ((user1 = ? AND user2 = ?) OR (user1 = ? AND user2 = ?))
			  AND status = 'ativo'
			  AND tipo IN ('namoro', 'casamento')
			`,
			[groupId, authorId, targetId, targetId, authorId]
		);

		if (!rel) {
			return new ReturnMessage({
				chatId,
				content: `❌ Ops! Você só pode coisar com quem você está namorando ou casado! ${getMentionStr(targetJid)} não tem nada sério com você. 😳`,
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin,
					mentions: [targetJid]
				}
			});
		}
	} else {
		// Pegar algum relacionamento aleatório atual do autor
		const activeRels = await database.dbAll(
			dbName,
			`
			SELECT * FROM relacionamentos 
			WHERE group_id = ? 
			  AND (user1 = ? OR user2 = ?)
			  AND status = 'ativo'
			  AND tipo IN ('namoro', 'casamento')
			`,
			[groupId, authorId, authorId]
		);

		if (!activeRels || activeRels.length === 0) {
			return new ReturnMessage({
				chatId,
				content:
					"❌ Você não está em nenhum relacionamento neste grupo para coisar! Vá namorar ou casar primeiro! 😉",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		// Escolhe um aleatório
		rel = activeRels[Math.floor(Math.random() * activeRels.length)];
		targetId = rel.user1 === authorId ? rel.user2 : rel.user1;
		targetJid = rel.user1 === authorId ? rel.user2_jid : rel.user1_jid;
	}

	// Incrementar coisas_count
	await database.dbRun(
		dbName,
		`
		UPDATE relacionamentos 
		SET coisas_count = coisas_count + 1 
		WHERE id = ?
		`,
		[rel.id]
	);

	// Usar os JIDs corretos da DB se disponíveis, senão os resolvidos
	const u1Jid = rel.user1_jid || authorJid;
	const u2Jid = rel.user2_jid || targetJid;

	const displayAuthorJid = getCleanNumber(u1Jid) === authorId ? u1Jid : u2Jid;
	const displayTargetJid = getCleanNumber(u1Jid) === targetId ? u1Jid : u2Jid;

	const randomFrase = COISAR_FRASES[Math.floor(Math.random() * COISAR_FRASES.length)];
	const formattedFrase = randomFrase
		.replace("{autor}", getMentionStr(displayAuthorJid))
		.replace("{pessoa}", getMentionStr(displayTargetJid));

	return new ReturnMessage({
		chatId,
		content: formattedFrase,
		options: {
			quotedMessageId: message.origin.id._serialized,
			goReply: message.origin,
			mentions: [displayAuthorJid, displayTargetJid]
		}
	});
}

const TRAIR_FRASES = [
	"😱 *ESCÂNDALO!* {autor} foi flagrado(a) traindo {conjugue} com {pessoa}! O amor não vale nada mesmo... 💔",
	"🔥 *BABADO NO GRUPO!* {autor} deu uma escapadinha com {pessoa} pelas costas de {conjugue}! 🤫",
	"🕵️‍♂️ *FLAGRANTE!* {conjugue} pegou {autor} no colo de {pessoa}! O clima esquentou! 🍿",
	"💔 Que audácia! {autor} traiu a confiança de {conjugue} nos braços de {pessoa}! 💋",
	"🚨 *ALERTA CORNO!* {conjugue} acaba de ganhar um par de chifres novinho 🐂 porque {autor} coisou escondido com {pessoa}! 😭",
	"🫣 *PULO DA CERCA!* {autor} resolveu diversificar e traiu {conjugue} com {pessoa}! 🙊",
	"🤐 *SEGREDO REVELADO!* A casa caiu para {autor}, que andava de romance com {pessoa} ignorando {conjugue}! 🪓"
];

async function trairCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	// Só funciona em grupo
	if (!message.group) {
		return new ReturnMessage({
			chatId,
			content: "❌ Este comando só funciona em grupos! 👥",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}

	const groupId = message.group;
	const authorJid = getSenderJid(message);
	const authorId = getCleanNumber(authorJid);

	// Verificar se o autor tem algum relacionamento ativo (namoro ou casamento)
	const activeRels = await database.dbAll(
		dbName,
		`
		SELECT * FROM relacionamentos 
		WHERE group_id = ? 
		  AND (user1 = ? OR user2 = ?)
		  AND status = 'ativo'
		  AND tipo IN ('namoro', 'casamento')
		`,
		[groupId, authorId, authorId]
	);

	if (!activeRels || activeRels.length === 0) {
		return new ReturnMessage({
			chatId,
			content: "❌ Você não pode trair ninguém se não estiver namorando nem casado(a)! 😉",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}

	const partnersJids = activeRels.map((r) => (r.user1 === authorId ? r.user2_jid : r.user1_jid));
	const partnersIds = activeRels.map((r) => (r.user1 === authorId ? r.user2 : r.user1));

	// Determinar a pessoa com quem traiu
	const mentions = message.mentions ?? message.origin?.mentionedIds ?? [];
	let targetJid = mentions.length > 0 ? mentions[0] : null;
	let targetId = targetJid ? getCleanNumber(targetJid) : null;

	if (targetId) {
		if (targetId === authorId) {
			return new ReturnMessage({
				chatId,
				content: "❌ Você não pode se trair consigo mesmo(a)! 🤔",
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		if (partnersIds.includes(targetId)) {
			return new ReturnMessage({
				chatId,
				content: `❌ Ué? Como você vai trair seu parceiro(a) com ele(a) mesmo(a)? Isso é só amor! 🥰`,
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin,
					mentions: [targetJid]
				}
			});
		}
	} else {
		// Selecionar um membro aleatório do grupo
		try {
			const chat = await bot.client.getChatById(groupId);
			const participants = chat.participants || [];
			const botId = bot.client.info.wid._serialized;

			// Excluir autor, parceiros e o bot
			const candidates = participants.filter((p) => {
				const jid = p.id._serialized;
				const cleanJid = getCleanNumber(jid);
				return cleanJid !== authorId && jid !== botId && !partnersIds.includes(cleanJid);
			});

			if (candidates.length > 0) {
				const randomParticipant = candidates[Math.floor(Math.random() * candidates.length)];
				targetJid = randomParticipant.id._serialized;
				targetId = getCleanNumber(targetJid);
			}
		} catch (err) {
			logger.error("Erro ao selecionar membro aleatório para trair:", err);
		}
	}

	// Incrementar traicoes_count em todos os relacionamentos ativos do autor
	await database.dbRun(
		dbName,
		`
		UPDATE relacionamentos 
		SET traicoes_count = traicoes_count + 1 
		WHERE group_id = ? 
		  AND (user1 = ? OR user2 = ?)
		  AND status = 'ativo'
		  AND tipo IN ('namoro', 'casamento')
		`,
		[groupId, authorId, authorId]
	);

	// Montar string dos cônjuges traídos
	const conjuguesStr = partnersJids.map((p) => getMentionStr(p)).join(", ");

	// Montar a frase de traição
	const randomFrase = TRAIR_FRASES[Math.floor(Math.random() * TRAIR_FRASES.length)];

	let targetStr = "";
	const mentionsList = [authorJid, ...partnersJids];

	if (targetJid) {
		targetStr = getMentionStr(targetJid);
		mentionsList.push(targetJid);
	} else {
		targetStr = "um(a) amante misterioso(a) 🕵️‍♂️";
	}

	const formattedFrase = randomFrase
		.replace("{autor}", getMentionStr(authorJid))
		.replace("{conjugue}", conjuguesStr)
		.replace("{pessoa}", targetStr);

	return new ReturnMessage({
		chatId,
		content: formattedFrase,
		options: {
			quotedMessageId: message.origin.id._serialized,
			goReply: message.origin,
			mentions: mentionsList
		}
	});
}

async function relacionamentoCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	// Só funciona em grupo
	if (!message.group) {
		return new ReturnMessage({
			chatId,
			content: "❌ Este comando só funciona em grupos! 👥",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}

	const groupId = message.group;
	const authorJid = getSenderJid(message);
	const authorId = getCleanNumber(authorJid);

	// Obter relacionamentos (ativos e inativos/terminados) do autor
	const rels = await database.dbAll(
		dbName,
		`
		SELECT * FROM relacionamentos 
		WHERE group_id = ? 
		  AND (user1 = ? OR user2 = ?)
		  AND tipo IN ('namoro', 'casamento')
		ORDER BY status ASC, criado_em DESC
		`,
		[groupId, authorId, authorId]
	);

	if (!rels || rels.length === 0) {
		return new ReturnMessage({
			chatId,
			content: `💔 ${getMentionStr(authorJid)}, você não tem nenhum relacionamento registrado neste grupo! Que tal tentar *!namorar* alguém? 😉`,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin,
				mentions: [authorJid]
			}
		});
	}

	let responseText = `📊 *HISTÓRICO DE RELACIONAMENTOS* 📊\n\n👤 Perfil: ${getMentionStr(authorJid)}\n\n`;
	const mentionsList = [authorJid];

	rels.forEach((rel, index) => {
		const partnerJid = rel.user1 === authorId ? rel.user2_jid : rel.user1_jid;
		mentionsList.push(partnerJid);

		const typeStr = rel.tipo === "casamento" ? "💍 Casamento" : "💖 Namoro";
		const statusStr = rel.status === "ativo" ? "✅ Ativo" : "💔 Terminado";

		let durationStr = "";
		if (rel.status === "ativo") {
			durationStr = formatDuration(Date.now() - rel.criado_em);
		} else if (rel.terminado_em) {
			durationStr = formatDuration(rel.terminado_em - rel.criado_em);
		} else {
			durationStr = "Sem registro";
		}

		responseText += `${index + 1}. *Parceiro(a):* ${getMentionStr(partnerJid)}\n`;
		responseText += `   *Tipo:* ${typeStr}\n`;
		responseText += `   *Status:* ${statusStr}\n`;
		responseText += `   *Duração:* ${durationStr}\n`;
		responseText += `   *Coisaram:* ${rel.coisas_count} vez(es) 🔥\n`;
		responseText += `   *Traições:* ${rel.traicoes_count} vez(es) 😈\n\n`;
	});

	responseText += `Use bastante amor (ou safadeza) no grupo! 😉`;

	return new ReturnMessage({
		chatId,
		content: responseText,
		options: {
			quotedMessageId: message.origin.id._serialized,
			goReply: message.origin,
			mentions: mentionsList
		}
	});
}

async function relacionamentosCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	// Só funciona em grupo
	if (!message.group) {
		return new ReturnMessage({
			chatId,
			content: "❌ Este comando só funciona em grupos! 👥",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}

	const groupId = message.group;

	// Obter todos os relacionamentos (namoro/casamento) do grupo
	const allRels = await database.dbAll(
		dbName,
		`
		SELECT * FROM relacionamentos 
		WHERE group_id = ? 
		  AND tipo IN ('namoro', 'casamento')
		ORDER BY status ASC, criado_em DESC
		`,
		[groupId]
	);

	if (!allRels || allRels.length === 0) {
		return new ReturnMessage({
			chatId,
			content:
				"💔 Nenhum relacionamento foi registrado neste grupo ainda! Sejam os pioneiros pedindo alguém em namoro! 😉",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}

	// Filtrar os ativos e terminados
	const activeRels = allRels.filter((r) => r.status === "ativo");
	const terminatedRels = allRels.filter((r) => r.status === "terminado");

	const activeNamoros = activeRels.filter((r) => r.tipo === "namoro").length;
	const activeCasamentos = activeRels.filter((r) => r.tipo === "casamento").length;
	const totalTerminados = terminatedRels.length;

	let totalCoisadas = 0;
	let totalTraicoes = 0;

	let mostActiveRel = null;
	let mostBetrayedRel = null;

	allRels.forEach((rel) => {
		totalCoisadas += rel.coisas_count;
		totalTraicoes += rel.traicoes_count;

		if (!mostActiveRel || rel.coisas_count > mostActiveRel.coisas_count) {
			mostActiveRel = rel;
		}
		if (!mostBetrayedRel || rel.traicoes_count > mostBetrayedRel.traicoes_count) {
			mostBetrayedRel = rel;
		}
	});

	let responseText = `👥 *RELACIONAMENTOS DO GRUPO* 👥\n\n`;
	const mentionsList = [];

	if (activeRels.length > 0) {
		responseText += `*Relacionamentos Ativos:* \n`;
		activeRels.forEach((rel, index) => {
			const typeEmoji = rel.tipo === "casamento" ? "💍" : "💖";
			responseText += `${index + 1}. ${getMentionStr(rel.user1_jid)} ${typeEmoji} ${getMentionStr(rel.user2_jid)} (Duração: ${formatDuration(Date.now() - rel.criado_em)})\n`;
			if (!mentionsList.includes(rel.user1_jid)) mentionsList.push(rel.user1_jid);
			if (!mentionsList.includes(rel.user2_jid)) mentionsList.push(rel.user2_jid);
		});
		responseText += `\n`;
	} else {
		responseText += `Não há relacionamentos ativos neste momento. 💔\n\n`;
	}

	responseText += `📊 *RESUMO GERAL* 📊\n`;
	responseText += `• 💖 Namoros Ativos: ${activeNamoros}\n`;
	responseText += `• 💍 Casamentos Ativos: ${activeCasamentos}\n`;
	responseText += `• 💔 Relacionamentos Terminados: ${totalTerminados}\n`;
	responseText += `• 🔥 Total de Coisadas: ${totalCoisadas}\n`;
	responseText += `• 😈 Total de Traições: ${totalTraicoes}\n\n`;

	if (mostActiveRel && mostActiveRel.coisas_count > 0) {
		responseText += `👑 *Casal Safado:* ${getMentionStr(mostActiveRel.user1_jid)} & ${getMentionStr(mostActiveRel.user2_jid)} coisaram ${mostActiveRel.coisas_count} vez(es)! 🔥\n`;
		if (!mentionsList.includes(mostActiveRel.user1_jid)) mentionsList.push(mostActiveRel.user1_jid);
		if (!mentionsList.includes(mostActiveRel.user2_jid)) mentionsList.push(mostActiveRel.user2_jid);
	}

	if (mostBetrayedRel && mostBetrayedRel.traicoes_count > 0) {
		responseText += `🐂 *Casal Mais Traído:* ${getMentionStr(mostBetrayedRel.user1_jid)} & ${getMentionStr(mostBetrayedRel.user2_jid)} teve ${mostBetrayedRel.traicoes_count} traição(ões)! 😱\n`;
		if (!mentionsList.includes(mostBetrayedRel.user1_jid))
			mentionsList.push(mostBetrayedRel.user1_jid);
		if (!mentionsList.includes(mostBetrayedRel.user2_jid))
			mentionsList.push(mostBetrayedRel.user2_jid);
	}

	return new ReturnMessage({
		chatId,
		content: responseText,
		options: {
			quotedMessageId: message.origin.id._serialized,
			goReply: message.origin,
			mentions: mentionsList
		}
	});
}

// Configura e exporta os comandos
const commands = [
	new Command({
		name: "namorar",
		description: "Pede em namoro ou aceita pedido de namoro",
		category: "diversao",
		reactions: {
			after: "💖"
		},
		method: namorarCommand
	}),
	new Command({
		name: "casar",
		description: "Pede em casamento ou aceita pedido de casamento",
		category: "diversao",
		reactions: {
			after: "💍"
		},
		method: casarCommand
	}),
	new Command({
		name: "separar",
		description: "Pede separação ou aceita pedido de separação",
		category: "diversao",
		reactions: {
			after: "💔"
		},
		method: separarCommand
	}),
	new Command({
		name: "recusar",
		description: "Recusa um pedido de namoro, casamento ou separação",
		category: "diversao",
		reactions: {
			after: "💔"
		},
		method: recusarCommand
	}),
	new Command({
		name: "coisar",
		description: "Coisa com a pessoa marcada ou com parceiro aleatório",
		category: "diversao",
		reactions: {
			after: "🔥"
		},
		method: coisarCommand
	}),
	new Command({
		name: "trair",
		description: "Trai parceiro(s) com a pessoa marcada ou membro aleatório",
		category: "diversao",
		reactions: {
			after: "😈"
		},
		method: trairCommand
	}),
	new Command({
		name: "relacionamento",
		description: "Exibe o histórico de relacionamentos do autor",
		category: "diversao",
		reactions: {
			after: "📊"
		},
		method: relacionamentoCommand
	}),
	new Command({
		name: "relacionamentos",
		description: "Exibe todos os relacionamentos e estatísticas do grupo",
		category: "diversao",
		reactions: {
			after: "📊"
		},
		method: relacionamentosCommand
	})
];

module.exports = { commands };
