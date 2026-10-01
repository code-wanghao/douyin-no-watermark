/**
 * 抖音电脑版 · 评论区原图代理
 *
 * 目标：在电脑版里点开评论图片看到的是原图，点保存存下来的也是原图，不需要额外导出。
 *
 * 做法：
 *   评论接口返回的每条图片对象里有两个字段
 *     origin_url            原始图（无水印）
 *     owner_watermark_image 预渲染的带水印图（客户端显示/保存时用的就是它）
 *   本代理只劫持 *.douyin.com 的 HTTPS，把接口 JSON 里所有指向"带水印图"的字段
 *   原地改写成 origin_url 的副本。客户端拿到手的就是原图地址，显示和保存自然都是无水印的。
 *
 *   其他域名一律原样 TCP 隧道转发，不解密、不干预。
 *
 * 用法：
 *   node proxy.mjs                  正常启动（缺证书会自动生成）
 *   node proxy.mjs --install-ca     只装根证书
 *   node proxy.mjs --uninstall-ca   卸载根证书
 *   node proxy.mjs --restore-proxy  还原系统代理设置
 *   node proxy.mjs --port 8080      指定端口（默认 8080）
 *   node proxy.mjs -o D:\图片        指定原图保存目录（默认 图片\抖音原图）
 *   node proxy.mjs --features comment,aweme   只启用指定功能（comment / aweme / all / none）
 *   node proxy.mjs --choose-only    重新选功能并保存，不启动代理
 *   node proxy.mjs --yes            装证书时不再询问
 *   node proxy.mjs --trace          追踪模式：把客户端对图片 CDN 的每次请求都记进日志
 *   node proxy.mjs --dev            本地自测用：不碰系统代理、不检查证书信任
 */

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateCerts, loadCerts } from './certgen.mjs';
import { imageSizeOf } from './imgsize.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CERT_DIR = path.join(HERE, 'certs');
const BACKUP_FILE = path.join(CERT_DIR, 'proxy-backup.json');
const LOG_DIR = path.join(HERE, 'logs');

/* ---------- 日志：控制台里出现的一切都同时落盘，窗口被关掉也查得到 ---------- */

let LOG_FILE = '';
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  LOG_FILE = path.join(LOG_DIR, `proxy-${stamp}.log`);
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, callback) => {
    // 用同步写入：进程被强杀时缓冲区里的日志也不会丢
    try {
      fs.appendFileSync(LOG_FILE, typeof chunk === 'string' ? chunk : Buffer.from(chunk));
    } catch { /* 日志写不进去也不能影响主流程 */ }
    return originalWrite(chunk, encoding, callback);
  };
} catch { /* 没有日志也要能跑 */ }

process.on('uncaughtException', (e) => {
  try {
    process.stdout.write(`[崩溃] ${e?.stack || e}\n`);
    try { restoreIfApplied(); } catch { /* ignore */ }
    process.stdout.write('[退出] 1\n');
  } catch { /* ignore */ }
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  try {
    process.stdout.write(`[未处理的 Promise 拒绝] ${e?.stack || e}\n`);
    try { restoreIfApplied(); } catch { /* ignore */ }
    process.stdout.write('[退出] 1\n');
  } catch { /* ignore */ }
  process.exit(1);
});
process.on('exit', (code) => {
  if (!LOG_FILE) return;
  try {
    fs.appendFileSync(LOG_FILE, `\n[退出] code=${code}\n`);
  } catch { /* ignore */ }
});

/** 读 Windows 登记的"图片"文件夹（可能是 OneDrive 重定向后的真实路径）。读不到返回 ''。 */
function knownPicturesDir() {
  try {
    const script = String.raw`
$p = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' -ErrorAction SilentlyContinue).'My Pictures'
if ($p) { [Environment]::ExpandEnvironmentVariables($p) }
`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
    const out = (r.stdout || '').trim();
    return out && path.isAbsolute(out) ? out : '';
  } catch {
    return '';
  }
}

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = Number(opt('--port', process.env.DY_PROXY_PORT || 8080));
const AUTO_YES = has('--yes');
const DEV = has('--dev');          // 本地自测用：不碰系统代理、不检查证书信任
const TRACE = has('--trace');      // 追踪模式：把客户端对图片 CDN 的每一次请求都记进日志

/* ============================ 功能开关 ============================ */
/*
 * 两个功能可以单独启用，互不依赖：
 *   comment —— 评论区图片去水印（顺带"只保存你点开的"）
 *   aweme   —— 作品去水印（视频 / 图文的保存与下载）
 * 选择来源优先级：命令行 --features > features.json > 首次运行交互选择 > 默认全开
 */

const FEATURE_DEFS = [
  {
    key: 'comment',
    name: '评论区图片去水印',
    desc: '点开评论图片看到的就是原图，可以只保存你点开过的那几张',
  },
  {
    key: 'aweme',
    name: '作品去水印',
    desc: '保存视频 / 图文作品时，拿到的是无水印版本',
  },
];
const FEATURE_KEYS = FEATURE_DEFS.map((f) => f.key);
const CONFIG_FILE = path.join(HERE, 'features.json');

let FEATURES = Object.fromEntries(FEATURE_KEYS.map((k) => [k, true]));

function loadFeatureConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const list = Array.isArray(raw.features) ? raw.features : [];
    if (!list.length) return null;
    const picked = Object.fromEntries(FEATURE_KEYS.map((k) => [k, list.includes(k)]));
    if (!FEATURE_KEYS.some((k) => picked[k])) return null;
    return picked;
  } catch {
    return null;
  }
}

function saveFeatureConfig(features) {
  try {
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify({
        features: FEATURE_KEYS.filter((k) => features[k]),
        note: '改完保存即可生效；也可以用 选择功能.bat 重新选。留空数组或删掉本文件会回到默认（两个都开）。',
      }, null, 2),
      'utf8',
    );
  } catch { /* 写不进去不影响本次运行 */ }
}

