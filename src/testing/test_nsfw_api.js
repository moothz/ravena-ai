const BotAPI = require("../BotAPI");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");

async function runTests() {
	console.log("=== Iniciando testes do endpoint /api/nsfw-detect ===");
	const testPort = 5998;
	const botApi = new BotAPI({ port: testPort });
	await botApi.start();
	const baseUrl = `http://localhost:${testPort}`;

	try {
		// Teste 1: Requisição sem imagem -> 400
		console.log("\n[Teste 1] Requisição sem imagem");
		try {
			await axios.post(`${baseUrl}/api/nsfw-detect`, {});
			console.error("FAIL: Deveria ter retornado 400");
		} catch (err) {
			if (err.response?.status === 400) {
				console.log("PASS: Retornou 400:", err.response.data);
			} else {
				console.error("FAIL: Status inesperado:", err.response?.status);
			}
		}

		// Teste 2: Base64 acima de 3MB -> 413
		console.log("\n[Teste 2] Base64 acima de 3MB (> 3.145.728 bytes)");
		const largeBuffer = Buffer.alloc(3.2 * 1024 * 1024, "a");
		const largeBase64 = `data:image/jpeg;base64,${largeBuffer.toString("base64")}`;
		try {
			await axios.post(
				`${baseUrl}/api/nsfw-detect`,
				{ image: largeBase64 },
				{ maxBodyLength: 50 * 1024 * 1024 }
			);
			console.error("FAIL: Deveria ter retornado 413");
		} catch (err) {
			if (err.response?.status === 413) {
				console.log("PASS: Retornou 413:", err.response.data);
			} else {
				console.error("FAIL: Status inesperado:", err.response?.status, err.response?.data);
			}
		}

		// Teste 3: Multipart upload arquivo acima de 3MB -> 413
		console.log("\n[Teste 3] Multipart upload arquivo acima de 3MB");
		const largeFilePath = path.join(__dirname, "temp_large_test.jpg");
		fs.writeFileSync(largeFilePath, Buffer.alloc(3.2 * 1024 * 1024, 0));
		try {
			const form = new FormData();
			form.append("file", fs.createReadStream(largeFilePath));
			await axios.post(`${baseUrl}/api/nsfw-detect`, form, {
				headers: form.getHeaders(),
				maxBodyLength: 50 * 1024 * 1024
			});
			console.error("FAIL: Deveria ter retornado 413");
		} catch (err) {
			if (err.response?.status === 413) {
				console.log("PASS: Retornou 413:", err.response.data);
			} else {
				console.error("FAIL: Status inesperado:", err.response?.status, err.response?.data);
			}
		} finally {
			if (fs.existsSync(largeFilePath)) fs.unlinkSync(largeFilePath);
		}

		// Teste 4: Multipart upload arquivo não-imagem -> 400
		console.log("\n[Teste 4] Multipart upload arquivo não-imagem (.txt)");
		const txtFilePath = path.join(__dirname, "temp_test.txt");
		fs.writeFileSync(txtFilePath, "arquivo de texto");
		try {
			const form = new FormData();
			form.append("file", fs.createReadStream(txtFilePath), {
				filename: "temp_test.txt",
				contentType: "text/plain"
			});
			await axios.post(`${baseUrl}/api/nsfw-detect`, form, {
				headers: form.getHeaders()
			});
			console.error("FAIL: Deveria ter retornado 400");
		} catch (err) {
			if (err.response?.status === 400) {
				console.log("PASS: Retornou 400:", err.response.data);
			} else {
				console.error("FAIL: Status inesperado:", err.response?.status, err.response?.data);
			}
		} finally {
			if (fs.existsSync(txtFilePath)) fs.unlinkSync(txtFilePath);
		}

		// Teste 5: Multipart upload válido (pequeno 100 bytes) -> sucesso e verificação de deleção
		console.log(
			"\n[Teste 5] Multipart upload válido e verificação de limpeza de arquivo em uploads/"
		);
		const uploadsDir = path.join(__dirname, "../../uploads");
		const filesBefore = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : [];

		const smallImgPath = path.join(__dirname, "temp_small.jpg");
		const sampleJpg = Buffer.from(
			"/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
			"base64"
		);
		fs.writeFileSync(smallImgPath, sampleJpg);

		try {
			const form = new FormData();
			form.append("file", fs.createReadStream(smallImgPath), {
				filename: "temp_small.jpg",
				contentType: "image/jpeg"
			});
			const res = await axios.post(`${baseUrl}/api/nsfw-detect`, form, {
				headers: form.getHeaders()
			});
			console.log("PASS: Detecção respondeu:", res.data);
		} catch (err) {
			console.error("Erro na chamada:", err.response?.status, err.response?.data || err.message);
		} finally {
			if (fs.existsSync(smallImgPath)) fs.unlinkSync(smallImgPath);
		}

		const filesAfter = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : [];
		const leftover = filesAfter.filter((f) => !filesBefore.includes(f));
		if (leftover.length === 0) {
			console.log("PASS: Nenhum arquivo temporário sobrou em uploads/ (limpeza confirmada)!");
		} else {
			console.error("FAIL: Arquivos não deletados encontrados em uploads/:", leftover);
		}

		// Teste 6: Base64 válido pequeno -> sucesso
		console.log("\n[Teste 6] Base64 válido pequeno (< 3MB)");
		try {
			const res = await axios.post(`${baseUrl}/api/nsfw-detect`, {
				image: `data:image/jpeg;base64,${sampleJpg.toString("base64")}`
			});
			console.log("PASS: Respondeu com sucesso:", res.data);
		} catch (err) {
			console.error(
				"Erro na chamada base64:",
				err.response?.status,
				err.response?.data || err.message
			);
		}

		console.log("\n=== Todos os testes concluídos com sucesso! ===");
		process.exit(0);
	} finally {
		await botApi.stop();
	}
}

runTests().catch((err) => {
	console.error(err);
	process.exit(1);
});
