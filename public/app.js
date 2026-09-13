/* 物料管家 · 前端逻辑 v3（卡片流 · 明亮主题） */
'use strict';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
};

/* ---------- 访问口令（服务端启用 PI_TOKEN 时自动流转） ---------- */
let apiToken = localStorage.getItem('pi_token') || '';
function setApiToken(t) {
  apiToken = String(t || '').trim();
  if (apiToken) localStorage.setItem('pi_token', apiToken);
  else localStorage.removeItem('pi_token');
}
function mediaUrl(u) {
  const s = safeUrl(u);
  if (!s) return null;
  return apiToken ? s + (s.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(apiToken) : s;
}
let askingToken = null;
function askToken() {
  if (askingToken) return askingToken;
  askingToken = new Promise((resolve) => {
    showModal((root) => {
      root.classList.add('confirm-box');
      const head = modalHead('访问口令');
      const body = el('div', 'modal-body');
      body.appendChild(el('div', 'confirm-msg', '本系统已开启访问口令保护，请输入口令（将保存在本设备浏览器中）。'));
      const pad = el('div', 'stock-pad');
      const inp = document.createElement('input');
      inp.type = 'password';
      inp.className = 'q-reason';
      inp.placeholder = '访问口令';
      pad.appendChild(inp);
      body.appendChild(pad);
      const foot = el('div', 'form-foot');
      const ok = el('button', 'btn primary', '确认');
      ok.onclick = () => {
        setApiToken(inp.value.trim());
        closeModal();
        resolve();
      };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok.click(); });
      foot.appendChild(ok);
      body.appendChild(foot);
      root.append(head, body);
      setTimeout(() => inp.focus(), 40);
    });
    const done = () => { askingToken = null; };
    askingToken.then(done, done);
    return askingToken;
  });
}

/* ---------- API 封装 ---------- */
async function api(path, opts = {}) {
  const doFetch = () => {
    const headers = { ...(opts.headers || {}) };
    if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    if (apiToken) headers['x-token'] = apiToken;
    return fetch(path, { ...opts, headers });
  };
  let res = await doFetch();
  if (res.status === 401) {
    let errData = null;
    try { errData = await res.clone().json(); } catch { /* ignore */ }
    if (errData && errData.code === 'TOKEN_REQUIRED') {
      await askToken();
      res = await doFetch(); // 口令到手，重试一次
    }
  }
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) throw new Error((data && data.error) || `请求失败 (HTTP ${res.status})`);
  return data;
}
const apiGet = (p) => api(p);
const apiJson = (p, method, body) => api(p, { method, body: JSON.stringify(body) });

function toast(msg, type = '') {
  const t = el('div', 'toast ' + type, msg);
  $('#toastWrap').appendChild(t);
  setTimeout(() => t.remove(), 3400);
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function safeUrl(u) {
  const s = String(u || '');
  return (s.startsWith('/photos/') || /^https?:\/\//i.test(s)) ? s : null;
}
/* 分类 → 渐变配色的方块图标 */
const PALETTE = [
  ['#3d7bff', '#0fb5ef'], ['#7c5cff', '#b060ff'], ['#0e9fbf', '#31d3c8'],
  ['#f29d12', '#f7684b'], ['#10a469', '#41d18f'], ['#ec4f92', '#ff8ab0'], ['#5a6cf3', '#8ea0ff']
];
function hashOf(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) >>> 0; return h; }
function tileGradient(category) {
  const cat = category || '';
  return PALETTE[hashOf(cat) % PALETTE.length];
}
function glyphOf(category) {
  const cat = String(category || '').trim();
  return cat ? Array.from(cat)[0] : '◈';
}
function tileEl(category, cls = 'mt-tile') {
  const [a, b] = tileGradient(category);
  const d = el('div', cls, glyphOf(category));
  d.style.background = `linear-gradient(135deg, ${a}, ${b})`;
  return d;
}
function photoOrTile(m, cls = 'mt-photo', tileCls = 'mt-tile') {
  const u = mediaUrl(m.photo);
  if (u) {
    const img = el('img');
    img.className = cls;
    img.src = u;
    img.loading = 'lazy';
    img.onerror = () => img.replaceWith(tileEl(m.category, tileCls));
    return img;
  }
  return tileEl(m.category, tileCls);
}
function pill(text, kind) {
  const p = el('span', 'pill ' + (kind || ''), text);
  return p;
}
/* 价格文本：小数值保留更多位，带币种符号 */
function moneyText(p, cur) {
  const n = Number(p);
  if (p == null || p === '' || !Number.isFinite(n) || n <= 0) return '';
  const s = n < 0.1 ? String(parseFloat(n.toFixed(5))) : n.toFixed(2).replace(/\.00$/, '');
  const sym = cur === 'CNY' ? '¥' : cur === 'USD' ? '$' : cur === 'HKD' ? 'HK$' : (cur ? cur + ' ' : '');
  return sym + s;
}
/* 立创参考价 → 人民币折算文本（带原始美元提示） */
function refCnyText(m) {
  const n = Number(m.lcsc_price);
  if (m.lcsc_price == null || !Number.isFinite(n) || n <= 0) return null;
  const cur = String(m.lcsc_currency || 'USD').toUpperCase();
  if (cur === 'CNY') return { main: '¥' + parseFloat(n.toFixed(4)), tip: '立创参考价' };
  if (cur === 'USD') {
    const cny = n * (Number(state.fx.usdCny) || 7.1);
    return {
      main: '≈¥' + parseFloat(cny.toFixed(4)),
      tip: `立创参考价 $${parseFloat(n.toFixed(5))} × 汇率 ${state.fx.usdCny}${state.fx.source === 'live' ? '' : '（兜底汇率）'}`
    };
  }
  return { main: moneyText(n, cur), tip: '立创参考价' };
}

/* ---------- 状态 ---------- */
const state = {
  rows: [], total: 0,
  q: '', category: '', status: '',
  facets: { brand: '', package: '', location: '', attrs: {} },
  detailId: null,
  aiSession: null, pendingAttach: null, config: null,
  fx: { usdCny: 7.1, source: 'fallback' }
};
function clearFacets() {
  state.facets = { brand: '', package: '', location: '', attrs: {} };
}
function hasFacets() {
  const f = state.facets;
  return !!(f.brand || f.package || f.location || Object.keys(f.attrs).length);
}
/** 组装筛选参数（供 materials 与 facets 接口共用） */
function filterParams() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.category) p.set('category', state.category);
  if (state.status) p.set('status', state.status);
  const f = state.facets;
  if (f.brand) p.set('brand', f.brand);
  if (f.package) p.set('package', f.package);
  if (f.location) p.set('location', f.location);
  const ae = Object.entries(f.attrs);
  if (ae.length) p.set('attrs', JSON.stringify(Object.fromEntries(ae)));
  return p;
}

/* ================= 统计 + 筛选 ================= */
async function loadStats() {
  const s = await apiGet('/api/stats');
  $('#stTotal').textContent = s.total;
  $('#stQty').textContent = s.totalQty.toLocaleString();
  $('#stLow').textContent = s.lowCount;
  $('#stOut').textContent = s.outCount;
  buildChips(s.categories);
}
function buildChips(cats) {
  const box = $('#catChips');
  box.textContent = '';
  const mk = (label, val) => {
    const b = el('button', 'cat-chip' + (state.category === val ? ' on' : ''), label);
    b.onclick = () => { state.category = val; clearFacets(); refreshChips(); loadList(); };
    box.appendChild(b);
  };
  mk('全部', '');
  for (const c of cats) mk(c, c);
}
function refreshChips() {
  for (const b of $('#catChips').children) b.classList.toggle('on', b.textContent === (state.category || '全部'));
}
function setStatus(status) {
  state.status = status;
  document.querySelectorAll('#segStatus button').forEach((b) => b.classList.toggle('on', b.dataset.status === status));
}
$('#segStatus').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-status]');
  if (!b) return;
  setStatus(b.dataset.status);
  loadList();
});
document.querySelectorAll('.sum-card').forEach((card) => {
  card.addEventListener('click', () => {
    const go = card.dataset.go || 'all';
    setStatus(go === 'low' ? 'low' : go === 'out' ? 'out' : '');
    resetFilters({ keepStatus: true });
    scrollCards();
    loadList();
  });
});
function scrollCards() {
  const y = ($('#summary').getBoundingClientRect().top + window.pageYOffset - 90);
  window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
}

