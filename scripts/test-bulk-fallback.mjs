// bulk 兜底路径测试（网络受限场景）
const B = 'http://127.0.0.1:7901';
(async () => {
  const codes = ['C1525','C25543','C25552','C25530','C25879','C25905','C25139','C7467248','C46961737','C46635894','C1710','C1711','C1712','C54431701','C54431702','C54431703','C54431704','C54431705','C54431699','C3000141'];
  const msg = '以下 20 个立创编号全部建档入库，每个 10 个，一次处理完不要分批：' + codes.join('、');
  const t0 = Date.now();
  const c = await (await fetch(B + '/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: msg }) })).json();
  console.log('耗时', ((Date.now() - t0) / 1000).toFixed(0) + 's');
  const bulk = (c.ops || []).find((o) => o.op === 'bulk');
  console.log('bulk op:', JSON.stringify(bulk || '无'));
  console.log('reply尾部:', (c.reply || '').slice(-120).replace(/\n+/g, ' | '));
  const s = await (await fetch(B + '/api/stats')).json();
  console.log('入库后种类:', s.total, '（应 20）');
  const list = await (await fetch(B + '/api/materials?size=1&q=C1525')).json();
  if (list.rows[0]) {
    const m = list.rows[0];
    console.log('抽验 C1525: stock=' + m.stock, '| remark=' + (m.remark ? '有标注' : '无'), '| model=' + (m.model || '空(基础档)'));
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
