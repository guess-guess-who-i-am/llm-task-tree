import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentRuntime } from './agent-runtime.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

test('local JPEG reads preserve original image bytes instead of decoding them into UTF-8 garbage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-jpeg-'));
  const { createCanvas } = createRequire(require.resolve('pdfjs-dist/package.json'))('@napi-rs/canvas');
  const canvas = createCanvas(20, 20), context = canvas.getContext('2d');
  context.fillStyle = 'blue'; context.fillRect(0, 0, 20, 20);
  const bytes = canvas.toBuffer('image/jpeg'), file = path.join(root, "Tiger'e photo.jpg");
  await writeFile(file, bytes);
  const runtime = await createAgentRuntime({ cwd: root, homeDir: root, codexHome: path.join(root, '.codex'),
    treeBridgeFactory: async () => ({ tools: [], instructions: '', close: async () => {} }) });
  try {
    const result = await runtime.call('read_file', { path: file });
    assert.equal(result.image?.mimeType, 'image/jpeg');
    assert.equal(result.image?.data, bytes.toString('base64'));
    assert.equal(result.content, undefined, 'JPEG must never become replacement characters in model text');
    const dedicated = await runtime.call('view_image', { path: file });
    assert.deepEqual(dedicated.image, result.image);
    const binary = path.join(root, 'binary.dat'); await writeFile(binary, Buffer.from([0, 255, 254]));
    await assert.rejects(runtime.call('read_file', { path: binary }), /二进制|UTF-8/);
  } finally { await runtime.close(); }
});

test('unknown tool hooks sharing a command stay ordered across lifecycle events and runtime sessions', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'tool-hook-order-'));
  const codexHome=path.join(root,'codex'), project=path.join(root,'project');
  await mkdir(codexHome); await mkdir(project);
  const script=path.join(root,'hook.mjs');
  await writeFile(script,`let input='';for await(const chunk of process.stdin)input+=chunk;const event=JSON.parse(input).hook_event_name;const start=Date.now();await new Promise(r=>setTimeout(r,100));console.log(JSON.stringify({additionalContext:JSON.stringify({event,start,end:Date.now()})}));`);
  const hook={type:'command',command:`'${process.execPath}' '${script}'`};
  await writeFile(path.join(codexHome,'hooks.json'),JSON.stringify({hooks:{PreToolUse:[{hooks:[hook]}],PostToolUse:[{hooks:[hook]}]}}));
  const treeBridgeFactory=async()=>({tools:[],instructions:'',close:async()=>{}});
  const options={cwd:project,codexHome,homeDir:root,treeBridgeFactory};
  const first=await createAgentRuntime(options), second=await createAgentRuntime(options);
  try {
    const results=await Promise.all([first.hooks('PreToolUse',{}),second.hooks('PostToolUse',{}),first.hooks('PreToolUse',{})]);
    const runs=results.map(result=>JSON.parse(result.context));
    assert.ok(runs[1].start>=runs[0].end,'unknown Pre/Post hook commands must not overlap across sessions');
    assert.ok(runs[2].start>=runs[1].end,'the shared hook queue must preserve admission order');
  } finally {await first.close();await second.close();}
});

test('explicitly parallel-safe tool hooks can overlap across calls', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'safe-tool-hooks-'));
  const codexHome=path.join(root,'codex'),project=path.join(root,'project');
  await mkdir(codexHome);await mkdir(project);
  const script=path.join(root,'hook.mjs');
  await writeFile(script,`const start=Date.now();await new Promise(r=>setTimeout(r,100));console.log(JSON.stringify({additionalContext:JSON.stringify({start,end:Date.now()})}));`);
  await writeFile(path.join(codexHome,'hooks.json'),JSON.stringify({hooks:{PreToolUse:[{hooks:[{type:'command',command:`'${process.execPath}' '${script}'`,parallelSafe:true}]}]}}));
  const runtime=await createAgentRuntime({cwd:project,codexHome,homeDir:root,treeBridgeFactory:async()=>({tools:[],instructions:'',close:async()=>{}})});
  try {
    const [a,b]=(await Promise.all([runtime.hooks('PreToolUse',{}),runtime.hooks('PreToolUse',{})])).map(result=>JSON.parse(result.context));
    assert.ok(a.start<b.end && b.start<a.end,'safe hooks must not serialize independent reads');
  } finally {await runtime.close();}
});

test('explicitly independent hooks overlap; unknown hooks remain barriers and context order is stable', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'parallel-hooks-'));
  const codexHome=path.join(root,'codex'), project=path.join(root,'project');
  await mkdir(codexHome); await mkdir(path.join(project,'.codex'),{recursive:true});
  const hooks=[];
  for(const id of ['a','b','barrier','c']) {
    const file=path.join(root,id+'.mjs');
    await writeFile(file,`const start=Date.now();await new Promise(r=>setTimeout(r,120));console.log(JSON.stringify({additionalContext:JSON.stringify({id:${JSON.stringify(id)},start,end:Date.now()})}));`);
    hooks.push({type:'command',command:`'${process.execPath}' '${file}'`,parallelSafe:id!=='barrier'});
  }
  await writeFile(path.join(codexHome,'hooks.json'),JSON.stringify({hooks:{UserPromptSubmit:[{hooks:[hooks[0]]}]}}));
  await writeFile(path.join(project,'.codex/hooks.json'),JSON.stringify({hooks:{UserPromptSubmit:[{hooks:hooks.slice(1)}]}}));
  const runtime=await createAgentRuntime({cwd:project,codexHome,homeDir:root});
  try {
    const result=await runtime.hooks('UserPromptSubmit',{});
    const [a,b,barrier,c]=result.context.split('\n\n').map(JSON.parse);
    assert.ok(a.start<b.end && b.start<a.end,'safe global and project hooks must overlap');
    assert.ok(barrier.start>=a.end && barrier.start>=b.end);
    assert.ok(c.start>=barrier.end);
    assert.equal(result.reports.length,4);
  } finally {await runtime.close();}
});