function parseFeatureArg(value) {
  const t = String(value || '').trim().toLowerCase();
  const allTrue = () => Object.fromEntries(FEATURE_KEYS.map((k) => [k, true]));
  const allFalse = () => Object.fromEntries(FEATURE_KEYS.map((k) => [k, false]));
  if (!t || t === 'all') return allTrue();
  if (t === 'none') return allFalse();
  const parts = t.split(/[,，\s]+/).filter(Boolean);
  const picked = Object.fromEntries(FEATURE_KEYS.map((k) => [k, parts.includes(k)]));
  return FEATURE_KEYS.some((k) => picked[k]) ? picked : null;
}

function featuresToText(features) {
  return FEATURE_DEFS.filter((f) => features[f.key]).map((f) => f.name).join(' + ') || '（全关）';
}

// 保存目录在启动时按"可写"逐个探测决定，所以这里是 let
let OUT_DIR = '';

function outDirCandidates() {
  const list = [];
  const explicit = opt('-o', opt('--out', ''));
  if (explicit) list.push(path.resolve(explicit));
  const known = knownPicturesDir();
  if (known) list.push(path.join(known, '抖音原图'));
  list.push(path.join(os.homedir(), 'Pictures', '抖音原图'));
  list.push(path.join(os.homedir(), 'Desktop', '抖音原图'));
  list.push(path.join(HERE, '抖音原图'));
  return [...new Set(list)];
}

/**
 * 逐个试探候选目录，返回第一个真正能写的。
 * mkdir 成功不代表能写（比如 D:\ 根目录只给 Users 读权限，报 EPERM），所以这里写个探针文件确认。
 */
function pickDownloadDir() {
  const tried = [];
  for (const dir of outDirCandidates()) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.write-probe');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return { dir, tried };
    } catch (e) {
      tried.push(`${dir} (${e.code || e.message})`);
    }
  }
  return { dir: '', tried };
}

/* ============================ 看门狗 ============================ */
/*
 * 代理负责把系统代理指向自己。如果它被强杀（关窗口、任务管理器结束、崩溃），
 * 系统代理就会停在一个没人监听的地址上，整机断网。
 * 所以启动时再拉起一个独立的看门狗进程：父进程一消失、而备份文件还在，就把代理设置还原回去。
 */

const WATCHDOG_PID = Number(opt('--watchdog', 0));

// 只要我们把系统代理改成了自己，这个开关就是 true。
// 任何异常退出路径都会先靠它把代理还原回去，避免留下"指向死端口"的代理设置。
let proxyApplied = false;

