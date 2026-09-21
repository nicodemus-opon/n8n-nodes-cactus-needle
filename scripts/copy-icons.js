// Cross-platform icon copy (replaces `mkdir -p dist/icons && cp icons/*.svg dist/icons/`).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'icons');
const dest = path.join(root, 'dist', 'icons');

fs.mkdirSync(dest, { recursive: true });
for (const file of fs.readdirSync(src)) {
	if (file.endsWith('.svg')) {
		fs.copyFileSync(path.join(src, file), path.join(dest, file));
	}
}
console.log('[copy:icons] done');