/* ================= 列表加载 + 卡片渲染 ================= */
const RENDER_STEP = 80; // 分页懒渲染：先渲染 80 张，点按钮/滚到底继续
let renderLimit = RENDER_STEP;
async function loadList() {
  renderLimit = RENDER_STEP;
  const data = await apiGet('/api/materials?' + filterParams().toString() + '&size=500');
  state.rows = data.rows;
  state.total = data.total;
  renderCards();
  loadFacets();
}
/* 动态细化筛选（facet） */
let facetToken = 0;
async function loadFacets() {
  const my = ++facetToken;
  try {
    const f = await apiGet('/api/facets?' + filterParams().toString());
    if (my !== facetToken) return; // 已有更新的请求，丢弃旧结果
    renderFacetBar(f);
  } catch { /* facet 加载失败不影响列表 */ }
}
function renderFacetBar(f) {
  const bar = $('#facetBar');
  bar.textContent = '';
  const groups = [
    { key: 'brand', label: '品牌', items: f.brand, cur: state.facets.brand },
    { key: 'package', label: '封装', items: f.package, cur: state.facets.package },
    { key: 'location', label: '位置', items: f.location, cur: state.facets.location }
  ];
  for (const [k, items] of Object.entries(f.attrs || {})) {
    groups.push({ key: 'attr:' + k, label: k, items, cur: state.facets.attrs[k] });
  }
  const usable = groups.filter((g) => g.items && g.items.length && (g.items.length > 1 || g.cur));
  if (!usable.length && !hasFacets()) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');

  const row = el('div', 'facet-row');
  const mkSelect = (g) => {
    const sel = document.createElement('select');
    sel.className = 'f-select' + (g.cur ? ' on' : '');
    sel.title = '按' + g.label + '筛选';
    const all = el('option', null, g.label + '：全部');
    all.value = '';
    sel.appendChild(all);
    for (const it of g.items) {
      const o = el('option', null, `${it.v}${it.n ? '（' + it.n + '）' : ''}`);
      o.value = it.v;
      sel.appendChild(o);
    }
    sel.value = g.cur || '';
    if (g.cur && sel.value !== g.cur) { // 当前选中值不在选项列表（条件叠加导致）——补进去
      const o = el('option', null, g.cur);
      o.value = g.cur;
      sel.insertBefore(o, sel.options[1]);
      sel.value = g.cur;
    }
    sel.onchange = () => setFacet(g.key, sel.value);
    return sel;
  };
  for (const g of usable) row.appendChild(mkSelect(g));
  bar.appendChild(row);
  if (hasFacets()) {
    const clr = el('button', 'f-clear', '✕ 清除全部细选');
    clr.onclick = () => { clearFacets(); loadList(); };
    bar.appendChild(clr);
  }
}
function setFacet(key, val) {
  if (key.startsWith('attr:')) {
    const k = key.slice(5);
    if (val) state.facets.attrs[k] = val;
    else delete state.facets.attrs[k];
  } else {
    state.facets[key] = val || '';
  }
  loadList();
}
function renderCards() {
  const feed = $('#cardFeed');
  feed.textContent = '';
  const filtered = !!(state.q || state.category || state.status);
  $('#emptyState').classList.toggle('hidden', state.rows.length > 0);
  if (!state.rows.length) {
    $('#emptyText').textContent = filtered
      ? '没有符合筛选条件的物料。可调整搜索词，或在下方「细选」里点"清除全部细选"。'
      : '还没有物料：点右上角「＋ 新增物料」，或右下角 ✦ 让 AI 建档。';
  }
  const hint = $('#countHint');
  hint.textContent = '';
  hint.append(el('b', null, String(state.total)), ' 种物料');
  const shown = state.rows.slice(0, renderLimit);
  for (const m of shown) feed.appendChild(cardEl(m));
  if (state.rows.length > shown.length) {
    const more = el('button', 'more-btn', `加载更多（还有 ${state.rows.length - shown.length} 个）`);
    more.onclick = () => { renderLimit += RENDER_STEP; renderCards(); };
    feed.appendChild(more);
  }
}
function cardEl(m) {
  const card = el('div', 'mcard' + (m.out ? ' is-out' : m.low ? ' is-low' : ''));

  const top = el('div', 'mcard-top');
  top.appendChild(photoOrTile(m));
  const main = el('div', 'mt-main');
  main.appendChild(el('div', 'mt-name', m.name || m.model || '未命名物料'));
  if (m.model) main.appendChild(el('div', 'mt-model', m.model));
  const tags = el('div', 'mt-tags');
  tags.appendChild(pill(m.category || '未分类', 'cat'));
  if (m.package) tags.appendChild(pill(m.package, 'pkg'));
  if (m.brand) tags.appendChild(pill(m.brand, 'brand'));
  if (m.lcsc_code) {
    const c = pill(m.lcsc_code, 'lcsc');
    if (m.lcsc_url) c.onclick = (ev) => { ev.stopPropagation(); window.open(m.lcsc_url, '_blank'); };
    tags.appendChild(c);
  }
  main.appendChild(tags);
  top.appendChild(main);
  card.appendChild(top);

  if (m.spec || (m.attributes && Object.keys(m.attributes).length)) {
    const spec = m.spec || Object.keys(m.attributes).slice(0, 3).map((k) => `${k} ${m.attributes[k]}`).join(' · ');
    card.appendChild(el('div', 'mt-spec', spec));
  }

  const sr = el('div', 'mt-stockrow');
  const box = el('div', 'stock-box');
  box.appendChild(el('span', 'stock-num' + (m.out ? ' out' : m.low ? ' low' : ''), String(m.stock)));
  box.appendChild(el('span', 'stock-unit', m.unit || '个'));
  sr.appendChild(box);
  const priceTxt = moneyText(m.price, m.currency);
  if (priceTxt) {
    const pe = el('span', 'mt-price', priceTxt);
    pe.title = '来料价（你自己登记的采购价）';
    sr.appendChild(pe);
  }
  const ref = refCnyText(m);
  if (ref) {
    const re2 = el('span', 'mt-refprice', ref.main);
    re2.title = ref.tip;
    sr.appendChild(re2);
    if (!priceTxt) re2.classList.add('alone');
  }
  const note = el('span', 'stock-note');
  if (m.out) note.textContent = '已缺货';
  else if (m.low) note.textContent = `低于预警 ${m.min_stock}`;
  else if (m.min_stock > 0) note.textContent = `预警 ${m.min_stock}`;
  if (note.textContent) sr.appendChild(note);
  card.appendChild(sr);

  if (m.location) {
    const loc = el('div', 'mt-loc', '📍 ' + m.location);
    card.appendChild(loc);
  }

  const acts = el('div', 'mcard-acts');
  acts.appendChild(btnCard('＋ 入库', 'in', () => quickStock(m, 1)));
  acts.appendChild(btnCard('－ 出库', 'out', () => quickStock(m, -1)));
  acts.appendChild(btnCard('详情', 'ghost', () => openMaterial(m.id)));
  card.appendChild(acts);

  card.onclick = () => openMaterial(m.id);
  return card;
}
function btnCard(txt, kind, fn) {
  const b = el('button', 'qbtn ' + kind, txt);
  b.onclick = (e) => { e.stopPropagation(); fn(); };
  return b;
}

/* 顶部搜索 / 品牌复位 */
let searchTimer = null;
$('#inpSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = $('#inpSearch').value.trim(); clearFacets(); loadList(); }, 200);
});
function resetFilters({ keepStatus = false } = {}) {
  state.q = ''; state.category = '';
  clearFacets();
  $('#inpSearch').value = '';
  refreshChips();
  if (!keepStatus) setStatus('');
}
$('#brandBtn').addEventListener('click', () => {
  resetFilters();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  loadList();
});

/* ================= 库存操作 ================= */
function quickStock(m, dir) {
  const sign = dir > 0 ? '＋ 入库' : '－ 出库';
  showModal((root) => {
    root.classList.add('confirm-box');
    const head = modalHead(sign + ' · ' + (m.name || m.model || ''));
    const body = el('div', 'modal-body');
    body.appendChild(el('div', 'act-note', `当前库存：${m.stock}${m.unit || '个'} · ${m.location || '未设置位置'}`));
    const pad = el('div', 'stock-pad');
    const quick = el('div', 'quick');
    const qnum = document.createElement('input');
    qnum.type = 'number'; qnum.className = 'q-num'; qnum.value = '10'; qnum.min = '1';
    for (const n of [1, 5, 10, 50, 100]) {
      const b = el('button', 'btn sm', (dir > 0 ? '+' : '-') + n);
      b.onclick = () => { qnum.value = String(Math.max(0, (Number(qnum.value) || 0) + n)); };
      quick.appendChild(b);
    }
    const reason = document.createElement('input');
    reason.className = 'q-reason';
    reason.placeholder = dir > 0 ? '原因（如：新购到货）' : '原因（如：焊接用掉）';
    pad.append(el('span', null, '数量'), quick, qnum, reason);
    body.appendChild(pad);
    const foot = el('div', 'form-foot');
    const ok = el('button', 'btn primary', '确认' + (dir > 0 ? '入库' : '出库'));
    const cancel = el('button', 'btn', '取消');
    ok.onclick = async () => {
      const delta = dir > 0 ? Math.abs(Number(qnum.value) || 0) : -Math.abs(Number(qnum.value) || 0);
      if (!delta) return toast('请输入数量', 'err');
      ok.disabled = true;
      try {
        await apiJson(`/api/materials/${m.id}/stock`, 'POST', { delta, reason: reason.value.trim() || (dir > 0 ? '手动入库' : '手动出库') });
        closeModal();
        toast(dir > 0 ? `已入库 ${Math.abs(delta)}${m.unit || '个'}` : `已出库 ${Math.abs(delta)}${m.unit || '个'}`, 'ok');
        refreshAll();
      } catch (e) { toast(e.message, 'err'); ok.disabled = false; }
    };
    cancel.onclick = closeModal;
    foot.append(ok, cancel);
    body.appendChild(foot);
    root.append(head, body);
    qnum.focus(); qnum.select();
  });
}

/* ================= 弹层 ================= */
function modalHead(title) {
  const head = el('div', 'modal-head');
  head.appendChild(el('h2', null, title));
  const x = el('button', 'icon-btn', '✕');
  x.onclick = closeModal;
  head.appendChild(x);
  return head;
}
let modalCleanup = null;
function showModal(build) {
  if (modalCleanup) { try { modalCleanup(); } catch { /* ignore */ } }
  modalCleanup = null;
  $('#modalBox').textContent = '';
  build($('#modalBox'));
  $('#modalMask').classList.remove('hidden');
}
function closeModal() {
  if (modalCleanup) { try { modalCleanup(); } catch { /* ignore */ } }
  modalCleanup = null;
  $('#modalMask').classList.add('hidden');
  $('#modalBox').textContent = '';
}
$('#modalMask').addEventListener('mousedown', (e) => { if (e.target === $('#modalMask')) closeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#modalMask').classList.contains('hidden')) closeModal();
  else if (!$('#detailMask').classList.contains('hidden')) closeDetail();
  else if (!$('#aiMask').classList.contains('hidden')) closeAi();
});

/* ================= 详情弹窗 ================= */
async function openMaterial(id) {
  state.detailId = id;
  $('#detailMask').classList.remove('hidden');
  $('#detailModal').classList.remove('hidden');
  $('#dBody').textContent = '';
  $('#dTitle').textContent = '物料详情';
  try {
    const [m, ledger] = await Promise.all([apiGet(`/api/materials/${id}`), apiGet(`/api/materials/${id}/ledger`)]);
    renderDetail(m, ledger);
  } catch (e) {
    $('#dBody').textContent = '';
    $('#dBody').appendChild(el('div', 'act-note', '加载失败：' + e.message));
  }
}
function closeDetail() {
  $('#detailMask').classList.add('hidden');
  $('#detailModal').classList.add('hidden');
  state.detailId = null;
}
$('#dClose').onclick = closeDetail;
$('#detailMask').onclick = closeDetail;

