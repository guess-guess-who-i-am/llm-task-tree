import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentRuntime } from './agent-runtime.js';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const require = createRequire(import.meta.url);

test('installed skills accept workspace-relative and home-relative paths without discovery retries',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'runtime-skill-path-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const cwd=path.join(root,'project'),codexHome=path.join(root,'.codex');
  const relative='llm-task-tree/skills/demo/SKILL.md',homeRelative='.codex/skills/personal/SKILL.md';
  await mkdir(path.dirname(path.join(cwd,relative)),{recursive:true});
  await mkdir(path.dirname(path.join(root,homeRelative)),{recursive:true});
  await writeFile(path.join(cwd,relative),'---\nname: demo\n---\n完整项目方法');
  await writeFile(path.join(root,homeRelative),'---\nname: personal\n---\n完整全局方法');
  await writeFile(path.join(cwd,'SKILL.md'),'unregistered');
  const runtime=await createAgentRuntime({cwd,codexHome,homeDir:root,
    treeBridgeFactory:async()=>({tools:[],instructions:'',close:async()=>{}})});
  t.after(()=>runtime.close());
  assert.equal((await runtime.call('skills_read',{name:relative})).content,'---\nname: demo\n---\n完整项目方法');
  assert.equal((await runtime.call('skills_read',{name:'./'+relative})).path,path.join(cwd,relative));
  assert.equal((await runtime.call('skills_read',{name:'~/'+homeRelative})).content,'---\nname: personal\n---\n完整全局方法');
  await assert.rejects(runtime.call('skills_read',{name:'./SKILL.md'}),/installed|登记/);
});

test('caller PATH survives runtime setup and is shared by commands, Hooks and the tree bridge',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'runtime-command-path-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const codexHome=path.join(root,'.codex'),bin=path.join(root,'tools');
  await mkdir(codexHome);await mkdir(bin);
  const command=`"${process.execPath}" -e 'console.log(process.env.PATH)'`;
  await writeFile(path.join(codexHome,'hooks.json'),JSON.stringify({hooks:{UserPromptSubmit:[{hooks:[{type:'command',
    command:`"${process.execPath}" -e 'console.log(JSON.stringify({additionalContext:process.env.PATH}))'`}]}]}}));
  let bridgePath;
  const runtime=await createAgentRuntime({cwd:root,codexHome,homeDir:root,environment:{PATH:bin},
    treeBridgeFactory:async({environment})=>{bridgePath=environment.PATH;return {tools:[],instructions:'',close:async()=>{}};}});
  t.after(()=>runtime.close());
  const result=await runtime.call('exec_command',{command});
  assert.equal(result.ok,true);
  const paths=result.stdout.trim().split(path.delimiter);
  assert.ok(paths.includes(bin),'caller-provided command directories must not be discarded');
  assert.equal(paths[0],path.dirname(process.execPath));
  assert.equal(new Set(paths).size,paths.length,'do not accumulate duplicate PATH entries');
  assert.equal(bridgePath,result.stdout.trim());
  assert.equal((await runtime.hooks('UserPromptSubmit')).context,result.stdout.trim());
});

test('Finder/SSH minimal PATH can run real ripgrep without relying on the Codex shell',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'runtime-bundled-rg-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'example.txt'),'可检索内容');
  const moduleUrl=new URL('./agent-runtime.js',import.meta.url).href;
  const code=`import {createAgentRuntime} from ${JSON.stringify(moduleUrl)};
    const r=await createAgentRuntime({cwd:process.cwd(),homeDir:process.cwd(),codexHome:process.cwd()+"/.codex",
      treeBridgeFactory:async()=>({tools:[],instructions:"",close:async()=>{}})});
    try {console.log(JSON.stringify(await r.call("exec_command",{command:"rg --files"})));}finally{await r.close();}`;
  const child=await promisify(execFile)(process.execPath,['--input-type=module','-e',code],{
    cwd:root,env:{...process.env,PATH:process.platform==='win32'?process.env.SystemRoot+'/System32':'/usr/bin:/bin'}});
  const result=JSON.parse(child.stdout);
  assert.equal(result.ok,true,result.stderr);
  assert.match(result.stdout,/example.txt/);
});

