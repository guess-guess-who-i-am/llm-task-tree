import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const markdown='# LLM Task Graph Subtree\n\n> Fold root: DOC_S05\n\n## DOC_S05 - 设计方案\n- Problem: 如何完成设计？\n\n## DOC_S05_DESIGN - 中文标题与事实\n- Notes: 保留中文正文。\n\n# GraphState\n- Current: DOC_S05\n- Next: DOC_S05_DESIGN\n\n# Edges\n## E_DESIGN - 设计关系\n- Endpoints: DOC_S05, DOC_S05_DESIGN\n';

test('raw subtree HTTP save validates IDs before creating, backing up or overwriting files',{timeout:30000},async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'subtree-save-http-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const main='# LLM Task Graph\n## ROOT - 主树\n## DOC_S05 - 设计阶段\n# GraphState\n- Current: ROOT\n- Next: ROOT\n# Edges\n';
  await writeFile(path.join(root,'task-tree.md'),main);
  const child=spawn(process.execPath,['server.js'],{env:{...process.env,TASK_TREE_PROJECT_ROOT:root,PORT:'0',TASK_TREE_NO_OPEN:'1'},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(child.exitCode!==null)return;const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;});
  let log='';
  const base=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(log)),15000);
    child.stdout.on('data',chunk=>{log+=chunk;const url=log.match(/running at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];if(url){clearTimeout(timer);resolve(url);}});
    child.stderr.on('data',chunk=>log+=chunk);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
  });
  const save=(target,text)=>fetch(base+'/api/subtree-file',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:target,markdown:text,reason:'验证原始子树保存边界'})});
  const target='subtrees/design.md';
  const valid=await save(target,markdown);
  assert.equal(valid.status,200,await valid.text());
  assert.equal(await readFile(path.join(root,target),'utf8'),markdown,'ASCII IDs and Chinese titles/text remain accepted');
  for(const invalid of [markdown.replaceAll('DOC_S05_DESIGN','DOC_S05_设计方案'),markdown.replaceAll('DOC_S05_DESIGN','DOC_S05.1'),markdown.replace('## E_DESIGN -','## E_设计 -')]) {
    for(const file of [target,'subtrees/invalid-new.md']) {
      const response=await save(file,invalid);
      assert.equal(response.status,400,`${file}: ${await response.clone().text()}`);
      assert.match((await response.json()).error,/ID/);
      assert.equal(await readFile(path.join(root,target),'utf8'),markdown);
      await assert.rejects(access(path.join(root,'subtrees/invalid-new.md')),{code:'ENOENT'});
      await assert.rejects(access(path.join(root,'versions/subtrees')),{code:'ENOENT'});
      assert.equal(await readFile(path.join(root,'task-tree.md'),'utf8'),main);
    }
  }
  for(const title of ['## DOC_S13_药品业务入口','## DOC_S05_DESIGN','## DOC_S05_DESIGN -','## DOC_S05_DESIGN -   ']) {
    const malformed=markdown.replace('## DOC_S05_DESIGN - 中文标题与事实',title);
    for(const endpoint of ['/api/subtree-file','/api/subtree-file/fold']) {
      for(const file of [target,'subtrees/malformed-new.md']) {
        const response=await fetch(base+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:file,markdown:malformed,foldRoot:'DOC_S05',mode:'attach',reason:'拒绝被解析器忽略的节点标题'})});
        assert.equal(response.status,400,`${endpoint}: ${title}: ${await response.clone().text()}`);
        assert.match((await response.json()).error,/节点标题/);
        assert.equal(await readFile(path.join(root,target),'utf8'),markdown);
        await assert.rejects(access(path.join(root,'subtrees/malformed-new.md')),{code:'ENOENT'});
        await assert.rejects(access(path.join(root,'versions/subtrees')),{code:'ENOENT'});
        assert.equal(await readFile(path.join(root,'task-tree.md'),'utf8'),main);
      }
    }
  }
});
