/**
 * Session Shredder — permanently remove DSH session data from disk.
 *
 * The Host owns the deletion logic (`lib/core.js`); this module registers one
 * model-facing tool and enforces the two safety gates that cannot live in the
 * filesystem layer:
 *
 *  1. only a top-level (non-subagent) session may purge;
 *  2. every real deletion asks the composed approval answerers first.
 */
import {
  PurgeError,
  describePlan,
  formatBytes,
  listSessions,
  planPurge,
  purgeSessions,
  resolveOptions,
} from './lib/core.js';

/** Cordis activation requires the tool registry and the persistence seam. */
export const inject = ['tools', 'sessionPersistence'];

/** Stable plugin row name. */
export const name = 'session-shredder';

const ACTIONS = ['list', 'plan', 'purge'];

const TOOL_DESCRIPTION = [
  'Permanently delete DSH session data from disk: the append-only session log plus every historical format generation, the projection-cache record, the legacy cache-seed entry, and attachments that no surviving session references.',
  'This is irreversible. Use it only when the user explicitly asks to permanently delete sessions. Never use it for "archive", "hide", cleanup suggestions, or the current session.',
  'Workflow: call action:"list" to discover ids, call action:"plan" for the exact footprint and blockers, show that plan to the user, and call action:"purge" with confirm:true only after the user agrees.',
  'A purge refuses the current session and any live session, and asks the user for approval before deleting.',
].join(' ');

/**
 * Register the tool on the plugin context.
 *
 * @param {any} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const options = resolveOptions(config);
  const tool = {
    name: 'session_purge',
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'list stored sessions, plan the exact footprint of given ids, or permanently delete them.',
        },
        sessionIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Target session ids for plan/purge. Required for plan and purge.',
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true for purge. Set only after the user has seen the plan and explicitly agreed.',
        },
        purgeAttachments: {
          type: 'boolean',
          description: 'Override the deployment default for attachment removal (only objects no surviving session references).',
        },
        limit: {
          type: 'integer',
          description: 'Maximum rows for action:"list" (1-500). Defaults to the plugin config.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'summary'],
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.summary }];
      },
    },
    timeoutMs: 600_000,
    async execute(args, exec) {
      const agent = exec.agent;
      if (agent === undefined) throw new PurgeError('session_purge must run inside an agent turn', 'NO_AGENT');
      assertTopLevel(ctx, agent);

      switch (args.action) {
        case 'list':
          return listAction(ctx, options, args.limit, agent.id);
        case 'plan':
          return planAction(ctx, options, args.sessionIds, agent.id);
        case 'purge':
          return purgeAction(ctx, options, args, exec, agent.id);
        default:
          throw new PurgeError(`unknown action: ${JSON.stringify(args.action)}`, 'INVALID_ACTION');
      }
    },
  };
  ctx.effect(() => ctx.tools.register(tool));
  registerHttpRoutes(ctx, options);
}

/**
 * The browser page reads and deletes through two authenticated `/api` Fetch
 * routes. They live inside Connection's Host/Origin fence, so the browser
 * session is the only caller; deletion requires `confirm:true` and the UI's
 * own confirmation dialog is the human gate.
 */
