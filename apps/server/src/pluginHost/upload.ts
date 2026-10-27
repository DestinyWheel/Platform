import { mkdir } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { PluginError } from './types.js';

/** 解压上传包到临时目录，顺带做路径穿越检查（zip-slip） */
export async function extractPackage(buffer: Buffer, tmpRoot: string): Promise<string> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new PluginError('bad_package', '不是合法的 zip 包');
  }

  const entries = zip.getEntries();
  if (entries.length === 0) throw new PluginError('bad_package', 'zip 包是空的');

  for (const entry of entries) {
    const name = entry.entryName.replace(/\\/g, '/');
    if (name.startsWith('/') || name.split('/').includes('..') || /^[a-zA-Z]:/.test(name)) {
      throw new PluginError('bad_package', `包内路径不合法：${entry.entryName}`);
    }
  }

  await mkdir(tmpRoot, { recursive: true });
  const { mkdtemp } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(tmpRoot, 'upload-'));
  zip.extractAllTo(dir, true);

  // 允许 zip 里多包一层目录（很常见：dice-0.1.0/manifest.json）
  const children = await readdir(dir, { withFileTypes: true });
  if (children.length === 1 && children[0]?.isDirectory()) {
    return path.join(dir, children[0].name);
  }
  return dir;
}
