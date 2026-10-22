/** Each nonempty distinct request initializes one lazy retrieval process. */
export async function warmGraphPool(queryGraph,{processes=4,generation=Date.now()}={}) {
  const results=await Promise.all(Array.from({length:processes},(_,i)=>queryGraph(`task tree software engineering tools; pool warmup ${generation}-${i}`)));
  const pids=[...new Set(results.map(r=>r.queryPid).filter(Boolean))];
  if(pids.length!==processes || results.some(r=>r.loads<1))throw new Error(`Graph pool not fully warm: ${pids.length}/${processes} initialized processes`);
  return {...results[0],warmedProcessPids:pids,warmedProcesses:pids.length};
}
