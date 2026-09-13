// 物料管家 · 服务端入口
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ROOT, loadConfig, saveConfig, publicConfig, getAiConfig, ensureDirs, DATA_DIR, PHOTO_DIR } from './config.js';
import * as db from './db.js';
import * as ai from './ai.js';
import { runAgent } from './agent.js';
import { extractCode, detailToFields } from './lcsc.js';
import { localizeLcscPhoto } from './lcscnet.js';
import { registerAiSessionRoutes } from './aisessions.js';
import { registerMaterialExtras } from './materialextras.js';
import { registerKitRoutes } from './kits.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '5m' }));
app.use('/photos', express.static(path.join(ROOT, 'photos'), { maxAge: '1d' }));

// ---------------- 可选访问口令（PI_TOKEN 环境变量） ----------------
// 设置后：/api 与 /photos 都要求携带口令（请求头 x-token 或查询参数 ?token=）
// 页面本身公开；前端会弹窗索要一次并保存在浏览器 localStorage
const ACCESS_TOKEN = String(process.env.PI_TOKEN || '').trim();
if (ACCESS_TOKEN) {
  const a = Buffer.from(ACCESS_TOKEN);
  const tokenOk = (req) => {
    const t = Buffer.from(String(req.get('x-token') || req.query.token || '').trim());
    return t.length === a.length && crypto.timingSafeEqual(t, a);
  };
  app.use(['/api', '/photos'], (req, res, next) => {
    if (tokenOk(req)) return next();
    res.status(401).json({ error: '需要访问口令（请刷新页面输入）', code: 'TOKEN_REQUIRED' });
  });
  console.log('[security] 已启用访问口令（PI_TOKEN）');
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

// 物料 API
app.get('/api/stats', (req, res) => res.json(db.getStats()));
app.get('/api/categories', (req, res) => res.json(db.getStats().categories));
app.get('/api/activity', (req, res) => res.json(db.getRecentLedger(Math.min(Number(req.query.limit) || 12, 60))));
/** 细化筛选参数解析（白名单校验，防止任意 JSON path 注入） */
const ATTR_KEY_RE = /^[\w\u4e00-\u9fa5 ()%±./·+-]{1,24}$/;
function parseFacetParams(query) {
  const s = (v) => String(v || '').slice(0, 60);
  let attrPairs = null;
  if (query.attrs) {
    try {
      const o = JSON.parse(String(query.attrs));
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        attrPairs = Object.entries(o).slice(0, 5)
          .map(([k, v]) => [String(k), String(v).slice(0, 60)])
          .filter(([k, v]) => ATTR_KEY_RE.test(k) && k && v);
        if (!attrPairs.length) attrPairs = null;
      }
    } catch { /* 忽略非法 attrs */ }
  }
  return {
    brand: s(query.brand),
    pkg: s(query.package),
    location: s(query.location),
    attrPairs
  };
}

app.get('/api/materials', (req, res) => {
  const { q = '', category = '', lowOnly = '', status = '', page = 0, size = 200 } = req.query;
  res.json(db.listMaterials({
    q, category, lowOnly: lowOnly === '1' || lowOnly === 'true', status,
    ...parseFacetParams(req.query),
    page: Number(page) || 0, size: Math.min(Number(size) || 200, 500)
  }));
});

// 细化筛选的取值统计（基于当前已选条件）
app.get('/api/facets', (req, res) => {
  const { q = '', category = '', lowOnly = '', status = '' } = req.query;
  res.json(db.getFacets({
    q, category, lowOnly: lowOnly === '1' || lowOnly === 'true', status,
    ...parseFacetParams(req.query)
  }));
});
app.get('/api/materials/:id', (req, res) => {
  const m = db.getMaterial(req.params.id);
  if (!m) return res.status(404).json({ error: '物料不存在' });
  res.json(m);
});
app.get('/api/materials/:id/ledger', (req, res) => res.json(db.getLedger(req.params.id)));
app.post('/api/materials', (req, res, next) => {
  try {
    const data = req.body || {};
    if (!data.model && !data.name) return res.status(400).json({ error: '至少需要填型号或名称' });
    const m = db.createMaterial({ ...data, source: 'manual' });
    res.status(201).json(m);
  } catch (e) { next(e); }
});
app.put('/api/materials/:id', (req, res, next) => {
  try {
    const m = db.updateMaterial(req.params.id, req.body || {});
    if (!m) return res.status(404).json({ error: '物料不存在' });
    res.json(m);
  } catch (e) { next(e); }
});
app.delete('/api/materials/:id', (req, res) => {
  const ok = db.deleteMaterial(req.params.id);
  if (!ok) return res.status(404).json({ error: '物料不存在或已删除' });
  res.json({ ok: true });
});
app.post('/api/materials/:id/stock', (req, res, next) => {
  try {
    const { delta = 0, reason = '' } = req.body || {};
    const r = db.adjustStock(req.params.id, Number(delta), reason, 'manual');
    const m = db.getMaterial(r.id);
    res.json({ ...r, material: m });
  } catch (e) { next(e); }
});
app.post('/api/materials/:id/set-stock', (req, res, next) => {
  try {
    const { stock = 0, reason = '' } = req.body || {};
    const r = db.setStock(req.params.id, Number(stock), reason, 'manual');
    const m = db.getMaterial(r.id);
    res.json({ ...r, material: m });
  } catch (e) { next(e); }
});

