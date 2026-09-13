// AI Agent：把用户自然语言/照片指令转换成库存数据库操作
// 真实模式：OpenAI 兼容工具调用循环；provider=mock 时走本地演示解析（不联网）
import * as ai from './ai.js';
import * as db from './db.js';
import * as lcscnet from './lcscnet.js';
import { AI_PRESETS } from './config.js';

export const SYSTEM_PROMPT = `你是"物料管家"的 AI 助手，负责管理用户的电子元器件/物料库存系统。根据用户的中文指令，调用工具完成：新增物料建档、查询物料、增加/减少库存、盘点修正库存、删除物料等，并用简体中文简洁回复。

必须遵守：
1. 新增物料时尽力提取：型号(model，如 CL21B103KBANNNC / STM32F103C8T6 / 10kΩ 0805 电阻)、数量、单位；尽量给出品牌/封装/分类/规格；无法确定的字段留空，绝不编造型号或参数。
2. 数量增减必须明确。用户只含糊说"入库100"但没指明哪个物料时：先调用 search_material；若唯一匹配就执行并说明；多个候选则列出请用户选择，不得擅自选。**带 C 编号的指令不要先 search**——adjust_stock/set_stock/delete_material 都直接支持 lcsc_code，一步到位；本地没有该编号要新建时，create_material 只传 lcsc_code+stock 就会自动补全立创资料。
   批量编号核对（用户一次给多个编号问"入库了吗/在不在/哪些没有"）：**必须调用 check_codes 一次性核对**，然后分"已在库 / 不在库"两份清单汇报，绝不允许跳过工具凭印象回答，也不要逐个 search。
3. 入库=delta 为正（reason 写来源如"新购到货"），出库/领用/使用=delta 为负（reason 如实写，如"焊接用掉"）。库存不可为负，工具会校验。
4. 识别图片（料盘标签/丝印/包装袋）时：只填能确定的字段；不确定处要说明"此字段不确定，建议人工核对"。
5. 立创编号是 C+数字，如 C5137636。处理原则：
   - 用户说"入库/加 N 个 Cxxxx"或"建档/录入 Cxxxx"，而本地没有该编号时：**不要反问用户，直接执行**——先调用 lcsc_lookup 从立创商城拉取该编号的型号/品牌/封装/参数等资料，再用 create_material 建档（lcsc_code 与拉取到的字段一并填写，stock=N），一步完成。若 lcsc_lookup 失败（网络/无效编号），才说明原因并询问是否仅用编号建档。
   - 本地已有该编号：直接 adjust_stock 增加/减少库存即可，不要重复建档。
   - 建档时把 lcsc_lookup 返回的字段（model/name/brand/category/package/spec/attributes/photo/datasheet_url 等）**尽量完整**传给 create_material，让档案信息齐全。
   - 用户只是问"这是什么编号/查一下 Cxxxx"：调用 lcsc_lookup 并告知结果即可，不改动库存。
6. 仅当用户明确表达删除时才 delete_material，删除前必须能唯一确定目标。
7. 用户说"清空/全部删除/删掉所有物料"时：这是危险批量操作，**必须先向用户确认**，得到明确的"确认清空/清空吧/确定"等答复后，再以 confirm=true 调用 clear_all_materials；第一轮只能询问确认并告知会清空多少种物料，不要直接执行。
8. 系统已经提供足够工具（建档/查询/出入库/盘点/删除/清空），不要说自己"没有这个能力"；如果某指令确实无法一步完成，请说明卡在哪并给出可执行的下一条建议。
9. 回复格式：先一句话概括执行结果，再按需给出注意事项或下一步建议。不要输出 JSON，只说自然语言。
10. 修改/补全已有物料：update_material 可修改任意字段；若物料带有立创编号但缺照片/参数/数据手册/参考价等资料，优先用 lcsc_backfill 自动从立创商城补全——默认只填空缺字段不覆盖已有值，用户明确说"覆盖/重新拉取/刷新价格"时才 overwrite=true。
    价格有两条独立线，绝不能混：price=用户的来料价（用户报多少填多少，通常 CNY）；lcsc_price=立创参考价（来自立创国内站，人民币含税参考价）。任何立创刷新/补全都只写 lcsc_price，永远不改 price；用户说"来料价改成 X"只改 price。补全后提醒用户图片会立即显示在卡片上。
11. 批量任务（一次建档/操作很多个编号）：
    - 尽量在一条回复里**并行发起多个工具调用**（一次 tool_calls 携带多个 invoke），减少轮数；
    - 每批建议 8~15 个，执行完一批就用文字小结进度，并请用户回复"继续"处理下一批；
    - 严禁把工具调用以任何文本/标记形式写在回复正文里，调用必须走工具通道。`;

