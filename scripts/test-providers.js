const fs = require("fs");
const axios = require("axios");
const path = require("path");
const { performance } = require("perf_hooks");

const CONFIG_FILE = path.join(__dirname, "..", "service-providers.json");
const TEST_IMAGE = path.join(__dirname, "..", "data", "rare-fish.jpg");
const TEST_AUDIO = path.join(__dirname, "..", "data", "ravena_sample.mp3");

const TEST_TOOLS = [
	{
		type: "function",
		function: {
			name: "web_search",
			description: "Pesquisa na web por informações atualizadas, notícias ou fatos recentes.",
			parameters: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "Termos de busca"
					}
				},
				required: ["query"]
			}
		}
	}
];

function extractToolCall(data, type) {
	if (!data) return null;
	const msg = type === "ollama" ? data.message : data.choices?.[0]?.message;
	if (!msg) return null;

	// Formato padrão OpenAI ou Ollama
	if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
		const first = msg.tool_calls[0];
		return first.function?.name || first.name || "called";
	}

	// Formato legado function_call
	if (msg.function_call?.name) {
		return msg.function_call.name;
	}

	// Fallback para respostas com tags XML (ex: MiniMax ou invoke tags)
	if (typeof msg.content === "string") {
		const invokeMatch = msg.content.match(/<invoke\s+name=["']([^"']+)["']/i);
		if (invokeMatch) return invokeMatch[1];
		const toolCallMatch = msg.content.match(
			/<(?:minimax:)?tool_call[^>]*>[\s\S]*?<invoke\s+name=["']([^"']+)["']/i
		);
		if (toolCallMatch) return toolCallMatch[1];
		if (/<tool_call>[\s\S]*?<\/tool_call>/i.test(msg.content)) return "tool_call";
	}

	return null;
}

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

				// 3. Teste de Tool Calling (se habilitado pro modelo)
				const isToolCallingEnabled = p.toolCalling === true || p.tool_calling === true;
				if (isToolCallingEnabled) {
					const toolTimeout = (p.timeout || 30000) * (p.timeout_multiplier || 1);
					let toolRes;

					if (p.type === "ollama") {
						toolRes = await testUrl(
							`${p.url}/api/chat`,
							"POST",
							{
								model: p.model,
								messages: [
									{
										role: "user",
										content:
											"Qual a cotação do dólar hoje? Use a ferramenta web_search para pesquisar."
									}
								],
								tools: TEST_TOOLS,
								options: { num_predict: 150 },
								stream: false
							},
							{ Authorization: p.apiKey ? `Bearer ${p.apiKey}` : undefined },
							toolTimeout
						);
					} else {
						toolRes = await testUrl(
							`${p.url}/chat/completions`,
							"POST",
							{
								model: p.model,
								messages: [
									{
										role: "user",
										content:
											"Qual a cotação do dólar hoje? Use a ferramenta web_search para pesquisar."
									}
								],
								tools: TEST_TOOLS,
								max_tokens: 150,
								stream: false
							},
							{ Authorization: p.apiKey ? `Bearer ${p.apiKey}` : undefined },
							toolTimeout
						);
					}

					if (toolRes.ok) {
						const calledTool = extractToolCall(toolRes.data, p.type);
						if (calledTool) {
							toolRes.fileInfo = `call: ${calledTool}`;
						} else {
							toolRes.ok = false;
							toolRes.status = "NO_CALL";
						}
					}
					results.push({ name: "TOOLS", ...toolRes });
				}
			} else if (category === "laya") {
				const authHeader = p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {};

				// 1. Health / GPU Status
				const healthRes = await testUrl(
					`${p.url}/health`,
					"GET",
					null,
					authHeader,
					p.timeoutMs || 5000
				);
				if (healthRes.ok && healthRes.data) {
					const dev = healthRes.data.device || "cpu";
					const bgem3 = healthRes.data.bgem3_engine ? "BGE-M3" : "READY";
					healthRes.fileInfo = `${dev} | ${bgem3}`;
				}
				results.push({ name: "HEALTH", ...healthRes });

				// 2. Teste de Intenção (Comando Legítimo)
				const predictRes = await testUrl(
					`${p.url}/predict`,
					"POST",
					{
						state: "qual a previsão do tempo pra amanhã?",
						questions: {
							intent: {
								type: "choice",
								instructions: "Classifique a intenção.",
								criteria: {
									clima: "Consulta previsão do tempo",
									conversa: "Conversa casual"
								}
							}
						},
						model: p.model || "ravena-bgem3"
					},
					{ "Content-Type": "application/json", ...authHeader },
					p.timeoutMs || 5000
				);
				if (predictRes.ok && predictRes.data) {
					const intent = predictRes.data.answers?.intent;
					if (intent?.choice === "clima") {
						predictRes.fileInfo = `intent: clima (${((intent.confidence || 0) * 100).toFixed(0)}%)`;
					} else {
						predictRes.ok = false;
						predictRes.status = "WRONG_CHOICE";
						predictRes.fileInfo = `got: ${intent?.choice}`;
					}
				}
				results.push({ name: "INTENT", ...predictRes });

				// 3. Teste de Hard Negative (Supressão de Falso Positivo)
				const hnRes = await testUrl(
					`${p.url}/predict`,
					"POST",
					{
						state: "mas e se eu quiser criar boi na fazenda?",
						questions: {
							intent: {
								type: "choice",
								instructions: "Classifique a intenção.",
								criteria: {
									fazenda: "Jogo da fazendinha",
									conversa: "Conversa casual"
								}
							}
						},
						model: p.model || "ravena-bgem3"
					},
					{ "Content-Type": "application/json", ...authHeader },
					p.timeoutMs || 5000
				);
				if (hnRes.ok && hnRes.data) {
					const intent = hnRes.data.answers?.intent;
					if (intent?.choice === "conversa") {
						hnRes.fileInfo = `gate: conversa (${((intent.confidence || 0) * 100).toFixed(0)}%)`;
					} else {
						hnRes.ok = false;
						hnRes.status = "FALSE_POS";
						hnRes.fileInfo = `fp: ${intent?.choice}`;
					}
				}
				results.push({ name: "HARD_NEG", ...hnRes });

				// 4. Teste de Visão (SigLIP 2 - Figurinhas)
				if (fs.existsSync(TEST_IMAGE)) {
					try {
						const FormData = require("form-data");
						const form = new FormData();
						form.append("file", fs.createReadStream(TEST_IMAGE));
						form.append(
							"questions",
							JSON.stringify({
								safety: {
									type: "choice",
									instructions: "Classifique a imagem.",
									criteria: { Safe: "Seguro", Nsfw: "Impróprio" }
								}
							})
						);
						const visionRes = await testUrl(
							`${p.url}/predict/image/upload`,
							"POST",
							form,
							{ ...form.getHeaders(), ...authHeader },
							p.timeoutMs || 10000
						);
						if (visionRes.ok && visionRes.data) {
							const safety = visionRes.data.results?.safety;
							visionRes.fileInfo = `safety: ${safety?.answer || "ok"}`;
						}
						results.push({ name: "VISION", ...visionRes });
					} catch (vErr) {
						results.push({
							name: "VISION",
							ok: false,
							status: "ERR",
							time: 0,
							error: vErr.message
						});
					}
				}
			} else if (category === "whisper") {
				const authHeader = p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {};
				if (audioBase64) {
					const transcribeRes = await testUrl(
						`${p.url}/transcribe`,
						"POST",
						{
							audioData: audioBase64,
							language: "pt"
						},
						authHeader
					);
					results.push({ name: "TRANSCR", ...transcribeRes });
				} else {
					results.push({ name: "PING", ...(await testUrl(p.url, "GET", null, authHeader)) });
				}
			} else if (category === "bonsai") {
				const authHeader = p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {};
				const genRes = await testUrl(
					`${p.url}/generate`,
					"POST",
					{
						prompt: "A cute little raven bot, digital art",
						width: 512,
						height: 512
					},
					{ responseType: "arraybuffer", ...authHeader }
				);
				if (genRes.ok) {
					const outPath = `test-output-bonsai-${p.name}.png`;
					fs.writeFileSync(outPath, Buffer.from(genRes.data));
					genRes.fileInfo = getFileSize(outPath);
				}
				results.push({ name: "GEN_IMG", ...genRes });
			} else if (category === "kokorotts" || category === "f5tts") {
				const timeout = (p.timeout || 120000) * (p.timeout_multiplier || 1);
				const isKokoro = category === "kokorotts";
				const ttsRes = await testUrl(
					`${p.url}/v1/audio/speech`,
					"POST",
					{
						model: isKokoro ? "kokoro-tts" : "f5-tts",
						input: "Olá, eu sou a Ravena!",
						voice: isKokoro ? "mulher" : "ravena",
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
					const outPath = `test-output-${category}-${p.name}.mp3`;
					fs.writeFileSync(outPath, Buffer.from(ttsRes.data));
					ttsRes.fileInfo = getFileSize(outPath);
				}
				results.push({ name: "TTS", ...ttsRes });
			} else if (category === "nudenet") {
				const headers = { "Content-Type": "application/json" };
				if (p.apiKey) headers.Authorization = `Bearer ${p.apiKey}`;
				if (imageBase64) {
					const classifyRes = await testUrl(
						`${p.url}/api/v1/classify`,
						"POST",
						{
							images: [{ id: "test", source: imageBase64 }],
							threshold: 0.7
						},
						headers,
						p.timeout || 15000
					);
					results.push({ name: "CLASSIFY", ...classifyRes });
				} else {
					results.push({ name: "PING", ...(await testUrl(p.url, "GET", null, headers)) });
				}
			} else if (category === "rembg") {
				const rembgUrl = p.url.replace(/\/+$/, "") + "/api/remove";
				const authHeader = p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {};
				const pingRes = await testUrl(rembgUrl, "GET", null, authHeader);
				if (pingRes.status === 422 || pingRes.status === 200) {
					pingRes.ok = true;
					pingRes.status = 200;
				}
				results.push({ name: "PING", ...pingRes });
			} else {
				const authHeader = p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {};
				results.push({ name: "STATUS", ...(await testUrl(p.url, "GET", null, authHeader)) });
			}

			// Exibe resultados
			for (const res of results) {
				let statusSymbol = "";
				let statusColor = COLORS.bright;

				if (res.status === 200) {
					statusSymbol = `${COLORS.green}✅ [OK] `;
					statusColor += COLORS.green;
				} else if (res.status === "NO_CALL") {
					statusSymbol = `${COLORS.yellow}⚠️  [WARN]`;
					statusColor += COLORS.yellow;
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
				} else if (res.status === "NO_CALL") {
					const msgContent =
						p.type === "ollama"
							? res.data?.message?.content
							: res.data?.choices?.[0]?.message?.content;
					const preview = msgContent
						? (typeof msgContent === "string" ? msgContent : JSON.stringify(msgContent)).trim()
						: "Modelo respondeu sem acionar tool_calls";
					console.log(
						`${COLORS.yellow}   ┗ Resposta: ${preview.substring(0, 100)}${preview.length > 100 ? "..." : ""}${COLORS.reset}`
					);
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

runTests()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
