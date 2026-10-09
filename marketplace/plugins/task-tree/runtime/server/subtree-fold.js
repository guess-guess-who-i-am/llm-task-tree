import {parseTreeNodeFields} from './tree-quality.js';
import '../public/tree-layout.js';

const STUB_FIELDS=new Set(['Folded','SubtreeFile','SubtreeCount']);

function sections(text,kind) {
  const matches=[...text.matchAll(/^##\s+(\S+)\s+-\s+(.+)$/gm)];
  return matches.map((match,i)=>({
    id:match[1],title:match[2].trim(),raw:text.slice(match.index,matches[i+1]?.index ?? text.length).trimEnd()+'\n',kind
  }));
}

function document(markdown) {
  const text=String(markdown || '').replace(/\r/g,'');
  const graphAt=text.search(/^# GraphState\s*$/m), edgesAt=text.search(/^# Edges\s*$/m);
  if(graphAt<0 || edgesAt<graphAt) throw new Error('任务树需要 GraphState、Edges 分区');
  const head=text.slice(0,graphAt), nodes=sections(head,'node');
  const edges=sections(text.slice(edgesAt+'# Edges'.length),'edge').map(edge=>{
    const pairs=[...edge.raw.matchAll(/^-\s+Endpoints:[^\S\r\n]*([^\r\n]*)$/gm)];
    const endpoints=pairs[0]?.[1].split(',').map(id=>id.trim()) || [];
    if(pairs.length!==1 || endpoints.length!==2 || endpoints.some(id=>!id) || endpoints[0]===endpoints[1]) throw new Error(`边 ${edge.id} 需要恰好两个不同有效端点`);
    return {...edge,endpoints};
  });
  for(const group of [nodes,edges]) if(new Set(group.map(item=>item.id)).size!==group.length) throw new Error('节点和边 ID 必须唯一，不能重复');
  return {prefix:head.slice(0,head.search(/^##\s+/m)),nodes,edges,state:text.slice(graphAt,edgesAt)};
}

function mergeNode(target,sources,{unfold=false}={}) {
  // Keep missing fields verbatim, including multiline facts; generated fields are
  // intentional edits. Index-only fields never become facts in the child file.
  let raw=target.raw;
  const present=new Set([...raw.matchAll(/^-\s+([A-Za-z]+):/gm)].map(m=>m[1]));
  for(const source of sources) {
    if(!source) continue;
    const fields=[...source.raw.matchAll(/^-\s+([A-Za-z]+):/gm)];
    for(let i=0;i<fields.length;i++) {
      const field=fields[i][1];
      if(present.has(field) || (unfold && STUB_FIELDS.has(field))) continue;
      raw=raw.trimEnd()+'\n'+source.raw.slice(fields[i].index,fields[i+1]?.index ?? source.raw.length).trimEnd()+'\n';
      present.add(field);
    }
  }
  const fields=[...raw.matchAll(/^-\s+([A-Za-z]+):/gm)];
  for(let i=fields.length-1;i>=0;i--) if(unfold && STUB_FIELDS.has(fields[i][1])) raw=raw.slice(0,fields[i].index)+raw.slice(fields[i+1]?.index ?? raw.length);
  return {...target,raw};
}

function render(doc,nodes,edges) {
  return `${doc.prefix.trimEnd()}\n\n${nodes.map(n=>n.raw.trimEnd()).join('\n\n')}\n\n${doc.state.trimEnd()}\n\n# Edges\n\n${edges.map(e=>e.raw.trimEnd()).join('\n\n')}\n`;
}

function edgeFacts(edge) {
  const fields=[...edge.raw.matchAll(/^-\s+([A-Za-z]+):[^\S\r\n]*/gm)];
  const facts=new Map();
  for(let i=0;i<fields.length;i++) {
    const field=fields[i];
    if(field[1]!=='Endpoints') facts.set(field[1],edge.raw.slice(field.index+field[0].length,fields[i+1]?.index ?? edge.raw.length).trim());
  }
  return facts;
}

/** A pure fold plan: host owns backups, index fields and atomic persistence. */
export function planSubtreeFold(current,subtree,{rootId,previous=''}={}) {
  const main=document(current), proposed=document(subtree), old=previous ? document(previous) : {nodes:[],edges:[]};
  const byId=new Map(main.nodes.map(n=>[n.id,n]));
  if(!rootId || !byId.has(rootId)) throw new Error(`主树中没有折叠根 ${rootId || '(empty)'}`);
  for(const [text,doc] of [[subtree,proposed],...(previous?[[previous,old]]:[])]) {
    const header=String(text).match(/^>\s*Fold root:\s*(\S+)/m)?.[1];
    if(header && header!==rootId) throw new Error('Fold root 与折叠根不一致');
    if(!doc.nodes.some(n=>n.id===rootId)) throw new Error(`子树缺少折叠根 ${rootId}`);
  }
  const nodeIds=new Set(byId.keys()), treeRoot=nodeIds.has('ROOT')?'ROOT':main.nodes[0]?.id;
  const adjacency=globalThis.TaskTreeLayout.buildSpanningTreeAdjacency({nodeIds,edges:main.edges,rootId:treeRoot});
  const branch=new Set(), queue=[rootId];
  for(let i=0;i<queue.length;i++) {
    const id=queue[i]; if(branch.has(id)) continue;
    branch.add(id); queue.push(...(adjacency.get(id)||[]));
  }
  const movedNodeIds=main.nodes.filter(n=>n.id!==rootId && branch.has(n.id)).map(n=>n.id);
  const moved=new Set(movedNodeIds);
  // The existing UI requires every visible edge endpoint to be a visible node.
  // Do not invent projections that could alter dependency semantics on unfold.
  for(const edge of main.edges) if(edge.endpoints.some(id=>moved.has(id)) && !edge.endpoints.every(id=>branch.has(id))) {
    throw new Error(`跨分支关系 ${edge.id} 连接 ${edge.endpoints.join('、')}，不能无损折叠；请明确该关系的分支归属`);
  }
  for(const n of [...proposed.nodes,...old.nodes]) if(byId.has(n.id) && !branch.has(n.id)) throw new Error(`节点 ${n.id} 属于主树其它分支，不能迁入此子树`);

  const oldNodes=new Map(old.nodes.map(n=>[n.id,n]));
  const nodes=new Map();
  for(const n of proposed.nodes) nodes.set(n.id,mergeNode(n,[oldNodes.get(n.id),byId.get(n.id)],{unfold:n.id===rootId}));
  for(const n of [...old.nodes,...main.nodes.filter(n=>branch.has(n.id))]) if(!nodes.has(n.id)) nodes.set(n.id,mergeNode(n,[],{unfold:n.id===rootId}));
  const ids=new Set(nodes.keys()), internalMain=main.edges.filter(e=>e.endpoints.every(id=>branch.has(id)));
  const remainingEdges=main.edges.filter(e=>!e.endpoints.every(id=>branch.has(id)));
  const remainingIds=new Set(remainingEdges.map(e=>e.id));
  const edges=new Map(), renamedEdges=[], retainedMainEdges=[];
  for(const e of [...internalMain,...old.edges]) {
    if(remainingIds.has(e.id)) throw new Error(`边 ${e.id} 属于主树其它分支，请使用唯一边 ID`);
    if(e.endpoints.some(id=>!ids.has(id))) throw new Error(`边 ${e.id} 含无效子树端点 ${e.endpoints.join('、')}`);
    edges.set(e.id,e);
  }
  // The caller knows which endpoints actually belong to this branch. A model
  // may include the already-existing parent link for context; leave that link
  // in main instead of asking the model to repair harmless storage placement.
  const endpointKey=edge=>JSON.stringify([...edge.endpoints].sort());
  const mainByEndpoints=new Map();
  for(const e of remainingEdges) {
    const key=endpointKey(e), group=mainByEndpoints.get(key) || [];
    group.push({edge:e,facts:edgeFacts(e)});
    mainByEndpoints.set(key,group);
  }
  const reservedIds=new Set([...remainingIds,...edges.keys(),...proposed.edges.map(e=>e.id)]);
  for(let e of proposed.edges) {
    if(e.endpoints.some(id=>!ids.has(id))) {
      const candidates=mainByEndpoints.get(endpointKey(e));
      if(!candidates) throw new Error(`边 ${e.id} 含无效子树端点 ${e.endpoints.join('、')}`);
      const supplied=[...edgeFacts(e)].filter(([,value])=>value);
      const existing=candidates.find(({facts})=>supplied.every(([field,value])=>facts.get(field)===value))?.edge;
      if(!existing) throw new Error(`边 ${e.id} 与主树现有外部关系的事实不一致，不能静默归位或丢弃；请明确 ${supplied.map(([field])=>field).join('、')} 的变更`);
      retainedMainEdges.push({proposedId:e.id,mainId:existing.id,endpoints:[...existing.endpoints]});
      continue;
    }
    if(remainingIds.has(e.id)) {
      const from=e.id, base=`${from}_${rootId}`;
      let to=base, suffix=2;
      while(reservedIds.has(to)) to=`${base}_${suffix++}`;
      reservedIds.add(to);
      renamedEdges.push({from,to,endpoints:[...e.endpoints]});
      e={...e,id:to,raw:e.raw.replace(/^##\s+\S+/,()=>`## ${to}`)};
    }
    edges.set(e.id,e);
  }
  const neighbours=new Map([...ids].map(id=>[id,[]]));
  for(const {endpoints:[a,b]} of edges.values()) {neighbours.get(a).push(b);neighbours.get(b).push(a);}
  const reached=new Set(), visits=[rootId];
  for(let i=0;i<visits.length;i++) {const id=visits[i];if(reached.has(id))continue;reached.add(id);visits.push(...neighbours.get(id));}
  if(reached.size!==ids.size) throw new Error(`子树包含未连接到折叠根的节点：${[...ids].filter(id=>!reached.has(id)).join('、')}`);
  if(!/^>\s*Fold root:/m.test(proposed.prefix)) proposed.prefix=proposed.prefix.trimEnd()+`\n\n> Fold root: ${rootId}\n`;
  return {
    markdown:render(main,main.nodes.filter(n=>!moved.has(n.id)),remainingEdges),
    subtreeMarkdown:render(proposed,[...nodes.values()],[...edges.values()]),
    movedNodeIds,renamedEdges,retainedMainEdges
  };
}
