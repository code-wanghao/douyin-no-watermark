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