test('runtime exposes local review input registration using the isolated worker root',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'runtime-review-input-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const cwd=path.join(root,'worker'),owner=path.join(root,'owner');
  await mkdir(cwd);await mkdir(owner);
  await mkdir(path.join(cwd,'corpus'));
  await writeFile(path.join(cwd,'corpus/input.json'),'fixture');
  const runtime=await createAgentRuntime({cwd,homeDir:root,codexHome:path.join(root,'.codex'),environment:{TASK_TREE_PROJECT_ROOT:owner},
    treeBridgeFactory:async()=>({tools:[],instructions:'',close:async()=>{}})});
  t.after(()=>runtime.close());
  assert.ok(runtime.tools.some(tool=>tool.function.name==='task_tree_review_inputs'));
  assert.equal((await runtime.call('task_tree_review_inputs',{action:'register',paths:['corpus']})).ok,true);
  assert.deepEqual((await runtime.call('task_tree_review_inputs',{action:'list'})).paths,['corpus']);
  assert.deepEqual(JSON.parse(await readFile(path.join(cwd,'.task-tree-review-inputs.json'),'utf8')).paths,['corpus']);
  await assert.rejects(readFile(path.join(owner,'.task-tree-review-inputs.json')),{code:'ENOENT'});
});

test('execution runtime reads trees structurally without exposing user presentation screenshot tools',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'runtime-presentation-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const schema=name=>({type:'function',function:{name,parameters:{type:'object'}}});
  const invoked=[];
  const runtime=await createAgentRuntime({cwd:root,homeDir:root,codexHome:path.join(root,'.codex'),
    treeBridgeFactory:async()=>({tools:['task_tree_focus','task_tree_read','task_tree_render'].map(schema),instructions:'',close:async()=>{},call:async name=>{invoked.push(name);return {ok:true};}})});
  t.after(()=>runtime.close());
  assert.ok(!runtime.tools.some(t=>t.function.name==='task_tree_render'));
  assert.ok(runtime.tools.some(t=>t.function.name==='task_tree_read'));
  assert.ok(runtime.tools.some(t=>t.function.name==='view_image'),'real visual tasks remain possible');
  await assert.rejects(runtime.call('task_tree_render',{}),/展示|截图/);
  assert.equal(invoked.length,0,'a hallucinated screenshot call cannot bypass routing');
});

test('tools, Hooks and MCP all use the isolated execution root, retaining the owner separately', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-root-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const cwd = path.join(root, 'candidate'), codexHome = path.join(root, 'codex');
  await mkdir(cwd); await mkdir(codexHome);
  const owner = path.join(root, 'owner');
  const script = `"${process.execPath}" -e 'console.log(JSON.stringify({additionalContext:process.env.TASK_TREE_PROJECT_ROOT,owner:process.env.TASK_TREE_OWNER_PROJECT_ROOT}))'`;
  await writeFile(path.join(codexHome, 'hooks.json'), JSON.stringify({hooks:{UserPromptSubmit:[{hooks:[{type:'command',command:script}]}]}}));
  let bridgeRoot;
  const runtime = await createAgentRuntime({cwd, homeDir:root, codexHome, environment:{TASK_TREE_PROJECT_ROOT:owner},
    treeBridgeFactory:async options => { bridgeRoot = options.environment.TASK_TREE_PROJECT_ROOT; return {tools:[],instructions:'',close:async()=>{}}; }});
  t.after(() => runtime.close());
  assert.equal(bridgeRoot, cwd);
  assert.equal((await runtime.hooks('UserPromptSubmit')).context, cwd);
  const output = JSON.parse((await runtime.call('exec_command',{command:script})).stdout);
  assert.equal(output.additionalContext, cwd);
  assert.equal(output.owner, owner);
});