test('reuses global/project rules, full skills and actual lifecycle hooks without copying configuration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tree-agent-context-'));
  const codexHome = path.join(root, 'codex');
  const project = path.join(root, 'project');
  await mkdir(path.join(codexHome, 'skills', 'demo'), { recursive: true });
  await mkdir(path.join(project, '.codex'), { recursive: true });
  await writeFile(path.join(codexHome, 'AGENTS.md'), 'GLOBAL_RULE_SENTINEL');
  await writeFile(path.join(project, 'AGENTS.md'), 'PROJECT_RULE_SENTINEL');
  const skill = '---\nname: demo\ndescription: isolated test\n---\n' + '完整技能正文\n'.repeat(5000);
  await writeFile(path.join(codexHome, 'skills/demo/SKILL.md'), skill);
  const hook = path.join(project, 'hook.mjs');
  await writeFile(hook, `let s='';for await(const c of process.stdin)s+=c;const i=JSON.parse(s);console.log(JSON.stringify(i.hook_event_name==='Stop'?{decision:'block',reason:'FIX_REQUIRED'}:{hookSpecificOutput:{additionalContext:'HOOK_'+i.hook_event_name}}));`);
  const config = { hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'Stop'].map(event => [event, [{ hooks: [{ type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}`, timeout: 5 }] }]])) };
  await writeFile(path.join(project, '.codex/hooks.json'), JSON.stringify(config));
  const runtime = await createAgentRuntime({ cwd: project, codexHome, homeDir: root });
  try {
  assert.match(runtime.systemPrompt, /GLOBAL_RULE_SENTINEL/);
  assert.match(runtime.systemPrompt, /PROJECT_RULE_SENTINEL/);
  const skills = await runtime.call('skills_list', {});
  assert.ok(skills.skills.some(item => item.name === 'demo'));
  assert.equal((await runtime.call('skills_read', { name: 'demo' })).content, skill);
  const pre = await runtime.hooks('UserPromptSubmit', { prompt: 'test', session_id: 's', turn_id: 't' });
  assert.match(pre.context, /HOOK_UserPromptSubmit/);
  const stop = await runtime.hooks('Stop', { session_id: 's', turn_id: 't' });
  assert.equal(stop.blocked, true);
  assert.match(stop.context, /FIX_REQUIRED/);
  assert.equal(await readFile(path.join(project, 'AGENTS.md'), 'utf8'), 'PROJECT_RULE_SENTINEL');
  } finally { await runtime.close(); }
});

test('large shared catalog stays searchable without being injected; refresh and duplicate names are explicit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tree-skill-index-'));
  const codexHome = path.join(root, 'codex');
  const project = path.join(root, 'project');
  await mkdir(path.join(codexHome, 'skill-registry'), { recursive: true }); await mkdir(project);
  const full = '完整正文\n'.repeat(10000);
  const file = path.join(root, 'external-SKILL.md'); await writeFile(file,full);
  const index = path.join(codexHome,'skill-registry/skills-index.json');
  const skills = Array.from({length:16000},(_,i)=>({id:`external:s${i}`,name:`s${i}`,description:`Skill ${i}`,path:path.join(root,`${i}/SKILL.md`),source:'external-library'}));
  skills[123].path = file;
  await writeFile(index,JSON.stringify({skills}));
  const runtime=await createAgentRuntime({cwd:project,codexHome,homeDir:root});
  try {
    const baselineCount = runtime.skillCount;
    assert.equal((await runtime.call('skills_list',{})).skills.filter(s=>s.source==='external-library').length,16000);
    assert.ok(Buffer.byteLength(runtime.systemPrompt)<10000);
    assert.equal((await runtime.call('skills_list',{query:'external:s123'})).skills[0].id,'external:s123');
    assert.equal((await runtime.call('skills_read',{name:'external:s123'})).content,full);
    const other=path.join(root,'other-SKILL.md'); await writeFile(other,'other');
    skills.push({id:'extra:s123',name:'s123',path:other,source:'external-library'});
    await writeFile(index,JSON.stringify({skills}));
    await runtime.hooks('SessionStart',{source:'startup'});
    assert.equal(runtime.skillCount,baselineCount+1);
    assert.equal((await runtime.call('skills_read',{name:'s123'})).ok,false);
    assert.equal((await runtime.call('skills_read',{name:other})).content,'other');
    assert.ok(runtime.tools.some(t=>t.function.name==='task_tree_flow_status'));
    assert.ok(runtime.tools.some(t=>t.function.name==='task_tree_subtree'));
  } finally { await runtime.close(); }
});
