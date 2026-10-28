/**
 * Session-shredder core: discover and permanently remove the on-disk footprint
 * of DSH sessions.
 *
 * The DSH session-persistence seam deliberately has no delete API, so removal
 * is filesystem work. The rules encoded here:
 *
 *  - only ever touch paths below the configured data directory;
 *  - refuse the current session and any session live in this process;
 *  - delete the session's whole project/session directory (every historical
 *    format generation), its projection-cache record, and its record in the
 *    legacy cache seed document;
 *  - delete an attachment object only when a complete reference scan of every
 *    surviving session proves no survivor uses it.
 *
 * Nothing here asks for approval; the caller owns that gate.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Session ids: harness chats use `session-<token>`; subagent chats use a bare UUID. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Content-addressed attachment ids. */
const ATTACHMENT_ID_PATTERN = /^sha256:([a-f0-9]{64})$/;
/** One path-safe character in the persistence backend's encoding. */
const SAFE_CODE_UNIT = /^[A-Za-z0-9._-]$/;

/** A user-visible, attributable purge failure. */
export class PurgeError extends Error {
  constructor(message, code = 'SESSION_PURGE_FAILED') {
    super(message);
    this.name = 'PurgeError';
    this.code = code;
  }
}

/**
 * Encode one raw string as a single safe path segment, matching the JSONL
 * persistence backend so a computed directory always names that backend's
 * directory. Injectable over all JS strings (including lone surrogates).
 *
 * @param {string} raw
 * @returns {string}
 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new PurgeError('cannot encode an empty path segment', 'INVALID_SESSION_ID');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && SAFE_CODE_UNIT.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/**
 * Inverse of {@link encodeSegment} for reading project directory names.
 *
 * @param {string} segment
 * @returns {string}
 */
export function decodeSegment(segment) {
  let out = '';
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === '~' && /^[0-9A-Fa-f]{4}$/.test(segment.slice(i + 1, i + 5))) {
      out += String.fromCharCode(parseInt(segment.slice(i + 1, i + 5), 16));
      i += 4;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Resolve and validate plugin configuration into absolute defaults.
 *
 * @param {Record<string, unknown>} [config]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {() => string} [homedir]
 * @returns {{
 *   dataDir: string,
 *   sessionsRoot: string,
 *   storagesRoot: string,
 *   projectionCacheRoot: string,
 *   projectionCacheSeed: string,
 *   attachmentsRoot: string,
 *   requestImageCacheRoot: string,
 *   requireApproval: boolean,
 *   secureOverwrite: boolean,
 *   purgeAttachments: boolean,
 *   clearRequestImageCache: boolean,
 *   attachmentMinAgeMs: number,
 *   attachmentScanMaxEvents: number,
 *   listLimit: number,
 *   maxTargets: number
 * }}
 */
export function resolveOptions(config = {}, env = process.env, homedir = os.homedir) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new PurgeError('plugin config must be an object', 'INVALID_CONFIG');
  }
  const home = typeof config.dataDir === 'string' && config.dataDir.trim() !== ''
    ? path.resolve(config.dataDir)
    : path.resolve(env.DSH_HOME || path.join(homedir(), '.dsh'));
  const sessionsRoot = absolute(config.sessionsRoot, path.join(home, 'sessions'), 'sessionsRoot');
  const storagesRoot = absolute(config.storagesRoot, path.join(home, 'storages'), 'storagesRoot');
  const projectionCacheRoot = absolute(
    config.projectionCacheRoot,
    path.join(storagesRoot, 'session_projcache', 'sessions'),
    'projectionCacheRoot',
  );
  const attachmentsRoot = absolute(
    config.attachmentsRoot,
    path.join(home, 'attachments', 'v1'),
    'attachmentsRoot',
  );
  const requestImageCacheRoot = absolute(
    config.requestImageCacheRoot,
    path.join(home, 'cache', 'attachments', 'request-images'),
    'requestImageCacheRoot',
  );
  for (const [label, root] of [['dataDir', home], ['sessionsRoot', sessionsRoot], ['storagesRoot', storagesRoot]]) {
    if (path.parse(root).root === root) throw new PurgeError(`${label} must not be a filesystem root`, 'INVALID_CONFIG');
  }
  return {
    dataDir: home,
    sessionsRoot,
    storagesRoot,
    projectionCacheRoot,
    projectionCacheSeed: path.join(storagesRoot, 'session_projcache.json'),
    attachmentsRoot,
    requestImageCacheRoot,
    requireApproval: config.requireApproval !== false,
    secureOverwrite: config.secureOverwrite === true,
    purgeAttachments: config.purgeAttachments !== false,
    clearRequestImageCache: config.clearRequestImageCache !== false,
    attachmentMinAgeMs: integerAtLeast(config.attachmentMinAgeMs, 10 * 60_000, 0),
    attachmentScanMaxEvents: integerAtLeast(config.attachmentScanMaxEvents, 50_000, 100),
    listLimit: integerAtLeast(config.listLimit, 50, 1),
    maxTargets: integerAtLeast(config.maxTargets, 50, 1),
  };
}

