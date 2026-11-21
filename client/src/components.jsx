import React, { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Icon } from './icons.jsx';

// ---------- Markdown 渲染（长讲解用） ----------
// mermaid 按需懒加载（包不小，没图时不拖慢首屏）
let mermaidPromise = null;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default || m);
  }
  return mermaidPromise;
}

let mermaidSeq = 0;
// 把讲解里的 ```mermaid 代码块渲染成真正的图（SVG）；配色读当前皮肤的 CSS 变量，两套皮肤都清晰。
// 渲染失败就保留原始代码块降级显示，绝不崩页。
async function renderMermaidBlocks(root) {
  const codes = root.querySelectorAll('code.language-mermaid');
  if (!codes.length) return;
  let mermaid;
  try {
    mermaid = await loadMermaid();
  } catch {
    return; // 库没加载成功：保留代码块原样
  }
  try {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: {
        background: 'transparent',
        primaryColor: v('--accent-soft', '#d7ffb8'),
        primaryBorderColor: v('--accent', '#58cc02'),
        primaryTextColor: v('--ink-strong', '#3c3c3c'),
        secondaryColor: v('--side', '#f7f7f7'),
        tertiaryColor: v('--surface', '#ffffff'),
        lineColor: v('--accent-dark', '#46a302'),
        textColor: v('--ink', '#4b4b4b'),
      },
    });
  } catch {
    /* 初始化失败就走默认配色继续渲染 */
  }
  for (const code of codes) {
    const pre = code.closest('pre');
    if (!pre || pre.dataset.mermaidDone) continue;
    pre.dataset.mermaidDone = '1';
    try {
      const { svg } = await mermaid.render(`mmd-${Date.now()}-${mermaidSeq++}`, code.textContent || '');
      const fig = document.createElement('div');
      fig.className = 'mermaid-figure';
      fig.innerHTML = svg;
      pre.replaceWith(fig);
    } catch {
      delete pre.dataset.mermaidDone; // 失败降级：留着原始代码块
    }
  }
}

export function Markdown({ text }) {
  const ref = useRef(null);
  const html = DOMPurify.sanitize(marked.parse(String(text || '')));
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    // 先处理 mermaid 图块（渲染成图，不套代码框）
    renderMermaidBlocks(root);
    // 其余代码块上方补一条语言条（语雀风文档排版用，语言名取自 marked 给的 language-* 类）
    root.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('code.language-mermaid')) return; // 图块不套代码框
      if (pre.parentElement && pre.parentElement.classList.contains('code-wrap')) return;
      const code = pre.querySelector('code');
      const m = code && /language-([\w-]+)/.exec(code.className || '');
      const wrap = document.createElement('div');
      wrap.className = 'code-wrap';
      const bar = document.createElement('div');
      bar.className = 'code-bar';
      bar.textContent = m ? m[1] : 'code';
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(bar);
      wrap.appendChild(pre);
    });
  }, [html]);
  return <div className="md" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}

// ---------- 思维导图（自绘 SVG，不用 mermaid 的 mindmap 渲染） ----------
// 数据是一棵树 {title, children:[...]}：新数据存 JSON，老数据是 mermaid mindmap 文本，按缩进解析成树再画。
// 画法仿 XMind：中心主题是主色胶囊，一级分支各一种颜色、平滑贝塞尔曲线连接，子节点是圆角小块，分支左右均衡铺开。