function renderDetail(m, ledger) {
  $('#dTitle').textContent = m.name || m.model || '未命名物料';
  const body = $('#dBody');
  body.textContent = '';

  /* 头部：图片 + 名称 */
  const hero = el('div', 'd-hero');
  const u = mediaUrl(m.photo);
  hero.appendChild(u ? (() => {
    const img = el('img', 'd-photo');
    img.src = u;
    img.onerror = () => img.replaceWith(tileEl(m.category, 'd-tile'));
    return img;
  })() : tileEl(m.category, 'd-tile'));
  const info = el('div');
  info.appendChild(el('div', 'd-name', m.name || '未命名物料'));
  if (m.model) info.appendChild(el('div', 'd-model', m.model));
  const meta = el('div', 'mt-tags');
  if (m.brand) meta.appendChild(pill(m.brand, 'brand'));
  if (m.category) meta.appendChild(pill(m.category, 'cat'));
  if (m.package) meta.appendChild(pill(m.package, 'pkg'));
  if (m.lcsc_code) {
    const c = pill(m.lcsc_code, 'lcsc');
    if (m.lcsc_url) c.onclick = () => window.open(m.lcsc_url, '_blank');
    meta.appendChild(c);
  }
  info.appendChild(meta);
  if (m.location) info.appendChild(el('div', 'act-note', '📍 ' + m.location));
  hero.appendChild(info);
  body.appendChild(hero);

  /* 库存 + 价格行 */
  const pr = el('div', 'mt-stockrow');
  const box = el('div', 'stock-box');
  box.appendChild(el('span', 'stock-num' + (m.out ? ' out' : m.low ? ' low' : ''), String(m.stock)));
  box.appendChild(el('span', 'stock-unit', (m.unit || '个') + (m.min_stock > 0 ? ` · 预警线 ${m.min_stock}` : '')));
  pr.appendChild(box);
  const priceTxt = moneyText(m.price, m.currency);
  if (priceTxt) {
    const p1 = el('span', 'mt-price', priceTxt);
    p1.title = '来料价（你自己登记的采购价）';
    pr.appendChild(p1);
  }
  const ref = refCnyText(m);
  if (ref) {
    const p2 = el('span', 'mt-refprice', ref.main);
    p2.title = ref.tip;
    pr.appendChild(p2);
    if (!priceTxt) p2.classList.add('alone');
  }
  body.appendChild(pr);

  /* 操作 + 数据手册 */
  const acts = el('div', 'd-actions');
  const inB = el('button', 'btn sm', '＋ 入库'); inB.onclick = () => quickStock(m, 1);
  const outB = el('button', 'btn sm', '－ 出库'); outB.onclick = () => quickStock(m, -1);
  const setB = el('button', 'btn sm', '盘点修正'); setB.onclick = () => setStockModal(m);
  const editB = el('button', 'btn sm', '✎ 编辑'); editB.onclick = () => openForm(m);
  const delB = el('button', 'btn sm danger', '删除'); delB.onclick = () => deleteConfirm(m);
  acts.append(inB, outB, setB, editB, delB);
  if (m.lcsc_code) {
    const rp = el('button', 'btn sm', '🔄 立创价');
    rp.title = '刷新立创参考价（只更新参考价，不改来料价）';
    rp.onclick = async () => {
      rp.disabled = true; rp.textContent = '刷新中…';
      try {
        const out = await apiJson(`/api/materials/${m.id}/refresh-price`, 'POST', {});
        toast(`立创参考价已更新：${moneyText(out.lcsc_price, out.lcsc_currency)} · 来料价未变`, 'ok');
        refreshAll();
      } catch (e) { toast(e.message, 'err'); }
      finally { rp.disabled = false; rp.textContent = '🔄 立创价'; }
    };
    acts.appendChild(rp);
  }
  const lb = el('button', 'btn sm', '🏷 标签');
  lb.title = '生成条码标签并打印（扫码可快速定位）';
  lb.onclick = () => labelModal(m);
  acts.appendChild(lb);
  if (m.datasheet_url && safeUrl(m.datasheet_url)) {
    const ds = el('a', 'btn sm dsheet', '📄 数据手册');
    ds.href = safeUrl(m.datasheet_url);
    ds.target = '_blank';
    ds.rel = 'noopener';
    ds.title = '查看/下载数据手册 PDF';
    acts.appendChild(ds);
  }
  if (m.lcsc_url) {
    const lc = el('a', 'btn sm', '立创页面 ↗');
    lc.href = m.lcsc_url; lc.target = '_blank'; lc.rel = 'noopener';
    acts.appendChild(lc);
  }
  body.appendChild(acts);

  /* 库存走势（近 30 条流水的存量曲线） */
  if (ledger.length >= 2) {
    const pts = ledger.slice(0, 30).reverse().map((r) => r.after_stock);
    const w = 320, h = 60, pad = 4;
    const min = Math.min(...pts), max = Math.max(...pts);
    const span = (max - min) || 1;
    const xy = pts.map((v, i) => [
      pad + i * ((w - 2 * pad) / (pts.length - 1)),
      h - pad - ((v - min) / span) * (h - 2 * pad)
    ]);
    const line = xy.map(([x, y]) => x.toFixed(1) + ',' + y.toFixed(1)).join(' ');
    const svg = document.createElement('div');
    svg.className = 'spark-box';
    const sv = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    sv.setAttribute('viewBox', `0 0 ${w} ${h}`);
    sv.setAttribute('preserveAspectRatio', 'none');
    sv.classList.add('spark-svg');
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('points', line);
    sv.appendChild(poly);
    svg.append(el('span', 'spark-label', '库存走势'), sv);
    svg.appendChild(el('span', 'spark-range', `${min} ~ ${max}`));
    body.appendChild(svg);
  }

  /* 规格参数（结构化参数表） */
  const attrs = (m.attributes && typeof m.attributes === 'object') ? m.attributes : null;
  if ((attrs && Object.keys(attrs).length) || m.spec) {
    const sa = el('div', 'section');
    sa.appendChild(el('h3', null, '规格参数'));
    if (m.spec) sa.appendChild(el('div', 'act-note', m.spec));
    if (attrs && Object.keys(attrs).length) {
      const grid = el('div', 'spec-grid');
      for (const [k, v] of Object.entries(attrs)) {
        const row = el('div');
        row.appendChild(el('b', null, k));
        row.appendChild(el('span', null, String(v)));
        grid.appendChild(row);
      }
      sa.appendChild(grid);
    }
    body.appendChild(sa);
  }

  /* 基本信息 */
  const sec = el('div', 'section');
  sec.appendChild(el('h3', null, '基本信息'));
  const kv = el('div', 'kv');
  const rows = [
    ['立创编号', m.lcsc_code], ['品牌', m.brand],
    ['分类', m.category], ['封装', m.package],
    ['位置', m.location], ['单位', m.unit],
    ['来料单价', m.price != null ? `${m.price} ${m.currency || ''}`.trim() : ''],
    ['立创参考价', m.lcsc_price != null ? `${m.lcsc_price} ${m.lcsc_currency || 'USD'}${ref ? '（' + ref.main + '）' : ''}` : ''],
    ['供应商', m.supplier], ['预警下限', m.min_stock > 0 ? String(m.min_stock) : '']
  ];
  for (const [k, v] of rows) {
    if (!v && v !== 0) continue;
    const d = el('div');
    d.appendChild(el('dt', null, k));
    d.appendChild(el('dd', null, String(v)));
    kv.appendChild(d);
  }
  sec.appendChild(kv);
  body.appendChild(sec);

  if (m.description || m.remark) {
    const sd = el('div', 'section');
    sd.appendChild(el('h3', null, '描述 / 备注'));
    sd.appendChild(el('div', 'act-note', [m.description, m.remark].filter(Boolean).join('\n')));
    body.appendChild(sd);
  }

  /* 出入库流水 */
  const sl = el('div', 'section');
  sl.appendChild(el('h3', null, `出入库流水（${ledger.length}）`));
  if (!ledger.length) sl.appendChild(el('div', 'act-note', '暂无流水记录'));
  for (const r of ledger) {
    const it = el('div', 'ledger-item');
    const dlt = el('span', 'delta ' + (r.delta > 0 ? 'in' : r.delta < 0 ? 'out' : ''), (r.delta > 0 ? '＋' : '') + r.delta);
    it.append(dlt, el('span', null, r.reason || '—'), el('span', 'ld-time', fmtTime(r.created_at)));
    sl.appendChild(it);
  }
  body.appendChild(sl);
}

function setStockModal(m) {
  showModal((root) => {
    root.classList.add('confirm-box');
    const head = modalHead('盘点修正');
    const body = el('div', 'modal-body');
    body.appendChild(el('div', 'act-note', `${m.name || m.model} 当前库存 ${m.stock}${m.unit || '个'}，输入盘点后的实际数量（差额自动记账）。`));
    const pad = el('div', 'stock-pad');
    const num = document.createElement('input');
    num.type = 'number'; num.className = 'q-num'; num.value = m.stock; num.min = '0';
    const reason = document.createElement('input');
    reason.className = 'q-reason'; reason.placeholder = '盘点原因（可选）';
    pad.append(el('span', null, '盘点后数量'), num, reason);
    const foot = el('div', 'form-foot');
    const ok = el('button', 'btn primary', '确认修正');
    const cancel = el('button', 'btn', '取消');
    ok.onclick = async () => {
      const v = Number(num.value);
      if (!Number.isFinite(v) || v < 0) return toast('请输入有效数量', 'err');
      ok.disabled = true;
      try {
        await apiJson(`/api/materials/${m.id}/set-stock`, 'POST', { stock: v, reason: reason.value.trim() });
        closeModal(); toast('已盘点修正', 'ok'); refreshAll();
      } catch (e) { toast(e.message, 'err'); ok.disabled = false; }
    };
    cancel.onclick = closeModal;
    foot.append(ok, cancel);
    body.append(pad, foot);
    root.append(head, body);
    num.focus(); num.select();
  });
}

function deleteConfirm(m) {
  showModal((root) => {
    root.classList.add('confirm-box');
    const head = modalHead('删除物料');
    const body = el('div', 'modal-body');
    body.appendChild(el('div', 'confirm-msg', `确定删除「${m.name || m.model || m.lcsc_code || ''}」吗？删除后从列表消失（流水保留）。`));
    const foot = el('div', 'form-foot');
    const cancel = el('button', 'btn', '取消');
    const ok = el('button', 'btn modal-danger', '确认删除');
    cancel.onclick = closeModal;
    ok.onclick = async () => {
      try {
        await api(`/api/materials/${m.id}`, { method: 'DELETE' });
        closeModal(); closeDetail(); toast('已删除', 'ok'); refreshAll();
      } catch (e) { toast(e.message, 'err'); }
    };
    foot.append(cancel, ok);
    body.appendChild(foot);
    root.append(head, body);
  });
}

/* ================= 表单 ================= */
const FIELD_DEFS = [
  ['name', '物料名称', '如：贴片电阻 10kΩ 0805'],
  ['model', '厂家型号', '如 CL21B103KBANNNC'],
  ['brand', '品牌', '三星 / 国巨 / ST…'],
  ['category', '分类', '电阻 / 电容 / 集成电路…'],
  ['package', '封装 / 尺寸', '0805、SOT-23、LQFP48…'],
  ['spec', '关键规格', '10kΩ ±1% 1/8W'],
  ['unit', '单位', '个 / 卷 / 盘'],
  ['min_stock', '预警下限', '低于该值标黄提醒'],
  ['location', '存放位置', '料架A-3 / 抽屉2'],
  ['price', '来料单价', '可手动填写；有立创编号可自动获取'],
  ['currency', '币种', 'CNY / USD'],
  ['supplier', '供应商', '立创商城 / 淘宝…'],
  ['stock', '初始库存', '新建时的数量']
];

