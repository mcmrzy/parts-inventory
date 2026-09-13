// Kit/BOM 清单路由（独立模块）
// 一份清单 = 一组物料 + 数量（如"做 10 块某板子要的料"）
// 支持缺料检查与整套领用（全部扣 / 有多少扣多少）
import crypto from 'node:crypto';

const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

function ensureSchema(db) {
  const d = db.openDb();
  const stmts = [
    `CREATE TABLE IF NOT EXISTS kits (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      note TEXT,
      created_at TEXT,
      updated_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS kit_items (
      id TEXT PRIMARY KEY,
      kit_id TEXT NOT NULL,
      material_id TEXT NOT NULL,
      qty INTEGER NOT NULL DEFAULT 1,
      created_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_kit_items ON kit_items(kit_id)`
  ];
  for (const s of stmts) d.prepare(s).run();
}

/** @param app Express @param deps {{ db: object }} */
export function registerKitRoutes(app, deps) {
  const { db } = deps;
  ensureSchema(db);

  const touch = (id) => db.openDb().prepare('UPDATE kits SET updated_at = ? WHERE id = ?').run(now(), id);

  // 清单列表
  app.get('/api/kits', (req, res) => {
    const d = db.openDb();
    const rows = d.prepare(`
      SELECT k.id, k.name, k.note, k.created_at, k.updated_at,
        (SELECT COUNT(*) FROM kit_items i WHERE i.kit_id = k.id) AS item_count
      FROM kits k ORDER BY k.updated_at DESC`).all();
    res.json(rows);
  });

  // 新建清单
  app.post('/api/kits', (req, res, next) => {
    try {
      const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
      if (!name) return res.status(400).json({ error: '请填写清单名称' });
      const note = String((req.body && req.body.note) || '').slice(0, 200);
      const id = uid();
      const d = db.openDb();
      d.prepare('INSERT INTO kits (id, name, note, created_at, updated_at) VALUES (?,?,?,?,?)').run(id, name, note, now(), now());
      res.status(201).json({ id, name, note, item_count: 0 });
    } catch (e) { next(e); }
  });

  // 清单详情（含物料行；已删除/不存在的物料行标记 missing）
  app.get('/api/kits/:id', (req, res, next) => {
    try {
      const id = String(req.params.id || '');
      if (!UUID_RE.test(id)) return res.status(400).json({ error: '无效清单 ID' });
      const d = db.openDb();
      const kit = d.prepare('SELECT * FROM kits WHERE id = ?').get(id);
      if (!kit) return res.status(404).json({ error: '清单不存在' });
      const items = d.prepare(`
        SELECT i.id AS item_id, i.material_id, i.qty,
          m.model, m.name, m.lcsc_code, m.unit, m.stock, m.location, m.price, m.currency, m.deleted AS mdeleted
        FROM kit_items i LEFT JOIN materials m ON m.id = i.material_id
        WHERE i.kit_id = ? ORDER BY i.rowid ASC`).all(id);
      res.json({
        kit,
        items: items.map((r) => ({
          item_id: r.item_id, material_id: r.material_id, qty: r.qty,
          model: r.model, name: r.name, lcsc_code: r.lcsc_code,
          unit: r.unit || '个', stock: r.stock, location: r.location,
          price: r.price, currency: r.currency,
          gone: r.model == null ? 1 : 0
        }))
      });
    } catch (e) { next(e); }
  });

  // 改名/备注
  app.patch('/api/kits/:id', (req, res, next) => {
    try {
      const id = String(req.params.id || '');
      if (!UUID_RE.test(id)) return res.status(400).json({ error: '无效清单 ID' });
      const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
      const note = String((req.body && req.body.note) || '').slice(0, 200);
      if (!name) return res.status(400).json({ error: '请填写清单名称' });
      db.openDb().prepare('UPDATE kits SET name = ?, note = ?, updated_at = ? WHERE id = ?').run(name, note, now(), id);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // 删除清单（连带条目）
  app.delete('/api/kits/:id', (req, res, next) => {
    try {
      const id = String(req.params.id || '');
      if (!UUID_RE.test(id)) return res.status(400).json({ error: '无效清单 ID' });
      const d = db.openDb();
      d.prepare('DELETE FROM kit_items WHERE kit_id = ?').run(id);
      d.prepare('DELETE FROM kits WHERE id = ?').run(id);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // 添加物料行
  app.post('/api/kits/:id/items', (req, res, next) => {
    try {
      const id = String(req.params.id || '');
      if (!UUID_RE.test(id)) return res.status(400).json({ error: '无效清单 ID' });
      const materialId = String((req.body && req.body.material_id) || '');
      const qty = Math.max(1, Math.round(Number(req.body && req.body.qty) || 1));
      if (!UUID_RE.test(materialId)) return res.status(400).json({ error: '无效物料 ID' });
      const d = db.openDb();
      if (!db.getMaterial(materialId)) return res.status(404).json({ error: '物料不存在' });
      if (!d.prepare('SELECT id FROM kits WHERE id = ?').get(id)) return res.status(404).json({ error: '清单不存在' });
      const exist = d.prepare('SELECT id, qty FROM kit_items WHERE kit_id = ? AND material_id = ?').get(id, materialId);
      if (exist) {
        d.prepare('UPDATE kit_items SET qty = qty + ? WHERE id = ?').run(qty, exist.id);
      } else {
        d.prepare('INSERT INTO kit_items (id, kit_id, material_id, qty, created_at) VALUES (?,?,?,?,?)').run(uid(), id, materialId, qty, now());
      }
      touch(id);
      res.status(201).json({ ok: true });
    } catch (e) { next(e); }
  });

  // 修改数量
  app.patch('/api/kit-items/:itemId', (req, res, next) => {
    try {
      const itemId = String(req.params.itemId || '');
      if (!/^[\da-f-]{16,}$/i.test(itemId)) return res.status(400).json({ error: '无效条目 ID' });
      const qty = Math.round(Number(req.body && req.body.qty));
      if (!Number.isFinite(qty) || qty < 1) return res.status(400).json({ error: '数量必须 ≥ 1' });
      const d = db.openDb();
      const row = d.prepare('SELECT kit_id FROM kit_items WHERE id = ?').get(itemId);
      if (!row) return res.status(404).json({ error: '条目不存在' });
      d.prepare('UPDATE kit_items SET qty = ? WHERE id = ?').run(qty, itemId);
      touch(row.kit_id);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // 删除条目
  app.delete('/api/kit-items/:itemId', (req, res, next) => {
    try {
      const itemId = String(req.params.itemId || '');
      if (!/^[\da-f-]{16,}$/i.test(itemId)) return res.status(400).json({ error: '无效条目 ID' });
      const d = db.openDb();
      const row = d.prepare('SELECT kit_id FROM kit_items WHERE id = ?').get(itemId);
      d.prepare('DELETE FROM kit_items WHERE id = ?').run(itemId);
      if (row) touch(row.kit_id);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // 缺料检查
  app.get('/api/kits/:id/check', (req, res, next) => {
    try {
      const id = String(req.params.id || '');
      if (!UUID_RE.test(id)) return res.status(400).json({ error: '无效清单 ID' });
      const d = db.openDb();
      const rows = d.prepare(`
        SELECT i.id AS item_id, i.qty, m.id AS material_id, m.model, m.name, m.lcsc_code,
          m.stock, m.unit, m.location, m.deleted AS mdeleted
        FROM kit_items i LEFT JOIN materials m ON m.id = i.material_id
        WHERE i.kit_id = ? ORDER BY i.rowid ASC`).all(id);
      const items = rows.map((r) => {
        const have = r.mdeleted ? 0 : (r.stock || 0);
        const shortage = Math.max(0, r.qty - have);
        return {
          item_id: r.item_id, material_id: r.material_id,
          model: r.model, name: r.name, lcsc_code: r.lcsc_code,
          unit: r.unit || '个', location: r.location,
          need: r.qty, have, shortage,
          status: r.mdeleted ? 'missing' : (shortage > 0 ? (have > 0 ? 'low' : 'missing') : 'ok')
        };
      });
      const shortageCount = items.filter((i) => i.status !== 'ok').length;
      res.json({ ok: shortageCount === 0, shortageCount, total: items.length, items });
    } catch (e) { next(e); }
  });

  // 整套领用（出库并记账）：mode=all 需要全部够；partial 有多少扣多少
  app.post('/api/kits/:id/take', async (req, res, next) => {
    try {
      const id = String(req.params.id || '');
      if (!UUID_RE.test(id)) return res.status(400).json({ error: '无效清单 ID' });
      const mode = (req.body && req.body.mode) === 'partial' ? 'partial' : 'all';
      const kit = db.openDb().prepare('SELECT name FROM kits WHERE id = ?').get(id);
      if (!kit) return res.status(404).json({ error: '清单不存在' });
      const d = db.openDb();
      const rows = d.prepare(`
        SELECT i.qty, m.id AS material_id, m.stock, m.model, m.name, m.deleted AS mdeleted
        FROM kit_items i LEFT JOIN materials m ON m.id = i.material_id
        WHERE i.kit_id = ? ORDER BY i.rowid ASC`).all(id);
      const lines = [];
      const insufficient = [];
      for (const r of rows) {
        if (r.mdeleted || !r.material_id) continue;
        const deduct = mode === 'partial' ? Math.min(r.qty, Math.max(0, r.stock || 0)) : r.qty;
        if ((r.stock || 0) < r.qty) insufficient.push(`${r.model || r.name}（有 ${r.stock} 需 ${r.qty}）`);
        if (deduct > 0) lines.push({ material_id: r.material_id, deduct, label: r.model || r.name });
      }
      if (mode === 'all' && insufficient.length) {
        return res.status(409).json({ error: '库存不足，无法整套领用', insufficient });
      }
      for (const l of lines) {
        db.adjustStock(l.material_id, -l.deduct, `整套领用：${kit.name}`, 'kit');
      }
      res.json({ ok: true, mode, deducted: lines.length, totalDeduct: lines.reduce((a, b) => a + b.deduct, 0), insufficient: mode === 'partial' ? insufficient : [] });
    } catch (e) { next(e); }
  });
}