function restoreIfApplied() {
  if (!proxyApplied) return;
  proxyApplied = false;
  try {
    restoreProxyFromBackup();
  } catch { /* 还原失败还有看门狗兜底 */ }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runWatchdog(parentPid) {
  const deadline = Date.now() + 12 * 3600 * 1000;   // 最多守 12 小时，避免留下孤儿进程
  while (Date.now() < deadline) {
    await sleep(1500);
    if (!fs.existsSync(BACKUP_FILE)) return 0;      // 主进程已经正常收尾，不碰任何设置
    if (!isAlive(parentPid)) {
      restoreProxyFromBackup();
      return 0;
    }
  }
  return 0;
}

function startWatchdog() {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--watchdog', String(process.pid)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

const COMMENT_API_RE = /\/aweme\/v1\/web\/comment\/(list|list\/reply)/;
const REG_PATH = String.raw`HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings`;

/* ============================ 基础工具 ============================ */

const say = (msg) => process.stdout.write(msg + '\n');
/** 只写日志文件、不刷屏（追踪模式用） */
const logOnly = (msg) => {
  if (!LOG_FILE) return;
  try {
    fs.appendFileSync(LOG_FILE, msg + '\n');
  } catch { /* ignore */ }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ps(script) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

const WININET_REFRESH = String.raw`
$sig = '[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);'
$w = Add-Type -MemberDefinition $sig -Name WinInet -Namespace CodexDy -PassThru
$w::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
$w::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null
`;

async function ask(question, defaultYes = true) {
  if (AUTO_YES) return defaultYes;
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  const text = answer.trim();
  if (text === '') return defaultYes;   // 直接回车＝用问题里标注的默认项
  return /^y(es)?$/i.test(text);
}

/** 返回用户输入的原始字符串（多选项提问用） */
async function askRaw(question) {
  if (!process.stdin.isTTY) return '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return answer;
}

/** 首次运行时让用户选要启用哪些功能，结果会存进 features.json */
async function chooseFeatures() {
  say('请选择要启用的功能（可多选，用逗号分隔，例如 1,2）：');
  say('');
  FEATURE_DEFS.forEach((f, i) => say(`  ${i + 1}. ${f.name}　—— ${f.desc}`));
  say('');
  const all = Object.fromEntries(FEATURE_KEYS.map((k) => [k, true]));
  const answer = (await askRaw('输入编号，直接回车＝两个都启用： ')).trim();
  if (!answer) return all;

  const picked = answer
    .split(/[,，\s、]+/)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= FEATURE_DEFS.length);

  if (!picked.length) {
    say('没看懂输入，这次先按"两个都启用"处理；下次可以双击 选择功能.bat 重选。');
    return all;
  }
  const result = Object.fromEntries(FEATURE_DEFS.map((f, i) => [f.key, picked.includes(i + 1)]));
  say(`已选择：${featuresToText(result)}（已记住，想改就双击 选择功能.bat）`);
  return result;
}

/* ============================ 证书管理 ============================ */

function ensureCerts() {
  if (fs.existsSync(path.join(CERT_DIR, 'ca.pem')) && fs.existsSync(path.join(CERT_DIR, 'leaf.pem'))) {
    return loadCerts(CERT_DIR);
  }
  say('首次运行，正在生成根证书和服务器证书...');
  const { thumbprint } = generateCerts(CERT_DIR);
  say(`证书已生成（CA 指纹 ${thumbprint}）`);
  return loadCerts(CERT_DIR);
}

function isCaTrusted(thumbprint) {
  const script = [
    `$t = '${thumbprint}'`,
    String.raw`$hit = Get-ChildItem Cert:\CurrentUser\Root -ErrorAction SilentlyContinue | Where-Object { $_.Thumbprint -eq $t }`,
    `if ($hit) { 'TRUSTED' } else { 'MISSING' }`,
  ].join('\n');
  return ps(script).out.includes('TRUSTED');
}

function installCa(cerPath) {
  const script = [
    `$c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2('${cerPath}')`,
    String.raw`$s = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root','CurrentUser')`,
    String.raw`$s.Open('ReadWrite')`,
    `$s.Add($c)`,
    `$s.Close()`,
    `'INSTALLED'`,
  ].join('\n');
  return ps(script);
}

function uninstallCa(cerPath) {
  const script = [
    `$c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2('${cerPath}')`,
    String.raw`$s = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root','CurrentUser')`,
    String.raw`$s.Open('ReadWrite')`,
    `$s.Remove($c)`,
    `$s.Close()`,
    `'REMOVED'`,
  ].join('\n');
  return ps(script);
}

/* ============================ 系统代理 ============================ */

function readProxySettings() {
  const script = [
    `$p = Get-ItemProperty '${REG_PATH}'`,
    `[pscustomobject]@{ Enable = [int]$p.ProxyEnable; Server = [string]$p.ProxyServer; Override = [string]$p.ProxyOverride } | ConvertTo-Json -Compress`,
  ].join('\n');
  const r = ps(script);
  if (!r.out) return { Enable: 0, Server: '', Override: '' };
  try {
    return JSON.parse(r.out);
  } catch {
    return { Enable: 0, Server: '', Override: '' };
  }
}

function applyProxy(server) {
  const script = [
    `Set-ItemProperty '${REG_PATH}' -Name ProxyEnable -Value 1 -Type DWord`,
    `Set-ItemProperty '${REG_PATH}' -Name ProxyServer -Value '${server}' -Type String`,
    `Set-ItemProperty '${REG_PATH}' -Name ProxyOverride -Value '<local>' -Type String`,
    WININET_REFRESH,
    `'OK'`,
  ].join('\n');
  return ps(script);
}

function clearProxy() {
  const script = [
    `Set-ItemProperty '${REG_PATH}' -Name ProxyEnable -Value 0 -Type DWord`,
    `Set-ItemProperty '${REG_PATH}' -Name ProxyServer -Value '' -Type String`,
    WININET_REFRESH,
    `'OK'`,
  ].join('\n');
  return ps(script);
}

function restoreProxyFromBackup() {
  if (!fs.existsSync(BACKUP_FILE)) {
    clearProxy();
    return '已关闭系统代理（没有找到备份文件）';
  }
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
  } catch {
    clearProxy();
    return '备份文件损坏，已直接关闭系统代理';
  }
  const script = [
    `Set-ItemProperty '${REG_PATH}' -Name ProxyEnable -Value ${saved.Enable ? 1 : 0} -Type DWord`,
    `Set-ItemProperty '${REG_PATH}' -Name ProxyServer -Value '${String(saved.Server || '').replace(/'/g, "''")}' -Type String`,
    `Set-ItemProperty '${REG_PATH}' -Name ProxyOverride -Value '${String(saved.Override || '').replace(/'/g, "''")}' -Type String`,
    WININET_REFRESH,
    `'OK'`,
  ].join('\n');
  ps(script);
  fs.unlinkSync(BACKUP_FILE);
  return '已还原成启动前的代理设置';
}

/* ============================ 改写与收集 ============================ */

const images = new Map();   // uri -> record
const originPathIndex = new Map();   // 原图的 URL 路径 -> uri，用来判定"这张被点开了"
let rewriteCount = 0;
let apiHits = 0;
let traceSeq = 0;

function pickUrl(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  const list = node.url_list || node.urlList || [];
  if (!Array.isArray(list) || !list.length) return '';
  const clean = list.find((u) => typeof u === 'string' && !/watermark/i.test(u));
  return clean || (typeof list[0] === 'string' ? list[0] : '');
}

function deWatermark(url) {
  if (!url) return url;
  let out = url;
  if (/~tplv-[^?]*watermark[^?]*/i.test(out)) out = out.replace(/~tplv-[^?]*(?=\?|$)/i, '');
  out = out.replace(/[?&](watermark|wm|is_watermark)=[^&]*/gi, '');
  return out.replace(/\?&/, '?').replace(/\?$/, '');
}

/*
 * 只接管"带水印"的那两个字段，把它们换成原图。
 *
 * 为什么不把 origin_url / medium_url / thumbnail_url 也一起换掉：
 * 接口本来就给了三档干净的变体（原图 / 中图 / 缩略图），只有 owner_watermark_image 是带水印的。
 * 如果把它们全换成同一个原图地址，客户端就会在列表渲染时直接把原图下完，
 * 你点开时只是命中缓存 —— 于是"点开哪张"在网络层上就再也看不出来了。
 * 保持三档变体不变，客户端就还是它原本的节奏：列表取小图、点开取大图，
 * "点开"因此变成一次可识别的请求。
 */
const OVERRIDE_FIELDS = ['owner_watermark_image', 'download_url'];

/** 按 url 造一个和原节点同构的副本（保留 uri / 尺寸等字段，避免客户端对不上） */
function cloneNodeLike(node, url) {
  const copy = node && typeof node === 'object' ? JSON.parse(JSON.stringify(node)) : {};
  copy.url_list = [url];
  return copy;
}

/** 一张图片对象里"干净的那份"在哪：评论图看 origin_url，图文看顶层 url_list */
function pickCleanImageUrl(im) {
  if (!im || typeof im !== 'object') return '';
  const raw = pickUrl(im.origin_url)
    || pickUrl(im.url_list ? { url_list: im.url_list } : null)
    || pickUrl(im.download_url)
    || pickUrl(im.medium_url)
    || '';
  return raw ? deWatermark(raw) : '';
}

/** 把一张图片对象里"带水印的字段"指向干净的那份；返回改写了几个字段 */
function rewriteOneImage(im) {
  if (!im || typeof im !== 'object') return 0;
  const clean = pickCleanImageUrl(im);
  if (!clean) return 0;
  // 用"干净那份"的元信息构造替换节点。
  // 关键是 uri 也要跟着换 —— 否则 uri 指向带水印的对象、url_list 指向干净对象，
  // 两边对不上，客户端若拿 uri 做缓存键就会出问题。
  const src = (im.origin_url && typeof im.origin_url === 'object') ? im.origin_url : im;
  let n = 0;
  for (const field of OVERRIDE_FIELDS) {
    if (!im[field]) continue;
    const replacement = { url_list: [clean] };
    for (const key of ['uri', 'width', 'height', 'data_size', 'file_hash']) {
      if (src[key] != null) replacement[key] = src[key];
    }
    im[field] = replacement;
    n++;
  }
  return n;
}

/** 递归把对象里所有 url_list 都换成同一个地址（用于 misc_download_addrs 这种嵌套结构） */
function rewriteUrlLists(node, url, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return 0;
  let n = 0;
  if (Array.isArray(node.url_list) && node.url_list.length) {
    node.url_list = [url];
    n++;
  }
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (val && typeof val === 'object') n += rewriteUrlLists(val, url, depth + 1);
  }
  return n;
}

