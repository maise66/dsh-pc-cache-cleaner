/**
 * Core cache-cleaning logic for the dsh-cache-cleaner bundle.
 *
 * Pure Node (no Harness APIs) so the Host entry, the HTTP route, the slash
 * command and the agent tool all share one implementation.
 *
 * Safety rules baked into this module:
 * - only the roots listed by a target are ever opened, and only their
 *   *contents* are removed (a root directory itself is never deleted);
 * - symlinks and junctions are skipped, never followed;
 * - every failure (locked file, access denied, missing folder) is counted as a
 *   skip instead of aborting the run, so one busy browser cannot fail a clean.
 */

import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { TARGET_ID as ARCHIVED_SHOTS_ID, cleanArchivedShots, measureArchivedShots } from './archived-shots.js';

const execFileAsync = promisify(execFile);

/**
 * Cache groups the plugin knows about; `dns` is a flush, the rest are folders.
 *
 * `dsh-archived-shots` is the odd one out: it is not a cache but a *narrow,
 * evidence-based* deletion of screenshots that provably belong to archived
 * sessions. It is NOT in DEFAULT_TARGETS on purpose — deleting it by accident
 * would remove part of a session's evidence, so it must be named explicitly.
 */
export const TARGET_IDS = ['temp', 'windows-update', 'thumbnails', 'browser-cache', 'dns', 'npm-cache', 'dsh-archived-shots'];

/** Cleaned when the caller passes no explicit list. */
export const DEFAULT_TARGETS = ['temp', 'windows-update', 'thumbnails', 'browser-cache', 'dns'];

/** Display names for the report. */
export const TARGET_NAMES = {
  'temp': '系统临时文件（全盘）',
  'windows-update': 'Windows 更新缓存（全盘）',
  'thumbnails': '缩略图缓存',
  'browser-cache': '浏览器缓存',
  'dns': 'DNS 解析缓存',
  'npm-cache': 'npm 下载缓存',
  'dsh-archived-shots': 'DSH 已归档会话截图',
};

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

function roamingAppData() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

function systemRoot() {
  return process.env.SystemRoot || 'C:\\Windows';
}

/** Candidate folders under one Chromium "User Data" directory. */
const CHROMIUM_CACHE_DIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnGraphiteCache',
  'Service Worker/CacheStorage',
];

/** Chromium-based browsers, as [label, path under LocalAppData]. */
const CHROMIUM_BROWSERS = [
  ['Google/Chrome', 'Google/Chrome/User Data'],
  ['Microsoft/Edge', 'Microsoft/Edge/User Data'],
  ['BraveSoftware/BraveBrowser', 'BraveSoftware/BraveBrowser/User Data'],
  ['Chromium', 'Chromium/User Data'],
];

/** Opera keeps its profile in Roaming: [label, path under APPDATA]. */
const OPERA_BROWSERS = [
  ['Opera', 'Opera Software/Opera Stable'],
  ['Opera GX', 'Opera Software/Opera GX Stable'],
];

