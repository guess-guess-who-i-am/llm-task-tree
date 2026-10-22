import {watch,createReadStream} from 'node:fs';
import {readFile,lstat,readlink} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

let recursiveWatchUnavailable = false;

export function validateReviewScopeFiles(files) {
  if (!Array.isArray(files) || files.length === 0 || files.some(file => typeof file !== 'string'
    || !file || path.isAbsolute(file) || path.win32.isAbsolute(file)
    || file.split(/[\\/]/).includes('..') || file.startsWith(':')))
    throw new TypeError('reviewScopeFiles 必须是非空的项目内相对路径或 Git 路径模式数组');
  return [...files];
}

export function validateReviewDependencyScope(scope) {
  if(!scope||scope.complete!==true)throw new TypeError('验收依赖必须明确声明 complete=true');
  const files=validateReviewScopeFiles(scope.files).map(file=>file.replaceAll('\\','/').replace(/\/$/,''));
  if(files.some(file=>/[\*?\[\]]/.test(file)||file.startsWith(':')||file==='.'||file.includes('//')))
    throw new TypeError('验收依赖需要实际文件或目录，不接受通配符、全项目或 Git 路径模式');
  const normalized=files.map(file=>path.posix.normalize(file));
  if(normalized.some(file=>file==='.'))throw new TypeError('验收依赖不能声明整个项目');
  return [...new Set(normalized)];
}

// Git's inventory/pathspec semantics define the declared boundary. Content
// signatures (not index entries or timestamps) determine whether it changed.
async function projectSnapshot(root, scope) {
  const files = await new Promise((resolve, reject) => {
    const child = spawn('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...(scope || [])], { cwd: root });
    const names = new Set(); let pending = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      pending += chunk; let end;
      while ((end = pending.indexOf('\0')) >= 0) { const name = pending.slice(0, end); if (!ignored(name)) names.add(name); pending = pending.slice(end + 1); }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve([...names].sort()) : reject(new Error(`检查输入清单读取失败：${stderr}`)));
  });
  const snapshot = new Map();
  for (let offset = 0; offset < files.length; offset += 64) {
    const entries = await Promise.all(files.slice(offset, offset + 64).map(async file => {
      return [file, await signature(path.join(root, file))];
    }));
    for (const [file, value] of entries) if (value !== 'absent') snapshot.set(file, value);
  }
  return snapshot;
}

function changedPath(before, after) {
  for (const file of new Set([...before.keys(), ...after.keys()]))
    if (before.get(file) !== after.get(file)) return file;
}

const ignored = file => /(^|\/)(\.git|\.task-tree-[^/]*|versions)(\/|$)/.test(file);
async function signature(file) {
  try {
    const stat=await lstat(file);
    if(stat.isSymbolicLink())return `${stat.mode}:`+await readlink(file);
    if(path.basename(file)==='task-trees.json') {
      const bytes=await readFile(file);
      try {
        const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
          ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
        return `${stat.mode}:`+JSON.stringify(canonical(JSON.parse(bytes.toString('utf8'))));
      }catch{/* Invalid registry still compares exact bytes. */}
    }
    const hash=createHash('sha256');
    for await (const bytes of createReadStream(file)) hash.update(bytes);
    return `${stat.mode}:`+hash.digest('hex');
  } catch(error){if(error.code==='ENOENT')return 'absent';throw error;}
}

