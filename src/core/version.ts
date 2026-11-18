/** 版本号单一来源：从最近的 package.json 读取 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function packageVersion(): string {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      const f = path.join(dir, 'package.json');
      if (fs.existsSync(f)) {
        const j = JSON.parse(fs.readFileSync(f, 'utf8')) as { name?: string; version?: string };
        if (j.name === 'forgeapi' && j.version) return j.version;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* ignore */ }
  return '0.0.0';
}

export const VERSION = packageVersion();