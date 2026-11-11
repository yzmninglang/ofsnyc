export function managerHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ofsync 管理台</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #0b1120; color: #e5e7eb; }
    header { display: flex; align-items: baseline; gap: 14px; padding: 18px 28px; border-bottom: 1px solid #1f2937; }
    header h1 { margin: 0; font-size: 1.25rem; letter-spacing: .04em; }
    main { max-width: 1180px; margin: 0 auto; padding: 22px 28px 60px; display: grid; gap: 18px; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 10px; padding: 18px 20px; }
    .card h2 { margin: 0 0 14px; font-size: 1rem; color: #cbd5e1; }
    .muted { color: #94a3b8; font-size: .86rem; }
    code { background: #030712; padding: 1px 5px; border-radius: 4px; color: #cbd5e1; }
    label { display: grid; gap: 6px; font-size: .88rem; color: #cbd5e1; }
    input, select, textarea { background: #030712; border: 1px solid #334155; color: #e5e7eb; border-radius: 6px; padding: 8px 10px; font: inherit; width: 100%; }
    textarea { min-height: 64px; resize: vertical; }
    button { background: #1d4ed8; color: #fff; border: 0; border-radius: 6px; padding: 8px 13px; font: inherit; cursor: pointer; white-space: nowrap; }
    button:hover { background: #2563eb; }
    button.secondary { background: #1f2937; border: 1px solid #334155; }
    button.secondary:hover { background: #273449; }
    button.danger { background: #7f1d1d; }
    button.danger:hover { background: #991b1b; }
    button:disabled { opacity: .45; cursor: not-allowed; }
    .row { display: flex; gap: 8px; align-items: center; }
    .row > input { flex: 1; }
    form { display: grid; gap: 12px; }
    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
    .badges { display: flex; gap: 8px; flex-wrap: wrap; }
    .badge { border: 1px solid #334155; border-radius: 999px; padding: 2px 10px; font-size: .78rem; color: #93c5fd; }
    .message { margin: 0; min-height: 1.2em; font-size: .86rem; color: #fca5a5; }
    .message.ok { color: #86efac; }
    .split { display: grid; grid-template-columns: minmax(260px, 1fr) minmax(280px, 1fr); gap: 20px; }
    @media (max-width: 760px) { .split { grid-template-columns: 1fr; } }
    .project-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; max-height: 320px; overflow: auto; }
    .project-list li { border: 1px solid #1f2937; border-radius: 8px; padding: 10px 12px; cursor: pointer; }
    .project-list li:hover { border-color: #334155; }
    .project-list li.selected { border-color: #2563eb; background: #0f1c3a; }
    .project-list .name { font-size: .92rem; }
    .project-list .id { color: #64748b; font-size: .74rem; font-family: ui-monospace, monospace; }
    .mapping-form { display: grid; gap: 12px; align-content: start; }
    table { width: 100%; border-collapse: collapse; font-size: .88rem; }
    th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid #1f2937; vertical-align: top; }
    th { color: #94a3b8; font-weight: 600; font-size: .8rem; }
    tr:last-child td { border-bottom: 0; }
    .path { font-family: ui-monospace, monospace; font-size: .78rem; color: #cbd5e1; word-break: break-all; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .actions button { padding: 5px 9px; font-size: .8rem; }
    .status { display: inline-flex; align-items: center; gap: 6px; font-size: .8rem; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #64748b; }
    .status.watching .dot { background: #22c55e; }
    .status.syncing .dot { background: #3b82f6; }
    .status.error .dot { background: #ef4444; }
    .status.awaiting-auth .dot { background: #f59e0b; }
    .status.paused .dot { background: #64748b; }
    .error-text { color: #fca5a5; font-size: .78rem; margin-top: 4px; }
    dialog { background: #111827; color: #e5e7eb; border: 1px solid #334155; border-radius: 12px; padding: 0; width: min(720px, 92vw); }
    dialog::backdrop { background: rgba(2, 6, 23, .72); }
    .dialog-head { display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; border-bottom: 1px solid #1f2937; }
    .dialog-body { padding: 16px 18px; display: grid; gap: 12px; }
    .browse-list { list-style: none; margin: 0; padding: 0; max-height: 340px; overflow: auto; border: 1px solid #1f2937; border-radius: 8px; }
    .browse-list li { padding: 9px 12px; cursor: pointer; border-bottom: 1px solid #111c2f; font-size: .88rem; }
    .browse-list li:last-child { border-bottom: 0; }
    .browse-list li:hover { background: #1b2537; }
    pre { background: #030712; border: 1px solid #1f2937; border-radius: 8px; padding: 12px; max-height: 420px; overflow: auto; font-size: .8rem; }
  </style>
</head>
<body>
  <header>
    <h1>ofsync</h1>
    <span class="muted">ShareLaTeX 本地同步管理台</span>
    <span id="servers" class="badges"></span>
  </header>
  <main>
    <section class="card">
      <h2>1. 连接服务器</h2>
      <form id="connect-form">
        <div class="grid-2">
          <label>服务器地址
            <input id="server-url" placeholder="http://192.168.1.16:8189" autocomplete="off" required>
          </label>
          <label>认证方式
            <select id="auth-method">
              <option value="password">邮箱 + 密码</option>
              <option value="cookie">浏览器 Cookie</option>
            </select>
          </label>
        </div>
        <div class="grid-2" id="password-fields">
          <label>邮箱
            <input id="email" autocomplete="username" placeholder="joe@example.com">
          </label>
          <label>密码
            <input id="password" type="password" autocomplete="current-password" placeholder="仅保存在内存中">
          </label>
        </div>
        <div id="cookie-fields" hidden>
          <label>Cookie
            <textarea id="cookie" placeholder="overleaf.sid=...; other=..."></textarea>
          </label>
        </div>
        <div class="row">
          <button type="submit" id="connect-button">连接并列出项目</button>
          <span class="muted">账号密码只保存在当前进程内存中，不会写入磁盘。</span>
        </div>
        <p id="connect-message" class="message"></p>
      </form>
    </section>

    <section class="card" id="projects-card" hidden>
      <h2>2. 选择项目与本地文件夹</h2>
      <div class="split">
        <div>
          <p class="muted" style="margin-top:0">服务器：<span id="connected-server"></span></p>
          <ul id="project-list" class="project-list"></ul>
        </div>
        <div class="mapping-form">
          <p style="margin:0">已选择：<strong id="selected-project">—</strong></p>
          <label>本地文件夹
            <div class="row">
              <input id="directory" placeholder="C:\\Users\\you\\ofsync-projects\\project">
              <button type="button" id="browse" class="secondary">浏览…</button>
            </div>
          </label>
          <div class="row">
            <button type="button" id="create-mapping">开始同步</button>
          </div>
          <p id="create-message" class="message"></p>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>3. 同步映射</h2>
      <table>
        <thead>
          <tr>
            <th>项目</th><th>本地文件夹</th><th>状态</th><th>最近同步</th><th>操作</th>
          </tr>
        </thead>
        <tbody id="mapping-rows"></tbody>
      </table>
      <p class="muted" style="margin-bottom:0">暂停或删除映射都不会删除本地文件；配置保存在 <code>~/.ofsync/manager.json</code>。</p>
    </section>
  </main>

  <dialog id="browse-dialog">
    <div class="dialog-head">
      <strong>选择本地文件夹</strong>
      <button type="button" id="browse-close" class="secondary">关闭</button>
    </div>
    <div class="dialog-body">
      <div class="row">
        <button type="button" id="browse-up" class="secondary">上一级</button>
        <input id="browse-path" placeholder="输入路径或从上方选择">
        <button type="button" id="browse-go" class="secondary">前往</button>
      </div>
      <ul id="browse-list" class="browse-list"></ul>
      <div class="row">
        <input id="new-folder" placeholder="新建文件夹名称">
        <button type="button" id="browse-mkdir" class="secondary">新建</button>
        <button type="button" id="browse-use">使用此文件夹</button>
      </div>
      <p id="browse-message" class="message"></p>
    </div>
  </dialog>

  <dialog id="conflicts-dialog">
    <div class="dialog-head">
      <strong>冲突</strong>
      <button type="button" id="conflicts-close" class="secondary">关闭</button>
    </div>
    <div class="dialog-body">
      <pre id="conflicts-body">加载中…</pre>
    </div>
  </dialog>

  <script>
    const $ = (id) => document.getElementById(id);
    const state = { serverUrl: null, projects: [], selected: null, browsePath: null, browseParent: null, pollTimer: null };

    function setMessage(id, text, ok) {
      const el = $(id);
      el.textContent = text || '';
      el.className = ok ? 'message ok' : 'message';
    }

    async function api(path, method, body) {
      const options = { method: method || 'GET', headers: {} };
      if (body !== undefined) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
      }
      const response = await fetch(path, options);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || ('HTTP ' + response.status));
      }
      return data;
    }

    function formatTime(value) {
      if (!value) return '—';
      const date = new Date(value);
      return isNaN(date.getTime()) ? value : date.toLocaleString();
    }

    function phaseLabel(phase) {
      return ({
        watching: '监听中', syncing: '同步中', paused: '已暂停', 'awaiting-auth': '等待登录',
        error: '出错', idle: '空闲'
      })[phase] || phase;
    }

    async function loadServers() {
      const data = await api('/api/manage/servers');
      const container = $('servers');
      container.textContent = '';
      for (const server of data.servers) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = server;
        container.appendChild(badge);
      }
    }

    $('auth-method').addEventListener('change', () => {
      const usePassword = $('auth-method').value === 'password';
      $('password-fields').hidden = !usePassword;
      $('cookie-fields').hidden = usePassword;
    });

    $('connect-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = $('connect-button');
      const serverUrl = $('server-url').value.trim();
      const method = $('auth-method').value;
      const body = { serverUrl };
      if (method === 'password') {
        body.email = $('email').value.trim();
        body.password = $('password').value;
      } else {
        body.cookie = $('cookie').value.trim();
      }
      button.disabled = true;
      setMessage('connect-message', '正在连接…', true);
      try {
        const result = await api('/api/manage/connect', 'POST', body);
        state.serverUrl = result.serverUrl;
        state.projects = result.projects;
        state.selected = null;
        localStorage.setItem('ofsync.serverUrl', state.serverUrl);
        $('connected-server').textContent = state.serverUrl;
        $('projects-card').hidden = false;
        renderProjects();
        setMessage('connect-message', '已连接，找到 ' + result.projects.length + ' 个项目。', true);
        await loadServers();
      } catch (error) {
        setMessage('connect-message', error.message, false);
      } finally {
        button.disabled = false;
      }
    });

    function renderProjects() {
      const list = $('project-list');
      list.textContent = '';
      if (state.projects.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'muted';
        empty.textContent = '没有可选项目。';
        list.appendChild(empty);
        return;
      }
      for (const project of state.projects) {
        const item = document.createElement('li');
        if (state.selected && state.selected.id === project.id) {
          item.className = 'selected';
        }
        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = project.name + (project.archived ? '（已归档）' : '');
        const id = document.createElement('div');
        id.className = 'id';
        id.textContent = project.id;
        item.appendChild(name);
        item.appendChild(id);
        item.addEventListener('click', () => {
          state.selected = project;
          $('selected-project').textContent = project.name;
          setMessage('create-message', '');
          renderProjects();
        });
        list.appendChild(item);
      }
    }

    $('create-mapping').addEventListener('click', async () => {
      if (!state.serverUrl) {
        setMessage('create-message', '请先连接服务器。', false);
        return;
      }
      if (!state.selected) {
        setMessage('create-message', '请先选择一个项目。', false);
        return;
      }
      const directory = $('directory').value.trim();
      if (!directory) {
        setMessage('create-message', '请选择本地文件夹。', false);
        return;
      }
      const button = $('create-mapping');
      button.disabled = true;
      setMessage('create-message', '正在添加映射并开始同步…', true);
      try {
        await api('/api/manage/mappings', 'POST', {
          serverUrl: state.serverUrl,
          projectId: state.selected.id,
          projectName: state.selected.name,
          directory
        });
        setMessage('create-message', '已添加映射，正在后台同步。', true);
        await refreshMappings();
      } catch (error) {
        setMessage('create-message', error.message, false);
      } finally {
        button.disabled = false;
      }
    });

    function addCell(row, child) {
      const cell = document.createElement('td');
      if (typeof child === 'string') {
        cell.textContent = child;
      } else {
        cell.appendChild(child);
      }
      row.appendChild(cell);
      return cell;
    }

    function actionButton(label, className, handler) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.className = className || 'secondary';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await handler();
        } catch (error) {
          alert(error.message);
        } finally {
          button.disabled = false;
          await refreshMappings();
        }
      });
      return button;
    }

    async function showConflicts(id) {
      $('conflicts-body').textContent = '加载中…';
      $('conflicts-dialog').showModal();
      try {
        const conflicts = await api('/api/manage/mappings/' + encodeURIComponent(id) + '/conflicts');
        $('conflicts-body').textContent = JSON.stringify(conflicts, null, 2);
      } catch (error) {
        $('conflicts-body').textContent = error.message;
      }
    }

    function renderMappings(mappings) {
      const body = $('mapping-rows');
      body.textContent = '';
      if (mappings.length === 0) {
        const row = document.createElement('tr');
        const cell = addCell(row, '还没有同步映射，请在上方添加。');
        cell.className = 'muted';
        cell.colSpan = 5;
        body.appendChild(row);
        return;
      }
      for (const mapping of mappings) {
        const row = document.createElement('tr');

        const projectCell = document.createElement('div');
        const projectName = document.createElement('div');
        projectName.textContent = mapping.projectName;
        const projectId = document.createElement('div');
        projectId.className = 'muted';
        projectId.textContent = mapping.projectId;
        projectCell.appendChild(projectName);
        projectCell.appendChild(projectId);
        if (mapping.lastError) {
          const error = document.createElement('div');
          error.className = 'error-text';
          error.textContent = mapping.lastError;
          projectCell.appendChild(error);
        }
        addCell(row, projectCell);

        const path = document.createElement('div');
        path.className = 'path';
        path.textContent = mapping.directory;
        addCell(row, path);

        const status = document.createElement('div');
        status.className = 'status ' + mapping.phase;
        const dot = document.createElement('span');
        dot.className = 'dot';
        status.appendChild(dot);
        status.appendChild(document.createTextNode(phaseLabel(mapping.phase) + (mapping.conflicts ? ' · ' + mapping.conflicts + ' 个冲突' : '')));
        addCell(row, status);

        addCell(row, formatTime(mapping.lastSyncAt));

        const actions = document.createElement('div');
        actions.className = 'actions';
        if (mapping.paused || !mapping.running) {
          actions.appendChild(actionButton('继续', '', async () => {
            await api('/api/manage/mappings/' + mapping.id + '/resume', 'POST');
          }));
        } else {
          actions.appendChild(actionButton('暂停', 'secondary', async () => {
            await api('/api/manage/mappings/' + mapping.id + '/pause', 'POST');
          }));
        }
        actions.appendChild(actionButton('同步', 'secondary', async () => {
          await api('/api/manage/mappings/' + mapping.id + '/sync', 'POST');
        }));
        actions.appendChild(actionButton('冲突', 'secondary', async () => {
          await showConflicts(mapping.id);
        }));
        actions.appendChild(actionButton('删除', 'danger', async () => {
          if (!confirm('移除映射「' + mapping.projectName + '」？本地文件会保留。')) {
            return;
          }
          await api('/api/manage/mappings/' + mapping.id, 'DELETE');
        }));
        addCell(row, actions);
        body.appendChild(row);
      }
    }

    async function refreshMappings() {
      try {
        renderMappings(await api('/api/manage/mappings'));
      } catch (error) {
        // The manager process may be shutting down; keep polling.
      }
    }

    $('browse').addEventListener('click', async () => {
      $('browse-dialog').showModal();
      $('browse-path').value = $('directory').value.trim();
      await loadBrowse($('directory').value.trim());
    });
    $('browse-close').addEventListener('click', () => $('browse-dialog').close());

    async function loadBrowse(path) {
      setMessage('browse-message', '');
      try {
        const result = await api('/api/manage/browse?path=' + encodeURIComponent(path || ''));
        state.browsePath = result.path || null;
        state.browseParent = result.parent || null;
        $('browse-path').value = result.path || '';
        $('browse-up').disabled = !result.parent;
        const list = $('browse-list');
        list.textContent = '';
        if (result.directories.length === 0) {
          const empty = document.createElement('li');
          empty.className = 'muted';
          empty.textContent = '没有子文件夹。';
          list.appendChild(empty);
        }
        for (const directory of result.directories) {
          const item = document.createElement('li');
          item.textContent = directory.name;
          item.addEventListener('click', () => loadBrowse(directory.path));
          list.appendChild(item);
        }
      } catch (error) {
        setMessage('browse-message', error.message, false);
      }
    }

    $('browse-up').addEventListener('click', () => {
      if (state.browseParent) loadBrowse(state.browseParent);
    });
    $('browse-go').addEventListener('click', () => loadBrowse($('browse-path').value.trim()));
    $('browse-path').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        loadBrowse($('browse-path').value.trim());
      }
    });
    $('browse-mkdir').addEventListener('click', async () => {
      if (!state.browsePath) {
        setMessage('browse-message', '请先选择一个目录。', false);
        return;
      }
      const name = $('new-folder').value.trim();
      if (!name) {
        setMessage('browse-message', '请输入文件夹名称。', false);
        return;
      }
      try {
        const result = await api('/api/manage/browse/mkdir', 'POST', { path: state.browsePath, name });
        $('new-folder').value = '';
        setMessage('browse-message', '已创建 ' + result.path, true);
        await loadBrowse(result.path);
      } catch (error) {
        setMessage('browse-message', error.message, false);
      }
    });
    $('browse-use').addEventListener('click', () => {
      if (!state.browsePath) {
        setMessage('browse-message', '请先选择一个目录。', false);
        return;
      }
      $('directory').value = state.browsePath;
      $('browse-dialog').close();
    });
    $('conflicts-close').addEventListener('click', () => $('conflicts-dialog').close());

    const savedServer = localStorage.getItem('ofsync.serverUrl');
    if (savedServer) {
      $('server-url').value = savedServer;
    }
    loadServers().catch(() => {});
    refreshMappings();
    state.pollTimer = setInterval(refreshMappings, 2500);
  </script>
</body>
</html>`;
}
