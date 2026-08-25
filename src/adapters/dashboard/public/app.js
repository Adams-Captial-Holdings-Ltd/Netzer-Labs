// Mission Control SPA. No build step. ESM module loaded directly by the browser.
// Hits the /api/* JSON endpoints with the dashboard token from sessionStorage.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  token: sessionStorage.getItem('claudeclaw_token') || '',
  view: 'overview',
  data: {},
  agents: [],
};

const VIEWS = [
  { id: 'overview', label: 'Overview' },
  { id: 'agents', label: 'Agents' },
  { id: 'chat', label: 'Chat' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'usage', label: 'Usage' },
  { id: 'memories', label: 'Memories' },
  { id: 'hive', label: 'Hive' },
  { id: 'missions', label: 'Missions' },
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'vectors', label: 'Vectors' },
  { id: 'audit', label: 'Audit' },
  { id: 'killSwitches', label: 'Kill switches' },
];

async function api(path, opts = {}) {
  const headers = Object.assign(
    { 'Authorization': `Bearer ${state.token}` },
    opts.body ? { 'Content-Type': 'application/json' } : {},
    opts.headers || {},
  );
  const resp = await fetch(`/api${path}`, Object.assign({}, opts, { headers }));
  if (resp.status === 401) {
    sessionStorage.removeItem('claudeclaw_token');
    state.token = '';
    render();
    throw new Error('unauthorized');
  }
  const body = await resp.text();
  if (!resp.ok) {
    throw new Error(`${resp.status}: ${body}`);
  }
  return body ? JSON.parse(body) : null;
}