// 图片上传：仅收内存、MIME 白名单
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file && ALLOWED_MIME.has(file.mimetype)) cb(null, true);
    else cb(new Error('仅支持图片文件（jpg/png/webp/gif/bmp）'));
  }
});

// ---------------- AI 会话存储（内存 + SQLite 持久化） ----------------
const sessions = new Map(); // id -> {history:[{role,text,imageKey,imageUrl}], pendingImage, last}
const sessionImages = new Map(); // imageKey -> {buf, mime}
const SESSION_TTL = 4 * 3600 * 1000;

function getSession(id) {
  if (!id || !sessions.has(id)) return null;
  return sessions.get(id);
}
/** 内存会话过期后，从数据库恢复历史（图片仅保留展示地址） */
function reviveSession(id) {
  const hit = getSession(id);
  if (hit) return hit;
  const msgs = db.aiSessionMessages(id);
  if (!msgs.length) return null;
  const s = {
    history: msgs.map((m) => ({ role: m.role, text: m.text, imageKey: null, imageUrl: m.imageUrl })),
    pendingImage: null, last: Date.now()
  };
  sessions.set(id, s);
  return s;
}
function newSession() {
  const id = crypto.randomUUID();
  sessions.set(id, { history: [], pendingImage: null, last: Date.now() });
  db.aiSessionEnsure(id, null);
  return id;
}
function cleanupSessions() {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.last > SESSION_TTL) sessions.delete(k);
}
setInterval(cleanupSessions, 30 * 60 * 1000).unref();
function storeImage(buf, mime) {
  const key = crypto.randomUUID();
  sessionImages.set(key, { buf, mime });
  setTimeout(() => sessionImages.delete(key), 20 * 60 * 1000).unref();
  return key;
}
function llmMessages(session) {
  // 只送最近 24 条进模型（完整历史仍保留展示），降低长会话时的推理延迟
  const recent = session.history.length > 24 ? session.history.slice(-24) : session.history;
  const lastIdx = session.history.length - 1;
  const msgs = [];
  for (let i = 0; i < recent.length; i++) {
    const h = recent[i];
    if (h.role !== 'user' && h.role !== 'assistant') continue;
    const content = [{ type: 'text', text: h.text || '' }];
    if (h.imageKey && recent[i] === session.history[lastIdx]) {
      const img = sessionImages.get(h.imageKey);
      if (img) content.push(ai.imagePart(img.buf, img.mime));
    }
    msgs.push({ role: h.role, content });
  }
  return msgs;
}

// ---------------- 立创商城数据获取（固定常量地址 + 主机白名单断言） ----------------
const LCSC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const LCSC_API_HOST = 'wmsc.lcsc.com';
const LCSC_DETAIL_ENDPOINT = new URL('https://wmsc.lcsc.com/ftps/wm/product/detail');

function httpError(status, msg) {
  const e = new Error(msg);
  e.statusCode = status;
  return e;
}

function requireCode(raw) {
  const code = extractCode(raw);
  if (!code) throw httpError(400, '无法识别立创编号，请输入 C 开头的编号（如 C1710）或商品链接');
  return code;
}