function registerHttpRoutes(ctx, options) {
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.connection;
    if (connection === undefined || typeof connection.fetch?.register !== 'function') return;
    const routes = [
    {
      path: '/api/session-shredder/sessions',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          const listing = await listSessions(ctx, options, { limit: 500 });
          return jsonResponse(200, {
            sessions: listing.shown.map((session) => ({
              id: session.id,
              title: session.title ?? null,
              cwd: session.cwd ?? null,
              createdAt: session.createdAt ?? null,
              bytes: session.bytes,
              eventCount: session.eventCount ?? null,
              live: session.live,
              archived: session.archived === true,
              orphan: session.orphan,
              subagent: !session.id.startsWith('session-'),
            })),
            total: listing.total,
            totalBytes: listing.totalBytes,
            hidden: listing.hidden,
            root: listing.sessionsRoot,
          });
        } catch (error) {
          return jsonResponse(500, { error: errorMessage(error) });
        }
      },
    },
    {
      path: '/api/session-shredder/delete',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body;
        try {
          body = await request.json();
        } catch {
          return jsonResponse(400, { error: 'request body must be JSON' });
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          return jsonResponse(400, { error: 'request body must be a JSON object' });
        }
        if (body.confirm !== true) return jsonResponse(400, { error: 'confirm:true is required' });
        if (!Array.isArray(body.sessionIds) || body.sessionIds.length === 0) {
          return jsonResponse(400, { error: 'sessionIds must be a non-empty array' });
        }
        if (body.sessionIds.some((id) => typeof id !== 'string')) {
          return jsonResponse(400, { error: 'sessionIds must contain strings only' });
        }
        const ids = [...new Set(body.sessionIds)];
        if (ids.length > options.maxTargets) {
          return jsonResponse(400, { error: `at most ${options.maxTargets} sessions may be deleted per request` });
        }
        try {
          const result = await purgeSessions(ctx, options, ids, {
            purgeAttachments: body.purgeAttachments !== false,
          });
          const ok = result.verified && result.targets.every((target) => target.errors.length === 0);
          return jsonResponse(200, {
            ok,
            verified: result.verified,
            deletedFiles: result.deletedFiles,
            deletedBytes: result.deletedBytes,
            attachments: result.attachments,
            requestImageCache: result.requestImageCache,
            targets: result.targets.map((target) => ({
              id: target.id,
              bytes: target.bytes,
              files: target.files,
              errors: target.errors,
            })),
            warnings: result.warnings,
          });
        } catch (error) {
          const status = error instanceof PurgeError ? 409 : 500;
          return jsonResponse(status, { error: errorMessage(error), code: error?.code });
        }
      },
    },
  ];
  for (const route of routes) {
      connectionCtx.effect(() => {
        const dispose = connection.fetch.register(route);
        return () => {
          void dispose();
        };
      }, `session-shredder: ${route.path}`);
    }
  });
}

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A subagent must not permanently delete user data; only a top-level session
 * owns that authority.
 */
function assertTopLevel(ctx, agent) {
  const session = ctx.get('sessions')?.get(agent.id);
  const header = session?.header;
  if (header === undefined) return;
  // A user fork keeps `parentSession` for lineage and is still a top-level
  // chat; only delegation marks a subagent.
  if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) {
    throw new PurgeError(
      'only a top-level session may purge session data; subagent sessions must not delete user data',
      'NOT_TOP_LEVEL',
    );
  }
}

function normalizeIds(value) {
  if (!Array.isArray(value)) {
    throw new PurgeError('sessionIds must be an array of session ids for plan and purge', 'INVALID_SESSION_ID');
  }
  if (value.length === 0) throw new PurgeError('sessionIds must name at least one session', 'INVALID_SESSION_ID');
  return [...new Set(value)];
}

async function listAction(ctx, options, limit, currentSessionId) {
  const listing = await listSessions(ctx, options, {
    limit,
    currentSessionId,
  });
  const lines = [
    `Session Shredder — ${listing.total} session${listing.total === 1 ? '' : 's'} under ${listing.sessionsRoot}`,
  ];
  if (listing.shown.length === 0) lines.push('No sessions found.');
  for (const session of listing.shown) {
    const flags = [session.current ? 'CURRENT' : '', session.live ? 'LIVE' : '', session.archived ? 'ARCHIVED' : '', session.orphan ? 'ORPHAN (no stored header)' : '']
      .filter(Boolean)
      .join(', ');
    lines.push(
      `- ${session.id}  ${formatBytes(session.bytes)}${flags ? `  [${flags}]` : ''}` +
        `${session.title !== undefined ? `  "${session.title}"` : ''}` +
        `${session.cwd !== undefined ? `  ${session.cwd}` : ''}`,
    );
  }
  if (listing.hidden > 0) lines.push(`... ${listing.hidden} more not shown (raise limit or filter by id).`);
  lines.push('Use action:"plan" with ids before deleting.');
  return { ok: true, summary: lines.join('\n') };
}

async function planAction(ctx, options, sessionIds, currentSessionId) {
  const plan = await planPurge(ctx, options, normalizeIds(sessionIds), { currentSessionId });
  const lines = [
    `Purge plan (dry run) — ${plan.targets.length} session${plan.targets.length === 1 ? '' : 's'}, ${formatBytes(plan.totalBytes)} on disk.`,
  ];
  for (const target of plan.targets) {
    lines.push(
      `- ${target.id}${target.title !== undefined ? `  "${target.title}"` : ''}  ${formatBytes(target.bytes)}`,
    );
    if (target.dirs.length > 0) {
      for (const dir of target.dirs) lines.push(`    log: ${dir}`);
    } else {
      lines.push('    log: none on disk');
    }
    for (const file of target.cacheFiles) lines.push(`    cache: ${file}`);
    if (target.blockers.length > 0) {
      for (const reason of target.blockers) lines.push(`    BLOCKER: ${reason}`);
    }
  }
  for (const warning of plan.warnings) lines.push(`warning: ${warning}`);
  lines.push(
    plan.blockers.length > 0
      ? 'This plan cannot be purged as-is; resolve the blockers first.'
      : 'No attachments are counted here: purge scans surviving sessions and deletes only unreferenced objects.',
  );
  return { ok: plan.blockers.length === 0, summary: lines.join('\n') };
}

