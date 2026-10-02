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
import { qualityCandidates, collectImageCandidates } from './quality.mjs';

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

/*
 * 实验开关：让评论接口换一种图片格式返回。
 * 客户端请求评论接口时会带 pc_img_format=webp，接口因此给的都是"origin-webp:q75"这种 WebP 转码版；
 * 如果把它改成 jpeg（或不带），理论上能拿到更高码率的 JPEG 原图。
 * 风险：请求 URL 带 a_bogus 签名，改参数可能直接校验不通过 —— 所以做成实验开关，由用户决定试不试。
 */
const IMG_FORMAT = String(opt('--img-format', '')).trim().toLowerCase();

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
    short: '评论区图片',
    desc: '点开评论图片看到的就是原图，可以只保存你点开过的那几张',
  },
  {
    key: 'aweme',
    name: '作品去水印',
    short: '作品去水印',
    desc: '视频 / 图文点"下载"就是无水印版；作者关了下载时自动把灰按钮变回可点',
  },
  {
    key: 'pick',
    name: '点赞/收藏即标记',
    short: '点赞收藏',
    desc: '你点赞或收藏过的作品会被记下，结束时可下载',
  },
];
const FEATURE_KEYS = FEATURE_DEFS.map((f) => f.key);
const CONFIG_FILE = path.join(HERE, 'features.json');
// 把本次收集到的作品地址落盘，供"粘贴链接下载"复用（跨次运行滚动累积）
const WORKS_INDEX = path.join(HERE, 'works-index.json');

let FEATURES = Object.fromEntries(FEATURE_KEYS.map((k) => [k, true]));

function loadFeatureConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const list = Array.isArray(raw.features) ? raw.features.slice() : [];
    // 兼容旧配置：unlock 已经并入 aweme
    if (list.includes('unlock') && !list.includes('aweme')) list.push('aweme');
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
        note: '改完保存即可生效；也可以用 选择功能.bat 重新选。留空数组或删掉本文件会回到默认（全部启用）。',
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
  // 兼容旧写法：--features unlock 等价于 aweme
  if (parts.includes('unlock') && !parts.includes('aweme')) parts.push('aweme');
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
// 点赞 / 收藏动作接口（用来当"我要这个作品"的触发器）
const PICK_API_RE = /\/commit\/item\/digg|\/aweme\/collect/;
const REG_PATH = String.raw`HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings`;

/* ============================ 基础工具 ============================ */

const say = (msg) => process.stdout.write(msg + '\n');

/** 控制台里中文是双宽字符，对齐要按"显示宽度"算，不能按字符个数 */
function displayWidth(text) {
  let w = 0;
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    const wide = (c >= 0x1100 && c <= 0x115f)
      || (c >= 0x2e80 && c <= 0xa4cf)
      || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff)
      || (c >= 0xfe30 && c <= 0xfe6f)
      || (c >= 0xff00 && c <= 0xff60)
      || (c >= 0xffe0 && c <= 0xffe6)
      || (c >= 0x1f300 && c <= 0x1f64f);
    w += wide ? 2 : 1;
  }
  return w;
}

/** 把 text 补到指定显示宽度（至少留一个空格） */
function padTo(text, width) {
  const s = String(text);
  return s + ' '.repeat(Math.max(1, width - displayWidth(s)));
}
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
  say('要启用哪些功能？');
  say('');
  FEATURE_DEFS.forEach((f, i) => say(`  ${i + 1}  ${padTo(f.name, 20)}${f.desc}`));
  say('');
  const all = Object.fromEntries(FEATURE_KEYS.map((k) => [k, true]));
  const answer = (await askRaw('输入编号（如 1,2），回车＝全部启用： ')).trim();
  if (!answer) return all;

  const picked = answer
    .split(/[,，\s、]+/)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= FEATURE_DEFS.length);

  if (!picked.length) {
    say('没看懂输入，这次先按全部启用处理（之后可双击 选择功能.bat 重选）。');
    return all;
  }
  const result = Object.fromEntries(FEATURE_DEFS.map((f, i) => [f.key, picked.includes(i + 1)]));
  say(`已选择：${featuresToText(result)}  （已记住，想改就双击 选择功能.bat）`);
  return result;
}

/* ============================ 证书管理 ============================ */

