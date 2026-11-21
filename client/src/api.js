// 极简 API 封装：出错时把后端给的白话文案抛出来给界面显示。
async function req(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opt);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(data.error || `请求失败（HTTP ${resp.status}）`);
    err.status = resp.status;
    throw err;
  }
  return data;
}

export const api = {
  get: (u) => req('GET', u),
  post: (u, b) => req('POST', u, b || {}),
  del: (u) => req('DELETE', u),
  async uploadPdf(file) {
    const fd = new FormData();
    fd.append('file', file);
    const resp = await fetch('/api/import/pdf', { method: 'POST', body: fd });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(data.error || 'PDF 上传失败');
      err.status = resp.status;
      throw err;
    }
    return data;
  },
  // 上传文件导入知识点：PDF / txt / md，后端提取文字；不支持的格式后端会给明确文案。
  async uploadFile(file) {
    const fd = new FormData();
    fd.append('file', file);
    const resp = await fetch('/api/import/file', { method: 'POST', body: fd });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(data.error || '文件上传失败');
      err.status = resp.status;
      throw err;
    }
    return data;
  },
};
