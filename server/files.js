// 读取本地资料：只读。所有路径都被限定在设置里指定的资料根目录内，越界一律拒绝。
const fs = require('fs');
const path = require('path');
const { loadSettings } = require('./settings');

// PDF 文字层提取：用 pdfjs-dist（纯 JS，Windows/Node 环境可直接跑）。
// 启动时可能打印 DOMMatrix/Path2D 的 polyfill 警告，那只影响画图渲染，不影响读文字，可忽略。
async function pdfText(buf) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    text += tc.items.map((it) => it.str).join(' ') + '\n';
  }
  return { text: text.trim(), pages: doc.numPages };
}

const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.h', '.cpp',
  '.hpp', '.cs', '.go', '.rs', '.json', '.yaml', '.yml', '.toml', '.html', '.css', '.vue', '.sh',
  '.sql', '.xml', '.csv', '.log', '.ini', '.env.example',
]);
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_PDF_BYTES = 25 * 1024 * 1024;

class FileAccessError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function getRoot() {
  const root = loadSettings().filesRoot;
  if (!root) {
    throw new FileAccessError('还没有设置资料根目录：请先到「设置」页填一个文件夹路径，之后就能浏览和读取里面的资料了。');
  }
  const abs = path.resolve(root);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new FileAccessError(`资料根目录不存在或不是文件夹：${root}。请到「设置」页改成一个真实存在的文件夹。`);
  }
  return abs;
}

// 把用户给的相对路径解析到根目录内；任何想跳出根目录的路径（..、绝对路径、符号链接）都拒绝。
function resolveInRoot(rel) {
  const root = getRoot();
  const clean = String(rel || '').replace(/^[/\\]+/, '');
  const abs = path.resolve(root, clean);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new FileAccessError('这个路径超出了资料根目录的范围，已拒绝。', 403);
  }
  // 符号链接也要验真实路径
  if (fs.existsSync(abs)) {
    const real = fs.realpathSync(abs);
    const realRoot = fs.realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new FileAccessError('这个路径超出了资料根目录的范围，已拒绝。', 403);
    }
  }
  return abs;
}

function kindOf(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (TEXT_EXTS.has(ext)) return 'text';
  return null;
}

function listDir(rel) {
  const abs = resolveInRoot(rel);
  if (!fs.existsSync(abs)) throw new FileAccessError('这个文件夹不存在。', 404);
  const entries = fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => {
      const isDir = e.isDirectory();
      const kind = isDir ? 'dir' : kindOf(e.name);
      return {
        name: e.name,
        type: isDir ? 'dir' : 'file',
        readable: isDir ? true : Boolean(kind),
        kind: kind || 'unsupported',
      };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { root: loadSettings().filesRoot, path: String(rel || ''), entries };
}

async function readFileText(rel) {
  const abs = resolveInRoot(rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new FileAccessError('这个文件不存在。', 404);
  }
  const kind = kindOf(abs);
  if (!kind) {
    throw new FileAccessError('这种文件暂时读不了：只支持 txt / md / 常见代码文件 / pdf。');
  }
  const stat = fs.statSync(abs);
  if (kind === 'text') {
    if (stat.size > MAX_TEXT_BYTES) throw new FileAccessError('这个文本文件太大了（超过 2 MB），先拆小一点再读。');
    const text = fs.readFileSync(abs, 'utf8');
    return { kind, text, chars: text.length, scanned: false };
  }
  if (stat.size > MAX_PDF_BYTES) throw new FileAccessError('这个 PDF 太大了（超过 25 MB）。');
  const data = await pdfText(fs.readFileSync(abs));
  return { kind, text: data.text, chars: data.text.length, scanned: data.text.length < 50, pages: data.pages };
}

// 上传的 PDF（Buffer）提取文字层，与文件读取共用同一判断口径。
async function extractPdfBuffer(buf) {
  const data = await pdfText(buf);
  return { text: data.text, chars: data.text.length, scanned: data.text.length < 50, pages: data.pages };
}

// 上传文件导入知识点：只收 PDF / txt / md，其它格式明确报错，不静默失败。
const UPLOAD_TEXT_EXTS = new Set(['.txt', '.md', '.markdown']);
async function extractUploadBuffer(buf, originalname) {
  const name = String(originalname || '');
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf') {
    if (buf.length > MAX_PDF_BYTES) throw new FileAccessError('这个 PDF 太大了（超过 25 MB），先拆小一点再传。');
    const r = await extractPdfBuffer(buf);
    return { kind: 'pdf', ...r };
  }
  if (UPLOAD_TEXT_EXTS.has(ext)) {
    if (buf.length > MAX_TEXT_BYTES) throw new FileAccessError('这个文本文件太大了（超过 2 MB），先拆小一点再传。');
    const text = buf.toString('utf8').replace(/^\uFEFF/, '').trim();
    if (!text) throw new FileAccessError('这个文件是空的，没读到任何文字。');
    return { kind: 'text', text, chars: text.length, scanned: false, pages: 0 };
  }
  throw new FileAccessError(
    `这种文件读不了：只支持 PDF、txt、md 三种格式，你传的是「${name || '未命名文件'}」${ext ? `（${ext} 格式）` : ''}。先转成 PDF 或 txt 再传吧。`
  );
}

module.exports = { listDir, readFileText, extractPdfBuffer, extractUploadBuffer, FileAccessError, MAX_PDF_BYTES };
