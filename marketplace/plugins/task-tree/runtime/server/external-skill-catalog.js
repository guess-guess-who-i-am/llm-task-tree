import path from 'node:path';
import {readFile, realpath, stat} from 'node:fs/promises';

// Shared by broker sessions. Load a catalog only on an actual discovery request,
// coalescing simultaneous reads; exact routed paths need just the tiny manifest.
const files=new Map();
async function jsonFile(file) {
  let info;try{info=await stat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  const version=`${info.mtimeMs}:${info.size}`;
  let entry=files.get(file);
  if(entry?.version!==version){
    entry={version,promise:readFile(file,'utf8').then(JSON.parse)};files.set(file,entry);
    entry.promise.catch(()=>{if(files.get(file)===entry)files.delete(file);});
  }
  return entry.promise;
}
const within=(root,file)=>{const relative=path.relative(root,file);return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};

export function externalSkillCatalog(codexHome) {
  const manifestFile=path.join(codexHome,'skill-registry/external-skills-manifest.json');
  async function manifest(){
    const data=await jsonFile(manifestFile);
    return data?.schemaVersion==='graph-tool-call-skills/1'&&path.isAbsolute(data.rootPath||'')&&path.isAbsolute(data.catalogPath||'')?data:null;
  }
  return {
    async list(query){
      if(!query)return []; // Do not dump 15k external entries into model context.
      const source=await manifest();if(!source)return [];
      const catalog=await jsonFile(source.catalogPath);
      const root=path.resolve(source.rootPath),text=query.toLowerCase();
      return (catalog?.skills||[]).flatMap(raw=>{
        if(typeof raw.dir!=='string'||path.isAbsolute(raw.dir))return [];
        const file=path.resolve(root,raw.dir,'SKILL.md');if(!within(root,file))return [];
        const entry={id:`external:${raw.dir}`,name:raw.name||raw.dir,
          description:[raw.description,raw.problem_cn,raw.when_cn].filter(Boolean).join(' '),path:file,source:'external-library'};
        return `${entry.id} ${entry.name} ${entry.description} ${entry.path}`.toLowerCase().includes(text)?[entry]:[];
      });
    },
    async readExact(file){
      if(!path.isAbsolute(file)||path.basename(file)!=='SKILL.md')return null;
      const source=await manifest();if(!source)return null;
      if(!within(path.resolve(source.rootPath),path.resolve(file)))return null;
      const root=await realpath(source.rootPath);
      let resolved;try{resolved=await realpath(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
      if(!within(root,resolved))return null;
      const content=await readFile(resolved,'utf8');
      return {id:`external:${path.relative(root,path.dirname(resolved)).split(path.sep).join('/')}`,
        name:content.match(/^name:\s*["']?([^\r\n"']+)/m)?.[1]?.trim()||path.basename(path.dirname(resolved)),
        path:resolved,source:'external-library',content};
    }
  };
}