function openForm(m) {
  showModal((root) => {
    const isEdit = !!m;
    const head = modalHead(isEdit ? '编辑物料' : '新增物料');
    const body = el('div', 'modal-body');
    const form = el('form');
    if (!isEdit) {
      const panel = el('div', 'lcsc-panel');
      const row = el('div', 'row');
      const inp = document.createElement('input');
      inp.placeholder = '粘贴立创编号或链接，如 C1710';
      const btn = el('button', 'btn sm primary', '查资料自动填写');
      const st = el('div', 'lcsc-state info', '支持 C 开头编号，自动拉取型号/品牌/封装/参数。');
      btn.onclick = async () => {
        const code = inp.value.trim();
        if (!code) return toast('请先输入立创编号', 'err');
        btn.disabled = true; st.className = 'lcsc-state info'; st.textContent = '正在查询立创商城…';
        try {
          const d = await apiGet('/api/lcsc/detail?code=' + encodeURIComponent(code));
          st.className = 'lcsc-state ok';
          if (d.already_exists) st.textContent = `已存在同编号物料（${d.existing.map((x) => x.name || x.model).join('、')}）。直接对它入库即可，或先删除再建档。`;
          else {
            const ref = d.lcsc_price != null
              ? ` 立创参考价 $${parseFloat(Number(d.lcsc_price).toFixed(5))}${state.fx.usdCny ? '（≈¥' + parseFloat((Number(d.lcsc_price) * Number(state.fx.usdCny)).toFixed(4)) + '）' : ''}，`
              : ' ';
            st.textContent = `已获取资料并自动填写。${ref}「来料单价」留空待你自行填写（与参考价相互独立）。`;
          }
          applyLcscToForm(form, d);
        } catch (e) {
          st.className = 'lcsc-state err'; st.textContent = e.message;
        } finally { btn.disabled = false; }
      };
      row.append(inp, btn);
      panel.append(row, st);
      form.appendChild(panel);
    }

    const grid = el('div', 'form-grid');
    const values = m || {};
    for (const [f, label, ph] of FIELD_DEFS) {
      const wrap = el('div', 'fld');
      wrap.appendChild(el('label', null, label));
      const input = document.createElement('input');
      if (f === 'stock' || f === 'min_stock') { input.type = 'number'; input.min = '0'; }
      input.dataset.field = f;
      input.placeholder = ph;
      let v = values[f];
      if (f === 'min_stock') v = v || '0';
      if (f === 'stock') v = v ?? '0';
      input.value = v === undefined || v === null ? '' : String(v);
      wrap.appendChild(input);
      grid.appendChild(wrap);
    }
    for (const [f, label] of [['description', '补充描述'], ['remark', '备注']]) {
      const wrap = el('div', 'fld full');
      wrap.appendChild(el('label', null, label));
      const t = document.createElement('textarea');
      t.rows = 2; t.dataset.field = f; t.value = (values[f] || '');
      wrap.appendChild(t);
      grid.appendChild(wrap);
    }
    const attrSec = el('div', 'fld full');
    attrSec.appendChild(el('label', null, '结构化参数（可选：阻值 = 10kΩ）'));
    const attrsBox = el('div');
    attrsBox.id = 'attrsBox';
    const addBtn = el('button', 'attr-add', '＋ 添加参数');
    addBtn.type = 'button';
    addBtn.onclick = () => attrsBox.appendChild(attrRowEl('', ''));
    const attrs = (values.attributes && typeof values.attributes === 'object') ? values.attributes : {};
    if (!Object.keys(attrs).length) attrsBox.appendChild(attrRowEl('', ''));
    for (const [k, v] of Object.entries(attrs)) attrsBox.appendChild(attrRowEl(k, v));
    attrSec.append(attrsBox, addBtn);
    grid.appendChild(attrSec);

    const photoWrap = el('div', 'fld full');
    photoWrap.appendChild(el('label', null, '物料照片（可选）'));
    const picker = el('div', 'photo-pick');
    const pImg = el('img'); pImg.alt = '';
    const ph0 = values.photo ? mediaUrl(values.photo) : null;
    if (ph0) pImg.src = ph0; else pImg.style.visibility = 'hidden';
    const fileBtn = el('label', 'btn sm');
    fileBtn.textContent = '📁 选择图片';
    const fInput = document.createElement('input');
    fInput.type = 'file'; fInput.accept = 'image/*'; fInput.hidden = true;
    const photoField = document.createElement('input');
    photoField.type = 'text'; photoField.dataset.field = 'photo'; photoField.value = values.photo || '';
    photoField.placeholder = '/photos/… 或 https://…';
    fInput.onchange = async () => {
      const file = fInput.files && fInput.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('image', file, file.name);
      try {
        const up = await api('/api/photo', { method: 'POST', body: fd });
        photoField.value = up.url;
        pImg.src = up.url; pImg.style.visibility = 'visible';
        toast('照片已上传', 'ok');
      } catch (e) { toast(e.message, 'err'); }
      finally { fInput.value = ''; }
    };
    fileBtn.appendChild(fInput);
    picker.append(pImg, fileBtn, photoField);
    photoWrap.appendChild(picker);
    grid.appendChild(photoWrap);

    const urlWrap = el('div', 'fld full');
    urlWrap.appendChild(el('label', null, '数据手册 / 商品链接'));
    const dh = document.createElement('input');
    dh.type = 'text'; dh.placeholder = 'https://datasheet…';
    dh.dataset.field = 'datasheet_url'; dh.value = values.datasheet_url || '';
    urlWrap.appendChild(dh);
    grid.appendChild(urlWrap);
    const h1 = document.createElement('input'); h1.type = 'hidden'; h1.dataset.field = 'lcsc_code'; h1.value = values.lcsc_code || '';
    const h2 = document.createElement('input'); h2.type = 'hidden'; h2.dataset.field = 'lcsc_url'; h2.value = values.lcsc_url || '';
    grid.append(h1, h2);
    form.appendChild(grid);

    const foot = el('div', 'form-foot');
    const err = el('span', 'act-note');
    err.style.color = 'var(--danger)';
    const cancel = el('button', 'btn', '取消');
    cancel.type = 'button'; cancel.onclick = closeModal;
    const ok = el('button', 'btn primary', isEdit ? '保存修改' : '保存');
    ok.type = 'submit';
    foot.append(err, cancel, ok);
    form.appendChild(foot);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const payload = readForm(form);
      if (!payload.name && !payload.model) { err.textContent = '至少填写物料名称或型号'; return; }
      ok.disabled = true;
      try {
        if (isEdit) await apiJson(`/api/materials/${m.id}`, 'PUT', payload);
        else await apiJson('/api/materials', 'POST', { ...payload, stock: Number(payload.stock) || 0 });
        closeModal(); toast(isEdit ? '已保存' : '已新增物料', 'ok'); refreshAll();
      } catch (ex) { err.textContent = ex.message; ok.disabled = false; }
    };
    body.appendChild(form);
    root.append(head, body);
  });
}
function attrRowEl(k, v) {
  const row = el('div', 'attr-row');
  const kIn = document.createElement('input');
  kIn.className = 'k'; kIn.placeholder = '参数名（阻值）'; kIn.value = k;
  const vIn = document.createElement('input');
  vIn.placeholder = '参数值（10kΩ）'; vIn.value = v;
  const del = el('button', 'del', '✕');
  del.type = 'button';
  del.onclick = () => row.remove();
  row.append(kIn, vIn, del);
  return row;
}
function readForm(form) {
  const out = {};
  for (const input of form.querySelectorAll('[data-field]')) {
    const f = input.dataset.field;
    let v = input.value.trim();
    if (f === 'stock' || f === 'min_stock') v = Math.max(0, Number(v) || 0);
    if (f === 'price') v = v === '' ? null : Number(v);
    out[f] = v;
  }
  const attrs = {};
  for (const row of form.querySelectorAll('#attrsBox .attr-row')) {
    const ins = row.querySelectorAll('input');
    const k = ins[0].value.trim();
    const v = ins[1].value.trim();
    if (k) attrs[k] = v;
  }
  out.attributes = Object.keys(attrs).length ? attrs : null;
  return out;
}
function applyLcscToForm(form, d) {
  const set = (f, v) => {
    const inp = form.querySelector(`[data-field="${f}"]`);
    if (inp && v !== undefined && v !== null && v !== '') inp.value = String(v);
  };
  set('name', d.name); set('model', d.model); set('brand', d.brand); set('category', d.category);
  set('package', d.package); set('spec', d.spec); set('description', d.description);
  set('supplier', d.supplier); set('price', d.price != null ? String(d.price) : ''); set('currency', d.currency);
  set('datasheet_url', d.datasheet_url); set('lcsc_code', d.lcsc_code); set('lcsc_url', d.lcsc_url);
  set('photo', d.photo || '');
  const pi = form.querySelector('.photo-pick img');
  const u = mediaUrl(d.photo);
  if (pi && u) { pi.src = u; pi.style.visibility = 'visible'; }
  const box = form.querySelector('#attrsBox');
  if (box && d.attributes && Object.keys(d.attributes).length) {
    box.textContent = '';
    for (const [k, v] of Object.entries(d.attributes)) box.appendChild(attrRowEl(k, v));
  }
}

/* ================= AI 聊天 ================= */
async function ensureAiPanelReady() {
  if (!state.config) state.config = await apiGet('/api/ai/config');
  const cfg = state.config.ai;
  $('#aiBadge').textContent = cfg.provider === 'mock'
    ? '演示模式'
    : (cfg.apiKeySet ? (cfg.model || '已配置') : '未配置 Key');
  return cfg;
}
function openAi() {
  ensureAiPanelReady().catch(() => {});
  $('#aiMask').classList.remove('hidden');
  $('#aiDrawer').classList.remove('hidden');
  setTimeout(() => $('#chatText').focus(), 60);
  scrollChat();
}
function closeAi() {
  $('#aiMask').classList.add('hidden');
  $('#aiDrawer').classList.add('hidden');
}
$('#aiMask').onclick = closeAi;
$('#aiClose').onclick = closeAi;
$('#fabAi').addEventListener('click', openAi);

