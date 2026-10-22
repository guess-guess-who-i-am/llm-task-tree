(() => {
  const params = new URLSearchParams(location.search);
  const suppliedOrigin = params.get('sshLauncher');
  let launcher = '';
  if (suppliedOrigin) {
    try { const url = new URL(suppliedOrigin); if (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)) launcher = url.origin; } catch {}
  }
  const profileId = params.get('sshProfile') || '';
  const style = document.createElement('style');
  style.textContent = '.remoteSshDialog{width:min(640px,calc(100vw - 32px));max-height:85vh;overflow:auto;border:1px solid #d1dccf;border-radius:16px;padding:24px;background:#fafcf9;color:#26382d}.remoteSshDialog::backdrop{background:#15241966}.remoteSshDialog header{display:flex;align-items:center;justify-content:space-between;gap:16px}.remoteSshDialog h2{font-size:18px;margin:0}.remoteSshDialog label{display:block;margin:14px 0 0}.remoteSshDialog input,.remoteSshDialog select{box-sizing:border-box;width:100%;padding:9px;border:1px solid #bdcbbb;border-radius:8px;background:white;color:inherit}.remoteSshDialog button{border:1px solid #c5d2c3;border-radius:8px;padding:8px 12px;background:white;color:inherit;cursor:pointer}.remoteSshDialog button:disabled{opacity:.5;cursor:wait}.remoteSshDialog footer{display:flex;gap:10px;margin-top:20px;flex-wrap:wrap}.remoteSshDialog p{line-height:1.6;overflow-wrap:anywhere}.remoteSshDialog [data-status]{white-space:pre-wrap}.remoteSshDialog details{margin-top:16px}.remoteSshDialog .remoteHint{font-size:13px;color:#556952}';
  document.head.append(style);
  const dialog = document.createElement('dialog');
  dialog.className = 'remoteSshDialog';
  dialog.innerHTML = `<header><h2>SSH 远程工作区</h2><button type="button" data-close aria-label="关闭">✕</button></header>
    <p class="remoteHint">界面在本机；代码、命令和 Agent 在服务器执行。使用已有 SSH 配置与密钥。</p>
    <label>已保存的连接<select data-profiles><option value="">新建连接</option></select></label>
    <form><label>SSH 别名或地址<input name="host" list="remoteSshAliases" placeholder="例如 hyf" required autocomplete="off"></label><datalist id="remoteSshAliases"></datalist>
    <label>服务器项目目录<input name="projectRoot" placeholder="/home/hyf/memes" required autocomplete="off"></label>
    <details><summary>高级设置（通常无需填写）</summary>
    <label>用户名<input name="user" autocomplete="off"></label><label>SSH 端口<input name="port" type="number" min="1" max="65535"></label>
    <label>本机私钥路径<input name="identityFile" placeholder="仅指定路径，不上传私钥"></label>
    <label>远程 Node 路径<input name="nodePath" placeholder="自动发现 ~/.local/bin/node 或 PATH 中的 node"></label>
    <label>远程全局环境文件<input name="globalEnvFile" placeholder="~/.config/task-tree/.env（服务器上的文件）"></label></details>
    <p data-status role="status" aria-live="polite"></p>
    <footer><button type="submit" data-connect>连接并打开</button><button type="button" data-save>保存连接</button><button type="button" data-disconnect>断开隧道</button></footer></form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form'), select = dialog.querySelector('[data-profiles]'), status = dialog.querySelector('[data-status]');
  let profiles = [], connecting = false;
  const show = text => { status.textContent = text; };
  const values = () => Object.fromEntries([...new FormData(form)].filter(([, value]) => value.trim()));
  const fill = profile => { form.reset(); for (const [key, value] of Object.entries(profile || {})) if (form.elements.namedItem(key)) form.elements.namedItem(key).value = value; };
  const busy = value => { connecting = value; for (const button of form.querySelectorAll('button')) button.disabled = value; select.disabled = value; };
  async function request(url, body) {
    const response = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  }
  function remoteUrl(url, id) {
    const target = new URL(url); target.searchParams.set('sshLauncher', location.origin); target.searchParams.set('sshProfile', id); return target.href;
  }
  async function load() {
    const result = await request('/api/remote-ssh'); profiles = result.profiles;
    select.replaceChildren(new Option('新建连接', ''));
    for (const profile of profiles) select.add(new Option(`${profile.connected ? '● ' : ''}${profile.name}`, profile.id));
    const aliases = dialog.querySelector('datalist'); aliases.replaceChildren();
    for (const alias of result.aliases) aliases.append(new Option(alias, alias));
    if (!profiles.length && result.aliases.includes('hyf')) form.elements.host.value = 'hyf';
  }
  async function connect(profile) {
    busy(true);
    try {
      show('正在连接 SSH…');
      let { job } = await request('/api/remote-ssh/connect', profile);
      while (job.status === 'running') {
        show(job.message);
        await new Promise(resolve => setTimeout(resolve, 700));
        ({ job } = await request(`/api/remote-ssh/jobs/${encodeURIComponent(job.id)}`));
      }
      if (job.status !== 'completed') throw new Error(job.error || job.message);
      show(`已连接 ${job.hostname} · ${job.root}`);
      location.assign(remoteUrl(job.url, job.profileId));
    } catch (error) { show(error.message); }
    finally { busy(false); }
  }
  function localUrl(id = '', root = '') {
    const url = new URL('/', launcher); url.searchParams.set('sshManage', '1');
    if (id) url.searchParams.set('sshConnect', id);
    if (root) url.searchParams.set('sshRoot', root);
    return url.href;
  }
  async function open() {
    if (launcher) { location.assign(localUrl()); return; }
    dialog.showModal(); show('正在读取 SSH 配置…');
    try { await load(); show('选择已有连接，或填写服务器项目目录。'); }
    catch (error) { show(error.message); }
  }
  window.taskTreeRemote = {
    open,
    switchProject(root) { if (!launcher || !profileId) return false; location.assign(localUrl(profileId, root)); return true; },
    setProject(project) {
      if (project.executionHost?.mode !== 'ssh') return;
      const button = document.getElementById('projectSwitchBtn');
      const name = document.getElementById('projectSwitchName');
      if (name) name.textContent = `远程 · ${project.name}`;
      if (button) button.title = `${project.executionHost.hostname} · ${project.root}`;
      document.getElementById('remoteSshBtn').textContent = launcher ? 'SSH · 返回本机' : 'SSH · 远程工作区';
    }
  };
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  select.onchange = () => { fill(profiles.find(item => item.id === select.value)); show(''); };
  form.onsubmit = event => { event.preventDefault(); if (form.reportValidity()) void connect(values()); };
  dialog.querySelector('[data-save]').onclick = async () => {
    if (!form.reportValidity()) return;
    try { const { profile } = await request('/api/remote-ssh/save', values()); await load(); select.value = profile.id; fill(profile); show('连接已保存'); }
    catch (error) { show(error.message); }
  };
  dialog.querySelector('[data-disconnect]').onclick = async () => {
    if (!select.value || connecting) { show('请先选择一个已保存的连接'); return; }
    try { show((await request('/api/remote-ssh/disconnect', { id: select.value })).message); await load(); }
    catch (error) { show(error.message); }
  };
  document.getElementById('remoteSshBtn')?.addEventListener('click', open);
  if (!launcher && (params.has('sshManage') || params.has('sshConnect'))) void (async () => {
    await open();
    const id = params.get('sshConnect');
    if (!id) return;
    const profile = profiles.find(item => item.id === id);
    if (!profile) { show('原 SSH 连接不存在，请重新选择'); return; }
    fill({ ...profile, ...(params.get('sshRoot') && { projectRoot: params.get('sshRoot') }) });
    history.replaceState(null, '', location.pathname);
    await connect(values());
  })();
})();
