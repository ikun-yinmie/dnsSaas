/* dnsSaas 前端:Tab 布局 + 表单化配置 + 即时反馈 */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const S = {
  state: null,       // /api/state
  tab: 'dashboard',
  yamlLoaded: false,
  modal: null,       // {kind:'domain'|'provider', mode:'create'|'edit', id, name}
};

/* ---------- 工具 ---------- */
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function ago(ts) {
  if (!ts) return '从未';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
function fmtMs(ms) { return ms == null ? '—' : `${ms}ms`; }

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function api(path, opts = {}) {
  const resp = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (resp.status === 401) {
    $('#login-mask').classList.remove('hidden');
    throw new Error('未登录');
  }
  return resp.json();
}

async function withBtn(btn, text, fn) {
  if (!btn || btn.disabled) return;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = text;
  try { await fn(); } finally { btn.disabled = false; btn.textContent = old; }
}

function fqdnOf(side) {
  const name = (side.name || '@').trim();
  const base = side.zone || side.subdomain || '';
  if (!name || name === '@') return base;
  if (name === '*') return base.startsWith('*.') ? base : `*.${base}`;
  if (name.includes('.') || name.includes('*')) return name;
  return `${name}.${base}`;
}

/* ---------- 数据刷新 ---------- */
async function refreshState() {
  try {
    const data = await api('/api/state');
    S.state = data;
    $('#login-mask').classList.add('hidden');
    $('#logout-btn').classList.remove('hidden');
    if (data.server?.dryRun) $('#dry-tag').classList.remove('hidden');
    $('#uptime').textContent = `已运行 ${ago(data.startedAt).replace('后', '')}`;
    renderAll();
  } catch { /* 401 或网络错误 */ }
}

function renderAll() {
  if (!S.state) return;
  renderStats();
  if (S.tab === 'dashboard') { renderDashboard(); }
  if (S.tab === 'domains') { renderDomainList(); }
  if (S.tab === 'providers') { renderProviderList(); }
  if (S.tab === 'logs') { fetchLogs(); }
}

/* ---------- 仪表盘 ---------- */
function renderStats() {
  const st = S.state;
  const cfgs = st.domainCfgs || [];
  const liveMap = new Map((st.domains || []).map((d) => [d.id, d]));
  // 只统计配置中存在的域名(防止旧状态残留干扰)
  const okCount = cfgs.filter((c) => liveMap.get(c.id)?.lastCheckResult?.ok === true).length;
  const failCount = cfgs.filter((c) => liveMap.get(c.id)?.lastCheckResult?.ok === false).length;
  const bestN = (st.ips?.best || []).length;
  const need = st.ipNeeded || 0;
  $('#stats').innerHTML = `
    <div class="stat"><div class="num">${cfgs.length}</div><div class="label">域名总数</div></div>
    <div class="stat"><div class="num" style="color:var(--green)">${okCount}</div><div class="label">当前可用</div></div>
    <div class="stat"><div class="num" style="color:var(--red)">${failCount}</div><div class="label">当前失败</div></div>
    <div class="stat"><div class="num">${bestN} / ${need}</div><div class="label">优选IP / 需要</div></div>`;
}

function sideLine(label, state, cfg) {
  if (!cfg) return '';
  const fq = fqdnOf(cfg);
  const values = (state?.currentValues || []).join(', ');
  const errLine = state?.lastError
    ? `<div class="kv"><span style="color:var(--red)">同步错误</span><b style="color:var(--red)">${esc(String(state.lastError).slice(0, 80))}</b></div>`
    : '';
  return `
  <div class="kv"><span>${label}</span><b>${esc(cfg.provider)} · ${esc(fq)}</b></div>
  <div class="kv"><span>类型 / TTL</span><b>${esc(cfg.type)} · TTL ${esc(cfg.ttl)}</b></div>
  <div class="kv"><span>当前记录值</span><b>${esc(values || '未同步')}</b></div>
  ${errLine}`;
}

function renderDashboard() {
  const cfgs = S.state.domainCfgs || [];
  const liveMap = new Map((S.state.domains || []).map((d) => [d.id, d]));
  // 以配置为准渲染(不再遍历运行时状态,避免历史残留的幽灵域名出现)
  $('#domains').innerHTML = cfgs.map((cfg) => {
    const d = liveMap.get(cfg.id) || {};
    const r = d.lastCheckResult || {};
    const pills = [];
    pills.push(r.ok === true ? `<span class="pill green">可用 ${r.ms != null ? `${r.ms}ms` : ''}</span>`
      : r.ok === false ? `<span class="pill red">失败</span>` : `<span class="pill gray">待检</span>`);
    pills.push(`<span class="pill">${esc(cfg.mode)}</span>`);
    if (cfg.mode === 'saas') {
      pills.push(cfg.usePreferred === false
        ? '<span class="pill gray">不参与优选</span>'
        : '<span class="pill purple">参与优选</span>');
    }
    if (d.activeSide === 'backup') pills.push('<span class="pill amber">备侧接管</span>');
    if (d.fails > 0) pills.push(`<span class="pill amber">连续失败 ${d.fails}</span>`);
    const err = r.ok === false ? `<div class="kv"><span style="color:var(--red)">错误</span><b style="color:var(--red)">${esc((r.error || '').slice(0, 70))}</b></div>` : '';
    return `
    <div class="card">
      <h3>${esc(cfg.id)} ${pills.join(' ')}</h3>
      <div class="kv"><span>检测间隔</span><b>每 ${esc(cfg.check?.intervalSec ?? 300)} 秒</b></div>
      ${sideLine('主记录', d.primary, cfg.primary)}
      ${cfg.backup ? sideLine('备记录', d.backup, cfg.backup) : ''}
      ${err}
      <div class="kv"><span>最近检测</span><b>${ago(d.lastCheckAt)} ${r.code ? `· HTTP ${r.code} · TCP ${fmtMs(r.tcpMs)} · TLS ${fmtMs(r.tlsMs)}` : ''}</b></div>
      <div class="kv"><span>最近更新记录</span><b>${ago(d.lastUpdateAt)}</b></div>
      <div class="row" style="margin-top:8px">
        <button class="btn small" data-act="check" data-id="${esc(cfg.id)}">立即检测</button>
        <button class="btn small" data-act="sync" data-id="${esc(cfg.id)}">同步/应用优选IP</button>
        <button class="btn small" data-act="edit-domain" data-id="${esc(cfg.id)}">编辑</button>
      </div>
    </div>`;
  }).join('') || '<div class="sub">还没有域名,去「域名管理」添加</div>';

  const ips = S.state.ips || {};
  const best = ips.best || [];
  const need = S.state.ipNeeded || 0;
  $('#ip-best').innerHTML = best.length
    ? best.map((b, i) => `<span class="pill ${i < need ? 'green' : ''}">${esc(b.ip)} · ${b.ms}ms</span>`).join('')
    : '<span class="pill gray">暂无(等待测速)</span>';
  const parts = [];
  if (need > 0) parts.push(`需 ${need} 个不同 IP(按域名侧数)`);
  if (ips.poolSize) parts.push(`池 ${ips.poolSize} 个`);
  if (ips.testedAt) parts.push(`测速于 ${ago(ips.testedAt)}`);
  if (ips.lastError) parts.push(`错误: ${ips.lastError}`);
  $('#ip-meta').textContent = parts.join(' · ');
  const all = ips.all || [];
  $('#ip-all').innerHTML = all.length
    ? all.map((r) => `<div class="${r.ms == null ? 'bad' : ''}">${esc(r.ip)} — ${r.ms == null ? '超时' : `${r.ms}ms`}</div>`).join('')
    : '<div class="sub">无数据</div>';
}

/* ---------- 域名管理列表 ---------- */
function renderDomainList() {
  const live = new Map((S.state.domains || []).map((d) => [d.id, d]));
  const cfgs = S.state.domainCfgs || [];
  $('#domain-list').innerHTML = cfgs.map((cfg) => {
    const d = live.get(cfg.id) || {};
    const r = d.lastCheckResult || {};
    const statusPill = r.ok === true ? `<span class="pill green">可用 ${r.ms != null ? `${r.ms}ms` : ''}</span>`
      : r.ok === false ? '<span class="pill red">失败</span>' : '<span class="pill gray">待检</span>';
    const prefPill = cfg.mode === 'saas'
      ? (cfg.usePreferred === false ? '<span class="pill gray">不参与优选</span>' : '<span class="pill purple">参与优选</span>')
      : '';
    const primaryFq = fqdnOf(cfg.primary);
    const backupFq = cfg.backup ? fqdnOf(cfg.backup) : '';
    return `
    <div class="row-card ${cfg.enabled === false ? 'disabled' : ''}">
      <div class="row-main">
        <div class="row-title">
          ${esc(cfg.id)} ${statusPill} <span class="pill">${esc(cfg.mode)}</span> ${prefPill}
        </div>
        <div class="row-meta">
          主: ${esc(cfg.primary.provider)} · ${esc(primaryFq)} · ${esc(cfg.primary.type)} · TTL ${cfg.primary.ttl}
          ${cfg.backup ? `<br>备: ${esc(cfg.backup.provider)} · ${esc(backupFq)} · ${esc(cfg.backup.type)} · TTL ${cfg.backup.ttl}` : ''}
          <br>检测每 ${cfg.check.intervalSec}s · 阈值 ${cfg.check.failThreshold} 次 · ${esc((cfg.check.urls || []).join(', '))}
        </div>
      </div>
      <div class="row-actions">
        <label class="switch"><input type="checkbox" data-act="toggle-domain" data-id="${esc(cfg.id)}" ${cfg.enabled !== false ? 'checked' : ''}> 启用</label>
        <button class="btn small" data-act="check" data-id="${esc(cfg.id)}">立即检测</button>
        <button class="btn small" data-act="edit-domain" data-id="${esc(cfg.id)}">编辑</button>
        <button class="btn small danger" data-act="del-domain" data-id="${esc(cfg.id)}">删除</button>
      </div>
    </div>`;
  }).join('') || '<div class="sub">还没有域名,点右上角「+ 添加域名」</div>';
}

/* ---------- 服务商列表 ---------- */
function renderProviderList() {
  const provs = S.state.providers || [];
  const usedCount = (name) => (S.state.domainCfgs || []).filter(
    (d) => d.primary?.provider === name || d.backup?.provider === name,
  ).length;
  $('#provider-list').innerHTML = provs.map((p) => {
    const v = p.verify || {};
    const vp = v.ok === true ? '<span class="pill green">连接正常</span>'
      : v.ok === false ? `<span class="pill red">${esc((v.lastError || '异常').slice(0, 40))}</span>`
      : '<span class="pill gray">未验证</span>';
    return `
    <div class="row-card ${p.enabled === false ? 'disabled' : ''}">
      <div class="row-main">
        <div class="row-title">${esc(p.name)} <span class="pill ${p.type === 'dnshe' ? 'blue' : 'amber'}">${esc(p.type)}</span> ${vp}</div>
        <div class="row-meta">被 ${usedCount(p.name)} 个域名使用 · 验证于 ${v.lastVerifyAt ? ago(v.lastVerifyAt) : '从未'}</div>
      </div>
      <div class="row-actions">
        <label class="switch"><input type="checkbox" data-act="toggle-provider" data-name="${esc(p.name)}" ${p.enabled !== false ? 'checked' : ''}> 启用</label>
        <button class="btn small" data-act="verify-provider" data-name="${esc(p.name)}" ${p.enabled === false ? 'disabled' : ''}>测试连通</button>
        <button class="btn small" data-act="edit-provider" data-name="${esc(p.name)}">编辑</button>
        <button class="btn small danger" data-act="del-provider" data-name="${esc(p.name)}">删除</button>
      </div>
    </div>`;
  }).join('') || '<div class="sub">还没有服务商,点右上角「+ 添加服务商」</div>';
}

/* ---------- 模态框:域名表单 ---------- */
const TTL_OPTIONS = [1, 60, 120, 300, 600, 1800, 3600, 86400];
const ttlOptionsHtml = (cur) => TTL_OPTIONS.map((v) =>
  `<option value="${v}" ${Number(cur) === v ? 'selected' : ''}>${v === 1 ? '自动 (Auto)' : `${v} 秒`}</option>`).join('');

function sideFieldsHtml(prefix, side) {
  const provs = (S.state.providers || []).map((p) =>
    `<option value="${esc(p.name)}" ${side?.provider === p.name ? 'selected' : ''}>${esc(p.name)} (${esc(p.type)})${p.enabled === false ? ' [已禁用]' : ''}</option>`,
  ).join('') || '<option value="">(还没有服务商,请先添加)</option>';
  const target = side?.zone || side?.subdomain || '';
  const ttl = side?.ttl ?? 600;
  return `
    <div class="field"><label>服务商</label><select id="${prefix}-provider">${provs}</select></div>
    <div class="field"><label>区域 / 子域名</label>
      <div><input type="text" id="${prefix}-target" value="${esc(target)}" placeholder="Cloudflare 填 zone / DNSHE 填子域名">
      <div class="hint" id="${prefix}-target-hint"></div></div>
    </div>
    <div class="field"><label>记录名</label><input type="text" id="${prefix}-name" value="${esc(side?.name ?? '*')}" placeholder="* 表示通配符,@ 表示主名"></div>
    <div class="field"><label>记录类型</label><select id="${prefix}-type">${['A', 'AAAA', 'CNAME'].map((t) => `<option ${side?.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
    <div class="field"><label>TTL</label><select id="${prefix}-ttl">${ttlOptionsHtml(ttl)}</select></div>
    <div class="field cf-only"><label>Cloudflare 代理</label><label class="switch"><input type="checkbox" id="${prefix}-proxied" ${side?.proxied ? 'checked' : ''}> 开启橙云</label></div>
    <div class="field only-static"><label>固定值</label><input type="text" id="${prefix}-values" value="${esc((side?.values || []).join(','))}" placeholder="多个值用逗号分隔,如 1.1.1.1,2.2.2.2"></div>`;
}

function openDomainModal(id) {
  const cfg = id ? (S.state.domainCfgs || []).find((d) => d.id === id) : null;
  S.modal = { kind: 'domain', mode: cfg ? 'edit' : 'create', id: id || null };
  const d = cfg || { mode: 'saas', enabled: true, usePreferred: true, primary: { provider: (S.state.providers[0] || {}).name, name: '*', type: 'A', ttl: 600 }, check: { urls: [], expectStatus: [200, 301, 302, 401], intervalSec: 300, failThreshold: 3, timeoutMs: 8000 } };
  $('#modal-title').textContent = cfg ? `编辑域名 · ${cfg.id}` : '添加域名';
  $('#modal-body').innerHTML = `
    <fieldset>
      <legend>基本信息</legend>
      <div class="field"><label>域名 ID</label><input type="text" id="d-id" value="${esc(d.id || '')}" ${cfg ? 'readonly' : ''} placeholder="如 lsky(唯一标识)"></div>
      <div class="field"><label>工作模式</label>
        <select id="d-mode">
          <option value="saas" ${d.mode === 'saas' ? 'selected' : ''}>saas — 从优选池分配 IP(推荐)</option>
          <option value="ddns" ${d.mode === 'ddns' ? 'selected' : ''}>ddns — 跟随本机公网 IP</option>
          <option value="static" ${d.mode === 'static' ? 'selected' : ''}>static — 固定记录值</option>
        </select>
      </div>
      <div class="field"><label>启用</label><label class="switch"><input type="checkbox" id="d-enabled" ${d.enabled !== false ? 'checked' : ''}> 启用该域名调度</label></div>
      <div class="field only-saas"><label>参与优选IP分配</label><label class="switch"><input type="checkbox" id="d-usepref" ${d.usePreferred !== false ? 'checked' : ''}> 由优选池自动分配(多个域名各占不同 IP)</label></div>
    </fieldset>
    <fieldset><legend>主侧记录</legend>${sideFieldsHtml('p', d.primary)}</fieldset>
    <fieldset>
      <legend>备侧记录(互备,可选)</legend>
      <div class="field"><label>启用备侧</label><label class="switch"><input type="checkbox" id="d-backup-enabled" ${d.backup ? 'checked' : ''}> 启用互备(不同服务商)</label></div>
      <div id="backup-wrap" class="${d.backup ? '' : 'hidden'}">${sideFieldsHtml('b', d.backup || { provider: (S.state.providers[0] || {}).name, name: '*', type: 'A', ttl: 600 })}</div>
    </fieldset>
    <fieldset>
      <legend>检测设置</legend>
      <div class="field"><label>检测地址</label><div><textarea id="d-urls" placeholder="每行一个,如 https://lsky.example.net/">${esc((d.check?.urls || []).join('\n'))}</textarea><div class="hint">所有地址都通过才判定可用</div></div></div>
      <div class="field"><label>期望状态码</label><input type="text" id="d-status" value="${esc((d.check?.expectStatus || [200, 301, 302, 401]).join(','))}" placeholder="200,301,302,401"></div>
      <div class="field"><label>检测间隔(秒)</label><input type="number" id="d-interval" min="10" value="${esc(d.check?.intervalSec ?? 300)}"><div class="hint" style="grid-column:2">10~86400,建议 300</div></div>
      <div class="field"><label>连续失败阈值</label><input type="number" id="d-threshold" min="1" value="${esc(d.check?.failThreshold ?? 3)}"><div class="hint" style="grid-column:2">达到次数后触发:优选IP替换 → 互备切换 → 告警</div></div>
      <div class="field"><label>超时(毫秒)</label><input type="number" id="d-timeout" min="1000" value="${esc(d.check?.timeoutMs ?? 8000)}"></div>
    </fieldset>`;
  bindModalDynamics();
  $('#modal').classList.remove('hidden');
}

function openProviderModal(name) {
  const p = name ? (S.state.providers || []).find((x) => x.name === name) : null;
  S.modal = { kind: 'provider', mode: p ? 'edit' : 'create', name: name || null };
  $('#modal-title').textContent = p ? `编辑服务商 · ${p.name}` : '添加服务商';
  const type = p?.type || 'cloudflare';
  $('#modal-body').innerHTML = `
    <fieldset>
      <legend>基本信息</legend>
      <div class="field"><label>名称</label><input type="text" id="pv-name" value="${esc(p?.name || '')}" ${p ? 'readonly' : ''} placeholder="如 cf-main"></div>
      <div class="field"><label>类型</label>${p
        ? `<b>${esc(p.type)}</b>`
        : `<select id="pv-type"><option value="cloudflare">Cloudflare(API Token)</option><option value="dnshe">DNSHE(API Key 密钥对)</option></select>`}
      </div>
      <div class="field"><label>启用</label><label class="switch"><input type="checkbox" id="pv-enabled" ${p?.enabled !== false ? 'checked' : ''}> 启用该服务商</label></div>
    </fieldset>
    <fieldset class="pv-cf"><legend>Cloudflare</legend>
      <div class="field"><label>API Token</label><input type="password" id="pv-token" placeholder="${p ? '(留空保持不变)' : 'Zone.DNS Edit 权限的 Token'}"></div>
      <div class="field"><label>API 地址</label><input type="text" id="pv-apibase-cf" value="${esc(p?.type === 'cloudflare' ? (p.apiBase || 'https://api.cloudflare.com/client/v4') : 'https://api.cloudflare.com/client/v4')}"></div>
    </fieldset>
    <fieldset class="pv-dnshe"><legend>DNSHE</legend>
      <div class="field"><label>X-API-Key</label><input type="text" id="pv-apikey" placeholder="${p ? '(留空保持不变)' : 'cfsd_ 开头的 Key'}"></div>
      <div class="field"><label>X-API-Secret</label><input type="password" id="pv-apisecret" placeholder="${p ? '(留空保持不变)' : '只显示一次的 Secret'}"></div>
      <div class="field"><label>API 地址</label><input type="text" id="pv-apibase-dnshe" value="${esc(p?.type === 'dnshe' ? (p.apiBase || 'https://api005.dnshe.com') : 'https://api005.dnshe.com')}"></div>
    </fieldset>`;
  $('#pv-type')?.addEventListener('change', updateProviderTypeFields);
  updateProviderTypeFields();
  $('#modal').classList.remove('hidden');
}

function updateProviderTypeFields() {
  // 新建:读类型下拉;编辑:下拉不存在,用当前服务商的类型
  let type = 'cloudflare';
  const sel = $('#pv-type');
  if (sel) {
    type = sel.value;
  } else if (S.modal?.kind === 'provider') {
    const p = (S.state.providers || []).find((x) => x.name === S.modal.name);
    type = p?.type || 'cloudflare';
  }
  $('.pv-cf')?.classList.toggle('hidden', type !== 'cloudflare');
  $('.pv-dnshe')?.classList.toggle('hidden', type !== 'dnshe');
}

function bindModalDynamics() {
  const mode = $('#d-mode');
  const applyMode = () => {
    const m = mode.value;
    $$('.only-saas').forEach((el) => el.classList.toggle('hidden', m !== 'saas'));
    $$('.only-static').forEach((el) => el.classList.toggle('hidden', m !== 'static'));
  };
  mode.addEventListener('change', applyMode);
  applyMode();

  $('#d-backup-enabled').addEventListener('change', (e) => {
    $('#backup-wrap').classList.toggle('hidden', !e.target.checked);
  });

  ['p', 'b'].forEach((prefix) => {
    const sel = $(`#${prefix}-provider`);
    if (!sel) return;
    const apply = () => {
      const prov = (S.state.providers || []).find((p) => p.name === sel.value);
      const type = prov?.type || 'cloudflare';
      const hint = $(`#${prefix}-target-hint`);
      if (hint) hint.textContent = type === 'cloudflare' ? '填 Cloudflare Zone,如 example.net' : '填 DNSHE 子域名,如 example.com';
      $(`#${prefix}-proxied`)?.closest('.cf-only')?.classList.toggle('hidden', type !== 'cloudflare');
    };
    sel.addEventListener('change', apply);
    apply();
  });
}

