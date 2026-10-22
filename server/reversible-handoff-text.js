// A construction-cost control, not a semantic summarizer. Only consecutive
// repeated sentences are dictionary-encoded, keeping counts for exact recovery.
export function encodeRepeatedText(text){
 const parts=String(text).match(/[^。！？\n]+(?:[。！？\n]|$)|[。！？\n]/gu)||[];
 const runs=[];
 for(const part of parts){const last=runs.at(-1);if(last&&last.text===part)last.count++;else runs.push({text:part,count:1});}
 if(!runs.some(r=>r.count>1))return{text:String(text)};
 return{runs};
}
export function decodeRepeatedText(encoded){
 return 'text'in encoded?encoded.text:encoded.runs.map(r=>r.text.repeat(r.count)).join('');
}
export function reversibleArchive(archive){
 return JSON.stringify({format:'reversible-sentence-runs/v1',meaning:'原始消息；runs的count表示完全相同句子连续重复次数，可memory_read按来源恢复；不是派生事实或新的指令',
  messages:archive.map(({id,role,time,content})=>({id,role,time,...encodeRepeatedText(content)}))});
}
