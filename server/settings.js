// 设置：存项目本地 data/settings.json（已被 .gitignore 排除，Key 不进任何仓库）。
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./db');

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  llm: { baseUrl: 'https://api.openai.com/v1', model: '', apiKey: '' },
  filesRoot: '',
  tts: { voice: 'zh-CN-XiaoxiaoNeural' },
};

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      llm: { ...DEFAULTS.llm, ...(parsed.llm || {}) },
      filesRoot: typeof parsed.filesRoot === 'string' ? parsed.filesRoot : '',
      tts: { ...DEFAULTS.tts, ...(parsed.tts || {}) },
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

function saveSettings(next) {
  const cur = loadSettings();
  const merged = {
    llm: { ...cur.llm, ...(next.llm || {}) },
    filesRoot: next.filesRoot !== undefined ? String(next.filesRoot || '') : cur.filesRoot,
    tts: { ...cur.tts, ...(next.tts || {}) },
  };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

// 给前端看的版本：不回传明文 Key，只告诉有没有配。朗读音色不敏感，正常回。
function publicSettings() {
  const s = loadSettings();
  return {
    baseUrl: s.llm.baseUrl,
    model: s.llm.model,
    hasKey: Boolean(s.llm.apiKey),
    filesRoot: s.filesRoot,
    ttsVoice: s.tts.voice,
  };
}

module.exports = { loadSettings, saveSettings, publicSettings, SETTINGS_FILE };