function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'error' ? 'error' : ''}`;
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderAuthShell() {
  $('#app').innerHTML = `
    <div class="auth-shell">
      <h2>Mission Control</h2>
      <p class="muted small">Paste your <kbd>DASHBOARD_TOKEN</kbd>. Recoverable with
      <code>aws secretsmanager get-secret-value --secret-id /claudeclaw/dashboard</code>.</p>
      <div class="stack">
        <input type="password" id="token-input" placeholder="token..." />
        <button class="action" id="login">Sign in</button>
      </div>
    </div>
  `;
  $('#login').addEventListener('click', () => {
    const t = $('#token-input').value.trim();
    if (!t) return toast('token required', 'error');
    sessionStorage.setItem('claudeclaw_token', t);
    state.token = t;
    render();
  });
  $('#token-input').focus();
  $('#token-input').addEventListener('keyup', (e) => {
    if (e.key === 'Enter') $('#login').click();
  });
}

function renderHeader() {
  return `
    <header>
      <div>
        <h1>ClaudeClaw Mission Control <span class="tag">v1</span></h1>
      </div>
      <nav>
        ${VIEWS.map(
          (v) =>
            `<button data-view="${v.id}" class="${
              v.id === state.view ? 'active' : ''
            }">${v.label}</button>`,
        ).join('')}
        <button class="action danger" id="signout" title="Forget token">Sign out</button>
      </nav>
    </header>
  `;
}

function shell(body) {
  $('#app').innerHTML = `${renderHeader()}<main id="main">${body}</main>`;
  $$('nav button[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.view = btn.dataset.view;
      render();
    });
  });
  $('#signout')?.addEventListener('click', () => {
    sessionStorage.removeItem('claudeclaw_token');
    state.token = '';
    render();
  });
}

// ── Views ────────────────────────────────────────────────────────────
async function renderOverview() {
  shell(`<h2>Overview</h2><div id="tier-badge" class="muted small" style="margin-bottom:8px;">loading tier...</div>
    <div class="grid" id="cards">loading...</div>
    <h3>Today's spend by agent</h3><div id="spend-rows" class="card">loading...</div>
    <h3>Active add-ons</h3><div id="addon-rows" class="card">loading...</div>`);
  const [agents, cost, switches, sessions, tier, addons] = await Promise.all([
    api('/agents'),
    api('/cost-today'),
    api('/kill-switches'),
    api('/sessions'),
    api('/tier'),
    api('/addons'),
  ]);
  $('#tier-badge').innerHTML = `Tier <strong>T${tier.tier} ${escapeHtml(tier.label)}</strong> · daily cost cap $${tier.dailyCostCapUsd} · X-Ray ${tier.xrayEnabled ? 'ON' : 'OFF'} · ${addons.addons.filter((a) => a.active).length} of ${addons.count} add-ons active`;
  const activeSwitches = switches.switches.filter((s) => s.active);
  $('#cards').innerHTML = `
    ${cardHtml('Today spend', `$${Number(cost.costUsd).toFixed(4)}`, 'big')}
    ${cardHtml('Agents', String(agents.agents.length))}
    ${cardHtml('Sessions tracked', String(sessions.sessions.length))}
    ${cardHtml(
      'Active kill switches',
      String(activeSwitches.length),
      activeSwitches.length > 0 ? 'big' : '',
    )}
    <div class="card" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;border:1px solid rgba(99,102,241,0.3);background:linear-gradient(135deg,#0f172a 0%,var(--bg-2) 100%)" onclick="window.location.href='/dashboard/warroom'">
      <div>
        <div style="font-size:14px;font-weight:600;color:#a5b4fc">War Room</div>
        <div style="font-size:12px;color:var(--fg-muted);margin-top:2px">Multi-agent group chat</div>
      </div>
      <div style="font-size:20px;color:#6366f1">&#9876;</div>
    </div>
  `;
  const agentList = agents.agents.map((a) => a.id);
  const rows = await Promise.all(
    agentList.map(async (id) => {
      try {
        const u = await api(`/usage?days=1&agentId=${encodeURIComponent(id)}`);
        return `<tr><td class="mono">${escapeHtml(id)}</td>
          <td>$${u.totals.costUsd.toFixed(4)}</td>
          <td>${u.totals.calls}</td>
          <td>${u.totals.inputTokens.toLocaleString()} in</td>
          <td>${u.totals.outputTokens.toLocaleString()} out</td></tr>`;
      } catch (err) {
        return `<tr><td class="mono">${escapeHtml(id)}</td><td colspan="4" class="muted">${escapeHtml(err.message)}</td></tr>`;
      }
    }),
  );
  $('#spend-rows').innerHTML = `
    <table><thead><tr><th>Agent</th><th>Spend</th><th>Calls</th><th>In</th><th>Out</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table>`;
  $('#addon-rows').innerHTML = `<table><thead><tr><th>Add-on</th><th>Configured</th><th>Switch</th><th>Active</th></tr></thead>
    <tbody>${addons.addons
      .map(
        (a) => `
        <tr>
          <td><strong>${escapeHtml(a.title)}</strong><br/><span class="small muted">${escapeHtml(a.description)}</span></td>
          <td><span class="pill ${a.configured ? 'inactive' : 'active'}">${a.configured ? 'yes' : 'no'}</span></td>
          <td>${a.killSwitch ? `<code>${escapeHtml(a.killSwitch)}</code> ${a.killSwitchActive ? '<span class="pill active">TRIPPED</span>' : ''}` : '<span class="muted">—</span>'}</td>
          <td><span class="pill ${a.active ? 'inactive' : 'cancelled'}">${a.active ? 'active' : 'inactive'}</span></td>
        </tr>`,
      )
      .join('')}</tbody></table>`;
}

function cardHtml(label, value, valueClass = '') {
  return `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="value ${valueClass}">${escapeHtml(value)}</div></div>`;
}

async function renderAgents() {
  shell(`<h2>Agents</h2>
    <div style="display:grid;grid-template-columns:200px 1fr;gap:16px;">
      <div id="agent-list" class="card">loading...</div>
      <div id="agent-editor">pick an agent.</div>
    </div>`);
  const data = await api('/agents');
  state.agents = data.agents.map((a) => a.id);
  $('#agent-list').innerHTML = `<div class="label">Agents</div>
    ${data.agents.map((a) => `<div style="margin-top:6px;"><button class="action" style="width:100%;text-align:left;" data-agent="${escapeHtml(a.id)}">${escapeHtml(a.id)} (${escapeHtml(a.model || 'default')})</button></div>`).join('')}`;
  $$('button[data-agent]').forEach((btn) => {
    btn.addEventListener('click', () => loadAgentEditor(btn.dataset.agent));
  });
  if (data.agents[0]) loadAgentEditor(data.agents[0].id);
}

async function loadAgentEditor(agentId) {
  const editor = $('#agent-editor');
  editor.innerHTML = `<div class="muted">loading ${escapeHtml(agentId)}...</div>`;
  const [file, history] = await Promise.all([
    api(`/agents/${encodeURIComponent(agentId)}/file?file=CLAUDE.md`),
    api(`/agents/${encodeURIComponent(agentId)}/history?limit=25`),
  ]);
  editor.innerHTML = `
    <h3>${escapeHtml(agentId)} · CLAUDE.md</h3>
    <textarea id="agent-body" style="min-height:340px;font:13px/1.5 var(--mono);">${escapeHtml(file.body)}</textarea>
    <div class="row" style="margin-top:8px;">
      <input id="agent-note" placeholder="optional note for this revision" class="grow" />
      <button class="action" id="agent-save">Save revision</button>
    </div>
    <h3>Revisions</h3>
    <div id="agent-history">${
      history.revisions.length === 0
        ? '<div class="muted">No revisions saved yet via dashboard.</div>'
        : `<table><thead><tr><th>When</th><th>By</th><th>Note</th><th>Chars</th><th></th></tr></thead><tbody>${history.revisions
            .map(
              (r) => `<tr>
                <td class="mono">${escapeHtml(r.createdAt.slice(0, 19))}</td>
                <td>${escapeHtml(r.editedBy)}</td>
                <td>${escapeHtml(r.note || '')}</td>
                <td>${r.chars}</td>
                <td class="right"><button class="action" data-rev="${escapeHtml(r.revId)}">Restore</button></td>
              </tr>`,
            )
            .join('')}</tbody></table>`
    }</div>`;
  $('#agent-save').addEventListener('click', async () => {
    const body = $('#agent-body').value;
    const note = $('#agent-note').value.trim() || undefined;
    try {
      const r = await api(`/agents/${encodeURIComponent(agentId)}/file`, {
        method: 'PUT',
        body: JSON.stringify({ filename: 'CLAUDE.md', body, ...(note ? { note } : {}) }),
      });
      toast(`Saved rev ${r.revId.slice(0, 8)}`);
      await loadAgentEditor(agentId);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $$('button[data-rev]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const revId = btn.dataset.rev;
      try {
        const rev = await api(`/agents/${encodeURIComponent(agentId)}/history/${encodeURIComponent(revId)}`);
        $('#agent-body').value = rev.body;
        toast(`Loaded rev ${revId.slice(0, 8)} into editor — click Save to restore.`);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

async function renderSessions() {
  shell(`<h2>Sessions</h2><div id="sessions">loading...</div>`);
  const data = await api('/sessions');
  $('#sessions').innerHTML = data.sessions.length === 0
    ? `<div class="muted">No sessions yet.</div>`
    : `<table><thead><tr><th>Agent</th><th>Chat</th><th>Updated</th><th>Model</th></tr></thead>
      <tbody>${data.sessions
        .map(
          (s) => `
          <tr>
            <td class="mono">${escapeHtml(s.agentId)}</td>
            <td class="mono">${escapeHtml(s.chatId)}</td>
            <td>${s.updatedAt ? new Date(s.updatedAt * 1000).toISOString().slice(0, 19).replace('T', ' ') : ''}</td>
            <td class="mono">${escapeHtml(s.modelOverride || '')}</td>
          </tr>`,
        )
        .join('')}</tbody></table>`;
}

async function renderUsage() {
  shell(`<h2>Usage</h2>
    <div class="row" style="max-width: 400px; margin-bottom: 16px;">
      <input id="usage-agent" placeholder="agent id (default: main)" value="main" />
      <input id="usage-days" type="number" min="1" max="30" value="7" />
      <button class="action" id="usage-reload">Reload</button>
    </div>
    <div id="usage">loading...</div>`);
  const reload = async () => {
    const agent = $('#usage-agent').value.trim() || 'main';
    const days = Math.max(1, Math.min(30, Number($('#usage-days').value) || 7));
    const data = await api(`/usage?agentId=${encodeURIComponent(agent)}&days=${days}`);
    $('#usage').innerHTML = `
      <div class="grid">
        ${cardHtml('Calls', String(data.totals.calls))}
        ${cardHtml('Spend USD', `$${data.totals.costUsd.toFixed(4)}`, 'big')}
        ${cardHtml('Input tokens', data.totals.inputTokens.toLocaleString())}
        ${cardHtml('Output tokens', data.totals.outputTokens.toLocaleString())}
        ${cardHtml('Cache read', data.totals.cacheReadInputTokens.toLocaleString())}
        ${cardHtml('Cache write', data.totals.cacheWriteInputTokens.toLocaleString())}
      </div>
      <h3>Recent rows</h3>
      <table><thead><tr><th>Time</th><th>Model</th><th>Chat</th><th>In</th><th>Out</th><th>$</th><th>ms</th></tr></thead>
        <tbody>${data.rows
          .slice(0, 50)
          .map(
            (r) => `
          <tr>
            <td class="mono">${escapeHtml(String(r.ts).slice(11, 19))}</td>
            <td class="mono">${escapeHtml(String(r.modelId || '').split('.').pop())}</td>
            <td class="mono">${escapeHtml(String(r.chatId || ''))}</td>
            <td>${r.inputTokens}</td>
            <td>${r.outputTokens}</td>
            <td>$${Number(r.costUsd || 0).toFixed(4)}</td>
            <td>${r.latencyMs || ''}</td>
          </tr>`,
          )
          .join('')}</tbody></table>`;
  };
  $('#usage-reload').addEventListener('click', reload);
  await reload();
}

async function renderMemories() {
  shell(`<h2>Memories</h2>
    <div class="row" style="max-width: 500px; margin-bottom: 16px;">
      <input id="mem-agent" placeholder="agent id" value="main" />
      <input id="mem-chat" placeholder="chat id" class="grow" />
      <button class="action" id="mem-reload">Load</button>
    </div>
    <div id="memories" class="muted">enter a chat id to load.</div>`);
  $('#mem-reload').addEventListener('click', async () => {
    const agentId = $('#mem-agent').value.trim() || 'main';
    const chatId = $('#mem-chat').value.trim();
    if (!chatId) return toast('chatId required', 'error');
    const data = await api(`/memories?agentId=${encodeURIComponent(agentId)}&chatId=${encodeURIComponent(chatId)}`);
    if (data.memories.length === 0) {
      $('#memories').innerHTML = `<div class="muted">No memories for this chat.</div>`;
      return;
    }
    $('#memories').innerHTML = `
      <table><thead><tr><th>Importance</th><th>Tags</th><th>Content</th><th>Created</th></tr></thead>
        <tbody>${data.memories
          .map(
            (m) => `
            <tr>
              <td>${m.importance}</td>
              <td class="mono">${escapeHtml((m.tags || []).join(', '))}</td>
              <td>${escapeHtml(m.content)}</td>
              <td class="mono">${escapeHtml(String(m.createdAt).slice(0, 19))}</td>
            </tr>`,
          )
          .join('')}</tbody></table>`;
  });
}

async function renderHive() {
  shell(`<h2>Hive Mind</h2><div id="hive">loading...</div>`);
  const data = await api('/hive?limit=50');
  if (data.notes.length === 0) {
    $('#hive').innerHTML = `<div class="muted">No hive notes yet.</div>`;
    return;
  }
  $('#hive').innerHTML = `<table><thead><tr><th>Time</th><th>Agent</th><th>Topic</th><th>Imp</th><th>Note</th></tr></thead>
    <tbody>${data.notes
      .map(
        (n) => `
        <tr>
          <td class="mono">${escapeHtml(String(n.createdAt).slice(0, 19))}</td>
          <td class="mono">${escapeHtml(n.authorAgentId)}</td>
          <td class="mono">${escapeHtml(n.topic || '')}</td>
          <td>${n.importance}</td>
          <td>${escapeHtml(n.content)}</td>
        </tr>`,
      )
      .join('')}</tbody></table>`;
}

async function renderMissions() {
  shell(`<h2>Missions</h2>
    <div class="row" style="max-width: 500px; margin-bottom: 16px;">
      <input id="msn-owner" value="main" placeholder="owner agent" />
      <button class="action" id="msn-reload">Load</button>
    </div>
    <div id="msn-board" class="muted">loading...</div>`);
  const STATUSES = ['open', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled'];
  const reload = async () => {
    const owner = $('#msn-owner').value.trim() || 'main';
    const data = await api(`/missions?owner=${encodeURIComponent(owner)}`);
    if (data.missions.length === 0) {
      $('#msn-board').innerHTML = `<div class="muted">No missions for ${escapeHtml(owner)}.</div>`;
      return;
    }
    const byStatus = STATUSES.map((s) => ({
      status: s,
      rows: data.missions.filter((m) => m.status === s),
    }));
    $('#msn-board').innerHTML = `<div class="grid" style="grid-template-columns: repeat(${STATUSES.length}, 1fr);">
      ${byStatus
        .map(
          (col) => `
        <div class="card">
          <div class="label">${escapeHtml(col.status)} (${col.rows.length})</div>
          ${col.rows
            .map(
              (m) => `
            <div style="margin-top:8px;padding:8px;border:1px solid var(--border);border-radius:6px;">
              <div style="font-weight:600;">${escapeHtml(m.title)}</div>
              <div class="small muted">${escapeHtml(m.priority)} priority · by ${escapeHtml(m.createdByAgent)} · ${escapeHtml(m.id.slice(0, 8))}</div>
              <div class="small">${escapeHtml(m.body.slice(0, 140))}</div>
              <div class="right" style="margin-top:6px;">
                ${STATUSES.filter((s) => s !== m.status)
                  .map(
                    (s) =>
                      `<button class="action" data-mid="${escapeHtml(m.id)}" data-owner="${escapeHtml(owner)}" data-status="${s}" style="margin-left:4px;font-size:11px;">→ ${s}</button>`,
                  )
                  .join('')}
              </div>
            </div>`,
            )
            .join('')}
        </div>`,
        )
        .join('')}
    </div>`;
    $$('button[data-mid]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(
            `/missions/${encodeURIComponent(btn.dataset.owner)}/${encodeURIComponent(btn.dataset.mid)}/status`,
            {
              method: 'POST',
              body: JSON.stringify({ status: btn.dataset.status }),
            },
          );
          toast(`moved to ${btn.dataset.status}`);
          await reload();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  };
  $('#msn-reload').addEventListener('click', reload);
  await reload();
}

async function renderScheduled() {
  shell(`<h2>Scheduled tasks</h2>
    <div class="row" style="max-width: 500px; margin-bottom: 16px;">
      <input id="sched-agent" value="main" />
      <button class="action" id="sched-reload">Load</button>
    </div>
    <div id="sched">loading...</div>`);
  const reload = async () => {
    const agent = $('#sched-agent').value.trim() || 'main';
    const data = await api(`/scheduled?agentId=${encodeURIComponent(agent)}`);
    if (data.tasks.length === 0) {
      $('#sched').innerHTML = `<div class="muted">No scheduled tasks.</div>`;
      return;
    }
    $('#sched').innerHTML = `<table><thead><tr><th>Status</th><th>Next run</th><th>Recur</th><th>Chat</th><th>Prompt</th><th></th></tr></thead>
      <tbody>${data.tasks
        .map((t) => {
          const next = new Date(t.nextRunAt * 1000).toISOString().slice(0, 19);
          return `
            <tr data-id="${escapeHtml(t.id)}">
              <td><span class="pill ${escapeHtml(t.status)}">${escapeHtml(t.status)}</span></td>
              <td class="mono">${escapeHtml(next)}</td>
              <td class="mono">${t.intervalSec ? `${t.intervalSec}s` : 'one-shot'}</td>
              <td class="mono">${escapeHtml(t.chatId)}</td>
              <td>${escapeHtml(t.promptText.slice(0, 100))}</td>
              <td class="right">${
                t.status === 'active'
                  ? `<button class="action danger" data-cancel="${escapeHtml(t.id)}">Cancel</button>`
                  : ''
              }</td>
            </tr>`;
        })
        .join('')}</tbody></table>`;
    $$('button[data-cancel]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const agent = $('#sched-agent').value.trim() || 'main';
        const id = btn.dataset.cancel;
        try {
          await api(`/scheduled/${encodeURIComponent(agent)}/${encodeURIComponent(id)}`, {
            method: 'DELETE',
          });
          toast(`Cancelled ${id.slice(0, 8)}`);
          await reload();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  };
  $('#sched-reload').addEventListener('click', reload);
  await reload();
}

async function renderVectors() {
  shell(`<h2>Vectors</h2>
    <div class="row" style="max-width: 400px; margin-bottom: 16px;">
      <input id="vec-scope" placeholder="scope" value="default" />
      <button class="action" id="vec-reload">List docs</button>
    </div>
    <div id="vec-list" class="muted">load to view.</div>
    <h3>Ingest a document</h3>
    <div class="stack" style="max-width: 700px;">
      <div class="row">
        <input id="ing-title" placeholder="doc title" class="grow" />
        <input id="ing-source" placeholder="source (URL, filename)" />
      </div>
      <div class="row">
        <input id="ing-scope" placeholder="scope" value="default" />
        <select id="ing-format" style="background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 8px;">
          <option value="text">text</option>
          <option value="markdown">markdown</option>
          <option value="html">html</option>
          <option value="pdf">pdf (upload)</option>
          <option value="docx">docx (upload)</option>
        </select>
      </div>
      <textarea id="ing-content" placeholder="paste content here, or pick a file below..."></textarea>
      <div class="row">
        <input id="ing-file" type="file" accept=".pdf,.docx,.txt,.md,.html" />
        <button class="action" id="ing-go">Ingest</button>
      </div>
    </div>`);
  const reload = async () => {
    const scope = $('#vec-scope').value.trim() || 'default';
    const data = await api(`/vectors?scope=${encodeURIComponent(scope)}`);
    if (data.docs.length === 0) {
      $('#vec-list').innerHTML = `<div class="muted">No docs in scope.</div>`;
      return;
    }
    $('#vec-list').innerHTML = `
      <table><thead><tr><th>Doc id</th><th></th></tr></thead>
        <tbody>${data.docs
          .map(
            (d) => `<tr><td class="mono">${escapeHtml(d)}</td>
              <td class="right"><button class="action danger" data-del-scope="${escapeHtml(scope)}" data-del-doc="${escapeHtml(d)}">Delete</button></td></tr>`,
          )
          .join('')}</tbody></table>`;
    $$('button[data-del-doc]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const scope = btn.dataset.delScope;
        const doc = btn.dataset.delDoc;
        try {
          await api(`/vectors/${encodeURIComponent(scope)}/${encodeURIComponent(doc)}`, {
            method: 'DELETE',
          });
          toast(`Deleted ${doc}`);
          await reload();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  };
  $('#vec-reload').addEventListener('click', reload);
  $('#ing-go').addEventListener('click', async () => {
    const file = $('#ing-file').files[0];
    const explicitFormat = $('#ing-format').value;
    const isBinary = explicitFormat === 'pdf' || explicitFormat === 'docx';
    const payload = {
      docTitle: $('#ing-title').value.trim() || (file ? file.name : undefined),
      source: $('#ing-source').value.trim() || (file ? file.name : undefined),
      scope: $('#ing-scope').value.trim() || undefined,
      format: explicitFormat,
    };
    if (file && isBinary) {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      payload.contentBase64 = btoa(binary);
    } else {
      const content = $('#ing-content').value;
      if (!content.trim()) return toast('content or file required', 'error');
      payload.content = content;
    }
    try {
      const res = await api('/ingest', { method: 'POST', body: JSON.stringify(payload) });
      toast(`Ingested ${res.chunks} chunks as ${res.docId}`);
      $('#ing-content').value = '';
      $('#ing-file').value = '';
      $('#vec-scope').value = res.scope;
      await reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

async function renderAudit() {
  shell(`<h2>Audit log</h2><div id="audit">loading...</div>`);
  const data = await api('/audit?days=1');
  if (data.rows.length === 0) {
    $('#audit').innerHTML = `<div class="muted">No audit events today.</div>`;
    return;
  }
  $('#audit').innerHTML = `<table><thead><tr><th>Time</th><th>Action</th><th>Agent</th><th>Surface</th><th>Result</th><th>Detail</th></tr></thead>
    <tbody>${data.rows
      .map(
        (r) => `
        <tr>
          <td class="mono">${escapeHtml(String(r.ts || '').slice(11, 19))}</td>
          <td class="mono">${escapeHtml(r.action || '')}</td>
          <td class="mono">${escapeHtml(r.agentId || '')}</td>
          <td class="mono">${escapeHtml(r.surface || '')}</td>
          <td>${escapeHtml(r.result || '')}</td>
          <td class="mono">${escapeHtml(JSON.stringify(r.detail || {}).slice(0, 160))}</td>
        </tr>`,
      )
      .join('')}</tbody></table>`;
}

async function renderKillSwitches() {
  shell(`<h2>Kill switches</h2><div id="ks">loading...</div>`);
  const reload = async () => {
    const data = await api('/kill-switches');
    $('#ks').innerHTML = `<table><thead><tr><th>Name</th><th>State</th><th>Reason</th><th></th></tr></thead>
      <tbody>${data.switches
        .map(
          (s) => `
          <tr>
            <td class="mono">${escapeHtml(s.name)}</td>
            <td><span class="pill ${s.active ? 'active' : 'inactive'}">${s.active ? 'TRIPPED' : 'normal'}</span></td>
            <td class="mono">${escapeHtml(s.reason || '')}</td>
            <td class="right"><button class="action ${s.active ? '' : 'danger'}" data-switch="${escapeHtml(s.name)}" data-toggle="${s.active ? 'off' : 'on'}">${s.active ? 'Disarm' : 'TRIP'}</button></td>
          </tr>`,
        )
        .join('')}</tbody></table>`;
    $$('button[data-switch]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.switch;
        const toggleOn = btn.dataset.toggle === 'on';
        const reason = prompt(`Reason for ${toggleOn ? 'tripping' : 'disarming'} ${name}?`, 'manual via UI');
        if (reason === null) return;
        try {
          await api('/kill-switches', {
            method: 'POST',
            body: JSON.stringify({ name, active: toggleOn, reason }),
          });
          toast(`${name} ${toggleOn ? 'TRIPPED' : 'disarmed'}`);
          await reload();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  };
  await reload();
}

async function renderChat() {
  shell(`<h2>Chat</h2>
    <div class="row" style="max-width: 600px; margin-bottom: 16px;">
      <input id="chat-agent" value="main" />
      <input id="chat-id" placeholder="chat id (default: dashboard:<ts>)" class="grow" />
    </div>
    <div class="chat-log" id="chat-log"></div>
    <div class="row" style="margin-top: 12px;">
      <input id="chat-input" placeholder="type a message and press Enter..." class="grow" />
      <button class="action" id="chat-send">Send</button>
    </div>`);
  let chatId = `dashboard:${Date.now()}`;
  $('#chat-id').value = chatId;
  const log = $('#chat-log');
  const send = async () => {
    const text = $('#chat-input').value.trim();
    if (!text) return;
    const agent = $('#chat-agent').value.trim() || 'main';
    chatId = $('#chat-id').value.trim() || chatId;
    $('#chat-input').value = '';
    log.innerHTML += `<div class="user">> ${escapeHtml(text)}</div>`;
    const replyEl = document.createElement('div');
    replyEl.className = 'assistant';
    replyEl.textContent = '…';
    log.appendChild(replyEl);
    log.scrollTop = log.scrollHeight;
    // SSE streaming via fetch POST so the bearer token AND the user
    // prompt both stay out of access logs.
    try {
      const resp = await fetch('/api/test-turn/stream', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${state.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ agentId: agent, chatId, text }),
      });
      if (!resp.ok || !resp.body) {
        throw new Error(`stream HTTP ${resp.status}`);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';
        for (const raw of events) {
          const lines = raw.split('\n');
          let evType = 'message';
          let data = '';
          for (const l of lines) {
            if (l.startsWith('event: ')) evType = l.slice(7);
            else if (l.startsWith('data: ')) data += l.slice(6);
          }
          if (evType === 'chunk' || evType === 'reply') {
            replyEl.textContent = data;
            log.scrollTop = log.scrollHeight;
          } else if (evType === 'final') {
            try {
              const f = JSON.parse(data);
              replyEl.textContent = f.text;
            } catch {
              // ignore
            }
          } else if (evType === 'error') {
            replyEl.style.color = 'var(--danger)';
            replyEl.textContent = `error: ${data}`;
          }
        }
      }
    } catch (err) {
      replyEl.style.color = 'var(--danger)';
      replyEl.textContent = err.message;
    }
  };
  $('#chat-send').addEventListener('click', send);
  $('#chat-input').addEventListener('keyup', (e) => {
    if (e.key === 'Enter') send();
  });
  $('#chat-input').focus();
}

async function render() {
  if (!state.token) {
    renderAuthShell();
    return;
  }
  try {
    const renderers = {
      overview: renderOverview,
      agents: renderAgents,
      sessions: renderSessions,
      usage: renderUsage,
      memories: renderMemories,
      hive: renderHive,
      missions: renderMissions,
      scheduled: renderScheduled,
      vectors: renderVectors,
      audit: renderAudit,
      killSwitches: renderKillSwitches,
      chat: renderChat,
    };
    const fn = renderers[state.view] || renderOverview;
    await fn();
    // D3: keying the data-view attribute restarts the CSS fade-in.
    const main = $('#main');
    if (main) main.dataset.view = state.view;
    // D3: wrap any table inside #main in a scrollable container so the
    // mobile media query can scroll horizontally without breaking the
    // viewport. Skips tables that are already wrapped.
    $$('#main table').forEach((t) => {
      if (t.parentElement && !t.parentElement.classList.contains('table-wrap')) {
        const wrap = document.createElement('div');
        wrap.className = 'table-wrap';
        t.parentElement.insertBefore(wrap, t);
        wrap.appendChild(t);
      }
    });
  } catch (err) {
    console.error(err);
    toast(err.message, 'error');
  }
}

// D3: first-run welcome modal. Shows once per session and once per
// machine (sessionStorage AND localStorage flag). Dismissing sets both.
function maybeShowWelcome() {
  const seenSession = sessionStorage.getItem('claudeclaw_seen');
  const seenEver = localStorage.getItem('claudeclaw_seen');
  if (seenSession || seenEver) return;
  const root = $('#modal-root');
  if (!root) return;
  root.innerHTML = `
    <div class="welcome-overlay" id="welcome-overlay" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
      <div class="welcome-modal">
        <h2 id="welcome-title">Welcome to Mission Control</h2>
        <p class="muted">A quick three-step orientation so the rest of the UI feels less mysterious.</p>
        <ol>
          <li><strong>Sign in with your dashboard token.</strong> Recoverable any time with <code>aws secretsmanager get-secret-value --secret-id /claudeclaw/dashboard</code>.</li>
          <li><strong>Use the top nav to switch views.</strong> Overview is the at-a-glance state; Chat lets you drive a turn end-to-end.</li>
          <li><strong>Kill switches</strong> are your circuit breakers. Trip them when something downstream is misbehaving and disarm when fixed. Effects propagate in ~10s.</li>
        </ol>
        <div class="actions">
          <button class="action" id="welcome-dismiss">Got it</button>
        </div>
      </div>
    </div>
  `;
  $('#welcome-dismiss').addEventListener('click', () => {
    sessionStorage.setItem('claudeclaw_seen', '1');
    localStorage.setItem('claudeclaw_seen', '1');
    root.innerHTML = '';
  });
  // ESC dismisses
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') $('#welcome-dismiss')?.click();
    },
    { once: true },
  );
}

maybeShowWelcome();
render();
// v2
