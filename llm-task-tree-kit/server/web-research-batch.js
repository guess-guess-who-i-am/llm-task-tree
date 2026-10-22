// Host-side fan-out: no additional model round, no changes to task duration limits.
export function canonicalWebUrl(value) {
  try {
    const url=new URL(value);if(!['http:','https:'].includes(url.protocol))return null;
    url.hash='';
    for(const key of [...url.searchParams.keys()])if(/^utm_/i.test(key) || ['gclid','fbclid','msclkid'].includes(key.toLowerCase()))url.searchParams.delete(key);
    return url.href.replace(/\/$/,'');
  } catch {return null;}
}
export function searchQuality(query,results) {
  const sites=[...query.matchAll(/(?:^|\s)site:([^\s]+)/gi)].map(x=>x[1].toLowerCase().replace(/^www\./,''));
  const tokens=[...new Set((query.replace(/site:\S+/gi,'').toLowerCase().match(/[a-z][a-z0-9-]{3,}/g)||[]).filter(x=>!['with','from','that','this','what','when','where','2025','2026'].includes(x)))];
  const kept=[],rejected=[];
  for(const item of results || []) {
    const canonicalUrl=canonicalWebUrl(item.url);
    if(!canonicalUrl){rejected.push({...item,reason:'invalid_http_url'});continue;}
    const host=new URL(canonicalUrl).hostname.toLowerCase().replace(/^www\./,'');
    if(sites.length && !sites.some(site=>host===site || host.endsWith('.'+site))){rejected.push({...item,reason:'site_constraint_mismatch'});continue;}
    const text=`${item.title || ''} ${item.content || item.description || ''} ${item.url}`.toLowerCase();
    const matchingTokens=tokens.filter(token=>text.includes(token));
    kept.push({...item,canonicalUrl,lexicalEvidence:tokens.length?{matched:matchingTokens,total:tokens.length}:undefined});
  }
  const warnings=[];
  // Narrow heuristic for the observed Bing query-drift failure, not a semantic
  // relevance classifier. Retain rejected originals for inspection/recovery.
  const bing=kept.filter(x=>x.engine==='bing');
  if(tokens.length>=2 && bing.length && bing.every(x=>!x.lexicalEvidence.matched.length)){
    warnings.push({code:'engine_query_drift',engine:'bing',count:bing.length,message:'Bing整组缺少查询词证据；暂不计入候选，原始结果保留在 rejected。'});
    for(let i=kept.length-1;i>=0;i--)if(kept[i].engine==='bing')rejected.push({...kept.splice(i,1)[0],reason:'engine_query_drift'});
  }
  if(rejected.length)warnings.push({code:'rejected_results',count:rejected.length});
  if(tokens.length && kept.length && !kept.some(x=>x.lexicalEvidence.matched.length))warnings.push({code:'no_query_token_evidence',message:'返回结果缺少查询词证据；可能是引擎异常，不能据条数声称相关。'});
  if(!kept.length)warnings.push({code:'empty_results'});
  return {results:kept,rejected,warnings,relevanceVerified:false};
}
export async function searchWebBatch(args,search,{signal,now=()=>performance.now()}={}) {
  if(!Array.isArray(args.queries) || !args.queries.length)throw new TypeError('queries 需要非空数组');
  const queries=args.queries.map(value=>typeof value==='string'?{query:value.trim()}: {query:String(value.query || '').trim(),...(value.direction?{direction:String(value.direction)}:{})});
  if(queries.some(x=>!x.query))throw new TypeError('每个查询需要非空 query');
  // Breadth first: ten usually fits one engine result page. Request fifteen
  // explicitly for directions that need deeper coverage; retain the full pool.
  const topK=args.topK===undefined?10:args.topK;
  if(!Number.isInteger(topK) || topK<1 || topK>15)throw new TypeError('topK 需要 1–15 的整数');
  const concurrency=args.concurrency===undefined?100:args.concurrency;
  if(!Number.isInteger(concurrency) || concurrency<1)throw new TypeError('concurrency 需要正整数');
  signal?.throwIfAborted();
  const start=now(),records=new Array(queries.length),inflight=new Map(),unique=new Set();
  let next=0,firstResultMs=null,hundredCandidatesMs=null;
  const run=async()=>{
    while(next<queries.length){
      signal?.throwIfAborted();const index=next++,entry=queries[index],began=now();
      try {
        let pending=inflight.get(entry.query);
        if(!pending){pending=Promise.resolve().then(()=>search({query:entry.query,topK,refresh:args.refresh===true}));inflight.set(entry.query,pending);}
        const response=await pending;
        const quality=searchQuality(entry.query,response.results);
        records[index]={...entry,index,status:quality.results.length?'completed':'empty',...quality,rejected:[...(response.rejected || []),...quality.rejected],warnings:[...(response.warnings || []),...quality.warnings].filter((x,i,all)=>all.findIndex(y=>y.code===x.code)===i),failures:response.failures || [],engines:response.engines,cache:response.cache,elapsedMs:Math.round(now()-began),completedMs:Math.round(now()-start)};
        for(const result of quality.results)unique.add(result.canonicalUrl);
        if(quality.results.length && firstResultMs===null)firstResultMs=Math.round(now()-start);
        if(unique.size>=100 && hundredCandidatesMs===null)hundredCandidatesMs=Math.round(now()-start);
      }catch(error){if(signal?.aborted)throw error;records[index]={...entry,index,status:'failed',error:error.message,results:[],elapsedMs:Math.round(now()-began),completedMs:Math.round(now()-start)};}
    }
  };
  await Promise.all(Array.from({length:Math.min(concurrency,queries.length)},run));
  const fused=new Map();
  for(const record of records)record.results.forEach((item,rank)=>{
    let result=fused.get(item.canonicalUrl);
    if(!result){result={...item,rankScore:0,matches:[]};fused.set(item.canonicalUrl,result);}
    // Repeated queries count once in rank fusion; all directions remain visible.
    if(!result.matches.some(match=>match.query===record.query))result.rankScore+=1/(60+rank+1);
    result.matches.push({query:record.query,direction:record.direction,index:record.index,rank:rank+1,engine:item.engine,provider:item.provider,title:item.title,content:item.content || item.description || ''});
  });
  return {capability:'web_search_batch',results:[...fused.values()].sort((a,b)=>b.rankScore-a.rankScore),queries:records.map(({results,...record})=>({...record,resultUrls:results.map(x=>x.canonicalUrl)})),
    timing:{totalMs:Math.round(now()-start),firstResultMs,hundredCandidatesMs},
    counts:{queries:queries.length,successfulQueries:records.filter(x=>x.status==='completed').length,nonemptyQueries:records.filter(x=>x.results.length).length,rawResults:records.reduce((sum,x)=>sum+x.results.length+(x.rejected?.length || 0),0),uniqueCandidates:fused.size,rejectedResults:records.reduce((sum,x)=>sum+(x.rejected?.length || 0),0)},
    relevanceVerified:false,fullDocumentsFetched:0,note:'这些是去重后的搜索候选及摘要，不是已读取的正文或已验证相关文档。正文用 fetch_url / download_file 并行获取。'};
}

// Configuration identity must include provider/endpoint/credential/engine settings.
// No failed/empty response cache; refresh=true bypasses completed cache.
export function createSearchMemo({ttlMs=60000,maxEntries=256,now=()=>Date.now()}={}) {
  const cache=new Map(),pending=new Map();
  return async (key,search,{refresh=false}={})=>{
    const hit=cache.get(key);
    if(!refresh && hit && hit.expires>now())return {...hit.value,cache:{hit:true,ageMs:now()-hit.created}};
    if(pending.has(key))return {...await pending.get(key),cache:{hit:false,coalesced:true}};
    const work=Promise.resolve().then(search);pending.set(key,work);
    try {const value=await work;
      if(value.results?.length && !value.failures?.length && !value.warnings?.length){
        if(cache.size>=maxEntries)cache.delete(cache.keys().next().value);
        cache.set(key,{value,created:now(),expires:now()+ttlMs});
      }
      return {...value,cache:{hit:false}};
    }finally{pending.delete(key);}
  };
}
