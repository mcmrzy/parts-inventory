// 立创商城网络查询模块（供 AI Agent 工具使用）
// 安全：仅请求固定域名 wmsc.lcsc.com；图片下载仅允许 assets.lcsc.com 前缀
import fs from 'node:fs';
import path from 'node:path';
import { PHOTO_DIR } from './config.js';
import { extractCode, detailToFields } from './lcsc.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const API_HOST = 'wmsc.lcsc.com';
const API_ENDPOINT = new URL('https://wmsc.lcsc.com/ftps/wm/product/detail');
const IMG_PREFIX = 'https://assets.lcsc.com/';
const CN_ITEM_PREFIX = 'https://item.szlcsc.com/';

/** 拉取国内站商品页 HTML（仅用于读取中文描述与 CNY 参考价；productId 为纯数字后才会拼 URL） */
async function fetchCnItemPage(productId) {
  if (!/^\d{1,12}$/.test(String(productId))) return null;
  const url = CN_ITEM_PREFIX + productId + '.html';
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) return null;
  return await res.text();
}

/** 从国内商品页提取中文描述与 CNY 参考价（均为页面自带的元信息） */
function parseCnPage(html) {
  const out = {};
  const dm = html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i)
    || html.match(/<meta[^>]+content="([^"]+)"[^>]+name="description"/i);
  if (dm) {
    let d = dm[1].replace(/&amp;/g, '&').replace(/价格￥[\d.]+元?[，,]?/g, '');
    const cut = d.search(/。?提供/);
    if (cut > 0) d = d.slice(0, cut);
    d = d.replace(/[，,。\s]+$/, '') + '。';
    out.description = d.slice(0, 260);
  }
  const pm = html.match(/itemProp="price"\s+content="([\d.]+)"/i) || html.match(/content="([\d.]+)"\s*\/?>(?:\s*<[^>]+>)*?\s*<meta[^>]+itemProp="priceCurrency"/i);
  if (pm) {
    const v = parseFloat(pm[1]);
    if (Number.isFinite(v) && v > 0) out.priceCny = v;
  }
  return out;
}

/**
 * 把立创图床图片下载到本地 photos/，返回 /photos/xxx；
 * 非立创图床地址或下载失败时原样返回，不打断主流程
 */
export async function localizeLcscPhoto(url, code) {
  try {
    if (typeof url !== 'string' || !url.startsWith(IMG_PREFIX)) return url || null;
    // 界面显示尺寸最大 ~124px，取 224x224 小图即可（体积约为 900x900 的 1/5）
    const smallUrl = url.includes('/900x900/') ? url.replace('/900x900/', '/224x224/') : url;
    let res = await fetch(smallUrl, {
      headers: { 'User-Agent': UA, Referer: 'https://www.lcsc.com/' },
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok && smallUrl !== url) {
      res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.lcsc.com/' }, signal: AbortSignal.timeout(20000) });
    }
    if (!res.ok) return url;
    const ct = res.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) return url;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return url;
    const ext = (ct.split('/')[1] || 'jpg').replace('jpeg', 'jpg').split(';')[0];
    const safe = String(code || 'img').replace(/[^\w.-]/g, '_').slice(0, 40);
    const name = `lcsc_${safe}_${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(PHOTO_DIR, name), buf);
    return '/photos/' + name;
  } catch (e) {
    console.warn('[lcscnet] 图片本地化失败，保留远程地址:', e.message);
    return url;
  }
}

export class LcscNetError extends Error {}

/**
 * 按立创编号(Cxxxx)查询物料资料
 * @returns 与 create_material 字段一致的对象（含 photo/lcsc_url/datasheet_url）
 */
export async function fetchPartDetail(rawCode) {
  const code = extractCode(rawCode);
  if (!code) throw new LcscNetError('无法识别立创编号，请输入 C 开头编号');
  const target = new URL(API_ENDPOINT.href);
  target.searchParams.set('productCode', code);
  // 白名单断言：仅允许请求固定域名
  if (target.hostname !== API_HOST || target.protocol !== 'https:') {
    throw new LcscNetError('目标地址不在白名单内');
  }
  let res;
  try {
    res = await fetch(target, {
      headers: { 'User-Agent': UA, Referer: 'https://www.lcsc.com/', Accept: 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(15000)
    });
  } catch (e) {
    throw new LcscNetError('无法连接立创商城（网络错误），请稍后重试');
  }
  if (!res.ok) throw new LcscNetError(`立创接口返回 HTTP ${res.status}`);
  const data = await res.json().catch(() => null);
  if (!data || data.code !== 200 || !data.result) {
    throw new LcscNetError(`立创查询失败：${(data && data.msg) || '无效编号或接口限流'}`);
  }
  const fields = detailToFields(data.result);
  if (!fields || !fields.lcsc_code) throw new LcscNetError('该编号未查询到有效物料');
  // 国内站增强：中文描述 + 人民币参考价（国际接口只有英文与美元）
  if (fields.product_id) {
    try {
      const html = await fetchCnItemPage(fields.product_id);
      if (html) {
        const cn = parseCnPage(html);
        if (cn.description) fields.description = cn.description;
        if (cn.priceCny) { fields.lcsc_price = cn.priceCny; fields.lcsc_currency = 'CNY'; }
      }
    } catch (e) {
      console.warn('[lcscnet] 国内站增强失败（不影响主流程）:', e.message);
    }
  }
  return fields;
}

/** 精简成给模型看的关键信息（控制 token） */
export function partSummary(fields) {
  return {
    lcsc_code: fields.lcsc_code,
    model: fields.model,
    name: fields.name,
    brand: fields.brand,
    category: fields.category,
    package: fields.package,
    spec: fields.spec,
    attributes: fields.attributes || null,
    description: fields.description,
    unit: fields.unit,
    lcsc_price: fields.lcsc_price,
    lcsc_currency: fields.lcsc_currency,
    supplier: fields.supplier,
    photo: fields.photo,
    datasheet_url: fields.datasheet_url,
    lcsc_url: fields.lcsc_url
  };
}
