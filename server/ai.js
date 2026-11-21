// AI 流程：所有生成都走 llm.js（用户自配的模型）。
// 口径与 Muse「多学堂」一致：摸底→路线图→先预测后讲解→按要点批改；图谱只记知识点与推理链。
const { chat, chatJSON } = require('./llm');

const TEACHER = '你是一位耐心的中文老师，讲课用简体中文，先说人话再说术语，必须用术语时当场用一句白话解释。';

function subjectCtx(subject) {
  let s = `科目：${subject.title}\n学习目标：${subject.goal || '（未填）'}`;
  if (subject.mode === 'crash') {
    s += `\n学习模式：速成（用途：${subject.purpose || '（未填）'}；可用时间：${subject.time_budget || '（未填）'}）`;
  }
  return s;
}

async function probeQuestions(subject) {
  const out = await chatJSON(
    TEACHER,
    `${subjectCtx(subject)}\n\n请出 3~5 道摸底题，探清学生对这个科目的现有基础（从最基础到略有深度）。\n输出格式：{"questions":["问题1","问题2",...]}`
  );
  const qs = Array.isArray(out.questions) ? out.questions.map(String).filter(Boolean) : [];
  if (!qs.length) throw new Error('摸底题生成失败，请重试。');
  return qs;
}

async function buildRoadmap(subject, qaPairs) {
  const qa = qaPairs.map((p, i) => `问${i + 1}：${p.q}\n答${i + 1}：${p.a || '（没答）'}`).join('\n');
  const crash = subject.mode === 'crash';
  const rule = crash
    ? '这是速成模式：学生时间紧、目标明确。请只保留最核心的 3~5 步，砍掉枝节和锦上添花的内容，每步的 summary 里点明这一步对他的用途有什么用。'
    : '请按学生现有基础生成一条学习路线：4~7 步，每步是一个小主题；';
  const out = await chatJSON(
    TEACHER,
    `${subjectCtx(subject)}\n\n这是摸底问答：\n${qa}\n\n${rule}同时给出这条路线涉及的知识点清单和知识点之间的推理关系（谁是谁的前提、谁推出谁）。\n知识点标题要原样、简短、稳定，不要改写。\n输出格式：{"steps":[{"title":"步标题","summary":"这一步学什么（一句白话）","nodeTitles":["知识点标题"]}],"nodes":["知识点标题"],"edges":[{"from":"知识点标题","to":"知识点标题","reason":"为什么有这条推理关系（一句）"}]}`
  );
  if (!out || !Array.isArray(out.steps) || !out.steps.length) throw new Error('路线图生成失败，请重试。');
  return {
    steps: out.steps.map((s) => ({
      title: String(s.title || '一步'),
      summary: String(s.summary || ''),
      nodeTitles: Array.isArray(s.nodeTitles) ? s.nodeTitles.map(String) : [],
    })),
    nodes: Array.isArray(out.nodes) ? out.nodes.map(String) : [],
    edges: Array.isArray(out.edges)
      ? out.edges.map((e) => ({ from: String(e.from || ''), to: String(e.to || ''), reason: String(e.reason || '') }))
      : [],
  };
}