/**
 * 作品去水印：视频和图文的下载字段都指向"播放用的那份"。
 *
 * 依据是客户端自己的 download() 实现（从 pc-web 包里挖出来的）：
 *   优先 misc_download_addrs.suffix_scene → 其次 download_suffix_logo_addr → 兜底 download_addr
 * 这三个都是"下载专用"地址（带水印/带 logo）。而 play_addr 是边播边下用的流，是干净的。
 */
/**
 * 从视频对象里挑出"最干净的可用源"。
 * 优先 bit_rate 里码率最高的那一档（都是干净播放源，而且画质最好），
 * 没有 bit_rate 就退回 play_addr 系列。
 */
function pickCleanVideoSource(video) {
  let bestNode = null;
  let bestUrl = '';
  let bestScore = -1;
  for (const br of (Array.isArray(video.bit_rate) ? video.bit_rate : [])) {
    const url = pickUrl(br && br.play_addr);
    if (!url) continue;
    const score = Number(br.bit_rate)
      || (Number(br.play_addr && br.play_addr.width) * Number(br.play_addr && br.play_addr.height))
      || 0;
    if (score > bestScore) {
      bestScore = score;
      bestUrl = deWatermark(url);
      bestNode = br.play_addr;
    }
  }
  if (bestUrl) return { node: bestNode, url: bestUrl };

  for (const field of ['play_addr', 'play_addr_lowbr', 'play_addr_265']) {
    const url = pickUrl(video[field]);
    if (url) return { node: video[field], url: deWatermark(url) };
  }
  return null;
}

function rewriteAweme(json) {
  let fields = 0;
  let works = 0;
  const seen = new Set();
  const stack = [json];

  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);

    // ---- 视频 ----
    const video = node.video;
    if (video && typeof video === 'object') {
      const clean = pickCleanVideoSource(video);
      if (clean) {
        let n = 0;
        for (const field of ['download_addr', 'download_suffix_logo_addr', 'download_addr_265']) {
          if (video[field]) {
            video[field] = cloneNodeLike(clean.node, clean.url);
            n++;
          }
        }
        if (video.has_download_suffix_logo_addr) {
          video.has_download_suffix_logo_addr = false;
          n++;
        }
        if (typeof video.misc_download_addrs === 'string' && video.misc_download_addrs) {
          try {
            const misc = JSON.parse(video.misc_download_addrs);
            const c = rewriteUrlLists(misc, clean.url);
            if (c) {
              video.misc_download_addrs = JSON.stringify(misc);
              n += c;
            }
          } catch { /* 不是 JSON 就不动 */ }
        }
        if (n) {
          fields += n;
          works++;
        }
      }
    }

    // ---- 图文图片列表（评论图片走各自的分支）----
    for (const key of ['images', 'image_list']) {
      const arr = node[key];
      if (!Array.isArray(arr)) continue;
      let n = 0;
      for (const im of arr) n += rewriteOneImage(im);
      if (n) {
        fields += n;
        works++;
      }
    }

    for (const key of Object.keys(node)) {
      const val = node[key];
      if (val && typeof val === 'object') stack.push(val);
    }
  }

  return { fields, works };
}

/** 把评论 JSON 里"带水印图"的字段替换成 origin_url 的深拷贝。 */
function rewriteComments(json) {
  const comments = json?.comments;
  if (!Array.isArray(comments)) return { fields: 0, imgs: 0 };
  let fields = 0;
  let imgs = 0;
  for (const c of comments) {
    const list = c?.image_list;
    if (!Array.isArray(list)) continue;
    for (const im of list) {
      const originNode = im?.origin_url;
      const origin = pickUrl(originNode) || pickUrl(im?.download_url) || pickUrl(im?.medium_url);
      if (!origin) continue;
      const clean = deWatermark(origin);

      const uri = originNode?.uri || clean.split('?')[0];
      if (!images.has(uri)) {
        let originPath = '';
        try {
          originPath = new URL(clean).pathname;
        } catch { /* 解析不了就算了 */ }
        const rec = {
          uri,
          url: clean,
          originPath,
          opened: false,
          author: c?.user?.nickname || c?.user?.unique_id || '匿名',
          awemeId: c?.aweme_id || '',
          text: String(c?.text || '').replace(/\s+/g, ' ').slice(0, 30),
          width: im?.width || originNode?.width || 0,
          height: im?.height || originNode?.height || 0,
        };
        images.set(uri, rec);
        if (originPath) originPathIndex.set(originPath, uri);   // 用来判定"这张被点开了"
      }
      imgs++;

      // 关键一步：带水印的字段整体换成原图节点（url_list / uri / 尺寸一起换，避免 uri 对不上）
      fields += rewriteOneImage(im);
    }
  }
  rewriteCount += fields;
  return { fields, imgs };
}

