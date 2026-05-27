/**
 * FakeWuzapiClient.js
 *
 * Mock client that simulates wuzapi API responses without a real server.
 * Used in testing to exercise wuzapi code paths without network dependency.
 *
 * Supports:
 * - Predefined responses for all wuzapi endpoints
 * - "record/replay" mode: record real wuzapi responses, replay in tests
 * - Configurable error modes for testing error handling
 */

class FakeWuzapiClient {
	constructor(options = {}) {
		this.baseURL = options.baseURL || "http://localhost:3000";
		this.userToken = options.userToken || "test-token";
		this.userName = options.userName || "test-bot";
		this.adminToken = options.adminToken || "admin-token";

		// Error mode: 'none' | 'random' | 'always' | { [endpoint]: true }
		this.errorMode = options.errorMode || "none";
		this.customErrors = options.customErrors || {};

		// Response delay in ms
		this.delay = options.delay || 0;

		// Recorded responses (record/replay mode)
		this.recorded = {};
		this.recording = false;

		// State tracking
		this.state = {
			connected: false,
			phoneNumber: "5511999999999",
			pushName: "Ravena Bot",
			users: new Map(),
			groups: [],
			messages: [],
			presence: {}
		};

		// Pre-populate default user
		this.state.users.set(this.userToken, {
			id: this.userName,
			token: this.userToken,
			phoneNumber: this.state.phoneNumber
		});

		// Pre-populate a default group
		this.state.groups.push({
			id: "120363023456789012@g.us",
			name: "Grupo de Teste",
			owner: "5511999999999@s.whatsapp.net",
			participants: [
				{ jid: "5511999999999@s.whatsapp.net", admin: true },
				{ jid: "5511988888888@s.whatsapp.net", admin: false }
			],
			subject: "Grupo de Teste",
			creation: Date.now()
		});
	}

	/**
	 * Simulate a request with optional delay and error injection
	 */
	async _simulate(method, endpoint, body = null) {
		// Check error mode
		if (this._shouldFail(endpoint)) {
			throw new Error(`[FakeWuzapiClient] Simulated failure: ${method} ${endpoint}`);
		}

		// Record mode
		if (this.recording) {
			const key = `${method}:${endpoint}`;
			if (!this.recorded[key]) this.recorded[key] = [];
			this.recorded[key].push({ body, response: null });
		}

		// Apply delay
		if (this.delay > 0) {
			await new Promise((r) => setTimeout(r, this.delay));
		}

		return this._route(method, endpoint, body);
	}

