const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const { createCanvas, loadImage, registerFont } = require("canvas");
require("dotenv").config();

const Database = require("./src/utils/Database");
const database = Database.getInstance();
const bonsaiModule = require("./src/functions/BonsaiCommands");

const RARE_FISH_DESCRIPTIONS = {
	Cthulhu: "cosmic horror, tentacles on face, giant wings, green scaly humanoid dragon",
	Jörmungandr: "world serpent, colossal sea snake, glowing blue scales, ancient runes",
	Ryūjin: "Japanese sea dragon, long serpentine body, holding a tide jewel, regal and divine",
	"Dai Gum Loong": "giant golden Chinese dragon, five-clawed, whiskers, flowing mane, majestic",
	Godzilla: "king of monsters, giant prehistoric lizard, jagged dorsal fins, blue atomic glow",
	Leviathan:
		"biblical sea monster, armored plates, multi-headed, fire and steam emerging from scales",
	Bakunawa: "moon-swallowing sea serpent, giant gills, dragon-like features, Filipino mythology",
	Hydra: "multi-headed serpentine beast, green and purple scales, toxic breath, swampy atmosphere",
	Charybdis:
		"sentient massive whirlpool, rows of sharp teeth inside a vortex, sucking everything in",
	Megalodon: "prehistoric apex predator shark, massive jaws, battle scars, dark gray skin",
	Aspidochelone:
		"island-sized turtle, trees and greenery on its back, coral-covered shell, ancient eyes",
	Kraken: "colossal cephalopod, massive powerful tentacles, beak, dark ink clouds around it",
	Makara: "hybrid creature, crocodile body, elephant trunk, fish tail, ornate Hindu ornaments",
	Umibōzu:
		"giant shadowy sea spirit, smooth bald head, glowing white eyes, emerging from dark water",
	Nessie: "long-necked lake monster, plesiosaur body, dark green skin, elusive and mysterious",
	Taniwha: "Maori guardian spirit, lizard-whale hybrid, tribal tattoo-like patterns on skin",
	"Moby Dick": "monstrous white sperm whale, scarred head, broken harpoons and ropes stuck in back",
	Kelpie: "shapeshifting water horse, seaweed mane, webbed hooves, predatory look",
	Sedna:
		"Inuit sea goddess, mermaid-like, long black hair flowing in water, seals and walruses around her",
	Baleia: "majestic giant blue whale, immense scale, barnacles on skin, graceful movement"
};

const PLACEHOLDER_SIZE = 1206801; // Size of data/rare-fish.jpg in bytes
const MIN_SIZE_LIMIT = 10 * 1024; // 10 KB

let fontRegistered = false;
function registerCustomFont(databasePath) {
	if (fontRegistered) return;
	const fontPath = path.join(databasePath, "fonts", "FishingFont.ttf");
	try {
		if (fsSync.existsSync(fontPath)) {
			registerFont(fontPath, { family: "FishingFont" });
			fontRegistered = true;
		}
	} catch (err) {
		console.error("Erro ao registrar fonte para peixe raro:", err);
	}
}

async function drawTextOnRareFishImage(
	mediaContent,
	fishName,
	fishWeight,
	dateString,
	databasePath
) {
	try {
		if (!mediaContent || !mediaContent.data) {
			return mediaContent;
		}

		registerCustomFont(databasePath);

		const imgBuffer = Buffer.from(mediaContent.data, "base64");
		const img = await loadImage(imgBuffer);
		const width = img.width;
		const height = img.height;

		const canvas = createCanvas(width, height);
		const ctx = canvas.getContext("2d");

		ctx.drawImage(img, 0, 0);

		const line1 = `${fishName}, ${fishWeight.toFixed(2)}kg`;
		const line2 = dateString;

		const fontSize = Math.floor(width * 0.065);
		const strokeWidth = Math.floor(width * 0.01);

		const fontFamily = fontRegistered ? "FishingFont" : "Impact";
		ctx.font = `bold ${fontSize}px ${fontFamily}`;
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";

		ctx.strokeStyle = "black";
		ctx.lineWidth = strokeWidth;
		ctx.lineJoin = "round";
		ctx.fillStyle = "white";

		const y1 = Math.floor(height * 0.88);
		const y2 = Math.floor(height * 0.94);

		ctx.strokeText(line1, width / 2, y1);
		ctx.fillText(line1, width / 2, y1);

		ctx.strokeText(line2, width / 2, y2);
		ctx.fillText(line2, width / 2, y2);

		const outputBuffer = canvas.toBuffer("image/jpeg", { quality: 0.9 });

		mediaContent.data = outputBuffer.toString("base64");
		mediaContent.size = outputBuffer.length;
		delete mediaContent.url;
		mediaContent.source = "base64";
		return mediaContent;
	} catch (error) {
		console.error("Erro ao desenhar texto na imagem do peixe raro:", error);
		return mediaContent;
	}
}

