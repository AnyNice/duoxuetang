// 云端朗读：微软 edge-tts（Edge 浏览器朗读用的同一套神经网络音色，免费、无需 Key）。
// 合成结果按 sha256(voice + text) 落盘缓存到 data/tts-cache/，同一段再读直接回文件，不重复合成。
// 网络后路：环境变量 EDGE_TTS_PROXY（如 http://host.docker.internal:7890）设了就经代理连，没设直连。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { DATA_DIR } = require('./db');

const CACHE_DIR = path.join(DATA_DIR, 'tts-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

// 设置页可选的四种音色，白名单外的一律回落默认。
const VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓（女声 · 自然亲切）' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊（女声 · 温柔）' },
  { id: 'zh-CN-YunyangNeural', label: '云扬（男声 · 播报感）' },
  { id: 'zh-CN-YunjianNeural', label: '云健（男声 · 沉稳）' },
];
const DEFAULT_VOICE = VOICES[0].id;

function normalizeVoice(v) {
  return VOICES.some((x) => x.id === v) ? v : DEFAULT_VOICE;
}

function proxyAgent() {
  const proxy = String(process.env.EDGE_TTS_PROXY || '').trim();
  if (!proxy) return undefined;
  try {
    return new HttpsProxyAgent(proxy);
  } catch {
    return undefined; // 代理地址写错了也不能把朗读弄崩，直连试一次
  }
}

async function synthesize(text, voice) {
  const tts = new MsEdgeTTS({ agent: proxyAgent(), synthesisTimeoutMs: 30000 });
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text);
    const chunks = [];
    for await (const chunk of audioStream) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    if (!buf.length) throw new Error('云端语音没有返回音频');
    return buf;
  } finally {
    try {
      tts.close();
    } catch {
      /* ignore */
    }
  }
}

// 返回 mp3 文件路径：命中缓存直接给，未命中先合成再落盘。
async function getSpeechFile(text, voice) {
  const v = normalizeVoice(voice);
  const key = crypto.createHash('sha256').update(`${v}\n${text}`).digest('hex');
  const file = path.join(CACHE_DIR, `${key}.mp3`);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  const buf = await synthesize(text, v);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  return file;
}

module.exports = { VOICES, DEFAULT_VOICE, normalizeVoice, getSpeechFile };
