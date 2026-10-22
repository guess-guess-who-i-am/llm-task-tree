import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {estimateContextTokens} from './deepseek-context.js';

// Keep the runtime/Hook receipt intact. Only the model's view of a large shell
// output is replaced with durable references, not a truncated prefix or summary.
export async function projectCommandOutput(result,{inlineTokenBudget,codexHome}={}) {
  const content=JSON.stringify(result);
  if(!result || (typeof result.stdout!=='string'&&typeof result.stderr!=='string')
    || !Number.isFinite(inlineTokenBudget)
    || estimateContextTokens([{role:'tool',content}])<=inlineTokenBudget) return {content};
  const started=performance.now();
  try {
    const root=path.join(codexHome||process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'task-tree-tool-output');
    await mkdir(root,{recursive:true,mode:0o700});
    const directory=await mkdtemp(path.join(root,'command-'));
    const receiptPath=path.join(directory,'receipt.json');
    const archive={receiptPath,sha256:createHash('sha256').update(content).digest('hex'),bytes:Buffer.byteLength(content),complete:true};
    const writes=[writeFile(receiptPath,content,{encoding:'utf8',mode:0o600,flag:'wx'})];
    for(const key of ['stdout','stderr'])if(typeof result[key]==='string') {
      archive[key+'Path']=path.join(directory,key+'.txt');
      archive[key+'Lines']=result[key]?result[key].split('\n').length:0;
      writes.push(writeFile(archive[key+'Path'],result[key],{encoding:'utf8',mode:0o600,flag:'wx'}));
    }
    await Promise.all(writes);
    const {stdout,stderr,...metadata}=result;
    return {content:JSON.stringify({...metadata,archivedOutput:archive,
      outputGuidance:'命令输出较大，已完整保存（不是空输出、没有截断）。先根据退出码定位问题；用 exec_command 在 stdoutPath/stderrPath 按目标检索或读取所需行，原始完整回执在 receiptPath。不要为找一条证据再次把全部历史日志读入上下文。'}),
      archive,durationMs:performance.now()-started};
  } catch(error) {
    // Disk problems must not silently lose output or turn a finished command
    // into a retried side effect. Retain the original model view as fallback.
    return {content,error:String(error.message||error),durationMs:performance.now()-started};
  }
}
