// AI 会话历史 API（独立路由模块）
// 安全：会话 ID 必须是 UUID 格式；所有 SQL 走参数绑定
import crypto from 'node:crypto';

const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/**
 * @param app Express 实例
 * @param deps {{ db: object, dropMemorySession: (id:string)=>void }}
 */
export function registerAiSessionRoutes(app, deps) {
  const { db, dropMemorySession } = deps;

  app.get('/api/ai/sessions', (req, res) => {
    const n = Math.min(Number(req.query.limit) || 50, 200);
    res.json(db.aiSessionsList(n));
  });

  app.get('/api/ai/sessions/:id', (req, res) => {
    const id = String(req.params.id || '');
    if (!UUID_RE.test(id)) return res.status(400).json({ error: '无效会话 ID' });
    const msgs = db.aiSessionMessages(id);
    res.json({ sessionId: id, messages: msgs });
  });

  app.delete('/api/ai/sessions/:id', (req, res) => {
    const id = String(req.params.id || '');
    if (!UUID_RE.test(id)) return res.status(400).json({ error: '无效会话 ID' });
    db.aiSessionDelete(id);
    dropMemorySession(id);
    res.json({ ok: true });
  });
}