async function purgeAction(ctx, options, args, exec, currentSessionId) {
  if (args.confirm !== true) {
    throw new PurgeError('refusing to purge without confirm:true; show action:"plan" to the user first', 'CONFIRM_REQUIRED');
  }
  const ids = normalizeIds(args.sessionIds);
  const plan = await planPurge(ctx, options, ids, { currentSessionId, signal: exec.signal });
  if (plan.blockers.length > 0) {
    const lines = plan.blockers.map((entry) => `${entry.id}: ${entry.reasons.join('; ')}`);
    throw new PurgeError(`purge refused:\n${lines.join('\n')}`, 'BLOCKED');
  }

  await requireApproval(ctx, options, exec, plan);

  const result = await purgeSessions(ctx, options, ids, {
    currentSessionId,
    signal: exec.signal,
    purgeAttachments: typeof args.purgeAttachments === 'boolean' ? args.purgeAttachments : undefined,
  });

  const ok = result.verified && result.targets.every((target) => target.errors.length === 0);
  const lines = [
    `Purged ${result.targets.length} session${result.targets.length === 1 ? '' : 's'}: ` +
      `${formatBytes(result.deletedBytes)} removed in ${result.deletedFiles} file${result.deletedFiles === 1 ? '' : 's'}. ` +
      `Verified: ${result.verified ? 'yes' : 'NO'}.`,
  ];
  if (result.attachments.enabled) {
    const attachments = result.attachments;
    lines.push(
      `Attachments: ${attachments.deleted} deleted (${formatBytes(attachments.bytes)}), ` +
        `${attachments.keptShared} kept as shared, ${attachments.protected} kept as recent` +
        `${attachments.skipped !== undefined ? `, skipped: ${attachments.skipped}` : ''}.`,
    );
  } else {
    lines.push('Attachments: left in place (disabled for this call).');
  }
  if (result.requestImageCache?.cleared) {
    lines.push(
      `Request-image cache: cleared (${formatBytes(result.requestImageCache.bytes)}, ${result.requestImageCache.files} file(s)).`,
    );
  }
  for (const target of result.targets) {
    lines.push(
      `- ${target.id}: ${formatBytes(target.bytes)}, ${target.files} file${target.files === 1 ? '' : 's'}` +
        `${target.errors.length > 0 ? ` — ${target.errors.length} error(s)` : ''}`,
    );
    for (const error of target.errors) lines.push(`    ${error}`);
  }
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  if (!ok) lines.push('Some artifacts could not be removed; the tool did not report a clean purge.');
  return { ok, summary: lines.join('\n') };
}

/**
 * Ask the user through the composed approval answerers. A missing service or
 * an unavailable answerer fails closed unless `requireApproval` is false.
 */
async function requireApproval(ctx, options, exec, plan) {
  const summary = describePlan(plan);
  const approval = ctx.get('approval');
  // A session-level `never` policy is the user's explicit decision to disable
  // prompt-gated actions; respect it instead of failing every purge. The
  // plan + confirm:true + top-level-session checks still gate the call.
  if (approval !== undefined) {
    const session = ctx.get('sessions')?.get(exec.agent.id);
    try {
      if (session !== undefined && approval.overrideOf(session) === 'never') return;
    } catch {
      // Fall through to the configured behavior.
    }
  }
  if (!options.requireApproval) return;
  if (approval === undefined) {
    throw new PurgeError(
      'no approval service is composed; set requireApproval:false in the plugin config to allow unattended purges',
      'APPROVAL_UNAVAILABLE',
    );
  }
  let outcome;
  try {
    outcome = await approval.request({
      agent: exec.agent,
      toolName: 'session_purge',
      callId: exec.callId,
      reason: `Permanently delete ${summary} from disk. This cannot be undone.`,
      displayReason: {
        en: `Permanently delete ${summary} from disk. This cannot be undone.`,
        zh: `将从磁盘彻底删除 ${summary}，此操作不可撤销。`,
      },
      signal: exec.signal,
    });
  } catch (error) {
    throw new PurgeError(
      `approval could not be requested (${error?.message ?? String(error)}); nothing was deleted`,
      'APPROVAL_FAILED',
    );
  }
  if (outcome !== 'allowed-once') {
    throw new PurgeError(`purge not approved (${String(outcome)}); nothing was deleted`, 'NOT_APPROVED');
  }
}