function decompress(buffer, encoding) {
  const enc = String(encoding || '').toLowerCase();
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(buffer);
    if (enc.includes('gzip')) return zlib.gunzipSync(buffer);
    if (enc.includes('deflate')) return zlib.inflateSync(buffer);
  } catch {
    return null;
  }
  return buffer;
}

/* ============================ 下载（可选） ============================ */

function sanitize(name) {
  return String(name).replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim().slice(0, 40) || '匿名';
}

function extOf(url) {
  const m = String(url).split('?')[0].match(/\.([A-Za-z0-9]{2,5})$/);
  const e = m ? m[1].toLowerCase() : '';
  return /^(jpe?g|png|webp|gif|bmp|avif|heic)$/.test(e) ? (e === 'jpeg' ? 'jpg' : e) : 'jpg';
}

async function downloadAll(records) {
  if (!records.length) {
    say('没有采集到图片，跳过下载。');
    return;
  }
  if (!OUT_DIR) {
    say('没有可写目录，改为把原图直链打印在下面（复制出来用别的方式下载也一样）：');
    for (const r of records) say('  ' + r.url);
    return;
  }
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    // 先把链接落盘：这样即使后面下载全失败，链接也不会丢
    fs.writeFileSync(path.join(OUT_DIR, '原图链接.txt'), records.map((r) => r.url).join('\n'), 'utf8');
  } catch (e) {
    say(`写入 ${OUT_DIR} 失败（${e.code || e.message}），改为打印直链：`);
    for (const r of records) say('  ' + r.url);
    return;
  }
  say(`保存到：${OUT_DIR}`);
  let ok = 0;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const name = `${String(i + 1).padStart(String(records.length).length, '0')}_${sanitize(rec.author)}.${extOf(rec.url)}`;
    try {
      const res = await fetch(rec.url, {
        headers: { Referer: 'https://www.douyin.com/', 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) throw new Error('内容过小');
      fs.writeFileSync(path.join(OUT_DIR, name), buf);
      ok++;
      // 顺手核对：拿到的到底是不是原始分辨率
      const dim = imageSizeOf(buf);
      let note = '';
      if (dim && dim.w) {
        if (rec.width && rec.height) {
          note = (dim.w === rec.width && dim.h === rec.height)
            ? `  ${dim.w}x${dim.h} ${dim.fmt}  与接口原始尺寸一致 ✓`
            : `  ${dim.w}x${dim.h} ${dim.fmt}  （接口声明 ${rec.width}x${rec.height}）`;
        } else {
          note = `  ${dim.w}x${dim.h} ${dim.fmt}`;
        }
      }
      say(`  [${i + 1}/${records.length}] ${name}  ${(buf.length / 1024).toFixed(0)} KB${note}`);
    } catch (e) {
      say(`  [${i + 1}/${records.length}] 失败 ${name} (${e.message})`);
    }
  }
  say(`完成：${ok}/${records.length} 张`);
  say(`文件在这个文件夹里（马上帮你打开）：${OUT_DIR}`);
  try {
    spawn('explorer.exe', [OUT_DIR], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* 打不开就算了 */ }
}

/* ============================ 代理本体 ============================ */

/*
 * 解密范围：
 *   douyin.com —— 评论接口在这里，改写只需要它。
 *   图片 CDN  —— 必须一起解密，否则"用户点开了哪张图"在网络层上完全看不见。
 * 这些域名都在当前服务器证书的 SAN 里，不需要重装证书。
 * 其余域名一律原始隧道转发，不解密、不干预。
 */
const MITM_SUFFIXES = [
  'douyin.com',
  'douyinpic.com',
  'byteimg.com',
  'bytedance.com',
  'iesdouyin.com',
  'snssdk.com',
];

function shouldMitm(host) {
  const h = String(host).toLowerCase();
  return MITM_SUFFIXES.some((suffix) => h === suffix || h.endsWith('.' + suffix));
}

/**
 * 判断一个请求路径要不要解析改写，返回 'comment' / 'aweme' / ''。
 * 只按启用的功能决定，关掉的功能完全不做处理。
 */
function classifyEndpoint(pathname) {
  if (FEATURES.comment && COMMENT_API_RE.test(pathname)) return 'comment';
  if (FEATURES.aweme && /^\/aweme\//.test(pathname) && !COMMENT_API_RE.test(pathname)) return 'aweme';
  return '';
}

function upstreamFor(hostname, port) {
  // 仅供本地自动化测试使用：DY_UPSTREAM_OVERRIDE="www.douyin.com=127.0.0.1:9443"
  const raw = process.env.DY_UPSTREAM_OVERRIDE || '';
  for (const item of raw.split(',')) {
    const [h, target] = item.split('=');
    if (h && target && h.trim().toLowerCase() === hostname.toLowerCase()) {
      const [ip, p] = target.trim().split(':');
      return { host: ip, port: Number(p) || 443, insecure: true };
    }
  }
  return { host: hostname, port, insecure: false };
}

const HOP_BY_HOP = new Set([
  'connection', 'proxy-connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function handleInnerRequest(req, res) {
  const hostHeader = req.headers.host || '';
  let target;
  try {
    target = new URL(req.url, `https://${hostHeader}`);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
  }

  const up = upstreamFor(target.hostname, Number(target.port) || 443);
  const options = {
    host: up.host,
    port: up.port,
    method: req.method,
    path: target.pathname + target.search,
    headers,
    servername: target.hostname,
    rejectUnauthorized: !up.insecure,
  };

  // '' = 不用管，原样放行；'comment' / 'aweme' = 需要解析并改写
  const kind = classifyEndpoint(target.pathname);
  const started = Date.now();

  const upstreamReq = https.request(options, (upstreamRes) => {
    if (!kind) {
      if (TRACE) {
        traceSeq++;
        const tail = target.pathname.split('/').pop() || '';
        const uri = tail.split('~')[0];
        const tpl = (target.pathname.match(/~tplv-[^/]*/) || ['-'])[0];
        const bucket = target.pathname.split('/')[1] || '-';
        const type = String(upstreamRes.headers['content-type'] || '?').split(';')[0];
        const line = `[trace] #${traceSeq} ${req.method} ${target.hostname} bucket=${bucket} ${uri.slice(0, 22)} tpl=${tpl}`
          + ` dest=${req.headers['sec-fetch-dest'] || '-'}`
          + ` range=${req.headers.range ? 'Y' : 'N'}`
          + ` inm=${req.headers['if-none-match'] ? 'Y' : 'N'}`
          + ` len=${upstreamRes.headers['content-length'] || '?'}`
          + ` type=${type}`
          + ` cache=${upstreamRes.headers['cache-control'] || '-'}`;
        // 注意：say() 本身就会写日志，这里不能再调 logOnly，否则同一行会落盘两次
        if (/^image\//i.test(type) || /douyinpic|byteimg/i.test(target.hostname)) {
          say(line);          // 控制台只显示图片类，避免刷屏
        } else {
          logOnly(line);      // 其余只写日志文件
        }

      }

      // 请求的路径正好等于我们采集过的某张原图 —— 说明用户在客户端里点开了它
      const hitUri = originPathIndex.get(target.pathname);
      if (hitUri) {
        const rec = images.get(hitUri);
        if (rec && !rec.opened) {
          rec.opened = true;
          say(`  [点开] ${rec.author}${rec.text ? ' · ' + rec.text : ''}  (第 ${[...images.keys()].indexOf(hitUri) + 1} 张)`);
        }
        // 这张原图不要长期缓存：否则下次点开同一张时命中的是缓存、没有网络请求，"点开"就识别不出来了
        const headers = { ...upstreamRes.headers };
        delete headers.etag;
        delete headers['last-modified'];
        headers['cache-control'] = 'no-store';
        res.writeHead(upstreamRes.statusCode, headers);
        upstreamRes.pipe(res);
        return;
      }
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
      return;
    }

    const chunks = [];
    upstreamRes.on('data', (c) => chunks.push(c));
    upstreamRes.on('end', () => {
      apiHits++;
      const raw = Buffer.concat(chunks);
      const decoded = decompress(raw, upstreamRes.headers['content-encoding']);
      let body = raw;
      let changed = 0;
      let imgCount = 0;
      let workCount = 0;

      if (decoded) {
        let json = null;
        try {
          json = JSON.parse(decoded.toString('utf8'));
        } catch { json = null; }

        if (json) {
          if (FEATURES.comment && kind === 'comment') {
            const stats = rewriteComments(json);
            changed += stats.fields;
            imgCount = stats.imgs;
          }
          if (FEATURES.aweme) {
            const stats = rewriteAweme(json);
            changed += stats.fields;
            workCount = stats.works;
          }
          if (changed > 0) body = Buffer.from(JSON.stringify(json), 'utf8');

          if (TRACE && json.comments) {
            const tplOf = (node) => {
              const s = pickUrl(node);
              if (!s) return '-';
              return (s.match(/~tplv-[^/?]*/) || ['(无模板)'])[0];
            };
            const parts = [];
            for (const c of (json.comments || [])) {
              for (const im of (c.image_list || [])) {
                const u = (im.origin_url && im.origin_url.uri) || '';
                if (!u) continue;
                parts.push(`${u.split('/').pop().slice(0, 18)}`
                  + ` origin=${tplOf(im.origin_url)}`
                  + ` medium=${tplOf(im.medium_url)}`
                  + ` thumb=${tplOf(im.thumbnail_url)}`);
              }
            }
            if (parts.length) logOnly('[api-images] ' + parts.join('  |  '));
          }
        }
      }

      const outHeaders = { ...upstreamRes.headers };
      if (changed > 0) {
        // 改写过的响应不要进客户端缓存：否则下次客户端直接拿旧的（未改写）数据，
        // 评论那边还会导致我们看不到请求、识别不出"点开"。
        for (const k of ['content-encoding', 'content-length', 'transfer-encoding', 'etag', 'content-md5', 'expires']) {
          delete outHeaders[k];
        }
        outHeaders['cache-control'] = 'no-store';
        outHeaders['content-length'] = String(body.length);
      }
      res.writeHead(upstreamRes.statusCode, outHeaders);
      res.end(body);

      const tag = changed
        ? `改写 ${changed} 个字段`
          + (imgCount ? ` / ${imgCount} 张评论图` : '')
          + (workCount ? ` / ${workCount} 个作品` : '')
        : '无需改写';
      say(`  [接口] ${kind}  ${tag}  累计原图 ${images.size} 张 (${Date.now() - started}ms)`);
    });
  });

  upstreamReq.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('upstream error: ' + e.message);
  });
  req.pipe(upstreamReq);
}

function createProxy(certs) {
  const inner = http.createServer(handleInnerRequest);
  inner.on('clientError', (err, socket) => socket.destroy());

  const tlsServer = tls.createServer({
    key: certs.leafKey,
    cert: certs.leafPem + certs.caPem,
    ALPNProtocols: ['http/1.1'],        // 不提供 h2，让客户端回落到 HTTP/1.1，便于解析
    minVersion: 'TLSv1.2',
  }, (tlsSocket) => {
    inner.emit('connection', tlsSocket);
  });
  tlsServer.on('tlsClientError', (err) => {
    // 某个域名若报证书错误，说明它不在证书 SAN 覆盖范围内 —— 这种必须立刻看见，否则图片会静默加载失败
    say(`[tls错误] ${err.message}`);
  });

  const proxy = http.createServer((req, res) => {
    res.writeHead(405).end('only CONNECT is supported');
  });

  proxy.on('connect', (req, clientSocket, head) => {
    const [host, portText] = String(req.url).split(':');
    const port = Number(portText) || 443;
    clientSocket.on('error', () => {});
    if (TRACE) logOnly(`[connect] ${shouldMitm(host) ? 'MITM' : '隧道'} ${host}:${port}`);

    if (!shouldMitm(host)) {
      // 非目标域名：原样隧道，不解密
      const upstream = net.connect(port, host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      return;
    }

    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) clientSocket.unshift(head);
    tlsServer.emit('connection', clientSocket);
  });

  return proxy;
}

function listenOn(proxy, port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      proxy.removeListener('listening', onListening);
      reject(e);
    };
    const onListening = () => {
      proxy.removeListener('error', onError);
      resolve();
    };
    proxy.once('error', onError);
    proxy.once('listening', onListening);
    proxy.listen(port, '127.0.0.1');
  });
}

