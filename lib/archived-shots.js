/**
 * 已归档会话截图（`dsh-archived-shots`）—— 清理核心。
 *
 * 纯 Node，不依赖 Harness API，所以 Host 入口、HTTP 路由、斜杠命令与 Agent
 * 工具四条路共用同一份实现（与 lib/cleaner.js 同样的分工）。
 *
 * 这个目标删的不是「缓存」，而是**能证明属于已归档会话、且内容与台账逐字节一致
 * 的截图**。判定规则写在 notes/dsh-archive-shots/spec.md，这里只复述要点：
 *
 * 1. 「已归档」只认 <DSH_HOME>/storages/workspace.json 的 global.archivedSessionIds；
 *    目录名、workspace 记账、projcache 里的同名字段都不算。
 * 2. 截图归属靠会话日志里 tool/call(工具名) ←callId→ tool/result(路径) 的连接；
 *    只有 computer_shot / computer_marks / computer_batch 才算「产出」，
 *    read_image 一类才算「真的读过」，其余（pwsh/grep 列目录印出文件名）只是「提及」。
 *    提及不建立依赖，因此不阻止删除，但要如实计数。
 * 3. 会话日志是多帧 zstd 拼接流，必须逐帧解压（只解第一帧会得到 225 字节的会话头）。
 * 4. 子会话（头部带 parentSession、id 是裸 uuid）不在归档集合里，归档状态随父会话。
 * 5. 三重约束同时成立才删：台账有记录、字节数与 sha256 与记录一致、没有活跃会话
 *    产出或读过它，且至少有一个产出方。
 *
 * 安全边界（与 cleaner.js 一致）：只打开白名单根目录、只删根目录的**内容**、
 * 符号链接只跳过绝不跟随、任何单个失败都计为跳过而不中断整轮。
 */

import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';

/** 目标 id（cleaner.js 的 TARGET_IDS 里也有一份，两边必须一致）。 */
export const TARGET_ID = 'dsh-archived-shots';

/** 创建新截图文件的工具：只有这些算「产出」。 */
const CAPTURE_TOOLS = new Set(['computer_shot', 'computer_marks', 'computer_batch']);

/** 真正读取已有截图文件的工具：只有这些算「读过」，会阻止删除。 */
const CONSUMER_TOOLS = new Set(['read_image', 'computer_uia', 'computer_state']);

/** 截图文件名形如 shot-<date>_<time>-<ms>-<uuid>.jpg；毫秒段不补零（1–3 位）。 */
const SHOT_NAME_RE = /^shot-[\w-]+\.(?:jpg|png)$/;

/** 日志里出现的截图名，用于统计「提及」。 */
const SHOT_IN_TEXT_RE = /shot-\d{4}-\d{2}-\d{2}_[\d-]+-[0-9a-f-]{36}\.(?:jpg|png)/g;

const ZSTD_MAGIC = 0xfd2fb528;

/** DSH home：显式配置 > $DSH_HOME > ~/.dsh，与宿主约定一致。 */
export function resolveHome(configured) {
  if (typeof configured === 'string' && configured.length > 0) return configured;
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  return path.join(os.homedir(), '.dsh');
}

/** 这个目标涉及的三个位置。 */
export function resolvePaths(home) {
  const root = resolveHome(home);
  return {
    home: root,
    shots: path.join(root, 'data', 'computer-use', 'shots'),
    manifest: path.join(root, 'data', 'computer-use', 'owned-shots.jsonl'),
    registry: path.join(root, 'storages', 'workspace.json'),
    sessions: path.join(root, 'sessions'),
  };
}

/* ------------------------------------------------------------------ 日志解码 */

/**
 * 按帧结构扫描 zstd 帧边界，不依赖解压。
 *
 * 会话日志是**多帧拼接流**（一次打包一个帧），所以 `zstdDecompressSync(整个文件)`
 * 只能拿到第一帧——在本机实测会只剩 225 字节的会话头。这与
 * @deepseek-ai/dsh-session-log-export 以及 dsh-record-replay/lib/zstd.js 的做法一致。
 */
