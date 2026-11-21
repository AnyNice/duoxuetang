// 多学堂 Web 版 · 主服务（单端口：API + 前端静态文件）
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { db, now, normalizeTitle, mergeGraph, addMessage } = require('./db');
const { loadSettings, saveSettings, publicSettings } = require('./settings');
const llm = require('./llm');
const tts = require('./tts');
const ai = require('./ai');
const files = require('./files');
const auth = require('./auth');
const { replay } = require('./fsrs');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(auth.attachUser);

// ---------- 账号：注册 / 登录 / 退出 / 我是谁 ----------
// 注册校验：用户名至少 2 个字、密码至少 6 位，报错都用大白话。
app.post('/api/auth/register', (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (username.length < 2) return res.status(400).json({ error: '用户名至少要 2 个字。' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少要 6 位。' });
  if (db.prepare('SELECT id FROM users WHERE username=?').get(username)) {
    return res.status(400).json({ error: '这个用户名已经有人用了，换一个试试。' });
  }
  const first = auth.userCount() === 0;
  const ts = now();
  const info = db
    .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?,?,?)')
    .run(username, auth.hashPassword(password), ts);
  const user = { id: info.lastInsertRowid, username, created_at: ts, avatar: '' };
  if (first) auth.claimOrphanSubjects(user.id); // 第一个注册的人接管全部无主数据
  auth.setSessionCookie(res, auth.createSession(user.id));
  res.json({ user, claimed: first });
});
app.post('/api/auth/login', (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const row = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!row || !auth.verifyPassword(password, row.password_hash)) {
    return res.status(400).json({ error: '用户名或密码不对，再检查一下。' });
  }
  const user = { id: row.id, username: row.username, created_at: row.created_at, avatar: row.avatar || '' };
  auth.setSessionCookie(res, auth.createSession(user.id));
  res.json({ user });
});
app.post('/api/auth/logout', (req, res) => {
  auth.destroySession(auth.parseCookies(req)[auth.COOKIE_NAME]);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});
app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.user || null, hasUsers: Boolean(req.hasUsers) });
});
// ---------- 头像：换自己的头像 / 恢复默认 ----------
// 客户端已把图居中裁成 256×256 再传 data URL；服务端再校验一遍：必须是 png/jpeg/webp、解码后 ≤300KB、文件头对得上。
const AVATAR_MAX_BYTES = 300 * 1024;
function avatarMagicOk(buf, mime) {
  if (mime === 'png') return buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'jpeg') return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === 'webp')
    return buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}
app.post('/api/auth/avatar', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '请先登录。' });
  const dataUrl = req.body && req.body.avatar;
  if (typeof dataUrl !== 'string' || !dataUrl) return res.status(400).json({ error: '没收到图片，请重新选一张。' });
  const m = dataUrl.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!m) return res.status(400).json({ error: '头像只支持 PNG、JPG 或 WebP 图片。' });
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) return res.status(400).json({ error: '没收到图片，请重新选一张。' });
  if (buf.length > AVATAR_MAX_BYTES) return res.status(400).json({ error: '这张图太大了，换一张小一点的。' });
  if (!avatarMagicOk(buf, m[1])) return res.status(400).json({ error: '这个文件不像是一张图片，换一张试试。' });
  db.prepare('UPDATE users SET avatar=? WHERE id=?').run(dataUrl, req.user.id);
  res.json({ user: { ...req.user, avatar: dataUrl } });
});
app.delete('/api/auth/avatar', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '请先登录。' });
  db.prepare("UPDATE users SET avatar='' WHERE id=?").run(req.user.id);
  res.json({ user: { ...req.user, avatar: '' } });
});
// 账号接口往后，所有 /api 都过登录墙：未登录一律 401，空库初始状态也不例外。
app.use('/api', auth.requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: files.MAX_PDF_BYTES },
});

// ---------- 小工具 ----------
function getSubject(id) {
  return db.prepare('SELECT * FROM subjects WHERE id=?').get(id);
}
function getSession(id) {
  return db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
}
// ---------- 归属校验：科目是根实体，挂在它下面的课堂/闪卡/笔记都跟着科目算 ----------
// 数据接口都在登录墙之后（req.user 必有）；只有科目主人能看，拿别人的 id 来请求一律当不存在（404）。
// 无主科目（user_id 为空的存量数据）在第一个账号注册认领之前谁都看不到。
function subjectVisible(req, subject) {
  if (!subject) return false;
  if (!req.user) return false;
  return subject.user_id === req.user.id;
}
function getOwnedSubject(req, id) {
  const s = getSubject(id);
  return subjectVisible(req, s) ? s : null;
}
function getOwnedSession(req, id) {
  const s = getSession(id);
  if (!s) return null;
  return subjectVisible(req, getSubject(s.subject_id)) ? s : null;
}
function sessionDetail(id) {
  const s = getSession(id);
  if (!s) return null;
  const messages = db
    .prepare('SELECT * FROM messages WHERE session_id=? ORDER BY id ASC')
    .all(id)
    .map((m) => ({ ...m, meta: m.meta_json ? safeParse(m.meta_json) : null }));
  // 每步的思维导图与笔记存在状态（课堂页按步显示用）
  const stepMindmaps = {};
  for (const mm of db.prepare('SELECT step_index, content FROM mindmaps WHERE session_id=?').all(id)) {
    stepMindmaps[mm.step_index] = mm.content;
  }
  const stepNotes = {};
  for (const n of db
    .prepare("SELECT id, step_index FROM notes WHERE subject_id=? AND session_id=? AND kind='step'")
    .all(s.subject_id, id)) {
    stepNotes[n.step_index] = n.id;
  }
  // 每步的理解自评（self/helped/stuck）与费曼通过状态，课堂页按步显示用
  const stepMarks = {};
  for (const mk of db.prepare('SELECT step_index, mark FROM step_marks WHERE session_id=?').all(id)) {
    stepMarks[mk.step_index] = mk.mark;
  }
  return {
    ...s,
    roadmap: s.roadmap_json ? safeParse(s.roadmap_json) : null,
    quiz: s.quiz_json ? safeParse(s.quiz_json) : null,
    reviewNodeIds: s.review_node_ids ? safeParse(s.review_node_ids) : [],
    feynman: s.feynman_json ? safeParse(s.feynman_json) || {} : {},
    messages,
    stepMindmaps,
    stepNotes,
    stepMarks,
  };
}
function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function touchSession(id, patch) {
  const sets = Object.keys(patch)
    .map((k) => `${k}=?`)
    .join(', ');
  db.prepare(`UPDATE sessions SET ${sets}, updated_at=? WHERE id=?`).run(...Object.values(patch), now(), id);
}
function nodeByTitle(subjectId, title) {
  return db
    .prepare('SELECT * FROM nodes WHERE subject_id=? AND norm=?')
    .get(subjectId, normalizeTitle(title));
}
function reviewPlanFor(subjectId) {
  const nodes = db.prepare('SELECT * FROM nodes WHERE subject_id=? ORDER BY id ASC').all(subjectId);
  const nowDate = new Date();
  return nodes.map((n) => {
    const events = db
      .prepare('SELECT * FROM review_events WHERE node_id=? ORDER BY created_at ASC, id ASC')
      .all(n.id);
    const state = replay(events, nowDate);
    return { node: n, events: events.length, ...state };
  });
}

// 三件套（总览/术语表/速查表）存在 notes 表里，接口 kind 与存储 kind 的对应：
// overview→overview、terms→glossary、cheatsheet→cheatsheet。老 subject_docs 已在 db.js 启动时迁入，这里只读写 notes。
// 注意：三件套是各自页签的文档，不出现在知识库列表里（知识库只收教学中点名生成的文档，见 /api/subjects/:id/notes）。
const DOC_NOTE_KIND = { overview: 'overview', terms: 'glossary', cheatsheet: 'cheatsheet' };
const DOC_NOTE_TITLE = { overview: '一页纸总览', terms: '术语表', cheatsheet: '速查表' };
function getDoc(subjectId, kind) {
  const row = db
    .prepare('SELECT * FROM notes WHERE subject_id=? AND kind=?')
    .get(subjectId, DOC_NOTE_KIND[kind] || kind);
  return row || null;
}
function upsertDoc(subjectId, kind, content, style) {
  const noteKind = DOC_NOTE_KIND[kind] || kind;
  const existing = getDoc(subjectId, kind);
  if (existing) {
    db.prepare('UPDATE notes SET content=?, style=?, updated_at=? WHERE id=?').run(
      content,
      style || existing.style || '',
      now(),
      existing.id
    );
    return getDoc(subjectId, kind);
  }
  const info = db
    .prepare(
      'INSERT INTO notes (subject_id, session_id, step_index, step_title, title, content, kind, style, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
    )
    .run(subjectId, null, -1, '', DOC_NOTE_TITLE[kind] || kind, content, noteKind, style || '', now(), now());
  return db.prepare('SELECT * FROM notes WHERE id=?').get(info.lastInsertRowid);
}