function absolute(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.trim() === '') throw new PurgeError(`${label} must be a non-empty path string`, 'INVALID_CONFIG');
  return path.resolve(value);
}

function integerAtLeast(value, fallback, min) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min) throw new PurgeError(`expected an integer >= ${min}, got ${String(value)}`, 'INVALID_CONFIG');
  return value;
}

/**
 * Parse and validate one session id before any filesystem work.
 *
 * @param {unknown} id
 * @returns {string}
 */
export function assertSessionId(id) {
  if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) {
    throw new PurgeError(`invalid session id: ${JSON.stringify(id)} (expected a safe session id such as session-<token> or a subagent UUID)`, 'INVALID_SESSION_ID');
  }
  return id;
}

/** Human byte count, e.g. `1.4 MiB`. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Whether `target` is strictly below `root` after resolution. */
export function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function lstatOrUndefined(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function statOrUndefined(target) {
  try {
    return await fs.stat(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Walk one directory without following symlinks.
 *
 * @param {string} root
 * @returns {Promise<{ files: Array<{path: string, size: number, symlink: boolean, mtimeMs: number}>, directories: string[], bytes: number }>}
 */
export async function walkTree(root) {
  const files = [];
  const directories = [root];
  let bytes = 0;

  async function visit(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const stat = await lstatOrUndefined(target);
      if (stat === undefined) continue;
      if (stat.isSymbolicLink()) {
        files.push({ path: target, size: stat.size, symlink: true, mtimeMs: stat.mtimeMs });
      } else if (stat.isDirectory()) {
        directories.push(target);
        await visit(target);
      } else if (stat.isFile()) {
        files.push({ path: target, size: stat.size, symlink: false, mtimeMs: stat.mtimeMs });
        bytes += stat.size;
      }
    }
  }

  if (await statOrUndefined(root)) {
    const rootStat = await lstatOrUndefined(root);
    if (rootStat === undefined || !rootStat.isDirectory()) return { files, directories, bytes };
    await visit(root);
  }
  return { files, directories, bytes };
}

/**
 * Index every session directory the persistence backend owns below `root`.
 * The backend's on-disk shape is `<root>/<project>/<encoded-session-id>/`.
 *
 * @param {string} root
 * @returns {Promise<Map<string, string[]>>} session id -> session directories
 */
export async function indexSessionDirs(root) {
  const index = new Map();
  let projects;
  try {
    projects = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return index;
    throw error;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(root, project.name);
    const projectStat = await lstatOrUndefined(projectDir);
    if (projectStat === undefined || !projectStat.isDirectory()) continue;
    let entries;
    try {
      entries = await fs.readdir(projectDir, { withFileTypes: true });
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(projectDir, entry.name);
      const directoryStat = await lstatOrUndefined(directory);
      if (directoryStat === undefined || !directoryStat.isDirectory()) continue;
      const id = decodeSegment(entry.name);
      const list = index.get(id);
      if (list === undefined) index.set(id, [directory]);
      else list.push(directory);
    }
  }
  return index;
}

/**
 * Project the identity fields needed for cache-record matching.
 *
 * @param {{ id: string, header?: any } | undefined} snapshot
 */
function headerFacts(snapshot) {
  return snapshot?.header === undefined
    ? undefined
    : {
        createdAt: snapshot.header.createdAt,
        cwd: snapshot.header.cwd,
        parentSession: snapshot.header.parentSession,
        delegationDepth: snapshot.header.delegationDepth,
      };
}

async function safeTitle(ctx, id) {
  const query = ctx.get?.('sessionQuery');
  if (query === undefined || typeof query.readTitle !== 'function') return undefined;
  try {
    const snapshot = await query.readTitle(id);
    return typeof snapshot?.title === 'string' ? snapshot.title : undefined;
  } catch {
    return undefined;
  }
}

function liveAgentIds(ctx) {
  const agents = ctx.get?.('agents');
  if (agents === undefined || typeof agents.list !== 'function') return new Set();
  try {
    return new Set(agents.list().map((agent) => agent.id));
  } catch {
    return new Set();
  }
}

async function listSnapshots(persistence, signal) {
  try {
    return await persistence.list(signal === undefined ? undefined : { signal });
  } catch (error) {
    throw new PurgeError(`cannot list stored sessions: ${error?.message ?? String(error)}`, 'SESSION_LIST_FAILED');
  }
}

/**
 * Enumerate every stored and on-disk session for the list/plan surfaces.
 *
 * @param {any} ctx
 * @param {ReturnType<typeof resolveOptions>} options
 * @param {{ limit?: number, signal?: AbortSignal }} [request]
 */
export async function listSessions(ctx, options, request = {}) {
  const persistence = ctx.sessionPersistence;
  const snapshots = await listSnapshots(persistence, request.signal);
  const byId = new Map(snapshots.map((snapshot) => [snapshot.header.id, snapshot]));
  const dirIndex = await indexSessionDirs(options.sessionsRoot);
  const live = liveAgentIds(ctx);
  const currentSessionId = request.currentSessionId;
  const limit = Number.isInteger(request.limit)
    ? Math.min(Math.max(request.limit, 1), 500)
    : options.listLimit;

  const ids = new Set([...byId.keys(), ...dirIndex.keys()]);
  const rows = [];
  for (const id of ids) {
    const snapshot = byId.get(id);
    const dirs = dirIndex.get(id) ?? [];
    let bytes = 0;
    let latestMtime = 0;
    for (const dir of dirs) {
      let tree;
      try {
        tree = await walkTree(dir);
      } catch {
        continue;
      }
      bytes += tree.bytes;
      for (const file of tree.files) latestMtime = Math.max(latestMtime, file.mtimeMs);
    }
    rows.push({
      id,
      title: await safeTitle(ctx, id),
      cwd: snapshot?.header?.cwd,
      createdAt: snapshot?.header?.createdAt,
      parentSession: snapshot?.header?.parentSession,
      eventCount: snapshot?.eventCount,
      bytes,
      logDirs: dirs,
      stored: snapshot !== undefined,
      orphan: snapshot === undefined,
      live: live.has(id),
      current: id === currentSessionId,
      latestMtime: latestMtime || undefined,
    });
  }
  rows.sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1;
    return (right.createdAt ?? 0) - (left.createdAt ?? 0) || right.bytes - left.bytes;
  });
  const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
  return {
    total: rows.length,
    totalBytes,
    shown: rows.slice(0, limit),
    hidden: Math.max(0, rows.length - limit),
    sessionsRoot: options.sessionsRoot,
  };
}

/**
 * Build the deletion plan for a set of ids: exact directories, cache records,
 * sizes, and every reason the purge must refuse.
 *
 * @param {any} ctx
 * @param {ReturnType<typeof resolveOptions>} options
 * @param {string[]} ids
 * @param {{ currentSessionId?: string, signal?: AbortSignal }} [request]
 */
export async function planPurge(ctx, options, ids, request = {}) {
  const unique = [...new Set(ids.map(assertSessionId))];
  if (unique.length === 0) throw new PurgeError('at least one session id is required', 'INVALID_SESSION_ID');
  if (unique.length > options.maxTargets) {
    throw new PurgeError(`at most ${options.maxTargets} sessions may be purged in one call`, 'TOO_MANY_TARGETS');
  }
  const persistence = ctx.sessionPersistence;
  const snapshots = await listSnapshots(persistence, request.signal);
  const byId = new Map(snapshots.map((snapshot) => [snapshot.header.id, snapshot]));
  const dirIndex = await indexSessionDirs(options.sessionsRoot);
  const live = liveAgentIds(ctx);
  const now = Date.now();
  const targets = [];
  const blockers = [];
  const warnings = [];
  let totalBytes = 0;

  for (const id of unique) {
    if (request.signal?.aborted) throw new PurgeError('purge cancelled', 'ABORTED');
    const snapshot = byId.get(id);
    const dirs = dirIndex.get(id) ?? [];
    const cacheFiles = [];
    const cachePath = path.join(options.projectionCacheRoot, `${id}.json`);
    if (await statOrUndefined(cachePath)) cacheFiles.push(cachePath);
    if (snapshot !== undefined && id.startsWith('session-')) {
      const barePath = path.join(options.projectionCacheRoot, `${id.slice('session-'.length)}.json`);
      if (await recordMatches(barePath, snapshot.header)) cacheFiles.push(barePath);
    }

    let bytes = 0;
    let latestMtime = 0;
    const directories = [];
    for (const dir of dirs) {
      let tree;
      try {
        tree = await walkTree(dir);
      } catch (error) {
        warnings.push(`${id}: cannot read ${dir}: ${error?.message ?? String(error)}`);
        continue;
      }
      bytes += tree.bytes;
      directories.push(...tree.directories);
      for (const file of tree.files) latestMtime = Math.max(latestMtime, file.mtimeMs);
    }
    for (const file of cacheFiles) {
      const stat = await lstatOrUndefined(file);
      if (stat !== undefined) bytes += stat.size;
    }

    const reasons = [];
    if (dirs.some((dir) => !isInside(options.sessionsRoot, dir))) {
      reasons.push('a session directory escapes the configured sessions root');
    }
    if (cacheFiles.some((file) => !isInside(options.projectionCacheRoot, file))) {
      reasons.push('a cache record escapes the configured projection-cache root');
    }
    if (request.currentSessionId !== undefined && id === request.currentSessionId) {
      reasons.push('this is the current session; switch to another session to delete it');
    }
    if (live.has(id)) reasons.push('a live agent still owns this session in this process');
    if (dirs.length === 0 && cacheFiles.length === 0 && snapshot === undefined) {
      reasons.push('no session data found on disk or in persistence for this id');
    }
    if (latestMtime !== 0 && now - latestMtime < 60_000) {
      warnings.push(`${id}: the log was written ${Math.round((now - latestMtime) / 1000)}s ago; another DSH process may still have it open`);
    }

    const target = {
      id,
      title: await safeTitle(ctx, id),
      header: headerFacts(snapshot),
      dirs,
      directories,
      cacheFiles,
      bytes,
      createdAt: snapshot?.header?.createdAt,
      cwd: snapshot?.header?.cwd,
      stored: snapshot !== undefined,
      live: live.has(id),
      current: request.currentSessionId !== undefined && id === request.currentSessionId,
      blockers: reasons,
    };
    totalBytes += bytes;
    targets.push(target);
    if (reasons.length > 0) blockers.push({ id, reasons });
  }

  return { targets, blockers, warnings, totalBytes, sessionsRoot: options.sessionsRoot };
}

/**
 * Permanently delete every planned artifact for `ids`. Re-plans first, then
 * refuses on any blocker. Attachment removal is a global reference-scan and
 * is skipped conservatively when any surviving log cannot be read.
 *
 * @param {any} ctx
 * @param {ReturnType<typeof resolveOptions>} options
 * @param {string[]} ids
 * @param {{
 *   currentSessionId?: string,
 *   signal?: AbortSignal,
 *   purgeAttachments?: boolean,
 *   secureOverwrite?: boolean,
 * }} [request]
 */
export async function purgeSessions(ctx, options, ids, request = {}) {
  const plan = await planPurge(ctx, options, ids, {
    currentSessionId: request.currentSessionId,
    signal: request.signal,
  });
  if (plan.blockers.length > 0) {
    const lines = plan.blockers.map((entry) => `${entry.id}: ${entry.reasons.join('; ')}`);
    throw new PurgeError(`purge refused:\n${lines.join('\n')}`, 'BLOCKED');
  }

  const secureOverwrite = request.secureOverwrite ?? options.secureOverwrite;
  const purgeAttachments = request.purgeAttachments ?? options.purgeAttachments;
  const warnings = [...plan.warnings];

  // Plan attachment removal before touching the logs. Nothing is deleted here,
  // so a cancellation or a newly live target cannot leave a half-purged session.
  let attachmentPlan = {
    enabled: false,
    objects: [],
    protected: 0,
    keptShared: 0,
    skipped: undefined,
  };
  if (purgeAttachments && plan.targets.length > 0) {
    attachmentPlan = await planAttachmentObjects(ctx, options, plan.targets, {
      signal: request.signal,
      warnings,
    });
  }

  // The reference scan can take minutes; a target may have become live since
  // the first plan. Re-refuse before deleting anything.
  const liveNow = liveAgentIds(ctx);
  const becameLive = plan.targets.filter((target) => liveNow.has(target.id));
  if (becameLive.length > 0) {
    throw new PurgeError(
      `purge refused: session(s) became live during planning: ${becameLive.map((target) => target.id).join(', ')}`,
      'BLOCKED',
    );
  }

  const report = {
    targets: [],
    deletedFiles: 0,
    deletedBytes: 0,
    attachments: {
      enabled: attachmentPlan.enabled,
      deleted: 0,
      bytes: 0,
      protected: attachmentPlan.protected,
      keptShared: attachmentPlan.keptShared,
      skipped: attachmentPlan.skipped,
    },
    warnings,
    verified: true,
  };

  for (const target of plan.targets) {
    if (request.signal?.aborted) throw new PurgeError('purge cancelled', 'ABORTED');
    const targetReport = {
      id: target.id,
      title: target.title,
      bytes: target.bytes,
      files: 0,
      cacheFiles: 0,
      errors: [],
    };
    for (const dir of target.dirs) {
      const outcome = await shredTree(dir, { secureOverwrite });
      targetReport.files += outcome.files;
      targetReport.errors.push(...outcome.errors);
      report.deletedBytes += outcome.bytes;
    }
    for (const file of target.cacheFiles) {
      const outcome = await shredFile(file, { secureOverwrite });
      targetReport.cacheFiles++;
      targetReport.files++;
      report.deletedBytes += outcome.bytes;
      targetReport.errors.push(...outcome.errors);
    }
    // Remove directories that survived a partial tree removal.
    for (const dir of target.directories.slice().sort((left, right) => right.length - left.length)) {
      try {
        await fs.rmdir(dir);
      } catch (error) {
        if (error && (error.code === 'ENOENT' || error.code === 'ENOTEMPTY' || error.code === 'EEXIST')) continue;
        targetReport.errors.push(`${dir}: ${error?.message ?? String(error)}`);
      }
    }
    report.deletedFiles += targetReport.files;
    report.targets.push(targetReport);
  }

  // Only delete attachments once every target log and cache record is gone: a
  // surviving log still references its attachments.
  let removalClean = true;
  for (const planned of plan.targets) {
    for (const dir of planned.dirs) if (await statOrUndefined(dir)) removalClean = false;
    for (const file of planned.cacheFiles) if (await statOrUndefined(file)) removalClean = false;
  }
  let attemptedAttachments = [];
  if (attachmentPlan.enabled && attachmentPlan.objects.length > 0) {
    if (!removalClean) {
      report.attachments.skipped = 'target-removal-incomplete';
      warnings.push('attachment objects were retained because the session log removal was incomplete');
    } else {
      attemptedAttachments = attachmentPlan.objects;
      const outcome = await deleteAttachmentObjects(attemptedAttachments, { secureOverwrite, warnings });
      report.attachments.deleted = outcome.deleted;
      report.attachments.bytes = outcome.bytes;
    }
  }

  // The request-image cache is content-addressed by transform, not by
  // attachment, so variants of a deleted image cannot be attributed. Clearing
  // the whole derived cache is safe (it regenerates on demand) and removes
  // those copies.
  report.requestImageCache = { cleared: false, files: 0, bytes: 0 };
  if (report.attachments.deleted > 0 && options.clearRequestImageCache) {
    report.requestImageCache = await clearRequestImageCache(options, warnings, secureOverwrite);
  }

  const legacy = await stripLegacyCacheSeed(options, plan.targets).catch((error) => {
    warnings.push(`legacy projection cache cleanup failed: ${error?.message ?? String(error)}`);
    return { changed: false, removed: 0, failed: true, malformed: false };
  });
  if (legacy.changed) report.deletedFiles += legacy.removed;
  if (legacy.failed) report.verified = false;
  if (legacy.malformed) {
    report.verified = false;
    warnings.push('the legacy projection-cache seed could not be parsed; its records were left untouched');
  }

  // Verify every planned artifact is gone; a partial removal must not report success.
  for (let index = 0; index < report.targets.length; index++) {
    const targetReport = report.targets[index];
    const planned = plan.targets[index];
    for (const dir of planned.dirs) {
      if (await statOrUndefined(dir)) {
        report.verified = false;
        targetReport.errors.push(`directory still present after purge: ${dir}`);
      }
    }
    for (const file of planned.cacheFiles) {
      if (await statOrUndefined(file)) {
        report.verified = false;
        targetReport.errors.push(`cache record still present after purge: ${file}`);
      }
    }
    if (targetReport.errors.length > 0) report.verified = false;
  }
  for (const object of attemptedAttachments) {
    if (await statOrUndefined(object.file)) {
      report.verified = false;
      warnings.push(`attachment still present after purge: ${object.id}`);
    }
  }
  if (report.requestImageCache.cleared && (await statOrUndefined(options.requestImageCacheRoot))) {
    report.verified = false;
    warnings.push(`request-image cache still present after purge: ${options.requestImageCacheRoot}`);
  }
  return { ...report, plan };
}

/**
 * Decision support for the approval gate: a short human sentence with count,
 * byte total, and a bounded title list.
 */
export function describePlan(plan) {
  const count = plan.targets.length;
  const titles = plan.targets
    .map((target) => target.title ?? target.id)
    .slice(0, 5)
    .join(', ');
  const suffix = plan.targets.length > 5 ? `, +${plan.targets.length - 5} more` : '';
  return `${count} session${count === 1 ? '' : 's'} (${formatBytes(plan.totalBytes)}): ${titles}${suffix}`;
}

/**
 * Decide which attachment objects belong only to the targets. This performs
 * the full reference scan but deletes nothing; `purgeSessions` calls the
 * deletion only after every target log is gone. Any unreadable surviving log
 * suppresses all object deletion: a false "unreferenced" verdict would break
 * another session.
 */
async function planAttachmentObjects(ctx, options, targets, request) {
  const persistence = ctx.sessionPersistence;
  const warnings = request.warnings;
  const result = {
    enabled: true,
    objects: [],
    protected: 0,
    keptShared: 0,
    skipped: undefined,
  };
  const targetIds = new Set(targets.map((target) => target.id));
  const candidates = new Set();
  let candidatesComplete = true;

  for (const target of targets) {
    if (request.signal?.aborted) throw new PurgeError('purge cancelled', 'ABORTED');
    try {
      const scan = await scanAttachmentIds(persistence, target.id, {
        signal: request.signal,
        maxEvents: options.attachmentScanMaxEvents,
      });
      for (const id of scan.ids) candidates.add(id);
      if (!scan.complete) {
        candidatesComplete = false;
        warnings.push(`${target.id}: attachment reference scan reached its event cap; unknown attachments are retained`);
      }
    } catch (error) {
      candidatesComplete = false;
      warnings.push(`${target.id}: attachment reference scan failed (${error?.message ?? String(error)}); attachments are retained`);
    }
  }

  if (candidates.size === 0) {
    result.skipped = 'no-attachments-referenced';
    return result;
  }

  let snapshots;
  try {
    snapshots = await persistence.list(request.signal === undefined ? undefined : { signal: request.signal });
  } catch (error) {
    warnings.push(`attachment reference scan could not list surviving sessions (${error?.message ?? String(error)}); all attachments retained`);
    result.skipped = 'survivor-list-failed';
    return result;
  }

  const referenced = new Set();
  let survivorsComplete = true;
  for (const snapshot of snapshots) {
    if (targetIds.has(snapshot.header.id)) continue;
    try {
      const scan = await scanAttachmentIds(persistence, snapshot.header.id, {
        signal: request.signal,
        maxEvents: options.attachmentScanMaxEvents,
      });
      for (const id of scan.ids) referenced.add(id);
      if (!scan.complete) survivorsComplete = false;
    } catch (error) {
      survivorsComplete = false;
      warnings.push(`${snapshot.header.id}: attachment reference scan failed (${error?.message ?? String(error)})`);
    }
    if (!survivorsComplete) break;
  }

  if (!survivorsComplete) {
    result.skipped = 'survivor-scan-incomplete';
    warnings.push('attachment objects were retained because a surviving session could not be scanned completely');
    return result;
  }

  const now = Date.now();
  for (const attachmentId of candidates) {
    if (referenced.has(attachmentId)) {
      result.keptShared++;
      continue;
    }
    const match = ATTACHMENT_ID_PATTERN.exec(attachmentId);
    if (match === null) continue;
    const hex = match[1];
    const file = path.join(options.attachmentsRoot, 'objects', hex.slice(0, 2), hex);
    if (!isInside(options.attachmentsRoot, file)) continue;
    let stat;
    try {
      stat = await lstatOrUndefined(file);
    } catch (error) {
      warnings.push(`attachment ${attachmentId}: ${error?.message ?? String(error)}`);
      continue;
    }
    if (stat === undefined) continue;
    if (now - stat.mtimeMs < options.attachmentMinAgeMs) {
      result.protected++;
      continue;
    }
    result.objects.push({ id: attachmentId, file, bytes: stat.size });
  }
  if (!candidatesComplete) result.skipped = result.skipped ?? 'target-scan-incomplete';
  return result;
}

async function deleteAttachmentObjects(objects, request) {
  let deleted = 0;
  let bytes = 0;
  for (const object of objects) {
    const outcome = await shredFile(object.file, { secureOverwrite: request.secureOverwrite });
    if (outcome.errors.length === 0) {
      deleted++;
      bytes += outcome.bytes;
    } else {
      request.warnings.push(...outcome.errors);
    }
  }
  return { deleted, bytes };
}

/**
 * Remove the derived request-image cache. It is keyed by a transform hash
 * rather than by attachment id, so variants of a deleted image cannot be
 * selected individually; the directory is regenerable and safe to drop.
 */
async function clearRequestImageCache(options, warnings, secureOverwrite) {
  const root = options.requestImageCacheRoot;
  const guarded = [options.sessionsRoot, options.storagesRoot, options.projectionCacheRoot, options.attachmentsRoot];
  if (
    !isInside(options.dataDir, root) ||
    guarded.some(
      (protectedRoot) => root === protectedRoot || isInside(root, protectedRoot) || isInside(protectedRoot, root),
    )
  ) {
    warnings.push(`request-image cache at ${root} overlaps another data root; it was left untouched`);
    return { cleared: false, files: 0, bytes: 0 };
  }
  const stat = await lstatOrUndefined(root);
  if (stat === undefined) return { cleared: false, files: 0, bytes: 0 };
  if (!stat.isDirectory()) {
    warnings.push(`request-image cache at ${root} is not a directory; it was left untouched`);
    return { cleared: false, files: 0, bytes: 0 };
  }
  let tree;
  try {
    tree = await walkTree(root);
  } catch (error) {
    warnings.push(`request-image cache could not be read (${error?.message ?? String(error)}); it was left untouched`);
    return { cleared: false, files: 0, bytes: 0 };
  }
  for (const file of tree.files) {
    const outcome = await shredFile(file.path, { secureOverwrite });
    warnings.push(...outcome.errors);
  }
  try {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 2 });
  } catch (error) {
    warnings.push(`request-image cache could not be removed (${error?.message ?? String(error)})`);
    return { cleared: false, files: 0, bytes: 0 };
  }
  return { cleared: true, files: tree.files.length, bytes: tree.bytes };
}

