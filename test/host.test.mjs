/**
 * Registers the Host half against a fake context and exercises the two
 * authenticated Fetch routes without a browser. Run with:
 *   node test/host.test.mjs
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-shredder-host-'));
const options = { dataDir: root, attachmentMinAgeMs: 0, requireApproval: false };

const tools = [];
const routes = new Map();
const ctx = {
  effect(callback) {
    return callback();
  },
  inject(services, callback) {
    if (!services.includes('connection')) return;
    callback({
      connection: this.get('connection'),
      effect: (effect) => effect(),
    });
  },
  get(name) {
    if (name === 'connection') {
      return {
        fetch: {
          register(route) {
            routes.set(route.path, route);
            return async () => {};
          },
        },
      };
    }
    return undefined;
  },
  tools: {
    register(definition) {
      tools.push(definition);
      return () => {};
    },
  },
  sessionPersistence: {
    async list() {
      return [];
    },
    async stat() {
      return undefined;
    },
    async open() {
      throw new Error('not found');
    },
  },
};

apply(ctx, options);

assert.equal(tools.length, 1);
assert.equal(tools[0].name, 'session_purge');
assert.deepEqual([...routes.keys()].sort(), [
  '/api/session-shredder/delete',
  '/api/session-shredder/sessions',
]);

const listRoute = routes.get('/api/session-shredder/sessions');
assert.deepEqual(listRoute.methods, ['GET']);
const listResponse = await listRoute.fetch(new Request('http://localhost/api/session-shredder/sessions'));
assert.equal(listResponse.status, 200);
const listing = await listResponse.json();
assert.equal(listing.total, 0);
assert.equal(listing.totalBytes, 0);
assert.deepEqual(listing.sessions, []);
assert.equal(listing.hidden, 0);

const deleteRoute = routes.get('/api/session-shredder/delete');
assert.deepEqual(deleteRoute.methods, ['POST']);

async function callDelete(body, raw = false) {
  return deleteRoute.fetch(
    new Request('http://localhost/api/session-shredder/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw ? body : JSON.stringify(body),
    }),
  );
}

const missingConfirm = await callDelete({ sessionIds: ['session-testpurge-0001'] });
assert.equal(missingConfirm.status, 400);
assert.match((await missingConfirm.json()).error, /confirm/);

const badJson = await callDelete('{', true);
assert.equal(badJson.status, 400);

const emptyIds = await callDelete({ sessionIds: [], confirm: true });
assert.equal(emptyIds.status, 400);

const wrongType = await callDelete({ sessionIds: [42], confirm: true });
assert.equal(wrongType.status, 400);

const unknown = await callDelete({ sessionIds: ['session-testpurge-0001'], confirm: true });
assert.equal(unknown.status, 409);
assert.match((await unknown.json()).error, /purge refused/);

await fs.rm(root, { recursive: true, force: true });
console.log('host.test.mjs: all checks passed');