function ensureCerts() {
  if (fs.existsSync(path.join(CERT_DIR, 'ca.pem')) && fs.existsSync(path.join(CERT_DIR, 'leaf.pem'))) {
    return loadCerts(CERT_DIR);
  }
  say('  正在生成证书…');
  const { thumbprint } = generateCerts(CERT_DIR);
  logOnly(`证书已生成（CA 指纹 ${thumbprint}）`);
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
const works = new Map();    // aweme_id -> record（只存地址和元信息，不存文件）
let rewriteCount = 0;
let apiHits = 0;
let traceSeq = 0;
let worksSeen = 0;          // 识别到的作品数（视频/图文）
let unlockedTotal = 0;      // 其中原本禁止下载、被自动解除的个数
let upgradedCount = 0;      // 评论图里自动换成了更大候选的个数
let imgFormatHits = 0;      // 实验：改写 pc_img_format 的次数
let blockedSeen = 0;        // 看到多少个"原本禁止下载"的作品
const startedAt = Date.now();
let idleNotice = false;     // 是否已经提示过"等待中"，接通后收掉

const VERSION = 'v1.6.1';

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
  if (bestUrl) return { node: bestNode, url: bestUrl, uri: (bestNode && bestNode.uri) || '' };

  for (const field of ['play_addr', 'play_addr_lowbr', 'play_addr_265']) {
    const url = pickUrl(video[field]);
    if (url) return { node: video[field], url: deWatermark(url), uri: video[field].uri || '' };
  }
  return null;
}

/*
 * 处理作品（视频 / 图文）。三件事，各自受功能开关控制：
 *   1) 收集  —— 只把干净地址记下来（几百字节），全程不下载任何文件
 *   2) 去水印 —— 把下载专用字段指向播放地址（客户端点"下载"就是干净版）
 *   3) 解锁   —— 把 allow_download 等标志位改开（作者关了下载时，灰按钮变可点）
 */
function rewriteAweme(json) {
  let fields = 0;
  let workCount = 0;
  let unlocked = 0;
  const seen = new Set();
  const stack = [json];

  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);

    // ---- 收集：识别"这是个作品"并记下干净地址 ----
    const awemeId = node.aweme_id || node.awemeId || '';
    if (awemeId && (node.video || Array.isArray(node.images))) {
      collectWork(node, awemeId);

      // 诊断：这个作品是不是被作者限制了下载？
      // 不管有没有开"作品去水印"都记一笔 —— 否则用户看到灰按钮也不知道是没开功能还是没生效
      const vc = node.video_control;
      const restricted = node.prevent_download === true
        || (vc && typeof vc === 'object'
          && (vc.allow_download === false
            || (vc.download_info && typeof vc.download_info === 'object' && vc.download_info.level !== 0)));
      if (restricted) {
        blockedSeen++;
        logOnly(`[限制] aweme_id=${awemeId} 原本禁止下载`
          + `（allow_download=${vc && vc.allow_download}`
          + ` level=${vc && vc.download_info && vc.download_info.level}`
          + ` prevent_download=${node.prevent_download}）`
          + (FEATURES.aweme ? ' → 已解除' : ' → 但"作品去水印"没启用，没有解除'));
        if (!FEATURES.aweme) {
          logOnly('[限制] 想解除请在 选择功能.bat 里勾选「作品去水印」');
        }
      }
    }

    // ---- 视频 ----
    const video = node.video;
    if (video && typeof video === 'object') {
      const clean = pickCleanVideoSource(video);
      if (clean && FEATURES.aweme) {
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
          workCount++;
        }
      }
    }

    // ---- 图文图片列表（评论图片走各自的分支）----
    if (FEATURES.aweme) {
      for (const key of ['images', 'image_list']) {
        const arr = node[key];
        if (!Array.isArray(arr)) continue;
        let n = 0;
        for (const im of arr) n += rewriteOneImage(im);
        if (n) {
          fields += n;
          workCount++;
        }
      }
    }

    // ---- 解除下载限制（并入"作品去水印"；只在真的被限制时才动）----
    if (FEATURES.aweme) {
      let n = 0;
      if (node.prevent_download) {
        node.prevent_download = false;
        n++;
      }
      const vc = node.video_control;
      if (vc && typeof vc === 'object') {
        if (vc.allow_download === false) {
          vc.allow_download = true;
          n++;
        }
        if (vc.download_info && typeof vc.download_info === 'object' && vc.download_info.level !== 0) {
          vc.download_info.level = 0;
          n++;
        }
      }
      if (n) {
        fields += n;
        workCount++;
        unlocked++;
      }
    }

    for (const key of Object.keys(node)) {
      const val = node[key];
      if (val && typeof val === 'object') stack.push(val);
    }
  }

  return { fields, works: workCount, unlocked };
}