export function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    offset += 4;
    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) break;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, torn: true };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) break;
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, torn: true };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, torn: true };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames, torn: false };
}

/** 逐帧解压后拼接；尾部撕裂帧（写入中崩溃）跳过，与后端恢复语义一致。 */
export function decodeSessionLog(buffer) {
  const { frames, torn } = scanZstdFrames(buffer);
  const chunks = [];
  for (const frame of frames) {
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)));
    } catch {
      break;
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), frames: frames.length, torn };
}

/* ------------------------------------------------------------------ 台账读取 */

async function readArchiveSet(registryPath) {
  const raw = await fs.readFile(registryPath, 'utf8');
  const registry = JSON.parse(raw);
  const ids = registry?.global?.archivedSessionIds;
  if (!Array.isArray(ids)) {
    throw new Error(`${registryPath}: global.archivedSessionIds is missing or not an array`);
  }
  return new Set(ids.filter((id) => typeof id === 'string'));
}

/**
 * 读 owned-shots.jsonl。
 *
 * 一行坏掉只丢那一行（并计入 notes），不让整份台账不可用；这也意味着**坏行对应的
 * 文件不会被删**，方向是安全的。
 */
async function readManifest(manifestPath) {
  const entries = new Map();
  let malformed = 0;
  let raw;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch (error) {
    return { entries, malformed, missing: true, error };
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record.file === 'string') entries.set(record.file, record);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return { entries, malformed, missing: false };
}

/* ------------------------------------------------------------------ 会话扫描 */

/** 递归列出所有 .zstd 日志文件。符号链接目录不跟随。 */
async function listSessionLogs(sessionsRoot) {
  const out = [];
  async function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.zstd')) out.push(full);
    }
  }
  await walk(sessionsRoot, 0);
  return out;
}

/** 把 JSON 值里所有字符串摊平，便于按文本找截图名。 */
function collectStrings(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

/**
 * 扫一个会话日志，得出它「产出 / 读过 / 提及」了哪些截图。
 *
 * 关键：工具名只在 tool/call 上，结果事件的 message.toolCallId 指回它的 callId，
 * 所以必须先建 callId → 工具名 的映射再分类。只看结果事件会把 55 个截图全判成
 * 「无产出方」。
 */
function scanSessionLog(text) {
  const callTool = new Map();
  const resultShots = new Map(); // shot -> Set(callId)
  const mentioned = new Map(); // shot -> count
  let header = null;
  let firstTime = null;
  let lastTime = null;
  let unparsed = 0;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      unparsed += 1;
      continue;
    }
    if (event.type === 'session' && header === null) {
      header = event;
      continue;
    }
    if (typeof event.time === 'number') {
      if (firstTime === null || event.time < firstTime) firstTime = event.time;
      if (lastTime === null || event.time > lastTime) lastTime = event.time;
    }
    const data = event.data ?? {};
    if (event.type === 'tool/call' && typeof data.name === 'string' && typeof data.callId === 'string') {
      callTool.set(data.callId, data.name);
    }
    const names = new Set();
    for (const str of collectStrings(data)) {
      for (const match of str.matchAll(SHOT_IN_TEXT_RE)) names.add(match[0]);
    }
    if (names.size === 0) continue;
    if (event.type === 'tool/result') {
      const callId = data.message?.toolCallId ?? data.message?.source?.callId;
      for (const name of names) {
        if (!resultShots.has(name)) resultShots.set(name, new Set());
        resultShots.get(name).add(callId ?? '(no-callId)');
      }
    } else {
      for (const name of names) mentioned.set(name, (mentioned.get(name) ?? 0) + 1);
    }
  }

  const produced = new Map();
  const consumed = new Map();
  let unclassified = 0;
  for (const [shot, callIds] of resultShots) {
    for (const callId of callIds) {
      const tool = callTool.get(callId);
      if (tool && CAPTURE_TOOLS.has(tool)) produced.set(shot, (produced.get(shot) ?? 0) + 1);
      else if (tool && CONSUMER_TOOLS.has(tool)) consumed.set(shot, (consumed.get(shot) ?? 0) + 1);
      else {
        // 列目录式提及：记录但不当作依赖
        mentioned.set(shot, (mentioned.get(shot) ?? 0) + 1);
        unclassified += 1;
      }
    }
  }

  const parentId = typeof header?.parentSession === 'string' ? header.parentSession : null;
  return {
    sessionId: header?.id ?? null,
    parentId,
    isChild: parentId !== null,
    firstTime,
    lastTime,
    produced,
    consumed,
    mentioned,
    unclassified,
    unparsed,
  };
}

