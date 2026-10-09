process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const FormData = require("form-data");
const { upload, ensureUploadsDir, uploadsDir } = require("../BotAPI/middleware/upload");

async function run() {
	console.log("=== Testando Upload Middleware e STT Upload ===");

	// 1. Testa ensureUploadsDir
	const testDir = uploadsDir;
	if (fs.existsSync(testDir)) {
		// Simula caso em que o diretório foi deletado em runtime
		const files = fs.readdirSync(testDir);
		for (const f of files) {
			fs.unlinkSync(path.join(testDir, f));
		}
		fs.rmdirSync(testDir);
	}
	assert.strictEqual(fs.existsSync(testDir), false, "Diretório deve estar deletado para o teste");

	ensureUploadsDir();
	assert.strictEqual(fs.existsSync(testDir), true, "ensureUploadsDir deve recriar o diretório");
	console.log("✓ ensureUploadsDir recriou o diretório com sucesso");

	// 2. Testa upload do Multer com diretório deletado logo antes do upload (deve recriar dinamicamente)
	fs.rmdirSync(testDir);
	assert.strictEqual(fs.existsSync(testDir), false);

	const app = express();
	app.post("/test-upload", upload.single("audio"), (req, res) => {
		if (!req.file) {
			return res.status(400).json({ error: "Nenhum arquivo enviado" });
		}
		res.json({
			success: true,
			path: req.file.path,
			destination: req.file.destination,
			filename: req.file.filename,
			size: req.file.size
		});
	});

	const server = http.createServer(app);
	await new Promise((resolve) => server.listen(0, resolve));
	const port = server.address().port;

	try {
		const form = new FormData();
		const fakeAudioContent = Buffer.from("RIFF....WAVEfmt ....data....fake audio data");
		form.append("audio", fakeAudioContent, {
			filename: "test_audio.wav",
			contentType: "audio/wav"
		});

		const response = await new Promise((resolve, reject) => {
			const req = http.request(
				{
					hostname: "127.0.0.1",
					port,
					path: "/test-upload",
					method: "POST",
					headers: form.getHeaders()
				},
				(res) => {
					let data = "";
					res.on("data", (chunk) => (data += chunk));
					res.on("end", () => resolve({ statusCode: res.statusCode, body: JSON.parse(data) }));
				}
			);
			req.on("error", reject);
			form.pipe(req);
		});

		assert.strictEqual(response.statusCode, 200, "Upload deve retornar status 200");
		assert.strictEqual(response.body.success, true);
		assert.strictEqual(
			fs.existsSync(response.body.path),
			true,
			"Arquivo enviado deve existir no disco"
		);
		console.log(
			"✓ Upload funcionou mesmo com pasta deletada antes do request:",
			response.body.path
		);

		// Limpa o arquivo de teste
		if (fs.existsSync(response.body.path)) {
			fs.unlinkSync(response.body.path);
		}
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}

	console.log("=== Todos os testes do upload passaram com sucesso! ===");
}

run()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Erro no teste:", err);
		process.exit(1);
	});
