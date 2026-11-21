// FSRS-6 调度：复习状态不落库，每次都从 review_events 事件账重放现算。
// 默认权重（由公开的 FSRS-6 默认参数取，用在开放题判分上只作参考，不是精确预测）。
// 事件 → 评级映射：full=Good(3) / partial=Hard(2) / miss=Again(1)。
// 错因降噪：result 不是 full 且 error_cause 为 careless/execution 时，不算遗忘，按 Good 处理。
// 待确认：当前间隔 ≥21 天的知识点第一次真遗忘（Again 且非粗心/执行错）时不立刻打回，
//         先标「待确认」、到期改到 1 天后；同一节课内后续事件忽略；
//         下一节课再错才确认遗忘，答对最高按 Hard。

const W = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835,
  0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];
const DECAY = -W[20];
const FACTOR = Math.pow(0.9, 1 / DECAY) - 1;
const TARGET_R = 0.9;
const DAY_MS = 86400000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function initStability(rating) {
  return W[rating - 1];
}
function initDifficulty(rating) {
  return clamp(W[4] - Math.exp(W[5] * (rating - 1)) + 1, 1, 10);
}
function retrievability(elapsedDays, stability) {
  return Math.pow(1 + (FACTOR * elapsedDays) / stability, DECAY);
}
function nextDifficulty(d, rating) {
  const delta = -W[6] * (rating - 3);
  const damped = d + (delta * (10 - d)) / 9;
  const d0Easy = initDifficulty(4);
  return clamp(W[7] * d0Easy + (1 - W[7]) * damped, 1, 10);
}
function recallStability(d, s, r, rating) {
  const hardPenalty = rating === 2 ? W[15] : 1;
  const easyBonus = rating === 4 ? W[16] : 1;
  return (
    s *
    (Math.exp(W[8]) *
      (11 - d) *
      Math.pow(s, -W[9]) *
      (Math.exp(W[10] * (1 - r)) - 1) *
      hardPenalty *
      easyBonus +
      1)
  );
}
function forgetStability(d, s, r) {
  const v =
    W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r));
  return Math.min(v, s); // 遗忘后的稳定度不应超过遗忘前
}
function intervalDays(stability) {
  const days = (stability / FACTOR) * (Math.pow(TARGET_R, 1 / DECAY) - 1);
  return Math.max(days, 0.05);
}

function effectiveRating(ev) {
  const base = { full: 3, partial: 2, miss: 1 }[ev.result] || 1;
  if (base < 3 && (ev.error_cause === 'careless' || ev.error_cause === 'execution')) return 3;
  return base;
}
function isGenuineMiss(ev) {
  return effectiveRating(ev) === 1;
}

function applyGrade(state, rating, elapsedDays) {
  const r = retrievability(Math.max(elapsedDays, 0), state.S);
  const d = nextDifficulty(state.D, rating);
  const s = rating === 1 ? forgetStability(d, state.S, r) : recallStability(d, state.S, r, rating);
  return { S: Math.max(s, 0.05), D: d };
}

// events: [{result, error_cause, session_id, created_at}]，需按时间升序。
function replay(events, nowDate = new Date()) {
  if (!events || events.length === 0) {
    return { hasEvents: false, due: false, pendingConfirm: false };
  }
  let state = null;
  let lastAt = null;
  let pending = null; // {sessionId, at:Date, dueAt:Date}
  let lastResult = null;
  let lastRating = null;

  for (const ev of events) {
    const t = new Date(ev.created_at);
    const rating = effectiveRating(ev);
    lastResult = ev.result;
    if (!state) {
      state = { S: initStability(rating), D: initDifficulty(rating) };
      lastAt = t;
      lastRating = rating;
      continue;
    }
    if (pending) {
      if (ev.session_id != null && pending.sessionId != null && ev.session_id === pending.sessionId) {
        continue; // 待确认期间，同节课后续事件忽略
      }
      const elapsed = (t - lastAt) / DAY_MS;
      if (isGenuineMiss(ev)) {
        state = applyGrade(state, 1, elapsed); // 确认遗忘
        lastRating = 1;
      } else {
        state = applyGrade(state, Math.min(rating, 2), elapsed); // 答对最高按 Hard
        lastRating = Math.min(rating, 2);
      }
      pending = null;
      lastAt = t;
      continue;
    }
    const elapsed = (t - lastAt) / DAY_MS;
    const curInterval = intervalDays(state.S);
    if (isGenuineMiss(ev) && curInterval >= 21) {
      pending = { sessionId: ev.session_id, at: t, dueAt: new Date(t.getTime() + DAY_MS) };
      continue;
    }
    state = applyGrade(state, rating, elapsed);
    lastRating = rating;
    lastAt = t;
  }

  const ivl = intervalDays(state.S);
  const dueAt = pending ? pending.dueAt : new Date(lastAt.getTime() + ivl * DAY_MS);
  return {
    hasEvents: true,
    stability: Number(state.S.toFixed(2)),
    difficulty: Number(state.D.toFixed(2)),
    intervalDays: Number(ivl.toFixed(2)),
    lastReviewAt: lastAt.toISOString(),
    dueAt: dueAt.toISOString(),
    due: nowDate >= dueAt,
    overdueDays: Math.max(0, Math.floor((nowDate - dueAt) / DAY_MS)),
    pendingConfirm: Boolean(pending),
    lastResult,
    lastRating,
  };
}

module.exports = { replay, effectiveRating, isGenuineMiss, intervalDays, initStability, W };