function wrap(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((e) => {
      if (e instanceof llm.LlmError) return res.status(400).json({ error: e.message, code: e.code });
      if (e instanceof files.FileAccessError) return res.status(e.status).json({ error: e.message });
      console.error(e);
      res.status(500).json({ error: `出错了：${e.message}` });
    });
  };
}

// ---------- 设置（BYOK + 资料根目录） ----------
app.get('/api/settings', (req, res) => res.json(publicSettings()));
app.post(
  '/api/settings',
  wrap(async (req, res) => {
    const body = req.body || {};
    const cur = loadSettings();
    const next = { llm: { ...cur.llm }, filesRoot: cur.filesRoot };
    if (body.baseUrl !== undefined) next.llm.baseUrl = String(body.baseUrl || '').trim();
    if (body.model !== undefined) next.llm.model = String(body.model || '').trim();
    if (body.clearKey) next.llm.apiKey = '';
    else if (body.apiKey) next.llm.apiKey = String(body.apiKey).trim();
    if (body.filesRoot !== undefined) next.filesRoot = String(body.filesRoot || '').trim();
    if (body.ttsVoice !== undefined) next.tts = { voice: tts.normalizeVoice(String(body.ttsVoice || '')) };
    saveSettings(next);
    res.json(publicSettings());
  })
);

