/**
 * Standalone checks for the deletion core. Run with:
 *   node test/core.test.mjs
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PurgeError,
  decodeSegment,
  encodeSegment,
  formatBytes,
  listSessions,
  planPurge,
  purgeSessions,
  resolveOptions,
} from '../lib/core.js';

const targetId = 'session-testpurge-0001';
const survivorId = 'session-survivor-0002';
const orphanId = 'session-orphan-0003';
const bareId = '820d2c90-27c4-4819-9ae9-945390099016';
const createdAt = 1_700_000_000_000;
const cwd = 'D:\\Projects\\ShredderTest';

function snapshot(id, header = {}) {
  return {
    header: { version: 4, id, createdAt, cwd, isSeeded: false, ...header },
    revision: `rev-${id}`,
    eventCount: 1,
    sizeBytes: 10,
  };
}

function attachmentRef(hex) {
  return {
    type: 'user/message',
    seq: 0,
    time: 1,
    data: {
      message: {
        role: 'user',
        content: [{ type: 'image', attachment: { attachmentId: `sha256:${hex}` } }],
      },
    },
    surfaceOp: 'append',
  };
}

const sharedHex = 'ab'.repeat(32);
const targetOnlyHex = 'cd'.repeat(32);
const survivorHex = 'ef'.repeat(32);

function makePersistence(eventsById) {
  return {
    async list() {
      return [snapshot(targetId), snapshot(survivorId)];
    },
    async stat(id) {
      return id === targetId || id === survivorId ? snapshot(id) : undefined;
    },
    async open(id) {
      const events = eventsById[id];
      if (events === undefined) throw new Error(`not found: ${id}`);
      let closed = false;
      return {
        id,
        header: snapshot(id).header,
        inheritedEventCount: 0,
        access: 'read',
        async read(offset = 0, length = Number.MAX_SAFE_INTEGER) {
          if (closed) throw new Error('closed');
          const slice = events.filter((event) => event.seq >= Number(offset)).slice(0, length);
          return { eventState: 'shared-frozen', events: slice };
        },
        async flush() {},
        async close() {
          closed = true;
        },
      };
    },
  };
}

function makeContext(persistence, { liveIds = [] } = {}) {
  return {
    sessionPersistence: persistence,
    get(name) {
      if (name === 'agents') return { list: () => liveIds.map((id) => ({ id })) };
      return undefined;
    },
  };
}

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeFile(target, contents) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-shredder-'));
  const dataDir = path.join(root, 'dsh-home');
  const options = resolveOptions({
    dataDir,
    attachmentMinAgeMs: 0,
    requireApproval: false,
    secureOverwrite: true,
    maxTargets: 10,
  });

  const targetDir = path.join(options.sessionsRoot, '--D-Projects-ShredderTest--', encodeSegment(targetId));
  const survivorDir = path.join(options.sessionsRoot, '--D-Projects-ShredderTest--', encodeSegment(survivorId));
  const orphanDir = path.join(options.sessionsRoot, '--D-Projects-ShredderTest--', encodeSegment(orphanId));
  const bareDir = path.join(options.sessionsRoot, '--D-Projects-ShredderTest--', encodeSegment(bareId));
  await writeFile(path.join(targetDir, 'session.v3.jsonl.zstd'), 'old generation');
  await writeFile(path.join(targetDir, 'session.v4.jsonl.zstd'), 'current generation');
  await writeFile(path.join(survivorDir, 'session.v4.jsonl.zstd'), 'survivor');
  await writeFile(path.join(orphanDir, 'session.v4.jsonl.zstd'), 'orphan');
  await writeFile(path.join(bareDir, 'session.v4.jsonl.zstd'), 'subagent-style bare id');

  const cacheDir = options.projectionCacheRoot;
  await writeFile(
    path.join(cacheDir, `${targetId}.json`),
    JSON.stringify({ version: 7, record: { identity: { createdAt, cwd }, rows: { title: { val: 'Target' } } } }),
  );
  await writeFile(
    path.join(cacheDir, `${targetId.slice('session-'.length)}.json`),
    JSON.stringify({ version: 7, record: { identity: { createdAt, cwd } } }),
  );
  await writeFile(
    options.projectionCacheSeed,
    JSON.stringify({
      unit: { name: 'session_projcache', version: 3 },
      global: null,
      tables: {
        sessions: {
          [targetId]: { identity: { createdAt, cwd } },
          [targetId.slice('session-'.length)]: { identity: { createdAt, cwd } },
          [survivorId]: { identity: { createdAt, cwd } },
        },
      },
    }),
  );

  async function writeAttachment(hex) {
    await writeFile(path.join(options.attachmentsRoot, 'objects', hex.slice(0, 2), hex), `bytes-${hex}`);
  }
  await writeAttachment(sharedHex);
  await writeAttachment(targetOnlyHex);
  await writeAttachment(survivorHex);
  await writeFile(path.join(options.requestImageCacheRoot, 'aa', 'variant'), 'derived image bytes');

  const persistence = makePersistence({
    [targetId]: [attachmentRef(sharedHex), attachmentRef(targetOnlyHex)],
    [survivorId]: [attachmentRef(sharedHex), attachmentRef(survivorHex)],
  });
  const ctx = makeContext(persistence);

  assert.equal(encodeSegment('session-a/b'), 'session-a~002Fb');
  assert.equal(decodeSegment(encodeSegment('会话~id')), '会话~id');
  assert.equal(formatBytes(1536), '1.5 KiB');
  const filesystemRoot = path.parse(process.cwd()).root;
  assert.throws(() => resolveOptions({ dataDir: filesystemRoot }), PurgeError);

  const listing = await listSessions(ctx, options, { limit: 10, currentSessionId: targetId });
  assert.equal(listing.total, 4, 'two stored sessions plus two orphan directories');
  assert.equal(listing.shown.find((row) => row.id === targetId).current, true);

  const changingLiveIds = [];
  const dynamicCtx = makeContext(persistence, { liveIds: changingLiveIds });
  let dynamicListing = await listSessions(dynamicCtx, options, { limit: 10 });
  assert.equal(dynamicListing.shown.find((row) => row.id === survivorId).live, false);
  changingLiveIds.push(survivorId);
  dynamicListing = await listSessions(dynamicCtx, options, { limit: 10 });
  assert.equal(dynamicListing.shown.find((row) => row.id === survivorId).live, true);
  changingLiveIds.length = 0;
  dynamicListing = await listSessions(dynamicCtx, options, { limit: 10 });
  assert.equal(dynamicListing.shown.find((row) => row.id === survivorId).live, false);

  const plan = await planPurge(ctx, options, [targetId, orphanId, bareId], { currentSessionId: 'session-current' });
  assert.equal(plan.blockers.length, 0);
  assert.equal(plan.targets.length, 3);
  assert.ok(plan.targets[0].dirs.length === 1);
  assert.ok(plan.targets[0].cacheFiles.length === 2, 'exact and legacy cache records');

  const blocked = await planPurge(ctx, options, [targetId], { currentSessionId: targetId });
  assert.equal(blocked.blockers.length, 1);
  await assert.rejects(
    purgeSessions(ctx, options, [targetId], { currentSessionId: targetId }),
    /purge refused/,
  );

  const livePlan = await planPurge(ctx, options, [survivorId], { currentSessionId: 'session-current' });
  // survivor is not "live" in this fake; mark it live for the refusal check below.

  const result = await purgeSessions(ctx, options, [targetId, orphanId, bareId], {
    currentSessionId: 'session-current',
    purgeAttachments: true,
  });
  assert.equal(result.verified, true);
  assert.equal(await exists(targetDir), false, 'target log directory removed');
  assert.equal(await exists(orphanDir), false, 'orphan log directory removed');
  assert.equal(await exists(bareDir), false, 'subagent-style bare id directory removed');
  assert.equal(await exists(path.join(cacheDir, `${targetId}.json`)), false);
  assert.equal(await exists(path.join(cacheDir, `${targetId.slice('session-'.length)}.json`)), false);
  assert.equal(await exists(survivorDir), true, 'survivor log untouched');
  assert.equal(await exists(path.join(options.attachmentsRoot, 'objects', targetOnlyHex.slice(0, 2), targetOnlyHex)), false, 'unreferenced attachment removed');
  assert.equal(await exists(path.join(options.attachmentsRoot, 'objects', sharedHex.slice(0, 2), sharedHex)), true, 'shared attachment kept');
  assert.equal(await exists(path.join(options.attachmentsRoot, 'objects', survivorHex.slice(0, 2), survivorHex)), true, 'survivor attachment kept');
  assert.equal(result.attachments.deleted, 1);
  assert.equal(result.attachments.keptShared, 1);
  assert.equal(await exists(options.requestImageCacheRoot), false, 'derived request-image cache cleared');

  const seed = JSON.parse(await fs.readFile(options.projectionCacheSeed, 'utf8'));
  assert.equal(Object.hasOwn(seed.tables.sessions, targetId), false);
  assert.equal(Object.hasOwn(seed.tables.sessions, targetId.slice('session-'.length)), false);
  assert.equal(Object.hasOwn(seed.tables.sessions, survivorId), true);

  const liveCtx = makeContext(persistence, { liveIds: [survivorId] });
  const live = await planPurge(liveCtx, options, [survivorId], { currentSessionId: 'session-current' });
  assert.equal(live.blockers.length, 1);
  await assert.rejects(
    purgeSessions(liveCtx, options, [survivorId], { currentSessionId: 'session-current' }),
    /live agent/,
  );

  await assert.rejects(purgeSessions(ctx, options, ['../escape'], {}), /invalid session id/);

  await fs.rm(root, { recursive: true, force: true });
  console.log('core.test.mjs: all checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});