async function teachStep(subject, step, stepNo, totalSteps, prediction, material, otherSubjects) {
  const mat = material ? `\n\n本课资料（讲解请优先参照这份资料的内容和说法）：\n${material.slice(0, 8000)}` : '';
  const others = Array.isArray(otherSubjects) ? otherSubjects.filter(Boolean) : [];
  const analogy = others.length
    ? `\n跨科目类比：这个学生还学过或正在学这些科目：${others.join('、')}。讲解中如果某个概念用其中某个科目的概念打比方会明显更好懂，就自然地用一下；不贴切就不要硬套，不要为了类比而类比。`
    : '';
  const text = await chat(
    [
      { role: 'system', content: TEACHER },
      {
        role: 'user',
        content: `${subjectCtx(subject)}\n\n现在讲第 ${stepNo}/${totalSteps} 步：${step.title}（${step.summary}）。\n学生刚才先做了预测，他的预测是：「${prediction || '（没写预测）'}」。\n请先点评他的预测对在哪、偏差在哪，再正式讲解这一步：讲清概念、给一个小例子、指出常见误区。Markdown 格式，控制在 600 字以内。\n关于配图，记住一条铁规矩：不许只提图不给图——不要写「如下图」「看下图」「见图」「如图所示」这类话却不配图。如果这一步涉及流程、结构或对比关系、确实需要图示，就在你提到图的那句话紧下面给出一个 \`\`\`mermaid 代码块把图画出来（只用 flowchart 这类简单稳妥的语法，节点文字简短，不要用特殊符号、括号嵌套和冷门语法），正文可以照常说「如下图」。不需要图的时候就不要提图。${analogy}${mat}`,
      },
    ],
    { temperature: 0.7 }
  );
  return text;
}

async function buildQuiz(subject, steps, nodeTitles) {
  const outline = steps.map((s, i) => `${i + 1}. ${s.title}：${s.summary}`).join('\n');
  const out = await chatJSON(
    TEACHER,
    `${subjectCtx(subject)}\n\n这节课学完了以下内容：\n${outline}\n\n请出 4~6 道练习题检验掌握情况，题目要换新场景、不要和讲解里的例子雷同。每题给出评分要点（points）和它考的知识点（nodeTitles，必须从这个清单里原样选：${nodeTitles.join('、') || '（无）'}）。\n输出格式：{"questions":[{"question":"题目","points":["要点1","要点2"],"nodeTitles":["知识点标题"]}]}`
  );
  const qs = Array.isArray(out.questions) ? out.questions : [];
  if (!qs.length) throw new Error('练习题生成失败，请重试。');
  return {
    questions: qs.map((q, i) => ({
      id: i + 1,
      question: String(q.question || ''),
      points: Array.isArray(q.points) ? q.points.map(String) : [],
      nodeTitles: Array.isArray(q.nodeTitles) ? q.nodeTitles.map(String) : [],
    })),
  };
}

async function buildReviewQuiz(subject, nodes) {
  const list = nodes.map((n) => n.title).join('、');
  const out = await chatJSON(
    TEACHER,
    `${subjectCtx(subject)}\n\n这是复习课，只考这些到期的知识点：${list}。\n请为每个知识点出 1 道题，必须换全新的场景和例子，不许和以前学过的例子雷同。每题给出评分要点和它考的知识点（nodeTitles 原样回抄知识点标题）。\n输出格式：{"questions":[{"question":"题目","points":["要点1"],"nodeTitles":["知识点标题"]}]}`
  );
  const qs = Array.isArray(out.questions) ? out.questions : [];
  if (!qs.length) throw new Error('复习题生成失败，请重试。');
  return {
    questions: qs.map((q, i) => ({
      id: i + 1,
      question: String(q.question || ''),
      points: Array.isArray(q.points) ? q.points.map(String) : [],
      nodeTitles: Array.isArray(q.nodeTitles) ? q.nodeTitles.map(String) : [],
    })),
  };
}