/**
 * 扫全部会话日志，得出每个截图的产出方与读者。
 *
 * 返回 sessionId → { archived, isChild, parentId } 也一并给出，便于报告解释
 * 「为什么某个文件被跳过」。
 */
export async function scanSessions(paths, archiveSet, options = {}) {
  const logs = await listSessionLogs(paths.sessions);
  const producedBy = new Map(); // shot -> Map(sessionId -> count)
  const consumedBy = new Map(); // shot -> Map(sessionId -> count)
  const mentionedBy = new Map(); // shot -> Map(sessionId -> count)
  const sessions = [];
  const notes = [];
  let unparsedLines = 0;
  let tornLogs = 0;

  for (const file of logs) {
    if (options.signal?.aborted) break;
    try {
      const { text, frames, torn } = decodeSessionLog(await fs.readFile(file));
      if (torn) tornLogs += 1;
      const scanned = scanSessionLog(text);
      unparsedLines += scanned.unparsed;
      const sessionId = scanned.sessionId ?? `UNKNOWN:${path.basename(path.dirname(file))}`;
      // 子会话不在归档集合里，归档状态随其父会话
      const archivedSelf = archiveSet.has(sessionId);
      const parentArchived = scanned.parentId !== null && archiveSet.has(scanned.parentId);
      const archived = archivedSelf || parentArchived;
      sessions.push({ sessionId, archived, archivedSelf, parentArchived, isChild: scanned.isChild, parentId: scanned.parentId, file, frames });
      const bump = (map, shot, count) => {
        if (!map.has(shot)) map.set(shot, new Map());
        map.get(shot).set(sessionId, count);
      };
      for (const [shot, count] of scanned.produced) bump(producedBy, shot, count);
      for (const [shot, count] of scanned.consumed) bump(consumedBy, shot, count);
      for (const [shot, count] of scanned.mentioned) bump(mentionedBy, shot, count);
    } catch (error) {
      notes.push(`${file}: ${error.code || error.message}`);
    }
  }

  const archivedById = new Map(sessions.map((s) => [s.sessionId, s.archived]));
  const toRows = (map, shot) =>
    [...(map.get(shot) ?? new Map())].map(([sessionId, count]) => ({
      sessionId,
      count,
      archived: archivedById.get(sessionId) ?? archiveSet.has(sessionId),
    }));

  return {
    producedBy,
    consumedBy,
    mentionedBy,
    sessions,
    archivedById,
    toRows,
    stats: { logs: logs.length, sessions: sessions.length, unparsedLines, tornLogs },
    notes,
  };
}

/* ------------------------------------------------------------------ 选择候选 */

/**
 * 挑出「可以删」的截图。
 *
 * 只做判定，不删任何东西；删除在 cleanArchivedShots 里按这个结果执行。返回逐文件
 * 的结论与理由，便于 dry-run 报告被人逐条复核。
 */