/**
 * Read one session through the persistence seam and collect every
 * `attachmentId` value. Reads in bounded slices; reports `complete: false`
 * when the event cap is reached.
 *
 * @param {any} persistence
 * @param {string} id
 * @param {{ signal?: AbortSignal, maxEvents: number }} request
 */
async function scanAttachmentIds(persistence, id, request) {
  const ids = new Set();
  let seen = 0;
  let complete = true;
  const handle = await persistence.open(id, 'read', request.signal === undefined ? undefined : { signal: request.signal });
  try {
    let cursor = 0;
    while (seen < request.maxEvents) {
      if (request.signal?.aborted) throw new PurgeError('purge cancelled', 'ABORTED');
      const length = Math.min(200, request.maxEvents - seen);
      const page = await handle.read(cursor, length, request.signal === undefined ? undefined : { signal: request.signal });
      if (!page.events || page.events.length === 0) break;
      for (const event of page.events) {
        seen++;
        if (!collectAttachmentIds(event, ids)) complete = false;
      }
      const last = page.events[page.events.length - 1];
      cursor = Number(last.seq) + 1;
    }
    if (seen >= request.maxEvents) complete = false;
  } finally {
    await handle.close();
  }
  return { ids, complete, events: seen };
}

function collectAttachmentIds(value, out) {
  const stack = [value];
  let visited = 0;
  while (stack.length > 0 && visited < 200_000) {
    const node = stack.pop();
    visited++;
    if (node === null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'attachmentId' && typeof child === 'string' && ATTACHMENT_ID_PATTERN.test(child)) out.add(child);
      else if (child !== null && typeof child === 'object') stack.push(child);
    }
  }
  return stack.length === 0;
}

