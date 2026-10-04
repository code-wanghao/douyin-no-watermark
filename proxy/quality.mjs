/**
 * 给一个 CDN 图片地址造出"可能更清晰"的候选地址。
 *
 * 背景：接口给的 origin_url 虽然标着 origin（原始尺寸），但后面还挂着 WebP 转码和 q75 质量参数，
 * 所以抓下来的文件往往比手机保存的 JPEG 小不少 —— 那是编码差异，不一定是分辨率差异。
 *
 * CDN 地址形如：.../<对象>~tplv-<桶>-<模板>:<参数>.<扩展>?<签名>
 * 于是可以尝试三种候选：去掉处理模板取原始对象、把质量参数拉满、去掉缩放参数。
 * 能不能用取决于 CDN 与签名规则 —— 所以只能"探测后取最大的那份"，不能假设。
 */

export function qualityCandidates(url) {
  const out = [url];
  try {
    const u = new URL(url);
    const m = u.pathname.match(/~tplv-[^/]*/);
    if (!m) return out;
    const tpl = m[0];

    // ① 去掉整个处理模板 → 原始上传对象
    const raw = u.pathname.replace(/~tplv-[^/]*/, '');
    if (raw !== u.pathname) out.push(u.origin + raw + u.search);

    // ② 质量参数拉满
    if (/q\d+/.test(tpl)) {
      const better = tpl.replace(/q\d+/, 'q100');
      const next = u.pathname.replace(tpl, better);
      if (next !== u.pathname) out.push(u.origin + next + u.search);
    }

    // ③ 去掉 :宽:高 的缩放参数
    if (/:\d+:\d+/.test(tpl)) {
      const noScale = tpl.replace(/:\d+:\d+/g, '');
      const next = u.pathname.replace(tpl, noScale);
      if (next !== u.pathname) out.push(u.origin + next + u.search);
    }
  } catch { /* 地址不合法就只用原地址 */ }
  return [...new Set(out)];
}

/** 看这个地址是不是"带水印模板"的版本 */
export function looksWatermarked(url) {
  return /watermark/i.test(String(url));
}

/**
 * 把一张图片对象里所有字段的地址汇总成候选，并做安全处理：
 *   · 带水印模板的地址不能直接用 —— 但把它去掉模板后的原始对象地址加进来（那才是干净的原始文件）
 * 顺序：干净的优先，其次才是各字段。
 */
export function collectImageCandidates(imageObject, cleanUrl) {
  const out = [];
  const seen = new Set();
  const push = (u, from) => {
    if (typeof u !== 'string' || !u.startsWith('http') || seen.has(u)) return;
    seen.add(u);
    out.push({ url: u, from });
  };

  // 先收集"这条图片对象里到底有哪些地址"，并标明来源字段
  const sources = [];
  const FIELDS = ['origin_url', 'download_url', 'medium_url', 'thumbnail_url', 'owner_watermark_image'];
  for (const f of FIELDS) {
    const list = (imageObject && imageObject[f] && imageObject[f].url_list) || [];
    for (const u of list) sources.push({ url: u, from: f });
  }
  // 图片对象自己的顶层 url_list（图文主要靠它，评论图偶尔也有）
  for (const u of ((imageObject && imageObject.url_list) || [])) {
    sources.push({ url: u, from: 'url_list' });
  }

  for (const { url, from } of sources) {
    if (looksWatermarked(url)) {
      // 带水印的地址不直接用；只取它去掉模板后的原始对象（那才是干净的原始文件）
      for (const alt of qualityCandidates(url)) {
        if (alt !== url && !looksWatermarked(alt)) push(alt, `去模板(${from})`);
      }
    } else {
      push(url, from);
      for (const alt of qualityCandidates(url)) {
        if (alt !== url) push(alt, `变体(${from})`);
      }
    }
  }
  if (cleanUrl) push(cleanUrl, 'clean');
  return out;
}
