import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {parseTreeNodeFields,isTreeMarkdownPath} from './tree-quality.js';

// Resolve only linked descendants of the selected tree, not orphan files or
// other registered trees. Folded roots may occur both as index and detail.
export async function readLinkedTreeFiles({projectRoot,treeFile,markdown}) {
  const root=path.resolve(projectRoot),files=[],seen=new Set();
  const visit=async(relative,content)=>{
    const file=path.resolve(root,relative),local=path.relative(root,file).replaceAll('\\','/');
    if(!local||local.startsWith('../')||path.isAbsolute(local)||!isTreeMarkdownPath(local)||seen.has(file))return;
    seen.add(file);
    try{content??=await readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return;throw error;}
    const nodes=parseTreeNodeFields(content);
    files.push({file,path:local,markdown:content,nodes});
    for(const node of nodes){const child=String(node.fields.SubtreeFile||'').trim();if(child)await visit(child);}
  };
  await visit(treeFile,markdown);
  return files;
}

export async function findLinkedTreeNode(options,nodeId) {
  const files=await readLinkedTreeFiles(options);
  for(const entry of files.reverse()){
    const node=entry.nodes.find(node=>node.id===nodeId);
    if(node)return {...entry,node};
  }
  return null;
}
