import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function polling() {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function pollTreeChanges()');
  const end = source.indexOf('\nasync function saveTree()', start);
  let release;
  const response = new Promise(resolve => { release = resolve; });
  const applied = [];
  const context = vm.createContext({
    dirty: false, saveInFlight: false, saveTimer: null, modelPanelLoading: false,
    workspaceMode: 'main', activeSubtreePath: '', viewTreeId: 'method', treeLoadSequence: 1,
    lastLoadedMarkdown: 'old', lastSavedMarkdown: 'old', treeMarkdownCache: new Map(),
    fetch: async () => response, treeApiUrl: url => url,
    loadFromMarkdown: value => applied.push(value), setSaveState: () => {},
    loadVersions: async () => {}, writeCurrentVersionSnapshot: async () => {},
    isViewingActiveMethodTree: () => true
  });
  vm.runInContext(source.slice(start, end), context);
  return { context, applied, release: () => release({ ok: true, json: async () => ({ markdown: 'new' }) }) };
}

for (const [name, mutate] of [
  ['tree switched while response was pending', c => { c.viewTreeId = 'other'; }],
  ['subtree switched while response was pending', c => { c.workspaceMode = 'subtree'; c.activeSubtreePath = 'subtrees/B.md'; }],
  ['same tree reloaded while response was pending', c => { c.treeLoadSequence++; }],
  ['user edits made while response was pending', c => { c.dirty = true; }],
  ['save started while response was pending', c => { c.saveInFlight = true; }]
]) test(`background refresh discards stale response: ${name}`, async () => {
  const { context, applied, release } = await polling();
  const pending = context.pollTreeChanges(); mutate(context); release(); await pending;
  assert.deepEqual(applied, []);
  assert.equal(context.treeMarkdownCache.size, 0);
});

test('background refresh updates the unchanged owning tree and subtree', async () => {
  for (const mode of ['main', 'subtree']) {
    const { context, applied, release } = await polling();
    context.workspaceMode = mode;
    if (mode === 'subtree') context.activeSubtreePath = 'subtrees/A.md';
    const pending = context.pollTreeChanges(); release(); await pending;
    assert.deepEqual(applied, ['new']);
  }
});

test('terminal dialogue shows the host receipt once, not a second obsolete worker answer', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function directRunStreamValue(');
  const end = source.indexOf('\nfunction updateDirectRunStreamElement', start);
  const context = vm.createContext({});
  const declarations = [...source.matchAll(/^(?:async )?function (\w+)\(/gm)];
  for (const name of ['directRunMessageParts', 'directRunLiveParts']) {
    const index = declarations.findIndex(match => match[1] === name);
    vm.runInContext(source.slice(declarations[index].index, declarations[index + 1]?.index ?? source.length), context);
  }
  vm.runInContext(source.slice(start, end), context);
  const run = { status: 'completed', output: '执行者报告', messages: [{role:'assistant',content:'执行者报告\n\n【实际交付回执】'}] };
  assert.equal(context.directRunStreamValue(run, 'output'), '');
  assert.equal(context.directRunStreamValue({...run,status:'running'}, 'output'), '');
  assert.equal(context.directRunLiveParts({...run,status:'running'}).process, '执行者报告');
  assert.equal(context.directRunStreamValue({...run,output:'尚未保存的输出'}, 'output'), '尚未保存的输出');
});