/** 记下一个作品的干净地址（只记地址，不下载任何东西） */
function collectWork(node, awemeId) {
  if (!FEATURES.aweme && !FEATURES.pick) return;
  let rec = works.get(awemeId);
  if (!rec) {
    rec = {
      awemeId,
      desc: '',
      author: '',
      videoUrl: '',
      playUri: '',
      tierUris: [],
      imageUrls: [],
      picked: false,
      pickKind: '',
    };
    works.set(awemeId, rec);
  }

  const video = node.video;
  if (video && typeof video === 'object') {
    const clean = pickCleanVideoSource(video);
    if (clean) {
      if (!rec.videoUrl) rec.videoUrl = clean.url;
      // uri 是视频的永久编号，不会过期；结束时靠它去换新鲜的下载地址
      if (!rec.playUri) rec.playUri = clean.uri || '';
    }
    if (!rec.tierUris.length && Array.isArray(video.bit_rate)) {
      for (const br of video.bit_rate) {
        const u = br && br.play_addr && br.play_addr.uri;
        if (u) rec.tierUris.push(u);
      }
    }
  }
  if (Array.isArray(node.images) && !rec.imageUrls.length) {
    for (const im of node.images) {
      const u = pickCleanImageUrl(im);
      if (u) rec.imageUrls.push(u);
    }
  }
  if (!rec.author) rec.author = node.author?.nickname || node.author?.unique_id || '';
  if (!rec.desc) rec.desc = String(node.desc || '').replace(/\s+/g, ' ').slice(0, 40);
}