// ---------- 云端朗读（edge-tts 合成 mp3，带落盘缓存；失败回 500，前端自动回退设备语音） ----------
app.post(
  '/api/tts',
  wrap(async (req, res) => {
    const body = req.body || {};
    const text = String(body.text || '').trim();
    if (!text) return res.status(400).json({ error: '没有要朗读的内容' });
    if (text.length > 2000) return res.status(400).json({ error: '这一段太长了' });
    const voice = body.voice ? tts.normalizeVoice(String(body.voice)) : loadSettings().tts.voice;
    const file = await tts.getSpeechFile(text, voice);
    res.type('audio/mpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(file);
  })
);
app.post(
  '/api/settings/test',
  wrap(async (req, res) => {
    const body = req.body || {};
    const override = {};
    if (body.baseUrl) override.baseUrl = String(body.baseUrl).trim();
    if (body.model) override.model = String(body.model).trim();
    if (body.apiKey) override.apiKey = String(body.apiKey).trim();
    res.json(await llm.testConnection(override));
  })
);
// 模型列表缓存：设置页打开时先拿缓存显示，不重新请求接口。
app.get('/api/settings/models', (req, res) => {
  const { llm: cfg } = loadSettings();
  const cached = llm.cachedModels(cfg.baseUrl);
  res.json({
    baseUrl: cfg.baseUrl,
    models: cached ? cached.models : [],
    fetchedAt: cached ? cached.fetchedAt : 0,
  });
});
// 模型列表获取：走后端代理请求 {baseUrl}/models（Key 不经浏览器直连），成功后写缓存。
app.post(
  '/api/settings/models',
  wrap(async (req, res) => {
    const body = req.body || {};
    const override = {};
    if (body.baseUrl) override.baseUrl = String(body.baseUrl).trim();
    if (body.apiKey) override.apiKey = String(body.apiKey).trim();
    res.json(await llm.fetchModels(override));
  })
);

// ---------- 科目 ----------
app.get('/api/subjects', (req, res) => {
  const subjects = req.user
    ? db.prepare('SELECT * FROM subjects WHERE user_id=? ORDER BY id DESC').all(req.user.id)
    : db.prepare('SELECT * FROM subjects ORDER BY id DESC').all();
  const out = subjects.map((s) => {
    const nodeCount = db.prepare('SELECT COUNT(*) c FROM nodes WHERE subject_id=?').get(s.id).c;
    const cardDue = db
      .prepare('SELECT COUNT(*) c FROM cards WHERE subject_id=? AND due_at<=?')
      .get(s.id, now()).c;
    const plan = reviewPlanFor(s.id);
    const reviewDue = plan.filter((p) => p.hasEvents && p.due).length;
    const sessionCount = db.prepare('SELECT COUNT(*) c FROM sessions WHERE subject_id=?').get(s.id).c;
    return { ...s, nodeCount, cardDue, reviewDue, sessionCount };
  });
  res.json(out);
});
app.post(
  '/api/subjects',
  wrap(async (req, res) => {
    const body = req.body || {};
    const title = String(body.title || '').trim();
    if (!title) return res.status(400).json({ error: '请先给科目起个名字。' });
    const goal = String(body.goal || '').trim();
    const mode = body.mode === 'crash' ? 'crash' : 'normal';
    const purpose = mode === 'crash' ? String(body.purpose || '').trim() : '';
    const timeBudget = mode === 'crash' ? String(body.timeBudget || '').trim() : '';
    const info = db
      .prepare('INSERT INTO subjects (title, goal, mode, purpose, time_budget, user_id, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(title, goal, mode, purpose, timeBudget, req.user ? req.user.id : null, now());
    res.json(getSubject(info.lastInsertRowid));
  })
);
app.delete('/api/subjects/:id', (req, res) => {
  const s = getOwnedSubject(req, req.params.id);
  if (!s) return res.status(404).json({ error: '科目不存在。' });
  db.prepare('DELETE FROM subjects WHERE id=?').run(s.id);
  res.json({ ok: true });
});
app.get('/api/subjects/:id', (req, res) => {
  const s = getOwnedSubject(req, req.params.id);
  if (!s) return res.status(404).json({ error: '科目不存在。' });
  const nodes = db.prepare('SELECT * FROM nodes WHERE subject_id=? ORDER BY id ASC').all(s.id);
  const edges = db.prepare('SELECT * FROM edges WHERE subject_id=? ORDER BY id ASC').all(s.id);
  const sessions = db
    .prepare('SELECT id, kind, phase, step_index, created_at, updated_at FROM sessions WHERE subject_id=? ORDER BY id DESC')
    .all(s.id);
  res.json({ subject: s, nodes, edges, sessions });
});

// ---------- 课堂 ----------
app.post(
  '/api/subjects/:id/sessions',
  wrap(async (req, res) => {
    const subject = getOwnedSubject(req, req.params.id);
    if (!subject) return res.status(404).json({ error: '科目不存在。' });
    let materialText = '';
    let materialName = '';
    const materialPath = (req.body || {}).materialPath;
    if (materialPath) {
      const r = await files.readFileText(materialPath);
      if (r.scanned) {
        return res.status(400).json({ error: '这份 PDF 没读到文字（可能是扫描件），换一份带文字的资料再试。' });
      }
      materialText = r.text.slice(0, 12000);
      materialName = String(materialPath).split(/[\\/]/).pop();
    }
    const questions = await ai.probeQuestions(subject); // 没配 Key 会在这里给出白话提示
    // 速成科目开课前先有一页纸总览：还没有就顺手生成一份（生成失败不挡上课，科目页可手动补）
    if (subject.mode === 'crash') {
      if (!getDoc(subject.id, 'overview')) {
        try {
          const content = await ai.buildOverview(subject, 'easy');
          upsertDoc(subject.id, 'overview', content, 'easy');
        } catch {
          /* 总览没生成出来不影响开课 */
        }
      }
    }
    const info = db
      .prepare(
        'INSERT INTO sessions (subject_id, kind, phase, material_text, material_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run(subject.id, 'lesson', 'probe', materialText, materialName, now(), now());
    const sid = info.lastInsertRowid;
    addMessage(sid, 'assistant', 'probe', '先做几道摸底题，我按你的回答来安排学习路线。', { questions });
    res.json(sessionDetail(sid));
  })
);
app.get('/api/sessions/:id', (req, res) => {
  if (!getOwnedSession(req, req.params.id)) return res.status(404).json({ error: '课堂不存在。' });
  const d = sessionDetail(req.params.id);
  if (!d) return res.status(404).json({ error: '课堂不存在。' });
  res.json(d);
});
app.delete('/api/sessions/:id', (req, res) => {
  const s = getOwnedSession(req, req.params.id);
  if (!s) return res.status(404).json({ error: '课堂不存在。' });
  // 删课堂连带清掉这节课写下的复习事件账（与多学堂既定行为一致）
  db.prepare('DELETE FROM review_events WHERE session_id=?').run(s.id);
  db.prepare('DELETE FROM sessions WHERE id=?').run(s.id);
  res.json({ ok: true });
});

app.post(
  '/api/sessions/:id/probe',
  wrap(async (req, res) => {
    const s = getOwnedSession(req, req.params.id);
    if (!s || s.phase !== 'probe') return res.status(400).json({ error: '这节课不在摸底阶段。' });
    const subject = getSubject(s.subject_id);
    const answers = Array.isArray((req.body || {}).answers) ? req.body.answers : [];
    addMessage(
      s.id,
      'user',
      'probe_answer',
      answers.map((a, i) => `问${i + 1}：${a.q}\n答：${a.a || '（没答）'}`).join('\n\n'),
      { answers }
    );
    const roadmap = await ai.buildRoadmap(subject, answers);
    mergeGraph(subject.id, { nodes: roadmap.nodes, edges: roadmap.edges });
    touchSession(s.id, { phase: 'learning', step_index: 0, roadmap_json: JSON.stringify(roadmap) });
    addMessage(s.id, 'assistant', 'roadmap', '这是按你的摸底情况排的学习路线：', { roadmap });
    const step = roadmap.steps[0];
    addMessage(
      s.id,
      'assistant',
      'predict_prompt',
      `第 1 步：${step.title}\n${step.summary}\n\n先别急着看讲解——你先猜一猜、说说你的想法，写在下面（也可以点麦克风说）。`,
      { stepIndex: 0 }
    );
    res.json(sessionDetail(s.id));
  })
);

app.post(
  '/api/sessions/:id/predict',
  wrap(async (req, res) => {
    const s = getOwnedSession(req, req.params.id);
    if (!s || s.phase !== 'learning') return res.status(400).json({ error: '这节课不在教学阶段。' });
    const subject = getSubject(s.subject_id);
    const roadmap = safeParse(s.roadmap_json);
    const step = roadmap.steps[s.step_index];
    const text = String((req.body || {}).text || '').trim();
    addMessage(s.id, 'user', 'prediction', text || '（没写预测）', { stepIndex: s.step_index });
    // 跨科目类比：把学生其他科目的名字给老师，贴切时用那些概念打比方（只用本人其他科目）
    const otherSubjects = db
      .prepare('SELECT * FROM subjects WHERE id<>? ORDER BY id DESC')
      .all(subject.id)
      .filter((x) => subjectVisible(req, x))
      .map((r) => r.title);
    const teach = await ai.teachStep(subject, step, s.step_index + 1, roadmap.steps.length, text, s.material_text, otherSubjects);
    addMessage(s.id, 'assistant', 'teach', teach, { stepIndex: s.step_index });
    res.json(sessionDetail(s.id));
  })
);

app.post(
  '/api/sessions/:id/next',
  wrap(async (req, res) => {
    const s = getOwnedSession(req, req.params.id);
    if (!s || s.phase !== 'learning') return res.status(400).json({ error: '这节课不在教学阶段。' });
    const subject = getSubject(s.subject_id);
    const roadmap = safeParse(s.roadmap_json);
    const nextIndex = s.step_index + 1;
    if (nextIndex < roadmap.steps.length) {
      touchSession(s.id, { step_index: nextIndex });
      const step = roadmap.steps[nextIndex];
      addMessage(
        s.id,
        'assistant',
        'predict_prompt',
        `第 ${nextIndex + 1} 步：${step.title}\n${step.summary}\n\n还是先预测：说说你觉得这一步会讲什么、关键在哪。`,
        { stepIndex: nextIndex }
      );
      return res.json(sessionDetail(s.id));
    }
    // 全部步讲完 → 出练习
    const nodes = db.prepare('SELECT title FROM nodes WHERE subject_id=?').all(subject.id).map((n) => n.title);
    const quiz = await ai.buildQuiz(subject, roadmap.steps, nodes);
    touchSession(s.id, { phase: 'quiz', quiz_json: JSON.stringify(quiz) });
    addMessage(s.id, 'assistant', 'quiz', '都学完了，来做几道练习检验一下（换了新场景，认真想）：', {
      questions: quiz.questions.map((q) => ({ id: q.id, question: q.question })),
    });
    res.json(sessionDetail(s.id));
  })
);

app.post(
  '/api/sessions/:id/quiz',
  wrap(async (req, res) => {
    const s = getOwnedSession(req, req.params.id);
    if (!s || s.phase !== 'quiz') return res.status(400).json({ error: '这节课不在练习阶段。' });
    const subject = getSubject(s.subject_id);
    const quiz = safeParse(s.quiz_json);
    const answers = Array.isArray((req.body || {}).answers) ? req.body.answers : [];
    addMessage(
      s.id,
      'user',
      'quiz_answer',
      quiz.questions.map((q) => `题${q.id}：${q.question}\n答：${(answers.find((a) => a.id === q.id) || {}).answer || '（没答）'}`).join('\n\n'),
      { answers }
    );
    const results = await ai.gradeQuiz(subject, quiz, answers);
    // 写事件账 + 更新节点状态（只认真实判分）
    for (const r of results) {
      for (const nr of r.nodeResults || []) {
        const node = nodeByTitle(subject.id, nr.nodeTitle);
        if (!node) continue;
        db.prepare(
          'INSERT INTO review_events (subject_id, node_id, session_id, result, error_cause, created_at) VALUES (?,?,?,?,?,?)'
        ).run(subject.id, node.id, s.id, nr.result, nr.errorCause || '', now());
        const newStatus = nr.result === 'full' ? 'passed' : 'learning';
        db.prepare('UPDATE nodes SET status=? WHERE id=?').run(newStatus, node.id);
      }
    }
    touchSession(s.id, { phase: 'done' });
    addMessage(s.id, 'assistant', 'grading', '批改完了，逐题看一下错在哪：', { results });
    res.json(sessionDetail(s.id));
  })
);

app.post(
  '/api/sessions/:id/ask',
  wrap(async (req, res) => {
    const s = getOwnedSession(req, req.params.id);
    if (!s) return res.status(404).json({ error: '课堂不存在。' });
    const subject = getSubject(s.subject_id);
    const question = String((req.body || {}).question || '').trim();
    if (!question) return res.status(400).json({ error: '先写下你的问题。' });
    addMessage(s.id, 'user', 'aside_q', question);
    const roadmap = s.roadmap_json ? safeParse(s.roadmap_json) : null;
    const stepTitle = roadmap && roadmap.steps[s.step_index] ? roadmap.steps[s.step_index].title : '';
    const summary = `阶段=${s.phase}${stepTitle ? `，当前步=${stepTitle}` : ''}`;
    const answer = await ai.asideAnswer(subject, summary, question, s.material_text);
    const msg = addMessage(s.id, 'assistant', 'aside_a', answer);
    res.json({ message: { ...msg, meta: null } });
  })
);

// ---------- 快速学习套件：总览 / 术语表 / 速查表（存 notes 表，各自页签独立展示，不进知识库） ----------
function styleOfBody(req) {
  return (req.body || {}).style === 'pro' ? 'pro' : 'easy';
}
app.get('/api/subjects/:id/docs', (req, res) => {
  const subject = getOwnedSubject(req, req.params.id);
  if (!subject) return res.status(404).json({ error: '科目不存在。' });
  const out = { overview: null, terms: null, cheatsheet: null };
  for (const kind of Object.keys(out)) {
    const d = getDoc(subject.id, kind);
    if (!d) continue;
    out[kind] =
      kind === 'terms'
        ? { ...d, terms: safeParse(d.content)?.terms || [] }
        : d;
  }
  res.json(out);
});
app.post(
  '/api/subjects/:id/overview',
  wrap(async (req, res) => {
    const subject = getOwnedSubject(req, req.params.id);
    if (!subject) return res.status(404).json({ error: '科目不存在。' });
    const style = styleOfBody(req);
    const content = await ai.buildOverview(subject, style);
    res.json(upsertDoc(subject.id, 'overview', content, style));
  })
);
app.post(
  '/api/subjects/:id/terms',
  wrap(async (req, res) => {
    const subject = getOwnedSubject(req, req.params.id);
    if (!subject) return res.status(404).json({ error: '科目不存在。' });
    const style = styleOfBody(req);
    const terms = await ai.generateTerms(subject, style);
    const doc = upsertDoc(subject.id, 'terms', JSON.stringify({ terms }), style);
    res.json({ ...doc, terms });
  })
);
// 速查表的真实错因素材：这科 review_events 里带错因的记录，按错因类型与涉及知识点汇总给老师。
function cheatsheetErrorInfo(subjectId) {
  const rows = db
    .prepare(
      `SELECT e.error_cause AS cause, n.title AS node_title, COUNT(*) AS c
       FROM review_events e JOIN nodes n ON n.id=e.node_id
       WHERE e.subject_id=? AND e.error_cause<>''
       GROUP BY e.error_cause, n.title ORDER BY c DESC`
    )
    .all(subjectId);
  if (!rows.length) return { hasData: false, text: '' };
  const CAUSE_LABEL = { careless: '粗心', execution: '执行出错', concept: '概念没懂', memory: '记混了', other: '其他' };
  const lines = rows.map((r) => `- 错因「${CAUSE_LABEL[r.cause] || r.cause}」：知识点「${r.node_title}」栽过 ${r.c} 次`);
  return { hasData: true, text: lines.join('\n') };
}
app.post(
  '/api/subjects/:id/cheatsheet',
  wrap(async (req, res) => {
    const subject = getOwnedSubject(req, req.params.id);
    if (!subject) return res.status(404).json({ error: '科目不存在。' });
    const style = styleOfBody(req);
    const nodeTitles = db.prepare('SELECT title FROM nodes WHERE subject_id=? ORDER BY id ASC').all(subject.id).map((n) => n.title);
    const latest = db
      .prepare("SELECT roadmap_json FROM sessions WHERE subject_id=? AND kind='lesson' AND roadmap_json<>'' ORDER BY id DESC LIMIT 1")
      .get(subject.id);
    const roadmap = latest ? safeParse(latest.roadmap_json) : null;
    const outline = roadmap ? roadmap.steps.map((s, i) => `${i + 1}. ${s.title}：${s.summary}`).join('\n') : '';
    const errorInfo = cheatsheetErrorInfo(subject.id);
    const content = await ai.generateCheatsheet(subject, nodeTitles, outline, style, errorInfo);
    const doc = upsertDoc(subject.id, 'cheatsheet', content, style);
    res.json({ ...doc, usedRealErrors: errorInfo.hasData });
  })
);

// ---------- 费曼检验（讲给我听）：走课堂消息流，不判分、不卡进度 ----------
app.post(
  '/api/sessions/:id/feynman',
  wrap(async (req, res) => {
    const s = getOwnedSession(req, req.params.id);
    if (!s) return res.status(404).json({ error: '课堂不存在。' });
    if (s.kind !== 'lesson' || !s.roadmap_json) return res.status(400).json({ error: '这节课还没有学习路线，先完成摸底再来。' });
    const subject = getSubject(s.subject_id);
    const roadmap = safeParse(s.roadmap_json);
    const stepIndex = Math.min(Math.max(Number((req.body || {}).stepIndex ?? s.step_index) || 0, 0), roadmap.steps.length - 1);
    const step = roadmap.steps[stepIndex];
    const text = String((req.body || {}).text || '').trim();
    if (!text) return res.status(400).json({ error: '先把你的理解讲一段出来，再让老师听。' });
    // 历史轮次（同一步的讲给我听记录），让追问能接得上
    const msgs = db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY id ASC').all(s.id);
    const rounds = [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.type === 'feynman') {
        const meta = m.meta_json ? safeParse(m.meta_json) : null;
        if (meta && meta.stepIndex === stepIndex) {
          const fb = msgs[i + 1] && msgs[i + 1].type === 'feynman_feedback' ? msgs[i + 1].content : '';
          rounds.push({ user: m.content, feedback: fb });
        }
      }
    }
    addMessage(s.id, 'user', 'feynman', text, { stepIndex });
    const r = await ai.feynmanReview(subject, step, rounds, text);
    addMessage(s.id, 'assistant', 'feynman_feedback', r.feedback, { stepIndex, passed: r.passed });
    // 通过状态存 session 级：讲清了就记 passed（之后再讲也不取消），轮次累加，重进课堂能看到
    const feynman = s.feynman_json ? safeParse(s.feynman_json) || {} : {};
    const prev = feynman[stepIndex] || { passed: false, rounds: 0 };
    feynman[stepIndex] = {
      passed: Boolean(prev.passed || r.passed),
      rounds: (prev.rounds || 0) + 1,
      updated_at: now(),
    };
    touchSession(s.id, { feynman_json: JSON.stringify(feynman) });
    res.json(sessionDetail(s.id));
  })
);

// ---------- 理解自评（三档）+ 还是不懂自动补讲 ----------
app.post(
  '/api/sessions/:id/steps/:stepIndex/mark',
  wrap(async (req, res) => {
    const s = getOwnedSession(req, req.params.id);
    if (!s) return res.status(404).json({ error: '课堂不存在。' });
    const subject = getSubject(s.subject_id);
    const stepIndex = Number(req.params.stepIndex);
    const mark = String((req.body || {}).mark || '');
    if (!['self', 'helped', 'stuck'].includes(mark)) return res.status(400).json({ error: '自评档位不对。' });
    const roadmap = s.roadmap_json ? safeParse(s.roadmap_json) : null;
    const step = roadmap && roadmap.steps[stepIndex];
    if (!step) return res.status(400).json({ error: '找不到这一步。' });
    const existing = db
      .prepare('SELECT * FROM step_marks WHERE subject_id=? AND session_id=? AND step_index=?')
      .get(subject.id, s.id, stepIndex);
    if (existing) {
      db.prepare('UPDATE step_marks SET mark=?, updated_at=? WHERE id=?').run(mark, now(), existing.id);
    } else {
      db.prepare(
        'INSERT INTO step_marks (subject_id, session_id, step_index, mark, created_at, updated_at) VALUES (?,?,?,?,?,?)'
      ).run(subject.id, s.id, stepIndex, mark, now(), now());
    }
    let reteach = null;
    if (mark === 'stuck') {
      // 标「还是不懂」：自动生成一段前置概念补讲，存进课堂消息流，就在这一步讲解后面
      const teach = teachMessageFor(s.id, stepIndex);
      if (!teach) return res.status(400).json({ error: '这一步还没讲过，先听完讲解再自评。' });
      const text = await ai.reteachStep(subject, step, stepIndex + 1, teach.content);
      reteach = addMessage(s.id, 'assistant', 'reteach', text, { stepIndex });
    }
    res.json({ mark, reteach: reteach ? { ...reteach, meta: { stepIndex } } : null, session: sessionDetail(s.id) });
  })
);

// ---------- 笔记（用户主动点才生成；同一步再点是追加增补，绝不覆盖） ----------
function teachMessageFor(sessionId, stepIndex) {
  const msgs = db.prepare("SELECT * FROM messages WHERE session_id=? AND type='teach' ORDER BY id ASC").all(sessionId);
  for (const m of msgs) {
    const meta = m.meta_json ? safeParse(m.meta_json) : null;
    if (meta && meta.stepIndex === stepIndex) return m;
  }
  return null;
}
function getNote(id) {
  return db.prepare('SELECT * FROM notes WHERE id=?').get(id);
}
// 一步的教学素材：学生的预测 + 老师讲解 + 补讲 + 这一步涉及知识点的真实练习错因。
// 生成步笔记 / 步导图时喂给老师——文档是「这节课真实发生过什么」的整理，而不是只复述讲解。
function stepTeachingMaterial(subjectId, sessionId, step, stepIndex) {
  const msgs = db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY id ASC').all(sessionId);
  const byType = (type) =>
    msgs.filter((m) => {
      if (m.type !== type) return false;
      const meta = m.meta_json ? safeParse(m.meta_json) : null;
      return meta && meta.stepIndex === stepIndex;
    });
  const parts = [];
  const prediction = byType('prediction')[0];
  if (prediction) parts.push(`【学生学之前的预测】\n${prediction.content}`);
  const teach = byType('teach')[0];
  if (teach) parts.push(`【老师的讲解】\n${teach.content}`);
  const reteaches = byType('reteach');
  if (reteaches.length) {
    parts.push(`【老师的补讲】（学生标了「还是不懂」后补讲的前置概念）\n${reteaches.map((m) => m.content).join('\n\n')}`);
  }
  const CAUSE_LABEL = { careless: '粗心', execution: '执行出错', concept: '概念没懂', memory: '记混了', other: '其他' };
  const errLines = [];
  for (const title of step.nodeTitles || []) {
    const node = nodeByTitle(subjectId, title);
    if (!node) continue;
    const events = db.prepare('SELECT result, error_cause FROM review_events WHERE node_id=?').all(node.id);
    if (!events.length) continue;
    const cnt = { full: 0, partial: 0, miss: 0 };
    const causes = {};
    for (const e of events) {
      if (cnt[e.result] !== undefined) cnt[e.result]++;
      if (e.error_cause) causes[e.error_cause] = (causes[e.error_cause] || 0) + 1;
    }
    const causeText = Object.entries(causes)
      .map(([c, n]) => `${CAUSE_LABEL[c] || c} ${n} 次`)
      .join('、');
    errLines.push(
      `- 知识点「${node.title}」：共判分 ${events.length} 次——答全 ${cnt.full} 次、答到一部分 ${cnt.partial} 次、没答到 ${cnt.miss} 次${causeText ? `；错因：${causeText}` : ''}`
    );
  }
  if (errLines.length) parts.push(`【练习里暴露的错因】（真实判分记录）\n${errLines.join('\n')}`);
  return parts.join('\n\n');
}
app.post(
  '/api/sessions/:id/steps/:stepIndex/note',
  wrap(async (req, res) => {
    const s = getOwnedSession(req, req.params.id);
    if (!s) return res.status(404).json({ error: '课堂不存在。' });
    const subject = getSubject(s.subject_id);
    const stepIndex = Number(req.params.stepIndex);
    const roadmap = s.roadmap_json ? safeParse(s.roadmap_json) : null;
    const step = roadmap && roadmap.steps[stepIndex];
    if (!step) return res.status(400).json({ error: '找不到这一步。' });
    const teach = teachMessageFor(s.id, stepIndex);
    if (!teach) return res.status(400).json({ error: '这一步还没讲过，先听完讲解再生成笔记。' });
    // 笔记风格：生成时由用户选，'pro'=专业简洁，其余一律 'easy'=易懂（默认）
    const style = (req.body || {}).style === 'pro' ? 'pro' : 'easy';
    const existing = db
      .prepare('SELECT * FROM notes WHERE subject_id=? AND session_id=? AND step_index=?')
      .get(subject.id, s.id, stepIndex);
    const material = stepTeachingMaterial(subject.id, s.id, step, stepIndex);
    const r = await ai.generateNote(subject, step, stepIndex + 1, material, existing ? existing.content : '', style);
    if (existing) {
      if (r.appended) {
        const date = new Date().toLocaleDateString('zh-CN');
        const content = `${existing.content}\n\n---\n\n### 补充 · ${date}\n\n${r.addition}`;
        // style 记最近一次生成用的风格
        db.prepare('UPDATE notes SET content=?, style=?, updated_at=? WHERE id=?').run(content, style, now(), existing.id);
      } else {
        db.prepare('UPDATE notes SET updated_at=? WHERE id=?').run(now(), existing.id);
      }
      return res.json({ note: getNote(existing.id), appended: r.appended, created: false });
    }
    const info = db
      .prepare(
        "INSERT INTO notes (subject_id, session_id, step_index, step_title, title, content, kind, style, created_at, updated_at) VALUES (?,?,?,?,?,?,'step',?,?,?)"
      )
      .run(subject.id, s.id, stepIndex, step.title, step.title, r.addition, style, now(), now());
    res.json({ note: getNote(info.lastInsertRowid), appended: true, created: true });
  })
);
// ---------- 知识点级笔记 / 导图（图谱页每个知识点一份） ----------
// 知识点笔记的素材：图谱里它的依赖关系 + 真实练习表现（判分统计与错因），不编造。
function nodeNoteContext(subjectId, node) {
  const byId = Object.fromEntries(
    db.prepare('SELECT id, title FROM nodes WHERE subject_id=?').all(subjectId).map((n) => [n.id, n.title])
  );
  const outEdges = db.prepare('SELECT * FROM edges WHERE subject_id=? AND from_id=?').all(subjectId, node.id);
  const inEdges = db.prepare('SELECT * FROM edges WHERE subject_id=? AND to_id=?').all(subjectId, node.id);
  const lines = [`知识点：${node.title}`, `当前状态：${{ new: '未学', learning: '学过未通过', passed: '已通过' }[node.status] || node.status}`];
  if (outEdges.length) {
    lines.push(`它依赖（先懂这些才懂它）：${outEdges.map((e) => `「${byId[e.to_id]}」${e.reason ? `（${e.reason}）` : ''}`).join('；')}`);
  }
  if (inEdges.length) {
    lines.push(`依赖它的（它是这些的前提）：${inEdges.map((e) => `「${byId[e.from_id]}」${e.reason ? `（${e.reason}）` : ''}`).join('；')}`);
  }
  const events = db.prepare('SELECT result, error_cause FROM review_events WHERE node_id=? ORDER BY id ASC').all(node.id);
  if (events.length) {
    const cnt = { full: 0, partial: 0, miss: 0 };
    const causes = {};
    const CAUSE_LABEL = { careless: '粗心', execution: '执行出错', concept: '概念没懂', memory: '记混了', other: '其他' };
    for (const e of events) {
      if (cnt[e.result] !== undefined) cnt[e.result]++;
      if (e.error_cause) causes[e.error_cause] = (causes[e.error_cause] || 0) + 1;
    }
    const causeText = Object.entries(causes)
      .map(([c, n]) => `${CAUSE_LABEL[c] || c} ${n} 次`)
      .join('、');
    lines.push(
      `真实练习表现：共判分 ${events.length} 次——答全 ${cnt.full} 次、答到一部分 ${cnt.partial} 次、没答到 ${cnt.miss} 次${causeText ? `；错因分布：${causeText}` : ''}。`
    );
  } else {
    lines.push('真实练习表现：还没有练过这个知识点（没有判分记录）。');
  }
  return lines.join('\n');
}
function getNodeNote(subjectId, nodeId) {
  return db.prepare("SELECT * FROM notes WHERE subject_id=? AND kind='node' AND node_id=?").get(subjectId, nodeId);
}
function getOwnedNode(req, nodeId) {
  const node = db.prepare('SELECT * FROM nodes WHERE id=?').get(nodeId);
  if (!node) return null;
  return subjectVisible(req, getSubject(node.subject_id)) ? node : null;
}
app.post(
  '/api/nodes/:id/note',
  wrap(async (req, res) => {
    const node = getOwnedNode(req, req.params.id);
    if (!node) return res.status(404).json({ error: '知识点不存在。' });
    const subject = getSubject(node.subject_id);
    const style = (req.body || {}).style === 'pro' ? 'pro' : 'easy';
    const existing = getNodeNote(subject.id, node.id);
    const ctx = nodeNoteContext(subject.id, node);
    const r = await ai.generateNodeNote(subject, node.title, ctx, existing ? existing.content : '', style);
    if (existing) {
      if (r.appended) {
        const date = new Date().toLocaleDateString('zh-CN');
        const content = `${existing.content}\n\n---\n\n### 补充 · ${date}\n\n${r.addition}`;
        db.prepare('UPDATE notes SET content=?, style=?, updated_at=? WHERE id=?').run(content, style, now(), existing.id);
      } else {
        db.prepare('UPDATE notes SET updated_at=? WHERE id=?').run(now(), existing.id);
      }
      return res.json({ note: getNote(existing.id), appended: r.appended, created: false });
    }
    if (!r.addition) return res.status(400).json({ error: '笔记生成失败，请重试。' });
    const info = db
      .prepare(
        "INSERT INTO notes (subject_id, session_id, step_index, step_title, title, content, kind, style, node_id, node_title, created_at, updated_at) VALUES (?,?,?,'',?,?,'node',?,?,?,?,?)"
      )
      .run(subject.id, null, -1, node.title, r.addition, style, node.id, node.title, now(), now());
    res.json({ note: getNote(info.lastInsertRowid), appended: true, created: true });
  })
);
app.post(
  '/api/nodes/:id/mindmap',
  wrap(async (req, res) => {
    const node = getOwnedNode(req, req.params.id);
    if (!node) return res.status(404).json({ error: '知识点不存在。' });
    const subject = getSubject(node.subject_id);
    // 导图素材优先用这个知识点的笔记，还没有笔记就用图谱关系与练习表现
    const note = getNodeNote(subject.id, node.id);
    const source = note && note.content ? note.content : nodeNoteContext(subject.id, node);
    const tree = await ai.generateMindmap(subject, node.title, source);
    const stored = JSON.stringify(tree);
    const existing = db
      .prepare("SELECT * FROM notes WHERE subject_id=? AND kind='mindmap' AND node_id=?")
      .get(subject.id, node.id);
    if (existing) {
      db.prepare('UPDATE notes SET content=?, title=?, updated_at=? WHERE id=?').run(stored, node.title, now(), existing.id);
      return res.json({ entryId: `n${existing.id}`, noteId: existing.id, content: stored });
    }
    const info = db
      .prepare(
        "INSERT INTO notes (subject_id, session_id, step_index, step_title, title, content, kind, style, node_id, node_title, created_at, updated_at) VALUES (?,?,?,'',?,?,'mindmap','',?,?,?,?)"
      )
      .run(subject.id, null, -1, node.title, stored, node.id, node.title, now(), now());
    res.json({ entryId: `n${info.lastInsertRowid}`, noteId: Number(info.lastInsertRowid), content: stored });
  })
);

// ---------- 知识库：只收「老师在教学中应学生要求生成的文档」 ----------
// 步笔记（kind=step）、知识点笔记（kind=node）、思维导图文档（kind=mindmap 的行、
// 笔记自带的导图、课堂按步导图）。总览/术语表/速查表虽然也存在 notes 表里（kind=overview/
// glossary/cheatsheet），但那是各自页签的预制文档，不进知识库列表——数据保留、页签照常读写。
// 每条带 entryId：n<notes行id> 本表行；nm<笔记id> 笔记自带的导图（存在 notes.mindmap）；sm<mindmaps行id> 课堂按步导图。
app.get('/api/subjects/:id/notes', (req, res) => {
  const subject = getOwnedSubject(req, req.params.id);
  if (!subject) return res.status(404).json({ error: '科目不存在。' });
  const entries = [];
  const rows = db
    .prepare("SELECT * FROM notes WHERE subject_id=? AND kind IN ('step','node','mindmap') ORDER BY updated_at DESC")
    .all(subject.id);
  for (const n of rows) {
    entries.push({
      entryId: `n${n.id}`,
      noteId: n.id,
      kind: n.kind || 'step',
      style: n.style || '',
      title: n.title,
      session_id: n.session_id,
      step_index: n.step_index,
      step_title: n.step_title,
      node_id: n.node_id,
      node_title: n.node_title,
      has_mindmap: Boolean(n.mindmap),
      content_len: (n.content || '').length,
      created_at: n.created_at,
      updated_at: n.updated_at,
    });
    if (n.mindmap) {
      entries.push({
        entryId: `nm${n.id}`,
        noteId: n.id,
        kind: 'mindmap',
        style: '',
        title: `${n.title} · 思维导图`,
        session_id: n.session_id,
        step_index: n.step_index,
        step_title: n.step_title,
        node_id: n.node_id,
        node_title: n.node_title,
        has_mindmap: false,
        content_len: n.mindmap.length,
        created_at: n.created_at,
        updated_at: n.updated_at,
      });
    }
  }
  for (const mm of db.prepare('SELECT * FROM mindmaps WHERE subject_id=? ORDER BY updated_at DESC').all(subject.id)) {
    entries.push({
      entryId: `sm${mm.id}`,
      noteId: null,
      mindmapId: mm.id,
      kind: 'mindmap',
      style: '',
      title: `${mm.step_title || mm.title} · 思维导图`,
      session_id: mm.session_id,
      step_index: mm.step_index,
      step_title: mm.step_title,
      node_id: null,
      node_title: '',
      has_mindmap: false,
      content_len: (mm.content || '').length,
      created_at: mm.created_at,
      updated_at: mm.updated_at,
    });
  }
  entries.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  res.json(entries);
});
app.get('/api/mindmaps/:id', (req, res) => {
  const mm = db.prepare('SELECT * FROM mindmaps WHERE id=?').get(req.params.id);
  if (!mm || !subjectVisible(req, getSubject(mm.subject_id))) {
    return res.status(404).json({ error: '思维导图不存在。' });
  }
  res.json(mm);
});
// 删除知识库条目（删前确认在前端做）：n 行直删（步笔记连带它在库里的导图行是派生的、随行消失）；
// 知识点笔记删掉时连带删它的导图行；nm 只清笔记自带导图；sm 删课堂导图行。
app.delete('/api/notes/:entryId', (req, res) => {
  const entryId = String(req.params.entryId || '');
  const mN = entryId.match(/^n(\d+)$/);
  const mNm = entryId.match(/^nm(\d+)$/);
  const mSm = entryId.match(/^sm(\d+)$/);
  if (mNm) {
    const n = getNote(mNm[1]);
    if (!n || !subjectVisible(req, getSubject(n.subject_id))) return res.status(404).json({ error: '笔记不存在。' });
    db.prepare("UPDATE notes SET mindmap='', updated_at=? WHERE id=?").run(now(), n.id);
    return res.json({ ok: true });
  }
  if (mSm) {
    const mm = db.prepare('SELECT * FROM mindmaps WHERE id=?').get(mSm[1]);
    if (!mm || !subjectVisible(req, getSubject(mm.subject_id))) return res.status(404).json({ error: '思维导图不存在。' });
    db.prepare('DELETE FROM mindmaps WHERE id=?').run(mm.id);
    return res.json({ ok: true });
  }
  if (mN) {
    const n = getNote(mN[1]);
    if (!n || !subjectVisible(req, getSubject(n.subject_id))) return res.status(404).json({ error: '笔记不存在。' });
    if (n.kind === 'node' && n.node_id) {
      db.prepare("DELETE FROM notes WHERE subject_id=? AND kind='mindmap' AND node_id=?").run(n.subject_id, n.node_id);
    }
    db.prepare('DELETE FROM notes WHERE id=?').run(n.id);
    return res.json({ ok: true });
  }
  return res.status(400).json({ error: '条目不对。' });
});
app.get('/api/notes/:id', (req, res) => {
  const n = getNote(req.params.id);
  if (!n || !subjectVisible(req, getSubject(n.subject_id))) {
    return res.status(404).json({ error: '笔记不存在。' });
  }
  res.json(n);
});
app.post(
  '/api/notes/:id/mindmap',
  wrap(async (req, res) => {
    const n = getNote(req.params.id);
    if (!n || !subjectVisible(req, getSubject(n.subject_id))) {
      return res.status(404).json({ error: '笔记不存在。' });
    }
    const subject = getSubject(n.subject_id);
    const tree = await ai.generateMindmap(subject, n.title, n.content);
    // 导图存树结构 JSON（前端自绘渲染）；老数据里的 mermaid 文本前端会解析成树再画
    db.prepare('UPDATE notes SET mindmap=?, updated_at=? WHERE id=?').run(JSON.stringify(tree), now(), n.id);
    res.json(getNote(n.id));
  })
);

// ---------- 思维导图（课堂按步生成，与笔记导图分开存） ----------
app.post(
  '/api/sessions/:id/steps/:stepIndex/mindmap',
  wrap(async (req, res) => {
    const s = getOwnedSession(req, req.params.id);
    if (!s) return res.status(404).json({ error: '课堂不存在。' });
    const subject = getSubject(s.subject_id);
    const stepIndex = Number(req.params.stepIndex);
    const roadmap = s.roadmap_json ? safeParse(s.roadmap_json) : null;
    const step = roadmap && roadmap.steps[stepIndex];
    if (!step) return res.status(400).json({ error: '找不到这一步。' });
    const teach = teachMessageFor(s.id, stepIndex);
    if (!teach) return res.status(400).json({ error: '这一步还没讲过，先听完讲解再生成思维导图。' });
    const material = stepTeachingMaterial(subject.id, s.id, step, stepIndex);
    const tree = await ai.generateMindmap(subject, step.title, material);
    const stored = JSON.stringify(tree); // 存树结构 JSON，前端自绘渲染
    const existing = db.prepare('SELECT * FROM mindmaps WHERE session_id=? AND step_index=?').get(s.id, stepIndex);
    let mindmapId;
    if (existing) {
      db.prepare('UPDATE mindmaps SET content=?, title=?, updated_at=? WHERE id=?').run(stored, step.title, now(), existing.id);
      mindmapId = existing.id;
    } else {
      const info = db
        .prepare(
          'INSERT INTO mindmaps (subject_id, session_id, step_index, step_title, title, content, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)'
        )
        .run(subject.id, s.id, stepIndex, step.title, step.title, stored, now(), now());
      mindmapId = Number(info.lastInsertRowid);
    }
    res.json({ stepIndex, content: stored, mindmapId });
  })
);

// ---------- 复习（FSRS-6 事件账） ----------
app.get('/api/subjects/:id/review-plan', (req, res) => {
  const subject = getOwnedSubject(req, req.params.id);
  if (!subject) return res.status(404).json({ error: '科目不存在。' });
  const plan = reviewPlanFor(subject.id).map((p) => ({
    nodeId: p.node.id,
    title: p.node.title,
    status: p.node.status,
    events: p.events,
    hasEvents: p.hasEvents,
    stability: p.stability,
    intervalDays: p.intervalDays,
    dueAt: p.dueAt,
    due: Boolean(p.due),
    overdueDays: p.overdueDays || 0,
    pendingConfirm: Boolean(p.pendingConfirm),
    lastResult: p.lastResult,
  }));
  res.json(plan);
});
app.post(
  '/api/subjects/:id/review-session',
  wrap(async (req, res) => {
    const subject = getOwnedSubject(req, req.params.id);
    if (!subject) return res.status(404).json({ error: '科目不存在。' });
    let nodeIds = Array.isArray((req.body || {}).nodeIds) ? req.body.nodeIds.map(Number) : [];
    if (!nodeIds.length) {
      nodeIds = reviewPlanFor(subject.id).filter((p) => p.hasEvents && p.due).map((p) => p.node.id);
    }
    if (!nodeIds.length) {
      return res.status(400).json({ error: '现在没有到期的知识点，不用复习。等有到期的了再来。' });
    }
    const nodes = nodeIds
      .map((id) => db.prepare('SELECT * FROM nodes WHERE id=? AND subject_id=?').get(id, subject.id))
      .filter(Boolean);
    const quiz = await ai.buildReviewQuiz(subject, nodes);
    const info = db
      .prepare(
        'INSERT INTO sessions (subject_id, kind, phase, quiz_json, review_node_ids, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run(subject.id, 'review', 'quiz', JSON.stringify(quiz), JSON.stringify(nodes.map((n) => n.id)), now(), now());
    const sid = info.lastInsertRowid;
    addMessage(sid, 'assistant', 'quiz', `复习时间到，这次专练这 ${nodes.length} 个到期知识点（全是新场景）：`, {
      questions: quiz.questions.map((q) => ({ id: q.id, question: q.question })),
    });
    res.json(sessionDetail(sid));
  })
);

// ---------- 闪卡（SM-2） ----------
app.get('/api/subjects/:id/cards', (req, res) => {
  const subject = getOwnedSubject(req, req.params.id);
  if (!subject) return res.status(404).json({ error: '科目不存在。' });
  const cards = db
    .prepare(
      `SELECT c.*, n.title AS node_title FROM cards c LEFT JOIN nodes n ON n.id=c.node_id
       WHERE c.subject_id=? ORDER BY c.due_at ASC, c.id ASC`
    )
    .all(subject.id);
  res.json(cards);
});
app.post(
  '/api/subjects/:id/cards/generate',
  wrap(async (req, res) => {
    const subject = getOwnedSubject(req, req.params.id);
    if (!subject) return res.status(404).json({ error: '科目不存在。' });
    const nodes = db.prepare('SELECT * FROM nodes WHERE subject_id=? ORDER BY id ASC').all(subject.id);
    if (!nodes.length) return res.status(400).json({ error: '图谱里还没有知识点，先上课或导入资料攒一点再出卡。' });
    const generated = await ai.generateCards(subject, nodes.map((n) => n.title));
    // 挂节点：先按归一化标题精确匹配；没对上的按顺序兜底配对还没挂的知识点，避免脱钩卡。
    const usedNodeIds = new Set();
    const unmatched = [];
    let created = 0;
    for (const c of generated) {
      const node = nodeByTitle(subject.id, c.nodeTitle);
      if (node && !usedNodeIds.has(node.id)) {
        usedNodeIds.add(node.id);
        insertCard(subject.id, node.id, c);
        created++;
      } else {
        unmatched.push(c);
      }
    }
    const remaining = nodes.filter((n) => !usedNodeIds.has(n.id));
    unmatched.forEach((c, i) => {
      insertCard(subject.id, remaining[i] ? remaining[i].id : null, c);
      created++;
    });
    res.json({ created });
    function insertCard(subjectId, nodeId, c) {
      db.prepare(
        'INSERT INTO cards (subject_id, node_id, front, back, ease, interval_days, reps, due_at, created_at) VALUES (?,?,?,?,2.5,0,0,?,?)'
      ).run(subjectId, nodeId, c.front, c.back, now(), now());
    }
  })
);
// 脱钩闪卡修复：node_id 为空（或指向已不存在的知识点）的卡，按正反面内容与图谱知识点重新匹配挂回。
app.post(
  '/api/subjects/:id/cards/repair',
  wrap(async (req, res) => {
    const subject = getOwnedSubject(req, req.params.id);
    if (!subject) return res.status(404).json({ error: '科目不存在。' });
    const nodes = db.prepare('SELECT * FROM nodes WHERE subject_id=? ORDER BY id ASC').all(subject.id);
    const orphans = db
      .prepare(
        `SELECT c.* FROM cards c LEFT JOIN nodes n ON n.id=c.node_id
         WHERE c.subject_id=? AND (c.node_id IS NULL OR n.id IS NULL)`
      )
      .all(subject.id);
    let repaired = 0;
    for (const card of orphans) {
      const hay = normalizeTitle(`${card.front} ${card.back}`);
      let best = null;
      let bestScore = 0;
      for (const node of nodes) {
        const norm = node.norm;
        if (!norm) continue;
        let score = 0;
        if (hay.includes(norm)) score = norm.length * 2; // 正反面里直接出现知识点标题，最可信
        else if (norm.includes(normalizeTitle(card.front).slice(0, 12)) && normalizeTitle(card.front).length >= 4) score = 4;
        if (score > bestScore) {
          bestScore = score;
          best = node;
        }
      }
      if (best) {
        db.prepare('UPDATE cards SET node_id=? WHERE id=?').run(best.id, card.id);
        repaired++;
      }
    }
    res.json({ total: orphans.length, repaired, remaining: orphans.length - repaired });
  })
);
app.post('/api/cards/:id/review', (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id=?').get(req.params.id);
  if (!card || !subjectVisible(req, getSubject(card.subject_id))) {
    return res.status(404).json({ error: '闪卡不存在。' });
  }
  const grade = String((req.body || {}).grade || 'good');
  let { ease, interval_days: interval, reps } = card;
  let due;
  const DAY = 86400000;
  if (grade === 'again') {
    reps = 0;
    interval = 0;
    ease = Math.max(1.3, ease - 0.2);
    due = new Date(Date.now() + 10 * 60 * 1000); // SM-2 口径：不会就 10 分钟后再来
  } else {
    reps += 1;
    if (grade === 'hard') {
      interval = reps === 1 ? 1 : Math.max(1, Math.round(interval * 1.2));
      ease = Math.max(1.3, ease - 0.15);
    } else if (grade === 'easy') {
      interval = reps === 1 ? 2 : reps === 2 ? 6 : Math.round(interval * ease * 1.3);
      ease = ease + 0.15;
    } else {
      interval = reps === 1 ? 1 : reps === 2 ? 6 : Math.round(interval * ease);
    }
    due = new Date(Date.now() + interval * DAY);
  }
  db.prepare('UPDATE cards SET ease=?, interval_days=?, reps=?, due_at=? WHERE id=?').run(
    ease,
    interval,
    reps,
    due.toISOString(),
    card.id
  );
  res.json(db.prepare('SELECT * FROM cards WHERE id=?').get(card.id));
});
app.delete('/api/cards/:id', (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id=?').get(req.params.id);
  if (!card || !subjectVisible(req, getSubject(card.subject_id))) {
    return res.status(404).json({ error: '闪卡不存在。' });
  }
  db.prepare('DELETE FROM cards WHERE id=?').run(card.id);
  res.json({ ok: true });
});

// ---------- 导入知识点：粘贴文本 / 上传文件（PDF·txt·md） / 本地文件 ----------
// 导入的内容由 AI 拆成一个个知识点并入图谱（source='import'），和上课沉淀的知识点同等对待。
app.post(
  '/api/subjects/:id/import-text',
  wrap(async (req, res) => {
    const subject = getOwnedSubject(req, req.params.id);
    if (!subject) return res.status(404).json({ error: '科目不存在。' });
    const text = String((req.body || {}).text || '').trim();
    if (text.length < 20) return res.status(400).json({ error: '内容太短了，多贴一点再导入。' });
    const source = String((req.body || {}).source || '粘贴文本');
    const graph = await ai.extractGraph(subject, text, source);
    const result = mergeGraph(subject.id, graph, 'import');
    res.json(result);
  })
);
app.post('/api/import/pdf', upload.single('file'), (req, res) => {
  (async () => {
    if (!req.file) return res.status(400).json({ error: '没有收到文件。' });
    if (!/\.pdf$/i.test(req.file.originalname)) return res.status(400).json({ error: '只支持 PDF 文件。' });
    const r = await files.extractPdfBuffer(req.file.buffer);
    res.json({
      text: r.text,
      chars: r.chars,
      pages: r.pages,
      scanned: r.scanned,
      warning: r.scanned
        ? '没读到文字，这份 PDF 可能是扫描件（图片型），本工具没有 OCR，读不了扫描版。'
        : '',
    });
  })().catch((e) => res.status(400).json({ error: `PDF 没读成功：${e.message}` }));
});
// 上传文件（PDF / txt / md）→ 提取文字，前端确认后再调 import-text 拆成知识点。
// 不支持的格式在 files.extractUploadBuffer 里明确报错，不会静默失败。
app.post('/api/import/file', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? '文件太大了：PDF 不超过 25 MB，文本文件不超过 2 MB。' : `上传没成功：${err.message}`;
      return res.status(400).json({ error: msg });
    }
    try {
      if (!req.file) return res.status(400).json({ error: '没有收到文件。' });
      const r = await files.extractUploadBuffer(req.file.buffer, req.file.originalname);
      res.json({
        kind: r.kind,
        text: r.text,
        chars: r.chars,
        pages: r.pages || 0,
        scanned: r.scanned,
        warning: r.scanned
          ? '没读到文字，这份 PDF 可能是扫描件（图片型），本工具没有 OCR，读不了扫描版。'
          : '',
      });
    } catch (e) {
      if (e instanceof files.FileAccessError) return res.status(e.status).json({ error: e.message });
      res.status(400).json({ error: `文件没读成功：${e.message}` });
    }
  });
});
app.get(
  '/api/files/list',
  wrap(async (req, res) => res.json(files.listDir(String(req.query.path || ''))))
);
app.get(
  '/api/files/read',
  wrap(async (req, res) => {
    const r = await files.readFileText(String(req.query.path || ''));
    res.json({
      kind: r.kind,
      chars: r.chars,
      pages: r.pages,
      scanned: r.scanned,
      text: r.text.slice(0, 20000),
      warning: r.scanned ? '没读到文字，这份 PDF 可能是扫描件（图片型），本工具没有 OCR，读不了扫描版。' : '',
    });
  })
);
app.post(
  '/api/files/import',
  wrap(async (req, res) => {
    const subject = getOwnedSubject(req, (req.body || {}).subjectId);
    if (!subject) return res.status(400).json({ error: '科目不存在。' });
    const p = String((req.body || {}).path || '');
    const r = await files.readFileText(p);
    if (r.scanned) {
      return res.status(400).json({ error: '这份 PDF 没读到文字（可能是扫描件），没法导入。' });
    }
    const graph = await ai.extractGraph(subject, r.text, `本地文件 ${p}`);
    const result = mergeGraph(subject.id, graph, 'import');
    res.json(result);
  })
);