function formatDateTime(date) {
	const options = {
		day: "2-digit",
		month: "2-digit",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false
	};

	return new Intl.DateTimeFormat("en-GB", options).format(date).replace(",", "");
}

async function regenerateImage(legendary) {
	const dateString = formatDateTime(new Date(legendary.timestamp));
	const fishDescription = RARE_FISH_DESCRIPTIONS[legendary.fish_name] || "";

	const prompt = `Amateur photo with cybershot style framing, a bit blurry, dirty lens:
Person named '${legendary.user_name}' fishing an epically rare monstrous creature (fantasy) fish known as "${legendary.fish_name}", ${fishDescription}

Sweat and tears, joy
Epic scenario, huge boats, creature captured mythical, fantastic, water splashing
Dynamic, action-ready close-up composition, medium depth-of-field, hyper-detailed photorealistic-anime hybrid style, epic survival and exploration atmosphere.`;

	const mockMessage = {
		author: "SYSTEM",
		authorName: "Sistema",
		content: prompt,
		origin: {
			getQuotedMessage: () => Promise.resolve(null),
			react: async () => {}
		}
	};

	const mockBot = {
		createMedia: async (filePath) => {
			const data = await fs.readFile(filePath, { encoding: "base64" });
			return {
				mimetype: "image/jpeg",
				data,
				filename: path.basename(filePath),
				source: "file",
				isMessageMedia: true,
				size: data.length
			};
		},
		sendMessage: async () => {}
	};

	console.log(
		`[Regenerate] Calling Bonsai API for prompt: "${legendary.fish_name}" caught by "${legendary.user_name}"...`
	);
	const result = await bonsaiModule.generateImage(
		mockBot,
		mockMessage,
		prompt,
		{ filters: { nsfw: false } },
		true,
		{ skipNSFW: true, isProgrammatic: true }
	);

	if (!result || !result.content || !result.content.mimetype) {
		throw new Error("Bonsai API generation failed to return media content");
	}

	console.log(`[Regenerate] Drawing text overlay...`);
	const processedMedia = await drawTextOnRareFishImage(
		result.content,
		legendary.fish_name,
		legendary.weight,
		dateString,
		database.databasePath
	);

	return processedMedia;
}

async function main() {
	try {
		console.log("=== INICIANDO REGENERAÇÃO DE IMAGENS DE PEIXES RAROS ===");

		// Query legendary fish history
		const query = "SELECT * FROM fishing_legendary_history ORDER BY timestamp DESC";
		const legendaries = await database.dbAll("fishing", query);

		console.log(`Total de capturas lendárias no banco de dados: ${legendaries.length}`);

		const mediaDir = path.join(database.databasePath, "media");
		let countRegenerated = 0;

		for (const legendary of legendaries) {
			const imagePath = path.join(mediaDir, legendary.image_name);
			let needsRegen = false;
			let reason = "";

			try {
				const stats = await fs.stat(imagePath);
				if (stats.size === PLACEHOLDER_SIZE) {
					needsRegen = true;
					reason = "Imagem é o placeholder padrão (rare-fish.jpg)";
				} else if (stats.size < MIN_SIZE_LIMIT) {
					needsRegen = true;
					reason = `Arquivo muito pequeno (${stats.size} bytes)`;
				}
			} catch (err) {
				// File does not exist
				needsRegen = true;
				reason = "Arquivo de imagem ausente no disco";
			}

			if (needsRegen) {
				console.log(`\n--------------------------------------------------`);
				console.log(
					`[ID ${legendary.id}] Peixe: ${legendary.fish_name} (${legendary.weight.toFixed(2)} kg) | Pescador: ${legendary.user_name}`
				);
				console.log(`Motivo da regeneração: ${reason}`);

				try {
					const mediaContent = await regenerateImage(legendary);
					await fs.writeFile(imagePath, Buffer.from(mediaContent.data, "base64"));
					console.log(`✅ Imagem regenerada com sucesso e salva em: ${legendary.image_name}`);
					countRegenerated++;

					// Small delay to prevent API flooding
					await new Promise((resolve) => setTimeout(resolve, 3000));
				} catch (regenErr) {
					console.error(
						`❌ Erro ao regenerar peixe lendário ID ${legendary.id}:`,
						regenErr.message
					);
				}
			}
		}

		console.log(`\n=== FIM DO PROCESSO ===`);
		console.log(`Total de imagens processadas e corrigidas: ${countRegenerated}`);
		process.exit(0);
	} catch (error) {
		console.error("Erro fatal no script de regeneração:", error);
		process.exit(1);
	}
}

// Give SQLite a brief moment to initialize connection
setTimeout(main, 1000);