async function gradeQuiz(subject, quiz, answers) {
  const items = quiz.questions
    .map((q) => {
      const a = answers.find((x) => x.id === q.id);
      return `题${q.id}：${q.question}\n评分要点：${q.points.join('；') || '（无）'}\n考的知识点：${q.nodeTitles.join('、') || '（无）'}\n学生答案：${(a && a.answer) || '（没答）'}`;
    })
    .join('\n\n');
  const out = await chatJSON(
    TEACHER,
    `${subjectCtx(subject)}\n\n请逐题按评分要点批改下面的练习。判定只用三档：full（要点基本答全）、partial（答到一部分）、miss（没答到或答错）。\n每题还要给出它考的每个知识点的掌握结论（result 同样三档）和错因：答错时从 careless（粗心）、execution（思路对但执行/计算/表达出错）、concept（概念没懂）、memory（记混记错）、other 里选一个；答对时 errorCause 留空字符串。\nfeedback 用白话写清：错在哪、正确的应该是什么样。\n输出格式：{"results":[{"id":1,"verdict":"full|partial|miss","feedback":"批改说明","nodeResults":[{"nodeTitle":"知识点标题","result":"full|partial|miss","errorCause":""}]}]}`
  );
  const results = Array.isArray(out.results) ? out.results : [];
  if (!results.length) throw new Error('批改失败，请重试。');
  return results.map((r) => ({
    id: Number(r.id),
    verdict: ['full', 'partial', 'miss'].includes(r.verdict) ? r.verdict : 'miss',
    feedback: String(r.feedback || ''),
    nodeResults: (Array.isArray(r.nodeResults) ? r.nodeResults : []).map((n) => ({
      nodeTitle: String(n.nodeTitle || ''),
      result: ['full', 'partial', 'miss'].includes(n.result) ? n.result : 'miss',
      errorCause: ['careless', 'execution', 'concept', 'memory', 'other'].includes(n.errorCause)
        ? n.errorCause
        : '',
    })),
  }));
}

async function asideAnswer(subject, sessionSummary, question, material) {
  const mat = material ? `\n\n本课资料（优先参照）：\n${material.slice(0, 6000)}` : '';
  return chat(
    [
      { role: 'system', content: TEACHER },
      {
        role: 'user',
        content: `${subjectCtx(subject)}\n学生正在上课（进度：${sessionSummary}），中途插问一个问题。请直接回答，不要改变课程进度，不要出题。Markdown 格式，300 字以内。${mat}\n\n学生的问题：${question}`,
      },
    ],
    { temperature: 0.7 }
  );
}

async function extractGraph(subject, text, sourceLabel) {
  const out = await chatJSON(
    TEACHER,
    `${subjectCtx(subject)}\n\n下面是一份学习资料（来源：${sourceLabel}），学生想把它拆成一个个知识点来学。请把资料拆成一个个能单独拿出来学习的知识点（一个知识点 = 一个能独立讲清、独立出题检验的小主题，不要把一大段内容塞进一个知识点，也不要拆成词语碎片），并给出知识点之间的推理关系（前提→结论、组成、因果等），合并进这个科目的知识图谱。\n知识点标题要简短、稳定、像目录条目；只拆资料里真实出现的内容，不要编造。\n输出格式：{"nodes":["知识点标题"],"edges":[{"from":"知识点标题","to":"知识点标题","reason":"关系理由（一句）"}]}\n\n资料全文：\n${String(text).slice(0, 16000)}`
  );
  return {
    nodes: Array.isArray(out.nodes) ? out.nodes.map(String) : [],
    edges: Array.isArray(out.edges)
      ? out.edges.map((e) => ({ from: String(e.from || ''), to: String(e.to || ''), reason: String(e.reason || '') }))
      : [],
  };
}

async function generateCards(subject, nodeTitles) {
  const out = await chatJSON(
    TEACHER,
    `${subjectCtx(subject)}\n\n请为这些知识点各生成 1 张闪卡：正面是一个具体问题，背面是简明答案（可含一个小例子）。\nnodeTitle 必须把知识点标题原样回抄，一个字都不要改。\n知识点：${nodeTitles.join('、')}\n输出格式：{"cards":[{"nodeTitle":"知识点标题","front":"问题","back":"答案"}]}`
  );
  const cards = Array.isArray(out.cards) ? out.cards : [];
  if (!cards.length) throw new Error('闪卡生成失败，请重试。');
  return cards.map((c) => ({
    nodeTitle: String(c.nodeTitle || ''),
    front: String(c.front || ''),
    back: String(c.back || ''),
  }));
}

// ---------- 快速学习套件 ----------

