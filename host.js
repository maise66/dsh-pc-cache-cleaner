/**
 * dsh-cache-cleaner Host half.
 *
 * One operation — `cleanCache()` from lib/cleaner.js — is exposed through
 * three callers, all sharing this single implementation:
 *
 *   1. `POST /cache-clean/run`  → the sidebar button in client.js
 *   2. `/cache-clean`           → the slash-command surface of dsh-commands
 *   3. `cache_clean`            → the agent tool registry (dsh-tools)
 *
 * Config (overridable from the profile's cordis.patch.yml):
 * - `enabled`  {boolean}  set `false` to turn the plugin off (default `true`)
 * - `targets`  {string[]} ids cleaned by every caller; defaults to
 *                         DEFAULT_TARGETS in lib/cleaner.js
 *
 * The cleaner import carries a `?gen=N` query on purpose: Node's ESM registry
 * keys modules by specifier, and the Host keeps a live process, so a plain
 * `./lib/cleaner.js` would stay pinned to the copy it first loaded. Bumping the
 * query (together with this entry being a fresh module generation after a
 * bundle enable) is what lets edited host code actually take effect.
 */

import { DEFAULT_TARGETS, TARGET_IDS, cleanCache, listDrives, summarize } from './lib/cleaner.js?gen=3';

/** HTTP route the browser half calls. Registered as an exact GET-less route. */
const RUN_ROUTE = '/cache-clean/run';

/**
 * Health/version probe: an authenticated `GET /cache-clean/ping` answers
 * `{"ok":true,"version":N}`. An unauthenticated caller only sees the 401, which
 * is still enough to tell the route exists.
 */
const PING_ROUTE = '/cache-clean/ping';

/** Bump when the host entry changes shape, so a stale module generation shows. */
const PLUGIN_VERSION = 2;

/** Rejected clients see this status when the host refuses the request. */
const FALLBACK_REJECTION = 403;

/** Keep only ids the cleaner knows; an empty list falls back to the default. */
function normalizeTargets(value, fallback = DEFAULT_TARGETS) {
  const ids = Array.isArray(value) ? value.filter((id) => TARGET_IDS.includes(id)) : [];
  return ids.length > 0 ? ids : fallback;
}

