const fs = require("fs");
const axios = require("axios");
const path = require("path");
const { performance } = require("perf_hooks");

const CONFIG_FILE = "service-providers.json";
const TEST_IMAGE = path.join(__dirname, "data", "rare-fish.jpg");
const TEST_AUDIO = path.join(__dirname, "data", "ravena_sample.mp3");

// Cores para o terminal
const COLORS = {
	reset: "\x1b[0m",
	bright: "\x1b[1m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	cyan: "\x1b[36m",
	magenta: "\x1b[35m"
};

function getFileSize(filePath) {
	try {
		const stats = fs.statSync(filePath);
		return (stats.size / 1024).toFixed(1) + " KB";
	} catch (e) {
		return "0 KB";
	}
}

async function testUrl(url, method = "GET", data = null, headers = {}, timeout = 30000) {
	const start = performance.now();
	try {
		const config = {
			url,
			method,
			data,
			headers,
			timeout,
			validateStatus: () => true
		};
		// Se for arraybuffer, axios precisa saber
		if (headers.responseType) {
			config.responseType = headers.responseType;
			delete headers.responseType;
		}

		const response = await axios(config);
		const end = performance.now();
		return {
			ok: response.status >= 200 && response.status < 300,
			reachable: response.status < 500,
			status: response.status,
			time: (end - start).toFixed(0),
			data: response.data
		};
	} catch (error) {
		const end = performance.now();
		return {
			ok: false,
			reachable: false,
			status: error.code || "TIMEOUT",
			time: (end - start).toFixed(0),
			error: error.message
		};
	}
}

async function runTests() {
	if (!fs.existsSync(CONFIG_FILE)) {
		console.error(`${COLORS.red}❌ Arquivo ${CONFIG_FILE} não encontrado!${COLORS.reset}`);
		process.exit(1);
	}

	const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
	let imageBase64 = "";
	if (fs.existsSync(TEST_IMAGE)) {
		imageBase64 = fs.readFileSync(TEST_IMAGE).toString("base64");
	}
	let audioBase64 = "";
	if (fs.existsSync(TEST_AUDIO)) {
		audioBase64 = fs.readFileSync(TEST_AUDIO).toString("base64");
	}

	console.log(`\n${COLORS.bright}${COLORS.magenta}🔍 TESTE FUNCIONAL DE PROVEDORES${COLORS.reset}`);
	console.log(`====================================================`);

	for (const [category, providers] of Object.entries(config)) {
		if (!Array.isArray(providers) || providers.length === 0) continue;

		console.log(
			`\n${COLORS.bright}${COLORS.cyan}📁 Categoria: ${category.toUpperCase()}${COLORS.reset}`
		);
		console.log(`----------------------------------------------------`);

		for (const p of providers) {
			if (p.enabled === false) {
				console.log(
					`${COLORS.yellow}⚪ [OFF] ${p.name.padEnd(25)} | Desativado na configuração${COLORS.reset}`
				);
				continue;
			}

			const results = [];

			if (category === "llm") {
				// 1. Teste de Texto (Ping)
				let textRes;
				if (p.type === "ollama") {
					textRes = await testUrl(`${p.url}/api/generate`, "POST", {
						model: p.model,
						prompt: "Responda apenas 'PONG'",
						options: { num_predict: 5 },
						stream: false
					});
				} else {
					textRes = await testUrl(
						`${p.url}/chat/completions`,
						"POST",
						{
							model: p.model,
							messages: [{ role: "user", content: "Responda apenas 'PONG'" }],
							max_tokens: 5,
							stream: false
						},
						{ Authorization: p.apiKey ? `Bearer ${p.apiKey}` : undefined }
					);
				}
				results.push({ name: "TEXT", ...textRes });

				// 2. Teste de Imagem (se suportado)
				if (!p.textOnly && imageBase64) {
					let imgRes;
					if (p.type === "ollama") {
						imgRes = await testUrl(`${p.url}/api/generate`, "POST", {
							model: p.model,
							prompt: "O que tem nesta imagem?",
							images: [imageBase64],
							options: { num_predict: 20 },
							stream: false
						});
					} else {
						imgRes = await testUrl(
							`${p.url}/chat/completions`,
							"POST",
							{
								model: p.model,
								messages: [
									{
										role: "user",
										content: [
											{ type: "text", text: "O que tem nesta imagem?" },
											{
												type: "image_url",
												image_url: { url: `data:image/jpeg;base64,${imageBase64}` }
											}
										]
									}
								],
								max_tokens: 20,
								stream: false
							},
							{ Authorization: p.apiKey ? `Bearer ${p.apiKey}` : undefined }
						);
					}
					results.push({ name: "VISION", ...imgRes });
				}
			} else if (category === "whisper") {
				if (audioBase64) {
					const transcribeRes = await testUrl(`${p.url}/transcribe`, "POST", {
						audioData: audioBase64,
						language: "pt"
					});
					results.push({ name: "TRANSCR", ...transcribeRes });
				} else {
					results.push({ name: "PING", ...(await testUrl(p.url)) });
				}
			} else if (category === "bonsai") {
				const genRes = await testUrl(
					`${p.url}/generate`,
					"POST",
					{
						prompt: "A cute little raven bot, digital art",
						width: 512,
						height: 512
					},
					{ responseType: "arraybuffer" }
				);
				if (genRes.ok) {
					const outPath = `test-output-bonsai-${p.name}.png`;
					fs.writeFileSync(outPath, Buffer.from(genRes.data));
					genRes.fileInfo = getFileSize(outPath);
				}
				results.push({ name: "GEN_IMG", ...genRes });
			} else if (category === "f5tts") {
				const timeout = (p.timeout || 120000) * (p.timeout_multiplier || 1);
				const ttsRes = await testUrl(
					`${p.url}/v1/audio/speech`,
					"POST",
					{
						model: "f5-tts",
						input: "Olá, eu sou a Ravena!",
						voice: "ravena",
						response_format: "mp3"
					},
					{
						"Content-Type": "application/json",
						Authorization: p.apiKey ? `Bearer ${p.apiKey}` : undefined,
						responseType: "arraybuffer"
					},
					timeout
				);
				if (ttsRes.ok) {
					const outPath = `test-output-f5tts-${p.name}.mp3`;
					fs.writeFileSync(outPath, Buffer.from(ttsRes.data));
					ttsRes.fileInfo = getFileSize(outPath);
				}
				results.push({ name: "TTS", ...ttsRes });
			} else {
				results.push({ name: "STATUS", ...(await testUrl(p.url)) });
			}

			// Exibe resultados
			for (const res of results) {
				let statusSymbol = "";
				let statusColor = COLORS.bright;

				if (res.status === 200) {
					statusSymbol = `${COLORS.green}✅ [OK] `;
					statusColor += COLORS.green;
				} else if (res.ok) {
					statusSymbol = `${COLORS.green}✅ [UP] `;
					statusColor += COLORS.cyan;
				} else if (res.reachable) {
					statusSymbol = `${COLORS.yellow}⚠️  [ERR]`;
					statusColor += COLORS.yellow;
				} else {
					statusSymbol = `${COLORS.red}❌ [OFF]`;
					statusColor += COLORS.red;
				}

				const timeColor =
					res.time > 10000 ? COLORS.red : res.time > 3000 ? COLORS.yellow : COLORS.green;
				const subName = `(${res.name})`;
				const extra = res.fileInfo ? ` | ${COLORS.magenta}${res.fileInfo}${COLORS.reset}` : "";

				console.log(
					`${statusSymbol} ${p.name.padEnd(20)} ${COLORS.cyan}${subName.padEnd(8)}${COLORS.reset} | ` +
						`${statusColor}${res.status.toString().padEnd(8)}${COLORS.reset} | ` +
						`${timeColor}${res.time.toString().padStart(5)}ms${COLORS.reset}${extra}`
				);

				if (!res.reachable && res.error) {
					console.log(`${COLORS.red}   ┗ Error: ${res.error}${COLORS.reset}`);
				} else if (res.status !== 200 && !res.ok && res.data) {
					const errorMsg = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
					console.log(
						`${COLORS.yellow}   ┗ API Info: ${errorMsg.substring(0, 100)}${errorMsg.length > 100 ? "..." : ""}${COLORS.reset}`
					);
				}
			}
		}
	}

	console.log(`\n====================================================`);
	console.log(`${COLORS.bright}${COLORS.green}✨ Teste concluído!${COLORS.reset}\n`);
}

runTests().catch((err) => {
	console.error(err);
	process.exit(1);
});
