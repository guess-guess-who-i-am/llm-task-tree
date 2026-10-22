import {readFile,mkdir,writeFile,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {dialogueMessages,nodeConversationId} from './dialogue-state.js';

// Contract: a project-local last-write-wins record per tree/node. Empty records
// are tombstones: an older in-flight autosave cannot resurrect a sent draft.
export function createDialogueDraftStore(projectRoot) {
  const file=path.join(projectRoot,'.task-tree-dialogue-drafts.json');
  let queue=Promise.resolve();
  async function read(){
    try {const data=JSON.parse(await readFile(file,'utf8'));if(!Array.isArray(data.drafts))throw new Error('草稿文件格式错误');return data.drafts;}
    catch(error){if(error.code==='ENOENT')return [];throw error;}
  }
  async function persist(drafts){
    await mkdir(projectRoot,{recursive:true});
    const temporary=`${file}.${process.pid}.${randomUUID()}.tmp`;
    try {await writeFile(temporary,JSON.stringify({schema:'task-tree-dialogue-drafts/v1',drafts}),{mode:0o600,flag:'wx'});await rename(temporary,file);}
    finally {await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  }
  return {
    async list(){await queue;return read();},
    clear(treeId,nodeId){
      const operation=queue.catch(()=>{}).then(async()=>{
        const drafts=await read(),key=nodeConversationId(treeId,nodeId);
        const index=drafts.findIndex(d=>nodeConversationId(d.treeId,d.nodeId)===key);
        const draft={treeId,nodeId,text:'',attachments:[],updatedAt:Math.max(Date.now(),(drafts[index]?.updatedAt||0)+1)};
        if(index<0)drafts.push(draft);else drafts[index]=draft;
        await persist(drafts);return draft;
      });
      queue=operation;return operation;
    },
    save(input){
      if(typeof input?.treeId!=='string'||!input.treeId||typeof input.nodeId!=='string'||!input.nodeId
        ||typeof input.text!=='string'||!Number.isSafeInteger(input.updatedAt)||input.updatedAt<0
        ||(input.attachments!==undefined&&!Array.isArray(input.attachments))) {
        return Promise.reject(Object.assign(new Error('草稿需要 treeId、nodeId、文字 text、时间 updatedAt 和可选附件数组'),{status:400}));
      }
      const refs=dialogueMessages([{role:'user',content:'draft',attachments:input.attachments}])[0]?.attachments||[];
      const draft={treeId:input.treeId,nodeId:input.nodeId,text:input.text,attachments:refs,updatedAt:input.updatedAt};
      const operation=queue.catch(()=>{}).then(async()=>{
        const drafts=await read(),key=nodeConversationId(draft.treeId,draft.nodeId);
        const index=drafts.findIndex(d=>nodeConversationId(d.treeId,d.nodeId)===key),previous=drafts[index];
        if(previous&&previous.updatedAt>=draft.updatedAt)return previous;
        if(index<0)drafts.push(draft);else drafts[index]=draft;
        await persist(drafts);
        return draft;
      });
      queue=operation;
      return operation;
    }
  };
}