// 从 mermaid mindmap 的一行里抠出节点文字：root((X)) / id(X) / id[X] / id{{X}} / 纯文本都认。
function mindmapLineTitle(raw) {
  let t = String(raw || '').trim();
  if (!t) return '';
  const m = /^[^\s([{]*\s*(?:\(\(\s*(.*?)\s*\)\)|\(\s*(.*?)\s*\)|\[\s*(.*?)\s*\]|\{\{\s*(.*?)\s*\}\})\s*$/.exec(t);
  if (m) t = m.slice(1).find((x) => x !== undefined) || '';
  return t.replace(/^["“”']+|["“”']+$/g, '').trim();
}

// 把 mermaid mindmap 文本按缩进层级解析成树；解析不出根节点就返回 null。
export function parseMermaidMindmap(text) {
  const items = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    if (/^\s*mindmap\s*$/i.test(rawLine)) continue;
    const indent = rawLine.replace(/\t/g, '  ').match(/^ */)[0].length;
    const title = mindmapLineTitle(rawLine);
    if (title) items.push({ indent, title });
  }
  if (!items.length) return null;
  const root = { title: items[0].title, children: [] };
  const stack = [{ indent: items[0].indent, node: root }];
  for (let i = 1; i < items.length; i++) {
    const node = { title: items[i].title, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].indent >= items[i].indent) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ indent: items[i].indent, node });
  }
  return capMindDepth(root, 0);
}

// 树太深画出来会挤成一团：超过 3 层（中心不算）的后代，摊平挂到第 3 层当叶子。
function capMindDepth(node, depth) {
  if (!node.children || !node.children.length) return { title: node.title };
  if (depth >= 3) {
    const leaves = [];
    const walk = (n) => {
      for (const c of n.children || []) {
        leaves.push({ title: c.title });
        walk(c);
      }
    };
    walk(node);
    return { title: node.title, children: leaves.slice(0, 8) };
  }
  return { title: node.title, children: node.children.map((c) => capMindDepth(c, depth + 1)) };
}

function normalizeMindTree(node, depth) {
  if (!node || typeof node !== 'object') return null;
  const title = String(node.title || '').trim();
  if (!title) return null;
  const out = { title };
  if (depth < 3 && Array.isArray(node.children)) {
    const kids = node.children.map((c) => normalizeMindTree(c, depth + 1)).filter(Boolean);
    if (kids.length) out.children = kids;
  }
  return out;
}

// 入口：对象 / JSON 字符串 / mermaid 文本都能吃，统一出树；认不出来返回 null。
export function parseMindmapData(data) {
  if (!data) return null;
  if (typeof data === 'object') return normalizeMindTree(data, 0);
  const s = String(data).trim();
  if (!s) return null;
  if (s.startsWith('{')) {
    try {
      return normalizeMindTree(JSON.parse(s), 0);
    } catch {
      return null;
    }
  }
  return parseMermaidMindmap(s);
}

// 文字度量（canvas）：按字号量真实宽度，决定节点盒子大小与折行。
let measureCtx = null;
function textW(t, font) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = font;
  return measureCtx.measureText(t).width;
}
function wrapTitle(title, font, maxW) {
  const chars = [...String(title)];
  const lines = [];
  let cur = '';
  for (const ch of chars) {
    if (cur && textW(cur + ch, font) > maxW) {
      lines.push(cur);
      cur = ch;
      if (lines.length === 2) break;
    } else {
      cur += ch;
    }
  }
  if (lines.length < 2 && cur) lines.push(cur);
  if (lines.length === 2) {
    const used = lines.join('').length;
    if (used < chars.length) {
      let l2 = lines[1];
      while (l2 && textW(l2 + '…', font) > maxW) l2 = l2.slice(0, -1);
      lines[1] = l2 + '…';
    }
  }
  return lines.length ? lines : [''];
}

const MIND_FONT = {
  0: '700 15px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
  1: '700 13.5px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
  2: '13px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
};
const MIND_METRIC = {
  0: { padX: 20, padY: 9, lineH: 21, maxTextW: 190 },
  1: { padX: 14, padY: 7, lineH: 19, maxTextW: 140 },
  2: { padX: 11, padY: 6, lineH: 18, maxTextW: 132 },
};
const MIND_GAP_Y = 10;
const MIND_GAP_X = 46;
const MIND_FALLBACK_COLORS = ['#58cc02', '#1cb0f6', '#ce82ff', '#ff9600', '#14c8d8', '#ff7eb0'];

