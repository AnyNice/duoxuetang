// 数据层：better-sqlite3，数据库文件在项目 data/ 目录下。
// 若 better-sqlite3 的原生二进制不可用（个别环境装不上预编译包），
// 自动回退到 Node 自带的 node:sqlite 并适配成同一接口，功能不受影响。
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function openDatabase(file) {
  try {
    const BetterSQLite3 = require('better-sqlite3');
    const db = new BetterSQLite3(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return db;
  } catch (e) {
    console.warn(`better-sqlite3 不可用（${e.message.slice(0, 80)}），改用 Node 内置 node:sqlite。`);
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA foreign_keys = ON');
    return {
      exec: (sql) => raw.exec(sql),
      prepare: (sql) => {
        const stmt = raw.prepare(sql);
        return {
          run: (...args) => {
            const r = stmt.run(...args);
            return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
          },
          get: (...args) => stmt.get(...args),
          all: (...args) => stmt.all(...args),
        };
      },
    };
  }
}

const db = openDatabase(path.join(DATA_DIR, 'app.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  goal TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'lesson',          -- lesson | review
  phase TEXT NOT NULL DEFAULT 'probe',          -- probe | learning | quiz | done
  step_index INTEGER NOT NULL DEFAULT 0,
  roadmap_json TEXT DEFAULT '',                 -- {steps:[{title,summary,nodeTitles:[]}]}
  quiz_json TEXT DEFAULT '',                    -- {questions:[{id,question,points:[],nodeTitles:[]}]}
  material_text TEXT DEFAULT '',                -- 本课资料（来自本地文件，截断保存）
  material_name TEXT DEFAULT '',
  review_node_ids TEXT DEFAULT '',              -- 复习课针对的知识点 id（JSON 数组）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                           -- assistant | user
  type TEXT NOT NULL,                           -- probe|probe_answer|roadmap|predict_prompt|prediction|teach|quiz|grading|aside_q|aside_a
  content TEXT NOT NULL,
  meta_json TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  norm TEXT NOT NULL,                           -- 归一化标题，用于去重
  status TEXT NOT NULL DEFAULT 'new',           -- new | learning | passed，只认真实练习证据
  created_at TEXT NOT NULL,
  UNIQUE(subject_id, norm)
);
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  from_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  reason TEXT DEFAULT '',
  UNIQUE(subject_id, from_id, to_id)
);
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  node_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  ease REAL NOT NULL DEFAULT 2.5,
  interval_days INTEGER NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  due_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  session_id INTEGER,
  result TEXT NOT NULL,                         -- full | partial | miss（原始判分）
  error_cause TEXT DEFAULT '',                  -- '' | careless | execution | concept | memory | other
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subject_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                           -- overview（一页纸总览） | terms（术语表） | cheatsheet（速查表）
  content TEXT NOT NULL DEFAULT '',             -- overview/cheatsheet 存 Markdown；terms 存 JSON {"terms":[...]}
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(subject_id, kind)
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL DEFAULT 0,        -- 归属：科目 + 课堂 + 第几步，同一步只存一份，再生成是追加增补
  step_title TEXT DEFAULT '',
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',             -- Markdown
  mindmap TEXT DEFAULT '',                      -- 这份笔记的思维导图（树结构 JSON；老数据可能是 mermaid 文本，前端兼容解析），空=还没生成
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(subject_id, session_id, step_index)
);
CREATE TABLE IF NOT EXISTS mindmaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL DEFAULT 0,        -- 课堂里按步生成的思维导图（与笔记的导图分开存）
  step_title TEXT DEFAULT '',
  title TEXT NOT NULL,
  content TEXT NOT NULL,                        -- 思维导图树结构 JSON（老数据可能是 mermaid 文本）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id, step_index)
);
CREATE TABLE IF NOT EXISTS step_marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL DEFAULT 0,
  mark TEXT NOT NULL,                           -- self 自己能懂 | helped 靠讲解/帮助才懂 | stuck 还是不懂
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(subject_id, session_id, step_index)
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,                -- 登录名，唯一
  password_hash TEXT NOT NULL,                  -- scrypt 加盐哈希（格式 scrypt$盐$哈希），绝不存明文
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,                       -- 随机令牌，浏览器 cookie 只带它
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`);

// 老库补列：科目学习模式（速成模式）与科目归属（账号）。新库 CREATE 时没有这几列，统一在这里补齐。
{
  const cols = db.prepare('PRAGMA table_info(subjects)').all().map((c) => c.name);
  if (!cols.includes('mode')) db.exec("ALTER TABLE subjects ADD COLUMN mode TEXT NOT NULL DEFAULT 'normal'");
  if (!cols.includes('purpose')) db.exec("ALTER TABLE subjects ADD COLUMN purpose TEXT DEFAULT ''");
  if (!cols.includes('time_budget')) db.exec("ALTER TABLE subjects ADD COLUMN time_budget TEXT DEFAULT ''");
  // user_id 为空 = 还没有主人（没人注册过的老数据），第一个注册的用户会认领它们。
  if (!cols.includes('user_id')) db.exec('ALTER TABLE subjects ADD COLUMN user_id INTEGER REFERENCES users(id)');
}
// 知识点来源：''=上课路线沉淀，'import'=导入知识点拆出来的（图谱里打个小标）。
{
  const cols = db.prepare('PRAGMA table_info(nodes)').all().map((c) => c.name);
  if (!cols.includes('source')) db.exec("ALTER TABLE nodes ADD COLUMN source TEXT NOT NULL DEFAULT ''");
}
// 用户头像：存 data URL 文本（客户端已裁成 256×256 小图），空 = 没设过、用用户名首字圆圈。
{
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('avatar')) db.exec("ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT ''");
}
// notes 表加 kind/style/知识点归属。
// kind: step 步笔记 | node 知识点笔记 | overview 一页纸总览 | glossary 术语表 | cheatsheet 速查表 | mindmap 思维导图（知识点导图单独存一行，content 是树 JSON）
// 其中 overview/glossary/cheatsheet 是各自页签的文档，不进知识库列表；知识库只收 step/node/mindmap（教学中点名生成的文档）。
// style: '' 未记录 | easy 易懂版 | pro 专业简洁版（生成时由用户选，记在每份笔记上）
{
  const cols = db.prepare('PRAGMA table_info(notes)').all().map((c) => c.name);
  if (!cols.includes('kind')) db.exec("ALTER TABLE notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'step'");
  if (!cols.includes('style')) db.exec("ALTER TABLE notes ADD COLUMN style TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('node_id')) db.exec('ALTER TABLE notes ADD COLUMN node_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE');
  if (!cols.includes('node_title')) db.exec("ALTER TABLE notes ADD COLUMN node_title TEXT NOT NULL DEFAULT ''");
}
// 费曼通过状态：session 级存一份 {stepIndex: {passed, rounds, updated_at}}，重进课堂能看到哪步已讲清。
{
  const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  if (!cols.includes('feynman_json')) db.exec("ALTER TABLE sessions ADD COLUMN feynman_json TEXT NOT NULL DEFAULT ''");
}
// 旧 subject_docs（总览/术语表/速查表）迁入 notes 表：notes 里还没有同科目同 kind 的才迁，
// 原表保留不动当备份；迁完之后读写都走 notes（见 index.js 的 getDoc/upsertDoc），在各自页签展示、不进知识库列表。
{
  const KIND_MAP = { overview: 'overview', terms: 'glossary', cheatsheet: 'cheatsheet' };
  const TITLE_MAP = { overview: '一页纸总览', terms: '术语表', cheatsheet: '速查表' };
  const docs = db.prepare('SELECT * FROM subject_docs').all();
  for (const d of docs) {
    const kind = KIND_MAP[d.kind];
    if (!kind) continue;
    const exists = db.prepare('SELECT id FROM notes WHERE subject_id=? AND kind=?').get(d.subject_id, kind);
    if (exists) continue;
    db.prepare(
      'INSERT INTO notes (subject_id, session_id, step_index, step_title, title, content, kind, style, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(d.subject_id, null, -1, '', TITLE_MAP[d.kind] || d.kind, d.content, kind, '', d.created_at, d.updated_at);
  }
}

const now = () => new Date().toISOString();

// 标题归一化：合并空白、去结尾标点、大小写不敏感 —— 图谱去重与闪卡挂节点共用。
function normalizeTitle(s) {
  return String(s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[。．.、，,；;：:！!？?]+$/u, '')
    .toLowerCase();
}

function upsertNode(subjectId, title, source) {
  const t = String(title || '').trim();
  if (!t) return null;
  const norm = normalizeTitle(t);
  const existing = db.prepare('SELECT * FROM nodes WHERE subject_id=? AND norm=?').get(subjectId, norm);
  if (existing) return existing;
  const info = db
    .prepare('INSERT INTO nodes (subject_id, title, norm, status, source, created_at) VALUES (?,?,?,?,?,?)')
    .run(subjectId, t, norm, 'new', source || '', now());
  return db.prepare('SELECT * FROM nodes WHERE id=?').get(info.lastInsertRowid);
}

function addEdge(subjectId, fromId, toId, reason) {
  if (!fromId || !toId || fromId === toId) return;
  db.prepare('INSERT OR IGNORE INTO edges (subject_id, from_id, to_id, reason) VALUES (?,?,?,?)').run(
    subjectId,
    fromId,
    toId,
    String(reason || '')
  );
}

// 把提炼出的 {nodes:[title], edges:[{from,to,reason}]} 合并进图谱，返回新增计数。
// source='import' 时新建的知识点打上导入标记（已存在的节点不改它原来的来源）。
function mergeGraph(subjectId, graph, source) {
  let addedNodes = 0;
  let addedEdges = 0;
  const before = db.prepare('SELECT COUNT(*) c FROM nodes WHERE subject_id=?').get(subjectId).c;
  const beforeE = db.prepare('SELECT COUNT(*) c FROM edges WHERE subject_id=?').get(subjectId).c;
  const byNorm = new Map();
  for (const t of graph.nodes || []) {
    const n = upsertNode(subjectId, t, source);
    if (n) byNorm.set(n.norm, n);
  }
  const findNode = (title) => {
    const norm = normalizeTitle(title);
    if (byNorm.has(norm)) return byNorm.get(norm);
    return db.prepare('SELECT * FROM nodes WHERE subject_id=? AND norm=?').get(subjectId, norm);
  };
  for (const e of graph.edges || []) {
    const a = findNode(e.from);
    const b = findNode(e.to);
    if (a && b) addEdge(subjectId, a.id, b.id, e.reason);
  }
  const after = db.prepare('SELECT COUNT(*) c FROM nodes WHERE subject_id=?').get(subjectId).c;
  const afterE = db.prepare('SELECT COUNT(*) c FROM edges WHERE subject_id=?').get(subjectId).c;
  addedNodes = after - before;
  addedEdges = afterE - beforeE;
  return { addedNodes, addedEdges, totalNodes: after, totalEdges: afterE };
}

function addMessage(sessionId, role, type, content, meta) {
  const info = db
    .prepare('INSERT INTO messages (session_id, role, type, content, meta_json, created_at) VALUES (?,?,?,?,?,?)')
    .run(sessionId, role, type, String(content || ''), meta ? JSON.stringify(meta) : '', now());
  return db.prepare('SELECT * FROM messages WHERE id=?').get(info.lastInsertRowid);
}

module.exports = { db, now, normalizeTitle, upsertNode, addEdge, mergeGraph, addMessage, DATA_DIR };
