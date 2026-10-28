/**
 * Session Shredder — browser half.
 *
 * A dedicated main panel (also reachable from its sidebar icon) that lists
 * every stored session with its on-disk footprint, lets the user select the
 * ones they no longer need, and permanently deletes them through the Host's
 * authenticated `/api/session-shredder` routes.
 *
 * The page keeps its own controls and styling (theme tokens only) so it does
 * not depend on the Host's private UI primitives.
 */
window.__ModuleLoader__.load({
  id: '@murchey/dsh-session-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'sessionShredder';

    const zh = {
      panel: '会话存储',
      title: '会话存储',
      subtitle: '查看每个会话在磁盘上占用的空间，并永久删除不再需要的会话。',
      refresh: '刷新',
      refreshing: '刷新中…',
      search: '搜索会话',
      searchPlaceholder: '按标题、ID 或项目目录搜索',
      sortLabel: '排序',
      sortSize: '按大小',
      sortTime: '按时间',
      total: '共 {count} 个会话',
      usage: '总计 {size}',
      hidden: '另有 {count} 个未显示',
      selected: '已选 {count} 个 · {size}',
      selectedNone: '未选择会话',
      selectAll: '全选可删除的会话',
      selectRow: '选择会话 {title}',
      deleteSelected: '删除所选',
      delete: '删除',
      deleteRow: '删除会话 {title}',
      prune: '清理失效栏目',
      pruningLabel: '清理中…',
      pruneHint: '移除侧边栏中数据已不存在的会话条目',
      pruneBlocked: '会话列表尚未完整加载，暂时无法清理',
      pruneDone: '已清理 {count} 个失效条目。',
      pruneNone: '没有发现失效条目，侧边栏已经是干净的。',
      pruneFailed: '清理失败：{message}',
      live: '运行中',
      subagent: '子代理',
      orphan: '仅磁盘',
      empty: '还没有会话',
      noMatches: '没有匹配的会话',
      loading: '正在读取会话存储…',
      loadError: '读取失败：{message}',
      retry: '重试',
      deleteTitle: '永久删除会话？',
      deleteBody: '将从磁盘彻底删除 {count} 个会话，共 {size}。此操作不可撤销。',
      deleteAttachments: '同时删除不再被其他会话引用的附件',
      cancel: '取消',
      confirmDelete: '永久删除',
      deleting: '正在删除…',
      done: '已永久删除 {count} 个会话，释放 {size}。',
      partial: '删除完成，但有部分数据未能清理。',
      failed: '删除失败：{message}',
      details: '详情',
      warnings: '警告',
      close: '关闭',
      sessionFallback: '未命名会话',
      createdAt: '创建于 {date}',
      cannotSelectLive: '运行中的会话不能删除，请先结束它',
      note: '删除会移除会话日志、投影缓存和无引用附件；运行中的会话必须先结束。删除不可撤销。',
    };

    const en = {
      panel: 'Session storage',
      title: 'Session storage',
      subtitle: 'See how much disk space each session uses and permanently delete the ones you no longer need.',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      search: 'Search sessions',
      searchPlaceholder: 'Search by title, ID, or project folder',
      sortLabel: 'Sort',
      sortSize: 'By size',
      sortTime: 'By date',
      total: '{count} sessions',
      usage: '{size} total',
      hidden: '{count} more not shown',
      selected: '{count} selected · {size}',
      selectedNone: 'No sessions selected',
      selectAll: 'Select all deletable sessions',
      selectRow: 'Select session {title}',
      deleteSelected: 'Delete selected',
      delete: 'Delete',
      deleteRow: 'Delete session {title}',
      prune: 'Clear stale entries',
      pruningLabel: 'Clearing…',
      pruneHint: 'Remove sidebar entries whose session data no longer exists',
      pruneBlocked: 'The session list is not fully loaded yet; cleanup is unavailable',
      pruneDone: 'Cleared {count} stale entries.',
      pruneNone: 'No stale entries found; the sidebar is already clean.',
      pruneFailed: 'Cleanup failed: {message}',
      live: 'Live',
      subagent: 'Subagent',
      orphan: 'Disk only',
      empty: 'No sessions yet',
      noMatches: 'No matching sessions',
      loading: 'Reading session storage…',
      loadError: 'Could not load: {message}',
      retry: 'Retry',
      deleteTitle: 'Permanently delete sessions?',
      deleteBody: 'Permanently delete {count} sessions ({size}) from disk. This cannot be undone.',
      deleteAttachments: 'Also delete attachments no other session references',
      cancel: 'Cancel',
      confirmDelete: 'Delete permanently',
      deleting: 'Deleting…',
      done: 'Permanently deleted {count} sessions and freed {size}.',
      partial: 'Deletion finished, but some data could not be cleaned up.',
      failed: 'Delete failed: {message}',
      details: 'Details',
      warnings: 'Warnings',
      close: 'Close',
      sessionFallback: 'Untitled session',
      createdAt: 'Created {date}',
      cannotSelectLive: 'Live sessions cannot be deleted; stop the session first',
      note: 'Deletion removes the session log, projection cache, and unreferenced attachments. Live sessions must be stopped first. This cannot be undone.',
    };

    const CSS = `
.ss-page{height:100%;min-height:0;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;line-height:1.6;overflow:hidden}
.ss-scroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable}
.ss-content{max-width:960px;margin:0 auto;padding:28px clamp(20px,4vw,48px) 48px}
.ss-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}
.ss-head-actions{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap}
.ss-head h1{font-size:20px;font-weight:500;line-height:28px;margin:0}
.ss-subtitle{color:var(--dsw-alias-label-secondary);margin:6px 0 0;font-size:13px;line-height:20px;max-width:64ch}
.ss-stats{display:flex;flex-wrap:wrap;gap:8px 18px;color:var(--dsw-alias-label-secondary);font-size:13px;margin-bottom:18px}
.ss-stats strong{color:var(--dsw-alias-label-primary);font-weight:500}
.ss-toolbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.ss-search{display:flex;align-items:center;gap:8px;flex:1 1 260px;min-width:0;height:36px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.ss-search:focus-within{border-color:var(--dsw-alias-brand-primary)}
.ss-search svg{flex:none;color:var(--dsw-alias-label-secondary)}
.ss-search input{flex:1;min-width:0;height:100%;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;outline:none}
.ss-search input::placeholder{color:var(--dsw-alias-label-secondary)}
.ss-search-clear{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:16px;line-height:1;padding:2px 4px;border-radius:6px}
.ss-search-clear:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.ss-sort{display:flex;gap:4px;padding:2px;border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.ss-sort-btn{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:5px 10px;border-radius:8px;cursor:pointer}
.ss-sort-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.ss-sort-active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ss-selection{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 10px;margin-bottom:10px;border-radius:12px;background:var(--dsw-alias-bg-layer-1);min-height:44px}
.ss-select-all{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:13px;cursor:pointer;min-width:0}
.ss-select-all input{accent-color:var(--dsw-alias-brand-primary);width:15px;height:15px;flex:none}
.ss-list{list-style:none;margin:0;padding:0;border-top:.5px solid var(--dsw-alias-border-l1)}
.ss-row{display:flex;align-items:flex-start;gap:12px;padding:12px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.ss-row:hover{background:var(--dsw-alias-bg-layer-1)}
.ss-row-check{margin-top:3px;accent-color:var(--dsw-alias-brand-primary);width:15px;height:15px;flex:none}
.ss-row-main{flex:1;min-width:0}
.ss-row-top{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.ss-row-title{flex:1 1 200px;min-width:0;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ss-row-size{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);font-size:13px}
.ss-row-delete{flex:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;padding:2px 6px;border-radius:7px;align-self:center}
.ss-row-delete:hover{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.ss-row-delete:disabled{opacity:.4;cursor:default;background:transparent;color:var(--dsw-alias-label-secondary)}
.ss-muted{color:var(--dsw-alias-label-secondary);font-size:12px}
.ss-badges{display:inline-flex;gap:4px;flex:none;flex-wrap:wrap}
.ss-badge{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;white-space:nowrap}
.ss-badge-live{color:var(--dsw-alias-state-warn-primary)}
.ss-row-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.ss-id{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;background:var(--dsw-alias-bg-layer-2);border-radius:6px;padding:0 5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.ss-cwd{min-width:0;max-width:56ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ss-meta-date{white-space:nowrap}
.ss-bar{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);margin-top:8px;overflow:hidden}
.ss-bar-fill{display:block;height:100%;border-radius:2px;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 70%, transparent)}
.ss-row-live .ss-bar-fill{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 60%, transparent)}
.ss-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:var(--dsw-alias-label-secondary);padding:64px 20px;gap:10px}
.ss-empty p{margin:0}
.ss-spinner{width:22px;height:22px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:ss-spin .8s linear infinite}
@keyframes ss-spin{to{transform:rotate(360deg)}}
.ss-error{color:var(--dsw-alias-state-error-primary)}
.ss-error-banner{padding:8px 12px;border-radius:10px;margin-bottom:10px;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);color:var(--dsw-alias-state-error-primary);font-size:12px}
.ss-notice{display:flex;align-items:flex-start;gap:10px;padding:9px 12px;border-radius:10px;margin-bottom:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:19px}
.ss-notice-success{color:var(--dsw-alias-state-success-primary)}
.ss-notice-error{color:var(--dsw-alias-state-error-primary)}
.ss-notice-warning{color:var(--dsw-alias-state-warn-primary)}
.ss-notice-body{min-width:0;flex:1}
.ss-notice details{margin-top:2px;width:100%}
.ss-notice summary{cursor:pointer}
.ss-notice pre{margin:6px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;color:var(--dsw-alias-label-secondary);max-height:160px;overflow:auto}
.ss-notice-dismiss{margin-left:auto;border:0;background:transparent;color:inherit;cursor:pointer;font-size:16px;line-height:1;padding:2px 4px;border-radius:6px;flex:none}
.ss-notice-dismiss:hover{background:var(--dsw-alias-bg-layer-2)}
.ss-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:19px;margin:20px 0 0}
.ss-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border-radius:14px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.ss-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.ss-btn:disabled{opacity:.5;cursor:default}
.ss-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, var(--dsw-alias-border-l1))}
.ss-btn-danger:hover{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)}
.ss-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb, var(--dsw-alias-bg-overlay) 78%, transparent);backdrop-filter:blur(2px)}
.ss-dialog{width:min(480px,100%);max-height:calc(100dvh - 48px);overflow:auto;background:var(--dsw-alias-bg-overlay);border:.5px solid var(--dsw-alias-border-l1);border-radius:18px;padding:20px;box-shadow:0 12px 40px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent)}
.ss-dialog h2{font-size:18px;font-weight:500;line-height:26px;margin:0 0 8px}
.ss-dialog p{margin:0 0 12px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.ss-dialog-list{max-height:160px;overflow:auto;margin:0 0 12px;padding-left:18px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:21px}
.ss-dialog-list li{overflow-wrap:anywhere}
.ss-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.ss-check{display:flex;align-items:flex-start;gap:8px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;cursor:pointer}
.ss-check input{margin-top:2px;accent-color:var(--dsw-alias-brand-primary);width:15px;height:15px;flex:none}
.ss-page :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
@media (max-width:620px){.ss-cwd{max-width:100%}.ss-head{flex-direction:column}.ss-head>.ss-btn{align-self:flex-start}}
`;

    function cx(...parts) {
      return parts.filter(Boolean).join(' ');
    }

    function formatBytes(bytes) {
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

    function formatDate(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
      try {
        return new Intl.DateTimeFormat(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        }).format(new Date(ms));
      } catch {
        return '';
      }
    }

    async function requestJson(url, init = {}) {
      const headers = init.body === undefined ? init.headers : { 'content-type': 'application/json', ...init.headers };
      const response = await fetch(url, { credentials: 'same-origin', ...init, headers });
      let value = null;
      try {
        value = await response.json();
      } catch {
        value = null;
      }
      if (!response.ok) {
        const message = value && typeof value.error === 'string' ? value.error : `${response.status} ${response.statusText}`;
        throw new Error(message);
      }
      return value ?? {};
    }

    function ShredderIcon({ size = 16 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M4 7h16' }),
        h('path', { d: 'M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7' }),
        h('path', { d: 'M6.5 7l.9 12.1A1.5 1.5 0 0 0 8.9 20.5h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7' }),
        h('path', { d: 'M10 11v5M14 11v5' }),
      );
    }

    function SearchIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 15,
          height: 15,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('circle', { cx: 11, cy: 11, r: 6.5 }),
        h('path', { d: 'm16 16 4 4' }),
      );
    }

    function SessionShredderPage({ t, refreshSessions, pruneStaleSessions }) {
      const [sessions, setSessions] = React.useState([]);
      const [total, setTotal] = React.useState(0);
      const [totalBytes, setTotalBytes] = React.useState(0);
      const [hidden, setHidden] = React.useState(0);
      const [loading, setLoading] = React.useState(true);
      const [error, setError] = React.useState(null);
      const [query, setQuery] = React.useState('');
      const [sort, setSort] = React.useState('size');
      const [selected, setSelected] = React.useState(() => new Set());
      const [confirmOpen, setConfirmOpen] = React.useState(false);
      const [purgeAttachments, setPurgeAttachments] = React.useState(true);
      const [busy, setBusy] = React.useState(false);
      const [pruning, setPruning] = React.useState(false);
      const [notice, setNotice] = React.useState(null);
      const cancelRef = React.useRef(null);
      const deleteRef = React.useRef(null);
      const selectAllRef = React.useRef(null);
      const wasOpen = React.useRef(false);

      const load = React.useCallback(async () => {
        setLoading(true);
        try {
          const value = await requestJson('/api/session-shredder/sessions');
          setSessions(Array.isArray(value.sessions) ? value.sessions : []);
          setTotal(typeof value.total === 'number' ? value.total : 0);
          setTotalBytes(typeof value.totalBytes === 'number' ? value.totalBytes : 0);
          setHidden(typeof value.hidden === 'number' ? value.hidden : 0);
          setError(null);
        } catch (loadError) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        } finally {
          setLoading(false);
        }
      }, []);

      React.useEffect(() => {
        void load();
      }, [load]);

      React.useEffect(() => {
        setSelected((previous) => {
          if (previous.size === 0) return previous;
          const eligible = new Set(sessions.filter((session) => !session.live).map((session) => session.id));
          const next = new Set([...previous].filter((id) => eligible.has(id)));
          return next.size === previous.size ? previous : next;
        });
      }, [sessions]);

      React.useEffect(() => {
        if (confirmOpen) {
          wasOpen.current = true;
          const timer = setTimeout(() => cancelRef.current?.focus(), 0);
          return () => clearTimeout(timer);
        }
        if (wasOpen.current) {
          wasOpen.current = false;
          deleteRef.current?.focus();
        }
        return undefined;
      }, [confirmOpen]);

      const visible = React.useMemo(() => {
        const needle = query.trim().toLowerCase();
        const rows = sessions.filter((session) => {
          if (needle === '') return true;
          return (
            String(session.title ?? '').toLowerCase().includes(needle) ||
            session.id.toLowerCase().includes(needle) ||
            String(session.cwd ?? '').toLowerCase().includes(needle)
          );
        });
        rows.sort((left, right) => {
          if (sort === 'size') return right.bytes - left.bytes || (right.createdAt ?? 0) - (left.createdAt ?? 0);
          return (right.createdAt ?? 0) - (left.createdAt ?? 0) || right.bytes - left.bytes;
        });
        return rows;
      }, [sessions, query, sort]);

      const eligibleVisible = React.useMemo(() => visible.filter((session) => !session.live), [visible]);
      const allSelected = eligibleVisible.length > 0 && eligibleVisible.every((session) => selected.has(session.id));
      const someSelected = eligibleVisible.some((session) => selected.has(session.id));

      React.useEffect(() => {
        if (selectAllRef.current !== null) selectAllRef.current.indeterminate = someSelected && !allSelected;
      }, [someSelected, allSelected]);

      const selectedSessions = React.useMemo(
        () => sessions.filter((session) => selected.has(session.id)),
        [sessions, selected],
      );
      const selectedBytes = selectedSessions.reduce((sum, session) => sum + session.bytes, 0);
      const maxBytes = Math.max(1, ...sessions.map((session) => session.bytes));

      const toggle = (id) => {
        setSelected((previous) => {
          const next = new Set(previous);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      };

      const toggleAll = () => {
        setSelected((previous) => {
          const next = new Set(previous);
          if (allSelected) {
            for (const session of eligibleVisible) next.delete(session.id);
          } else {
            for (const session of eligibleVisible) next.add(session.id);
          }
          return next;
        });
      };

      const performDelete = async () => {
        const ids = selectedSessions.map((session) => session.id);
        if (ids.length === 0) return;
        setBusy(true);
        try {
          const value = await requestJson('/api/session-shredder/delete', {
            method: 'POST',
            body: JSON.stringify({ sessionIds: ids, confirm: true, purgeAttachments }),
          });
          const details = [];
          if (Array.isArray(value.warnings)) details.push(...value.warnings);
          for (const target of Array.isArray(value.targets) ? value.targets : []) {
            for (const item of Array.isArray(target.errors) ? target.errors : []) details.push(`${target.id}: ${item}`);
          }
          setNotice({
            kind: value.ok ? 'success' : 'warning',
            text: value.ok
              ? t('done', { count: ids.length, size: formatBytes(value.deletedBytes) })
              : t('partial'),
            details: details.join('\n'),
          });
          setConfirmOpen(false);
          setSelected(new Set());
          await load();
          try {
            // Refresh the Client catalog and drop any row whose data is gone,
            // including the row just deleted. The manual "clear stale entries"
            // button remains for leftovers from older sessions.
            if (typeof pruneStaleSessions === 'function') await pruneStaleSessions();
            else await refreshSessions?.();
          } catch {
            // The page already reflects the deletion; a sidebar sync failure is not a purge failure.
          }
        } catch (deleteError) {
          setConfirmOpen(false);
          setNotice({
            kind: 'error',
            text: t('failed', { message: deleteError instanceof Error ? deleteError.message : String(deleteError) }),
          });
        } finally {
          setBusy(false);
        }
      };

      const pruneEntries = async () => {
        if (pruning || loading) return;
        if (hidden > 0) {
          setNotice({ kind: 'error', text: t('pruneBlocked') });
          return;
        }
        setPruning(true);
        try {
          if (typeof pruneStaleSessions !== 'function') throw new Error('prune API unavailable');
          const removed = await pruneStaleSessions();
          if (typeof removed !== 'number' || removed < 0) throw new Error(t('pruneBlocked'));
          setNotice({
            kind: removed > 0 ? 'success' : 'info',
            text: removed > 0 ? t('pruneDone', { count: removed }) : t('pruneNone'),
          });
          await load();
        } catch (pruneError) {
          setNotice({
            kind: 'error',
            text: t('pruneFailed', { message: pruneError instanceof Error ? pruneError.message : String(pruneError) }),
          });
        } finally {
          setPruning(false);
        }
      };

      const onDialogKeyDown = (event) => {
        if (event.key === 'Escape' && !busy) {
          event.preventDefault();
          event.stopPropagation();
          setConfirmOpen(false);
          return;
        }
        if (event.key !== 'Tab') return;
        const focusable = [...event.currentTarget.querySelectorAll('button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
          (element) => !element.disabled,
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      };

      const sortButton = (value, label) =>
        h(
          'button',
          {
            type: 'button',
            className: cx('ss-sort-btn', sort === value && 'ss-sort-active'),
            'aria-pressed': sort === value,
            onClick: () => setSort(value),
          },
          label,
        );

      const row = (session) =>
        h(
          'li',
          { key: session.id, className: cx('ss-row', session.live && 'ss-row-live') },
          h('input', {
            type: 'checkbox',
            className: 'ss-row-check',
            checked: selected.has(session.id),
            disabled: session.live,
            onChange: () => toggle(session.id),
            'aria-label': t('selectRow', { title: session.title ?? session.id }),
            title: session.live ? t('cannotSelectLive') : undefined,
          }),
          h(
            'div',
            { className: 'ss-row-main' },
            h(
              'div',
              { className: 'ss-row-top' },
              h('span', { className: 'ss-row-title', title: session.title ?? session.id }, session.title ?? t('sessionFallback')),
              h(
                'span',
                { className: 'ss-badges' },
                session.live ? h('span', { className: 'ss-badge ss-badge-live' }, t('live')) : null,
                session.subagent ? h('span', { className: 'ss-badge' }, t('subagent')) : null,
                session.orphan ? h('span', { className: 'ss-badge' }, t('orphan')) : null,
              ),
              h('span', { className: 'ss-row-size' }, formatBytes(session.bytes)),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ss-row-delete',
                  disabled: session.live,
                  onClick: () => {
                    setSelected(new Set([session.id]));
                    setConfirmOpen(true);
                  },
                  'aria-label': t('deleteRow', { title: session.title ?? session.id }),
                },
                t('delete'),
              ),
            ),
            h(
              'div',
              { className: 'ss-row-meta' },
              h('code', { className: 'ss-id' }, session.id),
              session.cwd ? h('span', { className: 'ss-cwd', title: session.cwd }, session.cwd) : null,
              session.createdAt ? h('span', { className: 'ss-meta-date' }, t('createdAt', { date: formatDate(session.createdAt) })) : null,
            ),
            h(
              'div',
              { className: 'ss-bar', 'aria-hidden': 'true' },
              h('span', {
                className: 'ss-bar-fill',
                style: { width: session.bytes > 0 ? `${Math.max(1, (session.bytes / maxBytes) * 100)}%` : '0%' },
              }),
            ),
          ),
        );

      let body;
      if (loading && sessions.length === 0) {
        body = h('div', { className: 'ss-empty', role: 'status' }, h('span', { className: 'ss-spinner' }), h('p', null, t('loading')));
      } else if (error !== null && sessions.length === 0) {
        body = h(
          'div',
          { className: 'ss-empty', role: 'alert' },
          h('p', { className: 'ss-error' }, t('loadError', { message: error })),
          h('button', { type: 'button', className: 'ss-btn', onClick: () => void load() }, t('retry')),
        );
      } else if (visible.length === 0) {
        body = h('div', { className: 'ss-empty', role: 'status' }, h('p', null, t(sessions.length === 0 ? 'empty' : 'noMatches')));
      } else {
        body = h('ul', { className: 'ss-list', 'aria-busy': loading }, visible.map(row));
      }

      return h(
        'section',
        { className: 'ss-page', 'aria-label': t('title') },
        h('style', null, CSS),
        h(
          'div',
          { className: 'ss-scroll' },
          h(
            'div',
            { className: 'ss-content' },
            h(
              'div',
              { className: 'ss-head' },
              h(
                'div',
                null,
                h('h1', null, t('title')),
                h('p', { className: 'ss-subtitle' }, t('subtitle')),
              ),
              h(
                'div',
                { className: 'ss-head-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ss-btn',
                    title: hidden > 0 ? t('pruneBlocked') : t('pruneHint'),
                    disabled: loading || pruning || hidden > 0,
                    onClick: () => void pruneEntries(),
                  },
                  pruning ? t('pruningLabel') : t('prune'),
                ),
                h(
                  'button',
                  { type: 'button', className: 'ss-btn', onClick: () => void load(), disabled: loading },
                  loading ? t('refreshing') : t('refresh'),
                ),
              ),
            ),
            h(
              'div',
              { className: 'ss-stats' },
              h('span', null, t('total', { count: total })),
              h('span', null, t('usage', { size: formatBytes(totalBytes) })),
              hidden > 0 ? h('span', null, t('hidden', { count: hidden })) : null,
            ),
            error !== null && sessions.length > 0 ? h('div', { className: 'ss-error-banner', role: 'alert' }, t('loadError', { message: error })) : null,
            notice !== null
              ? h(
                  'div',
                  { className: cx('ss-notice', `ss-notice-${notice.kind}`), role: notice.kind === 'error' ? 'alert' : 'status' },
                  h(
                    'div',
                    { className: 'ss-notice-body' },
                    h('span', null, notice.text),
                    notice.details
                      ? h('details', null, h('summary', null, t('details')), h('pre', null, notice.details))
                      : null,
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'ss-notice-dismiss', 'aria-label': t('close'), onClick: () => setNotice(null) },
                    '×',
                  ),
                )
              : null,
            h(
              'div',
              { className: 'ss-toolbar' },
              h(
                'div',
                { className: 'ss-search' },
                h(SearchIcon),
                h('input', {
                  type: 'search',
                  value: query,
                  onChange: (event) => setQuery(event.target.value),
                  placeholder: t('searchPlaceholder'),
                  'aria-label': t('search'),
                }),
                query !== ''
                  ? h(
                      'button',
                      { type: 'button', className: 'ss-search-clear', 'aria-label': t('close'), onClick: () => setQuery('') },
                      '×',
                    )
                  : null,
              ),
              h(
                'div',
                { className: 'ss-sort', role: 'group', 'aria-label': t('sortLabel') },
                sortButton('size', t('sortSize')),
                sortButton('time', t('sortTime')),
              ),
            ),
            h(
              'div',
              { className: 'ss-selection' },
              h(
                'label',
                { className: 'ss-select-all' },
                h('input', {
                  ref: selectAllRef,
                  type: 'checkbox',
                  checked: allSelected,
                  disabled: eligibleVisible.length === 0,
                  onChange: toggleAll,
                  'aria-label': t('selectAll'),
                }),
                h(
                  'span',
                  null,
                  selectedSessions.length > 0
                    ? t('selected', { count: selectedSessions.length, size: formatBytes(selectedBytes) })
                    : t('selectedNone'),
                ),
              ),
              h(
                'button',
                {
                  ref: deleteRef,
                  type: 'button',
                  className: 'ss-btn ss-btn-danger',
                  disabled: selectedSessions.length === 0 || busy,
                  onClick: () => setConfirmOpen(true),
                },
                t('deleteSelected'),
              ),
            ),
            body,
            h('p', { className: 'ss-note' }, t('note')),
          ),
        ),
        confirmOpen
          ? h(
              'div',
              {
                className: 'ss-overlay',
                onMouseDown: (event) => {
                  if (event.target === event.currentTarget && !busy) setConfirmOpen(false);
                },
              },
              h(
                'div',
                {
                  className: 'ss-dialog',
                  role: 'dialog',
                  'aria-modal': 'true',
                  'aria-labelledby': 'ss-delete-title',
                  onKeyDown: onDialogKeyDown,
                },
                h('h2', { id: 'ss-delete-title' }, t('deleteTitle')),
                h('p', null, t('deleteBody', { count: selectedSessions.length, size: formatBytes(selectedBytes) })),
                h(
                  'ul',
                  { className: 'ss-dialog-list' },
                  selectedSessions.slice(0, 8).map((session) => h('li', { key: session.id }, session.title ?? session.id)),
                ),
                selectedSessions.length > 8
                  ? h('p', { className: 'ss-muted' }, `+${selectedSessions.length - 8}`)
                  : null,
                h(
                  'label',
                  { className: 'ss-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: purgeAttachments,
                    onChange: (event) => setPurgeAttachments(event.target.checked),
                    disabled: busy,
                  }),
                  h('span', null, t('deleteAttachments')),
                ),
                h(
                  'div',
                  { className: 'ss-dialog-actions' },
                  h(
                    'button',
                    { ref: cancelRef, type: 'button', className: 'ss-btn', disabled: busy, onClick: () => setConfirmOpen(false) },
                    t('cancel'),
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'ss-btn ss-btn-danger', disabled: busy, onClick: () => void performDelete() },
                    busy ? t('deleting') : t('confirmDelete'),
                  ),
                ),
              ),
            )
          : null,
      );
    }

    return {
      inject: ['slots', 'locale', 'sessions'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-shredder: dictionaries');
        const t = ctx.locale.bind(NS);
        const refreshSessions = async () => {
          try {
            await ctx.sessions.refresh();
          } catch {
            // Best-effort: keep the deletion result even if the catalog pull fails.
          }
        };
        /**
         * Pull the authoritative Host catalog, then drop any Client-side row
         * whose session no longer exists there. This cleans entries left behind
         * by deletions performed before the page learned to refresh the list.
         */
        const pruneStaleSessions = async (keepIds) => {
          let keep;
          if (Array.isArray(keepIds)) {
            keep = new Set(keepIds);
          } else {
            // Pull the authoritative list at click time so a session created
            // after this page loaded is never mistaken for a stale row.
            const data = await requestJson('/api/session-shredder/sessions');
            if (data !== null && typeof data.hidden === 'number' && data.hidden > 0) return -1;
            keep = new Set((Array.isArray(data?.sessions) ? data.sessions : []).map((session) => session.id));
          }
          await ctx.sessions.refresh();
          const snapshot = ctx.sessions.list.getSnapshot();
          const stale = snapshot.ids.filter((id) => !keep.has(id));
          if (stale.length === 0) return 0;
          if (typeof ctx.sessions.handleSessionRemoved !== 'function') return -1;
          for (const id of stale) {
            try {
              ctx.sessions.handleSessionRemoved(id);
            } catch {
              // Keep going: one stubborn row must not block the rest of the cleanup.
            }
          }
          return stale.length;
        };
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: 'session-shredder',
              locale: NS,
              inject: () => ({ refreshSessions, pruneStaleSessions }),
            },
            SessionShredderPage,
          ),
        );
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'session-shredder',
              order: 20,
              locale: NS,
              label: () => t('panel'),
            },
            ShredderIcon,
          ),
        );
      },
    };
  },
});