// ---------- 个人中心：学习统计 + 热力图 + 最近动态（只算当前用户名下的数据） ----------
// 活动量来源都是库里真实的时间戳：复习判分事件、上课作答（用户消息）、开课、生成/增补笔记。
function localDay(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
app.get('/api/profile', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '请先登录。' });
  const uid = req.user.id;
  const subjectIds = db.prepare('SELECT id FROM subjects WHERE user_id=?').all(uid).map((r) => r.id);
  const stats = { subjectCount: subjectIds.length, passedSteps: 0, cardCount: 0, noteCount: 0, streakDays: 0, totalActivities: 0 };
  const heatmap = {}; // { 'YYYY-MM-DD': 当天活动次数 }
  const recent = []; // { time, text }
  const bump = (iso) => {
    const day = localDay(iso);
    heatmap[day] = (heatmap[day] || 0) + 1;
  };
  if (subjectIds.length) {
    const inIds = subjectIds.join(',');
    // 已完成步数：路线里走完的步（练习/已完成阶段算全部步，教学中算当前步之前的步）
    for (const s of db
      .prepare(`SELECT phase, step_index, roadmap_json FROM sessions WHERE subject_id IN (${inIds}) AND kind='lesson'`)
      .all()) {
      const roadmap = s.roadmap_json ? safeParse(s.roadmap_json) : null;
      const total = roadmap && Array.isArray(roadmap.steps) ? roadmap.steps.length : 0;
      if (!total) continue;
      stats.passedSteps += s.phase === 'done' || s.phase === 'quiz' ? total : s.phase === 'learning' ? Math.min(s.step_index, total) : 0;
    }
    stats.cardCount = db.prepare(`SELECT COUNT(*) c FROM cards WHERE subject_id IN (${inIds})`).get().c;
    // 笔记数只数知识库里的文档：步笔记 + 知识点笔记 + 思维导图文档（导图行、笔记自带导图、课堂按步导图），
    // 与科目页「知识库」列表的条数口径一致；总览/术语/速查是各自页签的文档，不算。
    stats.noteCount =
      db
        .prepare(`SELECT COUNT(*) c FROM notes WHERE subject_id IN (${inIds}) AND kind IN ('step','node','mindmap')`)
        .get().c +
      db
        .prepare(`SELECT COUNT(*) c FROM notes WHERE subject_id IN (${inIds}) AND kind IN ('step','node') AND mindmap<>''`)
        .get().c +
      db.prepare(`SELECT COUNT(*) c FROM mindmaps WHERE subject_id IN (${inIds})`).get().c;
    // 热力图计数
    for (const r of db.prepare(`SELECT created_at FROM review_events WHERE subject_id IN (${inIds})`).all()) bump(r.created_at);
    for (const r of db
      .prepare(
        `SELECT m.created_at FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.subject_id IN (${inIds}) AND m.role='user'`
      )
      .all()) bump(r.created_at);
    for (const r of db.prepare(`SELECT created_at FROM sessions WHERE subject_id IN (${inIds})`).all()) bump(r.created_at);
    for (const n of db.prepare(`SELECT created_at, updated_at FROM notes WHERE subject_id IN (${inIds})`).all()) {
      bump(n.created_at);
      if (localDay(n.updated_at) !== localDay(n.created_at)) bump(n.updated_at);
    }
    // 最近动态（各来源取一批，混排取最新 12 条）
    for (const r of db
      .prepare(
        `SELECT e.created_at AS t, n.title AS node_title, s.title AS subject_title
         FROM review_events e JOIN nodes n ON n.id=e.node_id JOIN subjects s ON s.id=e.subject_id
         WHERE e.subject_id IN (${inIds}) ORDER BY e.id DESC LIMIT 20`
      )
      .all()) {
      recent.push({ time: r.t, text: `在《${r.subject_title}》复习了知识点「${r.node_title}」` });
    }
    const MSG_TEXT = {
      probe_answer: (t) => `在《${t}》完成了摸底`,
      prediction: (t) => `在《${t}》写下了预测`,
      quiz_answer: (t) => `在《${t}》完成了练习`,
      feynman: (t) => `在《${t}》把知识点讲给老师听`,
      aside_q: (t) => `在《${t}》向老师提问`,
    };
    for (const r of db
      .prepare(
        `SELECT m.created_at AS t, m.type, s.title AS subject_title
         FROM messages m JOIN sessions ss ON ss.id=m.session_id JOIN subjects s ON s.id=ss.subject_id
         WHERE ss.subject_id IN (${inIds}) AND m.role='user' ORDER BY m.id DESC LIMIT 20`
      )
      .all()) {
      const f = MSG_TEXT[r.type];
      if (f) recent.push({ time: r.t, text: f(r.subject_title) });
    }
    for (const r of db
      .prepare(
        `SELECT ss.created_at AS t, ss.kind, s.title AS subject_title FROM sessions ss JOIN subjects s ON s.id=ss.subject_id
         WHERE ss.subject_id IN (${inIds}) ORDER BY ss.id DESC LIMIT 10`
      )
      .all()) {
      recent.push({ time: r.t, text: r.kind === 'review' ? `在《${r.subject_title}》开始了一次复习` : `在《${r.subject_title}》开了一节新课` });
    }
    for (const n of db
      .prepare(
        `SELECT title, created_at, updated_at FROM notes WHERE subject_id IN (${inIds}) AND kind IN ('step','node') ORDER BY updated_at DESC LIMIT 10`
      )
      .all()) {
      if (n.updated_at > n.created_at) recent.push({ time: n.updated_at, text: `增补了笔记《${n.title}》` });
      else recent.push({ time: n.created_at, text: `生成了笔记《${n.title}》` });
    }
    recent.sort((a, b) => (a.time < b.time ? 1 : -1));
  }
  stats.totalActivities = Object.values(heatmap).reduce((a, b) => a + b, 0);
  // 连续学习天数：从今天（今天没学就从昨天）往回数不间断的天数
  {
    const cursor = new Date();
    if (!heatmap[localDay(cursor.toISOString())]) cursor.setDate(cursor.getDate() - 1);
    let streak = 0;
    while (heatmap[localDay(cursor.toISOString())]) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    stats.streakDays = streak;
  }
  res.json({
    user: { id: req.user.id, username: req.user.username, created_at: req.user.created_at, avatar: req.user.avatar || '' },
    stats,
    heatmap,
    recent: recent.slice(0, 12),
  });
});

// ---------- 静态托管 ----------
const DIST = path.join(__dirname, '..', 'dist');
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(DIST, 'index.html')));
} else {
  app.get('/', (req, res) => res.send('前端还没构建：请先运行 npm run build，再 npm start。'));
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`多学堂 Web 版已启动：http://localhost:${PORT}`);
});
