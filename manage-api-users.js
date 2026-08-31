#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const USERS_FILE = path.join(__dirname, "data", "external-API-users.json");

const DEFAULT_RATE_LIMITS = {
	imagine: 5,
	llm: 10,
	stt: 10,
	tts: 20
};

function ensureFile() {
	const dir = path.dirname(USERS_FILE);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	if (!fs.existsSync(USERS_FILE)) {
		fs.writeFileSync(USERS_FILE, "[]", "utf8");
	}
}

function loadUsers() {
	ensureFile();
	try {
		const data = fs.readFileSync(USERS_FILE, "utf8");
		return JSON.parse(data || "[]");
	} catch (e) {
		console.error("Erro ao ler arquivo de usuários:", e.message);
		return [];
	}
}

function saveUsers(users) {
	ensureFile();
	fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
}

function generateApiKey() {
	return "rav_live_" + crypto.randomBytes(20).toString("hex");
}

const command = process.argv[2];
const nameArg = process.argv[3];

if (!command || ["help", "--help", "-h"].includes(command)) {
	console.log(`
Uso:
  node manage-api-users.js add <nome>    - Cadastra um novo usuário de API externa
  node manage-api-users.js del <nome>    - Remove um usuário de API externa
  node manage-api-users.js list          - Lista todos os usuários cadastrados
`);
	process.exit(0);
}

const users = loadUsers();

if (command === "add") {
	if (!nameArg) {
		console.error("❌ Erro: Informe o nome do usuário. Ex: make add-api-user pessoa");
		process.exit(1);
	}

	const cleanName = nameArg.trim();
	const existingIndex = users.findIndex((u) => u.name.toLowerCase() === cleanName.toLowerCase());

	const apiKey = generateApiKey();
	const newUser = {
		name: cleanName,
		apiKey,
		createdAt: Date.now(),
		enabled: true,
		rateLimits: { ...DEFAULT_RATE_LIMITS }
	};

	if (existingIndex >= 0) {
		users[existingIndex] = newUser;
		console.log(`\n🔄 Usuário '${cleanName}' atualizado com nova chave de API!`);
	} else {
		users.push(newUser);
		console.log(`\n✅ Usuário '${cleanName}' cadastrado com sucesso!`);
	}

	saveUsers(users);

	console.log(`\n======================================================`);
	console.log(`👤 Usuário:    ${cleanName}`);
	console.log(`🔑 API Key:    ${apiKey}`);
	console.log(`⚡ Rate Limits:`);
	console.log(`   - imagine:  ${newUser.rateLimits.imagine} req/min`);
	console.log(`   - llm:      ${newUser.rateLimits.llm} req/min`);
	console.log(`   - stt:      ${newUser.rateLimits.stt} req/min`);
	console.log(`   - tts:      ${newUser.rateLimits.tts} req/min`);
	console.log(`======================================================\n`);
} else if (command === "del") {
	if (!nameArg) {
		console.error("❌ Erro: Informe o nome do usuário. Ex: make del-api-user pessoa");
		process.exit(1);
	}

	const cleanName = nameArg.trim();
	const initialLength = users.length;
	const filtered = users.filter((u) => u.name.toLowerCase() !== cleanName.toLowerCase());

	if (filtered.length === initialLength) {
		console.log(`⚠️ Usuário '${cleanName}' não encontrado no arquivo.`);
	} else {
		saveUsers(filtered);
		console.log(`✅ Usuário '${cleanName}' removido com sucesso.`);
	}
} else if (command === "list") {
	if (users.length === 0) {
		console.log("Nenhum usuário de API externa cadastrado.");
	} else {
		console.log(`\n--- Usuários de API Externa (${users.length}) ---`);
		users.forEach((u, i) => {
			console.log(
				`${i + 1}. [${u.enabled ? "ATIVO" : "DESATIVADO"}] ${u.name} | Key: ${u.apiKey} | Limits: ${JSON.stringify(u.rateLimits)}`
			);
		});
		console.log("-------------------------------------------\n");
	}
} else {
	console.error(`Comando desconhecido: ${command}. Use 'add', 'del' ou 'list'.`);
	process.exit(1);
}