// 三件套（总览/术语表/速查表）与笔记共用同一套风格口径：easy 易懂 / pro 专业简洁。
const DOC_STYLE_RULES = {
  easy: '风格是「易懂版」：大白话为主，关键处带一个生活化的小例子或比方，讲细一点；必须用术语时当场用一句白话解释。',
  pro: '风格是「专业简洁版」：术语准确、结论先行、只留干货，能压缩成短条目就不要写整句，不解释基础概念、不打比方、不说客套话。',
};
function docStyleRule(style) {
  return style === 'pro' ? DOC_STYLE_RULES.pro : DOC_STYLE_RULES.easy;
}

// 速成模式的「一页纸总览」：先搭骨架——核心概念、彼此关系、最要紧的 20%。
async function buildOverview(subject, style) {
  return chat(
    [
      { role: 'system', content: TEACHER },
      {
        role: 'user',
        content: `${subjectCtx(subject)}\n\n学生要用速成的方式学这门科目，时间很紧。请给他一页纸总览，先把骨架搭起来。Markdown 格式，800 字以内，结构固定为三节：\n## 核心概念\n列出 8~12 个最核心的概念，每个一行：**概念名**——一句人话解释。\n## 它们之间的关系\n用几句话讲清主线：先有什么、再有什么、谁依赖谁，像一张地图的文字版。\n## 最要紧的 20%\n从核心概念里挑出 2~3 个「核心中的核心」，逐个说明为什么它最要紧、学它的时候要抓什么。\n${docStyleRule(style)}`,
      },
    ],
    { temperature: 0.7 }
  );
}

// 术语先行：这科的关键词清单，每个一句人话解释。
async function generateTerms(subject, style) {
  const explainRule =
    style === 'pro'
      ? '每个配一句专业简洁的解释（术语准确、只给定义和关键区别，不打比方）'
      : '每个配一句人话解释（不懂这行的人也能看懂，必要时打个小比方）';
  const out = await chatJSON(
    TEACHER,
    `${subjectCtx(subject)}\n\n请列出这门科目最要紧的 10~20 个关键词（术语），${explainRule}。按重要程度从高到低排。\n输出格式：{"terms":[{"term":"术语","explain":"一句解释"}]}`
  );
  const terms = Array.isArray(out.terms) ? out.terms : [];
  if (!terms.length) throw new Error('术语表生成失败，请重试。');
  return terms
    .map((t) => ({ term: String(t.term || '').trim(), explain: String(t.explain || '').trim() }))
    .filter((t) => t.term);
}

// 速查表：一页纸总结（核心概念、关系、易错点），给考前/用前快速扫一眼。
// errorInfo: {hasData, text} —— 有真实练习错因就优先按真实错因写易错点；没有就按通用易错点并在正文里如实标注。
async function generateCheatsheet(subject, nodeTitles, stepsOutline, style, errorInfo) {
  const nodes = nodeTitles && nodeTitles.length ? `\n已沉淀的知识点：${nodeTitles.join('、')}` : '';
  const steps = stepsOutline ? `\n学过的路线：\n${stepsOutline}` : '';
  const errRule =
    errorInfo && errorInfo.hasData
      ? `\n## 易错点清单 这一节必须优先根据这个学生真实的练习错因来写（点名他实际栽过的跟头、涉及的知识点，写清错在哪、正确的是什么），真实错因不够 4 条时再补通用易错点凑到 4~8 条：\n${errorInfo.text}`
      : '\n## 易错点清单 这一节：这个学生还没有真实练习错因数据，按这门科目公认最容易搞错的地方写 4~8 条，并且必须在这一节的第一行写明：（暂无你的真实练习错因数据，以下是通用易错点）';
  return chat(
    [
      { role: 'system', content: TEACHER },
      {
        role: 'user',
        content: `${subjectCtx(subject)}${nodes}${steps}\n\n请生成一份「速查表」：一页纸能看完的总结，用在考试或实战前快速扫一眼。Markdown 格式，700 字以内，结构固定为三节：\n## 核心概念速查\n每个核心概念一行：**概念名**——最关键的一句话（定义/公式/结论）。\n## 关系与主线\n用简短的条目讲清概念之间怎么串起来（谁推出谁、流程顺序）。\n## 易错点清单\n列 4~8 条，每条一句：错在哪、正确的是什么。${errRule}\n${docStyleRule(style)}`,
      },
    ],
    { temperature: 0.7 }
  );
}

