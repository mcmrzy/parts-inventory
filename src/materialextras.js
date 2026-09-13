// 物料扩展操作路由（独立模块）
// - POST /api/materials/:id/refresh-price    按立创编号刷新"立创参考价"（只写 lcsc_price，绝不改用户来料价 price）
// - POST /api/materials/refresh-all-prices   批量刷新全部带立创编号物料的参考价
// - GET  /api/fx                             当前 USD→CNY 汇率
// 安全：id 为 UUID；lcsc_code 必须匹配 C+数字才外呼；外呼目标在 lcscnet/fxrate 内锁定官方域名
import { fetchPartDetail, localizeLcscPhoto } from './lcscnet.js';
import { fetchUsdCny, usdCnyCached, toCny } from './fxrate.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, PHOTO_DIR } from './config.js';

const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const CODE_RE = /^C\d{4,}$/i;
const BATCH_GAP_MS = 450;   // 批量抓取间隔，避免触发立创限流
const BATCH_MAX = 300;      // 单次批量上限

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 补货建议量：补到 2 倍预警线（至少 +1） */
function suggestQty(m) {
  const target = Math.max(m.min_stock * 2, m.min_stock, 0);
  return Math.max(target - m.stock, 1);
}

/** 重复物料分组：同立创编号 或 同型号（忽略大小写，型号长度≥3） */
function findDuplicateGroups(db) {
  const rows = db.listMaterials({ size: 500 }).rows;
  const byCode = new Map();
  const byModel = new Map();
  for (const m of rows) {
    if (m.lcsc_code) {
      const k = 'lcsc:' + m.lcsc_code.toUpperCase();
      if (!byCode.has(k)) byCode.set(k, []);
      byCode.get(k).push(m);
    }
    const model = String(m.model || '').trim().toUpperCase();
    if (model.length >= 3) {
      const k = 'model:' + model;
      if (!byModel.has(k)) byModel.set(k, []);
      byModel.get(k).push(m);
    }
  }
  const groups = [];
  for (const [k, items] of byCode) if (items.length > 1) groups.push({ key: k, by: '立创编号', items });
  for (const [k, items] of byModel) {
    if (items.length > 1 && !groups.some((g) => g.items.some((i) => items.some((j) => j.id === i.id)))) {
      groups.push({ key: k, by: '型号', items });
    }
  }
  return groups;
}