function readMindPalette() {
  try {
    const cs = getComputedStyle(document.documentElement);
    const colors = [];
    for (let i = 1; i <= 6; i++) {
      const v = cs.getPropertyValue(`--mm-c${i}`).trim();
      if (v) colors.push(v);
    }
    if (colors.length >= 3) return colors;
  } catch {
    /* 读不到变量就用默认色板 */
  }
  return MIND_FALLBACK_COLORS;
}

// 布局：算每个节点的盒子尺寸与子树高度，再把根的分支按高度贪心分到左右两侧。
function layoutMindTree(root) {
  function build(node, depth) {
    const met = MIND_METRIC[Math.min(depth, 2)];
    const font = MIND_FONT[Math.min(depth, 2)];
    const lines = wrapTitle(node.title, font, met.maxTextW);
    const w = Math.max(...lines.map((l) => textW(l, font))) + met.padX * 2;
    const h = lines.length * met.lineH + met.padY * 2;
    const kids = (node.children || []).map((c) => build(c, depth + 1));
    const kidsH = kids.length ? kids.reduce((a, k) => a + k.subH, 0) + MIND_GAP_Y * (kids.length - 1) : 0;
    return { title: node.title, lines, depth, w, h, kids, subH: Math.max(h, kidsH), x: 0, y: 0, colorIdx: 0 };
  }
  const rootL = build(root, 0);
  // 每层列宽：同一深度的节点按最宽的对齐成列，左右共用，曲线不打架
  const levelW = [];
  (function walk(n) {
    levelW[n.depth] = Math.max(levelW[n.depth] || 0, n.w);
    n.kids.forEach(walk);
  })(rootL);
  const maxDepth = levelW.length - 1;
  const sideW = (depth) => {
    let s = 0;
    for (let d = 1; d <= depth; d++) s += (levelW[d] || 0) + MIND_GAP_X;
    return s;
  };
  // 根分支分左右：交替往矮的一侧放，相对顺序不变
  const left = [];
  const right = [];
  let lh = 0;
  let rh = 0;
  rootL.kids.forEach((k, i) => {
    k.colorIdx = i;
    if (lh <= rh) {
      left.push(k);
      lh += k.subH + MIND_GAP_Y;
    } else {
      right.push(k);
      rh += k.subH + MIND_GAP_Y;
    }
  });
  const stackH = (arr) => (arr.length ? arr.reduce((a, k) => a + k.subH, 0) + MIND_GAP_Y * (arr.length - 1) : 0);
  const totalH = Math.max(rootL.h, stackH(left), stackH(right)) + 24;
  const oneSideW = sideW(maxDepth);
  const totalW = oneSideW * 2 + rootL.w + 32;
  const rootX = 16 + oneSideW;
  const rootY = totalH / 2 - rootL.h / 2;
  rootL.x = rootX;
  rootL.y = rootY;

  // 每列的水平位置预先算好：右侧第 d 列的左缘、左侧第 d 列的右缘（节点在列内靠父一侧对齐）
  const colLeftR = [0];
  const colRightL = [0];
  for (let d = 1; d <= maxDepth; d++) {
    colLeftR[d] = (d === 1 ? rootX + rootL.w : colLeftR[d - 1] + levelW[d - 1]) + MIND_GAP_X;
    colRightL[d] = (d === 1 ? rootX : colRightL[d - 1] - levelW[d - 1]) - MIND_GAP_X;
  }
  // 递归放置：子节点块在父节点的子树区间内垂直居中
  function placeSubtree(node, dir) {
    if (!node.kids.length) return;
    const kidsH = stackH(node.kids);
    let top = node.y + node.h / 2 - kidsH / 2;
    for (const k of node.kids) {
      k.colorIdx = node.colorIdx;
      k.y = top + k.subH / 2 - k.h / 2;
      k.x = dir > 0 ? colLeftR[k.depth] : colRightL[k.depth] - k.w;
      placeSubtree(k, dir);
      top += k.subH + MIND_GAP_Y;
    }
  }
  function placeFirstLevel(kids, dir) {
    let top = rootY + rootL.h / 2 - stackH(kids) / 2;
    for (const k of kids) {
      k.y = top + k.subH / 2 - k.h / 2;
      k.x = dir > 0 ? colLeftR[1] : colRightL[1] - k.w;
      placeSubtree(k, dir);
      top += k.subH + MIND_GAP_Y;
    }
  }
  placeFirstLevel(right, 1);
  placeFirstLevel(left, -1);

  // 收集连线与节点（带颜色）
  const links = [];
  const nodes = [];
  (function collect(n) {
    nodes.push(n);
    for (const k of n.kids) {
      links.push({ from: n, to: k });
      collect(k);
    }
  })(rootL);
  return { nodes, links, totalW, totalH };
}