/* ---------- 表单收集与保存 ---------- */
function collectSide(prefix) {
  const provider = $(`#${prefix}-provider`)?.value || '';
  const prov = (S.state.providers || []).find((p) => p.name === provider);
  const side = {
    provider,
    name: ($(`#${prefix}-name`)?.value || '').trim() || '@',
    type: $(`#${prefix}-type`)?.value || 'A',
    ttl: Number($(`#${prefix}-ttl`)?.value) || 600,
    proxied: $(`#${prefix}-proxied`)?.checked || false,
  };
  const target = ($(`#${prefix}-target`)?.value || '').trim();
  if (prov?.type === 'dnshe') side.subdomain = target; else side.zone = target;
  if ($('#d-mode')?.value === 'static') {
    side.values = ($(`#${prefix}-values`)?.value || '').split(/[,，\s]+/).filter(Boolean);
  }
  return side;
}

async function saveModal() {
  if (!S.modal) return;
  if (S.modal.kind === 'domain') {
    const body = {
      id: ($('#d-id')?.value || '').trim(),
      mode: $('#d-mode').value,
      enabled: $('#d-enabled').checked,
      usePreferred: $('#d-usepref')?.checked !== false,
      primary: collectSide('p'),
      check: {
        urls: ($('#d-urls')?.value || '').split('\n').map((s) => s.trim()).filter(Boolean),
        expectStatus: ($('#d-status')?.value || '').split(/[,，\s]+/).map(Number).filter(Number.isInteger),
        intervalSec: Number($('#d-interval')?.value) || 300,
        failThreshold: Number($('#d-threshold')?.value) || 3,
        timeoutMs: Number($('#d-timeout')?.value) || 8000,
        followRedirects: true,
        method: 'GET',
      },
    };
    if (!body.id) throw new Error('请填写域名 ID');
    if (!body.primary.zone && !body.primary.subdomain) throw new Error('请填写区域 / 子域名');
    if (body.backup || $('#d-backup-enabled')?.checked) {
      if ($('#d-backup-enabled')?.checked) body.backup = collectSide('b');
    }
    const create = S.modal.mode === 'create';
    const res = await api(create ? '/api/domains' : `/api/domains/${encodeURIComponent(S.modal.id)}`, {
      method: create ? 'POST' : 'PUT',
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(res.error || '保存失败');
    toast(res.msg || '已保存', 'ok');
  } else {
    const type = $('#pv-type')?.value || (S.state.providers.find((x) => x.name === S.modal.name) || {}).type;
    const body = {
      name: ($('#pv-name')?.value || '').trim(),
      type,
      enabled: $('#pv-enabled').checked,
    };
    if (type === 'cloudflare') {
      body.token = $('#pv-token')?.value || '';
      body.apiBase = $('#pv-apibase-cf')?.value || undefined;
    } else {
      body.apiKey = $('#pv-apikey')?.value || '';
      body.apiSecret = $('#pv-apisecret')?.value || '';
      body.apiBase = $('#pv-apibase-dnshe')?.value || undefined;
    }
    const create = S.modal.mode === 'create';
    if (!create) body.name = S.modal.name;
    const res = await api(create ? '/api/providers' : `/api/providers/${encodeURIComponent(S.modal.name)}`, {
      method: create ? 'POST' : 'PUT',
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(res.error || '保存失败');
    toast(res.msg || '已保存', 'ok');
  }
  closeModal();
  await refreshState();
}

function closeModal() {
  $('#modal').classList.add('hidden');
  S.modal = null;
}

/* ---------- 日志 ---------- */
async function fetchLogs() {
  try {
    const data = await api('/api/logs?n=300');
    const el = $('#logs');
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
    el.textContent = (data.logs || []).map((l) => `[${l.time}] [${l.level.toUpperCase()}] ${l.msg}`).join('\n');
    if (atBottom) el.scrollTop = el.scrollHeight;
  } catch { /* ignore */ }
}

/* ---------- 事件 ---------- */
function switchTab(tab) {
  S.tab = tab;
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${tab}`));
  if (tab === 'advanced' && !S.yamlLoaded) loadYaml();
  if (tab === 'logs') fetchLogs();
  renderAll();
}

async function loadYaml() {
  try {
    const cfg = await api('/api/config');
    $('#config-yaml').value = cfg.yaml;
    S.yamlLoaded = true;
  } catch { /* ignore */ }
}

function bindEvents() {
  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn) switchTab(btn.dataset.tab);
  });

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'check' || act === 'sync') {
      const id = el.dataset.id;
      await withBtn(el, '检测中…', async () => {
        try {
          const r = await api(`/api/domain/${encodeURIComponent(id)}/check`, { method: 'POST', body: '{}' });
          const res = r.result || {};
          toast(res.ok ? `✓ ${id} 可用 ${res.ms != null ? res.ms + 'ms' : ''}` : `✗ ${id} 失败: ${(res.error || '未知错误').slice(0, 80)}`, res.ok ? 'ok' : 'err');
        } catch (err) {
          toast(`${id}: ${err.message}`, 'err');
        }
        await refreshState();
      });
    } else if (act === 'edit-domain') {
      openDomainModal(el.dataset.id);
    } else if (act === 'del-domain') {
      const id = el.dataset.id;
      if (!confirm(`确定删除域名 ${id}?`)) return;
      await withBtn(el, '删除中…', async () => {
        const r = await api(`/api/domains/${encodeURIComponent(id)}`, { method: 'DELETE', body: '{}' });
        toast(r.ok ? r.msg : r.error, r.ok ? 'ok' : 'err');
        await refreshState();
      });
    } else if (act === 'edit-provider') {
      openProviderModal(el.dataset.name);
    } else if (act === 'del-provider') {
      const name = el.dataset.name;
      if (!confirm(`确定删除服务商 ${name}?`)) return;
      await withBtn(el, '删除中…', async () => {
        const r = await api(`/api/providers/${encodeURIComponent(name)}`, { method: 'DELETE', body: '{}' });
        toast(r.ok ? r.msg : r.error, r.ok ? 'ok' : 'err');
        await refreshState();
      });
    } else if (act === 'verify-provider') {
      const name = el.dataset.name;
      await withBtn(el, '验证中…', async () => {
        const r = await api(`/api/provider/${encodeURIComponent(name)}/verify`, { method: 'POST', body: '{}' });
        toast(r.ok ? `✓ ${name}: ${r.msg}` : `✗ ${name}: ${r.msg}`, r.ok ? 'ok' : 'err');
        await refreshState();
      });
    }
  });

  document.addEventListener('change', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    // 启用/禁用开关
    const act = el.dataset.act;
    if (act === 'toggle-domain') {
      const id = el.dataset.id;
      const cfg = (S.state.domainCfgs || []).find((d) => d.id === id);
      if (!cfg) return;
      const body = { ...cfg, enabled: el.checked };
      const r = await api(`/api/domains/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) });
      toast(r.ok ? `${id} 已${el.checked ? '启用' : '禁用'}` : r.error, r.ok ? 'ok' : 'err');
      await refreshState();
    } else if (act === 'toggle-provider') {
      const name = el.dataset.name;
      const r = await api(`/api/providers/${encodeURIComponent(name)}`, {
        method: 'PUT', body: JSON.stringify({ name, enabled: el.checked }),
      });
      toast(r.ok ? `${name} 已${el.checked ? '启用' : '禁用'}` : r.error, r.ok ? 'ok' : 'err');
      await refreshState();
    }
  });

  $('#btn-add-domain').addEventListener('click', () => openDomainModal(null));
  $('#btn-add-provider').addEventListener('click', () => openProviderModal(null));
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  $('#modal-save').addEventListener('click', (e) => withBtn(e.target, '保存中…', async () => {
    try { await saveModal(); } catch (err) { toast(err.message, 'err'); throw err; }
  }));

  $('#btn-test-ip').addEventListener('click', (e) => withBtn(e.target, '测速中…', async () => {
    toast('开始测速并同步所有参与优选的域名…');
    const r = await api('/api/ip/test', { method: 'POST', body: '{}' });
    toast(r.ok ? '✓ 测速完成,已同步' : r.error, r.ok ? 'ok' : 'err');
    await refreshState();
  }));

  $('#btn-check-all').addEventListener('click', (e) => withBtn(e.target, '检测中…', async () => {
    const ids = (S.state.domainCfgs || []).filter((d) => d.enabled !== false).map((d) => d.id);
    let okN = 0, failN = 0;
    for (let i = 0; i < ids.length; i++) {
      try {
        const r = await api(`/api/domain/${encodeURIComponent(ids[i])}/check`, { method: 'POST', body: '{}' });
        if (r.result?.ok) okN++; else failN++;
      } catch { failN++; }
      e.target.textContent = `检测中… ${i + 1}/${ids.length}`;
    }
    toast(`检测完成:${okN} 个可用,${failN} 个失败`, failN ? 'err' : 'ok');
    await refreshState();
  }));

  $('#btn-save-config').addEventListener('click', async () => {
    try {
      const r = await api('/api/config', { method: 'POST', body: JSON.stringify({ yaml: $('#config-yaml').value }) });
      toast('配置已保存并热重载', 'ok');
      S.yamlLoaded = false;
      await refreshState();
    } catch (err) {
      toast('保存失败: ' + err.message, 'err');
    }
  });
  $('#btn-reload-config').addEventListener('click', () => { S.yamlLoaded = false; loadYaml(); });

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-err').textContent = '';
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#login-pwd').value }) });
      S.yamlLoaded = false;
      await refreshState();
    } catch {
      $('#login-err').textContent = '密码错误';
    }
  });

  $('#logout-btn').addEventListener('click', () => location.reload());
}

/* ---------- 启动 ---------- */
async function boot() {
  bindEvents();
  await refreshState();
  if (!S.state) {
    // 可能 401,等待登录
    $('#login-mask').classList.remove('hidden');
  }
  setInterval(async () => {
    await refreshState();
    if (S.tab === 'logs') fetchLogs();
  }, 5000);
}

boot();
