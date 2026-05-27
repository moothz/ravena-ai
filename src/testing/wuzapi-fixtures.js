/**
 * wuzapi-fixtures.js
 *
 * Fixtures realistas de webhooks do wuzapi para testar a camada de tradução
 * de eventos (WuzapiEventHandler).
 *
 * Formato: WEBHOOK_FORMAT=json conforme wuzapi.
 * Cada fixture representa um payload POST recebido em /webhook/wuzapi.
 */

// =============================================================================
// HELPERS
// =============================================================================

/** Gera uma chave de mensagem simulada */
function makeKey(fromMe, id, participant, remoteJid) {
	return {
		fromMe,
		id,
		remoteJid,
		participant
	};
}

/** Gera um timestamp em milissegundos */
function nowMs() {
	return Date.now();
}

// =============================================================================
// FIXTURES — Mensagens
// =============================================================================

/**
 * Mensagem de texto simples (grupo)
 * Simula: usuário envia "!ping" em grupo
 */
const messageTextGroup = {
	type: "Message",
	token: "bot-user-token-1",
	event: {
		remoteJid: "120363023456789012@g.us",
		fromMe: false,
		message: {
			extendedTextMessage: {
				text: "!ping",
				key: makeKey(true, "msg-id-ref", "120363023456789012@g.us", null)
			}
		},
		messageTimestamp: nowMs(),
		participant: "5511999999999@s.whatsapp.net",
		pushName: "Testador"
	}
};

/**
 * Mensagem de texto simples (privado)
 * Simula: usuário envia "!help" no PV do bot
 */
const messageTextPrivate = {
	type: "Message",
	token: "bot-user-token-1",
	event: {
		remoteJid: "5511999999999@s.whatsapp.net",
		fromMe: false,
		message: {
			extendedTextMessage: {
				text: "!help"
			}
		},
		messageTimestamp: nowMs(),
		participant: "5511888888888@s.whatsapp.net",
		pushName: "Privado User"
	}
};

/**
 * Mensagem de imagem (grupo) — com base64
 * Simula: usuário envia foto com legenda "!s"
 */
const messageImageWithBase64 = {
	type: "Message",
	token: "bot-user-token-1",
	event: {
		remoteJid: "120363023456789012@g.us",
		fromMe: false,
		message: {
			imageMessage: {
				caption: "!s",
				mimetype: "image/png",
				fileSha256: "abc123def456",
				fileLength: 102400,
				height: 1080,
				width: 1920,
				base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
				url: "https://mmg.whatsapp.net/o1/v/t62.7118-24/12345_67890.jpg"
			}
		},
		messageTimestamp: nowMs(),
		participant: "5511999999999@s.whatsapp.net",
		pushName: "Testador"
	}
};

/**
 * Mensagem de imagem (grupo) — com S3 URL
 * Simula: wuzapi envia URL S3 ao invés de base64 (modo "both")
 */
const messageImageWithS3 = {
	type: "Message",
	token: "bot-user-token-1",
	event: {
		remoteJid: "120363023456789012@g.us",
		fromMe: false,
		message: {
			imageMessage: {
				caption: "!meme Topo:Teste|Baixo:Ravena",
				mimetype: "image/jpeg",
				fileSha256: "xyz789abc012",
				fileLength: 204800,
				height: 720,
				width: 1280,
				url: "https://s3.wuzapi.local/media/abc123.jpg",
				directPath: "/o1/v/t62.7118-24/12345_67890.jpg"
			}
		},
		messageTimestamp: nowMs(),
		participant: "5511999999999@s.whatsapp.net",
		pushName: "Testador"
	}
};

/**
 * Mensagem de áudio (grupo)
 * Simula: usuário envia nota de voz com legenda "!s"
 */
const messageAudio = {
	type: "Message",
	token: "bot-user-token-1",
	event: {
		remoteJid: "120363023456789012@g.us",
		fromMe: false,
		message: {
			audioMessage: {
				mimetype: "audio/ogg; codecs=opus",
				fileSha256: "audio-sha256",
				fileLength: 50000,
				seconds: 5,
				base64: "T2dnUwAAAAAAAAAAB3dlYmNhbXAAAAAQAAAA",
				ptt: true
			}
		},
		messageTimestamp: nowMs(),
		participant: "5511999999999@s.whatsapp.net",
		pushName: "Testador"
	}
};

