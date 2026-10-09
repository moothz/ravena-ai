const path = require("path");
const fsSync = require("fs");
const crypto = require("crypto");
const multer = require("multer");

const uploadsDir = path.join(__dirname, "../../../temp/uploads");

function ensureUploadsDir() {
	if (!fsSync.existsSync(uploadsDir)) {
		fsSync.mkdirSync(uploadsDir, { recursive: true });
	}
	return uploadsDir;
}

ensureUploadsDir();

const diskStorage = multer.diskStorage({
	destination: (req, file, cb) => {
		try {
			ensureUploadsDir();
			cb(null, uploadsDir);
		} catch (err) {
			cb(err);
		}
	},
	filename: (req, file, cb) => {
		crypto.randomBytes(16, (err, raw) => {
			if (err) return cb(err);
			cb(null, raw.toString("hex"));
		});
	}
});

const upload = multer({
	storage: diskStorage,
	limits: { fileSize: 50 * 1024 * 1024 }
});

const MAX_NSFW_FILE_SIZE = 3 * 1024 * 1024; // 3MB
const uploadNsfw = multer({
	storage: diskStorage,
	limits: {
		fileSize: MAX_NSFW_FILE_SIZE,
		files: 16
	},
	fileFilter: (req, file, cb) => {
		if (!file.mimetype || !file.mimetype.startsWith("image/")) {
			return cb(new Error("Apenas arquivos de imagem são permitidos."));
		}
		cb(null, true);
	}
});

module.exports = {
	uploadsDir,
	ensureUploadsDir,
	upload,
	uploadNsfw,
	MAX_NSFW_FILE_SIZE
};