export function MindmapView({ data, onRegenerate }) {
  const tree = parseMindmapData(data);
  if (!tree) {
    return (
      <div className="notice warn">
        这张思维导图是旧格式，这次没能解析出来。
        {onRegenerate && (
          <button type="button" className="small" style={{ marginLeft: 8 }} onClick={onRegenerate}>
            重新生成一张
          </button>
        )}
      </div>
    );
  }
  const palette = readMindPalette();
  const { nodes, links, totalW, totalH } = layoutMindTree(tree);
  const colorOf = (n) => palette[(n.colorIdx || 0) % palette.length];
  return (
    <div className="mindmap-scroll">
      <svg className="mindmap-svg" width={totalW} height={totalH} viewBox={`0 0 ${totalW} ${totalH}`} role="img" aria-label={`思维导图：${tree.title}`}>
        {links.map((l, i) => {
          const dir = l.to.x >= l.from.x ? 1 : -1;
          const x1 = dir > 0 ? l.from.x + l.from.w : l.from.x;
          const y1 = l.from.y + l.from.h / 2;
          const x2 = dir > 0 ? l.to.x : l.to.x + l.to.w;
          const y2 = l.to.y + l.to.h / 2;
          const mx = (x1 + x2) / 2;
          return (
            <path
              key={i}
              d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
              fill="none"
              stroke={colorOf(l.to)}
              strokeWidth={l.to.depth === 1 ? 3.5 : 2.2}
              strokeLinecap="round"
              opacity={l.to.depth === 1 ? 0.9 : 0.65}
            />
          );
        })}
        {nodes.map((n, i) => {
          const isRoot = n.depth === 0;
          const isBranch = n.depth === 1;
          const fill = isRoot ? 'var(--accent)' : isBranch ? colorOf(n) : 'var(--surface)';
          const stroke = isRoot ? 'var(--accent-dark)' : colorOf(n);
          const textFill = isRoot || isBranch ? '#ffffff' : 'var(--ink-strong)';
          const met = MIND_METRIC[Math.min(n.depth, 2)];
          return (
            <g key={i}>
              <rect
                x={n.x}
                y={n.y}
                width={n.w}
                height={n.h}
                rx={isRoot ? n.h / 2 : 10}
                fill={fill}
                stroke={stroke}
                strokeWidth={isRoot ? 0 : isBranch ? 0 : 1.6}
                opacity={isBranch ? 0.92 : 1}
              />
              {n.lines.map((line, li) => (
                <text
                  key={li}
                  x={n.x + n.w / 2}
                  y={n.y + met.padY + met.lineH * (li + 0.78)}
                  textAnchor="middle"
                  fontSize={n.depth === 0 ? 15 : n.depth === 1 ? 13.5 : 13}
                  fontWeight={n.depth <= 1 ? 700 : 400}
                  fill={textFill}
                >
                  {line}
                </text>
              ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---------- 本地草稿状态：刷新/切走再回来不丢 ----------
export function useLocalState(key, initial) {
  const storageKey = `draft:${key}`;
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw !== null ? JSON.parse(raw) : initial;
    } catch {
      return initial;
    }
  });
  const set = (v) => {
    setValue(v);
    try {
      if (v === '' || v === null || v === undefined || (typeof v === 'object' && Object.keys(v).length === 0)) {
        localStorage.removeItem(storageKey);
      } else {
        localStorage.setItem(storageKey, JSON.stringify(v));
      }
    } catch {
      /* localStorage 不可用就算了 */
    }
  };
  return [value, set];
}

// ---------- 带语音听写的文本框 ----------
// 用浏览器 Web Speech API（Chrome 的 webkitSpeechRecognition，lang=zh-CN）。
// 不支持的浏览器点麦克风会给出白话提示。
export function SpeechTextarea({ value, onChange, rows = 3, placeholder = '' }) {
  const [listening, setListening] = useState(false);
  const [tip, setTip] = useState('');
  const recRef = useRef(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => () => {
    if (recRef.current) {
      try {
        recRef.current.stop();
      } catch {
        /* ignore */
      }
    }
  }, []);

  function toggleMic() {
    if (listening) {
      recRef.current && recRef.current.stop();
      setListening(false);
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setTip('这个浏览器不支持语音听写，请用 Chrome 打开，或者先打字输入。');
      return;
    }
    setTip('');
    const rec = new SR();
    rec.lang = 'zh-CN';
    rec.interimResults = true;
    rec.continuous = false;
    const base = valueRef.current ? valueRef.current + (valueRef.current.endsWith('\n') ? '' : ' ') : '';
    rec.onresult = (e) => {
      let transcript = '';
      for (let i = 0; i < e.results.length; i++) transcript += e.results[i][0].transcript;
      onChange(base + transcript);
    };
    rec.onerror = (e) => {
      setListening(false);
      if (e.error === 'not-allowed') setTip('麦克风被拒绝了：请在浏览器地址栏旁边允许麦克风权限，再点一次。');
      else if (e.error === 'no-speech') setTip('没听到声音，再点麦克风说一次试试。');
      else setTip(`听写没成功（${e.error}），可以先打字输入。`);
    };
    rec.onend = () => setListening(false);
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      setTip('听写启动失败，可以先打字输入。');
    }
  }

  return (
    <div className="speech-box">
      <textarea
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="speech-row">
        <button type="button" className={listening ? 'mic-btn listening' : 'mic-btn'} onClick={toggleMic}>
          <Icon name="mic" size={16} /> {listening ? '正在听…点一下停' : '语音输入'}
        </button>
        {tip && <span className="tip">{tip}</span>}
      </div>
    </div>
  );
}

// ---------- 讲解朗读（优先云端 edge-tts 合成音频，任一段失败回退设备自带语音，zh-CN） ----------
// 全局只允许一段在读：ttsStop 登记当前朗读的收尾回调，任何新朗读/切步/离开课堂先调 stopSpeaking()。
let ttsStop = null;

export function stopSpeaking() {
  try {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  } catch {
    /* ignore */
  }
  if (ttsStop) {
    const f = ttsStop;
    ttsStop = null;
    f();
  }
}

// Markdown 讲解转纯文本：去掉语法标记，只留能念出口的话（代码内容保留、符号去掉）。
function toPlainText(md) {
  let t = String(md || '');
  // mermaid 图块不念代码，只提示一句（图的内容看原文）
  t = t.replace(/```\s*mermaid[^\n]*\n[\s\S]*?```/g, '\n图示见原文。\n');
  t = t.replace(/```[a-zA-Z0-9_-]*\n?/g, '');
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  t = t.replace(/<[^>]+>/g, '');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/^\s*>\s?/gm, '');
  t = t.replace(/^\s*[-*+]\s+/gm, '');
  t = t.replace(/^\s*\d+[.、)]\s+/gm, '');
  t = t.replace(/(\*\*|__)([\s\S]*?)\1/g, '$2');
  t = t.replace(/~~([\s\S]*?)~~/g, '$1');
  t = t.replace(/(\*|_)([\s\S]*?)\1/g, '$2');
  t = t.replace(/`([^`]+)`/g, '$1');
  t = t.replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, '');
  t = t.replace(/\|/g, '，');
  t = t.replace(/[ \t]+/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

// 按句断成小段排队读：整段太长时个别浏览器会中途卡住，分段更稳。
function chunkText(text, max = 160) {
  const chunks = [];
  let buf = '';
  const push = () => {
    const s = buf.trim();
    if (s) chunks.push(s);
    buf = '';
  };
  for (const part of String(text).split(/(?<=[。！？；…\n])/)) {
    if ((buf + part).length > max && buf) push();
    buf += part;
    if (buf.length >= max) push();
  }
  push();
  return chunks;
}

// 取设置里选的朗读音色（每次开读现取，改完设置立刻生效）
async function fetchTtsVoice() {
  try {
    const s = await api.get('/api/settings');
    return s.ttsVoice || 'zh-CN-XiaoxiaoNeural';
  } catch {
    return 'zh-CN-XiaoxiaoNeural';
  }
}

// 设备自带语音读一段（云端失败时的回退）：读完、出错都 resolve，被 stopSpeaking 取消时也会收尾
function speakWithDevice(chunk) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
      resolve();
      return;
    }
    const synth = window.speechSynthesis;
    let voice = null;
    try {
      const vs = synth.getVoices();
      voice = vs.find((v) => /^zh/i.test(v.lang) && v.localService) || vs.find((v) => /^zh/i.test(v.lang)) || null;
    } catch {
      voice = null; // 没有中文语音就走系统默认语音，照常读
    }
    const u = new SpeechSynthesisUtterance(chunk);
    u.lang = 'zh-CN';
    if (voice) {
      try {
        u.voice = voice;
      } catch {
        /* 个别环境给的语音对象塞不进去就不塞，用默认语音照常读 */
      }
    }
    u.onend = () => resolve();
    u.onerror = () => resolve();
    try {
      synth.speak(u);
    } catch {
      resolve();
    }
  });
}

export function SpeakButton({ text }) {
  const [speaking, setSpeaking] = useState(false);
  const aliveRef = useRef(true);
  const myStopRef = useRef(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      // 组件卸载（离开课堂/消息被替换）时若自己在读，停掉，别留着出声
      if (myStopRef.current) stopSpeaking();
    };
  }, []);

  if (typeof window === 'undefined') return null;

  async function start() {
    stopSpeaking(); // 先停掉别处正在读的，别叠着读
    const chunks = chunkText(toPlainText(text));
    if (!chunks.length) return;
    const voice = await fetchTtsVoice();

    let finished = false;
    let resolveStop = () => {};
    const stopPromise = new Promise((r) => {
      resolveStop = r;
    });
    let controller = null; // 正在进行的云端合成请求，可中断
    let audio = null; // 正在播放的云端音频
    let audioUrl = null;
    const releaseAudio = () => {
      if (audio) {
        try {
          audio.pause();
        } catch {
          /* ignore */
        }
        audio = null;
      }
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
        audioUrl = null;
      }
    };
    const done = () => {
      if (finished) return;
      finished = true;
      if (controller) {
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
        controller = null;
      }
      releaseAudio();
      resolveStop();
      if (myStopRef.current === done) myStopRef.current = null;
      if (ttsStop === done) ttsStop = null;
      if (aliveRef.current) setSpeaking(false);
    };
    myStopRef.current = done;
    ttsStop = done;
    setSpeaking(true);

    // 云端读一段：向 /api/tts 合成 mp3 再顺序播放；任何一步失败就抛错，外层回退设备语音
    const speakWithCloud = async (chunk) => {
      controller = new AbortController();
      const resp = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: chunk, voice }),
        signal: controller.signal,
      });
      controller = null;
      if (!resp.ok) throw new Error(`tts ${resp.status}`);
      const blob = await resp.blob();
      if (finished) return;
      audioUrl = URL.createObjectURL(blob);
      audio = new Audio(audioUrl);
      await new Promise((resolve, reject) => {
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error('音频播放失败'));
        audio.play().then(
          () => {},
          () => reject(new Error('音频播放失败'))
        );
      });
    };

    for (const chunk of chunks) {
      if (finished) break;
      let played = false;
      try {
        await Promise.race([speakWithCloud(chunk), stopPromise]);
        played = true;
      } catch {
        played = false; // 云端这段没读成（或正被叫停），下面按情况回退
      }
      releaseAudio();
      if (finished) break;
      if (!played) {
        // 回退设备语音读这一段：不弹错、不中断整篇
        await Promise.race([speakWithDevice(chunk), stopPromise]);
      }
    }
    done();
  }

  return (
    <div className="speak-row">
      {speaking ? (
        <button type="button" className="small speak-btn speaking" onClick={stopSpeaking}>
          <Icon name="square" size={13} filled /> 停止朗读
        </button>
      ) : (
        <button type="button" className="small speak-btn" onClick={start}>
          <Icon name="volume-2" size={15} /> 朗读讲解
        </button>
      )}
    </div>
  );
}