// 费曼检验：学生用自己的话讲一遍，老师点评对/漏/错并追问，并判定这一轮有没有「讲清」。
// 返回 {feedback, passed}：passed=true 表示这一步已讲清（界面上打通过标记）；没讲清就继续追问下一轮。不卡进度。
async function feynmanReview(subject, step, rounds, userText) {
  const hist = (rounds || [])
    .map((r, i) => `第 ${i + 1} 轮学生讲的：「${r.user}」\n老师当时的反馈摘要：${String(r.feedback || '').slice(0, 300)}`)
    .join('\n');
  const raw = await chat(
    [
      { role: 'system', content: TEACHER },
      {
        role: 'user',
        content: `${subjectCtx(subject)}\n\n现在是「讲给我听」环节：学生在用自己的话复述这一步「${step.title}」（${step.summary}），检验他是不是真懂了。${hist ? `\n之前的轮次：\n${hist}\n` : ''}\n学生这次讲的：「${userText}」\n\n请点评，Markdown 格式，300 字以内，结构：\n1. **讲对了什么**：具体点名他讲对的要点（别空夸）。\n2. **漏了什么**：这一步的关键点里他没提到的。\n3. **哪里讲错或糊弄过去了**：说得含糊、跳过推理、概念混淆的地方，直接点破并给正确说法；如果没有就说没有。\n4. 如果他这一轮已经把这一步的核心讲清楚了（关键要点基本都对、没有糊弄过去的地方），就肯定他讲清了，不要再追问；如果还没讲清，最后抛出**一个追问**，专挑他最含糊的地方问，让他再答一轮。\n5. 点评全部写完后，另起一行只输出状态标记（不要解释、不要加任何其他字）：讲清了就输出 @@STATE:passed@@，还没讲清就输出 @@STATE:continue@@。`,
      },
    ],
    { temperature: 0.7 }
  );
  let text = String(raw || '');
  let passed = false;
  const m = text.match(/@@STATE:(passed|continue)@@/);
  if (m) {
    passed = m[1] === 'passed';
    text = text.replace(/@@STATE:(passed|continue)@@/g, '').trim();
  }
  return { feedback: text, passed };
}

// 理解自评「还是不懂」时的补讲：找出这一步依赖的前置概念，先把地基补上，再接回这一步。
async function reteachStep(subject, step, stepNo, teachText) {
  return chat(
    [
      { role: 'system', content: TEACHER },
      {
        role: 'user',
        content: `${subjectCtx(subject)}\n\n学生刚学完第 ${stepNo} 步「${step.title}」（${step.summary}），他自评「还是不懂」。这一步的讲解是：\n${String(teachText).slice(0, 5000)}\n\n他大概率是卡在这一步依赖的某个前置概念上（地基没打好，后面的自然听不懂）。请给他一段补讲，Markdown 格式，500 字以内：\n1. 先点明：这一步默认你已经懂的是哪 1~2 个前置概念，他可能就是卡在这里。\n2. 把前置概念用大白话讲清，每个带一个小例子或比方，必须用术语时当场解释。\n3. 最后用几句话把前置概念和这一步接上：有了这个地基，这一步的哪个说法就顺理成章了。\n不要把原讲解整段重复一遍，不要出题，不要责备学生，语气耐心。`,
      },
    ],
    { temperature: 0.7 }
  );
}

// ---------- 笔记 ----------