// ---------------- 工具定义（OpenAI tools 格式） ----------------
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_material',
      description: '按关键词搜索现有物料。当用户说入库/出库/删除/有没有某个物料，但没给唯一编号时，用它找候选。',
      parameters: {
        type: 'object',
        properties: {
          keywords: { type: 'string', description: '搜索词，如型号、品牌、规格、立创编号、存放位置等' },
          limit: { type: 'integer', description: '最多返回几条，默认 5' }
        },
        required: ['keywords']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'lcsc_lookup',
      description: '按 C 开头编号（如 C5137636）从立创商城查询物料资料，返回型号/品牌/封装/参数等。用于：用户给编号要建档或入库但本地没有该编号时自动补全资料；或用户想了解某个编号是什么物料。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '立创编号，C 开头，如 C1710' }
        },
        required: ['code']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_codes',
      description: '批量核对立创编号是否已在库。用户一次给出多个编号问"入库了吗/在不在库/哪些没有"时，必须用本工具一次性核对（codes 传编号数组），不要逐个 search_material，更不要凭记忆判断。',
      parameters: {
        type: 'object',
        properties: {
          codes: { type: 'array', items: { type: 'string' }, description: '立创编号数组，如 ["C60490","C25543"]' }
        },
        required: ['codes']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_material',
      description: '新增一条物料档案（可带初始库存）。建档时 lcsc_code(立创编号 Cxxxx)如有务必填写。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '物料显示名，如：贴片电阻 10kΩ 0805' },
          model: { type: 'string', description: '厂家型号，如 CL21B103KBANNNC' },
          lcsc_code: { type: 'string', description: '立创商城编号，C 开头' },
          brand: { type: 'string', description: '品牌，如 三星/国巨/ST/村田' },
          category: { type: 'string', description: '分类，如：电阻/电容/电感/集成电路/二极管/连接器/其他' },
          package: { type: 'string', description: '封装/尺寸，如 0805、SOT-23、LQFP48' },
          spec: { type: 'string', description: '关键规格一句话，如 10kΩ ±1% 1/8W' },
          description: { type: 'string', description: '补充描述' },
          attributes: { type: 'object', description: '结构化参数，键用中文（lcsc_lookup 返回的 attributes 请原样传入），如 {"容值":"100nF","精度":"±10%"}', additionalProperties: { type: 'string' } },
          photo: { type: 'string', description: '物料照片地址（lcsc_lookup 返回的 photo 如有请带上）' },
          datasheet_url: { type: 'string', description: '数据手册链接（lcsc_lookup 返回的 datasheet_url）' },
          lcsc_url: { type: 'string', description: '立创商城商品页链接（lcsc_lookup 返回的 lcsc_url）' },
          unit: { type: 'string', description: '计量单位，默认 个；整盘可用 卷' },
          stock: { type: 'integer', description: '初始库存数量，没提就 0' },
          min_stock: { type: 'integer', description: '最低库存预警线，没提就 0' },
          location: { type: 'string', description: '存放位置，如 料架A-3' },
          price: { type: 'number', description: '来料单价——用户自己登记的采购/成本价。用户报多少就填多少，币种用 currency' },
          currency: { type: 'string', description: '来料价币种，默认 CNY' },
          lcsc_price: { type: 'number', description: '立创参考价（来自 lcsc_lookup 的 lcsc_price），不要把用户报价填这里' },
          lcsc_currency: { type: 'string', description: '立创参考价币种，通常 USD' },
          supplier: { type: 'string', description: '供应商，如 立创商城' },
          remark: { type: 'string', description: '备注' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'adjust_stock',
      description: '增加或减少某物料库存并记账。入库为正数，出库为负数。material_id 和 lcsc_code 二选一，有立创编号时直接传 lcsc_code（免搜索，更快）。',
      parameters: {
        type: 'object',
        properties: {
          material_id: { type: 'string', description: '物料 ID（与 lcsc_code 二选一）' },
          lcsc_code: { type: 'string', description: '立创编号，如 C1710（推荐，免搜索）' },
          delta: { type: 'integer', description: '库存变动量：入库 +N，出库 -N' },
          reason: { type: 'string', description: '变动原因，如：新购到货/焊接用掉' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_stock',
      description: '盘点：直接把某物料库存修正为指定值（自动记录差额流水）。material_id 和 lcsc_code 二选一。',
      parameters: {
        type: 'object',
        properties: {
          material_id: { type: 'string' },
          lcsc_code: { type: 'string', description: '立创编号（推荐）' },
          stock: { type: 'integer', description: '盘点后的实际数量' },
          reason: { type: 'string', description: '盘点原因' }
        },
        required: ['stock']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_material',
      description: '删除（软删除）某个物料档案。material_id 和 lcsc_code 二选一。',
      parameters: {
        type: 'object',
        properties: {
          material_id: { type: 'string' },
          lcsc_code: { type: 'string', description: '立创编号（推荐）' },
          reason: { type: 'string', description: '删除原因' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_material',
      description: '修改已有物料档案的字段（名称/型号/品牌/分类/封装/规格/单位/预警线/位置/价格/供应商/照片/链接/参数/备注等）。只需传要改的字段。',
      parameters: {
        type: 'object',
        properties: {
          material_id: { type: 'string', description: '物料 ID' },
          name: { type: 'string' }, model: { type: 'string' }, brand: { type: 'string' },
          category: { type: 'string' }, package: { type: 'string' }, spec: { type: 'string' },
          description: { type: 'string' }, unit: { type: 'string' },
          min_stock: { type: 'integer', description: '预警下限' },
          location: { type: 'string' }, price: { type: 'number' }, currency: { type: 'string' },
          supplier: { type: 'string' }, remark: { type: 'string' },
          photo: { type: 'string', description: '照片地址（/photos/… 或 https://…）' },
          datasheet_url: { type: 'string' }, lcsc_code: { type: 'string' }, lcsc_url: { type: 'string' },
          attributes: { type: 'object', description: '结构化参数（整体替换）', additionalProperties: { type: 'string' } },
          reason: { type: 'string', description: '修改原因（仅记录用）' }
        },
        required: ['material_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'lcsc_backfill',
      description: '按物料的立创编号，从立创商城自动补全该物料缺失的资料（照片/型号/品牌/分类/封装/规格/参数/数据手册等）。默认只填空缺字段、不覆盖已有值；用户明确要求覆盖时才传 overwrite=true。物料必须有 lcsc_code。',
      parameters: {
        type: 'object',
        properties: {
          material_id: { type: 'string', description: '物料 ID' },
          overwrite: { type: 'boolean', description: '是否覆盖已有字段（默认 false，只补空缺）' }
        },
        required: ['material_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'clear_all_materials',
      description: '清空库存：一次性删除（软删除）全部物料档案。危险批量操作：第一轮调用只能返回"待确认"信息，绝不能直接执行；必须先向用户确认，得到用户明确的"确认清空/清空吧/确定清空"等答复后，才能以 confirm=true 再次调用并真正执行。',
      parameters: {
        type: 'object',
        properties: {
          confirm: { type: 'boolean', description: '是否已获得用户明确确认（默认 false）' },
          reason: { type: 'string', description: '清空原因（用户提供时填写）' }
        },
        required: ['confirm']
      }
    }
  }
];

function itemShort(m) {
  return { id: m.id, lcsc_code: m.lcsc_code, model: m.model, name: m.name, brand: m.brand, package: m.package, category: m.category, spec: m.spec, stock: m.stock, unit: m.unit, min_stock: m.min_stock, location: m.location };
}

/** material_id / lcsc_code 二选一解析物料（省一轮搜索） */
function resolveMaterial(args) {
  if (args.material_id) {
    const m = db.getMaterial(String(args.material_id));
    return m ? { m } : { error: '物料不存在（material_id 无效）' };
  }
  const code = String(args.lcsc_code || '').trim().toUpperCase();
  if (/^C\d{4,}$/.test(code)) {
    const found = db.listMaterials({ q: code, size: 5 }).rows.filter((m) => (m.lcsc_code || '').toUpperCase() === code);
    if (found.length === 1) return { m: found[0] };
    if (found.length > 1) return { error: `编号 ${code} 匹配到 ${found.length} 条物料，请让用户明确指定`, candidates: found.map(itemShort) };
    return { error: `本地没有编号 ${code} 的物料；若要新建，直接调 create_material 只传 lcsc_code 即可自动补全立创资料` };
  }
  return { error: '缺少 material_id 或 lcsc_code' };
}

function searchTool(args) {
  const kw = String(args.keywords || '').trim();
  if (!kw) return { ok: false, error: '缺少搜索关键词' };
  const res = db.listMaterials({ q: kw, size: Math.min(Number(args.limit) || 5, 10) });
  return { ok: true, total: res.total, items: res.rows.slice(0, Math.min(Number(args.limit) || 5, 10)).map(itemShort) };
}

async function createTool(args) {
  const code = args.lcsc_code ? String(args.lcsc_code).trim().toUpperCase() : null;
  if (code && !/^C\d{4,}$/.test(code)) return { ok: false, error: 'lcsc_code 格式应为 C+数字' };
  if (code) {
    const dup = db.findActiveByLcsc(code);
    if (dup.length) {
      return {
        ok: false, code: 'DUPLICATE_LCSC', error: `该立创编号 ${code} 已存在`,
        existing: dup.map(itemShort)
      };
    }
  }
  const base = { ...args };
  const hasInfo = !!(str(args.model) || str(args.name));
  if (code && !hasInfo) {
    // 只给了编号：自动拉立创资料补全（含图片本地化）
    try {
      const p = await lcscnet.fetchPartDetail(code);
      const { _lcsc, ...fields } = p;
      Object.assign(base, fields, args);
      if (!base.attributes || !Object.keys(base.attributes).length) base.attributes = fields.attributes || null;
      base.photo = await lcscnet.localizeLcscPhoto(fields.photo, code);
    } catch (e) {
      return { ok: false, error: `从立创拉取资料失败：${e.message}。可至少提供 name 或 model 后重试` };
    }
  } else if (base.photo) {
    base.photo = await lcscnet.localizeLcscPhoto(String(base.photo), code || str(args.model));
  }
  if (!str(base.model) && !str(base.name)) return { ok: false, error: '缺少型号(model)或名称(name)，无法建档' };
  const m = db.createMaterial({ ...base, lcsc_code: code || null, source: 'ai' });
  return { ok: true, material: itemShort(m) };
}

function adjustTool(args) {
  const delta = Math.round(Number(args.delta) || 0);
  if (!delta) return { ok: false, error: 'delta 必须为非零整数' };
  const r0 = resolveMaterial(args);
  if (r0.error) return { ok: false, ...r0 };
  const m = r0.m;
  try {
    const r = db.adjustStock(m.id, delta, str(args.reason) || '', 'ai');
    return { ok: true, result: r, material: itemShort(db.getMaterial(r.id) || m) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function setTool(args) {
  const r0 = resolveMaterial(args);
  if (r0.error) return { ok: false, ...r0 };
  try {
    const r = db.setStock(r0.m.id, Math.max(0, Math.round(Number(args.stock) || 0)), str(args.reason) || '', 'ai');
    return { ok: true, result: r, material: itemShort(db.getMaterial(r.id) || r0.m) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function deleteTool(args) {
  const r0 = resolveMaterial(args);
  if (r0.error) return { ok: false, ...r0 };
  const m = r0.m;
  db.deleteMaterial(m.id);
  return { ok: true, deleted: itemShort(m), reason: str(args.reason) };
}

function clearAllTool(args) {
  const total = db.getStats().total;
  if (!args || args.confirm !== true) {
    return {
      ok: false,
      need_confirm: true,
      total,
      error: `这是危险操作：将一次性清空全部 ${total} 种物料。请先向用户确认（如"确认清空"），收到明确答复后再以 confirm=true 调用本工具。`
    };
  }
  const cleared = db.clearAllMaterials();
  return { ok: true, cleared, total };
}

async function lcscLookupTool(args) {
  const code = String(args && args.code || '').trim();
  if (!/^C\d{4,}$/i.test(code)) return { ok: false, error: '请提供有效的 C 开头编号' };
  try {
    const fields = await lcscnet.fetchPartDetail(code);
    return { ok: true, part: lcscnet.partSummary(fields) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function checkCodesTool(args) {
  const codes = (Array.isArray(args && args.codes) ? args.codes : [])
    .map((c) => String(c).toUpperCase().trim())
    .filter((c) => /^C\d{4,}$/.test(c))
    .slice(0, 200);
  if (!codes.length) return { ok: false, error: '请提供 C 开头的编号数组' };
  const map = new Map();
  for (const m of db.listMaterials({ size: 500 }).rows) {
    if (m.lcsc_code) map.set(String(m.lcsc_code).toUpperCase(), m);
  }
  const found = [];
  const missing = [];
  for (const code of [...new Set(codes)]) {
    const m = map.get(code);
    if (m) found.push({ code, id: m.id, model: m.model, name: m.name, stock: m.stock, unit: m.unit || '个', location: m.location });
    else missing.push(code);
  }
  return { ok: true, total: codes.length, foundCount: found.length, missingCount: missing.length, found, missing };
}

function updateTool(args) {
  const id = String(args.material_id || '');
  const m = db.getMaterial(id);
  if (!m) return { ok: false, error: '物料不存在' };
  const allowed = ['name', 'model', 'brand', 'category', 'package', 'spec', 'description', 'unit',
    'location', 'currency', 'supplier', 'remark', 'photo', 'datasheet_url', 'lcsc_code', 'lcsc_url'];
  const patch = {};
  for (const k of allowed) {
    if (args[k] != null && args[k] !== '') patch[k] = String(args[k]);
  }
  if (args.min_stock != null) patch.min_stock = Math.max(0, Math.round(Number(args.min_stock) || 0));
  if (args.price != null && args.price !== '') patch.price = Number(args.price) || 0;
  if (args.attributes && typeof args.attributes === 'object' && Object.keys(args.attributes).length) {
    patch.attributes = args.attributes;
  }
  if (!Object.keys(patch).length) return { ok: false, error: '没有提供任何要修改的字段' };
  const updated = db.updateMaterial(id, patch);
  return { ok: true, changed: Object.keys(patch), material: itemShort(updated) };
}

async function backfillTool(args) {
  const id = String(args.material_id || '');
  const m = db.getMaterial(id);
  if (!m) return { ok: false, error: '物料不存在' };
  if (!m.lcsc_code) return { ok: false, error: '该物料没有立创编号（lcsc_code），无法自动补全。可先用 update_material 补上编号再试。' };
  let fields;
  try {
    fields = await lcscnet.fetchPartDetail(m.lcsc_code);
  } catch (e) {
    return { ok: false, error: '从立创拉取资料失败：' + e.message };
  }
  const overwrite = args.overwrite === true;
  const patch = {};
  const keys = ['model', 'name', 'brand', 'category', 'package', 'spec', 'description', 'photo', 'datasheet_url', 'lcsc_url', 'supplier', 'lcsc_price', 'lcsc_currency'];
  for (const k of keys) {
    if (overwrite || !m[k]) {
      if (fields[k]) patch[k] = fields[k];
    }
  }
  if (fields.attributes && Object.keys(fields.attributes).length) {
    if (overwrite || !m.attributes || !Object.keys(m.attributes).length) patch.attributes = fields.attributes;
  }
  if (patch.photo) {
    patch.photo = await lcscnet.localizeLcscPhoto(patch.photo, m.lcsc_code);
  }
  if (!Object.keys(patch).length) {
    return { ok: true, filled: 0, note: '资料已齐全，没有需要补充的字段', material: itemShort(m) };
  }
  const updated = db.updateMaterial(id, patch);
  return { ok: true, filled: Object.keys(patch).length, fields: Object.keys(patch), material: itemShort(updated) };
}

async function runTool(name, rawArgs) {
  let args = rawArgs;
  if (typeof rawArgs === 'string') {
    try { args = JSON.parse(rawArgs || '{}'); } catch { args = {}; }
  }
  args = args || {};
  switch (name) {
    case 'search_material': return searchTool(args);
    case 'lcsc_lookup': return lcscLookupTool(args);
    case 'check_codes': return checkCodesTool(args);
    case 'create_material': return createTool(args);
    case 'adjust_stock': return adjustTool(args);
    case 'set_stock': return setTool(args);
    case 'delete_material': return deleteTool(args);
    case 'update_material': return updateTool(args);
    case 'lcsc_backfill': return backfillTool(args);
    case 'clear_all_materials': return clearAllTool(args);
    default: return { ok: false, error: `未知工具 ${name}` };
  }
}

function str(v) { return v == null ? '' : String(v).trim(); }

/** 单条工具结果转 ops 摘要（供前端展示） */
function opFromTool(name, out) {
  if (!out || !out.ok) return null;
  if (name === 'create_material') {
    const m = out.material;
    return { op: 'create', id: m.id, title: m.model || m.name, code: m.lcsc_code, stock: m.stock, unit: m.unit };
  }
  if (name === 'adjust_stock') {
    const m = out.material || {};
    return { op: 'stock', id: out.result.id, title: m.model || m.name, delta: out.result.delta, after: out.result.after, unit: m.unit };
  }
  if (name === 'set_stock') {
    const m = out.material || {};
    return { op: 'set', id: out.result.id, title: m.model || m.name, after: out.result.after, unit: m.unit };
  }
  if (name === 'delete_material') {
    const m = out.deleted;
    return { op: 'delete', id: m.id, title: m.model || m.name };
  }
  if (name === 'clear_all_materials') {
    return { op: 'clear_all', cleared: out.cleared };
  }
  if (name === 'update_material') {
    const m = out.material || {};
    return { op: 'update', id: m.id, title: m.model || m.name, changed: (out.changed || []).join('、') };
  }
  if (name === 'lcsc_backfill') {
    const m = out.material || {};
    return { op: 'backfill', id: m.id, title: m.model || m.name, filled: out.filled, fields: (out.fields || []).join('、') };
  }
  return null;
}

/**
 * 本地快车道：常见确定性指令（入库/出库/盘点/删除/查编号 + C编号）不经过大模型，
 * 直接操作数据库，毫秒级返回；不匹配或带图片时返回 null 走正常 AI 链路。
 */
function lastUserText(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.role !== 'user') continue;
    if (Array.isArray(h.content)) {
      const hasImage = h.content.some((p) => p && p.type === 'image_url');
      const txt = h.content.filter((p) => p && p.type === 'text').map((p) => p.text).join(' ');
      return { text: txt.trim(), hasImage };
    }
    return { text: String(h.content || '').trim(), hasImage: false };
  }
  return { text: '', hasImage: false };
}

function fmtMat(m) { return m.model || m.name || (m.lcsc_code ? '编号 ' + m.lcsc_code : '物料'); }

async function tryFastLocal(history) {
  const { text, hasImage } = lastUserText(history);
  if (hasImage || !text || text.length > 40) return null;
  const t = text.replace(/^(请|帮我|麻烦)+/g, '').trim();
  const codes = t.match(/\bC\d{4,}\b/gi) || [];
  if (codes.length !== 1) return null;          // 无编号或多编号 → 交给 AI
  const code = codes[0].toUpperCase();
  const tNoCode = t.replace(codes[0], ' ');      // 剔除编号后再找数量，避免把编号里的数字当数量
  const numM = tNoCode.match(/(\d{1,7})\s*(个|只|片|颗|卷|盘|pcs|PCS)?/);
  const findByCode = () => db.listMaterials({ q: code, size: 5 }).rows.filter((m) => (m.lcsc_code || '').toUpperCase() === code);

  // —— 入库 ——
  if (/^(入库|进料|补货|增加库存)/.test(t)) {
    if (!numM) return null;
    const qty = parseInt(numM[1], 10);
    if (!qty) return null;
    const found = findByCode();
    if (found.length === 1) {
      const m = found[0];
      try {
        const r = db.adjustStock(m.id, qty, '入库', 'local');
        return { reply: `⚡ 已入库 ${qty}${m.unit || '个'}：${fmtMat(m)}，当前库存 ${r.after}${m.unit || ''}。`, ops: [{ op: 'stock', id: m.id, title: m.model || m.name, delta: r.delta, after: r.after, unit: m.unit }] };
      } catch (e) {
        return { reply: `入库失败：${e.message}`, ops: [] };
      }
    }
    if (found.length > 1) return null;
    // 本地没有 → 立创建档+入库（拉立创资料，图片转存本地）
    try {
      const p = await lcscnet.fetchPartDetail(code);
      p.photo = await lcscnet.localizeLcscPhoto(p.photo, code);
      const rec = db.createMaterial({ ...p, stock: qty, source: 'local' });
      return {
        reply: `⚡ 本地无此编号，已自动从立创建档并入库 ${qty}${rec.unit}：${rec.model || rec.name}（${code}），当前库存 ${rec.stock}${rec.unit}。`,
        ops: [{ op: 'create', id: rec.id, title: rec.model || rec.name, code: rec.lcsc_code, stock: rec.stock, unit: rec.unit }]
      };
    } catch (e) {
      return { reply: `本地没有 ${code}，且从立创拉取资料失败：${e.message}`, ops: [] };
    }
  }

  // —— 出库 ——
  if (/^(出库|领用|用掉|消耗)/.test(t)) {
    if (!numM) return null;
    const qty = parseInt(numM[1], 10);
    if (!qty) return null;
    const found = findByCode();
    if (found.length !== 1) return null;
    const m = found[0];
    try {
      const r = db.adjustStock(m.id, -qty, '出库', 'local');
      return { reply: `⚡ 已出库 ${qty}${m.unit || '个'}：${fmtMat(m)}，当前库存 ${r.after}${m.unit || ''}。`, ops: [{ op: 'stock', id: m.id, title: m.model || m.name, delta: r.delta, after: r.after, unit: m.unit }] };
    } catch (e) {
      return { reply: `出库失败：${e.message}`, ops: [] };
    }
  }

  // —— 盘点修正 ——
  if (/^盘点/.test(t)) {
    const setM = t.match(/(?:为|改成|设为|到)\s*(\d{1,7})/);
    if (!setM || !code) return null;
    const found = findByCode();
    if (found.length !== 1) return null;
    const m = found[0];
    const r = db.setStock(m.id, parseInt(setM[1], 10), '盘点修正', 'local');
    return { reply: `⚡ 已将 ${fmtMat(m)} 库存修正为 ${r.after}${m.unit || ''}（${r.delta >= 0 ? '+' : ''}${r.delta}）。`, ops: [{ op: 'set', id: m.id, title: m.model || m.name, after: r.after, unit: m.unit }] };
  }

  // —— 删除 ——
  if (/^删除/.test(t)) {
    const found = findByCode();
    if (found.length !== 1) return null;
    const m = found[0];
    db.deleteMaterial(m.id);
    return { reply: `⚡ 已删除物料：${fmtMat(m)}（${code}）。`, ops: [{ op: 'delete', id: m.id, title: m.model || m.name }] };
  }

  // —— 查编号 ——
  if (/^(查|查找|查一下|查查|搜索)/.test(t) && !numM) {
    const found = findByCode();
    if (found.length) {
      const m = found[0];
      return { reply: `⚡ ${code}：${fmtMat(m)}｜${m.brand || ''} ${m.package || ''}｜库存 ${m.stock}${m.unit || ''}${m.location ? '｜位置 ' + m.location : ''}。`, ops: [] };
    }
    try {
      const p = await lcscnet.fetchPartDetail(code);
      return { reply: `⚡ ${code}（本地未建档）：${p.name}｜${p.brand || ''} ${p.package || ''}｜立创参考价 $${p.lcsc_price}。需要建档请说：入库 N 个 ${code}`, ops: [] };
    } catch (e) {
      return { reply: `${code} 本地没有，立创也查不到：${e.message}`, ops: [] };
    }
  }
  return null;
}

/**
 * 运行 Agent（真实工具循环）。history 由调用方持有：末尾需要是本次 user 消息。
 * 返回 {reply, ops}
 * 兜底：部分推理模型在轮次压力下会把内部 DSML 调用标记当正文输出，
 *      这里将其解析回真正的工具调用继续执行，绝不丢动作。
 */
const DSML_TOKEN = /[｜|]{2}\s*DSML\s*[｜|]{2}/;
const DSML_INVOKE_RE = /[｜|]{2}\s*DSML\s*[｜|]{2}\s*invoke\s+name="([\w]+)"([\s\S]*?)<\s*\/\s*[｜|]{2}\s*DSML\s*[｜|]{2}\s*invoke\s*>/g;
const DSML_PARAM_RE = /[｜|]{2}\s*DSML\s*[｜|]{2}\s*parameter\s+name="(\w+)"[^>]*>([\s\S]*?)<\s*\/\s*[｜|]{2}\s*DSML\s*[｜|]{2}\s*parameter\s*>/g;
const DSML_TAG_RE = /<\s*\/?\s*[｜|]{2}\s*DSML\s*[｜|]{2}\s*\/?\s*(?:tool_calls|invoke|parameter)[^>]*>/g;

function parseDsmlCalls(text) {
  const calls = [];
  if (!text) return calls;
  DSML_TOKEN.lastIndex = 0;
  if (!DSML_TOKEN.test(text)) return calls;
  let i = 0;
  for (const m of text.matchAll(DSML_INVOKE_RE)) {
    const name = m[1];
    const body = m[2] || '';
    const args = {};
    for (const pm of body.matchAll(DSML_PARAM_RE)) {
      args[pm[1]] = pm[2].trim();
    }
    calls.push({
      id: 'dsml_' + Date.now() + '_' + i,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) }
    });
    i++;
  }
  return calls;
}

function stripDsml(text) {
  if (!text) return '';
  DSML_INVOKE_RE.lastIndex = 0;
  DSML_TAG_RE.lastIndex = 0;
  return text.replace(DSML_INVOKE_RE, '').replace(DSML_TAG_RE, '').trim();
}

/** 执行一批工具调用并写入消息历史 */
async function execToolCalls(messages, calls, ops) {
  messages.push({ role: 'assistant', content: null, tool_calls: calls });
  for (const tc of calls) {
    const fn = tc.function || {};
    let out;
    try {
      out = await runTool(fn.name, fn.arguments);
    } catch (e) {
      out = { ok: false, error: e.message }; // 工具异常交给 AI 说明，不让整个请求挂掉
    }
    const op = opFromTool(fn.name, out);
    if (op) ops.push(op);
    messages.push({
      role: 'tool',
      tool_call_id: tc.id,
      content: JSON.stringify(out, null, 0)
    });
  }
}

export async function runAgent(cfg, history, { maxTurns = 40 } = {}) {
  if (!ai.isConfigured(cfg)) {
    return {
      reply: '还没有配置 AI。请点右上角“设置”，选择服务商并填入 API Key；或用“演示模式”先体验流程。',
      ops: []
    };
  }
  if (cfg.provider === 'mock') return runMock(cfg, history);

  // 快车道：确定性指令免 AI，毫秒级返回
  try {
    const fast = await tryFastLocal(history);
    if (fast) return fast;
  } catch (e) { /* 快车道任何异常都降级走 AI */ }

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history];
  const ops = [];
  let reply = null;
  for (let turn = 0; turn < maxTurns; turn++) {
    const hasImage = lastHasImage(messages);
    const resp = await ai.chatComplete(cfg, { messages, tools: TOOLS, hasImage });
    const apiCalls = (resp.tool_calls && resp.tool_calls.length) ? resp.tool_calls : null;
    const dsmlCalls = apiCalls ? null : parseDsmlCalls(resp.content || '');
    if (!apiCalls && (!dsmlCalls || !dsmlCalls.length)) {
      reply = stripDsml(resp.content || '') || '（AI 没有给出回复）';
      break;
    }
    await execToolCalls(messages, apiCalls || dsmlCalls, ops);
  }
  if (reply === null) {
    // 达到轮数上限：纯文本收尾；若仍泄漏 DSML 调用则解析执行，再给一次收尾机会
    for (let i = 0; i < 2 && reply === null; i++) {
      const resp = await ai.chatComplete(cfg, { messages, hasImage: false });
      const calls = parseDsmlCalls(resp.content || '');
      if (calls.length) {
        await execToolCalls(messages, calls, ops);
        continue;
      }
      reply = stripDsml(resp.content || '') || `本轮已执行 ${ops.length} 项操作，回复“继续”接着处理。`;
    }
    if (reply === null) reply = `本轮已执行 ${ops.length} 项操作，回复“继续”接着处理。`;
  }
  return { reply, ops };
}

function lastHasImage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i].content;
    if (Array.isArray(c)) {
      return c.some((p) => p && p.type === 'image_url');
    }
    if (messages[i].role === 'assistant') return false;
    if (messages[i].role === 'user') return false;
  }
  return false;
}

// ================= 演示模式（本地规则解析，不联网） =================
  const DEMO_KWS = {
    create: ['新增', '添加', '录入', '建档', '入册', '加入库存'],
    in: ['入库', '进料', '增加', '补货'],
    out: ['出库', '领用', '用掉', '使用', '消耗', '减少'],
    set: ['盘点', '修正', '改成'],
    del: ['删除', '移除', '作废'],
    clear: ['清空所有', '清空全部', '全部清空', '清空库存', '清库', '全部删除', '删掉所有', '清空全部物料', '确认清空', '确定清空'],
    search: ['搜索', '查找', '查一下', '有没有', '查查']
  };

const KNOWN_BRANDS = ['三星', '村田', '国巨', '华科', '风华', '厚声', 'tdk', 'murata', 'samsung', 'yageo', 'st', 'ti', '德州仪器', '英飞凌', '意法', 'microchip', 'nxp', '瑞萨', '兆易', '圣邦', '立创'];

function demoHelp() {
  return {
    reply: '【演示模式·内置模拟AI】\n我没有连真实大模型，先用规则帮你演示，可直接说：\n• “新增 100 个 10kΩ 0805 电阻 三星”\n• “入库 50 个 10kΩ”\n• “出库 20 个 C1710”\n• “盘点 C1710 库存为 30”\n• “删除 C1710”\n• “查找 0805”\n\n配置真实 AI（设置→服务商+API Key）后支持：拍照识别物料、模糊语义、立创编号自动补全等。',
    ops: []
  };
}

function matchToken(str, kws) { return kws.some((k) => str.includes(k)); }

function tokensOf(text) {
  return text.match(/[\p{Script=Han}]{1,}|[A-Za-z][A-Za-z0-9._+#/-]{1,}|C\d{4,}/gu) || [];
}

function countPart(text) {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(个|只|片|颗|卷|盘|条|米|包|pcs|PCS)?/);
  if (!m) return null;
  return { qty: Math.round(Number(m[1])), unit: m[2] || '个', rest: text.replace(m[0], '') };
}

function guessCategory(s) {
  const map = [
    ['集成电路', ['ic', '芯片', '单片机', 'mcu', '运放']],
    ['二极管', ['二极管', '整流', '稳压管']],
    ['三极管', ['三极管', '晶体管']],
    ['LED', ['led', '发光']],
    ['电容', ['电容', 'pf', 'nf', 'uf', 'μf', '法拉']],
    ['电感', ['电感', '磁珠', 'uh', 'mh']],
    ['连接器', ['连接器', '排针', '端子', '座', '插头']],
    ['晶振', ['晶振', 'mhz', 'khz', 'oscillator']],
    ['电阻', ['电阻', 'Ω', 'ohm', 'kω']]
  ];
  const low = s.toLowerCase();
  for (const [cat, keys] of map) if (keys.some((k) => low.includes(k))) return cat;
  return null;
}

function guessPackage(s) {
  const m = s.match(/\b(SOT-?23|SOT-?89|SMA|SMB|SMC|TO-?92|TO-?220|DO-?35|DO-?41|SOP-?\d+|SOIC-?\d+|TSSOP-?\d+|QFN-?\d+|LQFP-?\d+|DIP-?\d+)\b/i);
  if (m) return m[1].toUpperCase();
  const m2 = s.match(/\b(0402|0603|0805|1206|1210|2512|2010|1812)\b/);
  if (m2) return m2[1];
  return null;
}

function guessBrand(s) {
  const low = s.toLowerCase();
  for (const b of KNOWN_BRANDS) if (low.includes(b.toLowerCase())) return b;
  return null;
}

function demoSearch(text) {
  const rest = text.replace(/搜索|查找|查一下|有没有|查查|一下/g, ' ').trim();
  const items = db.listMaterials({ q: rest || text, size: 6 }).rows;
  if (!items.length) return { reply: `没有搜到与“${rest || text}”相关的物料。`, ops: [] };
  const lines = items.map((m) => `• ${m.model || m.name || m.lcsc_code}｜${m.name || ''}｜库存 ${m.stock}${m.unit}${m.low ? '（⚠️低于预警）' : ''}`).join('\n');
  return { reply: `找到 ${items.length} 条：\n${lines}`, ops: [] };
}

/** 根据关键词在库存里找最匹配物料，返回唯一匹配或 null（多选/无匹配） */
function pickMaterial(text) {
  // 直接命中 id（演示模式支持把物料id说给AI）
  const idM = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (idM) {
    const byId = db.getMaterial(idM[0]);
    if (byId) return byId;
  }
  const toks = tokensOf(text).filter((t) => !countPart(text) || !t.match(/^[\d.]+$/));
  const q = toks.join(' ');
  if (!q.trim()) return null;
  const res = db.listMaterials({ q: q.trim(), size: 10 });
  if (res.total === 0) return null;
  if (res.total === 1) return res.rows[0];
  // 多候选：取匹配度最高；平局则视为不唯一
  const scored = res.rows.map((m) => {
    const hay = `${m.model || ''} ${m.name || ''} ${m.lcsc_code || ''} ${m.brand || ''} ${m.spec || ''}`.toLowerCase();
    let hits = 0;
    for (const t of toks) {
      const low = t.toLowerCase().replace(/C\d{4,}/i, '');
      if (low.length >= 2 && hay.includes(low)) hits++;
      if (t.match(/^C\d{4,}$/i) && m.lcsc_code && m.lcsc_code.toLowerCase() === t.toLowerCase()) hits += 3;
    }
    return { m, hits };
  }).sort((a, b) => b.hits - a.hits);
  if (scored[0].hits > 0 && scored[0].hits > scored[1].hits) return scored[0].m;
  return scored[0].hits > 0 && res.total <= 3 && scored.every((s) => s.hits === scored[0].hits) ? null : null;
}

async function runMock(cfg, history) {
  const last = [...history].reverse().find((m) => m.role === 'user');
  if (!last) return demoHelp();
  let text = '';
  if (Array.isArray(last.content)) {
    text = last.content.map((p) => (p.type === 'text' ? p.text : '')).join(' ');
  } else text = String(last.content || '');
  text = text.trim();
  if (!text || matchToken(text, ['你好', '在吗']) || text.includes('能做什么') || text.includes('帮助')) return demoHelp();

  // 搜索
  if (matchToken(text, DEMO_KWS.search)) return demoSearch(text);
  // 清空全部（危险操作，先确认）
  if (matchToken(text, DEMO_KWS.clear)) {
    const total = db.getStats().total;
    const confirmed = /确认|确定|是的|对|清吧|清空吧|执行/.test(text);
    if (!confirmed) {
      return { reply: `这是一次性危险操作：将清空全部 ${total} 种物料（流水记录会保留）。请回复“确认清空”后我再执行。`, ops: [] };
    }
    const cleared = db.clearAllMaterials();
    return { reply: `已清空全部物料（共 ${cleared} 种），现在库存是空的。`, ops: [{ op: 'clear_all', cleared }] };
  }
  // 删除
  if (matchToken(text, DEMO_KWS.del)) {
    const t2 = text.replace(/删除|移除|作废/g, ' ');
    const m = pickMaterial(t2);
    if (!m) return { reply: `没有唯一匹配到要删除的物料（涉及 ${db.listMaterials({ q: t2, size: 1 }).total} 条），请给出明确的立创编号或完整型号。`, ops: [] };
    db.deleteMaterial(m.id);
    return { reply: `已删除物料：${m.model || m.name}（原库存 ${m.stock}${m.unit}）。`, ops: [{ op: 'delete', id: m.id, title: m.model || m.name }] };
  }
  // 盘点修正
  if (matchToken(text, DEMO_KWS.set)) {
    let target = null;
    let t2 = text;
    const setM = text.match(/(?:为|改成|设为|盘到)\s*(\d+)(?:\s*(?:个|只|片|颗|卷|盘|条|pcs|PCS))?/);
    if (setM) { target = Number(setM[1]); t2 = text.replace(setM[0], ' '); }
    if (target == null) {
      const cp = countPart(text.replace(/盘点|修正/g, ' '));
      if (cp) { target = cp.qty; t2 = cp.rest; }
    }
    const m = pickMaterial(t2);
    if (!m) return { reply: '没有唯一匹配到要盘点的物料，请给出明确编号/型号。', ops: [] };
    if (target == null) return { reply: `当前 ${m.model || m.name} 库存为 ${m.stock}${m.unit}，请说明要修正为多少（如：盘点 C-code 为 30）。`, ops: [] };
    const r = db.setStock(m.id, Number(target), '盘点修正(AI)', 'ai');
    return { reply: `已将 ${m.model || m.name} 库存修正为 ${r.after}${m.unit}（${r.delta >= 0 ? '+' : ''}${r.delta}）。`, ops: [{ op: 'set', id: m.id, title: m.model || m.name, after: r.after, unit: m.unit }] };
  }
  // 入库/出库（调整库存）
  if (matchToken(text, DEMO_KWS.in) || matchToken(text, DEMO_KWS.out)) {
    const isIn = matchToken(text, DEMO_KWS.in) && !matchToken(text, DEMO_KWS.out);
    const cp = countPart(text);
    if (!cp) return { reply: '请带上数量，例如：入库 50 个 C1710', ops: [] };
    const t2 = isIn ? text.replace(/入库|进料|增加|补货/g, ' ') : text.replace(/出库|领用|用掉|使用|消耗|减少/g, ' ');
    const targetText = t2.replace(/库存|数量|个|只|片|颗|pcs|PCS/g, ' ');
    const m = pickMaterial(targetText);
    if (!m) {
      // 本地没有该物料：若带了 C 编号，自动从立创拉资料建档并入库
      const codeM = text.match(/\bC\d{4,}\b/i);
      if (codeM) {
        try {
          const p = await lcscnet.fetchPartDetail(codeM[0]);
          const rec = db.createMaterial({ ...p, stock: cp.qty, unit: cp.unit === '个' ? (p.unit || '个') : cp.unit, source: 'ai' });
          return {
            reply: `本地没有 C 编号 C${String(codeM[0]).replace(/^C/i, '')}，已自动从立创商城拉取资料建档并入库 ${cp.qty}${cp.unit}：\n• 型号：${p.model || '—'}\n• 品牌：${p.brand || '—'} 封装：${p.package || '—'} 分类：${p.category || '—'}\n当前库存 ${rec.stock}${rec.unit}。`,
            ops: [{ op: 'create', id: rec.id, title: rec.model || rec.name, code: rec.lcsc_code, stock: rec.stock, unit: rec.unit }]
          };
        } catch (e) {
          return { reply: `本地没有该编号，且自动从立创拉资料失败：${e.message}。如需仅按编号建档，请说：新增 ${cp.qty} 个 C${String(codeM[0]).replace(/^C/i, '')}`, ops: [] };
        }
      }
      return { reply: `库存中没有唯一匹配“${targetText.trim()}”的物料。如果是新物料请用：新增 ${cp.qty} 个 <型号/名称>`, ops: [] };
    }
    const delta = isIn ? cp.qty : -cp.qty;
    try {
      const r = db.adjustStock(m.id, delta, isIn ? '入库(AI)' : '出库(AI)', 'ai');
      return { reply: `${isIn ? '已入库' : '已出库'} ${cp.qty}${cp.unit}：${m.model || m.name}，当前库存 ${r.after}${m.unit}。`, ops: [{ op: 'stock', id: m.id, title: m.model || m.name, delta: r.delta, after: r.after, unit: m.unit }] };
    } catch (e) {
      return { reply: `操作失败：${e.message}`, ops: [] };
    }
  }
  // 新增建档
  if (matchToken(text, DEMO_KWS.create)) {
    const t2 = text.replace(/新增|添加|录入|建档|入册|加入库存|帮我|请|一个|一种/g, ' ').trim();
    const cp = countPart(t2);
    const remain = (cp ? cp.rest : t2).replace(/库存|数量/g, ' ').trim();
    if (!remain) return { reply: '请描述物料，例如：新增 100 个 10kΩ 0805 电阻 三星', ops: [] };
    const brand = guessBrand(remain);
    const category = guessCategory(remain);
    const pkg = guessPackage(remain);
    // model：去掉中文、品牌、常见封装词后剩余的字母数字串
    let model = remain.replace(/[\p{Script=Han}]/gu, ' ')
      .split(/[^A-Za-z0-9_.+/#-]+/).filter((x) => x.length >= 2 && x !== brand && !/^(0805|0603|0402|1206)$/.test(x)).join(' ')
      .trim() || null;
    const isCode = remain.match(/\bC\d{4,}\b/i);
    const lcsc_code = isCode ? isCode[0].toUpperCase() : null;
    // 只给了 C 编号（没有其他型号信息）→ 尝试自动从立创拉资料建档
    if (lcsc_code && !model && !brand && !category && !pkg) {
      try {
        const p = await lcscnet.fetchPartDetail(lcsc_code);
        p.photo = await lcscnet.localizeLcscPhoto(p.photo, lcsc_code);
        const rec = db.createMaterial({ ...p, stock: cp ? cp.qty : 0, unit: cp ? cp.unit : (p.unit || '个'), source: 'ai' });
        return {
          reply: `已自动从立创商城拉取资料建档：型号 ${p.model || '—'} · 品牌 ${p.brand || '—'} · 封装 ${p.package || '—'} · 分类 ${p.category || '—'}，库存 ${rec.stock}${rec.unit}。`,
          ops: [{ op: 'create', id: rec.id, title: rec.model || rec.name, code: rec.lcsc_code, stock: rec.stock, unit: rec.unit }]
        };
      } catch (e) {
        return { reply: `自动从立创拉资料失败：${e.message}。如需仅按编号建档，可再说一次。`, ops: [] };
      }
    }
    const m = db.createMaterial({
      name: remain.replace(/\bC\d{4,}\b/i, '').trim() || null,
      model: model || (lcsc_code ? null : '演示物料'),
      lcsc_code,
      brand, category, package: pkg,
      unit: cp ? cp.unit : '个',
      stock: cp ? cp.qty : 0,
      supplier: '手动录入',
      source: 'ai'
    });
    return { reply: `已新增物料：${m.model || m.name}${lcsc_code ? '（' + lcsc_code + '）' : ''}，库存 ${m.stock}${m.unit}${category ? '，分类 ' + category : ''}。可再对我说“入库/出库”调整数量。`, ops: [{ op: 'create', id: m.id, title: m.model || m.name, code: m.lcsc_code, stock: m.stock, unit: m.unit }] };
  }
  return { reply: '没听懂这条指令（演示模式）。试着说：新增/入库/出库/盘点/删除/查找 + 数量 + 型号。', ops: [] };
}