/** `/cache-clean temp dns` → ['temp', 'dns']; unknown words are ignored. */
function parseTargets(rawInput) {
  if (typeof rawInput !== 'string' || rawInput.trim() === '') return undefined;
  const ids = rawInput
    .split(/[\s,，、]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((id) => TARGET_IDS.includes(id));
  return ids.length > 0 ? ids : undefined;
}

/** Read a bounded request body as utf-8 text. */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

export function apply(ctx, config) {
  if (config?.enabled === false) return;

  const targets = normalizeTargets(config?.targets);

  /** One in-flight clean at a time; concurrent callers share the same run. */
  let current = null;
  const runClean = (options = {}) => {
    if (current !== null) return current;
    const pending = cleanCache({
      targets: normalizeTargets(options.targets, targets),
      dryRun: options.dryRun,
      signal: options.signal,
    }).finally(() => {
      if (current === pending) current = null;
    });
    current = pending;
    return pending;
  };

  // --- 1. HTTP route for the sidebar button -------------------------------
  ctx.inject(['webServer', 'connection'], (scope) => {
    const rejectUntrusted = (req, res) => {
      const rejection = scope.connection.requestRejection(req);
      if (rejection === undefined || rejection === null) return false;
      res.statusCode = Number(rejection) || FALLBACK_REJECTION;
      res.end();
      return true;
    };

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: RUN_ROUTE,
      handler: async (req, res) => {
        if (rejectUntrusted(req, res)) return;
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('allow', 'POST');
          res.end();
          return;
        }
        const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
        if (contentType !== '' && contentType !== 'application/json') {
          sendJson(res, 415, { ok: false, error: 'content-type must be application/json' });
          return;
        }
        try {
          await readBody(req);
          const report = await runClean({ targets });
          sendJson(res, 200, report);
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error?.message || String(error) });
        }
      },
    }), 'cache-cleaner: POST /cache-clean/run');

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: PING_ROUTE,
      handler: async (req, res) => {
        if (rejectUntrusted(req, res)) return;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405;
          res.setHeader('allow', 'GET, HEAD');
          res.end();
          return;
        }
        sendJson(res, 200, { ok: true, version: PLUGIN_VERSION, drives: await listDrives(), targets });
      },
    }), 'cache-cleaner: GET /cache-clean/ping');
  });

  // --- 2. slash command ----------------------------------------------------
  ctx.inject(['commands'], (scope) => {
    scope.effect(() => scope.commands.register({
      name: 'cache-clean',
      description: '清理电脑缓存：临时文件、Windows 更新缓存、缩略图、浏览器缓存、DNS；也可点名清 dsh-archived-shots（DSH 已归档会话截图）',
      input: { hint: '[temp windows-update thumbnails browser-cache dns npm-cache dsh-archived-shots]' },
      handler: async ({ rawInput }) => {
        try {
          const report = await runClean({ targets: parseTargets(rawInput) });
          return { kind: 'success', text: summarize(report) };
        } catch (error) {
          return { kind: 'error', text: error?.message || String(error) };
        }
      },
    }), 'cache-cleaner: /cache-clean command');
  });

  // --- 3. agent tool -------------------------------------------------------
  ctx.inject(['tools'], (scope) => {
    scope.effect(() => scope.tools.register({
      name: 'cache_clean',
      description: '清理这台电脑上的缓存文件（临时文件、Windows 更新缓存、缩略图、浏览器缓存、DNS 解析缓存），返回释放的字节数与逐项明细。不传参数时清理默认目标。\n\n'
        + '另有目标 dsh-archived-shots：DSH 已归档会话截图。它删的不是缓存，而是 $DSH_HOME/data/computer-use/shots 下**能证明属于已归档会话、且字节与 owned-shots.jsonl 台账逐字节一致**的截图；'
        + '活跃会话产出或读过的截图一律不碰。该目标**默认只试运行**（不删任何文件），要真的删必须传 dryRun: false，且建议先不传参看候选清单。',
      parameters: {
        type: 'object',
        properties: {
          targets: {
            type: 'array',
            description: `要清理的目标；省略时使用插件默认目标（${targets.join(', ')}）。`,
            items: {
              type: 'string',
              enum: [...TARGET_IDS],
            },
          },
          dryRun: {
            type: 'boolean',
            description: '只对 dsh-archived-shots 有效：true（默认）只报候选清单不删文件；false 才真的删除。其它缓存目标不受影响。',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            freedBytes: { type: 'number', description: '本次释放的字节数' },
            filesDeleted: { type: 'integer', description: '删除的文件数' },
            filesSkipped: { type: 'integer', description: '因占用或权限跳过的条目数' },
            durationMs: { type: 'integer', description: '耗时（毫秒）' },
            summary: { type: 'string', description: '中文一句话汇总' },
            targets: {
              type: 'array',
              description: '逐项明细',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  bytes: { type: 'number' },
                  deleted: { type: 'integer' },
                  skipped: { type: 'integer' },
                  dryRun: { type: 'boolean', description: '该目标本次是否为试运行（dsh-archived-shots 专用）' },
                  candidates: { type: 'integer', description: '试运行时会被删除的候选条数' },
                  skippedFiles: {
                    type: 'array',
                    description: '被挡下的文件与理由',
                    items: {
                      type: 'object',
                      properties: { file: { type: 'string' }, reason: { type: 'string' } },
                      additionalProperties: true,
                    },
                  },
                },
                additionalProperties: true,
              },
            },
          },
          required: ['freedBytes', 'filesDeleted', 'filesSkipped', 'durationMs', 'summary'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute(args, exec) {
        const report = await runClean({
          targets: parseTargets(Array.isArray(args?.targets) ? args.targets.join(' ') : ''),
          // Only an explicit `false` enables real deletion; anything else is a preview.
          dryRun: args?.dryRun !== false,
          signal: exec?.signal,
        });
        return { ...report, summary: summarize(report) };
      },
    }), 'cache-cleaner: cache_clean tool');
  });
}