/** 按立创编号查询：URL 由固定常量构造，编号仅进入查询参数；请求前做主机白名单断言 */
async function lcscLookup(code) {
  const c = requireCode(code);
  if (!/^C\d{4,}$/.test(c)) throw httpError(400, '无效编号');
  const target = new URL(LCSC_DETAIL_ENDPOINT.href);
  target.searchParams.set('productCode', c);
  if (target.hostname !== LCSC_API_HOST || target.protocol !== 'https:') {
    throw httpError(403, '目标地址不在白名单内');
  }
  let res;
  try {
    res = await fetch(target, {
      headers: { 'User-Agent': LCSC_UA, Referer: 'https://www.lcsc.com/', Accept: 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(15000)
    });
  } catch (e) {
    throw httpError(502, '无法连接立创商城（网络错误），请检查网络后重试，或手动填写物料。');
  }
  if (!res.ok) throw httpError(502, `立创接口返回 HTTP ${res.status}`);
  const data = await res.json().catch(() => null);
  if (!data || data.code !== 200 || !data.result) {
    const msg = (data && data.code === 200)
      ? '该编号在立创商城没有查到数据（可能已下架或编号有误）'
      : `立创查询失败：${(data && data.msg) || '接口限流，请稍后重试'}`;
    throw httpError(400, msg);
  }
  const fields = detailToFields(data.result);
  if (!fields || !fields.lcsc_code) throw httpError(404, '该编号未查询到有效物料，请核对后重试');
  return fields;
}

// ---------------- 立创商城 API（直接引用原图地址，不在服务端下载图片） ----------------
app.get('/api/lcsc/detail', async (req, res, next) => {
  try {
    const code = requireCode(req.query.code || '');
    const mapped = await lcscLookup(code);
    const dups = db.findActiveByLcsc(mapped.lcsc_code);
    res.json({ ...mapped, already_exists: dups.length > 0, existing: dups });
  } catch (e) { next(e); }
});

app.post('/api/materials/import-lcsc', async (req, res, next) => {
  try {
    const { overrides = {} } = req.body || {};
    const code = requireCode(req.body && req.body.code);
    const mapped = await lcscLookup(code);
    const dups = db.findActiveByLcsc(mapped.lcsc_code);
    if (dups.length) {
      return res.status(200).json({ duplicate: true, existing: dups, mapped });
    }
    // 图片转存本地（立创图床有防盗链，远程地址时常刷不出来）
    mapped.photo = await localizeLcscPhoto(mapped.photo, mapped.lcsc_code);
    const m = db.createMaterial({ ...mapped, ...overrides, stock: overrides.stock ?? 0, source: 'lcsc' });
    res.status(201).json({ duplicate: false, material: m });
  } catch (e) { next(e); }
});

// ---------------- 本地照片上传 ----------------
app.post('/api/photo', upload.single('image'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '没有收到图片文件' });
    const mime = ALLOWED_MIME.has(req.file.mimetype) ? req.file.mimetype : 'image/jpeg';
    const ext = mime.split('/')[1].replace('jpeg', 'jpg');
    const name = `photo_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(PHOTO_DIR, name), req.file.buffer);
    res.json({ ok: true, url: '/photos/' + name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AI 拍照识别入口：上传待发送图片，可挂到已有会话（formData 字段 sessionId），随下一条消息发送
app.post('/api/ai/attach', upload.single('image'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '没有收到图片文件' });
    const mime = ALLOWED_MIME.has(req.file.mimetype) ? req.file.mimetype : 'image/jpeg';
    const wantSid = String((req.body && req.body.sessionId) || '');
    let sid;
    if (/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(wantSid) && reviveSession(wantSid)) {
      sid = wantSid;
    } else {
      sid = newSession();
    }
    const s = getSession(sid);
    const key = storeImage(req.file.buffer, mime);
    // 图片同时落盘 photos/，历史会话里也能显示
    const ext = (mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg').split(';')[0];
    const imgName = `ai_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(PHOTO_DIR, imgName), req.file.buffer);
    const imgUrl = '/photos/' + imgName;
    s.pendingImage = { key, url: imgUrl, name: req.file.originalname || 'photo.jpg' };
    res.json({ ok: true, sessionId: sid, name: s.pendingImage.name, url: imgUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------- 设置 / AI 配置 ----------------
registerMaterialExtras(app, { db });
registerKitRoutes(app, { db });
registerAiSessionRoutes(app, {
  db,
  dropMemorySession: (id) => sessions.delete(id)
});
app.get('/api/ai/config', (req, res) => res.json(publicConfig()));

app.post('/api/ai/config', (req, res, next) => {
  try {
    const patch = { ai: { ...(req.body || {}) } };
    if (!patch.ai.apiKey || patch.ai.apiKey === '******') delete patch.ai.apiKey; // 空/脱敏值 = 不修改
    if (patch.ai.provider === 'mock') patch.ai.apiKey = '';
    saveConfig(patch);
    res.json(publicConfig());
  } catch (e) { next(e); }
});

app.post('/api/ai/test', async (req, res, next) => {
  try {
    const out = await ai.testConnection(getAiConfig());
    res.json(out);
  } catch (e) { next(e); }
});

// 发送对话（文本，可携带上一张待发送图片；会话历史持久化到 SQLite）
app.post('/api/ai/chat', async (req, res, next) => {
  try {
    const { sessionId, text = '' } = req.body || {};
    if (!String(text).trim()) return res.status(400).json({ error: '消息不能为空' });
    const cfg = getAiConfig();
    if (!ai.isConfigured(cfg)) {
      return res.status(400).json({ error: '尚未配置 AI：请先到右上角“设置”里选择服务商并填入 API Key，或切到“演示模式”。' });
    }
    const wantSid = String(sessionId || '');
    const validSid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(wantSid);
    let sid;
    if (validSid && reviveSession(wantSid)) sid = wantSid;
    else if (validSid && db.aiSessionMessages(wantSid).length) sid = wantSid; // 空内存但库里有
    else sid = newSession();
    const s = getSession(sid);

    const pending = s.pendingImage;
    s.pendingImage = null;
    s.history.push({ role: 'user', text: String(text).trim(), imageKey: pending ? pending.key : null, imageUrl: pending ? pending.url : null });
    db.aiMessageAdd(sid, 'user', String(text).trim(), pending ? pending.url : null);

    const msgs = llmMessages(s);
    const result = await runAgent(cfg, msgs, {});
    s.history.push({ role: 'assistant', text: result.reply });
    db.aiMessageAdd(sid, 'assistant', result.reply, null);
    if (s.history.length > 60) s.history = s.history.slice(-60);
    res.json({ sessionId: sid, reply: result.reply, ops: result.ops || [], provider: cfg.provider });
  } catch (e) { next(e); }
});

// ---------------- 每日自动备份（保留 14 天，在线快照不停机） ----------------
const BACKUP_KEEP = 14;
function runBackup() {
  try {
    const dir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const n = new Date();
    const day = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
    const f = path.join(dir, `inventory-${day}.db`);
    if (!fs.existsSync(f)) {
      db.backupTo(f);
      const files = fs.readdirSync(dir).filter((x) => /^inventory-\d{4}-\d{2}-\d{2}\.db$/.test(x)).sort();
      while (files.length > BACKUP_KEEP) fs.unlinkSync(path.join(dir, files.shift()));
      console.log('[backup] 数据库已备份 →', path.basename(f));
    }
  } catch (e) {
    console.warn('[backup] 备份失败（不影响主流程）:', e.message);
  }
}

// 导出（CSV 落临时文件后 res.download；JSON 用 res.json）
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@]/.test(s) && !/^-\d/.test(s)) s = "'" + s; // 防公式注入
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
app.get('/api/export', (req, res, next) => {
  try {
    const { format = 'json' } = req.query;
    const data = db.exportAll();
    if (format === 'csv') {
      const cols = ['名称', '型号', '立创编号', '品牌', '分类', '封装', '规格', '库存', '单位', '预警下限', '位置', '参考价', '币种', '供应商', '备注', '创建时间'];
      const header = cols.map(csvCell).join(',');
      const lines = data.materials.map((m) => [m.name, m.model, m.lcsc_code, m.brand, m.category, m.package, m.spec, m.stock, m.unit, m.min_stock, m.location, m.price, m.currency, m.supplier, m.remark, m.created_at].map(csvCell).join(','));
      const body = '\ufeff' + [header, ...lines].join('\r\n');
      const outDir = path.join(DATA_DIR, 'exports');
      fs.mkdirSync(outDir, { recursive: true });
      const f = path.join(outDir, `materials-${Date.now()}.csv`);
      fs.writeFileSync(f, body, 'utf8');
      res.download(f, path.basename(f), () => fs.unlink(f, () => {}));
    } else {
      res.set('Content-Disposition', `attachment; filename="inventory-${Date.now()}.json"`);
      res.json(data);
    }
  } catch (e) { next(e); }
});

app.use((req, res) => res.status(404).json({ error: '接口不存在' }));
app.use((err, req, res, next) => {
  console.error('[server]', err && err.message);
  res.status(err && err.statusCode ? err.statusCode : 500).json({ error: err && err.message ? err.message : '服务器内部错误' });
});

ensureDirs();
db.openDb();
runBackup();
setInterval(runBackup, 6 * 3600 * 1000).unref();
const cfg = loadConfig();
const port = Number(process.env.PORT || cfg.server.port || 7860);
const host = process.env.HOST || cfg.server.host || '127.0.0.1';
app.listen(port, host, () => {
  const acfg = cfg.ai;
  const mode = acfg.provider === 'mock' ? '演示模式（本地模拟AI，不联网）' : (acfg.model || '未配置 Key');
  console.log('==============================================');
  console.log('  物料管家 已启动');
  console.log(`  本机访问:  http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  console.log(`  AI 模式:  ${mode}`);
  console.log(`  数据目录:  ${path.join(__dirname, '..', 'data')}`);
  console.log('  停止: 在窗口按 Ctrl+C');
  console.log('==============================================');
});
