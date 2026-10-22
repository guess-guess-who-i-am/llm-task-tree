import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {chmod,copyFile,lstat,mkdir,readFile,readdir,realpath,rename,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const registrationQueues=new Map();

export const REVIEW_INPUT_REGISTRY='.task-tree-review-inputs.json';
export const REVIEW_INPUTS_TOOL={
  name:'task_tree_review_inputs',
  description:'登记或查看本分支测试/复现需要的本地非Git输入。宿主会保存隔离的只读快照供子分支和最终检查使用；不把输入加入Git。只登记实际需要的项目内相对路径（文件或目录），不要登记整个项目、凭据或缓存。生成/取得输入后尽早登记，宿主在交接及结束时捕获。输入副本只读，待交付的修改/派生结果写入另一个产物路径，不能靠修改输入副本交付。',
  inputSchema:{type:'object',properties:{action:{type:'string',enum:['register','list']},paths:{type:'array',items:{type:'string'}}},required:['action'],additionalProperties:false}
};
const fail=(code,message,details={})=>Object.assign(new Error(message),{code,...details});
const blocked=file=>file==='.task-tree-runs/review-inputs'||file.startsWith('.task-tree-runs/review-inputs/')
  ||file.split('/').some(part=>/^(?:\.git|\.ssh|node_modules|\.task-tree-review-inputs\.json|\.task-tree-review-input-state\.json)$/.test(part)
  || /^\.env(?:\..*)?$/.test(part)||/^(?:id_rsa|id_ed25519|credentials)(?:\..*)?$/.test(part)||/\.(?:pem|key|p12|pfx)$/i.test(part));

function relativeInput(value) {
  if(typeof value!=='string'||!value||value.includes('\0')||value.includes('\\')||path.isAbsolute(value)||/^[A-Za-z]:/.test(value))
    throw fail('REVIEW_INPUT_PATH_INVALID',`检查输入必须是项目内相对路径：${String(value)}`);
  const relative=path.posix.normalize(value);
  if(relative==='.'||relative==='..'||relative.startsWith('../')||blocked(relative))
    throw fail('REVIEW_INPUT_PATH_INVALID',`不允许登记整个项目、越界路径或凭据：${value}`);
  return relative;
}
async function safePath(root,relative,{missing=false}={}) {
  const parts=relative.split('/');
  let current=root;
  for(const [index,part]of parts.entries()){
    current=path.join(current,part);
    try {
      const info=await lstat(current);
      if(info.isSymbolicLink())throw fail('REVIEW_INPUT_SYMLINK',`检查输入不跟随符号链接：${relative}`,{file:relative});
      if(index<parts.length-1&&!info.isDirectory())
        throw fail(missing?'REVIEW_INPUT_COLLISION':'REVIEW_INPUT_PATH_INVALID',`检查输入的父路径不是目录：${relative}`,{file:relative});
    }catch(error){
      if(error.code==='ENOENT'){
        if(missing)return current;
        throw fail('REVIEW_INPUT_MISSING',`已登记的检查输入不存在：${path.join(root,relative)}`,{file:relative,sourceRoot:root});
      }
      throw error;
    }
  }
  return current;
}
async function registry(root) {
  let raw;
  try {raw=await readFile(await safePath(root,REVIEW_INPUT_REGISTRY),'utf8');}
  catch(error){if(error.code==='REVIEW_INPUT_MISSING')return {schema:1,paths:[],registered:false};throw error;}
  let value;
  try {value=JSON.parse(raw);}catch{throw fail('REVIEW_INPUT_MANIFEST_INVALID',`检查输入登记文件不是有效JSON：${path.join(root,REVIEW_INPUT_REGISTRY)}`);}
  if(value?.schema!==1||!Array.isArray(value.paths))throw fail('REVIEW_INPUT_MANIFEST_INVALID','检查输入登记需要 schema:1 与 paths 数组');
  return {schema:1,paths:[...new Set(value.paths.map(relativeInput))],registered:true};
}
export async function registerReviewInputs(cwd,{action='list',paths}={}) {
  const root=await realpath(cwd);
  if(action==='register'){
    const prior=registrationQueues.get(root)||Promise.resolve();
    const pending=prior.catch(()=>{}).then(()=>updateRegistry(root,paths));
    registrationQueues.set(root,pending);
    try{return await pending;}finally{if(registrationQueues.get(root)===pending)registrationQueues.delete(root);}
  }
  const current=await registry(root);
  if(action==='list')return {ok:true,sourceRoot:root,...current};
  throw fail('REVIEW_INPUT_MANIFEST_INVALID','action必须是register或list');
}
async function updateRegistry(root,paths) {
  const current=await registry(root);
  if(!Array.isArray(paths)||!paths.length)throw fail('REVIEW_INPUT_MANIFEST_INVALID','register需要非空paths数组');
  const additions=[...new Set(paths.map(relativeInput))];
  await Promise.all(additions.map(file=>safePath(root,file)));
  const registered=[...new Set([...current.paths,...additions])].sort();
  const target=path.join(root,REVIEW_INPUT_REGISTRY),temporary=`${target}.${randomUUID()}.tmp`;
  try {await writeFile(temporary,JSON.stringify({schema:1,paths:registered})+'\n',{flag:'wx',mode:0o600});await rename(temporary,target);}
  finally {await rm(temporary,{force:true}).catch(()=>{});}
  return {ok:true,sourceRoot:root,schema:1,paths:registered,registered:true};
}
async function digest(file) {
  const hash=createHash('sha256');
  for await(const bytes of createReadStream(file))hash.update(bytes);
  return hash.digest('hex');
}
const version=info=>[info.dev,info.ino,info.size,info.mtimeMs,info.ctimeMs].join(':');

// Inputs are a separate filesystem channel, not project changes. A content
// snapshot survives the source worker's deletion and never follows a symlink.
export async function captureReviewInputs({sourceRoot,snapshotRoot=path.join(os.tmpdir(),'llm-task-tree-review-inputs')}={}) {
  const root=await realpath(sourceRoot),declaration=await registry(root);
  if(!declaration.paths.length)return {schema:1,sourceRoot:root,registered:declaration.registered,paths:[],fileCount:0,bytes:0};
  const directory=path.join(snapshotRoot,randomUUID()),blobs=path.join(directory,'blobs');
  const files=[],directories=[],excluded=[],seen=new Set(),versions=new Map();
  await mkdir(blobs,{recursive:true,mode:0o700});
  async function visit(relative) {
    if(seen.has(relative))return;
    seen.add(relative);
    if(blocked(relative)){excluded.push(relative);return;}
    const source=await safePath(root,relative),before=await lstat(source);
    versions.set(relative,version(before));
    if(before.isDirectory()){
      directories.push(relative);
      for(const child of (await readdir(source)).sort())await visit(`${relative}/${child}`);
      return;
    }
    if(!before.isFile())throw fail('REVIEW_INPUT_PATH_INVALID',`检查输入不是普通文件：${relative}`);
    const pending=path.join(blobs,`${randomUUID()}.tmp`);
    await copyFile(source,pending);
    const sha256=await digest(pending),sourceHash=await digest(source),after=await lstat(source);
    if(version(before)!==version(after)||sha256!==sourceHash)
      throw fail('REVIEW_INPUT_CHANGED',`捕获期间输入发生变化，请重新捕获最新版本：${relative}`,{file:relative});
    const blob=path.join(blobs,sha256);
    await rename(pending,blob);
    await chmod(blob,0o444);
    files.push({path:relative,sha256,bytes:before.size,executable:Boolean(before.mode&0o111)});
  }
  try {
    for(const relative of declaration.paths)await visit(relative);
    for(const [relative,before]of versions){
      const source=await safePath(root,relative);
      if(version(await lstat(source))!==before)throw fail('REVIEW_INPUT_CHANGED',`捕获期间输入发生变化，请重新捕获最新版本：${relative}`,{file:relative});
    }
    const manifest={schema:1,sourceRoot:root,paths:declaration.paths,files,directories,excluded};
    const manifestPath=path.join(directory,'manifest.json');
    await writeFile(manifestPath,JSON.stringify(manifest)+'\n',{flag:'wx',mode:0o400});
    return {schema:1,sourceRoot:root,snapshotRoot:directory,manifestPath,registered:true,paths:declaration.paths,
      fileCount:files.length,bytes:files.reduce((total,file)=>total+file.bytes,0),excluded};
  } catch(error){await rm(directory,{recursive:true,force:true});throw error;}
}

export async function materializeReviewInputs({candidatePath,receipts=[]}={}) {
  const root=await realpath(candidatePath),planned=new Map(),directories=new Set(),sources=[];
  for(const receipt of receipts.filter(Boolean)){
    sources.push({sourceRoot:receipt.sourceRoot,paths:receipt.paths||[],registered:Boolean(receipt.registered),fileCount:receipt.fileCount||0});
    if(!receipt.manifestPath)continue;
    const manifest=JSON.parse(await readFile(receipt.manifestPath,'utf8'));
    if(manifest.schema!==1||!Array.isArray(manifest.files))throw fail('REVIEW_INPUT_MANIFEST_INVALID','检查输入快照格式无效');
    for(const directory of manifest.directories||[])directories.add(relativeInput(directory));
    for(const file of manifest.files){
      const relative=relativeInput(file.path);
      if(!/^[a-f0-9]{64}$/.test(file.sha256))throw fail('REVIEW_INPUT_MANIFEST_INVALID','检查输入摘要无效');
      const previous=planned.get(relative);
      const ancestors=new Set(receipt.supersedes||[]),owners=new Set([receipt.manifestPath]);
      if(previous&&previous.sha256!==file.sha256){
        if(previous.ancestors.has(receipt.manifestPath))continue;
        if(![...previous.owners].every(owner=>ancestors.has(owner)))
          throw fail('REVIEW_INPUT_COLLISION',`不同分支提供了不一致的检查输入：${relative}`,{file:relative});
      }else if(previous){
        for(const owner of previous.owners)owners.add(owner);
        for(const ancestor of previous.ancestors)ancestors.add(ancestor);
      }
      const blob=path.join(receipt.snapshotRoot,'blobs',file.sha256);
      if(await digest(blob)!==file.sha256)throw fail('REVIEW_INPUT_SNAPSHOT_CHANGED',`检查输入快照已损坏：${relative}`,{file:relative});
      planned.set(relative,{...file,blob,owners,ancestors});
    }
  }
  // Validate every collision before writing any overlay; a dependency cannot
  // overwrite tracked candidate code or a different branch's dependency.
  for(const [relative,file]of planned){
    await safePath(root,relative,{missing:true});
    // safePath stops at a missing parent: use the complete validated relative
    // target, whose not-yet-created remainder contains no traversal.
    try {
      const info=await lstat(path.join(root,relative));
      if(!info.isFile()||await digest(path.join(root,relative))!==file.sha256)
        throw fail('REVIEW_INPUT_COLLISION',`检查输入与候选产物冲突，未覆盖：${relative}`,{file:relative});
      file.exists=true;
    }catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const copiedPaths=[];
  for(const relative of directories){
    await safePath(root,relative,{missing:true});
    try {
      if(!(await lstat(path.join(root,relative))).isDirectory())
        throw fail('REVIEW_INPUT_COLLISION',`检查输入目录与候选文件冲突，未覆盖：${relative}`,{file:relative});
    }catch(error){if(error.code!=='ENOENT')throw error;}
    if(planned.has(relative))throw fail('REVIEW_INPUT_COLLISION',`分支输入的文件与目录冲突：${relative}`,{file:relative});
  }
  for(const relative of directories){
    await mkdir(path.join(root,relative),{recursive:true});
  }
  for(const [relative,file]of planned){
    if(file.exists)continue;
    const target=path.join(root,relative);
    await mkdir(path.dirname(target),{recursive:true});
    await safePath(root,path.posix.dirname(relative)==='.'?relative:path.posix.dirname(relative),{missing:true});
    await copyFile(file.blob,target);
    await chmod(target,file.executable?0o555:0o444);
    copiedPaths.push(relative);
  }
  const prompt=[
    '【本轮本地输入交接】以下是Worker明确登记并保存的只读输入快照，已按原相对路径放入当前候选工作区；可直接复用原测试命令。它们不是待交付代码，不要编辑或提交这些副本。',
    ...(sources.length?sources.map(source=>`${source.registered?'已登记':'未登记本地输入'}：${source.sourceRoot}；路径：${source.paths.join(', ')||'(无)'}；快照文件数：${source.fileCount}`):['没有收到本轮本地输入登记；若确实需要额外输入，请明确指出缺失路径，不要伪称测试完成。']),
    '如仍缺少输入，使用以上明确来源或登记清单定位；不要执行 find /、全盘扫描或猜测其它工作区来恢复。输入缺失应说明具体路径与受影响测试。'
  ].join('\n');
  return {prompt,copiedPaths,fileCount:planned.size,sources};
}