/**
 * Delete the legacy whole-unit cache seed's records for purged sessions. The
 * per-record tree is authoritative; this file is only an initialization
 * source, so editing it cannot race the cache's normal writes.
 */
async function stripLegacyCacheSeed(options, targets) {
  let raw;
  try {
    raw = await fs.readFile(options.projectionCacheSeed, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { changed: false, removed: 0, failed: false, malformed: false };
    throw error;
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    return { changed: false, removed: 0, failed: false, malformed: true };
  }
  const table = document?.tables?.sessions;
  if (table === undefined || table === null || typeof table !== 'object') {
    return { changed: false, removed: 0, failed: false, malformed: false };
  }
  let removed = 0;
  for (const target of targets) {
    if (Object.hasOwn(table, target.id)) {
      delete table[target.id];
      removed++;
    }
    if (target.header !== undefined && target.id.startsWith('session-')) {
      const bare = target.id.slice('session-'.length);
      if (Object.hasOwn(table, bare) && legacyRecordMatches(table[bare], target.header)) {
        delete table[bare];
        removed++;
      }
    }
  }
  if (removed === 0) return { changed: false, removed: 0, failed: false, malformed: false };
  const directory = path.dirname(options.projectionCacheSeed);
  const temporary = path.join(directory, `.${path.basename(options.projectionCacheSeed)}.${process.pid}.${Date.now()}.tmp`);
  const stat = await statOrUndefined(options.projectionCacheSeed);
  await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: stat?.mode ?? 0o600 });
  await fs.rename(temporary, options.projectionCacheSeed);
  return { changed: true, removed, failed: false, malformed: false };
}

