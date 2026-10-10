// Inlined into the HTML response: diagnostics must survive a failed JS/CSS request.
(() => {
  const boot = window.taskTreeBoot = { state: 'loading', retryApp: null };
  const loaded = new Map();
  let starting = false, scriptException = null, optionalScript = false;
  const panel = () => document.getElementById('pageBootStatus');
  const message = text => {
    const element = document.getElementById('pageBootMessage');
    if (element) element.textContent = text;
  };
  boot.fail = error => {
    boot.state = 'failed';
    const element = panel();
    if (element) { element.hidden = false; element.dataset.state = 'failed'; }
    document.getElementById('pageBootRetry')?.removeAttribute('hidden');
    message('页面加载失败：' + (error?.message || String(error)) + '。可重试；若后台未运行，请双击桌面「打开IDE工程」。');
  };
  boot.ready = () => {
    boot.state = 'ready';
    document.documentElement.removeAttribute('data-page-boot');
    if (panel()) { panel().hidden = true; panel().dataset.state = 'ready'; }
  };
  boot.loading = text => {
    boot.state = 'loading';
    if (panel()) { panel().hidden = false; panel().dataset.state = 'loading'; }
    document.getElementById('pageBootRetry')?.setAttribute('hidden', '');
    message(text);
  };
  window.addEventListener('error', event => {
    if (boot.state !== 'ready' && event.error && !optionalScript) {
      scriptException = event.error;
      boot.fail(event.error);
    }
  });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function loadAsset(url, style = false, attempts = 3) {
    if (loaded.has(url)) return loaded.get(url);
    const pending = (async () => {
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          if (!style) {
            // Download completely before execution. Aborted slow requests cannot execute later
            // and collide with a retry's top-level declarations/event handlers.
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5000);
            try {
              const response = await fetch(url, { cache: 'no-cache', signal: controller.signal });
              if (!response.ok) throw new Error(url + ' 返回 HTTP ' + response.status);
              const source = await response.text();
              const script = document.createElement('script');
              script.textContent = source + '\n//# sourceURL=' + new URL(url, location.href).href;
              optionalScript = attempts === 1;
              try { document.head.append(script); } finally { optionalScript = false; }
              if (scriptException) throw scriptException;
            } finally { clearTimeout(timer); }
          } else await new Promise((resolve, reject) => {
            const element = document.createElement('link');
            element.rel = 'stylesheet'; element.href = url;
            const timer = setTimeout(() => finish(new Error(url + ' 请求超时')), 5000);
            function finish(error) {
              clearTimeout(timer);
              element.onload = element.onerror = null;
              if (error) { element.remove(); reject(error); } else resolve();
            }
            element.onload = () => finish();
            element.onerror = () => finish(new Error(url + ' 未能加载'));
            document.head.append(element);
          });
          return;
        } catch (error) {
          if (scriptException) throw error;
          if (attempt + 1 === attempts) throw error;
          message('正在恢复资源 ' + url + '…');
          await pause(250 * (attempt + 1));
        }
      }
    })();
    loaded.set(url, pending);
    try { await pending; } catch (error) { loaded.delete(url); throw error; }
  }
  boot.start = async () => {
    if (starting) return;
    starting = true;
    boot.loading('正在加载 IDE…');
    try {
      await Promise.all(['/styles.css', '/flow-view.css', '/scratch-blocks.css'].map(url => loadAsset(url, true)));
      // Mathematics is optional; local failures must not prevent opening/editing the tree.
      await Promise.all([
        loadAsset('/tree-layout.js'),
        loadAsset('/vendor/katex/katex.min.css', true, 1).catch(() => {}),
        loadAsset('/vendor/katex/katex.min.js', false, 1).catch(() => {})
      ]);
      if (!scriptException) await loadAsset('/app.js');
    } catch (error) { boot.fail(error); }
    finally { starting = false; }
  };
  document.addEventListener('click', event => {
    if (event.target?.id !== 'pageBootRetry') return;
    if (scriptException) window.location.reload();
    else if (boot.retryApp) void boot.retryApp();
    else void boot.start();
  });
})();