	/**
	 * Route to the appropriate handler
	 */
	async _route(method, endpoint, body) {
		// Session endpoints
		if (endpoint === "/session/status" && method === "GET") {
			return this._sessionStatus();
		}
		if (endpoint === "/session/connect" && method === "POST") {
			return this._sessionConnect(body);
		}
		if (endpoint === "/session/qr" && method === "GET") {
			return this._sessionQR();
		}
		if (endpoint === "/session/logout" && method === "POST") {
			return this._sessionLogout();
		}
		if (endpoint === "/session/pairphone" && method === "POST") {
			return this._sessionPairphone(body);
		}
		if (endpoint === "/session/disconnect" && method === "POST") {
			return this._sessionDisconnect();
		}

		// Chat endpoints
		if (endpoint === "/chat/send/text" && method === "POST") {
			return this._sendText(body);
		}
		if (endpoint === "/chat/send/image" && method === "POST") {
			return this._sendMedia(body, "image");
		}
		if (endpoint === "/chat/send/video" && method === "POST") {
			return this._sendMedia(body, "video");
		}
		if (endpoint === "/chat/send/audio" && method === "POST") {
			return this._sendMedia(body, "audio");
		}
		if (endpoint === "/chat/send/document" && method === "POST") {
			return this._sendMedia(body, "document");
		}
		if (endpoint === "/chat/send/sticker" && method === "POST") {
			return this._sendSticker(body);
		}
		if (endpoint === "/chat/send/poll" && method === "POST") {
			return this._sendPoll(body);
		}
		if (endpoint === "/chat/send/location" && method === "POST") {
			return this._sendLocation(body);
		}
		if (endpoint === "/chat/send/contact" && method === "POST") {
			return this._sendContact(body);
		}
		if (endpoint === "/chat/react" && method === "POST") {
			return this._react(body);
		}
		if (endpoint === "/chat/delete" && method === "POST") {
			return this._deleteMessage(body);
		}
		if (endpoint === "/chat/markread" && method === "POST") {
			return this._markRead(body);
		}
		if (endpoint === "/chat/presence" && method === "POST") {
			return this._setPresence(body);
		}

		// Download endpoints
		if (endpoint.startsWith("/chat/download") && method === "POST") {
			return this._downloadMedia(body, endpoint);
		}

		// User endpoints
		if (endpoint === "/user/info" && method === "POST") {
			return this._userInfo(body);
		}
		if (endpoint === "/user/avatar" && method === "POST") {
			return this._userAvatar(body);
		}
		if (endpoint === "/user/contacts" && method === "GET") {
			return this._userContacts();
		}
		if (endpoint === "/status/set/text" && method === "POST") {
			return this._setStatusText(body);
		}

		// Group endpoints
		if (endpoint === "/group/list" && method === "GET") {
			return this._groupList();
		}
		if (endpoint === "/group/info" && method === "GET") {
			return this._groupInfo(body);
		}
		if (endpoint === "/group/leave" && method === "POST") {
			return this._groupLeave(body);
		}
		if (endpoint === "/group/join" && method === "POST") {
			return this._groupJoin(body);
		}
		if (endpoint === "/group/inviteinfo" && method === "POST") {
			return this._groupInviteInfo(body);
		}
		if (endpoint === "/group/name" && method === "POST") {
			return this._groupName(body);
		}
		if (endpoint === "/group/photo" && method === "POST") {
			return this._groupPhoto(body);
		}
		if (endpoint === "/group/updateparticipants" && method === "POST") {
			return this._groupUpdateParticipants(body);
		}
		if (endpoint === "/group/invitelink" && method === "POST") {
			return this._groupInviteLink(body);
		}
		if (endpoint === "/group/topic" && method === "POST") {
			return this._groupTopic(body);
		}
		if (endpoint === "/group/announce" && method === "POST") {
			return this._groupAnnounce(body);
		}
		if (endpoint === "/group/locked" && method === "POST") {
			return this._groupLocked(body);
		}
		if (endpoint === "/group/ephemeral" && method === "POST") {
			return this._groupEphemeral(body);
		}
		if (endpoint === "/group/create" && method === "POST") {
			return this._groupCreate(body);
		}

		// Admin endpoints
		if (endpoint === "/admin/users" && method === "GET") {
			return this._adminListUsers();
		}
		if (endpoint === "/admin/users" && method === "POST") {
			return this._adminCreateUser(body);
		}
		if (endpoint.startsWith("/admin/users/") && method === "DELETE") {
			return this._adminDeleteUser(endpoint);
		}

		// Health
		if (endpoint === "/health" && method === "GET") {
			return this._health();
		}

		// Webhook
		if (endpoint === "/webhook" && method === "POST") {
			return this._setWebhook(body);
		}
		if (endpoint === "/webhook" && method === "GET") {
			return this._getWebhook();
		}

		// Fallback
		return { success: false, error: `No handler for ${method} ${endpoint}` };
	}

	// ─── Session ───────────────────────────────────────────────────────

	_sessionStatus() {
		return {
			data: {
				connected: this.state.connected,
				phoneNumber: this.state.phoneNumber,
				pushName: this.state.pushName
			}
		};
	}

	_sessionConnect(body) {
		this.state.connected = true;
		return { data: { connected: true, phoneNumber: this.state.phoneNumber } };
	}

	_sessionQR() {
		if (this.state.connected) {
			return { data: null }; // No QR needed
		}
		return {
			data: {
				qr: "data:image/png;base64,fake-qr-code-data",
				count: 1
			}
		};
	}

	_sessionLogout() {
		this.state.connected = false;
		return { data: { loggedOut: true } };
	}

	_sessionPairphone(body) {
		return { data: { paired: true, phoneNumber: body?.phone || "5511999999999" } };
	}

	_sessionDisconnect() {
		this.state.connected = false;
		return { data: { disconnected: true } };
	}

	// ─── Chat ──────────────────────────────────────────────────────────

	_sendText(body) {
		const msg = {
			id: `wuzapi-msg-${Date.now()}`,
			remoteJid: body.remoteJid,
			content: body.content,
			timestamp: Date.now(),
			fromMe: true
		};
		this.state.messages.push(msg);
		return { data: msg };
	}

	_sendMedia(body, type) {
		const msg = {
			id: `wuzapi-msg-${Date.now()}`,
			remoteJid: body.remoteJid,
			type,
			caption: body.options?.caption || "",
			filename: body.options?.filename || "file",
			base64: body.options?.base64 || "",
			url: `https://minio:9000/media/${Date.now()}.dat`,
			timestamp: Date.now(),
			fromMe: true
		};
		this.state.messages.push(msg);
		return { data: msg };
	}