$('#imgPick').onchange = async () => {
  const file = $('#imgPick').files && $('#imgPick').files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('image', file, file.name);
  if (state.aiSession) fd.append('sessionId', state.aiSession);
  addBotTyping();
  try {
    const up = await api('/api/ai/attach', { method: 'POST', body: fd });
    state.pendingAttach = { sessionId: up.sessionId, name: file.name, url: up.url };
    $('#attachPreview').src = mediaUrl(up.url);
    $('#attachName').textContent = file.name;
    $('#attachRow').classList.remove('hidden');
    state.aiSession = up.sessionId;
    addUserMsg('📷 已选照片，将随下一条消息发给 AI', up.url);
  } catch (e) {
    toast('照片上传失败：' + e.message, 'err');
  } finally {
    removeTyping();
    $('#imgPick').value = '';
  }
};
$('#attachRemove').onclick = () => {
  state.pendingAttach = null;
  $('#attachRow').classList.add('hidden');
};
function addUserMsg(text, imgUrl) {
  const wrap = el('div', 'msg user');
  const b = el('div', 'bubble');
  b.textContent = text;
  if (imgUrl) { const img = el('img', 'pic'); img.src = imgUrl; b.appendChild(img); }
  wrap.appendChild(b);
  $('#chatBox').appendChild(wrap);
  scrollChat();
}
function addBotMsg(text) {
  const wrap = el('div', 'msg bot');
  const b = el('div', 'bubble');
  b.textContent = text;
  wrap.appendChild(b);
  $('#chatBox').appendChild(wrap);
  scrollChat();
}
function addOpCards(ops) {
  for (const op of ops) {
    const wrap = el('div', 'msg bot');
    const card = el('div', 'op-card');
    let label, sub;
    if (op.op === 'create') { label = '✔ 已新增'; sub = `${op.title}${op.code ? '（' + op.code + '）' : ''} · 库存 ${op.stock}${op.unit || '个'}`; }
    else if (op.op === 'stock') { label = (op.delta > 0 ? '✔ 已入库' : '✔ 已出库') + ` ${Math.abs(op.delta)}${op.unit || ''}`; sub = `${op.title} · 当前 ${op.after}`; }
    else if (op.op === 'set') { label = '✔ 已盘点修正'; sub = `${op.title} · 现 ${op.after}${op.unit || ''}`; }
    else if (op.op === 'delete') { label = '✔ 已删除'; sub = op.title; }
    else if (op.op === 'clear_all') { label = '✔ 已清空全部'; sub = `共移除 ${op.cleared} 种物料`; }
    else if (op.op === 'update') { label = '✔ 已更新物料'; sub = `${op.title}${op.changed ? ' · 改动：' + op.changed : ''}`; }
    else if (op.op === 'backfill') { label = '✔ 已从立创补全资料'; sub = `${op.title} · 补充 ${op.filled || 0} 项${op.fields ? '（' + op.fields + '）' : ''}`; }
    else { label = '✔ 完成'; sub = op.title || ''; }
    card.appendChild(el('span', 'lbl', label + '：'));
    card.appendChild(el('span', null, sub));
    card.title = '点击查看该物料';
    card.onclick = () => { if (op.id) { closeAi(); openMaterial(op.id); } };
    wrap.appendChild(card);
    $('#chatBox').appendChild(wrap);
  }
  scrollChat();
}
let typingEl = null;
function addBotTyping() {
  if (typingEl) return;
  typingEl = el('div', 'msg bot typing');
  const bub = el('div', 'bubble');
  bub.append(el('span'), el('span'), el('span'));
  typingEl.appendChild(bub);
  $('#chatBox').appendChild(typingEl);
  scrollChat();
}
function removeTyping() { if (typingEl) { typingEl.remove(); typingEl = null; } }
function scrollChat() { const box = $('#chatBox'); box.scrollTop = box.scrollHeight; }

async function sendChat() {
  const raw = $('#chatText').value.trim();
  const pending = state.pendingAttach;
  if (!raw && !pending) return toast('先输入内容，或选择照片', 'err');
  $('#chatText').value = '';
  const text = raw || '识别这张图片里的物料并帮我录入';
  const sessionId = (pending && pending.sessionId) || state.aiSession || undefined;
  const attachUrl = pending ? mediaUrl(pending.url) : null;
  addUserMsg(text, attachUrl);
  if (pending) {
    state.pendingAttach = null;
    $('#attachRow').classList.add('hidden');
  }
  addBotTyping();
  try {
    const res = await apiJson('/api/ai/chat', 'POST', { sessionId, text });
    state.aiSession = res.sessionId;
    removeTyping();
    if (res.reply) addBotMsg(res.reply);
    if (res.ops && res.ops.length) addOpCards(res.ops);
    if (res.ops && res.ops.some((o) => ['create', 'stock', 'set', 'delete', 'clear_all', 'update', 'backfill'].includes(o.op))) refreshAll();
  } catch (e) {
    removeTyping();
    addBotMsg('出错了：' + e.message + '\n（请检查右上角「设置」里的 AI 配置）');
  }
}
$('#btnSend').onclick = sendChat;
$('#chatText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
$('#aiHints').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-txt]');
  if (b) { $('#chatText').value = b.dataset.txt; $('#chatText').focus(); }
});

/* ================= 会话历史 / 新对话 ================= */
const WELCOME_HTML = () => {
  const wrap = el('div', 'msg bot');
  const b = el('div', 'bubble');
  b.textContent = '你好，我是物料助手 👋\n直接说：新增 / 入库 / 出库 / 盘点 / 删除 / 查找 / 补图。\n也可以 📷 拍照，我识别后帮你建档。';
  wrap.appendChild(b);
  return wrap;
};
function resetChatBox() {
  $('#chatBox').textContent = '';
  $('#chatBox').appendChild(WELCOME_HTML());
  scrollChat();
}
function newChat() {
  state.aiSession = null;
  state.pendingAttach = null;
  $('#attachRow').classList.add('hidden');
  resetChatBox();
  $('#histPanel').classList.add('hidden');
  setTimeout(() => $('#chatText').focus(), 40);
}
$('#aiNewChat').addEventListener('click', newChat);

$('#aiHistoryBtn').addEventListener('click', async () => {
  const panel = $('#histPanel');
  if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const list = $('#histList');
  list.textContent = '';
  list.appendChild(el('div', 'hist-empty', '加载中…'));
  try {
    const sessions = await apiGet('/api/ai/sessions?limit=60');
    list.textContent = '';
    if (!sessions.length) {
      list.appendChild(el('div', 'hist-empty', '还没有历史会话'));
      return;
    }
    for (const s of sessions) {
      const item = el('div', 'hist-item');
      const main = el('div', 'hist-main');
      main.appendChild(el('div', 'hist-title', s.title || '（图片识别会话）'));
      main.appendChild(el('div', 'hist-meta', `${s.msg_count} 条 · ${fmtTime(s.updated_at)}`));
      const del = el('button', 'hist-del', '🗑');
      del.title = '删除该会话';
      del.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm('删除这个会话记录？')) return;
        try {
          await api('/api/ai/sessions/' + s.id, { method: 'DELETE' });
          if (state.aiSession === s.id) newChat();
          item.remove();
          if (!$('#histList').children.length) $('#histList').appendChild(el('div', 'hist-empty', '还没有历史会话'));
        } catch (err) { toast(err.message, 'err'); }
      };
      item.append(main, del);
      item.onclick = () => loadSession(s.id);
      list.appendChild(item);
    }
  } catch (e) {
    list.textContent = '';
    list.appendChild(el('div', 'hist-empty', '加载失败：' + e.message));
  }
});
$('#histClose').addEventListener('click', () => $('#histPanel').classList.add('hidden'));

async function loadSession(id) {
  try {
    const data = await apiGet('/api/ai/sessions/' + id);
    state.aiSession = id;
    const box = $('#chatBox');
    box.textContent = '';
    for (const m of data.messages) {
      if (m.role === 'user') addUserMsg(m.text || '', mediaUrl(m.imageUrl) || undefined);
      else if (m.role === 'assistant') addBotMsg(m.text || '');
    }
    if (!data.messages.length) resetChatBox();
    $('#histPanel').classList.add('hidden');
    scrollChat();
  } catch (e) {
    toast('加载会话失败：' + e.message, 'err');
  }
}

