// ==UserScript==
// @name         抖音评论区 · 无水印原图下载
// @namespace    local.codex.douyin-origin
// @version      1.0.0
// @description  抓取抖音评论区图片的原始 CDN 地址(平台未加水印的那一份), 支持单张/批量下载, 可选转 JPG
// @author       Codex
// @match        https://www.douyin.com/*
// @grant        GM_xmlhttpRequest
// @connect      douyinpic.com
// @connect      byteimg.com
// @connect      bytedance.com
// @connect      *
// @run-at       document-start
// ==/UserScript==

/*
 * 原理
 *   抖音评论区图片在 App/网页里保存时带水印, 是因为客户端合成了一层水印图,
 *   而服务器返回的评论数据里其实同时给了两份地址:
 *     origin_url            -> 原始图(无水印)
 *     owner_watermark_image -> 预渲染的带水印版本(保存时下载的就是它)
 *   本脚本挂上 fetch / XMLHttpRequest, 在评论接口响应里把 origin_url 挑出来。
 */

(function () {
  'use strict';

  const DEBUG = false;
  const JPG_QUALITY = 0.95;
  const log = (...a) => { if (DEBUG) console.log('%c[抖音原图]', 'color:#fe2c55;font-weight:bold', ...a); };

  /* ==================== 一、抓取层 ==================== */

  const store = new Map();       // uri -> record
  const API_RE = /comment\/(list|list\/reply)/;

  function pickUrl(node) {
    if (!node) return '';
    if (typeof node === 'string') return node;
    const list = node.url_list || node.urlList || [];
    if (!Array.isArray(list) || !list.length) return '';
    const clean = list.find((u) => typeof u === 'string' && !/watermark/i.test(u));
    return clean || (typeof list[0] === 'string' ? list[0] : '');
  }

  // 万一拿到的是带水印模板的地址, 尽量还原成干净模板
  function deWatermark(url) {
    if (!url) return url;
    let out = url;
    if (/~tplv-[^?]*watermark[^?]*/i.test(out)) {
      out = out.replace(/~tplv-[^?]*(?=\?|$)/i, '');
    }
    out = out.replace(/[?&](watermark|wm|is_watermark)=[^&]*/gi, '');
    return out.replace(/\?&/, '?').replace(/\?$/, '');
  }

  function currentAwemeId() {
    const m = location.pathname.match(/\/(?:video|note)\/(\d+)/);
    return m ? m[1] : '';
  }

  function harvest(json) {
    const comments = json && (json.comments || json.comment_list);
    if (!Array.isArray(comments)) return 0;
    let added = 0;
    for (const c of comments) {
      const imgs = c.image_list || c.imageList || [];
      if (!Array.isArray(imgs)) continue;
      for (const im of imgs) {
        const raw = im.origin_url || im.originUrl || im.download_url || im.downloadUrl || im.medium_url;
        let url = pickUrl(raw);
        if (!url) continue;
        url = deWatermark(url);
        const uri = (raw && raw.uri) || url.split('?')[0];
        if (store.has(uri)) continue;
        store.set(uri, {
          uri,
          url,
          thumb: pickUrl(im.thumbnail_url || im.thumbnailUrl) || url,
          watermarkUrl: pickUrl(im.owner_watermark_image || im.ownerWatermarkImage),
          author: (c.user && (c.user.nickname || c.user.unique_id)) || '匿名',
          awemeId: c.aweme_id || currentAwemeId(),
          width: im.width || (raw && raw.width) || 0,
          height: im.height || (raw && raw.height) || 0,
        });
        added++;
      }
    }
    if (added) {
      log('新增', added, '张, 累计', store.size);
      render();
      toast(`抓到 ${added} 张原图（累计 ${store.size}）`);
    }
    return added;
  }

  function hookFetch() {
    const original = window.fetch;
    if (typeof original !== 'function' || original.__dyPatched) return;
    const patched = function (input, init) {
      const promise = original.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (API_RE.test(url)) {
          promise
            .then((res) => {
              try { res.clone().json().then(harvest).catch(() => {}); } catch (e) { /* ignore */ }
            })
            .catch(() => {});
        }
      } catch (e) { /* ignore */ }
      return promise;
    };
    patched.__dyPatched = true;
    window.fetch = patched;
  }

  function hookXHR() {
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    if (open.__dyPatched) return;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__dyUrl = url; } catch (e) { /* ignore */ }
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      try {
        if (API_RE.test(String(this.__dyUrl || ''))) {
          this.addEventListener('load', () => {
            try { harvest(JSON.parse(this.responseText)); } catch (e) { /* ignore */ }
          });
        }
      } catch (e) { /* ignore */ }
      return send.apply(this, arguments);
    };
    XMLHttpRequest.prototype.open.__dyPatched = true;
  }

  hookFetch();
  hookXHR();

  /* ==================== 二、下载层 ==================== */

  function gmGet(url) {
    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          responseType: 'blob',
          headers: { Referer: 'https://www.douyin.com/' },
          timeout: 30000,
          onload: (r) => (r.status >= 200 && r.status < 300 && r.response
            ? resolve(r.response)
            : reject(new Error('HTTP ' + r.status))),
          onerror: () => reject(new Error('网络错误')),
          ontimeout: () => reject(new Error('超时')),
        });
      });
    }
    return fetch(url).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    });
  }

  function extOf(url) {
    const m = String(url).split('?')[0].match(/\.([A-Za-z0-9]{2,5})$/);
    const e = m ? m[1].toLowerCase() : '';
    return /^(jpe?g|png|webp|gif|bmp|avif|heic)$/.test(e) ? (e === 'jpeg' ? 'jpg' : e) : 'jpg';
  }

  function sanitize(name) {
    return String(name).replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 30) || '匿名';
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 20000);
  }

  function toJpeg(blob) {
    return createImageBitmap(blob).then((bmp) => {
      const cv = document.createElement('canvas');
      cv.width = bmp.width;
      cv.height = bmp.height;
      cv.getContext('2d').drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      return new Promise((resolve) => cv.toBlob(resolve, 'image/jpeg', JPG_QUALITY));
    });
  }

  let seq = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function downloadOne(rec, forceJpg) {
    const asJpg = forceJpg !== undefined ? forceJpg : jpgBox.checked;
    seq++;
    const base = `抖音原图_${sanitize(rec.author)}_${String(seq).padStart(3, '0')}`;
    const name = `${base}.${asJpg ? 'jpg' : extOf(rec.url)}`;
    try {
      const blob = await gmGet(rec.url);
      const out = asJpg ? await toJpeg(blob) : blob;
      if (!out) throw new Error('转换失败');
      saveBlob(out, name);
      toast('已保存 ' + name);
      return true;
    } catch (e) {
      console.warn('[抖音原图] 下载失败', rec.url, e);
      window.open(rec.url, '_blank');
      toast('直接下载被拦，已在新标签页打开原图');
      return false;
    }
  }

  async function downloadAll(records) {
    let ok = 0;
    for (const rec of records) {
      if (await downloadOne(rec)) ok++;
      await sleep(300);
    }
    toast(`批量完成：${ok}/${records.length}`);
  }

  function copyAll(records) {
    const text = records.map((r) => r.url).join('\n');
    const done = () => toast(`已复制 ${records.length} 条原图链接`);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* ignore */ }
    ta.remove();
  }

  /* ==================== 三、界面 ==================== */

  let root, panel, listEl, toggleEl, countEl, jpgBox, toastEl, open = false;

  const CSS = `
  #dyOriginRoot, #dyOriginRoot * { box-sizing: border-box; font-family: -apple-system, "Microsoft YaHei", sans-serif; }
  #dyOriginToggle {
    position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
    height: 42px; padding: 0 16px; border: 0; border-radius: 21px; cursor: pointer;
    background: linear-gradient(135deg, #fe2c55, #ff6b81); color: #fff;
    font-size: 13px; font-weight: 600; box-shadow: 0 6px 20px rgba(254,44,85,.38);
  }
  #dyOriginToggle:hover { filter: brightness(1.06); }
  #dyOriginPanel {
    position: fixed; right: 20px; bottom: 74px; z-index: 2147483000;
    width: 340px; max-height: 66vh; display: flex; flex-direction: column;
    background: #1c1c1e; color: #f2f2f2; border-radius: 14px; overflow: hidden;
    box-shadow: 0 18px 48px rgba(0,0,0,.55); border: 1px solid rgba(255,255,255,.09);
  }
  #dyOriginPanel[hidden] { display: none; }
  .dyHead { padding: 12px 14px; font-size: 13px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,.08); }
  .dyHead span.badge { color: #fe2c55; font-weight: 700; }
  .dyTools { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,.08); }
  .dyTools button {
    flex: 1 1 auto; height: 28px; padding: 0 10px; border-radius: 7px; cursor: pointer;
    border: 1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.07); color: #f2f2f2; font-size: 12px;
  }
  .dyTools button:hover { background: rgba(255,255,255,.14); }
  .dyTools button.primary { background: #fe2c55; border-color: #fe2c55; font-weight: 600; }
  .dyTools label { display: flex; align-items: center; gap: 5px; font-size: 12px; color: #c9c9cf; padding: 0 2px; }
  #dyOriginList { overflow-y: auto; padding: 8px 10px 12px; }
  .dyItem { display: flex; gap: 10px; align-items: center; padding: 7px 6px; border-radius: 9px; }
  .dyItem:hover { background: rgba(255,255,255,.06); }
  .dyItem img { width: 46px; height: 46px; object-fit: cover; border-radius: 6px; background: #2b2b2e; flex: none; }
  .dyMeta { flex: 1 1 auto; min-width: 0; }
  .dyMeta .name { font-size: 12px; color: #eaeaea; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dyMeta .sub { font-size: 11px; color: #8b8b93; margin-top: 3px; }
  .dyItem button { flex: none; height: 26px; padding: 0 9px; font-size: 11px; border-radius: 6px; cursor: pointer; border: 1px solid rgba(255,255,255,.16); background: transparent; color: #f2f2f2; }
  .dyItem button:hover { background: rgba(255,255,255,.12); }
  .dyEmpty { padding: 22px 14px; font-size: 12px; line-height: 1.7; color: #9a9aa2; text-align: center; }
  #dyOriginToast {
    position: fixed; right: 22px; bottom: 130px; z-index: 2147483001;
    background: rgba(20,20,22,.94); color: #fff; font-size: 12px; padding: 8px 13px;
    border-radius: 8px; opacity: 0; transition: opacity .18s ease; pointer-events: none;
  }
  #dyOriginToast.show { opacity: 1; }
  `;

  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastEl.__t);
    toastEl.__t = setTimeout(() => toastEl.classList.remove('show'), 1800);
  }

  function buildUI() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'dyOriginRoot';

    const style = document.createElement('style');
    style.textContent = CSS;

    const toggle = document.createElement('button');
    toggle.id = 'dyOriginToggle';
    toggle.textContent = '评论原图 0';
    toggleEl = toggle;
    toggle.addEventListener('click', () => {
      open = !open;
      panel.hidden = !open;
      if (open) render();
    });

    panel = document.createElement('div');
    panel.id = 'dyOriginPanel';
    panel.hidden = true;

    const head = document.createElement('div');
    head.className = 'dyHead';
    const title = document.createElement('div');
    title.textContent = '抖音评论 · 无水印原图';
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = '0';
    head.append(title, badge);
    countEl = badge;

    const tools = document.createElement('div');
    tools.className = 'dyTools';

    const btnAll = document.createElement('button');
    btnAll.className = 'primary';
    btnAll.textContent = '下载全部';
    btnAll.addEventListener('click', () => {
      const records = [...store.values()];
      if (!records.length) return toast('还没有抓到图片');
      downloadAll(records);
    });

    const btnCopy = document.createElement('button');
    btnCopy.textContent = '复制链接';
    btnCopy.addEventListener('click', () => copyAll([...store.values()]));

    const btnClear = document.createElement('button');
    btnClear.textContent = '清空';
    btnClear.addEventListener('click', () => { store.clear(); render(); toast('已清空'); });

    const jpgLabel = document.createElement('label');
    jpgBox = document.createElement('input');
    jpgBox.type = 'checkbox';
    const jpgText = document.createElement('span');
    jpgText.textContent = '保存为 JPG';
    jpgLabel.append(jpgBox, jpgText);

    tools.append(btnAll, btnCopy, btnClear, jpgLabel);

    listEl = document.createElement('div');
    listEl.id = 'dyOriginList';

    panel.append(head, tools, listEl);

    toastEl = document.createElement('div');
    toastEl.id = 'dyOriginToast';

    root.append(style, toggle, panel, toastEl);
    document.body.appendChild(root);
    render();
  }

  function render() {
    if (!listEl) return;
    const records = [...store.values()];
    if (countEl) countEl.textContent = String(records.length);
    if (toggleEl) toggleEl.textContent = '评论原图 ' + records.length;
    if (!records.length) {
      listEl.replaceChildren();
      const empty = document.createElement('div');
      empty.className = 'dyEmpty';
      empty.textContent = '还没抓到图片。\n把评论区展开、往下滚一滚（点开一张图片效果更好），原图会自动出现在这里。';
      listEl.appendChild(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    records.forEach((rec, i) => {
      const item = document.createElement('div');
      item.className = 'dyItem';

      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = rec.thumb;
      img.alt = '';

      const meta = document.createElement('div');
      meta.className = 'dyMeta';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = rec.author;
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = rec.width ? `${rec.width}×${rec.height} · 无水印` : '无水印原图';
      meta.append(name, sub);

      const btn = document.createElement('button');
      btn.textContent = '下载';
      btn.addEventListener('click', () => downloadOne(rec));

      const btnLink = document.createElement('button');
      btnLink.textContent = '链接';
      btnLink.title = '复制原图直链';
      btnLink.addEventListener('click', () => copyAll([rec]));

      item.append(img, meta, btn, btnLink);
      item.dataset.index = String(i);
      frag.appendChild(item);
    });
    listEl.replaceChildren(frag);
  }

  /* ==================== 四、启动 ==================== */

  function start() {
    buildUI();
    // 页面已经加载完才注入脚本(比如直接粘到控制台)时, 提示用户先滚一下
    toast('已就绪：展开评论区即可抓取原图');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  // 方便在控制台里手动查看
  window.dyOriginImages = () => [...store.values()];
})();