// ---------- 本地资料文件浏览器（只读） ----------
import { api } from './api.js';

export function FilesBrowser({ subjectId, onPickMaterial }) {
  const [path, setPath] = useState('');
  const [listing, setListing] = useState(null);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState('');

  async function load(p) {
    setError('');
    try {
      const data = await api.get(`/api/files/list?path=${encodeURIComponent(p)}`);
      setListing(data);
      setPath(p);
    } catch (e) {
      setError(e.message);
      setListing(null);
    }
  }
  useEffect(() => {
    load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function join(name) {
    return path ? `${path}/${name}` : name;
  }
  function parent() {
    const parts = path.split('/').filter(Boolean);
    parts.pop();
    return parts.join('/');
  }
  async function read(name) {
    setBusy(name);
    setPreview(null);
    try {
      const data = await api.get(`/api/files/read?path=${encodeURIComponent(join(name))}`);
      setPreview({ name, ...data });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }
  async function importToGraph(name) {
    if (!subjectId) return;
    setBusy(name);
    try {
      const r = await api.post('/api/files/import', { subjectId, path: join(name) });
      alert(`导入完成：拆出并新增 ${r.addedNodes} 个知识点、${r.addedEdges} 条关系，已并入图谱。`);
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy('');
    }
  }

  if (error && !listing) {
    return <div className="notice warn">{error}</div>;
  }
  if (!listing) return <div className="muted">正在读取资料目录…</div>;
  return (
    <div className="files-browser">
      <div className="files-head">
        <span className="muted">当前目录：{path || '（根目录）'}</span>
        {path && (
          <button type="button" className="small" onClick={() => load(parent())}>
            <Icon name="arrow-up" size={14} /> 返回上一级
          </button>
        )}
      </div>
      {error && <div className="notice warn">{error}</div>}
      <ul className="files-list">
        {listing.entries.map((e) => (
          <li key={e.name}>
            <span className="file-name">
              <Icon name={e.type === 'dir' ? 'folder' : 'file-text'} size={15} /> {e.name}
            </span>
            {e.type === 'dir' ? (
              <button type="button" className="small" onClick={() => load(join(e.name))}>
                打开
              </button>
            ) : e.readable ? (
              <span className="file-actions">
                <button type="button" className="small" disabled={busy === e.name} onClick={() => read(e.name)}>
                  预览
                </button>
                {subjectId && (
                  <button type="button" className="small" disabled={busy === e.name} onClick={() => importToGraph(e.name)}>
                    导入知识点
                  </button>
                )}
                {onPickMaterial && (
                  <button type="button" className="small" onClick={() => onPickMaterial(join(e.name))}>
                    作为本课资料
                  </button>
                )}
              </span>
            ) : (
              <span className="muted">（读不了这种文件）</span>
            )}
          </li>
        ))}
        {listing.entries.length === 0 && <li className="muted">这个文件夹是空的。</li>}
      </ul>
      {preview && (
        <div className="file-preview">
          <div className="muted">
            《{preview.name}》{preview.pages ? ` · ${preview.pages} 页` : ''} · 共 {preview.chars} 字
          </div>
          {preview.warning && <div className="notice warn">{preview.warning}</div>}
          <pre>{preview.text.slice(0, 3000)}{preview.text.length > 3000 ? '\n…（预览只显示前 3000 字）' : ''}</pre>
        </div>
      )}
    </div>
  );
}