/** 点赞 / 收藏 → 把这个作品标记为"我要的" */
function markPicked(awemeId, pathname, params) {
  if (!FEATURES.pick || !awemeId) return;
  const kind = /digg/.test(pathname) ? '点赞' : '收藏';
  const type = params.get('type');
  const action = params.get('action');
  const cancel = type === '0' || action === '0';

  let rec = works.get(awemeId);
  if (!rec) {
    rec = { awemeId, desc: '', author: '', videoUrl: '', imageUrls: [], picked: false, pickKind: '' };
    works.set(awemeId, rec);
  }
  rec.picked = !cancel;
  rec.pickKind = cancel ? '' : kind;
  logOnly(`[标记] ${cancel ? '取消' + kind : kind} aweme_id=${awemeId} type=${type ?? '-'} action=${action ?? '-'}`);
  if (!cancel) {
    const who = [rec.author, rec.desc].filter(Boolean).join(' · ');
    say(`  · 标记  ${kind}：${who || awemeId}`);
  }
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
      // 把这条图片对象里所有候选地址都记进日志：排查"为什么抓到的比手机小"时全靠它
      if (TRACE) {
        const parts = [];
        for (const f of ['origin_url', 'medium_url', 'thumbnail_url', 'download_url', 'owner_watermark_image']) {
          const list = (im[f] && im[f].url_list) || [];
          if (!list.length) continue;
          parts.push(`${f}=${list.length}个:${list.map((u) => String(u).split('/').pop().slice(0, 46)).join(' | ')}`);
        }
        if (parts.length) logOnly(`[候选] ${uri.split('/').pop().slice(0, 18)}  ${parts.join('   ')}`);
      }
      if (!images.has(uri)) {
        let originPath = '';
        try {
          originPath = new URL(clean).pathname;
        } catch { /* 解析不了就算了 */ }
        const rec = {
          uri,
          url: clean,
          // 这条图片对象里所有可用地址（含其它字段的），下载时拿来比大小
          candidates: collectImageCandidates(im, clean),
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

/** 抓一个地址的完整字节；超过上限就当这个候选不可用 */
async function fetchBuf(url, capBytes = 30 * 1024 * 1024) {
  const res = await fetch(url, {
    headers: { Referer: 'https://www.douyin.com/', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > capBytes) throw new Error(`超过 ${Math.round(capBytes / 1048576)}MB`);
  return buf;
}

/**
 * 边下边比：拿到超过 limitBytes 就立刻中止（说明它比当前赢家大）。
 * 返回 { buf, exceeded } —— exceeded=true 时 buf 为 null。
 */
async function fetchBufLimited(url, limitBytes) {
  const res = await fetch(url, {
    headers: { Referer: 'https://www.douyin.com/', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const declared = Number(res.headers.get('content-length')) || 0;
  if (declared && declared <= limitBytes) {
    return { buf: Buffer.from(await res.arrayBuffer()), exceeded: false };
  }
  const chunks = [];
  let got = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    got += chunk.length;
    if (got > limitBytes) {
      try { await res.body.cancel(); } catch { /* ignore */ }
      return { buf: null, exceeded: true, got };
    }
  }
  return { buf: Buffer.concat(chunks), exceeded: false };
}

/**
 * 只问大小、不下载正文。
 * 先试 HEAD；有些 CDN 不给 HEAD，就退化成 Range: bytes=0-0，从 Content-Range 里读总大小。
 */
async function probeSize(url) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { Referer: 'https://www.douyin.com/', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const len = Number(res.headers.get('content-length'));
      if (Number.isFinite(len) && len > 0) return len;
    }
  } catch { /* 落到 Range 那条路 */ }

  try {
    const res = await fetch(url, {
      headers: {
        Referer: 'https://www.douyin.com/',
        'User-Agent': 'Mozilla/5.0',
        Range: 'bytes=0-0',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 206) {
      const total = Number(String(res.headers.get('content-range') || '').split('/')[1]);
      await res.arrayBuffer();
      if (Number.isFinite(total) && total > 0) return total;
    }
    if (res.ok) {
      const buf = await res.arrayBuffer();
      if (buf.length > 0) return buf.length;
    }
  } catch { /* 这个候选不可用 */ }
  return null;
}

/**
 * 挑最大的那份候选。
 * 先用 HEAD 比大小（只问不拉，省流量），只把最大的那个真正下下来。
 * 对"探测不到大小、但来源是接口真实字段"的候选，再下载一小段比一比 ——
 * 有些 CDN 不给 HEAD 也不给 Range，光看探测结果会漏掉真正的大图。
 */
async function fetchBestImage(rec) {
  // 候选在采集阶段就准备好了（含所有字段 + 各自变体，并标了来源）
  const list = (rec.candidates || []).filter((c) => c && c.url);
  if (!list.some((c) => c.url === rec.url)) list.unshift({ url: rec.url, from: 'clean' });
  const tried = [];
  let winner = rec.url;
  let winnerSize = 0;
  for (const c of list) {
    const len = await probeSize(c.url);
    tried.push({ ...c, size: len });
    if (len && len > winnerSize) {
      winnerSize = len;
      winner = c.url;
    }
  }

  // 探测失败的"真实字段"候选：边下边比，超过当前赢家就当场换掉
  let buf = null;
  if (winnerSize > 0) {
    const suspects = tried.filter((t) => !t.size && t.url !== winner && !/^(去模板|变体)/.test(t.from));
    for (const c of suspects) {
      try {
        const part = await fetchBufLimited(c.url, winnerSize);
        if (part.exceeded) {
          buf = await fetchBuf(c.url);            // 它更大，整份取下来
          winner = c.url;
          c.size = buf.length;
          break;
        }
        if (part.buf && part.buf.length > winnerSize) {
          buf = part.buf;
          winner = c.url;
          winnerSize = part.buf.length;
          c.size = part.buf.length;
        }
      } catch { /* 这个候选确实取不到 */ }
    }
  }

  if (!buf) buf = await fetchBuf(winner);
  return { url: winner, buf, tried, upgraded: winner !== rec.url };
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
      // 探测几个候选，取最大的那份
      // （接口给的 origin_url 是"原始尺寸 + WebP 75%"，往往不是能拿到的最清晰版本）
      const got = await fetchBestImage(rec);
      const buf = got.buf;
      if (buf.length < 1024) throw new Error('内容过小');
      fs.writeFileSync(path.join(OUT_DIR, name), buf);
      ok++;
      if (got.upgraded) upgradedCount++;
      if (got.tried.length > 1) {
        const usable = got.tried.filter((t) => t.size).sort((a, b) => b.size - a.size);
        const wonFrom = (got.tried.find((t) => t.url === got.url) || {}).from || '?';
        logOnly(`[画质] ${name}  选中 ${Math.round(got.buf.length / 1024)}KB（来源 ${wonFrom}）`
          + `  可用 ${usable.length}/${got.tried.length}：`
          + usable.map((t) => `${Math.round(t.size / 1024)}KB(${t.from})`).join('  '));
      }
      // 尺寸只在"和接口声明对不上"时才提示，正常情况不刷屏
      const dim = imageSizeOf(buf);
      let note = '';
      if (dim && dim.w && rec.width && rec.height && (dim.w !== rec.width || dim.h !== rec.height)) {
        note = `  ⚠ ${dim.w}×${dim.h}（接口声明 ${rec.width}×${rec.height}）`;
      }
      const size = dim && dim.w ? `  ${dim.w}×${dim.h}` : '';
      const tag = `${i + 1}/${records.length}`.padEnd(7);
      say(`  ${tag}${name}${size}  ${(buf.length / 1024).toFixed(0)} KB${note}`);
    } catch (e) {
      say(`  ${`${i + 1}/${records.length}`.padEnd(7)}${name}  失败 (${e.message})`);
    }
  }
  say(`完成：${ok}/${records.length} 张`);
  if (upgradedCount) {
    say(`（其中 ${upgradedCount} 张原始地址不是最清晰的，已自动换成更大的那份）`);
  }
  return ok;
}

/** 下载单个文件到磁盘；视频可能几十 MB，所以带进度回调 */
async function downloadToFile(url, file, onProgress) {
  const res = await fetch(url, {
    headers: { Referer: 'https://www.douyin.com/', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const total = Number(res.headers.get('content-length')) || 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const out = fs.createWriteStream(file);
  let got = 0;
  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (onProgress) onProgress(got, total);
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  return got;
}

/**
 * 下载作品（视频 / 图文）。这一步才是真正走流量的时候，而且只下你标记过的那些。
 * 视频动辄几十 MB，所以每张 25% 报一次进度，避免长时间没反馈。
 */
/**
 * 用一个作品的永久编号（uri）去换新鲜的下载地址。
 * 实时收集到的是"下载地址"，那个地址带签名、会过期；uri 不会过期。
 * 实测：/aweme/v1/play/?video_id=<uri>&ratio=1080p 会 302 到一个可下载的地址，且不需要签名。
 */
function playApiCandidates(rec) {
  const uris = [rec.playUri, ...(rec.tierUris || [])].filter(Boolean);
  const out = [];
  for (const uri of [...new Set(uris)]) {
    for (const ratio of ['1080p', '720p', '540p', '']) {
      out.push('https://www.douyin.com/aweme/v1/play/?video_id=' + encodeURIComponent(uri)
        + (ratio ? `&ratio=${ratio}&line=0` : ''));
    }
  }
  if (rec.videoUrl) out.push(rec.videoUrl);
  return out;
}

async function downloadWorks(records) {
  if (!OUT_DIR) {
    say('没有可写目录，改为把地址打印出来：');
    for (const r of records) {
      if (r.videoUrl) say('  ' + r.videoUrl);
      for (const u of r.imageUrls) say('  ' + u);
    }
    return 0;
  }
  const videoDir = path.join(OUT_DIR, '视频');
  const imageDir = path.join(OUT_DIR, '图文');
  let ok = 0;

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const tag = `${i + 1}/${records.length}`.padEnd(7);
    const who = sanitize(rec.author || '未知作者');
    const what = sanitize(rec.desc || rec.awemeId);

    // ---- 图文：一个作品一个文件夹 ----
    if (rec.imageUrls.length) {
      const folder = path.join(imageDir, `${who}_${what}`);
      let n = 0;
      for (let k = 0; k < rec.imageUrls.length; k++) {
        const file = path.join(folder, `${String(k + 1).padStart(2, '0')}.${extOf(rec.imageUrls[k])}`);
        try {
          await downloadToFile(rec.imageUrls[k], file);
          n++;
        } catch (e) {
          logOnly(`[下载] 第 ${k + 1} 张失败：${e.message}`);
        }
      }
      say(`  ${tag}${who} · 图文  ${n}/${rec.imageUrls.length} 张`);
      if (n) ok++;
      continue;
    }

    // ---- 视频 ----
    const candidates = playApiCandidates(rec);
    if (candidates.length) {
      const name = `${who}_${what}.mp4`;
      const file = path.join(videoDir, name);
      for (const [k, u] of candidates.entries()) {
        let lastStep = 0;
        try {
          const size = await downloadToFile(u, file, (got, total) => {
            if (!total) return;
            const step = Math.floor((got / total) * 4);   // 每 25% 报一次
            if (step > lastStep) {
              lastStep = step;
              say(`  ${tag}${name}  ${step * 25}%`);
            }
          });
          const src = u.includes('/aweme/v1/play/') ? ((u.match(/ratio=(\w+)/) || [])[1] || '默认') : '缓存直链';
          say(`  ${tag}${name}  ${(size / 1048576).toFixed(1)} MB  (${src})`);
          ok++;
          break;
        } catch (e) {
          logOnly(`[下载] 候选 ${k + 1} 失败：${u.slice(0, 90)} → ${e.message}`);
          if (k === candidates.length - 1) say(`  ${tag}${name}  失败（${e.message}）`);
        }
      }
      continue;
    }

    say(`  ${tag}${who}_${what}  没有可用地址`);
    logOnly(`[下载] aweme_id=${rec.awemeId} 没有可用地址`);
  }
  return ok;
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
  const awemeWanted = FEATURES.aweme || FEATURES.pick;
  if (awemeWanted && /^\/aweme\//.test(pathname) && !COMMENT_API_RE.test(pathname)) return 'aweme';
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

  // 点赞 / 收藏动作 —— 直接把那个作品标记为"我要的"（只记标记，不下载）
  if (FEATURES.pick && PICK_API_RE.test(target.pathname)) {
    try {
      markPicked(
        target.searchParams.get('aweme_id') || target.searchParams.get('item_id') || '',
        target.pathname,
        target.searchParams,
      );
    } catch { /* 参数解析失败就算了 */ }
  }

  /*
   * 实验开关 --img-format：
   * 客户端请求评论接口时带 pc_img_format=webp，接口因此只给 WebP 转码版。
   * 改掉这个参数理论上能要来更高码率的原始图，但请求 URL 带 a_bogus 签名，
   * 改参数有可能直接校验不通过 —— 所以做成实验，由用户决定试不试。
   */
  let requestPath = target.pathname + target.search;
  if (IMG_FORMAT && COMMENT_API_RE.test(target.pathname)) {
    try {
      const probe = new URL(target.pathname + target.search, 'https://x.invalid');
      if (probe.searchParams.has('pc_img_format')) {
        const before = probe.searchParams.get('pc_img_format');
        if (IMG_FORMAT === 'none') probe.searchParams.delete('pc_img_format');
        else probe.searchParams.set('pc_img_format', IMG_FORMAT);
        requestPath = probe.pathname + probe.search;
        if (imgFormatHits === 0) {
          logOnly(`[实验] pc_img_format：${before} → ${IMG_FORMAT}`);
          say(`  · 实验：已把评论接口的图片格式请求改成 ${IMG_FORMAT}（接口若报错说明签名校验不通过）`);
        }
        imgFormatHits++;
      }
    } catch { /* 解析失败就不改 */ }
  }

  const up = upstreamFor(target.hostname, Number(target.port) || 443);
  const options = {
    host: up.host,
    port: up.port,
    method: req.method,
    path: requestPath,
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
          say(`  · 点开  ${rec.author}${rec.text ? ' · ' + rec.text : ''}`);
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
      let json = null;

      if (decoded) {
        try {
          json = JSON.parse(decoded.toString('utf8'));
        } catch { json = null; }

        if (json) {
          if (FEATURES.comment && kind === 'comment') {
            const stats = rewriteComments(json);
            changed += stats.fields;
            imgCount = stats.imgs;
          }
          if (FEATURES.aweme || FEATURES.pick) {
            const stats = rewriteAweme(json);
            changed += stats.fields;
            workCount = stats.works;
            worksSeen += stats.works;
            if (stats.unlocked) {
              unlockedTotal += stats.unlocked;
              logOnly(`[解锁] 这段响应里有 ${stats.unlocked} 处原本禁止下载，已自动解除`);
            }
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

      // 控制台只说人话；技术明细（字段数、耗时、kind）都进日志
      // 路径 + 解析结果一定要记：出现"改写 0 个字段"时，靠它才能分清是"没这个字段"还是"根本没解析成功"
      const topKeys = json ? Object.keys(json).slice(0, 8).join(',') : '';
      const parseNote = json
        ? `解析=OK 顶层键=${topKeys || '(空对象)'}`
        : `解析失败(编码=${upstreamRes.headers['content-encoding'] || '-'} 类型=${String(upstreamRes.headers['content-type'] || '-').split(';')[0]} ${raw.length}字节)`;
      logOnly(`[接口] ${kind} ${target.pathname}  改写 ${changed} 个字段`
        + (imgCount ? ` / ${imgCount} 张评论图` : '')
        + (workCount ? ` / ${workCount} 个作品` : '')
        + `  累计原图 ${images.size} 张 / 作品 ${worksSeen} 个`
        + `  | ${parseNote} (${Date.now() - started}ms)`);

      if (idleNotice) {
        idleNotice = false;
        say('  · 已接通');
      }
      if (imgCount) say(`  · 抓到 ${imgCount} 张评论图（累计 ${images.size}）`);
      if (workCount) say(`  · 识别到 ${workCount} 个作品（累计 ${worksSeen}）`);
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

  // 版本号按需查看：启动.bat --version
  if (has('--version') || has('-v')) {
    say(`抖音去水印代理 ${VERSION}`);
    return 0;
  }

  // 只做功能选择，不启动代理（给 选择功能.bat 用）
  if (has('--choose-only')) {
    say('抖音去水印代理 · 功能选择');
    say('');
    const picked = await chooseFeatures();
    saveFeatureConfig(picked);
    say('');
    say(`已保存：${featuresToText(picked)}`);
    say('下次双击 启动.bat 生效。');
    logOnly(`[功能] 配置文件=${CONFIG_FILE}`);
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

  // 界面只留人话；下面这些技术信息全部只进日志文件，方便出问题时排查
  say('抖音去水印代理');
  say('');
  logOnly(`[环境] 版本=${VERSION}`);
  logOnly(`[环境] 注册表图片文件夹=${knownPicturesDir() || '(读不到)'}`);
  logOnly(`[环境] node=${process.version}`);
  logOnly(`[环境] exe=${process.execPath}`);
  logOnly(`[环境] script=${fileURLToPath(import.meta.url)}`);
  logOnly(`[环境] cwd=${process.cwd()}`);
  logOnly(`[环境] platform=${process.platform} arch=${process.arch}`);
  logOnly(`[环境] stdin.isTTY=${process.stdin.isTTY} stdout.isTTY=${process.stdout.isTTY}`);
  logOnly(`[环境] 追踪模式=${TRACE ? '开' : '关'}`);
  logOnly(`[环境] 功能=${FEATURE_KEYS.filter((k) => FEATURES[k]).join(',') || '(全关)'}`);
  logOnly(`[环境] 运行日志=${LOG_FILE || '(未能创建日志文件)'}`);

  if (!FEATURE_KEYS.some((k) => FEATURES[k])) {
    say('提示：当前一个功能都没启用，只会转发流量、不做改写。');
    say('      想重选就双击 选择功能.bat。');
    say('');
  }

  const picked = pickDownloadDir();
  OUT_DIR = picked.dir;
  if (picked.tried.length) logOnly('[下载] 这些目录不可写，已跳过：' + picked.tried.join(' / '));
  logOnly(`[下载] 保存目录=${OUT_DIR || '(没有找到可写目录)'}`);

  const certs = ensureCerts();
  logOnly('[环境] 证书指纹=' + certs.thumbprint);

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
    logOnly('[dev] 跳过证书信任检查和系统代理设置。');
  } else if (!isCaTrusted(certs.thumbprint)) {
    logOnly('[环境] 根证书当前状态：未受信任');
    say('首次使用需要装一个本地根证书（用来解密抖音的 HTTPS）。');
    say('证书只在本机生成、不外传，不想用了双击 卸载根证书.bat 即可。');
    say('');
    const yes = await ask('现在安装吗？稍后 Windows 会弹安全警告，请点"是"。 (Y/n) ', true);
    if (!yes) {
      say('已取消。可以稍后双击 安装根证书.bat。');
      return 1;
    }
    const r = installCa(path.join(CERT_DIR, 'ca.cer'));
    if (!r.ok && !isCaTrusted(certs.thumbprint)) {
      say('安装失败：' + (r.err || r.out));
      return 1;
    }
    say('证书已装好。');
    say('');
  } else {
    logOnly('[环境] 根证书状态：已受信任');
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
  logOnly(`[代理] 已监听 127.0.0.1:${port}`);
  if (port !== PORT) logOnly(`[代理] 端口 ${PORT} 被拒绝（EACCES），已自动改用 ${port}`);

  // 再接管系统代理
  if (!DEV) {
    if (!fs.existsSync(BACKUP_FILE)) {
      fs.mkdirSync(CERT_DIR, { recursive: true });
      fs.writeFileSync(BACKUP_FILE, JSON.stringify(readProxySettings(), null, 2), 'utf8');
    }
    const applied = applyProxy(`127.0.0.1:${port}`);
    logOnly(`[代理] 写入结果 ok=${applied.ok} out=${applied.out} err=${applied.err}`);
    if (!applied.ok) {
      say('系统代理设置失败：' + (applied.err || applied.out));
      say('可手动设置：Windows 设置 → 网络和 Internet → 代理 → 127.0.0.1:' + port);
      say('');
    } else {
      proxyApplied = true;
      startWatchdog();   // 万一本进程被强杀，由看门狗把代理设置还原
    }
  }
  // ---- 运行状态卡片（这是用户唯一需要看的东西）----
  say('');
  const enabled = FEATURE_DEFS.filter((f) => FEATURES[f.key]);
  say(`  ${padTo('功能', 8)}${enabled.length ? enabled.map((f) => f.short).join(' · ') : '（全关）'}`);
  if (FEATURES.comment && OUT_DIR) say(`  ${padTo('存档', 8)}${OUT_DIR}`);
  say('');
  const hints = [];
  if (FEATURES.comment) hints.push('点开评论图');
  if (FEATURES.aweme || FEATURES.unlock) hints.push('点作品的下载');
  if (FEATURES.pick) hints.push('点赞或收藏');
  say(`  去抖音里重新加载一次内容；然后 ${hints.length ? hints.join(' / ') : '随便看看'} 都可以。`);
  say('  结束后按【回车】收尾（别按 Ctrl+C，那是关窗口）。');
  say('');

  let stopping = false;
  // 启动后到抓到第一张图之间是静默的，容易让人以为卡死。
  // 定期报一次状态，顺便提醒怎么收尾。
  const heartbeat = setInterval(() => {
    const parts = [];
    // 只报"标记过的"数量，刷到但没点开/没标记的不算
    if (FEATURES.comment) parts.push(`评论图 ${[...images.values()].filter((r) => r.opened).length}`);
    if (FEATURES.pick) parts.push(`作品 ${[...works.values()].filter((r) => r.picked).length}`);
    if (apiHits === 0) {
      idleNotice = true;
      say('  · 等待中… 请先在抖音里打开视频、重新加载一次内容');
    } else {
      say(`  · 运行中${parts.length ? ' · ' + parts.join(' · ') : ''}`);
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
    if (!DEV) logOnly(restoreProxyFromBackup());
    proxyApplied = false;
    say('系统代理已还原');
    // 「刷到的不统计」——只列用户明确标记过的：点开的评论图 + 点赞/收藏的作品
    const openedImgs = [...images.values()].filter((r) => r.opened);
    const pickedWorks = [...works.values()].filter((r) => r.picked);
    logOnly(`[汇总] 接口 ${apiHits} 次 · 改写 ${rewriteCount} 个字段`
      + ` · 评论图 刷到 ${images.size} / 点开 ${openedImgs.length}`
      + ` · 作品 刷到 ${works.size} / 标记 ${pickedWorks.length}`);

    if (openedImgs.length) {
      say('');
      say(`评论图  你点开过 ${openedImgs.length} 张：`);
      openedImgs.slice(0, 20).forEach((r, i) => {
        say(`  ${i + 1}. ${r.author}${r.text ? ' · ' + r.text : ''}`);
      });
      if (openedImgs.length > 20) say(`  …还有 ${openedImgs.length - 20} 张`);
    }
    if (pickedWorks.length) {
      say('');
      say(`作品  你点赞/收藏过 ${pickedWorks.length} 个：`);
      pickedWorks.slice(0, 20).forEach((r, i) => {
        const kind = r.imageUrls.length ? `图文 ${r.imageUrls.length} 张` : '视频';
        say(`  ${i + 1}. ${r.author}${r.desc ? ' · ' + r.desc : ''}   (${kind})`);
      });
      if (pickedWorks.length > 20) say(`  …还有 ${pickedWorks.length - 20} 个`);
    }
    if (unlockedTotal) {
      logOnly(`[解锁] 本次共自动解除 ${unlockedTotal} 处"禁止下载"限制`);
    }
    // 把收集到的作品地址滚动累积到 works-index.json，供"粘贴链接下载"复用
    if (works.size) {
      try {
        let old = [];
        try { old = JSON.parse(fs.readFileSync(WORKS_INDEX, 'utf8')); } catch { old = []; }
        const merged = new Map((Array.isArray(old) ? old : []).map((w) => [w.awemeId, w]));
        for (const r of works.values()) {
          const prev = merged.get(r.awemeId) || {};
          merged.set(r.awemeId, {
            awemeId: r.awemeId,
            author: r.author || prev.author || '',
            desc: r.desc || prev.desc || '',
            videoUrl: r.videoUrl || prev.videoUrl || '',
            playUri: r.playUri || prev.playUri || '',
            tierUris: (r.tierUris && r.tierUris.length) ? r.tierUris : (prev.tierUris || []),
            imageUrls: (r.imageUrls && r.imageUrls.length) ? r.imageUrls : (prev.imageUrls || []),
            updatedAt: new Date().toISOString(),
          });
        }
        fs.writeFileSync(WORKS_INDEX, JSON.stringify([...merged.values()].slice(-2000), null, 1), 'utf8');
        logOnly(`[索引] 已把 ${works.size} 个作品的地址写入 ${WORKS_INDEX}（累计 ${merged.size} 个）`);
      } catch (e) {
        logOnly('[索引] 写入失败: ' + e.message);
      }
    }
    if (blockedSeen && !FEATURES.aweme) {
      say('');
      say(`注意：这轮看到 ${blockedSeen} 个作品是"作者禁止下载"的，但「作品去水印」没启用，所以没解除。`);
      say('      想解除就双击 选择功能.bat，把「作品去水印」也勾上。');
    }

    if (openedImgs.length + pickedWorks.length > 0) {
      say('');
      const answer = (await askRaw('下载上面这些？  y=下载   回车=不下载： ')).trim().toLowerCase();
      if (/^y/.test(answer)) {
        try {
          if (openedImgs.length) await downloadAll(openedImgs);
          if (pickedWorks.length) await downloadWorks(pickedWorks);
          if (OUT_DIR) {
            say('');
            say(`已保存到 ${OUT_DIR}`);
            try {
              spawn('explorer.exe', [OUT_DIR], { detached: true, stdio: 'ignore' }).unref();
            } catch { /* 打不开就算了 */ }
          }
        } catch (e) {
          say('下载出错：' + (e?.message || e));
        }
      }
    } else if (FEATURES.comment || FEATURES.pick) {
      say('');
      say('这轮没有标记任何东西，没有可下载的。');
    } else {
      say('');
      say('（当前没启用"点开 / 标记"这类功能，所以没有需要下载的东西。）');
    }
    say('');
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