	_sendSticker(body) {
		const msg = {
			id: `wuzapi-msg-${Date.now()}`,
			remoteJid: body.remoteJid,
			type: "sticker",
			base64: body.options?.base64 || "",
			url: `https://minio:9000/sticker/${Date.now()}.webp`,
			timestamp: Date.now(),
			fromMe: true
		};
		this.state.messages.push(msg);
		return { data: msg };
	}

	_sendPoll(body) {
		const msg = {
			id: `wuzapi-msg-${Date.now()}`,
			remoteJid: body.remoteJid,
			type: "poll",
			name: body.name,
			options: body.options?.options || [],
			timestamp: Date.now(),
			fromMe: true
		};
		this.state.messages.push(msg);
		return { data: msg };
	}

	_sendLocation(body) {
		const msg = {
			id: `wuzapi-msg-${Date.now()}`,
			remoteJid: body.remoteJid,
			type: "location",
			latitude: body.latitude,
			longitude: body.longitude,
			name: body.name,
			address: body.address,
			timestamp: Date.now(),
			fromMe: true
		};
		this.state.messages.push(msg);
		return { data: msg };
	}

	_sendContact(body) {
		const msg = {
			id: `wuzapi-msg-${Date.now()}`,
			remoteJid: body.remoteJid,
			type: "contact",
			contact: body.contact,
			timestamp: Date.now(),
			fromMe: true
		};
		this.state.messages.push(msg);
		return { data: msg };
	}

	_react(body) {
		return {
			data: {
				keyId: body.keyId,
				reaction: body.reaction,
				remoteJid: body.remoteJid
			}
		};
	}

	_deleteMessage(body) {
		return { data: { deleted: true, keyId: body.keyId } };
	}

	_markRead(body) {
		return { data: { markedRead: true, keys: body.keys } };
	}

	_setPresence(body) {
		this.state.presence[body.remoteJid] = body.state;
		return { data: { remoteJid: body.remoteJid, state: body.state } };
	}

	// ─── Download ──────────────────────────────────────────────────────

	_downloadMedia(body, endpoint) {
		const type = endpoint.replace("/chat/download", "");
		return {
			data: {
				base64: "fake-base64-media-data",
				filename: `downloaded-${type}.dat`,
				mimetype: `image/${type}`,
				url: `https://minio:9000/media/downloaded-${type}.dat`
			}
		};
	}

	// ─── User ──────────────────────────────────────────────────────────

	_userInfo(body) {
		const phones = body.phones || body.Phone || [];
		const results = phones.map((phone) => ({
			jid: `${phone}@s.whatsapp.net`,
			name: `User ${phone}`,
			status: "Hello!",
			picture: `https://pps.whatsapp.net/profile/${phone}`
		}));
		return { data: results };
	}

	_userAvatar(body) {
		return {
			data: {
				jid: body.jid,
				picture: `https://pps.whatsapp.net/profile/${body.jid}`,
				pictureId: "abc123"
			}
		};
	}

	_userContacts() {
		return {
			data: [
				{ jid: "5511988888888@s.whatsapp.net", name: "Contato 1" },
				{ jid: "5511977777777@s.whatsapp.net", name: "Contato 2" }
			]
		};
	}

	_setStatusText(body) {
		return { data: { status: body.text } };
	}

	// ─── Groups ────────────────────────────────────────────────────────

	_groupList() {
		return { data: { Groups: this.state.groups } };
	}

	_groupInfo(body) {
		const group = this.state.groups.find((g) => g.id === body?.remoteJid);
		return group ? { data: group } : { error: "Group not found" };
	}

	_groupLeave(body) {
		const idx = this.state.groups.findIndex((g) => g.id === body.remoteJid);
		if (idx !== -1) this.state.groups.splice(idx, 1);
		return { data: { left: true, remoteJid: body.remoteJid } };
	}

	_groupJoin(body) {
		return {
			data: {
				joined: true,
				inviteCode: body.inviteCode,
				groupId: `120363023456789013@g.us`
			}
		};
	}

	_groupInviteInfo(body) {
		return {
			data: {
				inviteCode: body.inviteCode,
				groupName: "Grupo Convidado",
				participants: 2,
				creation: Date.now()
			}
		};
	}

