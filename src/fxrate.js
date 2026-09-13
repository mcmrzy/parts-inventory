// 汇率模块：USD→CNY 实时汇率（缓存 12 小时，失败时用兜底值）
// 安全：仅请求固定域名 open.er-api.com 的固定路径，无任何用户输入参与
const FX_HOST = 'open.er-api.com';
const FX_ENDPOINT = new URL('https://open.er-api.com/v6/latest/USD');
const FALLBACK_USD_CNY = 7.1;
const CACHE_TTL = 12 * 3600 * 1000;

let cache = { rate: null, fetchedAt: 0, source: 'init' };

export function usdCnyCached() {
  if (cache.rate && Date.now() - cache.fetchedAt < CACHE_TTL) {
    return { usdCny: cache.rate, fetchedAt: new Date(cache.fetchedAt).toISOString(), source: cache.source, cached: true };
  }
  return { usdCny: cache.rate || FALLBACK_USD_CNY, fetchedAt: cache.rate ? new Date(cache.fetchedAt).toISOString() : null, source: cache.source === 'live' ? 'live' : 'fallback', cached: false };
}

export async function fetchUsdCny() {
  if (cache.rate && Date.now() - cache.fetchedAt < CACHE_TTL) return usdCnyCached();
  const target = new URL(FX_ENDPOINT.href);
  if (target.hostname !== FX_HOST || target.protocol !== 'https:') {
    cache = { rate: FALLBACK_USD_CNY, fetchedAt: Date.now(), source: 'fallback' };
    return usdCnyCached();
  }
  try {
    const res = await fetch(target, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const rate = Number(data && data.rates && data.rates.CNY);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('汇率数据无效');
    cache = { rate, fetchedAt: Date.now(), source: 'live' };
  } catch (e) {
    // 拉取失败：保留旧值或兜底值，不影响主流程
    if (!cache.rate) cache = { rate: FALLBACK_USD_CNY, fetchedAt: Date.now(), source: 'fallback' };
    else cache.fetchedAt = Date.now(); // 旧值续命，避免每次请求都重试
  }
  return usdCnyCached();
}

/** 任意币种金额 → 人民币金额（目前支持 USD 折算，其他币种原样返回 null 表示不换算） */
export function toCny(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  const cur = String(currency || 'USD').toUpperCase();
  if (cur === 'CNY') return n;
  if (cur === 'USD') return Math.round(n * usdCnyCached().usdCny * 10000) / 10000;
  return null;
}