export async function selectArchivedShots(options = {}) {
  const paths = resolvePaths(options.home);
  const dryRun = options.dryRun !== false; // 默认只测量
  const notes = [];
  const rows = [];

  let archiveSet;
  try {
    archiveSet = await readArchiveSet(paths.registry);
  } catch (error) {
    return {
      ok: false,
      dryRun,
      reason: 'registry-unreadable',
      error: error.code || error.message,
      notes: [`${paths.registry}: ${error.code || error.message}`],
      selected: [],
      skipped: [],
      rows: [],
      stats: {},
    };
  }

  const manifest = await readManifest(paths.manifest);
  if (manifest.missing) {
    return {
      ok: false,
      dryRun,
      reason: 'manifest-unreadable',
      error: manifest.error?.code || manifest.error?.message,
      notes: [`${paths.manifest}: ${manifest.error?.code || manifest.error?.message}`],
      selected: [],
      skipped: [],
      rows: [],
      stats: { archiveSet: archiveSet.size },
    };
  }
  if (manifest.malformed > 0) notes.push(`${paths.manifest}: ${manifest.malformed} malformed line(s) ignored (their files will not be deleted)`);

  const scan = await scanSessions(paths, archiveSet, { signal: options.signal });
  notes.push(...scan.notes);

  let entries;
  try {
    entries = await fs.readdir(paths.shots, { withFileTypes: true });
  } catch (error) {
    return {
      ok: false,
      dryRun,
      reason: 'shots-unreadable',
      error: error.code || error.message,
      notes: [`${paths.shots}: ${error.code || error.message}`, ...notes],
      selected: [],
      skipped: [],
      rows: [],
      stats: { archiveSet: archiveSet.size, ...scan.stats },
    };
  }

  for (const entry of entries) {
    const full = path.join(paths.shots, entry.name);
    const row = { file: entry.name, path: full, bytes: 0, decision: 'skip', reason: '' };

    if (entry.isSymbolicLink()) {
      row.reason = 'symbolic-link';
      rows.push(row);
      continue;
    }
    if (!entry.isFile()) {
      row.reason = 'not-a-regular-file';
      rows.push(row);
      continue;
    }
    if (!SHOT_NAME_RE.test(entry.name)) {
      // 只处理截图命名，别的东西（人放进去的图片等）一律不碰
      row.reason = 'name-not-a-shot';
      rows.push(row);
      continue;
    }

    let stat;
    try {
      stat = await fs.lstat(full);
    } catch (error) {
      row.reason = `lstat-failed:${error.code || error.message}`;
      rows.push(row);
      continue;
    }
    row.bytes = Number(stat.size) || 0;

    const record = manifest.entries.get(entry.name);
    if (!record) {
      row.reason = 'no-manifest-record';
      rows.push(row);
      continue;
    }
    if (Number(record.size) !== row.bytes) {
      row.reason = `size-mismatch:manifest=${record.size}`;
      rows.push(row);
      continue;
    }
    let digest;
    try {
      digest = createHash('sha256').update(await fs.readFile(full)).digest('hex');
    } catch (error) {
      row.reason = `read-failed:${error.code || error.message}`;
      rows.push(row);
      continue;
    }
    if (typeof record.sha256 !== 'string' || digest !== record.sha256) {
      row.reason = 'sha256-mismatch';
      rows.push(row);
      continue;
    }

    const producers = scan.toRows(scan.producedBy, entry.name);
    const consumers = scan.toRows(scan.consumedBy, entry.name);
    const mentions = scan.toRows(scan.mentionedBy, entry.name);
    row.producers = producers.map((p) => p.sessionId);
    row.consumers = consumers.map((c) => c.sessionId);
    row.mentionedBy = mentions.map((m) => m.sessionId);

    if (producers.length === 0) {
      row.reason = 'no-producer';
      rows.push(row);
      continue;
    }
    const liveProducer = producers.find((p) => !p.archived);
    if (liveProducer) {
      row.reason = `live-producer:${liveProducer.sessionId}`;
      rows.push(row);
      continue;
    }
    const liveConsumer = consumers.find((c) => !c.archived);
    if (liveConsumer) {
      row.reason = `live-consumer:${liveConsumer.sessionId}`;
      rows.push(row);
      continue;
    }

    row.decision = 'delete';
    row.reason = 'archived-only-producer+verified';
    rows.push(row);
  }

  const selected = rows.filter((r) => r.decision === 'delete');
  const skipped = rows.filter((r) => r.decision !== 'delete');
  return {
    ok: true,
    dryRun,
    paths,
    notes,
    selected,
    skipped,
    rows,
    stats: {
      archiveSet: archiveSet.size,
      manifestEntries: manifest.entries.size,
      archiveIdsWithoutLog: [...archiveSet].filter((id) => !scan.archivedById.has(id)).length,
      ...scan.stats,
    },
  };
}