async function isDirectory(target) {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function listDirectories(root) {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

/** Every Chromium cache folder that exists right now, across profiles. */
async function chromiumCacheRoots() {
  const roots = [];
  for (const [, rel] of CHROMIUM_BROWSERS) {
    const userData = path.join(localAppData(), rel);
    for (const profile of await listDirectories(userData)) {
      for (const cache of CHROMIUM_CACHE_DIRS) {
        const candidate = path.join(profile, cache);
        if (await isDirectory(candidate)) roots.push(candidate);
      }
    }
  }
  for (const [, rel] of OPERA_BROWSERS) {
    const profile = path.join(roamingAppData(), rel);
    for (const cache of ['Cache', 'Code Cache', 'GPUCache', 'Service Worker/CacheStorage']) {
      const candidate = path.join(profile, cache);
      if (await isDirectory(candidate)) roots.push(candidate);
    }
  }
  // Firefox: %LocalAppData%\Mozilla\Firefox\Profiles\<profile>\cache2
  for (const profile of await listDirectories(path.join(localAppData(), 'Mozilla/Firefox/Profiles'))) {
    const candidate = path.join(profile, 'cache2');
    if (await isDirectory(candidate)) roots.push(candidate);
  }
  return roots;
}

/** Thumbnail/icon databases are single files, not folders. */
async function thumbnailFiles() {
  const explorer = path.join(localAppData(), 'Microsoft/Windows/Explorer');
  const files = [];
  try {
    for (const name of await fs.readdir(explorer)) {
      if (/^(thumbcache|iconcache)_.*\.db$/i.test(name)) files.push(path.join(explorer, name));
    }
  } catch {
    /* explorer cache folder missing: nothing to clean */
  }
  return files;
}

/** Every mounted drive letter, e.g. `['C:', 'D:']`, system drive first. */
export async function listDrives() {
  const system = (process.env.SystemDrive || 'C:').replace(/\/+$/, '').toUpperCase();
  const drives = [];
  for (let code = 65; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:`;
    try {
      const stat = await fs.stat(`${drive}\\`);
      if (stat.isDirectory()) drives.push(drive);
    } catch {
      /* empty drive letter or unplugged media */
    }
  }
  return [system, ...drives.filter((drive) => drive !== system)];
}

/** Drop candidates that do not exist, so missing roots never count as skips. */
async function existingPaths(candidates) {
  const seen = new Set();
  const kept = [];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isDirectory() || stat.isFile()) kept.push(candidate);
    } catch {
      /* absent on this machine */
    }
  }
  return kept;
}

/** Resolve one target id to the concrete roots it should clean. */
export async function resolveRoots(id) {
  switch (id) {
    case 'temp': {
      const candidates = [os.tmpdir(), path.join(systemRoot(), 'Temp')];
      for (const drive of await listDrives()) {
        candidates.push(`${drive}\\Temp`, `${drive}\\Windows\\Temp`);
      }
      return existingPaths(candidates);
    }
    case 'windows-update': {
      const candidates = [];
      for (const drive of await listDrives()) {
        candidates.push(`${drive}\\Windows\\SoftwareDistribution\\Download`);
      }
      return existingPaths(candidates);
    }
    case 'browser-cache':
      return chromiumCacheRoots();
    case 'npm-cache': {
      const npm = process.env.npm_config_cache || path.join(os.homedir(), 'AppData', 'Local', 'npm-cache');
      return path.isAbsolute(npm) ? [npm] : [];
    }
    case 'thumbnails':
      return thumbnailFiles();
    case 'dsh-archived-shots':
      // Not a plain root: this target is decided per file against two ledgers,
      // so it never goes through the generic tree-walk path. Reported here only
      // so callers that ask "where would this target look" get an answer.
      return existingPaths([path.join(resolveDshHome(), 'data', 'computer-use', 'shots')]);
    default:
      return [];
  }
}

/** DSH home, matching the harness convention: $DSH_HOME, else ~/.dsh. */
function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** Run one directory tree deletion with a small bounded pool. */
async function cleanTree(root, acc) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    acc.skipped += 1;
    if (acc.notes.length < 20) acc.notes.push(`${root}: ${error.code || error.message}`);
    return;
  }
  await mapLimit(entries, 8, async (entry) => {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      acc.skipped += 1;
      return;
    }
    if (entry.isDirectory()) {
      await cleanTree(full, acc);
      // Only ever remove the folder when it is empty, so a folder holding a
      // locked file (and any skip we recorded) survives.
      try {
        await fs.rmdir(full);
      } catch {
        /* not empty, or in use: keep it */
      }
      return;
    }
    if (!entry.isFile()) {
      acc.skipped += 1;
      return;
    }
    try {
      const stat = await fs.lstat(full);
      await fs.unlink(full);
      acc.bytes += Number(stat.size) || 0;
      acc.deleted += 1;
    } catch (error) {
      acc.skipped += 1;
      if (acc.notes.length < 20) acc.notes.push(`${full}: ${error.code || error.message}`);
    }
  });
}

/** Delete one single file target (thumbnail databases). */
async function cleanFile(file, acc) {
  try {
    const stat = await fs.lstat(file);
    await fs.unlink(file);
    acc.bytes += Number(stat.size) || 0;
    acc.deleted += 1;
  } catch (error) {
    acc.skipped += 1;
    if (acc.notes.length < 20) acc.notes.push(`${file}: ${error.code || error.message}`);
  }
}

/** Bounded-concurrency map preserving input order. */
async function mapLimit(items, limit, worker) {
  const queue = items.slice();
  const runners = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function flushDns() {
  await execFileAsync('ipconfig', ['/flushdns'], { windowsHide: true, timeout: 15_000 });
}

/**
 * Clean the given cache targets.
 *
 * @param options.targets - target ids; defaults to {@link DEFAULT_TARGETS}.
 * @param options.signal - optional AbortSignal, honoured between targets.
 * @returns aggregated report: freed bytes, per-target rows and skip notes.
 */
export async function cleanCache(options = {}) {
  const ids = (Array.isArray(options.targets) && options.targets.length > 0 ? options.targets : DEFAULT_TARGETS)
    .filter((id) => TARGET_IDS.includes(id));
  const started = Date.now();
  const rows = [];
  const totals = { bytes: 0, deleted: 0, skipped: 0 };

  for (const id of ids) {
    if (options.signal?.aborted) break;
    const row = { id, name: TARGET_NAMES[id] || id, bytes: 0, deleted: 0, skipped: 0, notes: [] };
    try {
      if (id === 'dns') {
        await flushDns();
        row.deleted = 1;
      } else if (id === ARCHIVED_SHOTS_ID) {
        /**
         * Screenshots are not a cache: every file is decided against the
         * archive set and the owned-shots ledger, and the whole target runs in
         * dry-run unless the caller explicitly opts in. `row.dryRun` tells the
         * caller that `bytes` is "would free", not "freed".
         */
        const dryRun = options.dryRun !== false;
        const report = await cleanArchivedShots({ home: options.dshHome, dryRun, signal: options.signal });
        row.bytes = report.bytes;
        row.deleted = report.deleted;
        row.skipped = report.skipped;
        row.dryRun = dryRun;
        row.candidates = report.files.filter((f) => f.action === 'would-delete').length;
        row.ok = report.ok;
        row.reason = report.reason;
        row.stats = report.stats;
        if (report.notes?.length) row.notes.push(...report.notes.slice(0, 20));
      } else {
        const acc = { bytes: 0, deleted: 0, skipped: 0, notes: row.notes };
        const roots = await existingPaths(await resolveRoots(id));
        if (roots.length === 0) {
          row.skipped = 0;
          row.missing = true;
        }
        for (const root of roots) {
          if (options.signal?.aborted) break;
          if (id === 'thumbnails') await cleanFile(root, acc);
          else await cleanTree(root, acc);
        }
        row.bytes = acc.bytes;
        row.deleted = acc.deleted;
        row.skipped = acc.skipped;
      }
    } catch (error) {
      row.skipped += 1;
      if (row.notes.length < 20) row.notes.push(error.code || error.message || String(error));
    }
    totals.bytes += row.bytes;
    totals.deleted += row.deleted;
    totals.skipped += row.skipped;
    rows.push(row);
  }

  return {
    ok: true,
    drives: await listDrives(),
    freedBytes: totals.bytes,
    filesDeleted: totals.deleted,
    filesSkipped: totals.skipped,
    durationMs: Date.now() - started,
    targets: rows,
  };
}

/** Measure what a single target would free, without deleting anything. */
export async function measureCache(options = {}) {
  const ids = (Array.isArray(options.targets) && options.targets.length > 0 ? options.targets : DEFAULT_TARGETS)
    .filter((id) => TARGET_IDS.includes(id));
  const rows = [];
  const totals = { bytes: 0, files: 0 };
  for (const id of ids) {
    const row = { id, name: TARGET_NAMES[id] || id, bytes: 0, files: 0 };
    if (id === ARCHIVED_SHOTS_ID) {
      /**
       * Measuring this target means running the real selection rule, not
       * summing a directory: the answer is "how much of this folder is
       * provably deletable", which is smaller than the folder.
       */
      const report = await measureArchivedShots({ home: options.dshHome, signal: options.signal });
      row.bytes = report.bytes;
      row.files = report.files;
      row.skipped = report.skipped;
      row.ok = report.ok;
      row.reason = report.reason;
      row.stats = report.stats;
      row.selected = report.selected;
      row.skippedRows = report.skippedRows;
      if (report.notes?.length) row.notes = report.notes.slice(0, 20);
    } else if (id !== 'dns') {
      const roots = await existingPaths(await resolveRoots(id));
      for (const root of roots) {
        if (id === 'thumbnails') {
          try {
            const stat = await fs.lstat(root);
            row.bytes += Number(stat.size) || 0;
            row.files += 1;
          } catch {
            /* vanished */
          }
        } else {
          await measureTree(root, row);
        }
      }
    }
    totals.bytes += row.bytes;
    totals.files += row.files;
    rows.push(row);
  }
  return { ok: true, drives: await listDrives(), totalBytes: totals.bytes, totalFiles: totals.files, targets: rows };
}

async function measureTree(root, row) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await measureTree(full, row);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const stat = await fs.lstat(full);
      row.bytes += Number(stat.size) || 0;
      row.files += 1;
    } catch {
      /* vanished between readdir and lstat */
    }
  }
}

/** Human-readable size, e.g. `1.2 GB`. */
export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${String(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 100 ? String(Math.round(size)) : size.toFixed(1)} ${units[index]}`;
}

/** One-line summary used by the command result and the tool result. */
export function summarize(report) {
  const parts = report.targets
    .filter((row) => row.deleted > 0 || row.bytes > 0)
    .map((row) => {
      if (row.id === 'dns') return `${row.name}：已刷新`;
      // A preview must not read as freed space.
      if (row.dryRun) return `${row.name}：试运行，可清 ${formatBytes(row.bytes)}（未删除）`;
      return `${row.name}：${formatBytes(row.bytes)}`;
    });
  const cleaned = parts.length > 0 ? parts.join('，') : '没有可清理的内容';
  const preview = report.targets.some((row) => row.dryRun);
  const verb = preview ? '预计释放' : '已释放';
  return `${verb} ${formatBytes(report.freedBytes)}（删除 ${String(report.filesDeleted)} 项，跳过 ${String(report.filesSkipped)} 项，耗时 ${(report.durationMs / 1000).toFixed(1)} 秒）。${cleaned}。`;
}
