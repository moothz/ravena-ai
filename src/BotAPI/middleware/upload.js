const path = require("path");
const fsSync = require("fs");
const multer = require("multer");

const uploadsDir = path.join(__dirname, "../../../temp/uploads");
if (!fsSync.existsSync(uploadsDir)) {
	fsSync.mkdirSync(uploadsDir, { recursive: true });
}

const upload = multer({
	dest: uploadsDir,
	limits: { fileSize: 50 * 1024 * 1024 }
});

const MAX_NSFW_FILE_SIZE = 3 * 1024 * 1024; // 3MB
const uploadNsfw = multer({
	dest: uploadsDir,
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
	upload,
	uploadNsfw,
	MAX_NSFW_FILE_SIZE
};
