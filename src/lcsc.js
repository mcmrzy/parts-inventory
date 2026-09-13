// 立创商城 · 纯函数映射库（无任何网络请求）
// 数据格式：LCSC 官网公开详情接口 https://wmsc.lcsc.com/ftps/wm/product/detail?productCode=Cxxxx 的 JSON
import { PHOTO_DIR } from './config.js';
import { canonicalizeAttributes } from './taxonomy.js';

export class LcscError extends Error {}

/** 从任意输入中提取立创编号：支持纯编号 / 商品链接 / 含编号文本 */
export function extractCode(input) {
  const s = String(input || '').trim();
  const m = s.match(/(?:[?_/=-])?(C\d{4,})(?!\d)/i);
  if (m) return m[1].toUpperCase();
  if (/^C\d{4,}$/i.test(s)) return s.toUpperCase();
  return null;
}

export function isValidCode(s) {
  return /^C\d{4,}$/i.test(String(s || '').trim());
}

// 常见英文大类 → 中文（其余保留英文原文，可在表单中修改）
const CATEGORY_ZH = {
  'Passives': '被动元件',
  'Capacitors': '电容',
  'Resistors': '电阻',
  'Inductors': '电感',
  'Magnetic Components': '磁性元件',
  'Semiconductor ICs': '集成电路',
  'Integrated Circuits': '集成电路',
  'Discrete Semiconductor': '分立半导体',
  'Diodes': '二极管',
  'Transistors': '三极管/晶体管',
  'Connectors': '连接器',
  'Crystals & Oscillators': '晶振',
  'Crystals, Oscillators & Resonators': '晶振',
  'Relays': '继电器',
  'Switches & Keys': '开关',
  'Optoelectronics': '光电器件',
  'LEDs': 'LED',
  'Protection Devices': '保护器件',
  'Modules': '模块',
  'Power Supplies': '电源',
  'Audio & Speakers': '音频器件',
  'Hardware': '五金件',
  'Automation': '工控',
  'Development Boards & Kits': '开发板',
  'ESD Protection': '保护器件',
  'Battery': '电池',
  'Transformers': '变压器',
  'Ferrite': '磁珠/铁氧体',
  'Filters': '滤波器',
  'Fuses': '保险丝',
  'Thermal': '散热件'
};

/** 把立创详情 JSON(result 对象) 映射为系统物料字段 */
export function detailToFields(d) {
  const catEn = d.parentCatalogName || '';
  const catZh = CATEGORY_ZH[catEn] || catEn || null;
  const brand = d.brandNameEn || null;
  const model = d.productModel || null;
  const pkg = d.encapStandard || null;
  const title = d.productKeyAttributes || d.productNameEn || model || `${brand} ${model}`;

  const attributes = {};
  const specParts = [];
  if (Array.isArray(d.paramVOList)) {
    for (const p of d.paramVOList) {
      if (p && p.paramName && p.paramValue != null) {
        attributes[p.paramName] = String(p.paramValue);
        if (p.isMain) specParts.push(String(p.paramValue));
      }
    }
  }
  const spec = specParts.length ? specParts.join(' | ') : null;
  // 参数键归一到标准分类库（顺序稳定，便于细选筛选）
  const canonicalAttrs = canonicalizeAttributes(catZh, attributes, title);

  let price = null;
  if (Array.isArray(d.productPriceList) && d.productPriceList.length) {
    const nums = d.productPriceList.map((p) => Number(p.productPrice)).filter((n) => Number.isFinite(n) && n > 0);
    if (nums.length) price = Math.min(...nums);
  }

  const photo = Array.isArray(d.productImages) && d.productImages.length
    ? d.productImages.find((u) => /_front/i.test(u)) || d.productImages[0]
    : null;

  return {
    lcsc_code: d.productCode,
    product_id: d.productId ? String(d.productId) : null,
    model,
    name: title,
    brand,
    category: catZh,
    package: pkg,
    spec,
    attributes: canonicalAttrs,
    description: d.productIntroEn || d.productNameEn || title,
    unit: '个',
    lcsc_price: price,          // 立创参考价（美元阶梯价最低档），独立于用户来料价 price
    lcsc_currency: 'USD',
    supplier: '立创商城',
    photo,
    datasheet_url: d.pdfUrl || null,
    lcsc_url: d.productId
      ? `https://item.szlcsc.com/${d.productId}.html`   // 国内站商品页
      : `https://www.lcsc.com/product-detail/${encodeURIComponent(d.productCode)}.html`,
    _lcsc: {
      stockNumber: d.stockNumber ?? null,
      stockText: d.domesticStockVO ? `现货约 ${d.domesticStockVO.total ?? '?'}` : null,
      catalog: d.catalogName || null,
      productCode: d.productCode
    }
  };
}

/** 本地保存图片的目录常量（供服务端写入） */
export function photoFileDir() {
  return PHOTO_DIR;
}