/**
 * 依次尝试候选端口。
 * 有些机器上 8080 会被安全软件或系统组件独占（报 EACCES，且不在 netsh 的保留段里），
 * 所以这里自动换端口，避免"代理设置指向了一个绑不上的端口"。
 */
async function bindProxy(certs, preferredPort, autoPick) {
  const candidates = autoPick
    ? [...new Set([preferredPort, 8899, 8888, 18080, 28080, 38080, 8081, 9000, 7891])]
    : [preferredPort];
  const failures = [];
  for (const port of candidates) {
    const proxy = createProxy(certs);
    try {
      await listenOn(proxy, port);
      return { proxy, port };
    } catch (e) {
      failures.push(`${port}: ${e.code || e.message}`);
      try { proxy.close(); } catch { /* ignore */ }
      if (e.code !== 'EACCES' && e.code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error(`没有可用端口（已尝试 ${failures.join(' / ')}）`);
}

/* ============================ 主流程 ============================ */

async function main() {
  if (WATCHDOG_PID) return runWatchdog(WATCHDOG_PID);

  // 只做功能选择，不启动代理（给 选择功能.bat 用）
  if (has('--choose-only')) {
    say('抖音评论区 · 图片/作品去水印代理 —— 功能选择');
    say('');
    const picked = await chooseFeatures();
    saveFeatureConfig(picked);
    say('');
    say(`已保存：${featuresToText(picked)}`);
    say(`配置文件：${CONFIG_FILE}`);
    say('下次双击 启动.bat 就按这个设置运行。');
    return 0;
  }

  /* ---------- 决定启用哪些功能 ---------- */
  // 优先级：命令行 --features > features.json > 首次运行交互选择 > 默认全开
  const argFeatures = opt('--features', '');
  if (argFeatures) {
    const parsed = parseFeatureArg(argFeatures);
    if (parsed) {
      FEATURES = parsed;
    } else {
      say(`[功能] 认不出 --features=${argFeatures}，本次按"两个都启用"处理。`);
    }
  } else if (has('--choose')) {
    FEATURES = await chooseFeatures();
    saveFeatureConfig(FEATURES);
  } else {
    const saved = loadFeatureConfig();
    if (saved) {
      FEATURES = saved;
    } else if (process.stdin.isTTY && !DEV) {
      FEATURES = await chooseFeatures();
      saveFeatureConfig(FEATURES);
      say('');
    }
  }

  say('抖音评论区 · 图片/作品去水印代理');
  say(`运行日志：${LOG_FILE || '(未能创建日志文件)'}`);
  say(`[功能] 已启用：${featuresToText(FEATURES)}`);
  if (!FEATURE_KEYS.some((k) => FEATURES[k])) {
    say('[功能] 警告：一个功能都没启用，代理只会转发流量、不做任何改写。');
    say('[功能] 想重选：双击 选择功能.bat，或者启动时加 --features comment,aweme');
  }
  say('');
  say('[环境] 注册表图片文件夹=' + (knownPicturesDir() || '(读不到)'));
  say('[环境] node=' + process.version);
  say('[环境] exe=' + process.execPath);
  say('[环境] script=' + fileURLToPath(import.meta.url));
  say('[环境] cwd=' + process.cwd());
  say('[环境] platform=' + process.platform + ' arch=' + process.arch);
  say('[环境] stdin.isTTY=' + process.stdin.isTTY + ' stdout.isTTY=' + process.stdout.isTTY);
  say('[环境] 追踪模式=' + (TRACE ? '开（会记录每一次图片请求）' : '关'));
  say('');

  const picked = pickDownloadDir();
  OUT_DIR = picked.dir;
  if (picked.tried.length) {
    say('[下载] 这些目录不可写，已跳过：' + picked.tried.join(' / '));
  }
  if (OUT_DIR) {
    say(`[下载] 原图将保存到：${OUT_DIR}`);
  } else {
    say('[下载] 没有找到可写目录。');
    say('[下载] 改写功能不受影响（客户端里仍然是无水印图），只是最后不能自动下载。');
    say('[下载] 想自动下载就指定一个可写目录，例如：启动.bat -o D:\\downloads\\douyin');
  }
  say('');

  const certs = ensureCerts();
  say('[环境] 证书指纹=' + certs.thumbprint);

  if (has('--install-ca')) {
    const r = installCa(path.join(CERT_DIR, 'ca.cer'));
    say(r.ok ? `根证书已安装（指纹 ${certs.thumbprint}）` : `安装失败：${r.err || r.out}`);
    return r.ok ? 0 : 1;
  }

  if (has('--uninstall-ca')) {
    const r = uninstallCa(path.join(CERT_DIR, 'ca.cer'));
    say(r.ok ? '根证书已从"受信任的根证书颁发机构"移除' : `移除失败：${r.err || r.out}`);
    return r.ok ? 0 : 1;
  }

  if (has('--restore-proxy')) {
    say(restoreProxyFromBackup());
    return 0;
  }

  if (DEV) {
    say('[dev] 跳过证书信任检查和系统代理设置。');
  } else if (!isCaTrusted(certs.thumbprint)) {
    say('[环境] 根证书当前状态：未受信任');
    say('根证书还没装进系统信任区，不装的话抖音看不懂我们伪造的证书，代理起不到作用。');
    say('（这个证书只存在你本机，私钥也只在 certs 目录里；不想要了随时用"卸载根证书.bat"移除。）');
    const yes = await ask('现在安装根证书吗？会弹出一次 Windows 安全警告，选"是"。(Y/n，直接回车＝安装) ', true);
    if (!yes) {
      say('已取消。可以稍后运行：node proxy.mjs --install-ca');
      return 1;
    }
    const r = installCa(path.join(CERT_DIR, 'ca.cer'));
    if (!r.ok && !isCaTrusted(certs.thumbprint)) {
      say('安装失败：' + (r.err || r.out));
      return 1;
    }
    say('根证书已安装。');
  } else {
    say('[环境] 根证书状态：已受信任');
  }

  // 先监听，确认拿到一个真能用的端口，再去动系统代理。
  // 顺序很关键：反过来一旦监听失败，系统代理就会指向一个没人监听的端口，整机断网。
  let bound;
  try {
    bound = await bindProxy(certs, PORT, !argv.includes('--port'));
  } catch (e) {
    say('绑定端口失败：' + (e.message || e));
    say('可以手动指定一个端口，例如：启动.bat --port 8899');
    return 1;
  }
  const proxy = bound.proxy;
  const port = bound.port;
  say(`[代理] 已监听 127.0.0.1:${port}`);
  if (port !== PORT) {
    say(`[代理] 端口 ${PORT} 在这台机器上被拒绝（EACCES），已自动改用 ${port}。`);
  }

  // 再接管系统代理
  if (!DEV) {
    if (!fs.existsSync(BACKUP_FILE)) {
      fs.mkdirSync(CERT_DIR, { recursive: true });
      fs.writeFileSync(BACKUP_FILE, JSON.stringify(readProxySettings(), null, 2), 'utf8');
    }
    const applied = applyProxy(`127.0.0.1:${port}`);
    say('[代理] 写入结果 ok=' + applied.ok + ' out=' + applied.out + ' err=' + applied.err);
    if (!applied.ok) {
      say('设置系统代理失败：' + (applied.err || applied.out));
      say('可以手动设置：Windows 设置 → 网络和 Internet → 代理 → 手动设置代理 → 127.0.0.1:' + port);
    } else {
      proxyApplied = true;
      say(`系统代理已指向 127.0.0.1:${port}`);
      startWatchdog();   // 万一本进程被强杀，由看门狗把代理设置还原
    }
  }
  say('');
  say('代理已启动。接下来：');
  let step = 1;
  say(`  ${step++}. 回到抖音电脑版，切到目标视频，让它重新加载一次（划走再点回来即可）；`);
  if (FEATURES.comment) {
    say(`  ${step++}. 点开评论图片看到的就是原图；点保存存下来的也是原图；`);
  }
  if (FEATURES.aweme) {
    say(`  ${step++}. 视频/图文点"下载"存下来的就是无水印版本；`);
  }
  say(`  ${step++}. 用完回到这个窗口，直接按【回车】结束（或输入 q 再回车）。`);
  say('');
  say('注意：不要按 Ctrl+C。在 .bat 里按 Ctrl+C 会先弹出 cmd 自己的');
  say('"终止批处理操作吗(Y/N)?"，选 Y 会把整个窗口关掉，脚本就没机会还原代理了。');
  say('');

  let stopping = false;
  // 启动后到抓到第一张图之间是静默的，容易让人以为卡死。
  // 定期报一次状态，顺便提醒怎么收尾。
  const heartbeat = setInterval(() => {
    const found = images.size;
    if (!FEATURES.comment) {
      say(`[状态] 运行中，已改写 ${rewriteCount} 个字段（看到 ${apiHits} 次接口响应）。结束后按回车。`);
    } else if (found === 0) {
      say('[状态] 还没抓到评论原图。确认抖音里已经打开视频、并把评论区展开（划走再点回来）。');
    } else {
      say(`[状态] 已采集 ${found} 张原图（看到 ${apiHits} 次评论接口响应）。结束后按回车。`);
    }
  }, 20000);

  const stopStdin = () => {
    try {
      process.stdin.removeAllListeners('data');
      process.stdin.pause();
    } catch { /* ignore */ }
  };
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    stopStdin();
    say('');
    say('正在收尾...');
    try { proxy.close(); } catch { /* ignore */ }
    if (!DEV) say(restoreProxyFromBackup());
    proxyApplied = false;
    say(`本次共看到 ${apiHits} 次评论接口响应，改写 ${rewriteCount} 个字段，采集到 ${images.size} 张原图。`);
    if (images.size) {
      const all = [...images.values()];
      const opened = all.filter((r) => r.opened);
      say(`采集到 ${all.length} 张原图，其中你在客户端里点开过 ${opened.length} 张。`);
      if (opened.length) {
        say('你点开过的是：');
        opened.slice(0, 20).forEach((r, i) => {
          say(`  ${i + 1}. ${r.author}${r.text ? ' · ' + r.text : ''}`);
        });
        if (opened.length > 20) say(`  …还有 ${opened.length - 20} 张`);
      }
      const answer = (await askRaw('下载哪些？ y=只下载你点开的 / a=全部 / 直接回车=不下载： ')).trim().toLowerCase();
      const target = /^a/.test(answer) ? all : (/^y/.test(answer) ? opened : null);
      if (target && target.length) {
        try {
          await downloadAll(target);
        } catch (e) {
          // 下载失败不能把整个收尾流程也带崩
          say('下载过程出错：' + (e?.message || e));
          say('原图直链如下，可复制出来用别的方式下载：');
          for (const r of target) say('  ' + r.url);
        }
      } else if (/^y/.test(answer)) {
        say('这次没有点开过任何评论图片，所以没有可下载的。');
      }
    }
    say('已退出。');
    process.exit(0);
  };

  // 优雅退出：控制台里按回车、或输入 q 再回车
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    const text = String(chunk).trim().toLowerCase();
    if (text === '' || text === 'q' || text === 'quit' || text === 'exit') shutdown();
  });
  process.stdin.resume();

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return new Promise(() => {});
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((e) => {
    say('出错：' + (e?.stack || e));
    restoreIfApplied();
    process.exit(1);
  });