/**
 * 执行（或只模拟）这个目标的清理。
 *
 * dryRun 默认 **true**：只给出候选清单。真实删除必须显式 dryRun: false——
 * 这是本目标与其它缓存目标最大的不同，因为删掉的是会话证据的一部分。
 */
export async function cleanArchivedShots(options = {}) {
  const started = Date.now();
  const selection = await selectArchivedShots(options);
  const dryRun = selection.dryRun;

  const result = {
    dryRun,
    ok: selection.ok,
    reason: selection.reason,
    error: selection.error,
    bytes: 0,
    deleted: 0,
    skipped: selection.skipped.length,
    notes: selection.notes ?? [],
    files: [],
    /**
     * Every file that was NOT selected, with its reason. Operators need this:
     * "55 candidates" is only trustworthy if you can also see the 0–N files
     * that were held back and why.
     */
    skippedFiles: selection.skipped.map((row) => ({ file: row.file, bytes: row.bytes, reason: row.reason })),
    stats: selection.stats ?? {},
  };
  if (!selection.ok) {
    result.notes = [...(selection.notes ?? [])];
    result.durationMs = Date.now() - started;
    return result;
  }

  for (const row of selection.selected) {
    // dry-run 里 bytes 表示「将会释放」，不表示已释放
    result.bytes += row.bytes;
    if (dryRun) {
      result.files.push({ file: row.file, bytes: row.bytes, action: 'would-delete' });
      continue;
    }
    try {
      // 删除前重新核对一次，缩小「判定」与「动手」之间的窗口
      const stat = await fs.lstat(row.path);
      if (Number(stat.size) !== row.bytes) {
        result.skipped += 1;
        result.bytes -= row.bytes;
        result.files.push({ file: row.file, bytes: row.bytes, action: 'skipped', reason: 'changed-before-delete' });
        continue;
      }
      await fs.unlink(row.path);
      result.deleted += 1;
      result.files.push({ file: row.file, bytes: row.bytes, action: 'deleted' });
    } catch (error) {
      result.skipped += 1;
      result.bytes -= row.bytes;
      result.files.push({ file: row.file, bytes: row.bytes, action: 'skipped', reason: error.code || error.message });
    }
  }

  result.durationMs = Date.now() - started;
  return result;
}

/** 只测量：报告候选条数与字节数，绝不删除。 */
export async function measureArchivedShots(options = {}) {
  const selection = await selectArchivedShots({ ...options, dryRun: true });
  const bytes = selection.selected.reduce((sum, row) => sum + row.bytes, 0);
  return {
    ok: selection.ok,
    reason: selection.reason,
    bytes,
    files: selection.selected.length,
    skipped: selection.skipped.length,
    stats: selection.stats ?? {},
    notes: selection.notes ?? [],
    selected: selection.selected.map((row) => ({ file: row.file, bytes: row.bytes, producers: row.producers })),
    skippedRows: selection.skipped.map((row) => ({ file: row.file, reason: row.reason })),
  };
}