/* ================= 设置 ================= */
const PRESETS = {
  mock: { label: '演示模式（本地模拟，不联网）', baseUrl: '', model: '', visionModel: '' },
  deepseek: { label: 'DeepSeek V4（视觉+工具）', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash-vision-exp', visionModel: 'deepseek-v4-flash-vision-exp', keyHint: 'DeepSeek API Key（推理+视觉+工具）' },
  zhichu: { label: '智谱 AI（GLM，含视觉）', baseUrl: 'https://open.bigmodel.cn/api/paas/v1', model: 'glm-4.6', visionModel: 'glm-4v-plus', keyHint: '智谱开放平台 API Key' },
  bailian: { label: '阿里云百炼（通义千问，含视觉）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', visionModel: 'qwen-vl-plus', keyHint: '百炼 API Key' },
  openai: { label: 'OpenAI（GPT，含视觉）', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', visionModel: 'gpt-4o-mini', keyHint: 'OpenAI API Key' },
  custom: { label: '自定义（OpenAI 兼容）', baseUrl: '', model: '', visionModel: '', keyHint: '接口需支持 tools；拍照需 vision 模型' }
};
function openSettings() {
  (async () => {
    const cfg = state.config || (state.config = await apiGet('/api/ai/config'));
    showModal((root) => {
      const head = modalHead('系统设置');
      const body = el('div', 'modal-body');
      body.appendChild(el('div', 'act-note', '本地运行：数据与 API Key 仅存于本机 data/config.json。拍照识别需要支持视觉的模型。'));
      const selW = el('div', 'fld full');
      selW.appendChild(el('label', null, 'AI 服务商 / 模式'));
      const sel = document.createElement('select');
      for (const [k, p] of Object.entries(PRESETS)) {
        const o = el('option', '', p.label);
        o.value = k;
        sel.appendChild(o);
      }
      sel.value = PRESETS[cfg.ai.provider] ? cfg.ai.provider : 'custom';
      selW.appendChild(sel);
      body.appendChild(selW);

      const grid = el('div', 'form-grid');
      const fBase = mk('接口地址 baseUrl', 'baseUrl');
      const fKey = mk('API Key', 'apiKey', 'password');
      const fModel = mk('对话模型 model', 'model');
      const fVision = mk('视觉模型（拍照识别）', 'visionModel');
      grid.append(fBase.wrap, fKey.wrap, fModel.wrap, fVision.wrap);
      body.appendChild(grid);
      const note = el('div', 'act-note');
      body.appendChild(note);

      function mk(label, name, type = 'text') {
        const wrap = el('div', 'fld');
        wrap.appendChild(el('label', null, label));
        const input = document.createElement('input');
        input.type = type;
        input.dataset.k = name;
        wrap.appendChild(input);
        return { wrap, input };
      }
      const ai = cfg.ai;
      fBase.input.value = ai.baseUrl || '';
      fModel.input.value = ai.model || '';
      fVision.input.value = ai.visionModel || '';
      fKey.input.placeholder = ai.apiKeySet ? '已保存（留空不修改）' : '输入 API Key';
      function applyPreset(key) {
        const p = PRESETS[key];
        if (!p) return;
        fBase.input.value = p.baseUrl;
        fModel.input.value = p.model;
        fVision.input.value = p.visionModel || '';
        fKey.input.placeholder = p.keyHint || 'API Key';
        fKey.input.value = '';
        note.textContent = key === 'mock' ? '演示模式：不联网不耗额度。' : '';
      }
      sel.onchange = () => applyPreset(sel.value);
      const foot = el('div', 'form-foot');
      const test = el('button', 'btn', '测试连接');
      const cancel = el('button', 'btn', '取消');
      const save = el('button', 'btn primary', '保存');
      cancel.onclick = closeModal;
      test.onclick = async () => {
        test.disabled = true; test.textContent = '测试中…';
        try {
          await apiJson('/api/ai/config', 'POST', readAiForm(sel));
          state.config = await apiGet('/api/ai/config');
          const out = await apiJson('/api/ai/test', 'POST', {});
          toast(out.note || '连接成功', 'ok');
        } catch (e) { toast('测试失败：' + e.message, 'err'); }
        finally { test.disabled = false; test.textContent = '测试连接'; }
      };
      save.onclick = async () => {
        try {
          await apiJson('/api/ai/config', 'POST', readAiForm(sel));
          state.config = await apiGet('/api/ai/config');
          closeModal(); toast('设置已保存', 'ok');
          ensureAiPanelReady().catch(() => {});
        } catch (e) { toast(e.message, 'err'); }
      };
      foot.append(test, cancel, save);
      body.appendChild(foot);
      root.append(head, body);
    });
  })().catch((e) => toast(e.message, 'err'));
}
function readAiForm(sel) {
  const read = (k) => { const i = document.querySelector(`[data-k="${k}"]`); return i ? i.value.trim() : ''; };
  return {
    provider: sel.value,
    baseUrl: read('baseUrl'), apiKey: read('apiKey'),
    model: read('model'), visionModel: read('visionModel')
  };
}

/* ================= 工具：补货清单 / 重复检测合并 / 扫码 ================= */
function replenishModal() {
  (async () => {
    const data = await apiGet('/api/replenish');
    showModal((root) => {
      const head = modalHead(`📋 补货清单（${data.total}）`);
      const body = el('div', 'modal-body');
      if (!data.total) {
        body.appendChild(el('div', 'warn-empty', '✓ 库存健康，暂无需要补货的物料'));
      } else {
        const list = el('div', 'repl-list');
        for (const it of data.items) {
          const row = el('div', 'repl-item' + (it.out ? ' is-out' : ''));
          row.appendChild(el('span', 'repl-badge' + (it.out ? ' out' : ''), it.out ? '缺货' : '预警'));
          const main = el('div', 'repl-main');
          main.appendChild(el('div', 'repl-name', it.name || it.model || '—'));
          main.appendChild(el('div', 'repl-meta', [it.lcsc_code, it.brand, it.location].filter(Boolean).join(' · ')));
          row.appendChild(main);
          const nums = el('div', 'repl-nums');
          nums.appendChild(el('span', 'repl-stock' + (it.out ? ' out' : ''), it.stock + (it.unit || '')));
          nums.appendChild(el('span', 'repl-suggest', '建议 +' + it.suggest));
          row.appendChild(nums);
          row.onclick = () => { closeModal(); openMaterial(it.id); };
          list.appendChild(row);
        }
        body.appendChild(list);
        const foot = el('div', 'form-foot');
        const dl = el('a', 'btn primary', '⬇ 导出 CSV');
        dl.href = '/api/export/replenish';
        dl.download = '';
        foot.appendChild(dl);
        body.appendChild(foot);
      }
      root.append(head, body);
    });
  })().catch((e) => toast(e.message, 'err'));
}

function duplicatesModal() {
  (async () => {
    const { groups } = await apiGet('/api/duplicates');
    showModal((root) => {
      const head = modalHead(`🧹 重复检测（${groups.length} 组）`);
      const body = el('div', 'modal-body');
      if (!groups.length) {
        body.appendChild(el('div', 'warn-empty', '✓ 未发现重复档案（按立创编号 / 型号比对）'));
      }
      for (const g of groups) {
        const card = el('div', 'dup-card');
        card.appendChild(el('div', 'dup-by', '重复依据：' + g.by + ' · ' + g.items.length + ' 条'));
        const pick = el('div', 'dup-pick');
        let keepId = g.items.reduce((a, b) => ((b.stock || 0) > (a.stock || 0) ? b : a), g.items[0]).id;
        for (const it of g.items) {
          const label = el('label', 'dup-opt' + (it.id === keepId ? ' on' : ''));
          const radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = 'keep-' + g.key;
          radio.value = it.id;
          radio.checked = it.id === keepId;
          radio.onchange = () => { keepId = it.id; for (const o of pick.querySelectorAll('.dup-opt')) o.classList.toggle('on', o.querySelector('input').checked); };
          label.appendChild(radio);
          const t = el('span');
          t.innerHTML = '';
          t.append(`${it.model || it.name || '—'}（库存 ${it.stock}${it.unit || ''}${it.lcsc_code ? ' · ' + it.lcsc_code : ''}${it.location ? ' · ' + it.location : ''}）`);
          label.appendChild(t);
          label.onclick = () => { radio.checked = true; radio.onchange(); };
          pick.appendChild(label);
        }
        card.appendChild(pick);
        const btn = el('button', 'btn sm primary', '合并到选中项');
        btn.onclick = async () => {
          const mergeIds = g.items.filter((i) => i.id !== keepId).map((i) => i.id);
          if (!mergeIds.length) return toast('请先选择要保留的档案', 'err');
          if (!confirm(`确定合并？保留 1 条，${mergeIds.length} 条将移除（库存与流水会迁移保留）。`)) return;
          btn.disabled = true;
          try {
            const out = await apiJson('/api/materials/merge', 'POST', { keep_id: keepId, merge_ids: mergeIds });
            toast(out.note, 'ok');
            btn.closest('.dup-card').remove();
            refreshAll();
            if (!$('#modalBox').querySelector('.dup-card')) closeModal();
          } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
        };
        card.appendChild(btn);
        body.appendChild(card);
      }
      root.append(head, body);
    });
  })().catch((e) => toast(e.message, 'err'));
}

/* 扫码查料：摄像头条码/二维码 → 反查库存；手动输入兜底 */
function scanModal() {
  let cleanup = null;
  const prevCleanup = modalCleanup;
  showModal((root) => {
    root.classList.add('confirm-box');
    const head = modalHead('⌗ 扫码查料');
    const body = el('div', 'modal-body');
    const video = el('video', 'scan-video');
    video.autoplay = true; video.playsInline = true; video.muted = true;
    const manual = el('div', 'stock-pad');
    const inp = document.createElement('input');
    inp.className = 'q-reason';
    inp.placeholder = '或手动输入 编号 / 型号 关键词，回车查询';
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const v = inp.value.trim(); if (v) { stop(); lookup(v); } } });
    manual.appendChild(inp);
    body.appendChild(el('div', 'act-note', '对准元件包装上的条码 / 二维码自动识别；识别后自动匹配库存。'));
    body.append(video, manual);
    const result = el('div', 'act-note', '');
    body.appendChild(result);
    root.append(head, body);
    setTimeout(() => inp.focus(), 40);

    let stream = null, stopped = false, timer = null;
    function stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (stream) stream.getTracks().forEach((t) => t.stop());
    }
    cleanup = stop;
    async function lookup(v) {
      result.textContent = '查询中：' + v;
      const r = await apiGet('/api/materials?size=10&q=' + encodeURIComponent(v));
      if (r.total === 1) { closeModal(); openMaterial(r.rows[0].id); return; }
      if (r.total > 1) {
        stop(); closeModal();
        showModal((root2) => {
          const h2 = modalHead('扫码结果（' + r.total + '）');
          const b2 = el('div', 'modal-body');
          for (const m of r.rows) {
            const it = el('div', 'hist-item');
            it.appendChild(el('div', 'hist-title', (m.model || m.name || '—') + `　库存 ${m.stock}${m.unit || ''}`));
            it.appendChild(el('div', 'hist-meta', [m.lcsc_code, m.brand, m.location].filter(Boolean).join(' · ')));
            it.onclick = () => { closeModal(); openMaterial(m.id); };
            b2.appendChild(it);
          }
          root2.append(h2, b2);
        });
        return;
      }
      const code = (String(v).match(/\bC\d{4,}\b/i) || [])[0];
      stop(); closeModal();
      showModal((root2) => {
        const h2 = modalHead('未找到匹配物料');
        const b2 = el('div', 'modal-body');
        b2.appendChild(el('div', 'confirm-msg', `没有匹配「${v}」的库存物料。` + (code ? `识别到疑似立创编号 ${code}，可交给 AI 从立创建档并入库。` : '')));
        const foot = el('div', 'form-foot');
        const again = el('button', 'btn', '重新扫码');
        again.onclick = () => { closeModal(); scanModal(); };
        const ai = el('button', 'btn primary', code ? `AI 建档 ${code}` : '打开 AI 助手');
        ai.onclick = () => { closeModal(); openAi(); if (code) $('#chatText').value = `入库 0 个 ${code}`.replace(' 0 个', ' ') ; };
        foot.append(again, ai);
        b2.appendChild(foot);
        root2.append(h2, b2);
      });
    }
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        video.srcObject = stream;
        await video.play();
        if ('BarcodeDetector' in window) {
          const det = new window.BarcodeDetector();
          const tick = async () => {
            if (stopped) return;
            try {
              const codes = await det.detect(video);
              if (codes && codes.length) { result.textContent = '识别到：' + codes[0].rawValue; lookup(codes[0].rawValue); return; }
            } catch { /* 帧未就绪 */ }
            timer = setTimeout(tick, 300);
          };
          tick();
        } else {
          result.textContent = '此浏览器不支持自动扫码识别，请手动输入关键词（推荐 Chrome / Edge）。';
        }
      } catch (e) {
        result.textContent = '无法打开摄像头：' + e.message;
      }
    })();
  });
  modalCleanup = () => { if (cleanup) cleanup(); };
  void prevCleanup;
}

$('#btnReplenish').addEventListener('click', replenishModal);
$('#btnDup').addEventListener('click', duplicatesModal);
$('#btnScan').addEventListener('click', scanModal);

/* ================= 语音输入（Web Speech API） ================= */
(function setupMic() {
  const btn = $('#btnMic');
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    btn.style.opacity = '.35';
    btn.title = '当前浏览器不支持语音识别（推荐 Chrome / Edge）';
    return;
  }
  let rec = null, listening = false, baseText = '';
  btn.addEventListener('click', () => {
    if (listening) { rec.stop(); return; }
    rec = new SR();
    rec.lang = 'zh-CN';
    rec.interimResults = true;
    rec.continuous = false;
    baseText = $('#chatText').value;
    rec.onresult = (e) => {
      let fin = '', inter = '';
      for (const res of e.results) {
        if (res.isFinal) fin += res[0].transcript;
        else inter += res[0].transcript;
      }
      $('#chatText').value = (baseText ? baseText + ' ' : '') + fin + inter;
    };
    rec.onstart = () => { listening = true; btn.classList.add('rec'); };
    rec.onend = () => { listening = false; btn.classList.remove('rec'); };
    rec.onerror = (e) => { toast('语音识别失败：' + (e.error || '未知错误'), 'err'); };
    rec.start();
  });
})();

