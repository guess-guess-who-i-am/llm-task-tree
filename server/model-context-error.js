// Classify the complete provider error before display truncation. Compatible
// gateways often JSON-encode their upstream error inside error.message.
export function contextLimitDetails(value) {
  const texts=[], seen=new Set();
  const visit=(item,depth=0)=>{
    if(depth>8 || item==null || seen.has(item))return;
    seen.add(item);
    if(typeof item==='string') {
      texts.push(item);
      try {visit(JSON.parse(item),depth+1);} catch {
        // Also accept a persisted "model HTTP400: { ... }" error message.
        const start=item.indexOf('{');
        if(start>0)try{visit(JSON.parse(item.slice(start)),depth+1);}catch{}
      }
    } else if(typeof item==='object') {
      for(const key of ['error','message','msg','code','type','cause','extError'])visit(item[key],depth+1);
    }
  };
  visit(value);
  const text=texts.join('\n');
  if(!/context[_ ]length|maximum context|context window|too many tokens|prompt\s+is\s+too\s+long|上下文.{0,12}(超|长)|context.{0,30}(exceed|too long)/i.test(text))return null;
  const counts=text.match(/prompt\s+is\s+too\s+long:\s*([\d,]+)\s*tokens?[^\n]{0,24}?([\d,]+)\s*maximum/i);
  return { ...(counts ? {inputTokens:Number(counts[1].replaceAll(',','')),windowTokens:Number(counts[2].replaceAll(',',''))} : {}) };
}

export function modelHttpError(status,model,detail) {
  const capacity=[400,413,422].includes(status) && contextLimitDetails(detail);
  if(capacity) return Object.assign(new Error(`模型 HTTP ${status}（${model}）：上下文超过模型容量${capacity.inputTokens?`，输入 ${capacity.inputTokens} token，窗口 ${capacity.windowTokens} token`:''}；正在尝试整理后继续。`),
    {code:'MODEL_CONTEXT_REJECTED',stage:'context-recovery',...capacity});
  return new Error(`模型 HTTP ${status}（${model}）: ${detail.slice(0,500)}`);
}
