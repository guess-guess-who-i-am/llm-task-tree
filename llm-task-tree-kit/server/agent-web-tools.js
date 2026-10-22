import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, link, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { localNetworkEnvironment } from './network-environment.js';

function httpUrl(value) {
  const url=new URL(value);
  if(!['https:','http:'].includes(url.protocol) || url.username || url.password) throw new Error('需要不含账号密码的 HTTP(S) 地址');
  return url.href;
}
function run(executable,args,{cwd,env,signal}) {
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    const abort=()=>child.kill('SIGKILL');
    signal?.addEventListener('abort',abort,{once:true});
    child.stdout.setEncoding('utf8').on('data',text=>{stdout+=text;});
    child.stderr.setEncoding('utf8').on('data',text=>{stderr+=text;});
    child.once('error',error=>{signal?.removeEventListener('abort',abort);reject(error);});
    child.once('close',code=>{
      signal?.removeEventListener('abort',abort);
      if(signal?.aborted)reject(signal.reason || new Error('已取消下载'));
      else if(code!==0)reject(new Error(`网络请求失败（${code}）：${stderr || stdout}`));
      else resolve(stdout);
    });
    if(signal?.aborted)abort();
  });
}
async function retrieve(url,file,options) {
  const env={...options.env};
  // curl intentionally ignores uppercase HTTP_PROXY; preserve the host setting.
  if(env.HTTP_PROXY && !env.http_proxy)env.http_proxy=env.HTTP_PROXY;
  // Mature redirect/proxy/TLS support. No shell interpolation or total task deadline.
  // Fail only when connection cannot start or data has stopped arriving.
  const output=await run(process.platform==='win32'?'curl.exe':'curl',[
    '--location','--fail','--silent','--show-error','--compressed','--proto','=http,https','--proto-redir','=http,https',
    '--connect-timeout','15','--speed-time','60','--speed-limit','1',
    '--user-agent','TaskTreeIDE/1.0 (public research retrieval)',
    '--output',file,'--write-out','%{json}','--url',httpUrl(url)
  ],{...options,env});
  const receipt=JSON.parse(output);
  return {finalUrl:receipt.url_effective,status:receipt.http_code,contentType:receipt.content_type || ''};
}
async function fingerprint(file) {
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(file))hash.update(chunk);
  return hash.digest('hex');
}
export function createAgentWebTools({cwd,env,signal,search}) {
  let networkEnvironment;
  const network=()=>networkEnvironment ||= localNetworkEnvironment(env);
  return {
    web_search: async args=>{
      const query=String(args.query || '').trim();
      if(!query)throw new Error('联网搜索需要 query');
      const result=await search({action:'web',query,...(args.topK!==undefined?{topK:args.topK}:{})});
      return {...result,capability:'web_search',note:'联网搜索与本地知识库索引独立；公开论文下载不需要搜索 API key。'};
    },
    web_search_batch: async args=>{
      signal?.throwIfAborted();
      const result=await search({action:'web_batch',queries:args.queries,...(args.topK!==undefined?{topK:args.topK}:{}),...(args.concurrency!==undefined?{concurrency:args.concurrency}:{}),...(args.refresh!==undefined?{refresh:args.refresh}:{})});
      signal?.throwIfAborted();return result;
    },
    fetch_url: async args=>{
      const temp=path.join(os.tmpdir(),`task-tree-web-${randomUUID()}`);
      try {
        const receipt=await retrieve(args.url,temp,{cwd,env:await network(),signal});
        const bytes=await readFile(temp);
        if(bytes.subarray(0,1024).includes(Buffer.from('%PDF-')) || bytes.includes(0)) throw new Error('这是 PDF 或二进制文件，请用 download_file 保存，再用 read_document 阅读');
        const charset=receipt.contentType.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1] || 'utf-8';
        const text=new TextDecoder(charset,{fatal:true}).decode(bytes);
        let content=text,title='',links=[];
        if(/text\/html/i.test(receipt.contentType) || /^\s*<!doctype html|^\s*<html/i.test(text)) {
          const {load}=await import('cheerio');
          const $=load(text);title=$('title').first().text().trim();
          $('script,style,noscript,template').remove();
          $('a[href]').each((_,element)=>{try{const url=new URL($(element).attr('href'),receipt.finalUrl);if(['http:','https:'].includes(url.protocol))links.push({text:$(element).text().trim(),url:url.href});}catch{}});
          $('br').replaceWith('\n');$('p,div,section,article,h1,h2,h3,h4,li,tr').append('\n');
          content=$('body').text().trim();
        }
        return {url:args.url,...receipt,title,content,links,truncated:false,bytes:bytes.length};
      } finally {await unlink(temp).catch(()=>{});}
    },
    download_file: async args=>{
      if(typeof args.path!=='string' || !args.path.trim())throw new Error('下载需要保存文件的 path');
      const file=path.resolve(cwd,args.path),temp=path.join(path.dirname(file),`.download-${randomUUID()}`);
      if(!args.overwrite && await stat(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;}))throw new Error(`文件已存在，不会覆盖：${file}`);
      await mkdir(path.dirname(file),{recursive:true});
      try {
        const receipt=await retrieve(args.url,temp,{cwd,env:await network(),signal});
        const {open}=await import('node:fs/promises');
        const handle=await open(temp,'r');let head;
        try {const buffer=Buffer.alloc(1024);const read=await handle.read(buffer,0,buffer.length,0);head=buffer.subarray(0,read.bytesRead);}finally{await handle.close();}
        const isPdf=head.includes(Buffer.from('%PDF-'));
        if((path.extname(file).toLowerCase()==='.pdf' || /application\/pdf/i.test(receipt.contentType)) && !isPdf)throw new Error('下载结果不是 PDF，可能是错误页或登录页；未保存为论文');
        const bytes=(await stat(temp)).size;
        if(!bytes)throw new Error('下载结果为空；未保存');
        const sha256=await fingerprint(temp);
        signal?.throwIfAborted();
        if(args.overwrite===true)await rename(temp,file);
        else {try{await link(temp,file);}catch(error){if(error.code==='EEXIST')throw new Error(`文件已存在，不会覆盖：${file}`);throw error;}await unlink(temp);}
        return {ok:true,url:args.url,...receipt,path:file,bytes,sha256,verifiedType:isPdf?'pdf':'file'};
      } finally {await unlink(temp).catch(()=>{});}
    },
    read_document: async args=>{
      const file=path.resolve(cwd,args.path),extension=path.extname(file).toLowerCase();
      if(!['.pdf','.docx','.doc','.rtf','.txt','.md'].includes(extension))throw new Error('read_document 支持 PDF、Word 和文本文件');
      const content=await run(process.execPath,[fileURLToPath(new URL('./chat-attachments.js',import.meta.url)),'--parse',file,extension],{cwd,env,signal});
      return {path:file,content,truncated:false};
    }
  };
}
