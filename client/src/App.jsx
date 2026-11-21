import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Markdown, SpeechTextarea, FilesBrowser, useLocalState, SpeakButton, stopSpeaking, MindmapView } from './components.jsx';
import { Icon, VerdictTag } from './icons.jsx';

const PHASE_LABEL = { probe: '摸底中', learning: '教学中', quiz: '练习中', done: '已完成' };
const STATUS_LABEL = { new: '未学', learning: '学过未通过', passed: '已通过' };
const CAUSE_LABEL = { careless: '粗心', execution: '执行出错', concept: '概念没懂', memory: '记混了', other: '其他' };

// ---------- 界面皮肤：E 多邻国风 / F 语雀风，存 localStorage ----------
function getInitialTheme() {
  try {
    return localStorage.getItem('lsw-theme') === 'f' ? 'f' : 'e';
  } catch {
    return 'e';
  }
}

export function ThemeSwitch({ theme, onTheme }) {
  return (
    <div className="theme-switch" role="group" aria-label="界面风格">
      <button className={theme === 'e' ? 'ts-btn active' : 'ts-btn'} onClick={() => onTheme('e')}>
        多邻国
      </button>
      <button className={theme === 'f' ? 'ts-btn active' : 'ts-btn'} onClick={() => onTheme('f')}>
        语雀
      </button>
    </div>
  );
}

// 头像圆圈：设过头像显示图片，没设过显示用户名首字（顶栏用）。
function AvatarFace({ user, className }) {
  if (user && user.avatar) {
    return (
      <span className={className}>
        <img src={user.avatar} alt="" />
      </span>
    );
  }
  return <span className={className}>{user ? user.username.slice(0, 1) : '?'}</span>;
}

// 把用户选的图居中裁成方形、缩到 256×256，返回 data URL（先 PNG，太大了改 JPEG 压一压）。
function processAvatarFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const size = 256;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const sx = (img.naturalWidth - side) / 2;
      const sy = (img.naturalHeight - side) / 2;
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
      let out = canvas.toDataURL('image/png');
      if (out.length > 380000) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        out = canvas.toDataURL('image/jpeg', 0.85);
      }
      resolve(out);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('这张图片读不出来，换一张试试。'));
    };
    img.src = url;
  });
}

// 品牌吉祥物：用户选定的 logo 图（绿猫头鹰抱学科书，client/public/logo.webp）；
// 顶栏小标 + 登录页品牌区两套皮肤都用，E 首页欢迎区另有大图，F 首页不出现