// 笔记风格二选一，用户点「生成笔记」时选：
// easy=易懂（大白话、带例子、讲细，像讲给朋友听）；pro=专业简洁（术语准确、只留干货、结论先行）。
const NOTE_STYLES = {
  easy: {
    label: '易懂版',
    firstRule:
      '风格是「易懂版」：全程大白话，像讲给刚入门的朋友听；每个要点都尽量带一个生活化的小例子或打比方；宁可多写两句把道理讲透，也不要甩术语干条目（必须用术语时当场用一句白话解释）。结构：先一句话说清这一步到底在讲什么，然后 **核心要点**（条目，每条讲细一点）、**例子**（讲解里的例子展开成一两句好懂的话）、**容易搞混的地方**（用白话提醒）。控制在 650 字以内。',
    appendRule:
      '增补的风格是「易懂版」：大白话、带例子、讲细一点，像讲给朋友听，必须用术语时当场用白话解释一句。',
  },
  pro: {
    label: '专业简洁版',
    firstRule:
      '风格是「专业简洁版」：面向已经入门的人，术语准确、不解释基础概念、不打比方、不说客套话；结论先行，只留干货：定义、公式/规则、关键区别、注意事项，全部压缩成短条目，一条一行，能省字就省字。结构：**核心结论**（条目）、**关键细节**（条目）、**易错点**（条目）。控制在 350 字以内。',
    appendRule:
      '增补的风格是「专业简洁版」：术语准确、只留干货，短条目、一条一行，不解释基础概念、不打比方。',
  },
};
function noteStyleOf(style) {
  return style === 'pro' ? NOTE_STYLES.pro : NOTE_STYLES.easy;
}

// 把一步的教学过程整理成笔记文档。素材由服务端拼好：学生的预测、老师的讲解、
// 标「还是不懂」后的补讲、这一步涉及知识点在练习里暴露的错因——老师据此整理成文。
// 已有笔记时只产出「增补」——新内容，不重复、不覆盖。增补按这次选的风格写。
async function generateNote(subject, step, stepNo, teachText, existingContent, style) {
  const st = noteStyleOf(style);
  if (existingContent) {
    const addition = await chat(
      [
        { role: 'system', content: TEACHER },
        {
          role: 'user',
          content: `${subjectCtx(subject)}\n\n学生之前已经为第 ${stepNo} 步「${step.title}」生成过一份笔记，这次课又学了一遍这一步，教学记录里可能有新角度、新例子或新要点。\n已有笔记：\n${existingContent.slice(0, 6000)}\n\n这次的教学记录（学生的预测、老师的讲解与补讲、练习错因）：\n${String(teachText).slice(0, 6000)}\n\n请只输出需要追加到笔记末尾的增补内容（Markdown，要点式）：已有笔记里没有的新要点、新例子、新提醒。不要重复已有内容，不要写标题和客套话。${st.appendRule}\n如果这次教学记录和已有笔记比没有任何新东西，只输出这一句：没有新的补充。`,
        },
      ],
      { temperature: 0.5 }
    );
    const a = String(addition || '').trim();
    if (!a || /^没有新的补充/.test(a) || a.length < 8) return { appended: false, addition: '' };
    return { appended: true, addition: a };
  }
  const content = await chat(
    [
      { role: 'system', content: TEACHER },
      {
        role: 'user',
        content: `${subjectCtx(subject)}\n\n请把第 ${stepNo} 步「${step.title}」的教学过程整理成一份复习笔记文档。下面的记录包含：学生学之前的预测、老师的讲解、老师的补讲，以及这一步涉及知识点在练习里暴露的错因。整理时以讲解为准；学生预测里想错、记混的地方和练习错因，要变成笔记里的提醒写出来。\n\n教学记录：\n${String(teachText).slice(0, 8000)}\n\n要求：提炼，不要照抄原文。Markdown 格式。${st.firstRule}`,
      },
    ],
    { temperature: 0.5 }
  );
  return { appended: true, addition: String(content || '').trim() };
}