/**
 * Mensagem com quoted (resposta)
 * Simula: usuário responde a uma mensagem com "!resumo"
 */
const messageWithQuoted = {
	type: "Message",
	token: "bot-user-token-1",
	event: {
		remoteJid: "120363023456789012@g.us",
		fromMe: false,
		message: {
			extendedTextMessage: {
				text: "!resumo",
				contextInfo: {
					stanzaId: "quoted-msg-id",
					remoteJid: "120363023456789012@g.us",
					participant: "5511999999999@s.whatsapp.net",
					quotedMessage: {
						extendedTextMessage: {
							text: "O rato roeu a roupa do rei de Roma. O rei ficou muito bravo."
						}
					}
				}
			}
		},
		messageTimestamp: nowMs(),
		participant: "5511999999999@s.whatsapp.net",
		pushName: "Testador"
	}
};

/**
 * Mensagem de vídeo (grupo)
 */
const messageVideo = {
	type: "Message",
	token: "bot-user-token-1",
	event: {
		remoteJid: "120363023456789012@g.us",
		fromMe: false,
		message: {
			videoMessage: {
				caption: "!yt teste",
				mimetype: "video/mp4",
				fileSha256: "video-sha256",
				fileLength: 5000000,
				seconds: 30,
				base64: "video-base64-data",
				width: 1920,
				height: 1080
			}
		},
		messageTimestamp: nowMs(),
		participant: "5511999999999@s.whatsapp.net",
		pushName: "Testador"
	}
};

/**
 * Mensagem de documento (grupo)
 */
const messageDocument = {
	type: "Message",
	token: "bot-user-token-1",
	event: {
		remoteJid: "120363023456789012@g.us",
		fromMe: false,
		message: {
			documentMessage: {
				title: "documento.pdf",
				mimetype: "application/pdf",
				fileSha256: "doc-sha256",
				fileLength: 150000,
				base64: "doc-base64-data"
			}
		},
		messageTimestamp: nowMs(),
		participant: "5511999999999@s.whatsapp.net",
		pushName: "Testador"
	}
};

/**
 * Mensagem de sticker
 */
const messageSticker = {
	type: "Message",
	token: "bot-user-token-1",
	event: {
		remoteJid: "120363023456789012@g.us",
		fromMe: false,
		message: {
			stickerMessage: {
				mimetype: "image/webp",
				fileSha256: "sticker-sha256",
				fileLength: 25000,
				base64: "sticker-base64-data",
				animated: false,
				width: 512,
				height: 512
			}
		},
		messageTimestamp: nowMs(),
		participant: "5511999999999@s.whatsapp.net",
		pushName: "Testador"
	}
};

// =============================================================================
// FIXTURES — Eventos de conexão
// =============================================================================

/**
 * Evento Connected — bot conectado com sucesso
 */
const connected = {
	type: "Connected",
	token: "bot-user-token-1",
	event: {
		userJid: "5511999999999@s.whatsapp.net",
		status: "connected"
	}
};

/**
 * Evento Disconnected — bot desconectado
 */
const disconnected = {
	type: "Disconnected",
	token: "bot-user-token-1",
	event: {
		userJid: "5511999999999@s.whatsapp.net",
		status: "disconnected",
		reason: "user_logged_out"
	}
};

/**
 * Evento QR — código QR disponível para leitura
 */
const qrCode = {
	type: "QR",
	token: "bot-user-token-1",
	event: {
		relay: "2",
		code: "2@ABCDEFGHIJKLMNOPQRSTUVWXYabcdefghijklmnopqrstuvw0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
		timestamp: nowMs()
	}
};

// =============================================================================
// FIXTURES — Eventos de grupo
// =============================================================================

/**
 * Evento GroupInfo — alterações no grupo
 */
const groupInfoChange = {
	type: "GroupInfo",
	token: "bot-user-token-1",
	event: {
		id: "120363023456789012@g.us",
		author: "5511999999999@s.whatsapp.net",
		changes: {
			subject: true,
			newSubject: "Novo Nome do Grupo"
		},
		timestamp: nowMs()
	}
};

/**
 * Evento JoinedGroup — bot entrou em um novo grupo
 */
