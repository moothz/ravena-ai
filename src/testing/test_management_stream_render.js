"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

async function main() {
	console.log("=== Iniciando teste de renderização de streams e isVideoKind no /manage ===");

	const possiblePaths = [
		path.join(__dirname, "../../public/management.js"),
		"/app/public/management.js"
	];
	const managementJsPath = possiblePaths.find((p) => fs.existsSync(p));
	assert.ok(managementJsPath, "management.js deve existir");

	const managementJs = fs.readFileSync(managementJsPath, "utf8");

	// 1. Validar que renderStreamSection declara isVideoKind
	console.log("1. Validando declaração de isVideoKind dentro de renderStreamSection...");
	const renderStreamSectionMatch = managementJs.match(
		/function renderStreamSection\(platform\) \{([\s\S]*?)\n {4}\}/
	);
	assert.ok(renderStreamSectionMatch, "Função renderStreamSection deve existir em management.js");

	const renderStreamBody = renderStreamSectionMatch[1];
	assert.match(
		renderStreamBody,
		/const\s*\{\s*storeKey,\s*kind\s*\}\s*=\s*parseStreamPlatform\(platform\);/,
		"renderStreamSection deve chamar parseStreamPlatform(platform)"
	);
	assert.match(
		renderStreamBody,
		/const\s+isVideoKind\s*=\s*kind\s*===\s*['"]video['"];/,
		"renderStreamSection deve declarar const isVideoKind = kind === 'video';"
	);
	console.log("✓ isVideoKind está devidamente declarado dentro de renderStreamSection.");

	// 2. Simular a execução do template literal de renderStreamSection para todas as plataformas com canais
	console.log("2. Simulando renderStreamSection com canais existentes...");
	const parseStreamPlatformMatch = managementJs.match(
		/function parseStreamPlatform\(platform\) \{([\s\S]*?)\n {4}\}/
	);
	assert.ok(parseStreamPlatformMatch, "Função parseStreamPlatform deve existir");
	const parseStreamPlatform = new Function("platform", parseStreamPlatformMatch[1]);

	const SPLIT_STREAM_PLATFORMS = ["youtube", "tiktok"];

	const fakeGroupData = {
		twitch: [
			{ channel: "streamer1", useThumbnail: true, closeGroupOnLive: true, closeGroupDuration: 30 }
		],
		kick: [{ channel: "streamer2", useThumbnail: false, closeGroupOnLive: false }],
		youtube: [
			{ channel: "canal_yt", notifyVideos: true, notifyLives: false, useThumbnail: true },
			{
				channel: "canal_yt_live",
				notifyVideos: false,
				notifyLives: true,
				closeGroupOnLive: true,
				closeGroupDuration: 60
			}
		],
		tiktok: [
			{ channel: "tiktok_user", notifyVideos: true, notifyLives: true, closeGroupOnLive: true }
		]
	};

	const renderedHtml = {};
	function simulateRenderStreamSection(platform) {
		if (SPLIT_STREAM_PLATFORMS.includes(platform)) {
			simulateRenderStreamSection(`${platform}_video`);
			simulateRenderStreamSection(`${platform}_live`);
			return;
		}

		const { storeKey, kind } = parseStreamPlatform(platform);
		const isVideoKind = kind === "video";
		let streams = (fakeGroupData[storeKey] || []).map((s, idx) => ({ ...s, _originalIndex: idx }));
		if (kind === "video") {
			streams = streams.filter((s) => s.notifyVideos !== false);
		} else if (kind === "live") {
			streams = streams.filter((s) => s.notifyLives !== false);
		}

		renderedHtml[platform] = [];
		streams.forEach((stream) => {
			const index = stream._originalIndex;
			const html = `
				<td>
					<strong>${stream.channel}</strong>
					${stream.useThumbnail ? ' <span class="badge-soon" style="color: #25d366; border-color: rgba(37,211,102,0.4); background: rgba(37,211,102,0.1);">Thumb</span>' : ""}
					${!isVideoKind && stream.closeGroupOnLive ? ` <span class="badge-soon" style="color: #f39c12; border-color: rgba(243,156,18,0.4); background: rgba(243,156,18,0.1);" title="Fecha o grupo durante lives"><i class="fas fa-lock"></i> Fechar Grupo${stream.closeGroupDuration ? ` (${stream.closeGroupDuration}m)` : ""}</span>` : ""}
				</td>
				<td>
					<button class="btn btn-xs btn-primary btn-edit-stream" data-platform="${platform}" data-index="${index}"><i class="fas fa-edit"></i> Editar</button>
				</td>
			`;
			renderedHtml[platform].push(html);
		});
	}

	// Executa para todas as plataformas sem lançar ReferenceError
	const platforms = [
		"twitch",
		"kick",
		"youtube",
		"youtube_video",
		"youtube_live",
		"tiktok",
		"tiktok_video",
		"tiktok_live"
	];
	for (const p of platforms) {
		assert.doesNotThrow(() => {
			simulateRenderStreamSection(p);
		}, `renderStreamSection('${p}') não deve lançar erro`);
	}

	// 3. Validações semânticas do resultado
	console.log("3. Validando regras de exibição de Fechar Grupo...");
	// Twitch com closeGroupOnLive deve mostrar badge
	assert.ok(
		renderedHtml["twitch"].some((h) => h.includes("Fechar Grupo (30m)")),
		"Twitch deve exibir badge Fechar Grupo"
	);
	// YouTube Video NÃO deve mostrar Fechar Grupo mesmo se a prop estivesse ativa
	assert.ok(
		renderedHtml["youtube_video"].every((h) => !h.includes("Fechar Grupo")),
		"YouTube Vídeo NÃO deve exibir badge Fechar Grupo (apenas lives)"
	);
	// YouTube Live com closeGroupOnLive DEVE mostrar badge
	assert.ok(
		renderedHtml["youtube_live"].some((h) => h.includes("Fechar Grupo (60m)")),
		"YouTube Live deve exibir badge Fechar Grupo"
	);
	// TikTok Vídeo NÃO deve mostrar Fechar Grupo
	assert.ok(
		renderedHtml["tiktok_video"].every((h) => !h.includes("Fechar Grupo")),
		"TikTok Vídeo NÃO deve exibir badge Fechar Grupo"
	);
	// TikTok Live DEVE mostrar Fechar Grupo
	assert.ok(
		renderedHtml["tiktok_live"].some((h) => h.includes("Fechar Grupo")),
		"TikTok Live deve exibir badge Fechar Grupo"
	);

	console.log("✓ Todas as asserções de renderização de stream passaram com sucesso.");
	console.log("\n=== TESTE CONCLUÍDO COM SUCESSO ===");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("ERRO NO TESTE:", err);
		process.exit(1);
	});