// 知识点笔记：结合图谱里这个知识点的依赖关系与真实练习表现生成；已有则只产出增补（与步笔记同一套口径与风格）。
// contextText 由服务端拼好：知识点说明（图谱依赖/被依赖关系）+ 练习表现（判分统计、错因）。
async function generateNodeNote(subject, nodeTitle, contextText, existingContent, style) {
  const st = noteStyleOf(style);
  if (existingContent) {
    const addition = await chat(
      [
        { role: 'system', content: TEACHER },
        {
          role: 'user',
          content: `${subjectCtx(subject)}\n\n学生之前已经为知识点「${nodeTitle}」生成过一份笔记，现在他的图谱关系或练习表现有了新变化。\n已有笔记：\n${existingContent.slice(0, 6000)}\n\n这个知识点的最新情况：\n${String(contextText).slice(0, 4000)}\n\n请只输出需要追加到笔记末尾的增补内容（Markdown，要点式）：已有笔记里没有的新理解、新提醒（尤其是练习里新暴露的薄弱点）。不要重复已有内容，不要写标题和客套话。${st.appendRule}\n如果没有任何新东西，只输出这一句：没有新的补充。`,
        },
      ],
      { temperature: 0.5 }
    );
    const a = String(addition || '').trim();
    if (!a || /^没有新的补充/.test(a) || a.length < 8) return { appended: false, addition: '' };
    return { appended: true, addition: a };
  }
  const content = await chat(
    [
      { role: 'system', content: TEACHER },
      {
        role: 'user',
        content: `${subjectCtx(subject)}\n\n请为知识点「${nodeTitle}」整理一份复习笔记。关于这个知识点的已知信息（图谱里的位置、依赖关系、学生的真实练习表现）：\n${String(contextText).slice(0, 5000)}\n\n要求：提炼成能复习的笔记，不要编造信息里没有的练习结论。Markdown 格式。${st.firstRule}`,
      },
    ],
    { temperature: 0.5 }
  );
  return { appended: true, addition: String(content || '').trim() };
}

// 思维导图：根据笔记/讲解内容产出一棵树（中心主题→一级分支→要点，最多 3 层），前端自绘 SVG 渲染。
// 返回清洗过的树对象 {title, children:[{title, children:[...]}]}，调用方 JSON 序列化后存库。
function cleanMindTree(node, depth) {
  if (!node || typeof node !== 'object') return null;
  let title = String(node.title || '').trim().replace(/\s+/g, ' ');
  if (!title) return null;
  if (title.length > 24) title = title.slice(0, 24);
  const out = { title };
  if (depth < 2) {
    const kids = Array.isArray(node.children) ? node.children : [];
    const cleaned = kids
      .map((k) => cleanMindTree(k, depth + 1))
      .filter(Boolean)
      .slice(0, depth === 0 ? 6 : 5);
    if (cleaned.length) out.children = cleaned;
  }
  return out;
}
async function generateMindmap(subject, centerTitle, sourceText) {
  const out = await chatJSON(
    TEACHER,
    `${subjectCtx(subject)}\n\n请把下面的内容整理成一棵思维导图树：中心主题是「${centerTitle}」，下面分 3~6 个一级分支，每个分支带 2~4 个要点；要点下面如果还有小点可以再带一层，整棵树最多 3 层（中心不算层）。每个节点的文字简短（12 个字以内），只写关键词或短语，不要写整句话。\n输出格式：{"title":"中心主题","children":[{"title":"分支名","children":[{"title":"要点"}]}]}\n\n内容：\n${String(sourceText).slice(0, 6000)}`
  );
  const tree = cleanMindTree(out, 0);
  if (!tree || !tree.children || !tree.children.length) throw new Error('思维导图生成失败，请重试。');
  if (!String(out.title || '').trim()) tree.title = centerTitle;
  return tree;
}

module.exports = {
  probeQuestions,
  buildRoadmap,
  teachStep,
  buildQuiz,
  buildReviewQuiz,
  gradeQuiz,
  asideAnswer,
  extractGraph,
  generateCards,
  buildOverview,
  generateTerms,
  generateCheatsheet,
  feynmanReview,
  reteachStep,
  generateNote,
  generateNodeNote,
  generateMindmap,
  noteStyleOf,
};