// Deterministic dependency invalidation, not an LLM judge. Files read by the
// checker join the watch set. Unknown shell dependencies conservatively cover
// the project unless the caller explicitly declares a COMPLETE dependency scope.
// An output list alone is never evidence of a complete shell dependency set.
export async function createReviewInputWatch({projectRoot,candidatePath,files=[],dependencyScope,signal,platform=process.platform}) {
  const scope = dependencyScope?.complete === true ? dependencyScope.files : undefined;
  if (scope !== undefined) validateReviewScopeFiles(scope);
  const controller=new AbortController(), baseline=new Map();
  let rejectChanged,watcher,closed=false,watchAll=false;
  const observations=new Set();
  const changed=new Promise((_,reject)=>{rejectChanged=reject;});
  changed.catch(()=>{});
  const invalidate=file=>{
    if(closed||controller.signal.aborted)return;
    const error=Object.assign(new Error(`检查输入已更新：${file}`),{code:'REVIEW_INPUT_CHANGED',file});
    controller.abort(error);rejectChanged(error);
  };
  const initialStamp = scope?.length === 0 ? Promise.resolve(new Map()) : projectSnapshot(projectRoot,scope);
  initialStamp.catch(()=>{});
  const add=async file=>{
    const relative=path.relative(candidatePath,path.resolve(candidatePath,file)).replaceAll('\\','/');
    if(relative.startsWith('../')||ignored(relative)||baseline.has(relative))return;
    // Capture the pre-review version, even if the live source changed before
    // its first explicit read. A late live baseline would miss that change.
    const initial=await initialStamp.catch(()=>null);
    baseline.set(relative,initial&&(scope===undefined||initial.has(relative))
      ? initial.get(relative)??'absent' : await signature(path.join(projectRoot,relative)));
  };
  await Promise.all(files.map(add));
  const abort=()=>controller.abort(signal.reason);
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  const validate=async({dependencyScope}={})=>{
    await Promise.all([...observations]);
    const declared=dependencyScope===undefined||dependencyScope?.complete===false?undefined:validateReviewDependencyScope(dependencyScope);
    if (watchAll || scope !== undefined || declared !== undefined) {
      let previous = await initialStamp;
      // The explicit host boundary remains authoritative. A final receipt can
      // narrow only the otherwise-unknown shell fallback, never caller inputs.
      const narrowed=scope===undefined&&declared!==undefined;
      if(narrowed)previous=new Map([...previous].filter(([file])=>declared.some(dep=>file===dep||file.startsWith(dep+'/'))));
      const current = scope?.length === 0 ? new Map() : await projectSnapshot(projectRoot,narrowed?declared.map(file=>`:(literal)${file}`):scope);
      const file = changedPath(previous,current);
      if (file) invalidate(file);
    }
    for(const [file,previous]of baseline){if(await signature(path.join(projectRoot,file))!==previous){invalidate(file);break;}}
    controller.signal.throwIfAborted();
  };
  // Capture before tool execution on every platform, including before the first
  // shell call. A watcher event only prompts a content check; it is not proof.
  if (platform !== 'linux' && !recursiveWatchUnavailable) try {watcher=watch(projectRoot,{recursive:true},(_,file)=>{
    const relative=String(file||'').replaceAll('\\','/');
    if(!relative||ignored(relative))return;
    if(baseline.has(relative))void validate().catch(()=>{});
  });
    watcher.on('error', () => {
      recursiveWatchUnavailable = true;
      watcher.close();
      // Rebuild the review once with a fresh content baseline, without killing
      // the host or accepting an interval whose changes could not be observed.
      invalidate('文件监听不可用，重新核对输入');
    });
  }catch{recursiveWatchUnavailable = true;}
  // Establish the fallback baseline before the checker can run shell tools.
  // Explicit file-only reviews also work outside Git. A shell review must
  // surface an inventory failure when validate() awaits this same promise.
  await initialStamp.catch(()=>{});
  return {signal:controller.signal,changed,validate,
    observe(message){
      const pending=(async()=>{
      if(message.method!=='tool/started')return;
      const {toolName,arguments:args}=message.params||{};
      if(['read_file','view_image'].includes(toolName)&&args?.path)await add(args.path);
      if(toolName==='exec_command')watchAll=true;
      })();
      observations.add(pending);
      void pending.finally(()=>observations.delete(pending)).catch(()=>{});
      return pending;
    },
    close(){closed=true;watcher?.close();signal?.removeEventListener('abort',abort);}
  };
}