test('lightweight registry routed external Skills are readable without restoring the full startup catalog', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'external-skill-routing-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const cwd=path.join(root,'project'),codexHome=path.join(root,'codex'),external=path.join(root,'external');
  await mkdir(cwd);await mkdir(path.join(codexHome,'skill-registry'),{recursive:true});
  await mkdir(path.join(external,'database'),{recursive:true});
  const file=path.join(external,'database','SKILL.md'),catalog=path.join(external,'catalog.json');
  const content='---\nname: database\ndescription: 数据库优化\n---\n完整方法正文\n'.repeat(1000);
  await writeFile(file,content);
  await writeFile(path.join(codexHome,'skill-registry/skills-index.json'),JSON.stringify({skills:[],externalSkillCount:1}));
  await writeFile(path.join(codexHome,'skill-registry/external-skills-manifest.json'),JSON.stringify({schemaVersion:'graph-tool-call-skills/1',rootPath:external,catalogPath:catalog,externalSkillCount:1}));
  await writeFile(catalog,JSON.stringify({skills:[{name:'database',dir:'database',description:'数据库优化'}]}));
  const runtime=await createAgentRuntime({cwd,codexHome,homeDir:root,treeBridgeFactory:async()=>({tools:[],instructions:'',close:async()=>{}})});
  t.after(()=>runtime.close());
  assert.ok(!runtime.systemPrompt.includes('数据库优化'),'external metadata is not copied into every prompt');
  assert.equal((await runtime.call('skills_read',{name:file})).content,content);
  assert.equal((await runtime.call('skills_read',{name:path.relative(cwd,file)})).content,content,'routed external paths also resolve against the actual workspace');
  const listed=await runtime.call('skills_list',{query:'database'});
  assert.equal(listed.skills.length,1);assert.equal(listed.skills[0].path,file);
  assert.equal((await runtime.call('skills_read',{name:listed.skills[0].id})).content,content);
  const outside=path.join(root,'SKILL.md');await writeFile(outside,'OUTSIDE');
  const {symlink}=await import('node:fs/promises');
  await mkdir(path.join(external,'escape'));await symlink(outside,path.join(external,'escape/SKILL.md'));
  await assert.rejects(runtime.call('skills_read',{name:path.join(external,'escape/SKILL.md')}),/installed|登记|越界/);
  await assert.rejects(runtime.call('skills_read',{name:outside}),/installed|登记|越界/);
  await assert.rejects(runtime.call('skills_read',{name:catalog}),/installed|SKILL.md|登记/);
  const other=path.join(external,'next');await mkdir(other);await writeFile(path.join(other,'SKILL.md'),'新目录正文');
  await writeFile(catalog,JSON.stringify({skills:[{name:'next',dir:'next',description:'下一项'}]}));
  assert.equal((await runtime.call('skills_list',{query:'next'})).skills.find(s=>s.source==='external-library')?.name,'next','catalog changes invalidate the shared lazy cache');
});

test('Stop maintenance classification requires every blocker to emit known structured issue codes',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'stop-maintenance-contract-'));
  const project=path.join(root,'project'),codexHome=path.join(root,'codex');
  await mkdir(path.join(project,'.codex'),{recursive:true});await mkdir(codexHome);
  const payloads=[
    {decision:'block',reason:'TREE_NOT_UPDATED'},
    {decision:'block',reason:'维护',taskTreeMaintenance:{schema:'task-tree-maintenance/v1',issues:[{code:'UNKNOWN',message:'未知'}]}},
    {decision:'block',reason:'维护',taskTreeMaintenance:{schema:'task-tree-maintenance/v1',issues:[{code:'TREE_NOT_UPDATED',message:'缺树维护'}]}}
  ];
  const scripts=[];
  for(let i=0;i<payloads.length;i++){
    const script=path.join(root,`hook-${i}.mjs`);scripts.push(script);
    await writeFile(script,`console.log(${JSON.stringify(JSON.stringify(payloads[i]))});`);
  }
  for(const [indices,expected] of [[[0],false],[[1],false],[[2],true],[[2,0],false]]){
    await writeFile(path.join(project,'.codex/hooks.json'),JSON.stringify({hooks:{Stop:[{hooks:indices.map(i=>({type:'command',command:`"${process.execPath}" "${scripts[i]}"`}))}]}}));
    const runtime=await createAgentRuntime({cwd:project,homeDir:root,codexHome,treeBridgeFactory:async()=>({tools:[],instructions:'',close:async()=>{}})});
    try{const stop=await runtime.hooks('Stop',{});assert.equal(stop.blocked,true);assert.equal(stop.maintenanceOnly,expected);
      if(expected)assert.deepEqual(stop.maintenanceIssues,['TREE_NOT_UPDATED']);
      else if(indices.length===2)assert.ok(stop.nonMaintenanceBlockers.length>0);
    }finally{await runtime.close();}
  }
});

test('shell tools and configured Hooks may run beyond old local command timeouts', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'long-command-'));
  const codexHome=path.join(root,'codex');await mkdir(codexHome);
  const script=`"${process.execPath}" -e 'setTimeout(()=>console.log(JSON.stringify({additionalContext:"长任务完成"})),1200)'`;
  await writeFile(path.join(codexHome,'hooks.json'),JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',command:script,timeout:1}]}]}}));
  const runtime=await createAgentRuntime({cwd:root,homeDir:root,codexHome,
    treeBridgeFactory:async()=>({tools:[],instructions:'',close:async()=>{}})});
  try{
    const [result,hook]=await Promise.all([runtime.call('exec_command',{command:script,timeoutMs:1000}),runtime.hooks('Stop',{})]);
    assert.equal(result.ok,true);assert.equal(result.timedOut,false);assert.match(hook.context,/长任务完成/);
  }finally{await runtime.close();}
});

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