	_groupName(body) {
		const group = this.state.groups.find((g) => g.id === body.remoteJid);
		if (group) group.name = body.name;
		return { data: { name: body.name } };
	}

	_groupPhoto(body) {
		return { data: { photoSet: true, remoteJid: body.remoteJid } };
	}

	_groupUpdateParticipants(body) {
		const actions = ["add", "remove", "promote", "demote"];
		const action = body.action || actions[0];
		return {
			data: {
				action,
				participants: body.participants || [],
				remoteJid: body.remoteJid,
				results: (body.participants || []).map((p) => ({
					jid: p,
					success: true
				}))
			}
		};
	}

	_groupInviteLink(body) {
		return {
			data: {
				inviteLink: `https://chat.whatsapp.com/fakeInviteCode123`,
				remoteJid: body.remoteJid
			}
		};
	}

	_groupTopic(body) {
		return { data: { topic: body.topic, remoteJid: body.remoteJid } };
	}

	_groupAnnounce(body) {
		return { data: { announce: body.announce, remoteJid: body.remoteJid } };
	}

	_groupLocked(body) {
		return { data: { locked: body.locked, remoteJid: body.remoteJid } };
	}

	_groupEphemeral(body) {
		return { data: { ephemeral: body.ephemeral, remoteJid: body.remoteJid } };
	}

	_groupCreate(body) {
		const newGroup = {
			id: `1203630234567890${this.state.groups.length + 14}@g.us`,
			name: body.name,
			owner: this.state.phoneNumber + "@s.whatsapp.net",
			participants: (body.participants || []).map((p) => ({ jid: p, admin: false })),
			subject: body.name,
			creation: Date.now()
		};
		this.state.groups.push(newGroup);
		return { data: newGroup };
	}

	// ─── Admin ─────────────────────────────────────────────────────────

	_adminListUsers() {
		const users = Array.from(this.state.users.values());
		return { data: users };
	}

	_adminCreateUser(body) {
		const user = {
			id: body.id || `user-${Date.now()}`,
			token: body.token || `token-${Date.now()}`
		};
		this.state.users.set(user.token, user);
		return { data: user };
	}

	_adminDeleteUser(endpoint) {
		const id = endpoint.replace("/admin/users/", "");
		if (id.includes("/full")) {
			// Full delete
			this.state.users.delete(id.replace("/full", ""));
		} else {
			this.state.users.delete(id);
		}
		return { data: { deleted: true, id } };
	}

	// ─── Health ────────────────────────────────────────────────────────

	_health() {
		return { status: "ok", timestamp: new Date().toISOString() };
	}

	// ─── Webhook ───────────────────────────────────────────────────────

	_setWebhook(body) {
		return { data: { webhook: body.url, format: body.format || "json" } };
	}

	_getWebhook() {
		return { data: { webhook: "http://ravena-ai:5000/webhook/wuzapi", format: "json" } };
	}

	// ─── Error injection ───────────────────────────────────────────────

	_shouldFail(endpoint) {
		if (this.errorMode === "none") return false;
		if (this.errorMode === "always") return true;
		if (this.errorMode === "random") return Math.random() < 0.3;
		if (typeof this.errorMode === "object") return !!this.errorMode[endpoint];
		if (typeof this.customErrors === "object") return !!this.customErrors[endpoint];
		return false;
	}

	// ─── Record/Replay ─────────────────────────────────────────────────

	startRecording() {
		this.recording = true;
		this.recorded = {};
	}

	stopRecording() {
		this.recording = false;
	}

	getRecorded() {
		return this.recorded;
	}

	saveRecorded(filePath) {
		const fs = require("fs");
		fs.writeFileSync(filePath, JSON.stringify(this.recorded, null, 2));
	}

	loadRecorded(filePath) {
		const fs = require("fs");
		this.recorded = JSON.parse(fs.readFileSync(filePath, "utf8"));
	}

	// ─── Public API methods (matching WuzapiClient interface) ──────────

	async get(endpoint) {
		return this._simulate("GET", endpoint);
	}

	async post(endpoint, body) {
		return this._simulate("POST", endpoint, body);
	}

	async delete(endpoint) {
		return this._simulate("DELETE", endpoint);
	}

	async adminGet(endpoint) {
		return this._simulate("GET", endpoint);
	}

	async adminPost(endpoint, body) {
		return this._simulate("POST", endpoint, body);
	}

	async adminDelete(endpoint) {
		return this._simulate("DELETE", endpoint);
	}
}

module.exports = FakeWuzapiClient;