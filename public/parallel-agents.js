// A view onto existing runs: opening or closing it never starts/stops a Worker.
(() => {
  const dialog=document.getElementById('parallelAgentDialog');
  if(!dialog)return;
  const el=id=>document.getElementById(id);
  const list=el('parallelAgentList'), output=el('parallelAgentOutput'), input=el('parallelAgentInput');
  const send=el('parallelAgentSend'), notice=el('parallelAgentNotice');
  const drafts=new Map(), requests=new Map(), pending=new Set();
  let runId='',taskId='',run=null,detail=null,timer,epoch=0,detailEpoch=0,listSignature='',outputSignature='';
  const labels={planned:'等待执行',queued:'等待执行',preparing:'准备中',running:'执行中',retrying:'正在续跑',completed:'分支完成',failed:'失败',stopped:'已停止',blocked:'依赖未完成'};
  const key=()=>JSON.stringify([runId,taskId]);
  const editable=job=>run&&['queued','preparing','running'].includes(run.status)&&job&&['planned','queued','preparing','running','retrying'].includes(job.status)&&job.acceptingGuidance!==false;
  const terminal=()=>['accepted','completed','failed','stopped'].includes(run?.status);
  const text=(tag,value,className)=>{
    const element=document.createElement(tag);element.textContent=value;
    if(className)element.className=className;
    return element;
  };
  function duration(job) {
    const start=Date.parse(job.startedAt||'');
    if(!Number.isFinite(start))return '尚未启动';
    const end=Date.parse(job.finishedAt||'')||Date.now();
    return `已用 ${Math.max(0,Math.floor((end-start)/1000))} 秒`;
  }
  function render() {
    if(!run)return;
    const jobs=run.jobs||[];
    const completed=jobs.filter(job=>job.status==='completed').length;
    el('parallelAgentSummary').textContent=`${completed}/${jobs.length} 个分支完成 · ${run.status==='checking'?'正在最终验收':terminal()?'本轮已结束':'后台持续执行中'}`;
    const signature=JSON.stringify(jobs.map(job=>[job.taskId,job.title,job.status,job.activity?.label,job.acceptingGuidance,taskId]));
    if(signature!==listSignature) {
      const focused=document.activeElement?.dataset?.agentSelect;
      list.replaceChildren(...jobs.map(job=>{
        const button=document.createElement('button');button.type='button';button.dataset.agentSelect=job.taskId;
        button.setAttribute('aria-pressed',String(job.taskId===taskId));
        button.append(text('strong',job.title||job.taskId),text('span',labels[job.status]||job.status),text('small',job.activity?.label||job.error||'等待下一条活动'));
        return button;
      }));
      if(focused)Array.from(list.children).find(button=>button.dataset.agentSelect===focused)?.focus({preventScroll:true});
      listSignature=signature;
    }
    const summary=jobs.find(job=>job.taskId===taskId);
    const job=summary&&{...(detail?.job?.taskId===taskId?detail.job:{}),...summary};
    if(!job){send.disabled=true;return;}
    el('parallelAgentTitle').textContent=job.title||job.taskId;
    el('parallelAgentTask').textContent=job.instruction||job.summary||'暂无任务说明';
    el('parallelAgentActivity').textContent=[labels[job.status]||job.status,duration(job),job.activity?.label,
      `已完成 ${job.completedTools||0} 次工具调用`,...Object.values(job.activeTools||{}).map(name=>`正在调用 ${name}`)].filter(Boolean).join(' · ');
    el('parallelAgentError').textContent=job.error||run.error||'';
    el('parallelAgentError').hidden=!el('parallelAgentError').textContent;
    const value=job.liveOutput||job.output||(detail?'等待模型输出…':'正在读取完整对话…');
    if(value!==outputSignature){
      const scroll=el('parallelAgentContent').scrollTop;
      if(typeof renderMarkdownLite==='function')output.innerHTML=renderMarkdownLite(value);
      else output.textContent=value;
      el('parallelAgentContent').scrollTop=scroll;
      outputSignature=value;
    }
    const messages=detail?.job?.taskId===taskId?detail.userMessages||[]:[];
    const peers=detail?.job?.taskId===taskId?detail.peerMessages||[]:[];
    const messagesElement=el('parallelAgentMessages');
    const messageSignature=JSON.stringify([messages,peers]);
    if(messagesElement.dataset.signature!==messageSignature) {
      messagesElement.replaceChildren(...messages.map(message=>{
        const card=document.createElement('article');
        const state=message.status==='delivered'?'已交给模型（是否落实请看回复）':editable(job)?'等待下一次模型请求送达':'本轮已结束，这条指导尚未送达';
        card.append(text('strong',`你 · ${state}`),text('p',message.content));return card;
      }),...peers.map(message=>{
        const card=document.createElement('article');
        card.append(text('strong',`分支通信 · ${message.fromTaskId} → ${message.toTaskId}`),text('p',message.question||''));
        if(message.response||message.answer)card.append(text('p',`回复：${message.response||message.answer}`));
        return card;
      }));
      messagesElement.dataset.signature=messageSignature;
    }
    input.disabled=!editable(job);
    send.disabled=!editable(job)||!input.value.trim()||pending.has(key());
    el('parallelAgentHint').textContent=editable(job)?'只发给当前 Agent；在下一次模型请求时送达。其他分支继续运行。':'当前分支已结束或正在整合，可查看记录；后续要求请回到节点对话发送。';
  }
  async function refresh(token=epoch) {
    clearTimeout(timer);
    let readFailed=false;
    try {
      const response=await fetch(`/api/codex/parallel/${encodeURIComponent(runId)}?view=progress`,{signal:AbortSignal.timeout(10000)});
      const payload=await response.json();
      if(token!==epoch||!dialog.open)return;
      if(!response.ok)throw new Error(payload.error||`HTTP ${response.status}`);
      run=payload.run;
      if(!taskId||!run.jobs?.some(job=>job.taskId===taskId))taskId=run.jobs?.[0]?.taskId||'';
      const draft=drafts.get(key())||'';
      if(document.activeElement!==input&&input.value!==draft)input.value=draft;
      render();
      await refreshDetail(token);
      if(notice.dataset.kind==='read-error'){notice.textContent='';notice.dataset.kind='';}
    } catch(error) {
      if(token!==epoch||!dialog.open)return;
      readFailed=true;
      notice.textContent=`读取进展失败，正在重连：${error.message}`;notice.dataset.kind='read-error';
    }
    if(token===epoch&&dialog.open&&(!terminal()||!detail||readFailed))timer=setTimeout(()=>refresh(token),1200);
  }
  async function refreshDetail(token=epoch) {
    if(!taskId)return;
    const selected=taskId,request=++detailEpoch;
    const response=await fetch(`/api/codex/parallel/${encodeURIComponent(runId)}/jobs/${encodeURIComponent(selected)}`,{signal:AbortSignal.timeout(10000)});
    const payload=await response.json();
    if(token!==epoch||request!==detailEpoch||selected!==taskId||!dialog.open)return;
    if(!response.ok)throw new Error(payload.error||`HTTP ${response.status}`);
    detail=payload;render();
  }
  function select(id) {
    drafts.set(key(),input.value);taskId=id;detail=null;detailEpoch++;input.value=drafts.get(key())||'';
    outputSignature='';notice.textContent='';render();el('parallelAgentContent').scrollTop=0;
    // Also refresh terminal runs: they have no background polling timer.
    void refresh();
  }
  document.addEventListener('click',event=>{
    const button=event.target.closest?.('[data-agent-run]');
    if(!button)return;
    if(runId)drafts.set(key(),input.value);
    runId=button.dataset.agentRun;taskId=button.dataset.agentTask||'';run=null;detail=null;epoch++;detailEpoch++;
    listSignature='';outputSignature='';list.replaceChildren();output.textContent='正在加载 Agent…';
    input.value=drafts.get(key())||'';input.disabled=true;send.disabled=true;notice.textContent='';
    el('parallelAgentTask').textContent='';el('parallelAgentMessages').replaceChildren();el('parallelAgentMessages').dataset.signature='';
    el('parallelAgentActivity').textContent='正在读取进展…';el('parallelAgentSummary').textContent='';
    el('parallelAgentError').hidden=true;el('parallelAgentTitle').textContent='Agent';
    if(!dialog.open)dialog.showModal();
    void refresh();
  });
  list.addEventListener('click',event=>{const button=event.target.closest('[data-agent-select]');if(button)select(button.dataset.agentSelect);});
  el('parallelAgentClose').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{drafts.set(key(),input.value);epoch++;clearTimeout(timer);});
  input.addEventListener('input',()=>{drafts.set(key(),input.value);render();});
  el('parallelAgentForm').addEventListener('submit',async event=>{
    event.preventDefault();
    const job=run?.jobs?.find(job=>job.taskId===taskId);
    const content=input.value.trim(),sendKey=key(),sendRun=runId,sendTask=taskId,token=epoch;
    if(!editable(job)||!content||pending.has(sendKey))return;
    let request=requests.get(sendKey);
    if(!request||request.content!==content)request={taskId:sendTask,content,clientMessageId:crypto.randomUUID()};
    requests.set(sendKey,request);pending.add(sendKey);render();notice.textContent='正在保存指导…';notice.dataset.kind='send';
    try {
      const response=await fetch(`/api/codex/parallel/${encodeURIComponent(sendRun)}/messages`,{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(15000)});
      const payload=await response.json();
      if(!response.ok)throw new Error(payload.error||`HTTP ${response.status}`);
      if(drafts.get(sendKey)?.trim()===content)drafts.delete(sendKey);
      requests.delete(sendKey);
      if(epoch===token&&dialog.open) {
        run=payload.run;
        if(taskId===sendTask){input.value=drafts.get(sendKey)||'';notice.textContent='指导已保存，等待 Agent 下一次请求模型时接收。';}
      }
    } catch(error) {
      if(epoch===token&&taskId===sendTask){notice.textContent=`发送未确认：${error.message}。内容已保留，可重试。`;notice.dataset.kind='send-error';}
    } finally {pending.delete(sendKey);if(epoch===token){render();void refresh(token);}}
  });
})();
