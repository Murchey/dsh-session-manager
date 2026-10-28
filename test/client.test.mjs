/**
 * Loads the browser half outside the app, checks its registrations, and walks
 * the initial page element tree with a tiny React stand-in. This catches
 * module-structure, registration, and first-render mistakes without a browser.
 * Run with: node test/client.test.mjs
 */
import assert from 'node:assert/strict';

let definition;
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      definition = value;
    },
  },
};

await import('../client.js');

assert.equal(definition.id, '@murchey/dsh-session-manager');

const hookStates = [];
let hookCursor = 0;

const React = {
  createElement(type, props, ...children) {
    return {
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
    };
  },
  useState(initial) {
    const index = hookCursor++;
    if (!(index in hookStates)) hookStates[index] = typeof initial === 'function' ? initial() : initial;
    return [
      hookStates[index],
      (next) => {
        hookStates[index] = typeof next === 'function' ? next(hookStates[index]) : next;
      },
    ];
  },
  useMemo(factory) {
    return factory();
  },
  useRef(initial) {
    return { current: initial };
  },
  useCallback(fn) {
    return fn;
  },
  useEffect() {},
};

const exported = definition.factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require: ${id}`);
});

assert.deepEqual(exported.inject, ['slots', 'locale', 'sessions']);

const registered = [];
const dictionaries = [];
let refreshCalls = 0;
const removedSessionIds = [];
const ctx = {
  effect(callback) {
    return callback();
  },
  sessions: {
    async refresh() {
      refreshCalls++;
    },
    list: {
      getSnapshot() {
        return { ids: ['session-keep', 'session-stale'] };
      },
    },
    handleSessionRemoved(id) {
      removedSessionIds.push(id);
    },
  },
  locale: {
    register(namespace, dicts) {
      dictionaries.push({ namespace, dicts });
      return () => {};
    },
    bind(namespace) {
      return (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`);
    },
  },
  slots: {
    inject(slot, callback) {
      return callback();
    },
    register(options, Component) {
      registered.push({ slot: options.name, options, Component });
      return () => {};
    },
  },
};

exported.apply(ctx);

assert.equal(dictionaries.length, 1);
assert.equal(dictionaries[0].namespace, 'sessionShredder');
assert.equal(dictionaries[0].dicts.zh.panel, '会话存储');
assert.equal(dictionaries[0].dicts.en.panel, 'Session storage');
assert.ok(dictionaries[0].dicts.zh.deleteTitle);
assert.ok(dictionaries[0].dicts.en.deleteTitle);

const main = registered.find((entry) => entry.slot === 'main');
const panel = registered.find((entry) => entry.slot === 'sidebar.panellist');
assert.ok(main, 'main panel registration');
assert.equal(main.options.key, 'session-shredder');
assert.equal(typeof main.Component, 'function');
assert.equal(typeof main.options.inject, 'function');
const mainInject = main.options.inject();
assert.equal(typeof mainInject.refreshSessions, 'function');
await mainInject.refreshSessions();
assert.equal(refreshCalls, 1);
assert.equal(typeof mainInject.pruneStaleSessions, 'function');
const pruned = await mainInject.pruneStaleSessions(['session-keep']);
assert.equal(pruned, 1);
assert.deepEqual(removedSessionIds, ['session-stale']);
assert.ok(panel, 'sidebar panellist registration');
assert.equal(panel.options.id, 'session-shredder');
assert.equal(panel.options.label(), 'panel');
assert.equal(typeof panel.Component, 'function');

hookCursor = 0;
hookStates.length = 0;
const page = main.Component({
  t: (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`),
});
assert.equal(page.type, 'section');
assert.ok(String(page.props.className).includes('ss-page'));

const classes = new Set();
const texts = [];
const elements = [];

function walk(node) {
  if (node === null || node === undefined || node === false) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child);
    return;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    texts.push(String(node));
    return;
  }
  if (typeof node !== 'object') return;
  if (typeof node.type === 'function') {
    if (node.type.name === 'SearchIcon' || node.type.name === 'ShredderIcon') walk(node.type(node.props));
    return;
  }
  if (node.props?.className) classes.add(String(node.props.className));
  elements.push(node);
  for (const child of node.children) walk(child);
}

walk(page);

assert.ok(classes.has('ss-page'), 'page root class');
assert.ok(classes.has('ss-spinner'), 'loading spinner');
assert.ok(classes.has('ss-search'), 'search field');
assert.ok(classes.has('ss-select-all'), 'select-all control');
assert.ok(classes.has('ss-btn'), 'buttons');
assert.ok(texts.includes('loading'), 'loading copy comes from locale keys');
assert.ok(texts.includes('title'), 'page title comes from locale keys');

const style = elements.find((element) => element.type === 'style');
assert.ok(style, 'page-local style element');
const css = style.children.join('');
assert.ok(css.includes('--dsw-alias-bg-base'), 'theme tokens are used');
assert.ok(css.includes('--dsw-alias-label-secondary'), 'secondary label token is used');
assert.ok(css.includes('backdrop-filter:brightness(.55)'), 'dialog scrim dims instead of washing the screen white');
assert.ok(!css.includes('bg-overlay) 78%'), 'the old milky overlay is gone');
assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'no literal hex colors in page CSS');
assert.ok(!css.includes('@deepseek-ai/dsh-client-ui-primitives'), 'no UI-primitive dependency');

const icon = panel.Component({ size: 18, active: false });
assert.equal(icon.type, 'svg');
assert.equal(icon.props.width, 18);
assert.equal(icon.props['aria-hidden'], 'true');

assert.ok(!Object.keys(dictionaries[0].dicts.zh).some((key) => key.length === 0), 'dictionary keys are non-empty');
console.log('client.test.mjs: all checks passed');