/* ================= 清单（Kit/BOM） ================= */
function kitsModal() {
  (async () => {
    const kits = await apiGet('/api/kits');
    showModal((root) => {
      const head = modalHead('📦 清单 / BOM');
      const body = el('div', 'modal-body');
      const create = el('div', 'stock-pad');
      const nameIn = document.createElement('input');
      nameIn.className = 'q-reason';
      nameIn.placeholder = '新清单名称，如：温湿度采集板 ×10';
      const mk = el('button', 'btn sm primary', '创建');
      mk.onclick = async () => {
        const name = nameIn.value.trim();
        if (!name) return toast('请填写清单名称', 'err');
        try {
          await apiJson('/api/kits', 'POST', { name });
          closeModal(); kitsModal();
        } catch (e) { toast(e.message, 'err'); }
      };
      nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') mk.click(); });
      create.append(nameIn, mk);
      body.appendChild(create);
      const list = el('div', 'repl-list');
      if (!kits.length) body.appendChild(el('div', 'warn-empty', '还没有清单。创建一份，把做某个项目要用的料都加进来，随时查缺料、整套领用。'));
      for (const k of kits) {
        const item = el('div', 'hist-item');
        const main = el('div', 'hist-main');
        main.appendChild(el('div', 'hist-title', k.name));
        main.appendChild(el('div', 'hist-meta', `${k.item_count} 种物料 · ${fmtTime(k.updated_at)}`));
        const del = el('button', 'hist-del', '🗑');
        del.onclick = async (e) => {
          e.stopPropagation();
          if (!confirm(`删除清单「${k.name}」？（不影响库存）`)) return;
          try { await api('/api/kits/' + k.id, { method: 'DELETE' }); kitsModal(); } catch (err) { toast(err.message, 'err'); }
        };
        item.append(main, del);
        item.onclick = () => kitDetailModal(k.id);
        list.appendChild(item);
      }
      if (kits.length) body.appendChild(list);
      root.append(head, body);
    });
  })().catch((e) => toast(e.message, 'err'));
}

