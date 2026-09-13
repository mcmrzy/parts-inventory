// 端到端冒烟测试（需先启动: PORT=7860 node src/server.js）
const B = process.env.BASE || 'http://127.0.0.1:7860';
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra ? ' :: ' + JSON.stringify(extra).slice(0, 300) : '')); }
}
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t, _status: r.status }; } };

async function main() {
  console.log('== 基础 ==');
  let r = await fetch(`${B}/api/health`); check('health', r.ok);
  let stats = await j(await fetch(`${B}/api/stats`)); check('stats 结构', stats.total !== undefined);

  console.log('== 物料 CRUD ==');
  const m = {
    name: '贴片电阻 10kΩ 0805', model: 'R10K0805', brand: '三星', category: '电阻', package: '0805',
    spec: '10kΩ ±1%', unit: '个', stock: 100, min_stock: 20, location: '料架A-1',
    attributes: { 阻值: '10kΩ', 精度: '±1%' }, remark: '端到端测试'
  };
  r = await fetch(`${B}/api/materials`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(m) });
  const created = await j(r);
  check('创建物料', r.status === 201 && !!created.id && created.stock === 100, created);
  const id = created.id;
  check('中文正常', created.name === '贴片电阻 10kΩ 0805', created.name);

  r = await fetch(`${B}/api/materials/${id}/stock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delta: 50, reason: '新购到货' }) });
  const st = await j(r);
  check('入库+50 → 150', st.after === 150 && st.delta === 50, st);

  r = await fetch(`${B}/api/materials/${id}/stock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delta: -30, reason: '焊接用掉' }) });
  const st2 = await j(r);
  check('出库-30 → 120', st2.after === 120, st2);

  r = await fetch(`${B}/api/materials/${id}/set-stock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stock: 200, reason: '盘点' }) });
  const st3 = await j(r);
  check('盘点修正 → 200', st3.after === 200, st3);

  r = await fetch(`${B}/api/materials/${id}/ledger`);
  const led = await j(r);
  check('流水记录数>=3', Array.isArray(led) && led.length >= 3, led && led.length);

  r = await fetch(`${B}/api/materials?q=10k`);
  const list = await j(r);
  check('搜索 q=10k 命中', list.total >= 1 && list.rows[0].id === id, list.total);

  r = await fetch(`${B}/api/materials?lowOnly=1`);
  const low = await j(r);
  check('预警接口可用', Array.isArray(low.rows), low.total);

  console.log('== 立创对接 ==');
  r = await fetch(`${B}/api/lcsc/detail?code=C1710`);
  const lc = await j(r);
  check('立创查详情 C1710', !!lc.lcsc_code && lc.productModelCode !== undefined || !!lc.model, lc && { code: lc.lcsc_code, model: lc.model, pkg: lc.package });
  check('立创品牌/封装', !!lc.brand && !!lc.package, { b: lc.brand, p: lc.package });
  check('立创属性中文', lc.attributes && lc.attributes['容值'], lc.attributes);

  r = await fetch(`${B}/api/materials/import-lcsc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'C1710', overrides: { stock: 1000, location: '立创来料区' } }) });
  const imp = await j(r);
  check('立创导入建档', r.status === 201 && imp.duplicate === false && !!imp.material.id, imp);
  const lcscId = imp.material.id;
  check('导入库存=1000', imp.material.stock === 1000, imp.material.stock);

  r = await fetch(`${B}/api/materials/import-lcsc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'C1710' }) });
  const imp2 = await j(r);
  check('重复导入识别', imp2.duplicate === true && Array.isArray(imp2.existing), imp2);

  r = await fetch(`${B}/api/lcsc/detail?code=foo`);
  check('非法编号400', r.status === 400, r.status);

  console.log('== AI 演示模式 ==');
  let chat = await j(await fetch(`${B}/api/ai/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '新增 50 个 100nF 0603 电容 村田' }) }));
  check('AI建档返回', chat.provider === 'mock' && chat.ops && chat.ops.length === 1 && chat.ops[0].op === 'create', chat);
  const demoid = chat.ops[0].id;

  chat = await j(await fetch(`${B}/api/ai/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `入库 30 个 ${demoid}`, sessionId: chat.sessionId }) }));
  check('AI入库(演示按ID)', chat.ops && chat.ops[0] && chat.ops[0].op === 'stock' && chat.ops[0].delta === 30, chat);

  chat = await j(await fetch(`${B}/api/ai/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `盘点 ${demoid} 为 66`, sessionId: chat.sessionId }) }));
  check('AI盘点(演示)', chat.ops && chat.ops[0] && chat.ops[0].op === 'set' && chat.ops[0].after === 66, chat);

  chat = await j(await fetch(`${B}/api/ai/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `删除 ${demoid}`, sessionId: chat.sessionId }) }));
  check('AI删除(演示)', chat.ops && chat.ops[0] && chat.ops[0].op === 'delete', chat);

  console.log('== 上传 / 附件 ==');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f030005fe02fea72c7d430000000049454e44ae426082', 'hex');
  const fd = new FormData();
  fd.append('image', new Blob([png], { type: 'image/png' }), 't.png');
  r = await fetch(`${B}/api/photo`, { method: 'POST', body: fd });
  const up = await j(r);
  check('照片上传', r.status === 200 && !!up.url && up.url.startsWith('/photos/'), up);

  const fd2 = new FormData();
  fd2.append('image', new Blob([png], { type: 'image/png' }), 't2.png');
  r = await fetch(`${B}/api/ai/attach`, { method: 'POST', body: fd2 });
  const att = await j(r);
  check('AI图片附件', r.status === 200 && !!att.sessionId, att);

  console.log('== 设置 ==');
  r = await fetch(`${B}/api/ai/config`);
  const cfg0 = await j(r);
  check('配置读取(mock)', cfg0.ai && cfg0.ai.provider === 'mock', cfg0);
  r = await fetch(`${B}/api/ai/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'zhichu', baseUrl: 'https://open.bigmodel.cn/api/paas/v1', model: 'glm-4.6', visionModel: 'glm-4v-plus', apiKey: 'test-key-xxx' }) });
  const cfg2 = await j(r);
  check('配置保存', cfg2.ai && cfg2.ai.model === 'glm-4.6' && cfg2.ai.apiKeySet === true, cfg2);
  // 还原初始 AI 配置（不触碰 apiKey）
  await fetch(`${B}/api/ai/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: cfg0.ai.provider, baseUrl: cfg0.ai.baseUrl, model: cfg0.ai.model, visionModel: cfg0.ai.visionModel }) });

  console.log('== 导出 ==');
  r = await fetch(`${B}/api/export?format=csv`);
  const csv = await r.text();
  check('CSV导出含表头', csv.includes('立创编号') || csv.includes('名称'), csv.slice(0, 60));
  r = await fetch(`${B}/api/export?format=json`);
  const ej = await j(r);
  check('JSON导出', ej.materials && ej.materials.length >= 2, ej.materials && ej.materials.length);

  console.log('== AI 清空（危险操作先确认） ==');
  chat = await j(await fetch(`${B}/api/ai/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '清空所有物料' }) }));
  check('清空先询问确认', (!chat.ops || chat.ops.length === 0) && /确认/.test(chat.reply || ''), chat);
  chat = await j(await fetch(`${B}/api/ai/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '确认清空', sessionId: chat.sessionId }) }));
  check('确认后执行清空', chat.ops && chat.ops[0] && chat.ops[0].op === 'clear_all', chat);
  const sEnd = await j(await fetch(`${B}/api/stats`));
  check('清空后库存为 0', sEnd.total === 0, sEnd);

  console.log(`\n结果: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('E2E 异常:', e); process.exit(2); });