const joinedGroup = {
	type: "JoinedGroup",
	token: "bot-user-token-1",
	event: {
		id: "120363099999999999@g.us",
		jid: "5511999999999@s.whatsapp.net",
		inviteCode: "ABCDEfghIJKL",
		timestamp: nowMs()
	}
};

/**
 * Evento ChatPresence — usuário digitando
 */
const chatPresence = {
	type: "ChatPresence",
	token: "bot-user-token-1",
	event: {
		remoteJid: "120363023456789012@g.us",
		participant: "5511999999999@s.whatsapp.net",
		presence: "composing"
	}
};

/**
 * Evento ReadReceipt — mensagem lida
 */
const readReceipt = {
	type: "ReadReceipt",
	token: "bot-user-token-1",
	event: {
		remoteJid: "120363023456789012@g.us",
		reader: "5511999999999@s.whatsapp.net",
		lastSeen: nowMs(),
		keys: [
			{
				fromMe: true,
				id: "msg-sent-id",
				remoteJid: "120363023456789012@g.us",
				participant: null
			}
		]
	}
};

// =============================================================================
// FIXTURES — Mensagem com reaction
// =============================================================================

/**
 * Mensagem de texto (para testar reação do bot)
 */
const messageForReaction = {
	type: "Message",
	token: "bot-user-token-1",
	event: {
		remoteJid: "120363023456789012@g.us",
		fromMe: false,
		message: {
			extendedTextMessage: {
				text: "Olá Ravena!"
			}
		},
		messageTimestamp: nowMs(),
		participant: "5511999999999@s.whatsapp.net",
		pushName: "Testador",
		key: makeKey(false, "msg-for-reaction", "120363023456789012@g.us", "5511999999999@s.whatsapp.net")
	}
};

// =============================================================================
// FIXTURES — Mensagem com poll
// =============================================================================

/**
 * Mensagem de poll
 */
const messagePoll = {
	type: "Message",
	token: "bot-user-token-1",
	event: {
		remoteJid: "120363023456789012@g.us",
		fromMe: false,
		message: {
			pollCreationMessage: {
				name: "Qual a melhor linguagem?",
				options: [
					{ optionName: "JavaScript" },
					{ optionName: "Python" },
					{ optionName: "Go" }
				],
				shippingOptionCount: 0,
				allowMultipleAnswers: false
			}
		},
		messageTimestamp: nowMs(),
		participant: "5511999999999@s.whatsapp.net",
		pushName: "Testador"
	}
};

// =============================================================================
// FIXTURES — Mensagem de contato
// =============================================================================

/**
 * Mensagem de contato
 */
const messageContact = {
	type: "Message",
	token: "bot-user-token-1",
	event: {
		remoteJid: "120363023456789012@g.us",
		fromMe: false,
		message: {
			contactMessage: {
				displayName: "João Silva",
				vcard: "BEGIN:VCARD\nVERSION:3.0\nFN:João Silva\nTEL;TYPE=CELL:+5511999999999\nEND:VCARD"
			}
		},
		messageTimestamp: nowMs(),
		participant: "5511999999999@s.whatsapp.net",
		pushName: "Testador"
	}
};

// =============================================================================
// FIXTURES — Mensagem de localização
// =============================================================================

/**
 * Mensagem de localização
 */
const messageLocation = {
	type: "Message",
	token: "bot-user-token-1",
	event: {
		remoteJid: "120363023456789012@g.us",
		fromMe: false,
		message: {
			locationMessage: {
				degreesLatitude: -23.5505,
				degreesLongitude: -46.6333,
				name: "São Paulo",
				address: "São Paulo, SP, Brasil"
			}
		},
		messageTimestamp: nowMs(),
		participant: "5511999999999@s.whatsapp.net",
		pushName: "Testador"
	}
};

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
	// Mensagens
	messageTextGroup,
	messageTextPrivate,
	messageImageWithBase64,
	messageImageWithS3,
	messageAudio,
	messageWithQuoted,
	messageVideo,
	messageDocument,
	messageSticker,
	messageForReaction,
	messagePoll,
	messageContact,
	messageLocation,

	// Conexão
	connected,
	disconnected,
	qrCode,

	// Grupo
	groupInfoChange,
	joinedGroup,
	chatPresence,
	readReceipt
};