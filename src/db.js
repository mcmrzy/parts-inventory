// SQLite 数据层（Node 内置 node:sqlite，零外部依赖）
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { DB_PATH, ensureDirs } from './config.js';
import { facetDefs, SEMI_NAME_WORDS, KEY_NOISE } from './taxonomy.js';

let db = null;

export function uid() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

function open() {
  ensureDirs();
  db = new DatabaseSync(DB_PATH);
  db.prepare('PRAGMA journal_mode = WAL').get();
  db.prepare('PRAGMA foreign_keys = ON').get();
  // 全部为静态建表语句；外部输入永远只通过 ? 参数绑定进入查询
  const schema = [
    `CREATE TABLE IF NOT EXISTS materials (
      id            TEXT PRIMARY KEY,
      lcsc_code     TEXT,
      model         TEXT,
      name          TEXT,
      brand         TEXT,
      category      TEXT,
      package       TEXT,
      spec          TEXT,
      attributes    TEXT,
      description   TEXT,
      unit          TEXT NOT NULL DEFAULT '个',
      stock         INTEGER NOT NULL DEFAULT 0,
      min_stock     INTEGER NOT NULL DEFAULT 0,
      location      TEXT,
      price         REAL,
      currency      TEXT DEFAULT 'CNY',
      lcsc_price    REAL,
      lcsc_currency TEXT DEFAULT 'USD',
      supplier      TEXT,
      photo         TEXT,
      datasheet_url TEXT,
      lcsc_url      TEXT,
      remark        TEXT,
      deleted       INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT,
      updated_at    TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_materials_lcsc ON materials(lcsc_code)`,
    `CREATE INDEX IF NOT EXISTS idx_materials_deleted ON materials(deleted)`,
    `CREATE TABLE IF NOT EXISTS ledger (
      id          TEXT PRIMARY KEY,
      material_id TEXT,
      delta       INTEGER NOT NULL,
      after_stock INTEGER NOT NULL,
      reason      TEXT,
      source      TEXT DEFAULT 'manual',
      created_at  TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ledger_material ON ledger(material_id, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS ai_sessions (
      id         TEXT PRIMARY KEY,
      title      TEXT,
      created_at TEXT,
      updated_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS ai_messages (
      id         TEXT PRIMARY KEY,
      session_id TEXT,
      role       TEXT,
      text       TEXT,
      image_url  TEXT,
      created_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ai_messages ON ai_messages(session_id)`
  ];
  for (const s of schema) db.prepare(s).run();
  // 迁移：为旧库补充参考价列（幂等）
  const cols = db.prepare('PRAGMA table_info(materials)').all().map((c) => c.name);
  if (!cols.includes('lcsc_price')) db.prepare('ALTER TABLE materials ADD COLUMN lcsc_price REAL').run();
  if (!cols.includes('lcsc_currency')) db.prepare('ALTER TABLE materials ADD COLUMN lcsc_currency TEXT DEFAULT \'USD\'').run();
  return db;
}

export function openDb() {
  return db || open();
}

/** 简单语句执行（PRAGMA / BEGIN / COMMIT） */
function runStmt(sql) {
  return openDb().prepare(sql).run();
}

function begin() { runStmt('BEGIN'); }
function commit() { runStmt('COMMIT'); }
function rollback() { runStmt('ROLLBACK'); }

const LIST_FIELDS = `id, lcsc_code, model, name, brand, category, package, spec, attributes,
  unit, stock, min_stock, location, price, currency, lcsc_price, lcsc_currency, supplier, photo,
  datasheet_url, lcsc_url, deleted, created_at, updated_at`;

function parseRow(r) {
  if (!r) return null;
  const out = { ...r };
  if (out.attributes) {
    try { out.attributes = JSON.parse(out.attributes); } catch { out.attributes = null; }
  } else out.attributes = null;
  return out;
}

/** 统一输出（去掉 deleted，补上预警状态） */
function toApi(m) {
  if (!m) return null;
  const { deleted, ...rest } = m;
  return {
    ...rest,
    low: m.min_stock > 0 && m.stock <= m.min_stock,
    out: m.stock <= 0
  };
}

// ---------------- 物料 CRUD ----------------