async function kitDetailModal(id) {
  const data = await apiGet('/api/kits/' + id);
  const { kit, items } = data;
  showModal((root) => {
    const head = modalHead('📦 ' + kit.name);
    const body = el('div', 'modal-body');

    const tools = el('div', 'd-actions');
    const chk = el('button', 'btn sm', '🔍 缺料检查');
    chk.onclick = () => kitCheckModal(id);
    const takeAll = el('button', 'btn sm primary', '整套领用');
    takeAll.title = '所有物料数量都足够时才会出库';
    takeAll.onclick = () => kitTake(id, 'all');
    const takePart = el('button', 'btn sm', '有多少扣多少');
    takePart.title = '库存不足的物料按现有数量出库';
    takePart.onclick = () => kitTake(id, 'partial');
    tools.append(chk, takeAll, takePart);
    body.appendChild(tools);

    const sec = el('div', 'section');
    sec.appendChild(el('h3', null, `物料（${items.length}）`));
    if (!items.length) sec.appendChild(el('div', 'act-note', '还没有物料，用下方搜索添加。'));
    for (const it of items) {
      const row = el('div', 'kit-row' + (it.gone ? ' gone' : ''));
      const nm = el('div', 'kit-name');
      nm.appendChild(el('div', null, it.model || it.name || '（物料已不存在）'));
      nm.appendChild(el('div', 'kit-meta', [it.lcsc_code, it.name].filter(Boolean).join(' · ') + `｜库存 ${it.stock ?? '—'}${it.unit || ''}`));
      const qty = document.createElement('input');
      qty.type = 'number'; qty.min = '1'; qty.value = it.qty; qty.className = 'q-num';
      qty.style.width = '76px';
      qty.title = '需要数量';
      qty.onchange = async () => {
        try {
          await apiJson('/api/kit-items/' + it.item_id, 'PATCH', { qty: Math.max(1, Number(qty.value) || 1) });
          toast('数量已更新', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
      const del = el('button', 'op-btn out', '移除');
      del.onclick = async () => {
        try { await api('/api/kit-items/' + it.item_id, { method: 'DELETE' }); kitDetailModal(id); } catch (e) { toast(e.message, 'err'); }
      };
      row.append(nm, qty, del);
      sec.appendChild(row);
    }
    body.appendChild(sec);

    const addSec = el('div', 'section');
    addSec.appendChild(el('h3', null, '添加物料'));
    const srow = el('div', 'stock-pad');
    const sin = document.createElement('input');
    sin.className = 'q-reason';
    sin.placeholder = '输入型号 / 名称 / 编号搜索，回车';
    const sres = el('div', 'act-note');
    let searchTimer = null;
    sin.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = sin.value.trim();
      if (!q) { sres.textContent = ''; return; }
      searchTimer = setTimeout(async () => {
        try {
          const r = await apiGet('/api/materials?size=8&q=' + encodeURIComponent(q));
          sres.textContent = '';
          if (!r.rows.length) { sres.textContent = '没有匹配的物料'; return; }
          for (const m of r.rows.slice(0, 6)) {
            const b = el('button', 'btn sm', `${(m.model || m.name || m.id).slice(0, 24)}（库存 ${m.stock}${m.unit || ''}）`);
            b.style.margin = '0 6px 6px 0';
            b.onclick = async () => {
              const q2 = prompt('需要数量：', '1');
              if (q2 === null) return;
              try {
                await apiJson('/api/kits/' + id + '/items', 'POST', { material_id: m.id, qty: Number(q2) || 1 });
                toast('已加入清单', 'ok');
                kitDetailModal(id);
              } catch (e) { toast(e.message, 'err'); }
            };
            sres.append(b);
          }
        } catch (e) { sres.textContent = '搜索失败：' + e.message; }
      }, 250);
    });
    srow.appendChild(sin);
    addSec.append(srow, sres);
    body.appendChild(addSec);

    root.append(head, body);
  });
}

async function kitCheckModal(id) {
  const c = await apiGet('/api/kits/' + id + '/check');
  showModal((root) => {
    const head = modalHead(c.ok ? '✓ 料齐，可以直接开工' : `⚠ 缺料 ${c.shortageCount} 项（共 ${c.total} 项）`);
    const body = el('div', 'modal-body');
    for (const it of c.items) {
      const cls = it.status === 'ok' ? 'st-ok' : it.status === 'low' ? 'st-low' : 'st-miss';
      const label = it.status === 'ok' ? '齐' : it.status === 'low' ? '部分缺' : (it.gone ? '已删' : '缺');
      const row = el('div', 'chk-row');
      row.appendChild(el('span', 'chk-st ' + cls, label));
      row.appendChild(el('span', 'chk-name', it.model || it.name || '（物料已不存在）'));
      row.appendChild(el('span', 'chk-nums', `需 ${it.need} / 有 ${it.have}${it.shortage ? ' · 缺 ' + it.shortage : ''}`));
      body.appendChild(row);
    }
    const miss = c.items.filter((i) => i.shortage > 0);
    if (miss.length) {
      const foot = el('div', 'form-foot');
      const aiB = el('button', 'btn primary', '🛒 AI 生成补货指令');
      aiB.onclick = () => {
        closeModal();
        openAi();
        $('#chatText').value = '以下物料需要补货，帮我从立创商城查最新资料并按建议数量入库（已有的直接加库存）：' +
          miss.map((i) => `${i.lcsc_code || i.model || i.name} 补 ${i.shortage}`).join('；');
        $('#chatText').focus();
      };
      foot.appendChild(aiB);
      body.appendChild(foot);
    }
    root.append(head, body);
  });
}

async function kitTake(id, mode) {
  const label = mode === 'all' ? '整套领用（每种物料数量都需足够）' : '部分领用（库存不足的按现有数量扣）';
  if (!confirm('确认' + label + '？将在流水中逐项记录出库。')) return;
  try {
    const out = await apiJson(`/api/kits/${id}/take`, 'POST', { mode });
    toast(`已按清单出库 ${out.deducted} 项，共 ${out.totalDeduct} 件`, 'ok');
    refreshAll();
    kitDetailModal(id);
  } catch (e) {
    const msg = e.message;
    if (msg.includes('库存不足')) {
      try {
        const c = await apiGet(`/api/kits/${id}/check`);
        const miss = c.items.filter((i) => i.status !== 'ok').map((i) => `${i.model || i.name} 缺 ${i.shortage}`).join('；');
        toast('缺料：' + miss, 'err');
        return;
      } catch { /* fallthrough */ }
    }
    toast(msg, 'err');
  }
}

/* ================= 库存价值报表 ================= */
function valueModal() {
  (async () => {
    const v = await apiGet('/api/value');
    showModal((root) => {
      const head = modalHead('💰 库存价值');
      const body = el('div', 'modal-body');
      const big = el('div', 'stock-big');
      big.appendChild(el('span', 'num', '¥' + v.ownCny.toLocaleString()));
      big.appendChild(el('span', 'qty-unit', `来料价估算（${v.priced}/${v.totalKinds} 种已登记价格）`));
      body.appendChild(big);
      const kv = el('div', 'kv');
      const rows = [
        ['物料规模', `${v.totalKinds} 种 · 共 ${v.totalQty.toLocaleString()} 件`],
        ['按币种明细', v.ownByCurrency.map((x) => `${x.currency} ${x.total.toLocaleString()}`).join('　') || '—'],
        ['立创参考价总值', `≈ ¥${v.refCny.toLocaleString()}（汇率 ${v.usdCny}）`],
        ['未登记来料价', `${v.unpriced} 种（可在编辑中补填）`]
      ];
      for (const [k, val] of rows) {
        const d = el('div');
        d.appendChild(el('dt', null, k));
        d.appendChild(el('dd', null, String(val)));
        kv.appendChild(d);
      }
      body.appendChild(kv);
      body.appendChild(el('div', 'act-note', '来料价 = 你登记的采购价合计（按币种折 CNY）；立创参考价总值仅供对照，两者独立计算。'));
      root.append(head, body);
    });
  })().catch((e) => toast(e.message, 'err'));
}

/* ================= 标签条码（Code39 生成 + 打印） ================= */
function labelModal(m) {
  showModal((root) => {
    const head = modalHead('🏷 物料标签');
    const body = el('div', 'modal-body');
    const code = (m.lcsc_code || m.model || m.id).toUpperCase().replace(/[^0-9A-Z\-\. \$\/\+%]/g, '').slice(0, 20) || 'PART';
    const box = el('div', 'label-box');
    box.innerHTML = window.code39Svg(code, { height: 64, narrow: 2, showText: true });
    body.appendChild(box);
    body.appendChild(el('div', 'act-note', `${m.name || m.model || ''}　${m.location ? '· ' + m.location : ''}\n打印后贴在料袋/料盒上，用「⌗ 扫码」即可快速定位。`));
    const foot = el('div', 'form-foot');
    const print = el('button', 'btn primary', '🖨 打印标签');
    print.onclick = () => {
      const w = window.open('', '_blank', 'width=460,height=340');
      if (!w) return toast('浏览器拦截了打印窗口', 'err');
      w.document.write(`<html><head><title>标签 ${code}</title><style>body{margin:16px;font-family:sans-serif}p{font-size:13px;margin:4px 0}</style></head><body>${box.innerHTML}<p>${(m.name || '').replace(/</g, '&lt;')}</p><p>${m.location ? '位置：' + m.location : ''}</p></body></html>`);
      w.document.close();
      w.focus();
      w.print();
    };
    const close = el('button', 'btn', '关闭');
    close.onclick = closeModal;
    foot.append(print, close);
    body.appendChild(foot);
    root.append(head, body);
  });
}

/* ================= 粘贴批量入库向导 ================= */
/* 解析立创订单/清单粘贴文本：编号 + 数量(N个) + ￥单价/个 */
function parsePastedRows(text) {
  const rows = [];
  for (const lineRaw of String(text || '').split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    const codeM = line.match(/\bC\d{4,}\b/i);
    if (!codeM) {
      rows.push({ ok: false, raw: line, reason: '未识别 C 编号' });
      continue;
    }
    const noCode = line.replace(codeM[0], ' ');
    const qtyM = noCode.match(/(\d{1,6})\s*(?:个|只|片|颗|pcs|PCS)/);
    const priceM = noCode.match(/[¥￥]\s*([\d.]+)\s*\/\s*个/);
    const qty = qtyM ? parseInt(qtyM[1], 10) : null;
    const price = priceM ? parseFloat(priceM[1]) : null;
    const cols = lineRaw.split('\t').map((c) => c.trim()).filter(Boolean);
    const model = cols.find((c) => /^[A-Za-z][\w\-.]{2,}$/i.test(c) && !/^C\d{4,}$/i.test(c)) || '';
    rows.push({
      ok: qty != null && qty > 0,
      code: codeM[0].toUpperCase(),
      qty, price, model,
      raw: line, skip: false, reason: qty == null ? '未识别数量' : ''
    });
  }
  return rows;
}

function pasteImportModal() {
  showModal((root) => {
    const head = modalHead('📥 粘贴批量入库');
    const body = el('div', 'modal-body');
    body.appendChild(el('div', 'act-note', '粘贴立创订单/购物清单文本（每行含 C 编号、数量、￥单价即可），自动核对在库状态：新物料建档入库，已有的按选择加库存并更新来料价。'));
    const ta = document.createElement('textarea');
    ta.rows = 9;
    ta.style.width = '100%';
    ta.style.fontFamily = 'var(--mono)';
    ta.placeholder = 'C29075519\tTPOWER(天源)\tTP8556N\tSOT-23-6L\t描述\t5个\t\t0.000044600\t￥0.676600/个\t￥3.38\nC49652790\tPAKER(派克微)\tRA2512F3R004G\t2512\t4mΩ ±1% 3W 编带\t10个\t\t0.000089300\t￥0.338500/个\t￥3.39';
    body.appendChild(ta);
    const foot = el('div', 'form-foot');
    const go = el('button', 'btn primary', '解析并核对');
    go.onclick = () => {
      const rows = parsePastedRows(ta.value);
      const valid = rows.filter((r) => r.ok);
      if (!valid.length) return toast('没有解析到有效的行（需含 C 编号 + 数量）', 'err');
      pastePreviewModal(valid);
    };
    foot.appendChild(go);
    body.appendChild(foot);
    root.append(head, body);
    setTimeout(() => ta.focus(), 40);
  });
}

async function pastePreviewModal(rows) {
  const codes = [...new Set(rows.map((r) => r.code))];
  const chk = await apiJson('/api/materials/check-codes', 'POST', { codes });
  const statusBy = new Map(chk.results.map((r) => [r.code, r]));
  for (const r of rows) {
    const st = statusBy.get(r.code);
    r.exists = !!(st && st.found);
    r.existing = st && st.found ? st : null;
    if (r.exists) r.action = 'add';   // 已有：默认加库存+更新来料价
  }
  showModal((root) => {
    const head = modalHead(`📥 确认入库（${rows.length} 行 · 在库 ${rows.filter((r) => r.exists).length} · 新 ${rows.filter((r) => !r.exists).length}）`);
    const body = el('div', 'modal-body');
    const list = el('div', 'paste-list');
    for (const r of rows) {
      const row = el('div', 'paste-row' + (r.ok ? '' : ' bad'));
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = r.ok && !r.skip;
      cb.onchange = () => { r.skip = !cb.checked; };
      row.appendChild(cb);
      const main = el('div', 'paste-main');
      main.appendChild(el('div', 'paste-code', r.code + (r.model ? ' · ' + r.model : '') + (r.ok ? '' : '　⚠ ' + (r.reason || '将跳过'))));
      main.appendChild(el('div', 'paste-meta', (r.ok
        ? [r.exists ? '已在库 ' + r.existing.stock + (r.existing.unit || '') : '新物料', r.price != null ? '来料价 ¥' + r.price : '', r.qty != null ? '入库 ' + r.qty : ''].filter(Boolean).join(' · ')
        : r.raw.slice(0, 60))));
      row.appendChild(main);
      if (r.ok && r.exists) {
        const sel = document.createElement('select');
        sel.className = 'f-select';
        for (const [v, t] of [['add', '加库存+更新来料价'], ['price', '仅更新来料价'], ['skip', '跳过']]) {
          const o = el('option', null, t);
          o.value = v;
          sel.appendChild(o);
        }
        sel.value = r.action;
        sel.onchange = () => { r.action = sel.value; cb.checked = r.action !== 'skip'; };
        row.appendChild(sel);
      }
      list.appendChild(row);
    }
    body.appendChild(list);
    const foot = el('div', 'form-foot');
    const prog = el('span', 'act-note');
    const ok = el('button', 'btn primary', '执行入库');
    ok.onclick = async () => {
      const todo = rows.filter((r) => r.ok && !r.skip);
      if (!todo.length) return toast('没有勾选任何行', 'err');
      ok.disabled = true;
      let done = 0, created = 0, added = 0, priced = 0;
      const errors = [];
      for (const r of todo) {
        prog.textContent = `处理中 ${done + 1}/${todo.length}：${r.code}…`;
        try {
          if (!r.exists) {
            await apiJson('/api/materials/import-lcsc', 'POST', {
              code: r.code,
              overrides: { stock: r.qty || 0, price: r.price, currency: 'CNY', supplier: '立创商城' }
            });
            created++;
          } else if (r.action === 'add') {
            if (r.qty) {
              await apiJson(`/api/materials/${r.existing.id}/stock`, 'POST', { delta: r.qty, reason: '新购到货（粘贴导入）' });
              added++;
            }
            if (r.price != null) {
              await apiJson(`/api/materials/${r.existing.id}`, 'PUT', { price: r.price, currency: 'CNY' });
              priced++;
            }
          } else if (r.action === 'price') {
            if (r.price != null) await apiJson(`/api/materials/${r.existing.id}`, 'PUT', { price: r.price, currency: 'CNY' });
            priced++;
          }
        } catch (e) {
          errors.push(r.code + '：' + e.message);
        }
        done++;
        prog.textContent = `处理中 ${done}/${todo.length}`;
        if (done % 3 === 0) await new Promise((res) => setTimeout(res, 420)); // 立创限流保护
      }
      let msg = `完成：新建 ${created}，加库存 ${added}，更新来料价 ${priced}`;
      if (errors.length) msg += `，失败 ${errors.length}（${errors[0]}）`;
      toast(msg, errors.length ? 'err' : 'ok');
      closeModal();
      refreshAll();
    };
    foot.append(prog, ok);
    body.appendChild(foot);
    root.append(head, body);
  });
}
$('#btnPaste').addEventListener('click', pasteImportModal);

/* ================= 一键同步图片 ================= */
$('#btnSyncImg').addEventListener('click', () => {
  if (!confirm('自动补齐缺失图片？\n· 有立创编号的：从立创商城拉取官方图\n· 没有的：按型号/描述从开放图库找相似图（会标注）\n每轮最多处理 80 个，可多次点击继续。')) return;
  const btn = $('#btnSyncImg');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = '同步中…';
  apiJson('/api/materials/sync-images', 'POST', { web: true })
    .then((out) => {
      toast(`图片同步完成：立创 ${out.lcsc} 张 · 网络相似 ${out.web} 张 · 未找到 ${out.failed}${out.remaining ? ' · 还有 ' + out.remaining + ' 个可继续同步' : ''}`, 'ok');
      refreshAll();
    })
    .catch((e) => toast('同步失败：' + e.message, 'err'))
    .finally(() => { btn.disabled = false; btn.textContent = original; });
});

/* ================= 顶栏动作 ================= */
$('#btnNew').addEventListener('click', () => openForm(null));
$('#btnSettings').addEventListener('click', openSettings);
$('#btnKits').addEventListener('click', kitsModal);
$('#btnValue').addEventListener('click', valueModal);
$('#btnRefreshPrices').addEventListener('click', async () => {
  const n = state.total;
  if (!n) return toast('仓库里还没有物料', 'err');
  if (!confirm(`从立创商城批量刷新全部带编号物料的参考价？\n（共 ${n} 种，逐一查询约需 ${Math.ceil(n * 0.3)} 秒；只更新立创参考价，不会改你的来料价）`)) return;
  const btn = $('#btnRefreshPrices');
  btn.disabled = true;
  toast('正在批量刷新立创参考价…', '');
  try {
    const out = await apiJson('/api/materials/refresh-all-prices', 'POST', {});
    let msg = `完成：更新 ${out.updated}/${out.total} 条参考价（汇率 ${out.usdCny}）`;
    if (out.failed && out.failed.length) msg += `，失败 ${out.failed.length} 条`;
    toast(msg, 'ok');
    refreshAll();
  } catch (e) { toast('批量刷新失败：' + e.message, 'err'); }
  finally { btn.disabled = false; }
});
$('#btnExport').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#exportMenu').classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#btnExport') && !e.target.closest('#exportMenu')) $('#exportMenu').classList.add('hidden');
});

/* ================= 刷新 ================= */
async function refreshAll() {
  try {
    await Promise.all([loadStats(), loadList()]);
    if (state.detailId) {
      try {
        const [m, ledger] = await Promise.all([apiGet(`/api/materials/${state.detailId}`), apiGet(`/api/materials/${state.detailId}/ledger`)]);
        renderDetail(m, ledger);
      } catch { /* 已删除 */ }
    }
  } catch (e) { toast('刷新失败：' + e.message, 'err'); }
}

/* ================= 启动 ================= */
(async function init() {
  try {
    apiGet('/api/fx').then((fx) => { if (fx && fx.usdCny) state.fx = fx; }).catch(() => {});
    await Promise.all([loadStats(), loadList(), ensureAiPanelReady()]);
  } catch (e) {
    toast('初始化失败：' + e.message, 'err');
    console.error(e);
  }
})();
