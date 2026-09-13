/* Code39 条码 SVG 生成器（零依赖）
   用途：物料标签打印 / 屏幕显示，手机端用 BarcodeDetector 可直接识别 */
(function () {
  'use strict';
  // Code39：每个字符 9 元素（5 条 4 隙），3 宽 6 窄；n=窄 w=宽
  const PAT = {
    '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn', '4': 'nnnwwnnnw',
    '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw', '8': 'wnnwnnwnn', '9': 'nnwwnnwnn',
    'A': 'wnnnnwnnw', 'B': 'nnwnnwnnw', 'C': 'wnwnnwnnn', 'D': 'nnnnwwnnw', 'E': 'wnnnwwnnn',
    'F': 'nnwnwwnnn', 'G': 'nnnnnwwnw', 'H': 'wnnnnwwnn', 'I': 'nnwnnwwnn', 'J': 'nnnnwwwnn',
    'K': 'wnnnnnnww', 'L': 'nnwnnnnww', 'M': 'wnwnnnnwn', 'N': 'nnnnwnnww', 'O': 'wnnnwnnwn',
    'P': 'nnwnwnnwn', 'Q': 'nnnnnnwww', 'R': 'wnnnnnwwn', 'S': 'nnwnnnwwn', 'T': 'nnnnwnwwn',
    'U': 'wwnnnnnnw', 'V': 'nwwnnnnnw', 'W': 'wwwnnnnnn', 'X': 'nwnnwnnnw', 'Y': 'wwnnwnnnn',
    'Z': 'nwwnwnnnn', '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '$': 'nwnwnwnnn',
    '/': 'nwnwnnnwn', '+': 'nwnnnwnwn', '%': 'nnnwnwnwn', '*': 'nwnnwnwnn'
  };

  /**
   * 生成 Code39 条码 SVG
   * @param text {string} 内容（自动大写；不支持的字符跳过）
   * @param opts {{height?:number, narrow?:number, wideRatio?:number, showText?:boolean}}
   * @returns {string} svg 字符串
   */
  function code39Svg(text, opts) {
    opts = opts || {};
    const height = opts.height || 60;
    const narrow = opts.narrow || 2;
    const wide = Math.round(narrow * (opts.wideRatio || 2.4));
    const gap = narrow; // 字符间空隙
    const clean = String(text || '').toUpperCase().split('').filter((c) => PAT[c]);
    const seq = '*' + clean.join('') + '*';
    // 计算总宽
    let units = 0;
    for (const ch of seq) {
      for (const el of PAT[ch]) units += (el === 'w' ? wide : narrow);
      units += gap;
    }
    const totalW = Math.max(units, 1);
    // 生成矩形
    const rects = [];
    let x = 0;
    let i = 0;
    for (const ch of seq) {
      const pat = PAT[ch];
      for (let k = 0; k < pat.length; k++) {
        const w = pat[k] === 'w' ? wide : narrow;
        if (i % 2 === 0) rects.push(`<rect x="${x}" y="0" width="${w}" height="${height}" fill="#111"/>`);
        x += w;
        i++;
      }
      x += gap;
    }
    const textH = opts.showText === false ? 0 : 16;
    const label = clean.join('').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${height + textH}" viewBox="0 0 ${totalW} ${height + textH}">` +
      `<rect width="${totalW}" height="${height + textH}" fill="#fff"/>` +
      rects.join('') +
      (textH ? `<text x="${totalW / 2}" y="${height + textH - 3}" font-size="${textH - 3}" text-anchor="middle" fill="#111" font-family="monospace">${label}</text>` : '') +
      `</svg>`;
  }

  window.code39Svg = code39Svg;
})();