/** 构造物料筛选 WHERE（excludeDim: 计算 facet 时排除自身维度） */
function buildMaterialWhere({ q = '', category = '', lowOnly = false, status = '', brand = '', pkg = '', location = '', attrPairs = null }, excludeDim = '') {
  const where = ['deleted = 0'];
  const params = [];
  if (q && q.trim()) {
    const like = `%${q.trim()}%`;
    where.push('(name LIKE ? OR model LIKE ? OR lcsc_code LIKE ? OR brand LIKE ? OR spec LIKE ? OR description LIKE ? OR location LIKE ? OR category LIKE ?)');
    params.push(like, like, like, like, like, like, like, like);
  }
  if (category) { where.push('category = ?'); params.push(category); }
  if (lowOnly || status === 'low') { where.push('(min_stock > 0 AND stock <= min_stock)'); }
  if (status === 'out') { where.push('stock <= 0'); }
  if (brand && excludeDim !== 'brand') { where.push('brand = ?'); params.push(brand); }
  if (pkg && excludeDim !== 'package') { where.push('package = ?'); params.push(pkg); }
  if (location && excludeDim !== 'location') { where.push('location = ?'); params.push(location); }
  if (attrPairs) {
    for (const [k, v] of attrPairs) {
      if (excludeDim === 'attr:' + k) continue;
      if (k === '器件类型(按名称)') {
        // 合成维度：立创参数没有该键，按名称/规格/型号关键词匹配
        where.push('(name LIKE ? OR spec LIKE ? OR model LIKE ?)');
        params.push('%' + v + '%', '%' + v + '%', '%' + v + '%');
        continue;
      }
      // key 已在服务端白名单校验；值走参数绑定
      where.push(`json_extract(attributes, '$."${k}"') = ?`);
      params.push(v);
    }
  }
  return { whereSql: where.join(' AND '), params };
}

