import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createTaskTreeAgentTools} from './task-tree-agent-tools.js';

test('task tree MCP writes can outlive obsolete per-tool timeout without closing the transport',async t=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'long-tree-tool-'));
  const markdown='# LLM Task Graph\n\n## ROOT - 测试\n- CurrentResult: 待完成\n\n# GraphState\n- Current: ROOT\n- Next: ROOT\n\n# Edges\n';
  await writeFile(path.join(cwd,'task-tree.md'),markdown);
  const server=http.createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/api/project'){res.end(JSON.stringify({root:cwd}));return;}
    if(req.url==='/api/tree/node-patch'){
      for await(const chunk of req){};
      await new Promise(r=>setTimeout(r,1200));
      await writeFile(path.join(cwd,'task-tree.md'),markdown.replace('待完成','验证完成'));
      res.end(JSON.stringify({ok:true,changes:[{nodeId:'ROOT',field:'CurrentResult',before:'待完成',after:'验证完成'}]}));return;
    }
    res.end('{}');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  await writeFile(path.join(cwd,'.task-tree-port'),String(server.address().port));
  const bridge=await createTaskTreeAgentTools({cwd,timeoutMs:1000});
  t.after(async()=>{await bridge.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const result=await bridge.call('task_tree_write',{nodeId:'ROOT',fields:{CurrentResult:'验证完成'},reason:'长工具验证'});
  assert.equal(result.ok,true);assert.equal(result.changes[0].after,'验证完成');
  const focus=await bridge.call('task_tree_focus',{});assert.equal(focus.projectRoot,cwd);
});