export default function App() {
  const [view, setView] = useState({ name: 'home' });
  const [theme, setTheme] = useState(getInitialTheme);
  const [me, setMe] = useState(undefined); // undefined=还没查 / null=未登录 / 对象=已登录的用户
  const [hasUsers, setHasUsers] = useState(false);
  const topbarRef = useRef(null);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('lsw-theme', theme);
    } catch {
      /* 存不了就算了 */
    }
  }, [theme]);
  const refreshMe = useCallback(async () => {
    try {
      const r = await api.get('/api/auth/me');
      setMe(r.user || null);
      setHasUsers(Boolean(r.hasUsers));
    } catch {
      setMe(null);
    }
  }, []);
  useEffect(() => {
    refreshMe();
  }, [refreshMe]);

  async function logout() {
    try {
      await api.post('/api/auth/logout');
    } catch {
      /* 退出失败也当已退出处理 */
    }
    setMe(null);
    setView({ name: 'home' });
  }

  // 登录墙：没登录就只能看到登录/注册页——首页、科目、课堂、个人中心、设置全部进不去，
  // 空库初始状态也一样（只许注册第一个账号）。服务端数据接口同样一律 401 兜底。
  const showAuth = view.name === 'auth' || (me !== undefined && !me);

  // 顶栏高度实测写回 --topbar-h：顶栏在窄屏会折行、真实高度比写死值大，
  // 课堂操作栏（.sticky-head）按写死值贴位就会裂开一条缝、滚动时内容从缝里滑过。
  // 量到多少就贴多少，折行也不怕。
  useEffect(() => {
    const el = topbarRef.current;
    if (!el) return;
    const apply = () => {
      document.documentElement.style.setProperty('--topbar-h', `${el.offsetHeight}px`);
    };
    apply();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(apply);
      ro.observe(el);
      return () => ro.disconnect();
    }
  }, [showAuth, me]);

  return (
    <div className="app">
      {!showAuth && (
      <header className="topbar" ref={topbarRef}>
        <div className="brand" onClick={() => setView({ name: 'home' })}>
          <img className="brand-logo" src="/logo.webp" alt="多学堂" />
          <span className="brand-name">
            多学堂 <span className="muted">Web 版</span>
          </span>
        </div>
        <nav>
          <ThemeSwitch theme={theme} onTheme={setTheme} />
          <button onClick={() => setView({ name: 'home' })}>我的科目</button>
          {me ? (
            <button className="avatar-btn" onClick={() => setView({ name: 'profile' })} title="个人中心">
              <AvatarFace user={me} className="avatar-circle" />
              <span className="avatar-name">{me.username}</span>
            </button>
          ) : (
            <button onClick={() => setView({ name: 'auth' })}>登录 / 注册</button>
          )}
        </nav>
      </header>
      )}
      <main
        className={
          view.name === 'session' ? 'page session-page' : view.name === 'profile' && !showAuth ? 'page page-wide' : 'page'
        }
      >
        {me === undefined ? (
          <p className="muted">正在加载…</p>
        ) : showAuth ? (
          <AuthPage
            hasUsers={hasUsers}
            onAuthed={(user) => {
              setMe(user);
              setHasUsers(true);
              setView({ name: 'home' });
            }}
          />
        ) : (
          <>
            {view.name === 'home' && <Home theme={theme} onOpen={(id) => setView({ name: 'subject', subjectId: id })} />}
            {view.name === 'profile' && (
              <ProfilePage user={me} onLogout={logout} onGoAuth={() => setView({ name: 'auth' })} onUserChange={setMe} />
            )}
            {view.name === 'subject' && (
              <SubjectView
                subjectId={view.subjectId}
                initialTab={view.tab}
                openNoteId={view.openNoteId}
                onOpenSession={(sessionId, focusStep) =>
                  setView({ name: 'session', subjectId: view.subjectId, sessionId, focusStep })
                }
                onBack={() => setView({ name: 'home' })}
              />
            )}
            {view.name === 'session' && (
              <SessionView
                sessionId={view.sessionId}
                focusStep={view.focusStep}
                theme={theme}
                onBack={() => setView({ name: 'subject', subjectId: view.subjectId })}
                onOpenNote={(entryId) =>
                  setView({ name: 'subject', subjectId: view.subjectId, tab: 'notes', openNoteId: entryId })
                }
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

// ---------- 登录 / 注册 ----------
function AuthPage({ hasUsers, onAuthed }) {
  const [mode, setMode] = useState(hasUsers ? 'login' : 'register'); // 还没人注册时默认落在注册（第一个账号认领数据）
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError('');
    setBusy(true);
    try {
      const r = await api.post(`/api/auth/${mode}`, { username: username.trim(), password });
      onAuthed(r.user);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-brand">
        <img className="auth-logo" src="/logo.webp" alt="多学堂" />
        <h1 className="auth-title">多学堂</h1>
        <p className="auth-tagline">什么都能学的 AI 学习空间</p>
      </div>
      <div className="auth-form">
        {!hasUsers && mode === 'register' && (
          <div className="notice friendly">这是第一个账号：注册之后，现在已有的科目和学习数据都会归到你名下。</div>
        )}
        <label>
          用户名
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="至少 2 个字" autoComplete="username" />
        </label>
        <label>
          密码
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="至少 6 位"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && username.trim() && password) submit();
            }}
          />
        </label>
        {error && <div className="notice warn">{error}</div>}
        <button className="primary auth-submit" onClick={submit} disabled={busy || !username.trim() || !password}>
          {busy ? '请稍等…' : mode === 'login' ? '登录' : '注册'}
        </button>
        <p className="auth-switch-line">
          {mode === 'login' ? (
            <>
              还没有账号？
              <button type="button" className="auth-link" onClick={() => { setMode('register'); setError(''); }}>
                去注册
              </button>
            </>
          ) : (
            <>
              已有账号？
              <button type="button" className="auth-link" onClick={() => { setMode('login'); setError(''); }}>
                去登录
              </button>
            </>
          )}
        </p>
        <p className="muted auth-privacy">密码只存加密后的样子，谁也看不到原文。</p>
      </div>
    </div>
  );
}

// ---------- 个人中心（GitHub 个人主页式布局：左资料栏 + 右热力图/动态/设置） ----------
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ProfilePage({ user, onLogout, onGoAuth, onUserChange }) {
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState('');
  const avatarFileRef = useRef(null);
  const [avatarDraft, setAvatarDraft] = useState(''); // 已裁好、等确认保存的头像图（data URL）
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState('');
  const [avatarNote, setAvatarNote] = useState('');

  useEffect(() => {
    if (!user) return;
    api
      .get('/api/profile')
      .then(setProfile)
      .catch((e) => setError(e.message));
  }, [user]);

  async function onPickAvatarFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // 清空，方便下次选同一张图也能触发
    if (!file) return;
    setAvatarError('');
    setAvatarNote('');
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      setAvatarError('头像只支持 PNG、JPG 或 WebP 图片。');
      return;
    }
    try {
      setAvatarDraft(await processAvatarFile(file));
    } catch (err) {
      setAvatarError(err.message);
    }
  }
  async function saveAvatar() {
    setAvatarBusy(true);
    setAvatarError('');
    try {
      const r = await api.post('/api/auth/avatar', { avatar: avatarDraft });
      if (onUserChange) onUserChange(r.user);
      setAvatarDraft('');
      setAvatarNote('头像换好了。');
    } catch (err) {
      setAvatarError(err.message);
    } finally {
      setAvatarBusy(false);
    }
  }
  async function resetAvatar() {
    setAvatarBusy(true);
    setAvatarError('');
    try {
      const r = await api.del('/api/auth/avatar');
      if (onUserChange) onUserChange(r.user);
      setAvatarNote('已恢复成默认头像。');
    } catch (err) {
      setAvatarError(err.message);
    } finally {
      setAvatarBusy(false);
    }
  }

  // 登录墙之下个人中心不会在未登录时被打开；这里只是兜底，真到了就引去登录。
  if (!user) {
    return (
      <div>
        <h1>个人中心</h1>
        <div className="card">
          <h3>先登录吧</h3>
          <p className="muted">个人中心和设置都要登录后才能进。</p>
          <button className="primary" onClick={onGoAuth}>
            去登录 / 注册
          </button>
        </div>
      </div>
    );
  }

  const stats = profile ? profile.stats : null;
  return (
    <div>
      <h1>个人中心</h1>
      {error && <div className="notice warn">{error}</div>}
      <div className="profile-layout">
        <aside className="profile-side">
          <div
            className="profile-avatar clickable"
            onClick={() => avatarFileRef.current && avatarFileRef.current.click()}
            title="点击更换头像"
          >
            {user.avatar ? <img src={user.avatar} alt="我的头像" /> : user.username.slice(0, 1)}
          </div>
          <div className="profile-username">{user.username}</div>
          <div className="muted">注册于 {fmtDate(user.created_at)}</div>
          <input
            ref={avatarFileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={onPickAvatarFile}
          />
          <div className="avatar-actions">
            {avatarDraft ? (
              <>
                <div className="avatar-preview">
                  <img src={avatarDraft} alt="新头像预览" />
                  <span className="muted">新头像预览</span>
                </div>
                <button className="primary" onClick={saveAvatar} disabled={avatarBusy}>
                  {avatarBusy ? '正在保存…' : '保存头像'}
                </button>
                <button onClick={() => setAvatarDraft('')} disabled={avatarBusy}>
                  取消
                </button>
              </>
            ) : (
              <>
                <button onClick={() => avatarFileRef.current && avatarFileRef.current.click()}>更换头像</button>
                {user.avatar && (
                  <button onClick={resetAvatar} disabled={avatarBusy}>
                    恢复默认头像
                  </button>
                )}
              </>
            )}
            {avatarNote && <div className="avatar-note">{avatarNote}</div>}
            {avatarError && <div className="notice warn">{avatarError}</div>}
          </div>
          <div className="profile-stats">
            <div className="stat-row">
              <span>在学科目</span>
              <b>{stats ? stats.subjectCount : '…'}</b>
            </div>
            <div className="stat-row">
              <span>已完成步数</span>
              <b>{stats ? stats.passedSteps : '…'}</b>
            </div>
            <div className="stat-row">
              <span>闪卡</span>
              <b>{stats ? `${stats.cardCount} 张` : '…'}</b>
            </div>
            <div className="stat-row">
              <span>笔记</span>
              <b>{stats ? `${stats.noteCount} 份` : '…'}</b>
            </div>
            <div className="stat-row">
              <span>连续学习</span>
              <b>{stats ? `${stats.streakDays} 天` : '…'}</b>
            </div>
          </div>
          <button className="profile-logout" onClick={onLogout}>
            退出登录
          </button>
        </aside>
        <div className="profile-main">
          <div className="card">
            <h3>
              <Icon name="calendar" size={17} /> 学习热力图
            </h3>
            {profile ? (
              <Heatmap data={profile.heatmap} total={stats.totalActivities} />
            ) : (
              <p className="muted">正在加载…</p>
            )}
          </div>
          <div className="card">
            <h3>最近动态</h3>
            {profile ? (
              profile.recent.length ? (
                <ul className="activity-list">
                  {profile.recent.map((r, i) => (
                    <li key={i}>
                      <span className="activity-text">{r.text}</span>
                      <span className="muted activity-time">{fmtDateTime(r.time)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">还没有学习动态，去学一节课这里就有了。</p>
              )
            ) : (
              <p className="muted">正在加载…</p>
            )}
          </div>
          <Settings />
        </div>
      </div>
    </div>
  );
}

// 学习热力图：仿 GitHub 贡献图，最近 53 周、一天一格，深浅 = 当天学习活动次数。
function heatLevel(count) {
  if (!count) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  return 4;
}
function dayKey(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function Heatmap({ data, total }) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - today.getDay() - 52 * 7); // 回到 52 周前那周的周日
  const weeks = [];
  const monthLabels = [];
  let prevMonth = -1;
  for (let w = 0; w < 53; w++) {
    const col = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(start);
      date.setDate(date.getDate() + w * 7 + d);
      col.push(date);
    }
    const m = col[0].getMonth();
    if (m !== prevMonth) {
      monthLabels.push({ week: w, label: `${m + 1}月` });
      prevMonth = m;
    }
    weeks.push(col);
  }
  return (
    <div>
      <div className="hm-scroll">
        <div className="hm-months">
          {monthLabels.map((ml) => (
            <span key={ml.week} style={{ gridColumn: `${ml.week + 1} / span 4` }}>
              {ml.label}
            </span>
          ))}
        </div>
        <div className="hm-body">
          <div className="hm-days">
            {['', '一', '', '三', '', '五', ''].map((t, i) => (
              <span key={i}>{t}</span>
            ))}
          </div>
          <div className="hm-grid">
            {weeks.map((col, w) =>
              col.map((date, d) => {
                const future = date > today;
                const key = dayKey(date);
                const count = data[key] || 0;
                return (
                  <div
                    key={`${w}-${d}`}
                    className={future ? 'hm-cell hm-future' : `hm-cell hm-${heatLevel(count)}`}
                    title={future ? '' : `${key} · ${count} 次学习活动`}
                  />
                );
              })
            )}
          </div>
        </div>
      </div>
      <div className="row-between hm-foot">
        <span className="muted">过去一年共 {total} 次学习活动</span>
        <span className="hm-legend">
          少
          {[0, 1, 2, 3, 4].map((l) => (
            <span key={l} className={`hm-cell hm-${l}`} />
          ))}
          多
        </span>
      </div>
    </div>
  );
}

function Home({ onOpen, theme }) {
  const [subjects, setSubjects] = useState([]);
  const [stats, setStats] = useState({}); // 每个科目的明细统计（图谱状态、闪卡总数），只用来算 XP 与任务进度
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [mode, setMode] = useState('normal'); // normal 常规 | crash 速成
  const [purpose, setPurpose] = useState('');
  const [timeBudget, setTimeBudget] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const list = await api.get('/api/subjects');
      setSubjects(list);
      // 明细统计：XP 只按真实「已通过」知识点数算，不许虚构
      const entries = await Promise.all(
        list.map(async (s) => {
          try {
            const [detail, cards] = await Promise.all([
              api.get(`/api/subjects/${s.id}`),
              api.get(`/api/subjects/${s.id}/cards`),
            ]);
            const nodes = detail.nodes || [];
            return [
              s.id,
              {
                nodes,
                passed: nodes.filter((n) => n.status === 'passed').length,
                learning: nodes.filter((n) => n.status === 'learning').length,
                cardTotal: cards.length,
              },
            ];
          } catch {
            return [s.id, null];
          }
        })
      );
      setStats(Object.fromEntries(entries));
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const totalNodes = subjects.reduce((a, s) => a + (stats[s.id] ? stats[s.id].nodes.length : s.nodeCount || 0), 0);
  const totalPassed = subjects.reduce((a, s) => a + (stats[s.id] ? stats[s.id].passed : 0), 0);
  const totalDue = subjects.reduce((a, s) => a + (s.reviewDue || 0) + (s.cardDue || 0), 0);
  const xp = totalPassed * 20; // XP 口径：每个真实通过的知识点 20 XP
  const progressPct = totalNodes > 0 ? Math.round((totalPassed / totalNodes) * 100) : 0;

  async function create() {
    setError('');
    try {
      const s = await api.post('/api/subjects', {
        title,
        goal,
        mode,
        purpose: mode === 'crash' ? purpose : '',
        timeBudget: mode === 'crash' ? timeBudget : '',
      });
      setTitle('');
      setGoal('');
      setPurpose('');
      setTimeBudget('');
      setMode('normal');
      onOpen(s.id);
    } catch (e) {
      setError(e.message);
    }
  }
  async function remove(id) {
    if (!confirm('删掉这个科目？它的课堂、图谱、闪卡和复习记录都会一起删掉。')) return;
    await api.del(`/api/subjects/${id}`);
    load();
  }

  return (
    <div>
      {/* 页头：E 是猫头鹰欢迎区（多邻国专属元素）；F 换语雀知识库式页头——同样的信息（科目数/通过数/到期数/总进度），文档式呈现 */}
      {theme === 'f' ? (
        <div className="kb-head">
          <div className="kb-title-row">
            <img className="brand-logo" src="/logo.webp" alt="多学堂" />
            <div>
              <div className="kb-title">多学堂</div>
              <div className="muted">首页 / 我的科目</div>
            </div>
          </div>
          <div className="kb-meta">
            <span>共 {subjects.length} 个科目</span>
            <span>已通过 {totalPassed} / 共 {totalNodes} 个知识点</span>
            {totalDue > 0 && <span className="kb-due">有 {totalDue} 项到期待处理</span>}
          </div>
          <div className="kb-progress" role="progressbar" aria-valuenow={progressPct} aria-valuemin="0" aria-valuemax="100">
            <div className="kb-progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
        </div>
      ) : (
        <div className="hero">
          <img className="hero-logo" src="/logo.webp" alt="多学堂吉祥物" />
          <div className="hero-main">
            <div className="bubble">
              {totalDue > 0
                ? `有 ${totalDue} 个任务该做了——该复习了，回头复习一下记得更牢！`
                : '挑个科目，开始今天的学习吧！先摸底，再一步步学。'}
            </div>
            <div className="hero-stats">
              <span className="xp-badge">
                <Icon name="star" size={16} filled /> {xp} XP
              </span>
              <span className="muted">已通过 {totalPassed} / 共 {totalNodes} 个知识点</span>
            </div>
            <div className="big-progress" role="progressbar" aria-valuenow={progressPct} aria-valuemin="0" aria-valuemax="100">
              <div className="big-progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        </div>
      )}
      <h1>我的科目</h1>
      <div className="card">
        <h3>新建科目</h3>
        <div className="form-row">
          <input placeholder="科目主题，比如：Python 基础" value={title} onChange={(e) => setTitle(e.target.value)} />
          <input placeholder="学习目标，比如：能独立写小脚本" value={goal} onChange={(e) => setGoal(e.target.value)} />
          <button className="primary" onClick={create} disabled={!title.trim()}>
            建好并开课
          </button>
        </div>
        <div className="row">
          <span className="muted">学习模式：</span>
          <div className="theme-switch" role="group" aria-label="学习模式">
            <button type="button" className={mode === 'normal' ? 'ts-btn active' : 'ts-btn'} onClick={() => setMode('normal')}>
              常规
            </button>
            <button type="button" className={mode === 'crash' ? 'ts-btn active' : 'ts-btn'} onClick={() => setMode('crash')}>
              <Icon name="zap" size={14} /> 速成
            </button>
          </div>
          <span className="muted">{mode === 'crash' ? '时间紧、先搭骨架：先给一页纸总览，路线只留核心步。' : '按部就班，一步步学扎实。'}</span>
        </div>
        {mode === 'crash' && (
          <div className="form-row">
            <input placeholder="用途，比如：明天下午面试" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
            <input placeholder="可用时间，比如：3 小时" value={timeBudget} onChange={(e) => setTimeBudget(e.target.value)} />
          </div>
        )}
        {error && <div className="notice warn">{error}</div>}
      </div>
      {subjects.length === 0 && <p className="muted">还没有科目，先在上面建一个。</p>}
      <div className="subject-grid">
        {subjects.map((s) => (
          <div className="card subject-card" key={s.id}>
            <div className="subject-title" onClick={() => onOpen(s.id)}>
              {s.title}
            </div>
            <div className="muted">{s.goal || '（没填学习目标）'}</div>
            {theme === 'f' ? (
              <>
                <div className="badges">
                  <span className="badge">知识点 {s.nodeCount}</span>
                  <span className="badge">课堂 {s.sessionCount}</span>
                  {s.mode === 'crash' && (
                    <span className="badge">
                      <Icon name="zap" size={13} /> 速成{s.purpose ? ` · ${s.purpose}` : ''}{s.time_budget ? ` · ${s.time_budget}` : ''}
                    </span>
                  )}
                </div>
                {(s.reviewDue > 0 || s.cardDue > 0) && (
                  <ul className="due-list">
                    {s.reviewDue > 0 && (
                      <li>
                        <span className="badge hot">到期</span>
                        <span>{s.reviewDue} 个知识点待复习</span>
                      </li>
                    )}
                    {s.cardDue > 0 && (
                      <li>
                        <span className="badge hot">到期</span>
                        <span>{s.cardDue} 张闪卡待复习</span>
                      </li>
                    )}
                  </ul>
                )}
              </>
            ) : (
              <>
            <div className="badges">
              <span className="badge">知识点 {s.nodeCount}</span>
              <span className="badge">课堂 {s.sessionCount}</span>
              {s.mode === 'crash' && (
                <span className="badge">
                  <Icon name="zap" size={13} /> 速成{s.purpose ? ` · ${s.purpose}` : ''}{s.time_budget ? ` · ${s.time_budget}` : ''}
                </span>
              )}
              {s.reviewDue > 0 && (
                <span className="badge hot">
                  <Icon name="calendar" size={13} /> {s.reviewDue} 个知识点到期复习
                </span>
              )}
              {s.cardDue > 0 && (
                <span className="badge hot due-card">
                  <Icon name="layers" size={13} /> {s.cardDue} 张闪卡到期
                </span>
              )}
            </div>
            {(() => {
              const st = stats[s.id];
              if (!st || (s.reviewDue === 0 && s.cardDue === 0)) return null;
              return (
                <div className="task-list">
                  {s.reviewDue > 0 && (
                    <div className="task-card task-green">
                      <div className="task-head">
                        <span>
                          <Icon name="calendar" size={15} /> 每日任务 · 复习
                        </span>
                        <span className="task-num">
                          已通过 {st.passed} / 共 {st.nodes.length}
                        </span>
                      </div>
                      <div className="task-text">{s.reviewDue} 个知识点该复习了，回头复习一下记得更牢。</div>
                      <div className="seg-bar">
                        {st.nodes.map((n) => (
                          <span key={n.id} className={`seg ${n.status === 'passed' ? 'on' : n.status === 'learning' ? 'mid' : ''}`} />
                        ))}
                      </div>
                    </div>
                  )}
                  {s.cardDue > 0 && (
                    <div className="task-card task-yellow">
                      <div className="task-head">
                        <span>
                          <Icon name="layers" size={15} /> 每日任务 · 闪卡
                        </span>
                        <span className="task-num">
                          到期 {s.cardDue} / 共 {st.cardTotal} 张
                        </span>
                      </div>
                      <div className="task-text">翻一翻卡片，把快忘的捡回来。</div>
                      <div className="seg-bar">
                        {Array.from({ length: st.cardTotal }).map((_, i) => (
                          <span key={i} className={`seg ${i < s.cardDue ? 'due' : 'on'}`} />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
              </>
            )}
            <div className="row-end">
              <button onClick={() => onOpen(s.id)}>进去学</button>
              <button className="danger" onClick={() => remove(s.id)}>
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function fmtFetchTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

const TTS_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓（女声 · 自然亲切）' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊（女声 · 温柔）' },
  { id: 'zh-CN-YunyangNeural', label: '云扬（男声 · 播报感）' },
  { id: 'zh-CN-YunjianNeural', label: '云健（男声 · 沉稳）' },
];

function Settings() {
  const [form, setForm] = useState({ baseUrl: '', model: '', apiKey: '', filesRoot: '', ttsVoice: 'zh-CN-XiaoxiaoNeural' });
  const [hasKey, setHasKey] = useState(false);
  const [clearKey, setClearKey] = useState(false);
  const [msg, setMsg] = useState('');
  const [testMsg, setTestMsg] = useState('');
  const [testOk, setTestOk] = useState(null); // null=测试中 / true=通了 / false=没通
  const [modelList, setModelList] = useState([]);
  const [modelsFetchedAt, setModelsFetchedAt] = useState(0);
  const [modelsFromCache, setModelsFromCache] = useState(false);
  const [modelsMsg, setModelsMsg] = useState('');
  const [modelsOk, setModelsOk] = useState(null); // null=获取中 / true=成功 / false=失败
  const [modelsBusy, setModelsBusy] = useState(false);
  const [showModels, setShowModels] = useState(false); // 模型列表默认收起，点「选择模型」才展开
  // 音色试听：只合成一句固定样例播放，不改已选/已保存的音色
  const [previewVoice, setPreviewVoice] = useState(''); // 正在试听（加载或播放中）的音色 id
  const [previewMsg, setPreviewMsg] = useState('');
  const previewAudioRef = useRef(null);
  const previewUrlRef = useRef(null);

  function stopPreview() {
    if (previewAudioRef.current) {
      try {
        previewAudioRef.current.pause();
      } catch {
        /* ignore */
      }
      previewAudioRef.current = null;
    }
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreviewVoice('');
  }
  useEffect(() => () => stopPreview(), []);
  async function playPreview(voiceId) {
    if (previewVoice === voiceId) {
      stopPreview(); // 播放中再点就停
      return;
    }
    stopPreview(); // 切到另一个音色前先停掉前一个
    setPreviewMsg('');
    setPreviewVoice(voiceId);
    try {
      const resp = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '你好，我是你的学习老师，这一课我们来讲清楚这个概念。', voice: voiceId }),
      });
      if (!resp.ok) throw new Error('合成失败');
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      previewUrlRef.current = url;
      const audio = new Audio(url);
      previewAudioRef.current = audio;
      audio.onended = () => {
        if (previewAudioRef.current === audio) stopPreview();
      };
      audio.onerror = () => {
        if (previewAudioRef.current === audio) {
          stopPreview();
          setPreviewMsg('试听播放失败，检查一下网络再试。');
        }
      };
      await audio.play();
    } catch {
      stopPreview();
      setPreviewMsg('试听没成功：云端语音暂时连不上，检查网络再试（不影响已保存的音色）。');
    }
  }

  useEffect(() => {
    api.get('/api/settings').then((s) => {
      setForm({ baseUrl: s.baseUrl, model: s.model, apiKey: '', filesRoot: s.filesRoot, ttsVoice: s.ttsVoice || 'zh-CN-XiaoxiaoNeural' });
      setHasKey(s.hasKey);
    });
    // 先读服务端缓存的模型列表，有就直接显示，不重新请求接口。
    api
      .get('/api/settings/models')
      .then((r) => {
        if (r.models && r.models.length) {
          setModelList(r.models);
          setModelsFetchedAt(r.fetchedAt || 0);
          setModelsFromCache(true);
        }
      })
      .catch(() => {});
  }, []);

  async function fetchModels() {
    setModelsBusy(true);
    setModelsMsg('正在从接口获取模型列表…');
    setModelsOk(null);
    try {
      const r = await api.post('/api/settings/models', { baseUrl: form.baseUrl, apiKey: form.apiKey });
      if (r.ok) {
        setModelList(r.models || []);
        setModelsFetchedAt(r.fetchedAt || Date.now());
        setModelsFromCache(false);
        setModelsOk(true);
      } else {
        setModelsOk(false);
      }
      setModelsMsg(r.message);
    } catch (e) {
      setModelsOk(false);
      setModelsMsg(e.message);
    } finally {
      setModelsBusy(false);
    }
  }

  async function save() {
    setMsg('');
    try {
      const s = await api.post('/api/settings', { ...form, clearKey });
      setHasKey(s.hasKey);
      setForm((f) => ({ ...f, apiKey: '' }));
      setClearKey(false);
      setMsg('已保存。设置存在本机项目的 data/settings.json 里，不会上传到任何地方。');
    } catch (e) {
      setMsg(e.message);
    }
  }
  async function test() {
    setTestMsg('正在测试…');
    setTestOk(null);
    try {
      const r = await api.post('/api/settings/test', form);
      setTestOk(Boolean(r.ok));
      setTestMsg(r.message);
    } catch (e) {
      setTestOk(false);
      setTestMsg(e.message);
    }
  }

  return (
    <div>
      <h1>设置</h1>
      <div className="card">
        <h3>模型（用你自己的 Key）</h3>
        <p className="muted">
          本应用不自带模型：上课、出题、批改都用你填的这个模型。填 OpenAI 兼容接口即可（OpenAI、深度求索、通义、智谱等大多兼容）。
        </p>
        <label>
          接口地址（base URL）
          <input
            value={form.baseUrl}
            onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            placeholder="https://api.openai.com/v1"
          />
        </label>
        <label>
          模型名（可以手动输入，也可以点「选择模型」从列表里挑）
          <input
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
            placeholder="比如 gpt-4o-mini / deepseek-chat"
            list="lsw-model-options"
          />
          <datalist id="lsw-model-options">
            {modelList.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        {showModels &&
          (modelList.length > 0 ? (
            <div className="model-picker" role="listbox" aria-label="可选模型列表">
              {modelList.map((m) => (
                <button
                  type="button"
                  key={m}
                  role="option"
                  aria-selected={m === form.model}
                  className={'model-option' + (m === form.model ? ' selected' : '')}
                  onClick={() => {
                    setForm({ ...form, model: m });
                    setShowModels(false); // 选完自动收起
                  }}
                >
                  <span className="model-option-name">{m}</span>
                  {m === form.model && <Icon name="check" size={15} />}
                </button>
              ))}
            </div>
          ) : (
            <div className="notice">还没有获取过模型列表：先点下面「获取模型列表」从接口拉一次，就能在这里点选了；也可以直接在输入框里手填模型名。</div>
          ))}
        <div className="row">
          <button type="button" onClick={() => setShowModels((v) => !v)}>
            {showModels ? '收起列表' : '选择模型'}
          </button>
          <button onClick={fetchModels} disabled={modelsBusy}>
            <Icon name="refresh-cw" size={15} /> {modelsBusy ? '正在获取…' : '获取模型列表'}
          </button>
          <span className="muted">
            {modelList.length
              ? `共 ${modelList.length} 个模型 · 上次获取：${fmtFetchTime(modelsFetchedAt)}${modelsFromCache ? '（缓存）' : ''}，点按钮可重新获取`
              : '还没有获取过模型列表：点按钮从接口拉一次，之后点「选择模型」展开点选就行。'}
          </span>
        </div>
        {modelsMsg && (
          <div className="notice">
            <Icon name={modelsOk === null ? 'clock' : modelsOk ? 'check-circle' : 'x-circle'} size={16} /> {modelsMsg}
          </div>
        )}
        <label>
          API Key{hasKey && !clearKey ? '（已配置，留空表示不改）' : ''}
          <input
            type="password"
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            placeholder={hasKey ? '••••••••' : 'sk-…'}
          />
        </label>
        {hasKey && (
          <label className="check">
            <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} /> 清除已保存的 Key
          </label>
        )}
        <div className="row">
          <button className="primary" onClick={save}>
            保存
          </button>
          <button onClick={test}>测试连接</button>
        </div>
        {testMsg && (
          <div className="notice">
            <Icon name={testOk === null ? 'clock' : testOk ? 'check-circle' : 'x-circle'} size={16} /> {testMsg}
          </div>
        )}
        {msg && <div className="notice">{msg}</div>}
      </div>
      <div className="card">
        <h3>资料根目录（读取本地文件）</h3>
        <p className="muted">
          填一个你放学习资料的文件夹。之后在科目里可以浏览这个文件夹、把 txt / md / 代码文件 / PDF 拆成知识点导入，或者选一份当本课资料。
          程序只读不写，而且只许读这个文件夹里面的东西。
        </p>
        <label>
          文件夹路径
          <input
            value={form.filesRoot}
            onChange={(e) => setForm({ ...form, filesRoot: e.target.value })}
            placeholder="比如 E:\\学习资料 或 /home/you/docs"
          />
        </label>
        <button className="primary" onClick={save}>
          保存
        </button>
      </div>
      <div className="card">
        <h3>朗读音色</h3>
        <p className="muted">
          讲解朗读优先用云端语音（微软 Edge 朗读同款音色，免费、不用 Key），合成过的段落会存下来、再读不重复合成；
          云端连不上时自动回退到设备自带语音。
        </p>
        <div className="model-picker" role="listbox" aria-label="朗读音色">
          {TTS_VOICES.map((v) => (
            <div key={v.id} className={'model-option voice-option' + (v.id === form.ttsVoice ? ' selected' : '')}>
              <button
                type="button"
                role="option"
                aria-selected={v.id === form.ttsVoice}
                className="voice-main"
                onClick={() => setForm({ ...form, ttsVoice: v.id })}
              >
                <span className="model-option-name">{v.label}</span>
                {v.id === form.ttsVoice && <Icon name="check" size={15} />}
              </button>
              <button
                type="button"
                className="small voice-preview-btn"
                onClick={() => playPreview(v.id)}
                title={previewVoice === v.id ? '停止试听' : `试听${v.label}`}
              >
                {previewVoice === v.id ? (
                  <>
                    <Icon name="square" size={12} filled /> 停止
                  </>
                ) : (
                  <>
                    <Icon name="volume-2" size={14} /> 试听
                  </>
                )}
              </button>
            </div>
          ))}
        </div>
        <p className="muted">试听只放一句样例听听音色，不会改变你已选的音色；选好后记得点「保存」。</p>
        {previewMsg && <div className="notice warn">{previewMsg}</div>}
        <button className="primary" onClick={save}>
          保存
        </button>
        {msg && <div className="notice">{msg}</div>}
      </div>
    </div>
  );
}

// ---------------- 科目页 ----------------
function SubjectView({ subjectId, onOpenSession, onBack, initialTab, openNoteId: openNoteIdProp }) {
  const [data, setData] = useState(null);
  const [docs, setDocs] = useState({ overview: null, terms: null, cheatsheet: null });
  const [notesCount, setNotesCount] = useState(0);
  const [tab, setTab] = useState(initialTab || 'lessons');
  // 从课堂/图谱「去知识库看」跳进来时，要自动打开的那份文档（entryId）
  const [openNoteId, setOpenNoteId] = useState(openNoteIdProp || '');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [d, dc, nt] = await Promise.all([
        api.get(`/api/subjects/${subjectId}`),
        api.get(`/api/subjects/${subjectId}/docs`).catch(() => ({ overview: null, terms: null, cheatsheet: null })),
        api.get(`/api/subjects/${subjectId}/notes`).catch(() => []),
      ]);
      setData(d);
      setDocs(dc);
      setNotesCount(nt.length);
    } catch (e) {
      setError(e.message);
    }
  }, [subjectId]);
  useEffect(() => {
    load();
  }, [load]);

  if (error) return <div className="notice warn">{error}</div>;
  if (!data) return <p className="muted">正在加载…</p>;
  const { subject, nodes, edges, sessions } = data;

  // 闪卡冲刺里「跳回对应步」：从最近的课堂往前找，哪个步包含这个知识点
  async function jumpToStep(nodeTitle) {
    for (const s of sessions) {
      if (s.kind !== 'lesson') continue;
      try {
        const d = await api.get(`/api/sessions/${s.id}`);
        if (!d.roadmap) continue;
        const idx = d.roadmap.steps.findIndex((st) => (st.nodeTitles || []).includes(nodeTitle));
        if (idx >= 0) {
          onOpenSession(s.id, idx);
          return true;
        }
      } catch {
        /* 找不到就继续往前一节课找 */
      }
    }
    return false;
  }

  return (
    <div>
      <div className="row-between">
        <button className="small" onClick={onBack}>
          <Icon name="arrow-left" size={15} /> 返回科目列表
        </button>
      </div>
      <h1>{subject.title}</h1>
      <p className="muted">
        目标：{subject.goal || '（未填）'}
        {subject.mode === 'crash' &&
          ` · 速成${subject.purpose ? `（用途：${subject.purpose}` : ''}${subject.time_budget ? `，可用时间：${subject.time_budget}` : ''}${subject.purpose ? '）' : ''}`}
      </p>
      {subject.mode === 'crash' && (
        <OverviewCard subjectId={subjectId} doc={docs.overview} reload={load} />
      )}
      <div className="tabs">
        {[
          ['lessons', '课堂'],
          ['graph', `知识图谱（${nodes.length}）`],
          ['cards', '闪卡'],
          ['review', '复习'],
          ['terms', '术语表'],
          ['cheat', '速查表'],
          ['notes', `知识库（${notesCount}）`],
          ['import', '导入知识点'],
        ].map(([k, label]) => (
          <button key={k} className={tab === k ? 'tab active' : 'tab'} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'lessons' && (
        <LessonsTab subjectId={subjectId} sessions={sessions} onOpenSession={onOpenSession} reload={load} />
      )}
      {tab === 'graph' && (
        <GraphTab
          nodes={nodes}
          edges={edges}
          subjectId={subjectId}
          onOpenNote={(entryId) => {
            setOpenNoteId(entryId);
            setTab('notes');
          }}
        />
      )}
      {tab === 'cards' && <CardsTab subjectId={subjectId} onJumpToStep={jumpToStep} />}
      {tab === 'review' && <ReviewTab subjectId={subjectId} onOpenSession={onOpenSession} />}
      {tab === 'terms' && <TermsTab subjectId={subjectId} doc={docs.terms} reload={load} />}
      {tab === 'cheat' && <CheatTab subjectId={subjectId} subjectTitle={subject.title} doc={docs.cheatsheet} reload={load} />}
      {tab === 'notes' && (
        <NotesTab
          subjectId={subjectId}
          subjectTitle={subject.title}
          sessions={sessions}
          onOpenSession={onOpenSession}
          openEntryId={openNoteId}
          onConsumeOpen={() => setOpenNoteId('')}
        />
      )}
      {tab === 'import' && <ImportTab subjectId={subjectId} reload={load} />}
    </div>
  );
}

const NOTE_STYLE_LABEL = { easy: '易懂版', pro: '专业简洁版' };
// 笔记风格选择（与课堂步笔记同一套口径：易懂版大白话带例子 / 专业简洁版只留干货），选一次记住。
function useNoteStyle() {
  const [style, setStyle] = useState(() => {
    try {
      return localStorage.getItem('lsw-note-style') === 'pro' ? 'pro' : 'easy';
    } catch {
      return 'easy';
    }
  });
  const change = (v) => {
    setStyle(v);
    try {
      localStorage.setItem('lsw-note-style', v);
    } catch {
      /* 存不了就算了 */
    }
  };
  return [style, change];
}
function NoteStyleToggle({ style, onChange }) {
  return (
    <span className="theme-switch" role="group" aria-label="生成风格">
      <button type="button" className={style === 'easy' ? 'ts-btn active' : 'ts-btn'} onClick={() => onChange('easy')}>
        易懂版
      </button>
      <button type="button" className={style === 'pro' ? 'ts-btn active' : 'ts-btn'} onClick={() => onChange('pro')}>
        专业简洁版
      </button>
    </span>
  );
}

// 速成科目的一页纸总览：科目页顶部常驻，先搭骨架再上课。
function OverviewCard({ subjectId, doc, reload }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(true);
  const [style, setStyle] = useNoteStyle();

  async function generate() {
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/subjects/${subjectId}/overview`, { style });
      reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card overview-card">
      <div className="row-between">
        <h3>
          <Icon name="sparkles" size={18} /> 一页纸总览（先搭骨架）
        </h3>
        <span className="row">
          {doc && doc.style && <span className="badge">{NOTE_STYLE_LABEL[doc.style] || doc.style}</span>}
          <NoteStyleToggle style={style} onChange={setStyle} />
          {doc && (
            <button className="small" onClick={() => setOpen(!open)}>
              {open ? '收起' : '展开'}
            </button>
          )}
          <button className="small" onClick={generate} disabled={busy}>
            {busy ? '正在生成…' : doc ? '重新生成' : '生成总览'}
          </button>
        </span>
      </div>
      {!doc && <p className="muted">速成先看全局：核心概念有哪些、彼此什么关系、最要紧的是哪 20%。生成后路线只走核心步。</p>}
      {error && <div className="notice warn">{error}</div>}
      {doc && open && <Markdown text={doc.content} />}
    </div>
  );
}

function TermsTab({ subjectId, doc, reload }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [style, setStyle] = useNoteStyle();
  async function generate() {
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/subjects/${subjectId}/terms`, { style });
      reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const terms = doc ? doc.terms || [] : [];
  return (
    <div>
      <div className="row">
        <button className="primary" onClick={generate} disabled={busy}>
          <Icon name="bookmark" size={15} /> {busy ? '正在整理术语…' : doc ? '重新生成术语表' : '生成术语表'}
        </button>
        <NoteStyleToggle style={style} onChange={setStyle} />
        {doc && doc.style && <span className="badge">当前：{NOTE_STYLE_LABEL[doc.style] || doc.style}</span>}
        <span className="muted">先把这科的生词扫掉：每个关键词一句解释，混个脸熟再上课。</span>
      </div>
      {error && <div className="notice warn">{error}</div>}
      {!doc && <p className="muted">还没有术语表，点上面的按钮生成一份。</p>}
      {terms.length > 0 && (
        <ul className="term-list">
          {terms.map((t, i) => (
            <li key={i} className="card term-item">
              <b>{t.term}</b>
              <span>{t.explain}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CheatTab({ subjectId, subjectTitle, doc, reload }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [style, setStyle] = useNoteStyle();
  const [errHint, setErrHint] = useState(''); // 本次生成是否结合了真实错因
  async function generate() {
    setBusy(true);
    setError('');
    setErrHint('');
    try {
      const r = await api.post(`/api/subjects/${subjectId}/cheatsheet`, { style });
      setErrHint(
        r.usedRealErrors
          ? '这次的易错点是按你在这科真实练习里的错因写的。'
          : '这科还没有真实练习错因，易错点先按通用情况写（正文里有标注）。'
      );
      reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function download() {
    if (!doc) return;
    const blob = new Blob([`# ${subjectTitle} · 速查表\n\n${doc.content}\n`], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${subjectTitle}-速查表.md`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div>
      <div className="row">
        <button className="primary" onClick={generate} disabled={busy}>
          <Icon name="file-text" size={15} /> {busy ? '正在整理速查表…' : doc ? '重新生成速查表' : '生成速查表'}
        </button>
        <NoteStyleToggle style={style} onChange={setStyle} />
        {doc && doc.style && <span className="badge">当前：{NOTE_STYLE_LABEL[doc.style] || doc.style}</span>}
        {doc && (
          <button onClick={download}>
            <Icon name="download" size={15} /> 下载 Markdown
          </button>
        )}
        <span className="muted">一页纸：核心概念 + 关系主线 + 易错点（有真实练习错因时优先按你的错因写），考前扫一眼。</span>
      </div>
      {errHint && <div className="notice friendly">{errHint}</div>}
      {error && <div className="notice warn">{error}</div>}
      {!doc && <p className="muted">还没有速查表，点上面的按钮生成一份（学过的内容越多，它总结得越准）。</p>}
      {doc && (
        <div className="card">
          <Markdown text={doc.content} />
        </div>
      )}
    </div>
  );
}

// 知识库只收三类文档：步笔记、知识点笔记、思维导图——都是老师在教学中应学生要求生成的。
// 总览/术语表/速查表在各自页签里，不进这个库。
const NOTE_KIND_LABEL = {
  step: '步笔记',
  node: '知识点笔记',
  mindmap: '思维导图',
};

// 把一段文本存成 .md 文件下载（笔记文档导出）。
function downloadMarkdownFile(title, text) {
  const name = `${String(title || '笔记').replace(/[\\/:*?"<>|]/g, ' ').trim() || '笔记'}.md`;
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
// 思维导图（树 JSON）转成 Markdown 大纲；老数据的 mermaid 文本没法转，就原样给出。
function mindmapToMarkdown(data) {
  try {
    const tree = typeof data === 'string' ? JSON.parse(data) : data;
    if (!tree || typeof tree !== 'object' || !tree.title) throw new Error('not a tree');
    const lines = [`# ${tree.title}`, ''];
    const walk = (node, depth) => {
      for (const child of node.children || []) {
        lines.push(`${'  '.repeat(depth)}- ${child.title}`);
        walk(child, depth + 1);
      }
    };
    walk(tree, 0);
    return lines.join('\n');
  } catch {
    return String(data || '');
  }
}

function NotesTab({ subjectId, subjectTitle, sessions, onOpenSession, openEntryId, onConsumeOpen }) {
  const [entries, setEntries] = useState([]);
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(null); // 打开看的条目详情 {entry, full}
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setEntries(await api.get(`/api/subjects/${subjectId}/notes`));
    } catch (e) {
      setError(e.message);
    }
  }, [subjectId]);
  useEffect(() => {
    load();
  }, [load]);

  // 从课堂/图谱点「去知识库看」跳进来：列表加载好后自动打开那份文档
  useEffect(() => {
    if (!openEntryId || !entries.length) return;
    const entry = entries.find((e) => e.entryId === openEntryId);
    if (entry) open(entry);
    if (onConsumeOpen) onConsumeOpen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openEntryId, entries]);

  // 某节课是这个科目的第几节课（只数正课，复习课不占号）
  function lessonNoOf(sessionId) {
    if (!sessionId || !Array.isArray(sessions)) return 0;
    const lessons = sessions.filter((s) => s.kind === 'lesson').map((s) => s.id).sort((a, b) => a - b);
    const idx = lessons.indexOf(sessionId);
    return idx >= 0 ? idx + 1 : 0;
  }

  async function open(entry) {
    setError('');
    try {
      let full = null;
      if (entry.entryId.startsWith('sm')) {
        full = await api.get(`/api/mindmaps/${entry.mindmapId}`);
      } else {
        full = await api.get(`/api/notes/${entry.noteId}`);
      }
      setSelected({ entry, full });
    } catch (e) {
      setError(e.message);
    }
  }
  async function remove(entry) {
    const label = NOTE_KIND_LABEL[entry.kind] || '条目';
    if (!confirm(`删掉这份${label}《${entry.title}》？删了就没了。`)) return;
    setError('');
    try {
      await api.del(`/api/notes/${entry.entryId}`);
      if (selected && selected.entry.entryId === entry.entryId) setSelected(null);
      load();
    } catch (e) {
      setError(e.message);
    }
  }
  async function genNoteMindmap() {
    if (!selected || !selected.full || !selected.full.id) return;
    setBusy('mindmap');
    setError('');
    try {
      const full = await api.post(`/api/notes/${selected.full.id}/mindmap`);
      setSelected({ entry: selected.entry, full });
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }
  async function genNodeMindmap() {
    if (!selected || !selected.entry.node_id) return;
    setBusy('mindmap');
    setError('');
    try {
      await api.post(`/api/nodes/${selected.entry.node_id}/mindmap`);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  if (selected) {
    const { entry, full } = selected;
    const kind = entry.kind;
    const isMindmapEntry = kind === 'mindmap';
    const mapContent = isMindmapEntry ? (entry.entryId.startsWith('nm') ? full.mindmap : full.content) : full.mindmap;
    // 知识点笔记的导图是库里独立的一行（kind=mindmap 且 node_id 相同）
    const linkedMap = kind === 'node' ? entries.find((e) => e.kind === 'mindmap' && e.node_id === entry.node_id) : null;
    const lessonNo = lessonNoOf(entry.session_id);
    function downloadDoc() {
      if (isMindmapEntry) {
        downloadMarkdownFile(entry.title, mindmapToMarkdown(mapContent));
      } else {
        downloadMarkdownFile(entry.title, `# ${entry.title}\n\n${full.content || ''}`);
      }
    }
    return (
      <div>
        <div className="row">
          <button className="small" onClick={() => setSelected(null)}>
            <Icon name="arrow-left" size={15} /> 返回知识库
          </button>
          {entry.session_id && kind === 'step' && (
            <button className="small" onClick={() => onOpenSession(entry.session_id, entry.step_index)}>
              回到课堂这一步
            </button>
          )}
          <button className="small" onClick={downloadDoc}>
            <Icon name="download" size={15} /> 下载 Markdown
          </button>
          <button className="danger small" onClick={() => remove(entry)}>
            删除这份{NOTE_KIND_LABEL[kind] || '文档'}
          </button>
        </div>
        <h3>
          <Icon name={isMindmapEntry ? 'network' : 'sticky-note'} size={18} /> {entry.title}
          <span className="badge">{NOTE_KIND_LABEL[kind] || kind}</span>
          {entry.style && <span className="badge">{NOTE_STYLE_LABEL[entry.style] || entry.style}</span>}
        </h3>
        <p className="muted">
          {subjectTitle && `科目《${subjectTitle}》 · `}
          {kind === 'step' && `${lessonNo ? `第 ${lessonNo} 节课 · ` : ''}第 ${entry.step_index + 1} 步「${entry.step_title}」 · `}
          {kind === 'node' && `知识点「${entry.node_title}」 · `}
          {isMindmapEntry && entry.step_title && `第 ${entry.step_index + 1} 步「${entry.step_title}」 · `}
          {isMindmapEntry && entry.node_title && `知识点「${entry.node_title}」 · `}
          生成于 {new Date(entry.created_at).toLocaleString()}
          {entry.updated_at !== entry.created_at && ` · 最近更新 ${new Date(entry.updated_at).toLocaleString()}`}
        </p>
        {error && <div className="notice warn">{error}</div>}
        {!isMindmapEntry && (
          <div className="card">
            <Markdown text={full.content} />
          </div>
        )}
        {(kind === 'step' || kind === 'node' || isMindmapEntry) && (
          <div className="card">
            <div className="row-between">
              <h3>
                <Icon name="network" size={18} /> 思维导图
              </h3>
              {!isMindmapEntry &&
                (kind === 'step' ? (
                  <button className="small" onClick={genNoteMindmap} disabled={busy === 'mindmap'}>
                    {busy === 'mindmap' ? '正在画图…' : full.mindmap ? '重新生成' : '生成思维导图'}
                  </button>
                ) : (
                  <button className="small" onClick={genNodeMindmap} disabled={busy === 'mindmap'}>
                    {busy === 'mindmap' ? '正在画图…' : linkedMap ? '重新生成' : '生成思维导图'}
                  </button>
                ))}
            </div>
            {isMindmapEntry || kind === 'step' ? (
              mapContent ? (
                <MindmapView data={mapContent} />
              ) : (
                <p className="muted">还没有思维导图：把这份内容画成一张图，中心是主题、分支是要点。</p>
              )
            ) : linkedMap ? (
              <p className="muted">
                这份知识点笔记有一张思维导图，在知识库列表里点「{entry.title} · 思维导图」那一条看（或回图谱页在知识点下面看）。
              </p>
            ) : (
              <p className="muted">还没有思维导图：点右上角生成一张，中心是这个知识点、分支是它的要点。</p>
            )}
          </div>
        )}
      </div>
    );
  }

  const kindsPresent = ['all', ...Object.keys(NOTE_KIND_LABEL).filter((k) => entries.some((e) => e.kind === k))];
  const shown = filter === 'all' ? entries : entries.filter((e) => e.kind === filter);
  return (
    <div>
      <p className="muted">
        这里只放老师在上课时按你的要求生成的文档：每一步的笔记、知识点的笔记和思维导图。你在课堂里点「生成笔记」或「思维导图」，老师就把那一步的讲解、你的预测和练习错因整理成一份文档存到这里。总览、术语表、速查表在各自的页签里，不放在这个库里。
      </p>
      {entries.length > 1 && (
        <div className="row lib-filters">
          {kindsPresent.map((k) => (
            <button key={k} className={filter === k ? 'tab active' : 'tab'} onClick={() => setFilter(k)}>
              {k === 'all' ? '全部' : NOTE_KIND_LABEL[k]}
            </button>
          ))}
        </div>
      )}
      {error && <div className="notice warn">{error}</div>}
      {entries.length === 0 && (
        <p className="muted">还没有文档。去课堂里学完一步，点「生成笔记」或「思维导图」，老师整理好的文档就会出现在这里。</p>
      )}
      {entries.length > 0 && shown.length === 0 && <p className="muted">这一类暂时还没有。</p>}
      <ul className="plain-list">
        {shown.map((e) => (
          <li key={e.entryId} className="card row-between">
            <span className="linklike" onClick={() => open(e)}>
              <Icon name={e.kind === 'mindmap' ? 'network' : 'sticky-note'} size={15} /> {e.title}
              <span className="badge">{NOTE_KIND_LABEL[e.kind] || e.kind}</span>
              {e.style && <span className="badge">{NOTE_STYLE_LABEL[e.style] || e.style}</span>}
              {e.kind === 'step' && e.has_mindmap ? <span className="badge">有思维导图</span> : null}
            </span>
            <span className="row">
              <span className="muted">
                {e.updated_at !== e.created_at
                  ? `${new Date(e.updated_at).toLocaleString()} 更新`
                  : `${new Date(e.created_at).toLocaleString()} 生成`}
              </span>
              <button className="danger small" onClick={() => remove(e)}>
                删除
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
function LessonsTab({ subjectId, sessions, onOpenSession, reload }) {
  const [materialPath, setMaterialPath] = useState('');
  const [showFiles, setShowFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function start() {
    setBusy(true);
    setError('');
    try {
      const s = await api.post(`/api/subjects/${subjectId}/sessions`, materialPath ? { materialPath } : {});
      onOpenSession(s.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(id) {
    if (!confirm('删掉这节课？这节课的复习记录也会一起清掉。')) return;
    await api.del(`/api/sessions/${id}`);
    reload();
  }

  return (
    <div>
      <div className="card">
        <h3>开一节新课</h3>
        <p className="muted">流程：先摸底 → 按你的情况排路线 → 逐步学（每步先预测再听讲解）→ 最后练习批改。</p>
        <div className="row">
          <button className="primary" onClick={start} disabled={busy}>
            {busy ? '正在出摸底题…' : '开始上课'}
          </button>
          <button onClick={() => setShowFiles(!showFiles)}>{showFiles ? '收起资料选择' : '选一份本课资料（可选）'}</button>
          {materialPath && <span className="badge">本课资料：{materialPath}</span>}
          {materialPath && (
            <button className="small" onClick={() => setMaterialPath('')}>
              不用了
            </button>
          )}
        </div>
        {showFiles && (
          <FilesBrowser
            onPickMaterial={(p) => {
              setMaterialPath(p);
              setShowFiles(false);
            }}
          />
        )}
        {error && <div className="notice warn">{error}</div>}
      </div>
      {sessions.length === 0 && <p className="muted">还没有上过课。</p>}
      <ul className="session-list">
        {sessions.map((s) => (
          <li key={s.id} className="card row-between">
            <span onClick={() => onOpenSession(s.id)} className="linklike">
              <Icon name={s.kind === 'review' ? 'calendar' : 'book-open'} size={15} /> {s.kind === 'review' ? '复习课' : '课堂'} #{s.id} · {PHASE_LABEL[s.phase] || s.phase} ·{' '}
              {new Date(s.created_at).toLocaleString()}
            </span>
            <button className="danger small" onClick={() => remove(s.id)}>
              删除
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function GraphTab({ nodes, edges, subjectId, onOpenNote }) {
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n.title]));
  const [entries, setEntries] = useState([]); // 知识库条目（找知识点笔记/导图用）
  const [picking, setPicking] = useState(0); // 正在给哪个知识点选笔记风格（nodeId）
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [savedEntry, setSavedEntry] = useState(''); // 刚存进知识库的那份文档的 entryId
  const [openNote, setOpenNote] = useState(null); // 展开看的知识点笔记全文
  const [openMap, setOpenMap] = useState({}); // nodeId -> 导图内容（展开看的）

  const loadEntries = useCallback(async () => {
    try {
      setEntries(await api.get(`/api/subjects/${subjectId}/notes`));
    } catch {
      /* 图谱本身不受影响 */
    }
  }, [subjectId]);
  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  const nodeNoteOf = (nodeId) => entries.find((e) => e.kind === 'node' && e.node_id === nodeId);
  const nodeMapOf = (nodeId) => entries.find((e) => e.kind === 'mindmap' && e.node_id === nodeId);

  async function genNodeNote(node, style) {
    setBusy(`note-${node.id}`);
    setMsg('');
    try {
      const r = await api.post(`/api/nodes/${node.id}/note`, { style });
      setPicking(0);
      if (r.note && r.note.id) setSavedEntry(`n${r.note.id}`);
      setMsg(
        r.created
          ? `「${node.title}」的笔记文档已生成（${NOTE_STYLE_LABEL[style]}），已存入知识库。`
          : r.appended
            ? `「${node.title}」的笔记文档已按${NOTE_STYLE_LABEL[style]}增补，知识库已更新。`
            : `「${node.title}」暂时没有新内容可补，笔记文档保持不变。`
      );
      loadEntries();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy('');
    }
  }
  async function genNodeMap(node) {
    setBusy(`map-${node.id}`);
    setMsg('');
    try {
      const r = await api.post(`/api/nodes/${node.id}/mindmap`);
      setOpenMap((m) => ({ ...m, [node.id]: r.content }));
      if (r.entryId) setSavedEntry(r.entryId);
      setMsg(`「${node.title}」的思维导图画好了，已存入知识库。`);
      loadEntries();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy('');
    }
  }
  async function viewNodeNote(entry) {
    setMsg('');
    try {
      setOpenNote(await api.get(`/api/notes/${entry.noteId}`));
    } catch (e) {
      setMsg(e.message);
    }
  }
  async function viewNodeMap(node) {
    if (openMap[node.id]) {
      setOpenMap((m) => ({ ...m, [node.id]: '' }));
      return;
    }
    const entry = nodeMapOf(node.id);
    if (!entry) return;
    try {
      const full = await api.get(`/api/notes/${entry.noteId}`);
      setOpenMap((m) => ({ ...m, [node.id]: full.content }));
    } catch (e) {
      setMsg(e.message);
    }
  }

  if (!nodes.length) return <p className="muted">图谱还是空的：上课或导入知识点后，知识点会沉淀到这里。</p>;
  return (
    <div>
      <h3>知识点</h3>
      <p className="muted">每个知识点都能单独让老师生成一份笔记文档（结合它在图谱里的位置和你的真实练习表现）和一张思维导图，都存进知识库。</p>
      {msg && (
        <div className="notice row">
          <span>{msg}</span>
          {savedEntry && onOpenNote && (
            <button className="small" onClick={() => onOpenNote(savedEntry)}>
              去知识库看 <Icon name="arrow-right" size={13} />
            </button>
          )}
        </div>
      )}
      <ul className="plain-list node-list">
        {nodes.map((n) => {
          const note = nodeNoteOf(n.id);
          const map = nodeMapOf(n.id);
          return (
            <li key={n.id} className="card node-row">
              <div className="row-between">
                <span className={`node-chip st-${n.status}`}>
                  {n.title} <em>{STATUS_LABEL[n.status]}</em>
                  {n.source === 'import' && <em className="src-import">导入</em>}
                </span>
                <span className="row">
                  {picking === n.id ? (
                    <>
                      <span className="muted">{note ? '增补什么风格？' : '笔记风格？'}</span>
                      <button className="small" disabled={busy !== ''} onClick={() => genNodeNote(n, 'easy')}>
                        {busy === `note-${n.id}` ? '整理中…' : '易懂版'}
                      </button>
                      <button className="small" disabled={busy !== ''} onClick={() => genNodeNote(n, 'pro')}>
                        {busy === `note-${n.id}` ? '整理中…' : '专业简洁版'}
                      </button>
                      <button className="small" disabled={busy !== ''} onClick={() => setPicking(0)}>
                        取消
                      </button>
                    </>
                  ) : (
                    <>
                      {note && (
                        <button className="small" onClick={() => (openNote && openNote.id === note.noteId ? setOpenNote(null) : viewNodeNote(note))}>
                          看笔记
                        </button>
                      )}
                      <button className="small" disabled={busy !== ''} onClick={() => setPicking(n.id)}>
                        <Icon name="sticky-note" size={14} /> {note ? '增补笔记' : '生成笔记'}
                      </button>
                      {map && (
                        <button className="small" onClick={() => viewNodeMap(n)}>
                          {openMap[n.id] ? '收起导图' : '看导图'}
                        </button>
                      )}
                      <button className="small" disabled={busy !== ''} onClick={() => genNodeMap(n)}>
                        <Icon name="network" size={14} /> {busy === `map-${n.id}` ? '正在画图…' : map ? '重画导图' : '思维导图'}
                      </button>
                    </>
                  )}
                </span>
              </div>
              {openNote && note && openNote.id === note.noteId && (
                <div className="node-note-body">
                  <Markdown text={openNote.content} />
                </div>
              )}
              {openMap[n.id] && (
                <div className="mindmap-card">
                  <MindmapView data={openMap[n.id]} onRegenerate={() => genNodeMap(n)} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <h3>推理关系</h3>
      {edges.length === 0 && <p className="muted">还没有推理关系。</p>}
      <ul className="edge-list">
        {edges.map((e) => (
          <li key={e.id}>
            <b>{byId[e.from_id]}</b> → <b>{byId[e.to_id]}</b>
            {e.reason && <span className="muted">：{e.reason}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CardsTab({ subjectId, onJumpToStep }) {
  const [cards, setCards] = useState([]);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  // 闪卡冲刺：纯本地自测状态，绝不调用复习接口、不写 FSRS、不改任何卡的到期时间
  const [sprint, setSprint] = useState(null); // {idx, marks: {cardId: true认识/false不认识}, done}

  const load = useCallback(async () => {
    setCards(await api.get(`/api/subjects/${subjectId}/cards`));
  }, [subjectId]);
  useEffect(() => {
    load();
  }, [load]);

  const dueCards = cards.filter((c) => new Date(c.due_at) <= new Date());
  const current = dueCards[Math.min(idx, Math.max(dueCards.length - 1, 0))];
  const orphans = cards.filter((c) => !c.node_id); // 没挂上知识点的脱钩卡

  async function repair() {
    setBusy(true);
    setMsg('');
    try {
      const r = await api.post(`/api/subjects/${subjectId}/cards/repair`);
      setMsg(
        r.total === 0
          ? '没有脱钩的闪卡。'
          : `修复完成：${r.repaired} 张重新挂回了知识点${r.remaining ? `，还有 ${r.remaining} 张实在对不上号（正反面里找不到知识点名），先留着` : ''}。`
      );
      load();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    setBusy(true);
    setMsg('');
    try {
      const r = await api.post(`/api/subjects/${subjectId}/cards/generate`);
      setMsg(`生成了 ${r.created} 张闪卡。`);
      setIdx(0);
      load();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function grade(g) {
    if (!current) return;
    await api.post(`/api/cards/${current.id}/review`, { grade: g });
    setFlipped(false);
    setIdx((i) => i + 1);
    load();
  }
  async function remove(id) {
    await api.del(`/api/cards/${id}`);
    load();
  }

  // ---------- 闪卡冲刺 ----------
  function startSprint() {
    setSprint({ idx: 0, marks: {}, done: cards.length === 0 });
    setFlipped(false);
  }
  function sprintMark(known) {
    const c = cards[sprint.idx];
    if (!c) return;
    const marks = { ...sprint.marks, [c.id]: known };
    const nextIdx = sprint.idx + 1;
    setSprint({ idx: nextIdx, marks, done: nextIdx >= cards.length });
    setFlipped(false);
  }
  async function jump(card) {
    if (!card.node_title) {
      alert('这张卡没有挂知识点，没法定位到步。');
      return;
    }
    const ok = onJumpToStep ? await onJumpToStep(card.node_title) : false;
    if (!ok) alert('这个知识点还没在课堂路线里出现过（可能是导入来的），先去上一节课就会带上它。');
  }

  if (sprint) {
    const cur = cards[sprint.idx];
    const knownCount = Object.values(sprint.marks).filter(Boolean).length;
    const unknownCards = cards.filter((c) => sprint.marks[c.id] === false);
    return (
      <div>
        <div className="row-between">
          <h3>
            <Icon name="zap" size={18} /> 闪卡冲刺
          </h3>
          <button className="small" onClick={() => setSprint(null)}>
            退出冲刺
          </button>
        </div>
        <p className="muted">把全科的卡快速过一遍，只刷不纠结。冲刺只是自测，不影响闪卡正常的复习安排。</p>
        {!sprint.done && cur ? (
          <div>
            <div className="muted">
              第 {sprint.idx + 1} / {cards.length} 张 · 已标认识 {knownCount} 张
            </div>
            <div className="big-progress">
              <div className="big-progress-fill" style={{ width: `${Math.round((sprint.idx / cards.length) * 100)}%` }} />
            </div>
            <div className="card flashcard" onClick={() => setFlipped(!flipped)}>
              <div className="muted">{cur.node_title || '闪卡'} · 点卡片翻面</div>
              <div className="flash-text">{flipped ? cur.back : cur.front}</div>
            </div>
            {flipped ? (
              <div className="row">
                <button className="grade again" onClick={() => sprintMark(false)}>
                  不认识
                </button>
                <button className="grade good" onClick={() => sprintMark(true)}>
                  认识
                </button>
              </div>
            ) : (
              <p className="muted">先想一下答案，再点卡片翻面对照，然后标「认识 / 不认识」。</p>
            )}
          </div>
        ) : (
          <div>
            <div className="notice friendly">
              冲刺完成：共 {cards.length} 张，认识 {knownCount} 张，不认识 {unknownCards.length} 张。
            </div>
            {unknownCards.length > 0 ? (
              <div>
                <h3>这些还是生的，回去补一补</h3>
                <ul className="plain-list">
                  {unknownCards.map((c) => (
                    <li key={c.id} className="row-between">
                      <span>
                        {c.front} <span className="muted">（{c.node_title || '未挂知识点'}）</span>
                      </span>
                      <button className="small" onClick={() => jump(c)}>
                        跳回对应步
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="muted">全都认识，状态很好。</p>
            )}
            <div className="row">
              <button className="primary" onClick={startSprint}>
                再冲一轮
              </button>
              <button onClick={() => setSprint(null)}>回闪卡列表</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="row">
        <button className="primary" onClick={generate} disabled={busy}>
          {busy ? '正在出卡…' : '从图谱生成闪卡'}
        </button>
        <button onClick={startSprint} disabled={cards.length === 0}>
          <Icon name="zap" size={15} /> 闪卡冲刺（全科 {cards.length} 张）
        </button>
        {orphans.length > 0 && (
          <button onClick={repair} disabled={busy}>
            <Icon name="refresh-cw" size={15} /> 修复未挂载闪卡（{orphans.length} 张）
          </button>
        )}
        <span className="muted">共 {cards.length} 张，到期 {dueCards.length} 张</span>
      </div>
      {msg && <div className="notice">{msg}</div>}
      {current ? (
        <div className="card flashcard" onClick={() => setFlipped(!flipped)}>
          <div className="muted">{current.node_title || '闪卡'} · 点卡片翻面</div>
          <div className="flash-text">{flipped ? current.back : current.front}</div>
          {flipped && (
            <div className="row" onClick={(e) => e.stopPropagation()}>
              <button className="grade again" onClick={() => grade('again')}>
                不会（10 分钟后再来）
              </button>
              <button className="grade hard" onClick={() => grade('hard')}>
                有点难
              </button>
              <button className="grade good" onClick={() => grade('good')}>
                记得
              </button>
              <button className="grade easy" onClick={() => grade('easy')}>
                太简单
              </button>
            </div>
          )}
        </div>
      ) : (
        <p className="muted">现在没有到期的闪卡，休息一下吧。</p>
      )}
      <h3>全部闪卡</h3>
      <ul className="plain-list">
        {cards.map((c) => (
          <li key={c.id} className="row-between">
            <span>
              {c.front} <span className="muted">（{c.node_title || '未挂知识点'} · {new Date(c.due_at).toLocaleString()} 到期）</span>
            </span>
            <button className="danger small" onClick={() => remove(c.id)}>
              删除
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReviewTab({ subjectId, onOpenSession }) {
  const [plan, setPlan] = useState([]);
  const [selected, setSelected] = useState({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const p = await api.get(`/api/subjects/${subjectId}/review-plan`);
    setPlan(p);
    const sel = {};
    p.forEach((x) => {
      if (x.hasEvents && x.due) sel[x.nodeId] = true;
    });
    setSelected(sel);
  }, [subjectId]);
  useEffect(() => {
    load();
  }, [load]);

  const dueCount = plan.filter((p) => p.hasEvents && p.due).length;
  async function start() {
    const nodeIds = Object.entries(selected)
      .filter(([, v]) => v)
      .map(([k]) => Number(k));
    if (!nodeIds.length) {
      setMsg('先勾选要复习的知识点。');
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const s = await api.post(`/api/subjects/${subjectId}/review-session`, { nodeIds });
      onOpenSession(s.id);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="muted">
        复习时间由你每次练习的真实判分推算（FSRS-6）：答得越稳，下次隔得越久。粗心或执行出错不算遗忘；很久没复习的知识点第一次答错会先标「待确认」，第二天再验一次才算数。
      </p>
      {dueCount > 0 && (
        <div className="notice friendly">
          <Icon name="leaf" size={16} /> {dueCount} 个知识点该复习了，回头复习一下记得更牢。不用有压力，挑几个先来就行。
        </div>
      )}
      <div className="row">
        <button className="primary" onClick={start} disabled={busy || dueCount === 0}>
          {busy ? '正在出复习题…' : `开始复习（${dueCount} 个到期）`}
        </button>
        {dueCount === 0 && <span className="muted">现在没有到期的知识点。</span>}
      </div>
      {msg && <div className="notice warn">{msg}</div>}
      <ul className="plain-list">
        {plan.map((p) => (
          <li key={p.nodeId} className="row-between">
            <label className="check grow">
              <input
                type="checkbox"
                disabled={!p.hasEvents}
                checked={Boolean(selected[p.nodeId])}
                onChange={(e) => setSelected({ ...selected, [p.nodeId]: e.target.checked })}
              />
              <span>
                {p.title}
                {p.pendingConfirm && <span className="badge hot">待确认</span>}
                {p.hasEvents && p.due && <span className="badge hot">已到期{p.overdueDays > 0 ? ` ${p.overdueDays} 天` : ''}</span>}
              </span>
            </label>
            <span className="muted">
              {!p.hasEvents
                ? '还没练过'
                : `能记约 ${p.intervalDays} 天 · ${new Date(p.dueAt).toLocaleDateString()} 到期 · 上次${{ full: '答全了', partial: '答到一部分', miss: '没答到' }[p.lastResult] || ''}`}
            </span>
          </li>
        ))}
        {plan.length === 0 && <li className="muted">图谱里还没有知识点。</li>}
      </ul>
    </div>
  );
}

function ImportTab({ subjectId, reload }) {
  const [text, setText] = useLocalState(`notes-${subjectId}`, '');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [fileInfo, setFileInfo] = useState(null);

  async function importText(source, content) {
    setBusy(true);
    setMsg('');
    try {
      const r = await api.post(`/api/subjects/${subjectId}/import-text`, { text: content, source });
      setMsg(
        `导入完成：拆出并新增 ${r.addedNodes} 个知识点、${r.addedEdges} 条推理关系（图谱现有 ${r.totalNodes} 个知识点）。这些知识点和上课学的完全一样，能上课、能出闪卡，图谱里会标上「导入」。`
      );
      reload();
      return true;
    } catch (e) {
      setMsg(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function onFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setMsg('');
    setFileInfo(null);
    try {
      const r = await api.uploadFile(file);
      setFileInfo({ name: file.name, ...r });
      if (r.warning) setMsg(r.warning);
    } catch (err) {
      setMsg(err.message);
    }
    e.target.value = '';
  }

  return (
    <div>
      <p className="muted">把现成的文章、资料给老师，老师会拆成一个个知识点并入这个科目的图谱和学习路线——之后就能像正常知识点一样上课学、生成闪卡。</p>
      <div className="card">
        <h3>粘贴文本导入知识点</h3>
        <SpeechTextarea value={text} onChange={setText} rows={8} placeholder="把文章、资料、笔记文字贴到这里（也可以语音口述），点导入后 AI 会拆成一个个知识点并入图谱。" />
        <button
          className="primary"
          disabled={busy || text.trim().length < 20}
          onClick={async () => {
            if (await importText('粘贴文本', text)) setText('');
          }}
        >
          {busy ? '正在拆知识点…' : '拆成知识点导入'}
        </button>
      </div>
      <div className="card">
        <h3>上传文件导入知识点</h3>
        <p className="muted">支持 PDF、txt、md 三种格式（PDF 不超过 25 MB，文本文件不超过 2 MB；其它格式会明确提示读不了）。PDF 只读文字层：扫描版（图片型）读不到文字，会明确提示。</p>
        <input type="file" accept=".pdf,.txt,.md,.markdown" onChange={onFile} />
        {fileInfo && (
          <div>
            <p className="muted">
              《{fileInfo.name}》{fileInfo.kind === 'pdf' ? ` · ${fileInfo.pages} 页` : ''} · 读到 {fileInfo.chars} 字
            </p>
            {!fileInfo.scanned && fileInfo.chars >= 20 && (
              <button
                className="primary"
                disabled={busy}
                onClick={async () => {
                  if (await importText(`上传文件 ${fileInfo.name}`, fileInfo.text)) setFileInfo(null);
                }}
              >
                {busy ? '正在拆知识点…' : '把这份文件拆成知识点导入'}
              </button>
            )}
          </div>
        )}
      </div>
      <div className="card">
        <h3>从本地资料文件夹导入知识点</h3>
        <p className="muted">读取「设置」里指定的资料根目录（只读）。点文件旁边的「导入知识点」即可；开课时也可以选一份当本课资料。</p>
        <FilesBrowser subjectId={subjectId} />
      </div>
      {msg && <div className="notice">{msg}</div>}
    </div>
  );
}

// ---------------- 课堂页 ----------------
// 两层结构（与空间版一致）：有关卡的正课先进「关卡页」（只有真实进度 + 全部关卡，不混讲解内容），
// 点当前关进该步的内容页（学完自动回关卡页），点已学完的关进只读回看，点未解锁的关原地给提示；
// 练习与课堂小结的入口挂在关卡页上（学完所有步后出现）。
// 摸底阶段、复习课没有关卡，走原来的单页内容形态。
// E 关卡路径：8 步一循环的横向偏移（px）
const PATH_OFFSETS = [0, 40, 80, 40, 0, -40, -80, -40];

// 关卡状态只有三种真实状态：done（已学完）/ current（当前步）/ locked（还没解锁）。
// 不再有「下一步画成蓝色播放键」的假解锁状态；进度一律按已学完步数算，不用阶段估算。
function stepStateOf(data, steps) {
  return (i) => {
    if (!steps.length) return 'locked';
    if (data.phase === 'done' || data.phase === 'quiz') return 'done';
    if (data.phase !== 'learning') return i === 0 ? 'current' : 'locked';
    if (i < data.step_index) return 'done';
    if (i === data.step_index) return 'current';
    return 'locked';
  };
}

function PathMap({ steps, stateOf, onStep }) {
  return (
    <div className="path-map" aria-label="学习路线关卡">
      {steps.map((s, i) => {
        const st = stateOf(i);
        const dx = PATH_OFFSETS[i % 8];
        return (
          <div className="path-row" key={i}>
            <button
              type="button"
              className={`path-node st-${st}`}
              style={{ transform: `translateX(${dx}px)` }}
              onClick={() => onStep(i, st)}
              aria-label={`第 ${i + 1} 关：${s.title}${st === 'done' ? '（已学完，点开回看）' : st === 'current' ? '（当前关，点开继续学）' : '（还没解锁）'}`}
            >
              {st === 'current' && <span className="path-bubble">开始</span>}
              <span className="path-icon">
                {st === 'done' ? (
                  <Icon name="star" size={27} filled />
                ) : st === 'current' ? (
                  <Icon name="play" size={25} filled />
                ) : (
                  <Icon name="lock" size={23} />
                )}
              </span>
            </button>
            <div className={`path-label st-${st}`} style={{ transform: `translateX(${dx}px)` }}>
              {s.title}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// F 语雀的课堂路线：编号步骤列表（竖排、细线连接、文档目录式）。
// 状态口径与 E 关卡路径完全一致（done/current/locked，由同一个 stateOf 给出），整行可点、行为与 E 相同，只是换语雀的呈现。
function StepList({ steps, stateOf, onStep }) {
  return (
    <div className="step-list-wrap">
      <div className="step-list-head">
        <span>学习路线</span>
        <span className="muted">共 {steps.length} 步</span>
      </div>
      <ol className="step-list">
        {steps.map((s, i) => {
          const st = stateOf(i);
          return (
            <li className={`step-row st-${st} clickable`} key={i} onClick={() => onStep(i, st)}>
              <span className="step-marker">
                {st === 'done' ? <Icon name="check" size={13} /> : String(i + 1).padStart(2, '0')}
              </span>
              <span className="step-title">{s.title}</span>
              {st === 'current' && <span className="step-tag">当前</span>}
              {st === 'done' && <span className="step-state muted">已完成 · 回看</span>}
              {st === 'locked' && (
                <span className="step-state muted">
                  <Icon name="lock" size={12} /> 未解锁
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function SessionView({ sessionId, onBack, theme, focusStep, onOpenNote }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 两层结构里的当前页：map 关卡页 / step 某一步的内容页 / quiz 练习页 / summary 课堂小结页
  const [page, setPage] = useState({ t: 'map' });
  const [lockHint, setLockHint] = useState('');
  const bottomRef = React.useRef(null);
  const focusAppliedRef = React.useRef(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/api/sessions/${sessionId}`));
    } catch (e) {
      setError(e.message);
    }
  }, [sessionId]);
  useEffect(() => {
    load();
  }, [load]);
  // 切步/换阶段/离开课堂时停掉正在读的讲解，别让上一段的声音残留
  useEffect(() => {
    stopSpeaking();
  }, [data && data.phase, data && data.step_index]);
  useEffect(() => () => stopSpeaking(), []);
  // 换一节课时回到关卡页
  useEffect(() => {
    setPage({ t: 'map' });
    setLockHint('');
    focusAppliedRef.current = false;
  }, [sessionId]);
  // 切页时回到顶部（关卡页和内容页都从头看）
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [page]);

  const steps0 = data && data.roadmap ? data.roadmap.steps : [];
  const hasLevels = Boolean(data) && data.kind === 'lesson' && steps0.length > 0 && data.phase !== 'probe';

  // 从知识库/冲刺跳回来时，直接打开那一步（已学完→回看，当前步→内容页；锁定步就留在关卡页）
  useEffect(() => {
    if (!data || focusAppliedRef.current) return;
    if (focusStep === undefined || focusStep === null) {
      focusAppliedRef.current = true;
      return;
    }
    if (!hasLevels) return;
    focusAppliedRef.current = true;
    const i = Math.min(Math.max(focusStep, 0), steps0.length - 1);
    if (stepStateOf(data, steps0)(i) !== 'locked') setPage({ t: 'step', i });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, focusStep, hasLevels]);

  // 没有关卡的课堂（摸底中、复习课）保持原来的单页形态：新消息来了滚到底
  useEffect(() => {
    if (data && !hasLevels && bottomRef.current) bottomRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [data, hasLevels]);

  if (error) return <div className="notice warn">{error}</div>;
  if (!data) return <p className="muted">正在加载…</p>;

  const messages = data.messages;
  const last = messages[messages.length - 1];
  const probeMsg = messages.find((m) => m.type === 'probe');
  const quizMsg = [...messages].reverse().find((m) => m.type === 'quiz');
  const gradingMsg = [...messages].reverse().find((m) => m.type === 'grading');
  const steps = steps0;
  const currentStepTaught = messages.some(
    (m) => m.type === 'teach' && m.meta && m.meta.stepIndex === data.step_index
  );
  const stateOf = stepStateOf(data, steps);
  const doneCount = steps.filter((_, i) => stateOf(i) === 'done').length;
  const progressPct = steps.length ? Math.round((doneCount / steps.length) * 100) : 0;

  // 把消息流按步切段：一段从该步的 predict_prompt 开始，到下一步的 predict_prompt 之前；
  // 旁问这类没有步号的消息，按出现位置归到当时的那一步。
  let segCursor = -1;
  const segOf = messages.map((m) => {
    if (m.type === 'predict_prompt' && m.meta && typeof m.meta.stepIndex === 'number') segCursor = m.meta.stepIndex;
    return segCursor;
  });
  const stepMessages = (i) => messages.filter((_, idx) => segOf[idx] === i);

  async function act(fn) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function goMap() {
    setLockHint('');
    setPage({ t: 'map' });
  }

  // 点关卡：已学完→回看、当前关→内容页、未解锁→原地给白话提示（先学完哪一步、这步要先有什么基础）
  function handleStep(i, st) {
    if (st === 'done' || st === 'current') {
      setLockHint('');
      setPage({ t: 'step', i });
      return;
    }
    const cur = data.step_index;
    const curStep = steps[cur];
    const target = steps[i];
    setLockHint(
      `第 ${i + 1} 步「${target.title}」还没解锁：先学完第 ${cur + 1} 步${curStep ? `「${curStep.title}」` : ''}。` +
        `这一步讲的是${target.summary ? `「${target.summary}」` : '后面的内容'}，是建立在前面几步之上的——前面的关学完，这一关自然就开了。`
    );
  }

  // 学完当前步：推进成功后回到关卡页（下一步在关卡页点进去；最后一步推进后关卡页会出现练习入口）
  async function finishStep() {
    let ok = false;
    await act(async () => {
      setData(await api.post(`/api/sessions/${sessionId}/next`, {}));
      ok = true;
    });
    if (ok) goMap();
  }

  // 渲染一串消息；teach 下面挂这一步的工具（笔记/思维导图）和理解自评（回看时只展示当时的自评，不给改）
  function renderMessages(list, readOnly) {
    return list.map((m) => {
      if (m.type === 'teach' && m.meta && typeof m.meta.stepIndex === 'number') {
        const si = m.meta.stepIndex;
        const mark = (data.stepMarks && data.stepMarks[si]) || '';
        const markLabel = (MARK_OPTIONS.find(([v]) => v === mark) || [])[1];
        return (
          <div key={m.id}>
            <Message m={m} quizMsg={quizMsg} />
            <StepTools
              sessionId={sessionId}
              stepIndex={si}
              hasNote={Boolean(data.stepNotes && data.stepNotes[si])}
              mindmap={(data.stepMindmaps && data.stepMindmaps[si]) || ''}
              onChanged={load}
              onOpenNote={onOpenNote}
            />
            {readOnly ? (
              mark ? (
                <div className="step-mark">
                  <span className="muted">当时你的自评：</span>
                  <span className="badge">{markLabel || mark}</span>
                </div>
              ) : null
            ) : (
              <StepMark sessionId={sessionId} stepIndex={si} mark={mark} onChanged={load} />
            )}
          </div>
        );
      }
      return <Message key={m.id} m={m} quizMsg={quizMsg} />;
    });
  }

  const headRow = (
    <div className="row-between sticky-head">
      <button className="small" onClick={onBack}>
        <Icon name="arrow-left" size={15} /> 返回科目
      </button>
      <span className="muted">
        <Icon name={data.kind === 'review' ? 'calendar' : 'book-open'} size={15} /> {data.kind === 'review' ? '复习课' : '课堂'} · {PHASE_LABEL[data.phase] || data.phase}
        {data.roadmap ? ` · 第 ${Math.min(data.step_index + 1, data.roadmap.steps.length)}/${data.roadmap.steps.length} 步` : ''}
        {data.material_name ? ` · 资料：${data.material_name}` : ''}
      </span>
    </div>
  );

  // 关卡页头部的进度区：E 是粗进度条 + 蜿蜒关卡路径；F 是细进度线 + 编号步骤列表。
  // 百分比只按已学完步数算（doneCount/总步数），两套皮肤同一口径。
  const progressBlock = steps.length > 0 && (
    theme === 'f' ? (
      <div>
        <div className="step-progress">
          <div className="kb-progress" role="progressbar" aria-valuenow={progressPct} aria-valuemin="0" aria-valuemax="100">
            <div className="kb-progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
          <span className="muted">
            已学完 {doneCount} / {steps.length} 步 · {progressPct}%
          </span>
        </div>
        <StepList steps={steps} stateOf={stateOf} onStep={handleStep} />
      </div>
    ) : (
      <div>
        <div className="session-progress-row">
          <div className="big-progress grow">
            <div className="big-progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
          <span className="muted">
            已学完 {doneCount} / {steps.length} 步 · {progressPct}%
          </span>
        </div>
        <PathMap steps={steps} stateOf={stateOf} onStep={handleStep} />
      </div>
    )
  );

  // ---------- 关卡页：只有进度 + 全部关卡（+ 学完所有步后的练习/小结入口），不混讲解内容 ----------
  if (hasLevels && page.t === 'map') {
    return (
      <div className="session-layout">
        <div className="session-main">
          {headRow}
          {error && <div className="notice warn">{error}</div>}
          {progressBlock}
          {lockHint && <div className="notice warn">{lockHint}</div>}
          {data.phase === 'quiz' && (
            <div className="card row-between">
              <span>
                <b>练习检验</b> <span className="muted">步子都学完了，来做几道换了新场景的题，看看是不是真会了。</span>
              </span>
              <button className="primary" onClick={() => setPage({ t: 'quiz' })}>
                进入练习 <Icon name="arrow-right" size={16} />
              </button>
            </div>
          )}
          {data.phase === 'done' && (
            <div className="card row-between">
              <span>
                <b>课堂小结</b> <span className="muted">这节课的练习批改结果都在小结里。</span>
              </span>
              <button className="primary" onClick={() => setPage({ t: 'summary' })}>
                查看课堂小结 <Icon name="arrow-right" size={16} />
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ---------- 关内页：只显示这一步的内容；已学完的步是只读回看 ----------
  if (hasLevels && page.t === 'step') {
    const i = Math.min(Math.max(page.i, 0), steps.length - 1);
    const readOnly = stateOf(i) === 'done';
    const isCurrent = data.phase === 'learning' && i === data.step_index;
    const list = stepMessages(i);
    const hasPrediction = list.some((m) => m.type === 'prediction');
    return (
      <div className="session-layout">
        <div className="session-main">
          <div className="row-between sticky-head">
            <button className="small" onClick={goMap}>
              <Icon name="arrow-left" size={15} /> 返回关卡
            </button>
            <span className="muted">
              第 {i + 1} 步 / 共 {steps.length} 步{readOnly ? ' · 回看' : ''}
            </span>
          </div>
          {error && <div className="notice warn">{error}</div>}
          <h3>
            第 {i + 1} 步 · {steps[i].title}
          </h3>
          <div className="transcript">{renderMessages(list, readOnly)}</div>
          {isCurrent && !currentStepTaught && !hasPrediction && (
            <PredictionForm
              sessionId={sessionId}
              stepIndex={i}
              busy={busy}
              onSubmit={(text) => act(async () => setData(await api.post(`/api/sessions/${sessionId}/predict`, { text })))}
            />
          )}
          {isCurrent && currentStepTaught && (
            <div className="card row">
              <button className="primary" disabled={busy} onClick={finishStep}>
                {busy ? (
                  '请稍等…'
                ) : i + 1 < steps.length ? (
                  <>
                    学完这一步，回到关卡 <Icon name="arrow-right" size={16} />
                  </>
                ) : (
                  <>
                    学完这一步，去做练习 <Icon name="arrow-right" size={16} />
                  </>
                )}
              </button>
            </div>
          )}
          {isCurrent && currentStepTaught && (
            <FeynmanBox
              sessionId={sessionId}
              stepIndex={i}
              stepTitle={steps[i] ? steps[i].title : ''}
              passed={Boolean(data.feynman && data.feynman[i] && data.feynman[i].passed)}
              busy={busy}
              onSubmit={(text) =>
                act(async () => setData(await api.post(`/api/sessions/${sessionId}/feynman`, { text, stepIndex: i })))
              }
            />
          )}
          {isCurrent && <AsideBox sessionId={sessionId} onDone={load} />}
        </div>
      </div>
    );
  }

  // ---------- 练习页：学完所有步后从关卡页进来，形态与原来的练习一致 ----------
  if (hasLevels && page.t === 'quiz') {
    const list = messages.filter((m) => ['quiz', 'quiz_answer', 'grading', 'aside_q', 'aside_a'].includes(m.type));
    return (
      <div className="session-layout">
        <div className="session-main">
          <div className="row-between sticky-head">
            <button className="small" onClick={goMap}>
              <Icon name="arrow-left" size={15} /> 返回关卡
            </button>
            <span className="muted">练习检验</span>
          </div>
          {error && <div className="notice warn">{error}</div>}
          <div className="transcript">{renderMessages(list, true)}</div>
          {data.phase === 'quiz' && quizMsg && (
            <QuizForm
              sessionId={sessionId}
              questions={quizMsg.meta.questions}
              busy={busy}
              onSubmit={(answers) =>
                act(async () => {
                  setData(await api.post(`/api/sessions/${sessionId}/quiz`, { answers }));
                  setPage({ t: 'summary' });
                })
              }
            />
          )}
          <AsideBox sessionId={sessionId} onDone={load} />
        </div>
      </div>
    );
  }

  // ---------- 课堂小结页：从关卡页进来，只看这节课的练习与批改 ----------
  if (hasLevels && page.t === 'summary') {
    const list = messages.filter((m) => ['quiz', 'quiz_answer', 'grading'].includes(m.type));
    return (
      <div className="session-layout">
        <div className="session-main">
          <div className="row-between sticky-head">
            <button className="small" onClick={goMap}>
              <Icon name="arrow-left" size={15} /> 返回关卡
            </button>
            <span className="muted">课堂小结</span>
          </div>
          {error && <div className="notice warn">{error}</div>}
          <div className="transcript">{renderMessages(list, true)}</div>
          {gradingMsg && (
            <div className="notice">这节课完成了。回科目页可以看图谱变化、生成闪卡，或等知识点到期后在「复习」页签里复习。</div>
          )}
        </div>
      </div>
    );
  }

  // ---------- 没有关卡的课堂（摸底中、复习课）：原来的单页形态 ----------
  return (
    <div className="session-layout">
      <div className="session-main">
      {headRow}
      {error && <div className="notice warn">{error}</div>}

      <div className="transcript">
        {renderMessages(messages, false)}
        <div ref={bottomRef} />
      </div>

      {data.phase === 'probe' && probeMsg && (
        <ProbeForm
          sessionId={sessionId}
          questions={probeMsg.meta.questions}
          busy={busy}
          onSubmit={(answers) => act(async () => setData(await api.post(`/api/sessions/${sessionId}/probe`, { answers })))}
        />
      )}
      {data.phase === 'quiz' && quizMsg && (
        <QuizForm
          sessionId={sessionId}
          questions={quizMsg.meta.questions}
          busy={busy}
          onSubmit={(answers) => act(async () => setData(await api.post(`/api/sessions/${sessionId}/quiz`, { answers })))}
        />
      )}
      {data.phase === 'done' && gradingMsg && (
        <div className="notice">这节课完成了。回科目页可以看图谱变化、生成闪卡，或等知识点到期后在「复习」页签里复习。</div>
      )}

      <AsideBox sessionId={sessionId} onDone={load} />
      </div>
    </div>
  );
}

// 每步讲解下方的工具行：生成笔记（主动点才生成，先选风格；同一步再点是按这次的风格追加增补）+ 思维导图。
// 生成的都是「文档」：存进这个科目的知识库，生成完明确告诉你存好了，并能一键跳过去看。
function StepTools({ sessionId, stepIndex, hasNote, mindmap, onChanged, onOpenNote }) {
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [picking, setPicking] = useState(false); // 正在选笔记风格
  const [savedEntry, setSavedEntry] = useState(''); // 刚存进知识库的那份文档的 entryId

  async function genNote(style) {
    setBusy('note');
    setMsg('');
    try {
      const r = await api.post(`/api/sessions/${sessionId}/steps/${stepIndex}/note`, { style });
      setPicking(false);
      if (r.note && r.note.id) setSavedEntry(`n${r.note.id}`);
      setMsg(
        r.created
          ? `老师把这一步整理成笔记文档了（${style === 'pro' ? '专业简洁版' : '易懂版'}），已存入知识库。`
          : r.appended
            ? `新内容已按${style === 'pro' ? '专业简洁版' : '易懂版'}追加到这一步的笔记文档后面，知识库已更新。`
            : '这次讲解没有新内容，笔记文档保持不变。'
      );
      onChanged();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy('');
    }
  }
  async function genMindmap() {
    setBusy('mindmap');
    setMsg('');
    try {
      const r = await api.post(`/api/sessions/${sessionId}/steps/${stepIndex}/mindmap`);
      if (r.mindmapId) setSavedEntry(`sm${r.mindmapId}`);
      setMsg('思维导图画好了，已存入知识库（下面也能直接看）。');
      onChanged();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy('');
    }
  }

  const savedLink = savedEntry && onOpenNote && (
    <button className="small" onClick={() => onOpenNote(savedEntry)}>
      去知识库看 <Icon name="arrow-right" size={13} />
    </button>
  );

  return (
    <div className="step-tools">
      {picking ? (
        <div className="row note-style-pick">
          <span className="muted">{hasNote ? '追加一段什么风格的？' : '这份笔记要什么风格？'}</span>
          <button className="small" onClick={() => genNote('easy')} disabled={busy !== ''}>
            {busy === 'note' ? '老师整理中…' : '易懂版（大白话 · 带例子）'}
          </button>
          <button className="small" onClick={() => genNote('pro')} disabled={busy !== ''}>
            {busy === 'note' ? '老师整理中…' : '专业简洁版（只留干货）'}
          </button>
          <button
            className="small"
            disabled={busy !== ''}
            onClick={() => {
              setPicking(false);
              setMsg('');
            }}
          >
            先不生成
          </button>
          {msg && <span className="muted">{msg}</span>}
          {savedLink}
        </div>
      ) : (
        <div className="row">
          <button className="small" onClick={() => setPicking(true)} disabled={busy !== ''}>
            <Icon name="sticky-note" size={14} /> {hasNote ? '追加笔记' : '生成笔记'}
          </button>
          <button className="small" onClick={genMindmap} disabled={busy !== ''}>
            <Icon name="network" size={14} /> {busy === 'mindmap' ? '正在画图…' : mindmap ? '重画思维导图' : '思维导图'}
          </button>
          {msg && <span className="muted">{msg}</span>}
          {savedLink}
        </div>
      )}
      {mindmap && (
        <div className="card mindmap-card">
          <MindmapView data={mindmap} onRegenerate={genMindmap} />
        </div>
      )}
    </div>
  );
}

// 理解自评：每步讲解后三档自评（自己能懂 / 靠讲解才懂 / 还是不懂）。
// 标「还是不懂」服务端会自动生成一段前置概念补讲存进消息流；另两档只记录不打扰。
const MARK_OPTIONS = [
  ['self', '自己能懂'],
  ['helped', '靠帮助才懂'],
  ['stuck', '还是不懂'],
];
function StepMark({ sessionId, stepIndex, mark, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  async function choose(mk) {
    if (busy || mk === mark) return;
    setBusy(true);
    setMsg('');
    try {
      const r = await api.post(`/api/sessions/${sessionId}/steps/${stepIndex}/mark`, { mark: mk });
      if (mk === 'stuck') {
        setMsg(r.reteach ? '老师给你补了一段前置概念，就在下面，慢慢看。' : '记下了。');
      }
      onChanged();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="step-mark">
      <span className="muted">这一步你懂到什么程度？</span>
      {MARK_OPTIONS.map(([v, label]) => (
        <button
          key={v}
          type="button"
          className={'small mark-btn' + (mark === v ? ` active mark-${v}` : '')}
          disabled={busy}
          onClick={() => choose(v)}
        >
          {mark === v && <Icon name="check" size={13} />} {label}
        </button>
      ))}
      {busy && <span className="muted">老师正在准备补讲…</span>}
      {msg && <span className="muted">{msg}</span>}
    </div>
  );
}

// 费曼检验：把这一步用自己的话讲给老师听，老师点评对/漏/错并追问；讲清了这一步会打上通过标记。
function FeynmanBox({ sessionId, stepIndex, stepTitle, busy, onSubmit, passed }) {
  const [text, setText] = useLocalState(`feynman-${sessionId}-${stepIndex}`, '');
  return (
    <div className="card feynman-box">
      <h3>
        <Icon name="message-circle" size={19} /> 讲给我听（检验是不是真懂了）
        {passed && (
          <span className="badge pass-badge">
            <Icon name="check-circle" size={14} /> 已通过 · 你讲清了
          </span>
        )}
      </h3>
      <p className="muted">
        用自己的话把「{stepTitle}」讲一遍，别照抄讲解。老师会指出你讲对的、漏掉的、糊弄过去的地方；
        {passed ? '这一步你已经讲清了，想再练一轮也可以。' : '没讲清会追问你，再答一轮；讲清了这一步就会标上「已通过」。不影响进度。'}
      </p>
      <SpeechTextarea value={text} onChange={setText} rows={3} placeholder="比如：这一步其实就是在说……（可以语音输入）" />
      <button
        className="primary"
        disabled={busy || !text.trim()}
        onClick={() => {
          onSubmit(text);
          setText('');
        }}
      >
        {busy ? '老师正在听…' : '讲完了，让老师听听'}
      </button>
    </div>
  );
}

function Message({ m, quizMsg }) {
  if (m.type === 'roadmap' && m.meta && m.meta.roadmap) {
    const steps = m.meta.roadmap.steps;
    return (
      <div className="msg assistant">
        <div className="msg-body">
          <p>{m.content}</p>
          <ol>
            {steps.map((s, i) => (
              <li key={i}>
                <b>{s.title}</b> <span className="muted">{s.summary}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    );
  }
  if (m.type === 'grading' && m.meta && m.meta.results) {
    const qById = Object.fromEntries(((quizMsg && quizMsg.meta.questions) || []).map((q) => [q.id, q.question]));
    return (
      <div className="msg assistant">
        <div className="msg-body">
          <p>{m.content}</p>
          {m.meta.results.map((r) => (
            <div key={r.id} className="grade-item">
              <div>
                <b>题{r.id}</b> <VerdictTag verdict={r.verdict} />
              </div>
              <div className="muted">{qById[r.id] || ''}</div>
              <Markdown text={r.feedback} />
              {(r.nodeResults || []).length > 0 && (
                <div className="muted">
                  {r.nodeResults.map((n, i) => (
                    <span key={i} className="badge">
                      {n.nodeTitle}：<VerdictTag verdict={n.result} size={13} />
                      {n.errorCause ? `（错因：${CAUSE_LABEL[n.errorCause] || n.errorCause}）` : ''}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }
  const isUser = m.role === 'user';
  return (
    <div className={`msg ${isUser ? 'user' : 'assistant'}`}>
      <div className="msg-body">
        {m.type === 'feynman' && (
          <div className="msg-tag">
            <Icon name="message-circle" size={13} /> 讲给我听 · 我的复述
          </div>
        )}
        {m.type === 'feynman_feedback' && (
          <div className="msg-tag">
            <Icon name="message-circle" size={13} /> 讲给我听 · 老师点评
            {m.meta && m.meta.passed && (
              <span className="badge pass-badge">
                <Icon name="check-circle" size={12} /> 讲清了 · 已通过
              </span>
            )}
          </div>
        )}
        {m.type === 'reteach' && (
          <div className="msg-tag">
            <Icon name="book-open" size={13} /> 补讲 · 前置概念（你标了「还是不懂」，先把地基补上）
          </div>
        )}
        {isUser ? <div className="pre-wrap">{m.content}</div> : <Markdown text={m.content} />}
        {/* 只有讲解（teach）带朗读按钮：练习、批改、旁问这次不加 */}
        {!isUser && m.type === 'teach' && <SpeakButton text={m.content} />}
      </div>
    </div>
  );
}

function ProbeForm({ sessionId, questions, busy, onSubmit }) {
  const [answers, setAnswers] = useLocalState(`probe-${sessionId}`, {});
  return (
    <div className="card">
      <h3>摸底题（知道多少答多少，答不上来就写"不知道"）</h3>
      {questions.map((q, i) => (
        <div key={i} className="qa-block">
          <div className="q-text">
            {i + 1}. {q}
          </div>
          <SpeechTextarea
            value={answers[i] || ''}
            onChange={(v) => setAnswers({ ...answers, [i]: v })}
            rows={2}
            placeholder="写下你的回答（可以语音输入）"
          />
        </div>
      ))}
      <button
        className="primary"
        disabled={busy}
        onClick={() => {
          onSubmit(questions.map((q, i) => ({ q, a: answers[i] || '' })));
          setAnswers({});
        }}
      >
        {busy ? '正在排学习路线…' : '答完了，排我的学习路线'}
      </button>
    </div>
  );
}

function PredictionForm({ sessionId, stepIndex, busy, onSubmit }) {
  const [text, setText] = useLocalState(`pred-${sessionId}-${stepIndex}`, '');
  return (
    <div className="card">
      <h3>先说说你的预测</h3>
      <SpeechTextarea value={text} onChange={setText} rows={3} placeholder="先猜一猜：这一步会讲什么？你觉得关键在哪？（可以语音输入）" />
      <button
        className="primary"
        disabled={busy}
        onClick={() => {
          onSubmit(text);
          setText('');
        }}
      >
        {busy ? '老师正在备课…' : '说完了，听讲解'}
      </button>
    </div>
  );
}

function QuizForm({ sessionId, questions, busy, onSubmit }) {
  const [answers, setAnswers] = useLocalState(`quiz-${sessionId}`, {});
  return (
    <div className="card">
      <h3>练习（认真做，批改会按要点逐题说清错在哪）</h3>
      {questions.map((q) => (
        <div key={q.id} className="qa-block">
          <div className="q-text">
            {q.id}. {q.question}
          </div>
          <SpeechTextarea
            value={answers[q.id] || ''}
            onChange={(v) => setAnswers({ ...answers, [q.id]: v })}
            rows={3}
            placeholder="写下你的答案（可以语音输入）"
          />
        </div>
      ))}
      <button
        className="primary"
        disabled={busy}
        onClick={() => {
          onSubmit(questions.map((q) => ({ id: q.id, answer: answers[q.id] || '' })));
          setAnswers({});
        }}
      >
        {busy ? '正在批改…' : '交卷批改'}
      </button>
    </div>
  );
}

function AsideBox({ sessionId, onDone }) {
  const [q, setQ] = useLocalState(`aside-${sessionId}`, '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function ask() {
    if (!q.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/sessions/${sessionId}/ask`, { question: q });
      setQ('');
      onDone();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card aside-box">
      <h3>
        <Icon name="help-circle" size={19} /> 旁问（不打断上课进度）
      </h3>
      <SpeechTextarea value={q} onChange={setQ} rows={2} placeholder="上课时有任何疑问，随时问（可以语音输入）" />
      <button onClick={ask} disabled={busy || !q.trim()}>
        {busy ? '老师想想…' : '问一下'}
      </button>
      {error && <div className="notice warn">{error}</div>}
    </div>
  );
}