async function recordMatches(file, header) {
  try {
    const document = JSON.parse(await fs.readFile(file, 'utf8'));
    return legacyRecordMatches(document?.record, header);
  } catch {
    return false;
  }
}

function legacyRecordMatches(record, header) {
  const identity = record?.identity;
  if (identity === undefined || identity === null) return false;
  if (header?.createdAt === undefined || identity.createdAt !== header.createdAt) return false;
  return (identity.cwd ?? undefined) === (header.cwd ?? undefined);
}

/** Shred and remove one complete session directory tree. */
async function shredTree(directory, options) {
  const report = { files: 0, bytes: 0, errors: [] };
  let tree;
  try {
    tree = await walkTree(directory);
  } catch (error) {
    report.errors.push(`${directory}: ${error?.message ?? String(error)}`);
    return report;
  }
  for (const file of tree.files) {
    const outcome = await shredFile(file.path, options);
    report.files++;
    report.bytes += outcome.bytes;
    report.errors.push(...outcome.errors);
  }
  try {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 2 });
  } catch (error) {
    report.errors.push(`${directory}: ${error?.message ?? String(error)}`);
  }
  return report;
}

/**
 * Overwrite (when enabled) and unlink one file. Symlinks are unlinked, never
 * followed. Read-only attachments are made writable first; a failed overwrite
 * still unlinks and reports the failure.
 */
async function shredFile(file, options) {
  const report = { bytes: 0, errors: [] };
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') return report;
    report.errors.push(`${file}: ${error?.message ?? String(error)}`);
    return report;
  }
  if (stat.isSymbolicLink()) {
    try {
      await fs.unlink(file);
    } catch (error) {
      report.errors.push(`${file}: ${error?.message ?? String(error)}`);
    }
    return report;
  }
  if (!stat.isFile()) {
    report.errors.push(`${file}: not a regular file`);
    return report;
  }
  report.bytes = stat.size;
  if (options.secureOverwrite && stat.size > 0) {
    try {
      await fs.chmod(file, 0o600).catch(() => undefined);
      const handle = await fs.open(file, 'r+');
      try {
        const chunk = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, stat.size)));
        let position = 0;
        while (position < stat.size) {
          const length = Math.min(chunk.length, stat.size - position);
          await handle.write(chunk, 0, length, position);
          position += length;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      report.errors.push(`${file}: overwrite failed before removal: ${error?.message ?? String(error)}`);
    }
  }
  try {
    await fs.unlink(file);
  } catch (error) {
    if (!(error && error.code === 'ENOENT')) report.errors.push(`${file}: ${error?.message ?? String(error)}`);
  }
  return report;
}