/**
 * 把一个游戏目录打成 zip，用于后台上传。
 *
 * 用法：node scripts/pack-game.mjs games/dice [输出路径]
 * 产物默认落在 storage/packages/<id>-<version>.zip
 */
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

const sourceDir = process.argv[2];
if (!sourceDir) {
  console.error('用法：node scripts/pack-game.mjs <游戏目录> [输出路径]');
  process.exit(1);
}

const manifest = JSON.parse(await readFile(path.join(sourceDir, 'manifest.json'), 'utf8'));
const outFile =
  process.argv[3] ?? path.join('storage', 'packages', `${manifest.id}-${manifest.version}.zip`);

const zip = new AdmZip();

async function addDirectory(dir, prefix) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await addDirectory(full, name);
    } else if (/\.(ts|tsx|js|mjs|json|css|html)$/.test(entry.name)) {
      zip.addFile(name, await readFile(full));
    }
  }
}

zip.addFile('manifest.json', await readFile(path.join(sourceDir, 'manifest.json')));
await addDirectory(path.join(sourceDir, 'src'), 'src');

await mkdir(path.dirname(outFile), { recursive: true });
zip.writeZip(outFile);

const info = await stat(outFile);
console.log(
  `已打包 ${manifest.id}@${manifest.version} → ${outFile} (${(info.size / 1024).toFixed(1)} KB)`,
);
console.log('上传：');
console.log(`  curl -X POST http://127.0.0.1:8787/api/admin/plugins \\`);
console.log(`    -H "authorization: Bearer <token>" \\`);
console.log(`    -H "content-type: application/zip" --data-binary "@${outFile}"`);
