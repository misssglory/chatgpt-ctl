/** Last-resort recovery for Chromium downloads missed by Playwright events.
 * Only consider newly created completed files and reject ambiguous matches. */
import { readdir, stat, copyFile, mkdir, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export function browserDownloadDirectories(env = process.env, home = os.homedir()) {
  const dirs = [path.join(home, 'Downloads')];
  if (env.XDG_DOWNLOAD_DIR) dirs.unshift(env.XDG_DOWNLOAD_DIR.replace(/^\$HOME(?=\/|$)/, home));
  return [...new Set(dirs.map(p => path.resolve(p)))];
}
const unfinished = /\.(?:crdownload|part|partial|tmp|download)$/i;
export async function snapshotBrowserDownloads(dirs = browserDownloadDirectories()) {
  const files = new Map();
  for (const dir of dirs) {
    let names;
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names) {
      if (unfinished.test(name)) continue;
      const full = path.join(dir, name);
      try { const info = await stat(full); if (info.isFile()) files.set(full, `${info.size}:${info.mtimeMs}`); } catch { /* concurrent deletion */ }
    }
  }
  return files;
}
export function expectedDownloadExtension(label) {
  if (/\.zip\b|\bzip\b/i.test(label)) return '.zip';
  const ext = path.extname(label.trim()).toLowerCase();
  return /^\.[a-z\d]{1,12}$/.test(ext) ? ext : null;
}
async function zipSignatureValid(p) {
  const h = await open(p, 'r');
  try { const buf = Buffer.alloc(4); const r = await h.read(buf, 0, 4, 0);
    return r.bytesRead === 4 && buf[0] === 0x50 && buf[1] === 0x4b &&
      ((buf[2] === 3 && buf[3] === 4) || (buf[2] === 5 && buf[3] === 6) || (buf[2] === 7 && buf[3] === 8));
  } finally { await h.close(); }
}
export async function recoverBrowserDownload({ before, label, directory, dirs = browserDownloadDirectories(), sleep = ms => new Promise(r => setTimeout(r, ms)), attempts = 8 }) {
  const ext = expectedDownloadExtension(label);
  const literalName = path.basename(label.trim());
  const exact = literalName.toLowerCase().endsWith(ext || '\0') ? literalName.toLowerCase() : null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const current = await snapshotBrowserDownloads(dirs);
    const matches = [];
    for (const [full, signature] of current) {
      if (before.has(full) || !signature || unfinished.test(full)) continue;
      if (ext && path.extname(full).toLowerCase() !== ext) continue;
      if (exact && path.basename(full).toLowerCase() !== exact) continue;
      const info = await stat(full).catch(() => null);
      if (!info || !info.isFile() || info.size === 0) continue;
      matches.push({ full, signature });
    }
    // Fail closed if multiple new files satisfy the requested extension.
    if (matches.length === 1) {
      const match = matches[0];
      await sleep(400);
      const after = await stat(match.full).catch(() => null);
      if (after && `${after.size}:${after.mtimeMs}` === match.signature && (!ext || ext !== '.zip' || await zipSignatureValid(match.full))) {
        await mkdir(directory, { recursive: true });
        const dest = path.join(directory, `${randomUUID().slice(0, 8)}-${path.basename(match.full)}`);
        await copyFile(match.full, dest);
        const copied = await stat(dest);
        if (copied.size !== after.size || (ext === '.zip' && !(await zipSignatureValid(dest)))) throw new Error('Recovered browser download failed integrity verification');
        return dest;
      }
    }
    if (matches.length > 1) return null;
    await sleep(350);
  }
  return null;
}