/** @param app Express 实例 @param deps {{ db: object }} */
export function registerMaterialExtras(app, deps) {
  const { db } = deps;

  app.get('/api/fx', async (req, res, next) => {
    try {
      const fx = await fetchUsdCny(); // 首次调用即拉取实时汇率（失败自动兜底）
      res.json({ usdCny: fx.usdCny, source: fx.source, fetchedAt: fx.fetchedAt });
    } catch (e) { next(e); }
  });

  app.post('/api/materials/:id/refresh-price', async (req, res, next) => {
    try {
      const id = String(req.params.id || '');
      if (!UUID_RE.test(id)) return res.status(400).json({ error: '无效物料 ID' });
      const m = db.getMaterial(id);
      if (!m) return res.status(404).json({ error: '物料不存在' });
      if (!CODE_RE.test(String(m.lcsc_code || ''))) {
        return res.status(400).json({ error: '该物料没有有效的立创编号，无法自动获取参考价' });
      }
      const fields = await fetchPartDetail(m.lcsc_code);
      if (fields.lcsc_price == null) {
        return res.status(404).json({ error: '立创未返回该物料价格，可稍后再试' });
      }
      // 只更新参考价字段；来料价 price 保持不动
      const updated = db.updateMaterial(id, { lcsc_price: fields.lcsc_price, lcsc_currency: fields.lcsc_currency || 'USD' });
      res.json({
        ok: true,
        lcsc_price: updated.lcsc_price,
        lcsc_currency: updated.lcsc_currency,
        lcsc_price_cny: toCny(updated.lcsc_price, updated.lcsc_currency),
        price: updated.price, // 原样返回，证明未改动
        note: '已更新立创参考价（USD，最低档阶梯价），来料价不受影响'
      });
    } catch (e) { next(e); }
  });

  app.post('/api/materials/localize-photos', async (req, res, next) => {
    try {
      const rows = db.listMaterials({ size: 500 }).rows
        .filter((m) => typeof m.photo === 'string' && m.photo.startsWith('https://assets.lcsc.com/'));
      let done = 0;
      let failed = 0;
      for (const m of rows) {
        const local = await localizeLcscPhoto(m.photo, m.lcsc_code || m.id);
        if (local && local !== m.photo) {
          db.updateMaterial(m.id, { photo: local });
          done++;
        } else {
          failed++;
        }
        await sleep(150);
      }
      res.json({ ok: true, total: rows.length, localized: done, failed, note: '立创图片已转存本地 photos/ 目录' });
    } catch (e) { next(e); }
  });

  // 批量补全：对所有带立创编号的物料，从立创拉资料填补空缺字段（参数/照片/手册/参考价等）
  // 只填空缺、不覆盖已有值；逐条间隔 420ms 防限流
  app.post('/api/materials/backfill-all', async (req, res, next) => {
    try {
      const rows = db.listMaterials({ size: 500 }).rows.filter((m) => CODE_RE.test(String(m.lcsc_code || '')));
      let updated = 0;
      let skipped = 0;
      const failed = [];
      for (const m of rows) {
        const needAttrs = !m.attributes || !Object.keys(m.attributes || {}).length;
        if (!needAttrs && m.photo && m.datasheet_url && m.lcsc_price != null) { skipped++; continue; }
        try {
          const f = await fetchPartDetail(m.lcsc_code);
          const patch = {};
          for (const k of ['model', 'name', 'brand', 'category', 'package', 'spec', 'description', 'photo', 'datasheet_url', 'lcsc_url', 'supplier', 'lcsc_price', 'lcsc_currency']) {
            if (!m[k] && f[k] != null) patch[k] = f[k];
          }
          if (needAttrs && f.attributes && Object.keys(f.attributes).length) patch.attributes = f.attributes;
          if (patch.photo) patch.photo = await localizeLcscPhoto(patch.photo, m.lcsc_code);
          if (Object.keys(patch).length) {
            db.updateMaterial(m.id, patch);
            updated++;
          } else {
            skipped++;
          }
        } catch (e) {
          failed.push({ lcsc_code: m.lcsc_code, error: e.message });
        }
        await sleep(420);
      }
      res.json({ ok: true, total: rows.length, updated, skipped, failed, note: '仅填补空缺字段，来料价与已有资料不被覆盖' });
    } catch (e) { next(e); }
  });

  // ---- 补货清单：缺货/低于预警 + 建议补货量 ----
  app.get('/api/replenish', (req, res) => {
    const { rows } = db.listMaterials({ status: 'low', size: 500 });
    const outRows = db.listMaterials({ status: 'out', size: 500 }).rows;
    const seen = new Set();
    const items = [];
    for (const m of [...outRows, ...rows]) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      items.push({
        id: m.id, lcsc_code: m.lcsc_code, model: m.model, name: m.name,
        brand: m.brand, package: m.package, location: m.location,
        stock: m.stock, min_stock: m.min_stock, unit: m.unit || '个',
        suggest: suggestQty(m), out: m.out
      });
    }
    items.sort((a, b) => (b.out - a.out) || (a.stock - b.stock));
    res.json({ total: items.length, items });
  });

  // ---- 重复物料分组（数据质量检查） ----
  app.get('/api/duplicates', (req, res) => {
    res.json({ groups: findDuplicateGroups(db) });
  });

  // ---- 合并重复物料：库存累加、流水迁移、空字段互补、软删被并入者 ----
  app.post('/api/materials/merge', async (req, res, next) => {
    try {
      const { keep_id: keepId, merge_ids: mergeIds } = req.body || {};
      if (!UUID_RE.test(String(keepId || ''))) return res.status(400).json({ error: '无效的保留物料 ID' });
      if (!Array.isArray(mergeIds) || !mergeIds.length) return res.status(400).json({ error: '缺少要并入的物料' });
      const keep = db.getMaterial(keepId);
      if (!keep) return res.status(404).json({ error: '保留物料不存在' });
      let movedStock = 0;
      const mergedNames = [];
      for (const mid of mergeIds) {
        if (!UUID_RE.test(String(mid)) || mid === keepId) continue;
        const m = db.getMaterial(mid);
        if (!m) continue;
        // 空字段互补（照片优先本地图）
        const patch = {};
        for (const k of ['model', 'name', 'brand', 'category', 'package', 'spec', 'description', 'location', 'datasheet_url', 'lcsc_url']) {
          if (!keep[k] && m[k]) patch[k] = m[k];
        }
        if (!keep.photo && m.photo) patch.photo = m.photo;
        if (m.attributes && Object.keys(m.attributes).length) {
          const merged = { ...(m.attributes), ...(keep.attributes || {}) };
          patch.attributes = merged;
        }
        if (Object.keys(patch).length) db.updateMaterial(keepId, patch);
        if (m.stock > 0) {
          db.adjustStock(keepId, m.stock, `合并库存（自 ${m.model || m.name || m.lcsc_code}）`, 'merge');
          movedStock += m.stock;
        }
        db.reassignLedger(mid, keepId);
        db.updateMaterial(mid, { remark: `已并入 ${keep.model || keep.name}（合并于 ${new Date().toISOString().slice(0, 10)}）` });
        db.deleteMaterial(mid);
        mergedNames.push(m.model || m.name || m.lcsc_code || mid);
      }
      const updated = db.getMaterial(keepId);
      res.json({
        ok: true, merged: mergedNames.length, movedStock,
        material: updated,
        note: `已把 ${mergedNames.join('、')} 并入 ${updated.model || updated.name}；流水已迁移，来料价与已填资料未覆盖`
      });
    } catch (e) { next(e); }
  });

  // ---- 批量核对立创编号是否已在库（给 AI 与粘贴导入共用） ----
  app.post('/api/materials/check-codes', (req, res) => {
    const raw = (req.body && req.body.codes) || [];
    const codes = (Array.isArray(raw) ? raw : [])
      .map((c) => String(c).toUpperCase().trim())
      .filter((c) => CODE_RE.test(c))
      .slice(0, 200);
    if (!codes.length) return res.status(400).json({ error: '请提供 C 开头的编号数组' });
    const map = new Map();
    for (const m of db.listMaterials({ size: 500 }).rows) {
      if (m.lcsc_code) map.set(String(m.lcsc_code).toUpperCase(), m);
    }
    const results = codes.map((code) => {
      const m = map.get(code);
      return m
        ? { code, found: true, id: m.id, model: m.model, name: m.name, stock: m.stock, unit: m.unit || '个', location: m.location }
        : { code, found: false };
    });
    res.json({ total: codes.length, foundCount: results.filter((r) => r.found).length, results });
  });

  // ---- 补货清单 CSV 导出 ----
  app.get('/api/export/replenish', (req, res) => {
    const cell = (v) => {
      let s = v == null ? '' : String(v);
      if (/^[=+\-@]/.test(s) && !/^-\d/.test(s)) s = "'" + s;
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const { rows } = db.listMaterials({ status: 'low', size: 500 });
    const outRows = db.listMaterials({ status: 'out', size: 500 }).rows;
    const seen = new Set();
    const items = [];
    for (const m of [...outRows, ...rows]) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      items.push({ m, suggest: suggestQty(m), out: m.out });
    }
    items.sort((a, b) => (b.out - a.out) || (a.m.stock - b.m.stock));
    const header = '立创编号,型号,名称,品牌,封装,位置,当前库存,预警线,建议补货量,单位';
    const lines = items.map(({ m, suggest }) => [m.lcsc_code, m.model, m.name, m.brand, m.package, m.location, m.stock, m.min_stock, suggest, m.unit || '个'].map(cell).join(','));
    const body = '\ufeff' + [header, ...lines].join('\r\n');
    const outDir = path.join(DATA_DIR, 'exports');
    fs.mkdirSync(outDir, { recursive: true });
    const f = path.join(outDir, `replenish-${Date.now()}.csv`);
    fs.writeFileSync(f, body, 'utf8');
    res.download(f, path.basename(f), () => fs.unlink(f, () => {}));
  });

  // ---- 库存价值报表：来料价与立创参考价两条线独立折算 CNY ----
  app.get('/api/value', (req, res) => {
    const { rows } = db.listMaterials({ size: 500 });
    const own = new Map();   // 来料价按币种
    let refCny = 0, ownCny = 0, priced = 0, refPriced = 0, totalQty = 0;
    for (const m of rows) {
      totalQty += m.stock || 0;
      if (m.price != null && Number(m.price) > 0) {
        priced++;
        const cur = String(m.currency || 'CNY').toUpperCase();
        const v = Number(m.price) * (m.stock || 0);
        own.set(cur, (own.get(cur) || 0) + v);
      }
      if (m.lcsc_price != null && Number(m.lcsc_price) > 0) {
        refPriced++;
        const cny = toCny(m.lcsc_price, m.lcsc_currency || 'USD');
        if (cny != null) refCny += cny * (m.stock || 0);
      }
    }
    for (const [cur, v] of own) {
      if (cur === 'CNY') ownCny += v;
      else if (cur === 'USD') ownCny += v * usdCnyCached().usdCny;
      else ownCny += v; // 未知币种按面值计
    }
    res.json({
      totalKinds: rows.length, totalQty,
      priced, unpriced: rows.length - priced, refPriced,
      ownByCurrency: [...own.entries()].map(([currency, total]) => ({ currency, total: Math.round(total * 100) / 100 })),
      ownCny: Math.round(ownCny * 100) / 100,
      refCny: Math.round(refCny * 100) / 100,
      usdCny: usdCnyCached().usdCny
    });
  });

  // ---- 一键同步图片：立创优先，无图的网络找相似图（Openverse 开放图库） ----
  const OV_HOST = 'api.openverse.org';
  const OV_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
  // 类目 → 英文检索词（找不到型号图时的兜底）
  const CATEGORY_EN = {
    '电阻': 'resistor', '电容': 'capacitor', '电感': 'inductor coil', '二极管': 'diode electronics',
    'LED': 'led electronics', '光电器件': 'led electronics', '集成电路': 'integrated circuit chip',
    '电源管理': 'power supply circuit', 'MOSFET': 'mosfet transistor', '晶体管': 'transistor electronics',
    '晶振': 'crystal oscillator electronics', '连接器': 'electronic connector', '开关': 'switch electronics',
    '传感器': 'sensor electronics', '电池': 'battery cell', '继电器': 'relay electronics',
    '电源模块': 'power module electronics', '蜂鸣器': 'buzzer electronics', '磁珠': 'ferrite bead'
  };

  /** Openverse 搜索：返回官方缩略图代理地址列表（域名固定白名单） */
  async function openverseThumbs(query, want) {
    const q = String(query || '').replace(/[^\w\s.-]/g, ' ').trim().slice(0, 60);
    if (!q) return [];
    const u = new URL('https://api.openverse.org/v1/images/');
    u.searchParams.set('q', q);
    u.searchParams.set('page_size', '6');
    const r = await fetch(u, { headers: { 'User-Agent': 'parts-inventory/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return [];
    const d = await r.json();
    const thumbs = [];
    for (const item of (d && d.results) || []) {
      if (item && item.id && OV_ID_RE.test(item.id)) {
        thumbs.push(`https://${OV_HOST}/v1/images/${item.id}/thumb/`);
        if (thumbs.length >= want) break;
      }
    }
    return thumbs;
  }

  /** 网络相似图：型号 → 英文名 → 分类英文词，逐级尝试，每级试 3 个候选跳过死源 */
  async function webSimilarImage(m) {
    const queries = [];
    const model = String(m.model || '').trim();
    if (model) queries.push(model);
    const nameEn = String(m.name || '').replace(/[^\w\s.-]/g, ' ').trim();
    if (nameEn && /[A-Za-z]{3,}/.test(nameEn)) queries.push(nameEn);
    const catEn = CATEGORY_EN[m.category];
    if (catEn) queries.push(catEn);
    queries.push('electronic components');
    for (const q of queries.slice(0, 3)) {
      const thumbs = await openverseThumbs(q, 3);
      for (const t of thumbs) {
        const local = await downloadImage(t, 'web_' + String(m.id).slice(0, 8));
        if (local) return { photo: local, query: q };
      }
    }
    return null;
  }

  /** 下载图片：仅 https + 主机白名单格式（拒绝内网/环回/IP直连）+ 图片类型 + ≤3MB */
  async function downloadImage(url, baseName) {
    let u;
    try { u = new URL(url); } catch { return null; }
    if (u.protocol !== 'https:') return null;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(h) || /^\[?[0-9a-f:]+\]?$/.test(h) && h.includes(':') || /\.(local|internal|lan)$/.test(h)) return null;
    if (/^(10|127)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return null;
    const r = await fetch(u, { headers: { 'User-Agent': 'parts-inventory/1.0' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (!ct.startsWith('image/')) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 3 * 1024 * 1024) return null;
    const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
    const name = `${baseName}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(PHOTO_DIR, name), buf);
    return '/photos/' + name;
  }

  app.post('/api/materials/sync-images', async (req, res, next) => {
    try {
      const cap = Math.min(Math.max(Number(req.body && req.body.limit) || 80, 1), 200);
      const rows = db.listMaterials({ size: 500 }).rows;
      const targets = rows.filter((m) => !m.photo);
      const useWeb = (req.body && req.body.web) !== false;
      let lcsc = 0, web = 0, failed = 0, scanned = 0, skipped = 0;
      const failList = [];
      for (const m of targets) {
        if (scanned >= cap) { skipped++; continue; }
        scanned++;
        let got = null, method = '';
        // 1) 立创图：有编号就从立创拉
        if (/^C\d{4,}$/i.test(String(m.lcsc_code || ''))) {
          try {
            const f = await fetchPartDetail(m.lcsc_code);
            if (f.photo) {
              got = await localizeLcscPhoto(f.photo, m.lcsc_code);
              method = 'lcsc';
            }
          } catch (e) { /* 走网络相似图 */ }
        }
        // 2) 网络相似图：型号/英文名/分类英文词逐级兜底
        if (!got && useWeb) {
          try {
            const hit = await webSimilarImage(m);
            if (hit) { got = hit.photo; method = 'web'; }
          } catch (e) { /* 忽略 */ }
        }
        if (got) {
          const patch = { photo: got };
          if (method === 'web') {
            const tag = '[图片为网络相似图]';
            patch.remark = m.remark ? (m.remark.includes(tag) ? m.remark : m.remark + ' ' + tag) : tag;
          }
          db.updateMaterial(m.id, patch);
          if (method === 'lcsc') lcsc++; else web++;
        } else {
          failed++;
          if (failList.length < 10) failList.push(m.lcsc_code || m.model || m.id);
        }
        await sleep(320);
      }
      res.json({
        ok: true,
        total: targets.length, scanned, lcsc, web, failed, skipped,
        remaining: Math.max(0, targets.length - scanned),
        note: '图片来源：立创商城 / Openverse 开放图库（网络图为相似参考图，已在备注标注）'
      });
    } catch (e) { next(e); }
  });

  app.post('/api/materials/refresh-all-prices', async (req, res, next) => {
    try {
      const list = db.listMaterials({ size: BATCH_MAX }).rows.filter((m) => CODE_RE.test(String(m.lcsc_code || '')));
      if (!list.length) return res.json({ ok: true, total: 0, updated: 0, failed: [], usdCny: usdCnyCached().usdCny });
      const failed = [];
      let updated = 0;
      for (const m of list) {
        try {
          const fields = await fetchPartDetail(m.lcsc_code);
          if (fields.lcsc_price != null) {
            db.updateMaterial(m.id, { lcsc_price: fields.lcsc_price, lcsc_currency: fields.lcsc_currency || 'USD' });
            updated++;
          } else {
            failed.push({ lcsc_code: m.lcsc_code, error: '无价格数据' });
          }
        } catch (e) {
          failed.push({ lcsc_code: m.lcsc_code, error: e.message });
        }
        await sleep(BATCH_GAP_MS);
      }
      const fx = await fetchUsdCny();
      res.json({ ok: true, total: list.length, updated, failed, usdCny: fx.usdCny, note: '仅更新立创参考价，来料价不受影响' });
    } catch (e) { next(e); }
  });
}