export function listMaterials(opts = {}) {
  const d = openDb();
  const { page = 0, size = 200 } = opts;
  const { whereSql, params } = buildMaterialWhere(opts);
  const total = d.prepare(`SELECT COUNT(*) AS c FROM materials WHERE ${whereSql}`).get(...params).c;
  const rows = d.prepare(
    `SELECT ${LIST_FIELDS} FROM materials WHERE ${whereSql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
  ).all(...params, size, page * size);
  return { rows: rows.map(parseRow).map(toApi), total };
}

/** 动态细化筛选（facet）统计：按标准分类库输出 + 品牌/封装/位置 */
export function getFacets(opts = {}) {
  const d = openDb();
  const { whereSql, params } = buildMaterialWhere(opts, '');
  const rows = d.prepare(`SELECT name, model, spec, brand, package, location, attributes FROM materials WHERE ${whereSql} LIMIT 2000`).all(...params);
  const tally = (arr) => {
    const m = new Map();
    for (const v of arr) { if (v) m.set(v, (m.get(v) || 0) + 1); }
    return [...m.entries()].map(([v, n]) => ({ v, n })).sort((a, b) => b.n - a.n).slice(0, 15);
  };
  // 解析每行的属性对象
  const parsed = rows.map((r) => {
    let a = null;
    if (r.attributes) { try { a = JSON.parse(r.attributes); } catch { a = null; } }
    return { ...r, attrs: (a && typeof a === 'object') ? a : null };
  });
  const cat = String(opts.category || '').trim();
  const defs = facetDefs(cat);
  const coveredAliases = new Set();
  const attrs = {};
  // 标准字段：按库定义顺序，别名取第一个命中的来源键
  for (const [ckey, aliases] of defs) {
    if (ckey === '器件类型') continue; // 器件类型走名称合成（见后）
    const m = new Map();
    for (const r of parsed) {
      if (!r.attrs) continue;
      for (const a of aliases) {
        coveredAliases.add(a);
        if (r.attrs[a] !== undefined) {
          const v = String(r.attrs[a]).trim();
          if (v && !/^[-–—]+$/.test(v) && !/^-?\d+(\.\d+)?$/.test(v)) m.set(v, (m.get(v) || 0) + 1);
          break;
        }
      }
    }
    if (!m.size) continue;
    const cap = /类型/.test(ckey) ? 20 : 12;
    if (m.size > cap) continue;
    attrs[ckey] = [...m.entries()].map(([v, n]) => ({ v, n })).sort((a, b) => b.n - a.n).slice(0, cap);
  }
  // 兜底：未在标准库内的长尾键（最多补 3 个，按覆盖数）
  const extra = new Map();
  for (const r of parsed) {
    if (!r.attrs) continue;
    for (const [k, v] of Object.entries(r.attrs)) {
      if (coveredAliases.has(k) || KEY_NOISE.test(k) || /类型/.test(k)) continue;
      const sv = String(v).trim();
      if (!sv || /^[-–—]+$/.test(sv) || /^-?\d+(\.\d+)?$/.test(sv)) continue;
      if (!extra.has(k)) extra.set(k, new Map());
      const mm = extra.get(k);
      mm.set(sv, (mm.get(sv) || 0) + 1);
    }
  }
  const extraKeys = [...extra.entries()]
    .map(([k, mm]) => ({ k, cover: [...mm.values()].reduce((a, b) => a + b, 0), mm }))
    .filter((x) => x.mm.size <= 12)
    .sort((a, b) => b.cover - a.cover)
    .slice(0, Math.max(0, 8 - Object.keys(attrs).length));
  for (const { k, mm } of extraKeys) {
    attrs[k] = [...mm.entries()].map(([v, n]) => ({ v, n })).sort((a, b) => b.n - a.n).slice(0, 12);
  }
  // 器件类型：优先用已归一的"器件类型"；覆盖率不足时按名称关键词合成
  {
    const m = new Map();
    for (const r of parsed) {
      if (r.attrs && r.attrs['器件类型']) {
        const v = String(r.attrs['器件类型']).trim();
        if (v) m.set(v, (m.get(v) || 0) + 1);
      }
    }
    if (cat && m.size >= 2 && [...m.values()].reduce((a, b) => a + b, 0) >= Math.min(3, rows.length)) {
      attrs['器件类型'] = [...m.entries()].map(([v, n]) => ({ v, n })).sort((a, b) => b.n - a.n).slice(0, 20);
    } else if (cat && !m.size) {
      // 老数据无该字段：按名称关键词合成
      const SYNTH_KEY = '器件类型(按名称)';
      const st = new Map();
      let covered = 0;
      for (const r of parsed) {
        const hay = `${r.name || ''} ${r.model || ''}`;
        let hit = null;
        for (const w of SEMI_NAME_WORDS) { if (hay.toUpperCase().includes(w.toUpperCase())) { hit = w; break; } }
        if (hit) { st.set(hit, (st.get(hit) || 0) + 1); covered++; }
      }
      if (st.size >= 2 && covered >= 3) attrs[SYNTH_KEY] = [...st.entries()].map(([v, n]) => ({ v, n })).sort((a, b) => b.n - a.n);
    }
  }
  return {
    brand: tally(rows.map((r) => r.brand)),
    package: tally(rows.map((r) => r.package)),
    location: tally(rows.map((r) => r.location)),
    attrs
  };
}

export function getMaterial(id) {
  const d = openDb();
  const r = d.prepare(`SELECT ${LIST_FIELDS} FROM materials WHERE id = ? AND deleted = 0`).get(id);
  return toApi(parseRow(r));
}

export function getMaterialIncludingDeleted(id) {
  const d = openDb();
  const r = d.prepare(`SELECT ${LIST_FIELDS} FROM materials WHERE id = ?`).get(id);
  return parseRow(r);
}

/** 同立创编号的活跃物料（用于提示合并/直接加库存） */
export function findActiveByLcsc(code) {
  if (!code) return [];
  const d = openDb();
  return d.prepare(`SELECT ${LIST_FIELDS} FROM materials WHERE deleted = 0 AND lcsc_code = ? ORDER BY created_at ASC`).all(code).map(parseRow).map(toApi);
}

export function createMaterial(data) {
  const d = openDb();
  const id = uid();
  const t = now();
  const attrs = data.attributes && typeof data.attributes === 'object' ? JSON.stringify(data.attributes) : (data.attributes || null);
  d.prepare(`INSERT INTO materials
    (id, lcsc_code, model, name, brand, category, package, spec, attributes, description,
     unit, stock, min_stock, location, price, currency, lcsc_price, lcsc_currency, supplier, photo, datasheet_url, lcsc_url, remark, deleted, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`
  ).run(
    id, str(data.lcsc_code), str(data.model), str(data.name), str(data.brand), str(data.category),
    str(data.package), str(data.spec), attrs, str(data.description),
    data.unit || '个', int(data.stock) || 0, int(data.min_stock) || 0, str(data.location),
    data.price != null && data.price !== '' ? Number(data.price) : null,
    data.currency || 'CNY',
    data.lcsc_price != null && data.lcsc_price !== '' ? Number(data.lcsc_price) : null,
    data.lcsc_currency || (data.lcsc_price != null ? 'USD' : null),
    str(data.supplier), str(data.photo), str(data.datasheet_url),
    str(data.lcsc_url), str(data.remark), t, t
  );
  const created = getMaterial(id);
  // 初始库存也写入流水，便于追溯
  const initStock = int(data.stock) || 0;
  if (initStock !== 0) {
    d.prepare('INSERT INTO ledger (id, material_id, delta, after_stock, reason, source, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(uid(), id, initStock, initStock, data.reason || '新建建档', data.source || 'manual', t);
  }
  return created;
}

export function updateMaterial(id, data) {
  const d = openDb();
  const old = getMaterialIncludingDeleted(id);
  if (!old) return null;
  const set = [];
  const params = [];
  const cols = ['lcsc_code', 'model', 'name', 'brand', 'category', 'package', 'spec', 'description',
    'unit', 'min_stock', 'location', 'price', 'currency', 'lcsc_price', 'lcsc_currency', 'supplier', 'photo', 'datasheet_url', 'lcsc_url', 'remark'];
  for (const c of cols) {
    if (c in data) {
      set.push(`${c} = ?`);
      params.push(c === 'price' && data[c] !== '' && data[c] != null ? Number(data[c]) : str(data[c]));
    }
  }
  if ('attributes' in data) {
    set.push('attributes = ?');
    params.push(data.attributes && typeof data.attributes === 'object' ? JSON.stringify(data.attributes) : null);
  }
  if (set.length === 0) return getMaterial(id);
  set.push('updated_at = ?');
  params.push(now());
  d.prepare(`UPDATE materials SET ${set.join(', ')} WHERE id = ?`).run(...params, id);
  return getMaterial(id);
}

/** 软删除 */
export function deleteMaterial(id) {
  const d = openDb();
  const r = d.prepare('UPDATE materials SET deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0').run(now(), id);
  return r.changes > 0;
}

export function restoreMaterial(id) {
  const d = openDb();
  d.prepare('UPDATE materials SET deleted = 0, updated_at = ? WHERE id = ?').run(now(), id);
  return getMaterial(id);
}

/** 永久删除（连带流水；仅用于彻底清理） */
export function purgeMaterial(id) {
  const d = openDb();
  begin();
  try {
    d.prepare('DELETE FROM ledger WHERE material_id = ?').run(id);
    d.prepare('DELETE FROM materials WHERE id = ?').run(id);
    commit();
  } catch (e) {
    rollback();
    throw e;
  }
}

/** 清空全部物料（软删除，流水保留）。返回清空数量。 */
export function clearAllMaterials() {
  const d = openDb();
  begin();
  try {
    const cur = d.prepare('SELECT COUNT(*) AS c FROM materials WHERE deleted = 0').get().c;
    d.prepare('UPDATE materials SET deleted = 1, updated_at = ? WHERE deleted = 0').run(now());
    commit();
    return cur;
  } catch (e) {
    rollback();
    throw e;
  }
}

// ---------------- 库存变动 ----------------

export function adjustStock(id, delta, reason = '', source = 'manual') {
  const d = openDb();
  delta = Math.round(Number(delta) || 0);
  if (delta === 0) throw new Error('变动数量不能为 0');
  begin();
  try {
    const row = d.prepare('SELECT id, stock FROM materials WHERE id = ? AND deleted = 0').get(id);
    if (!row) throw new Error('物料不存在');
    const after = row.stock + delta;
    if (after < 0) throw new Error(`库存不足：当前 ${row.stock}，无法减少 ${-delta}`);
    d.prepare('UPDATE materials SET stock = ?, updated_at = ? WHERE id = ?').run(after, now(), id);
    d.prepare('INSERT INTO ledger (id, material_id, delta, after_stock, reason, source, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(uid(), id, delta, after, reason || '', source, now());
    commit();
    return { id, delta, after };
  } catch (e) {
    rollback();
    throw e;
  }
}

/** 盘点修正：直接把库存设置为某值，自动记 diff 流水 */
export function setStock(id, targetStock, reason = '', source = 'manual') {
  const d = openDb();
  targetStock = Math.max(0, Math.round(Number(targetStock) || 0));
  begin();
  try {
    const row = d.prepare('SELECT id, stock FROM materials WHERE id = ? AND deleted = 0').get(id);
    if (!row) throw new Error('物料不存在');
    const diff = targetStock - row.stock;
    d.prepare('UPDATE materials SET stock = ?, updated_at = ? WHERE id = ?').run(targetStock, now(), id);
    if (diff !== 0) {
      d.prepare('INSERT INTO ledger (id, material_id, delta, after_stock, reason, source, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(uid(), id, diff, targetStock, reason || `盘点修正(原 ${row.stock})`, source, now());
    }
    commit();
    return { id, delta: diff, after: targetStock };
  } catch (e) {
    rollback();
    throw e;
  }
}

export function getLedger(id, limit = 100) {
  const d = openDb();
  return d.prepare('SELECT * FROM ledger WHERE material_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(id, limit);
}

export function getRecentLedger(limit = 30) {
  const d = openDb();
  const rows = d.prepare(`SELECT l.*, m.name, m.model, m.unit, m.deleted AS mdeleted
     FROM ledger l LEFT JOIN materials m ON m.id = l.material_id
     ORDER BY l.created_at DESC, l.rowid DESC LIMIT ?`).all(limit);
  return rows.map((r) => ({
    id: r.id, material_id: r.material_id, delta: r.delta, after_stock: r.after_stock,
    reason: r.reason, source: r.source, created_at: r.created_at,
    title: (r.name || r.model || '未知物料')
  }));
}

// ---------------- 统计 / 分类 ----------------

export function getStats() {
  const d = openDb();
  const s = d.prepare(`
    SELECT COUNT(*) AS total,
      COALESCE(SUM(stock),0) AS totalQty,
      COALESCE(SUM(CASE WHEN stock <= 0 THEN 1 ELSE 0 END),0) AS outCount,
      COALESCE(SUM(CASE WHEN min_stock > 0 AND stock <= min_stock THEN 1 ELSE 0 END),0) AS lowCount
    FROM materials WHERE deleted = 0`).get();
  const categories = d.prepare('SELECT category, COUNT(*) AS c FROM materials WHERE deleted = 0 AND category IS NOT NULL AND category <> \'\' GROUP BY category ORDER BY c DESC').all();
  return {
    total: s.total,
    totalQty: s.totalQty,
    outCount: s.outCount,
    lowCount: s.lowCount,
    categories: categories.map((r) => r.category)
  };
}

export function exportAll() {
  const d = openDb();
  const materials = d.prepare(`SELECT ${LIST_FIELDS} FROM materials WHERE deleted = 0 ORDER BY created_at ASC`).all().map(parseRow);
  const ledger = d.prepare('SELECT * FROM ledger ORDER BY created_at ASC').all();
  return { exported_at: now(), materials, ledger };
}

// ---------------- AI 会话持久化 ----------------

export function aiSessionEnsure(id, title) {
  const d = openDb();
  const t = now();
  d.prepare('INSERT INTO ai_sessions (id, title, created_at, updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING')
    .run(id, title || null, t, t);
}

export function aiMessageAdd(sessionId, role, text, imageUrl) {
  const d = openDb();
  const t = now();
  d.prepare('INSERT INTO ai_messages (id, session_id, role, text, image_url, created_at) VALUES (?,?,?,?,?,?)')
    .run(uid(), sessionId, role, text || '', imageUrl || null, t);
  d.prepare('UPDATE ai_sessions SET updated_at = ? WHERE id = ?').run(t, sessionId);
  // 首条用户消息作为会话标题
  if (role === 'user' && text) {
    const s = d.prepare('SELECT title FROM ai_sessions WHERE id = ?').get(sessionId);
    if (s && !s.title) {
      d.prepare('UPDATE ai_sessions SET title = ? WHERE id = ?').run(String(text).replace(/\s+/g, ' ').slice(0, 24), sessionId);
    }
  }
}

export function aiSessionsList(limit = 50) {
  const d = openDb();
  return d.prepare(`
    SELECT s.id, s.title, s.created_at, s.updated_at,
      (SELECT COUNT(*) FROM ai_messages m WHERE m.session_id = s.id) AS msg_count
    FROM ai_sessions s ORDER BY s.updated_at DESC LIMIT ?`).all(limit);
}

export function aiSessionMessages(sessionId) {
  const d = openDb();
  return d.prepare('SELECT role, text, image_url AS imageUrl, created_at AS createdAt FROM ai_messages WHERE session_id = ? ORDER BY rowid ASC').all(sessionId);
}

export function aiSessionDelete(sessionId) {
  const d = openDb();
  begin();
  try {
    d.prepare('DELETE FROM ai_messages WHERE session_id = ?').run(sessionId);
    d.prepare('DELETE FROM ai_sessions WHERE id = ?').run(sessionId);
    commit();
  } catch (e) {
    rollback();
    throw e;
  }
}

/** 在线备份（不停机）：优先 node:sqlite backup API，退回 VACUUM INTO */
export function backupTo(file) {
  const d = openDb();
  if (typeof d.backup === 'function') {
    d.backup(file);
    return 'backup';
  }
  const safe = String(file).replace(/'/g, "''"); // 路径由服务端自生成，仅做转义
  d.prepare(`VACUUM INTO '${safe}'`).run();
  return 'vacuum';
}

/** 合并物料：把 from 的流水迁移到 to 名下（保留历史可追溯） */
export function reassignLedger(fromId, toId) {
  openDb().prepare('UPDATE ledger SET material_id = ? WHERE material_id = ?').run(toId, fromId);
}

// ---------------- 工具 ----------------
function str(v) {
  return v == null || v === '' ? null : String(v);
}
function int(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}
