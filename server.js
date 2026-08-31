// 面试邀约工具 · 云端服务（独立部署，不依赖实操台账）
// 接口：
//   GET  /api/health   健康检查
//   POST /api/login    口令登录 { token }
//   POST /api/preview  生成邮件预览 { 候选人+安排字段 }
//   POST /api/send     入队（云端不入队）→ 本地 worker 消费调 wecom-cli 发送
//   GET  /api/logs     最近发送记录（含队列处理结果）
//   GET  /api/queue    查看队列状态（pending/processing/done/failed）
const express = require('express');
const path = require('path');
const { ObjectId } = require('mongodb');
const { buildEmail, buildHtml } = require('./lib/email-builder');
const { sendMail, smtpConfigured } = require('./lib/mailer');
const { addLog, getLogs, getDb, dbDiag, closeDb } = require('./lib/store');

const DEPLOY_TAG = 'brevo-gmail-sender';
const { enqueue, listPending } = require('./lib/queue');

const app = express();
const PORT = process.env.PORT || 8788;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';

// 简单限流：每天 50 封（入队计数）
const DAILY_LIMIT = 50;
const counter = { date: '', count: 0 };
function checkRate() {
  const today = new Date().toISOString().slice(0, 10);
  if (counter.date !== today) { counter.date = today; counter.count = 0; }
  return counter.count < DAILY_LIMIT;
}
function bumpRate() { counter.count += 1; }

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!ACCESS_TOKEN) {
    return res.status(503).json({ error: '服务未配置访问口令（ACCESS_TOKEN），请联系管理员在 Render 环境变量中配置' });
  }
  if (token !== ACCESS_TOKEN) {
    return res.status(401).json({ error: '口令不正确' });
  }
  next();
}

app.get('/api/health', async (req, res) => {
  const db = await getDb();
  res.json({
    status: 'ok',
    service: 'invite-tool',
    tag: DEPLOY_TAG,
    smtpReady: smtpConfigured(),
    queueReady: !!db,
    db: dbDiag(),
    time: new Date().toISOString(),
  });
});

app.post('/api/login', (req, res) => {
  const { token } = req.body || {};
  if (!ACCESS_TOKEN) {
    return res.status(503).json({ error: '服务未配置访问口令（ACCESS_TOKEN）' });
  }
  if (token !== ACCESS_TOKEN) {
    return res.status(401).json({ error: '口令不正确' });
  }
  res.json({ ok: true, smtpReady: smtpConfigured() });
});

// Brevo 投递状态查询（诊断"云端显示发送成功但候选人没收到"）：
// Render 出口 IP 固定且已在 Brevo 后台授权，从云端查 events 最稳。
// 用法：GET /api/brevo-status            → 最近 50 条事件
//       GET /api/brevo-status?email=x     → 按收件人过滤
//       GET /api/brevo-status?messageId=x → 按邮件过滤
app.get('/api/brevo-status', auth, async (req, res) => {
  const key = process.env.BREVO_API_KEY;
  if (!key) {
    return res.status(503).json({ error: '未配置 BREVO_API_KEY，Brevo 通道未启用' });
  }
  const params = new URLSearchParams({ limit: '50' });
  if (req.query.email) params.set('email', String(req.query.email));
  if (req.query.event) params.set('event', String(req.query.event));
  if (req.query.messageId) params.set('messageId', String(req.query.messageId));
  try {
    const resp = await fetch(`https://api.brevo.com/v3/smtp/statistics/events?${params}`, {
      headers: { 'accept': 'application/json', 'api-key': key },
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return res.status(502).json({ error: `Brevo API ${resp.status}: ${data.message || JSON.stringify(data)}` });
    }
    const events = (data.events || []).map(ev => ({
      event: ev.event,
      email: ev.email,
      subject: ev.subject,
      date: ev.date,
      reason: ev.reason || '',
      messageId: ev['message-id'] || ev.messageId || '',
    }));
    // 附带 senders 验证状态（诊断"sender not valid"拒绝）
    let senders = null;
    try {
      const sresp = await fetch('https://api.brevo.com/v3/senders', {
        headers: { 'accept': 'application/json', 'api-key': key },
      });
      const sdata = await sresp.json().catch(() => ({}));
      if (sresp.ok && Array.isArray(sdata.senders)) {
        senders = sdata.senders.map(s => ({ email: s.email, active: s.active }));
      }
    } catch (_) { /* senders 查询失败不影响 events 返回 */ }
    res.json({ count: events.length, events, senders });
  } catch (e) {
    res.status(502).json({ error: `Brevo 查询失败: ${e.message}` });
  }
});

app.post('/api/preview', auth, (req, res) => {
  try {
    const { subject, body } = buildEmail(req.body || {});
    res.json({ subject, body });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/send', auth, async (req, res) => {
  const data = req.body || {};
  let subject, body, html;
  try {
    const built = buildEmail(data);
    subject = built.subject;
    body = built.body;
    html = buildHtml(built.ctx);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // 占位符兜底检查
  if (/〔[^〕]*〕/.test(subject) || /〔[^〕]*〕/.test(body)) {
    return res.status(400).json({ error: '邮件内容包含未填写的占位符，请补全后再发送' });
  }

  if (!checkRate()) {
    return res.status(429).json({ error: `今日发送已达上限（${DAILY_LIMIT} 封），请明天再试` });
  }

  try {
    // 优先 SMTP 直发（Resend 等云端可达的通道），失败才入队让本地 worker 兜底
    const { messageId, from } = await sendMail({ to: data.email, subject, body, html });
    bumpRate();

    const log = {
      to: data.email,
      candidateName: (data.name || '').trim(),
      jobTitle: (data.job || '').trim(),
      mode: data.mode === 'online' ? 'online' : 'offline',
      subject,
      sentBy: (data.operator || 'HR').trim() || 'HR',
      sentAt: new Date(),
      messageId,
      status: 'sent',
      sender: from,
    };
    const stored = await addLog(log);

    res.json({ success: true, sent: true, subject, messageId, stored, sender: from });
  } catch (e) {
    if (e.code === 'SMTP_NOT_CONFIGURED') {
      return res.status(503).json({ error: e.message, subject, body, fallback: 'copy' });
    }
    console.error('[Send] SMTP 直发失败，转本地队列:', e.message);
    try {
      const { id } = await enqueue({
        to: data.email,
        candidateName: (data.name || '').trim(),
        jobTitle: (data.job || '').trim(),
        mode: data.mode === 'online' ? 'online' : 'offline',
        subject,
        body,
        operator: (data.operator || 'HR').trim() || 'HR',
        meta: {
          date: data.date,
          time: data.time,
          meetLink: data.meetLink || '',
          meetId: data.meetId || '',
          contact: data.contact || '',
          phone: data.phone || '',
          address: data.address || '',
          access: data.access || '',
          interviewers: data.interviewers || '',
          deadline: data.deadline || '',
          attachPpt: !!data.attachPpt,
        },
      });
      bumpRate();
      await addLog({
        to: data.email,
        candidateName: data.name || '',
        jobTitle: data.job || '',
        mode: data.mode === 'online' ? 'online' : 'offline',
        subject,
        sentBy: (data.operator || 'HR').trim() || 'HR',
        sentAt: new Date(),
        status: 'queued',
        queueId: id,
      });
      res.json({
        success: true,
        queued: true,
        queueId: id,
        subject,
        smtpError: e.message,
        message: 'SMTP 直发失败，已加入本地 worker 队列（你电脑开 worker 后自动发出）',
      });
    } catch (qe) {
      if (qe.code === 'QUEUE_UNAVAILABLE') {
        return res.status(503).json({ error: qe.message, subject, body, fallback: 'copy' });
      }
      console.error('[Send] 入队也失败:', qe.message);
      res.status(500).json({ error: '发送失败：' + qe.message });
    }
  }
});

app.get('/api/logs', auth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
  const logs = await getLogs(limit);
  res.json({ logs });
});

app.get('/api/queue', auth, async (req, res) => {
  const db = await getDb();
  if (!db) return res.json({ pending: [], processing: [], done: [], failed: [] });
  const col = db.collection('pending');
  const [pending, processing, done, failed] = await Promise.all([
    col.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(20).toArray(),
    col.find({ status: 'processing' }).sort({ processingAt: -1 }).limit(10).toArray(),
    col.find({ status: 'done' }).sort({ doneAt: -1 }).limit(10).toArray(),
    col.find({ status: 'failed' }).sort({ failedAt: -1 }).limit(10).toArray(),
  ]);
  const norm = (arr) => arr.map(d => ({ ...d, _id: d._id.toString() }));
  res.json({ pending: norm(pending), processing: norm(processing), done: norm(done), failed: norm(failed) });
});

// ===== WPS 表单 Webhook（候选人数据自动同步，2026-08-31）=====
// 绑定方式：WPS 表单 → 设置 → 提交表单后 → 数据推送(Webhook)
//   URL 填 https://invite-tool.onrender.com/api/wps-hook?c=<校验码>
// WPS 点「校验并绑定」时会请求该地址，接收方返回 bind_code JSON 后绑定生效；
// 绑定后每次有人提交表单，WPS 会 POST 提交数据到这里，自动入库。
// 2026-08-31 v2：① 审计日志（记录 WPS 发来的一切请求，便于诊断协议）
//   ② bind_code 纯数字时返回数字类型 JSON（WPS 界面校验码是数字串）
//   ③ POST 也响应校验（防 WPS 校验走 POST）

// 审计：把进到 /api/wps-hook 的原始请求记入 wps_hook_log 集合（诊断用）
async function auditHook(req, kind) {
  try {
    const db = await getDb();
    if (!db) return;
    const xHeaders = {};
    Object.keys(req.headers || {}).forEach(k => {
      if (k.startsWith('x-') || /content-type|user-agent/.test(k)) xHeaders[k] = req.headers[k];
    });
    await db.collection('wps_hook_log').insertOne({
      kind, method: req.method, url: req.originalUrl,
      headers: xHeaders, query: req.query,
      body: req.body, at: new Date(),
    });
  } catch (e) { console.error('[WPS-Hook] audit err:', e.message); }
}

// bind_code 响应：WPS 期望的格式是 {"bind_code":"<校验码>"}（字符串带引号）
function respondBindCode(res, code) {
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.send('{"bind_code":' + JSON.stringify(code) + '}');
}

app.get('/api/wps-hook', async (req, res) => {
  await auditHook(req, 'verify-get');
  const code = (req.query.c || req.query.bind_code || req.query.code || '').toString();
  if (!code) {
    return res.status(400).json({
      error: '缺少校验码：URL 需为 /api/wps-hook?c=<WPS弹窗里显示的bind_code>',
    });
  }
  respondBindCode(res, code);
});

// 从 WPS 推送的 JSON 里模糊提取关键字段（推送字段名不固定，按 key/值特征识别）
function parseWpsSubmission(obj) {
  const flat = {};

  // 优先处理 WPS 官方推送格式：answerContents = [{question, answer, ...}] 数组
  // 先把 question→answer 摊平成 flat（题目文本做 key，答案做 value）
  const ac = obj && (obj.answerContents || obj.answers || obj.answer_content);
  if (Array.isArray(ac)) {
    for (const item of ac) {
      if (item && typeof item === 'object') {
        const q = String(item.question || item.title || item.label || item.q || item.name || '');
        const a = item.answer !== undefined ? item.answer : (item.value || item.a || '');
        if (q || a) flat[q || 'answer'] = Array.isArray(a) ? a.join('；') : (a == null ? '' : String(a));
      } else if (item != null) {
        flat['answer'] = String(item);
      }
    }
  }

  // 兜底：全对象递归摊平（key 含路径）
  (function walk(o, p) {
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      Object.keys(o).forEach(k => walk(o[k], p ? p + '.' + k : k));
    } else if (Array.isArray(o)) {
      flat[p] = o.map(x => (x && typeof x === 'object') ? JSON.stringify(x) : String(x)).join('；');
    } else {
      flat[p] = o == null ? '' : String(o);
    }
  })(obj, '');

  const keyHit = (re) => {
    for (const k of Object.keys(flat)) if (re.test(k)) return flat[k];
    return '';
  };
  // 按 key 找不到时，再按值的特征提取
  const valHit = (re) => {
    for (const k of Object.keys(flat)) {
      const m = (flat[k] || '').match(re);
      if (m) return m[0];
    }
    return '';
  };

  let name = keyHit(/姓名|名字|考生/i).trim();
  let job = keyHit(/岗位|职位|应聘|求职|意向/i).trim();
  const email = valHit(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  const phone = valHit(/1[3-9]\d{9}/);

  // 值里带题干的情形（key 是字段 ID，值形如「姓名：李雷」）
  if (!name) {
    for (const k of Object.keys(flat)) {
      const m = (flat[k] || '').match(/(?:姓名|名字)[：:\s]*([\u4e00-\u9fa5·]{2,4})/);
      if (m) { name = m[1]; break; }
    }
  }
  if (!job) {
    for (const k of Object.keys(flat)) {
      const m = (flat[k] || '').match(/(?:应聘岗位|应聘职位|岗位|职位|应聘|求职意向)[：:\s]*([^\s；;，,。]{2,20})/);
      if (m) { job = m[1]; break; }
    }
  }
  if (!name) {
    for (const k of Object.keys(flat)) {
      if (/^[\u4e00-\u9fa5·]{2,4}$/.test(flat[k])) { name = flat[k]; break; }
    }
  }
  return { name: name.slice(0, 30), email, job: job.slice(0, 40), phone };
}

app.post('/api/wps-hook', async (req, res) => {
  const body = req.body || {};
  const bodyKeys = (body && typeof body === 'object') ? Object.keys(body) : [];

  // WPS 绑定请求特征：body.event === 'bind'（来自审计日志 2026-08-31）
  if (body.event === 'bind') {
    await auditHook(req, 'bind-event');
    const qCode = (req.query.c || req.query.bind_code || req.query.code || '').toString();
    const bCode = String(body.rid || body.bind_code || body.code || '').trim();
    const code = (qCode || bCode || 'unknown').toString();
    return respondBindCode(res, code);
  }

  // 校验请求识别：空 body，或 body 只含 bind_code/code 类字段 → 响应校验码
  const qCode = (req.query.c || req.query.bind_code || req.query.code || '').toString();
  const bCode = bodyKeys.some(k => /bind[_-]?code|code|echo|verify|challenge/i.test(k))
    ? String(body[bodyKeys.find(k => /bind[_-]?code|code/i.test(k))] || '') : '';
  const looksVerify = bodyKeys.length === 0 || /bind[_-]?code|echo|verify|challenge/i.test(bodyKeys.join('|'));
  if (looksVerify && (qCode || bCode)) {
    await auditHook(req, 'verify-post');
    return respondBindCode(res, (qCode || bCode).toString());
  }

  await auditHook(req, 'data');
  if (!bodyKeys.length) {
    return res.status(400).json({ error: '空数据' });
  }
  const parsed = parseWpsSubmission(body);
  try {
    const db = await getDb();
    if (!db) return res.status(503).json({ error: '数据库暂不可用' });
    const r = await db.collection('candidates').insertOne({
      raw: body,
      name: parsed.name, email: parsed.email, job: parsed.job, phone: parsed.phone,
      submittedAt: new Date(),
    });
    console.log('[WPS-Hook] 新候选人入库:', parsed.name, parsed.email);
    res.json({ ok: true, id: r.insertedId.toString(), parsed });
  } catch (e) {
    console.error('[WPS-Hook] 入库失败:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 已提交候选人列表（工具页「选用」按钮用）
app.get('/api/candidates', auth, async (req, res) => {
  try {
    const db = await getDb();
    if (!db) return res.json({ candidates: [] });
    const list = await db.collection('candidates')
      .find({}, { projection: { raw: 0 } })
      .sort({ _id: -1 })
      .limit(50)
      .toArray();
    res.json({ candidates: list.map(c => ({ ...c, _id: c._id.toString() })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 删除一条候选人记录（清理测试/垃圾数据）
app.delete('/api/candidates/:id', auth, async (req, res) => {
  try {
    if (!/^[0-9a-f]{24}$/i.test(req.params.id)) {
      return res.status(400).json({ error: '无效 id' });
    }
    const db = await getDb();
    if (!db) return res.status(503).json({ error: '数据库暂不可用' });
    const r = await db.collection('candidates').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ ok: true, deleted: r.deletedCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// WPS hook 审计日志（诊断绑定/推送问题用）
app.get('/api/wps-log', auth, async (req, res) => {
  try {
    const db = await getDb();
    if (!db) return res.json({ logs: [] });
    const list = await db.collection('wps_hook_log')
      .find({}, { projection: { headers: 0 } })
      .sort({ _id: -1 })
      .limit(50)
      .toArray();
    res.json({ logs: list.map(l => ({ ...l, _id: l._id.toString(), at: l.at instanceof Date ? l.at.toISOString() : l.at })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/smtpdiag', auth, async (req, res) => {
  const isResend = (process.env.SMTP_HOST || 'smtp.resend.com').includes('resend');
  const info = {
    mode: isResend ? 'Resend HTTP API (443)' : 'SMTP',
    host: process.env.SMTP_HOST || '(默认 smtp.resend.com)',
    port: process.env.SMTP_PORT || '(默认 465)',
    user: process.env.SMTP_USER || '(默认 resend)',
    fromAddr: process.env.SMTP_FROM_ADDR || '(默认 onboarding@resend.dev)',
    fromName: process.env.SMTP_FROM_NAME || '(默认 人力资源部)',
    replyTo: process.env.REPLY_TO || '(默认 HR_Support@insightelectionhk.com)',
    passSet: !!process.env.SMTP_PASS,
    passLength: (process.env.SMTP_PASS || '').length,
  };

  if (isResend) {
    try {
      const r = await fetch('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${process.env.SMTP_PASS || ''}` },
      });
      const d = await r.json().catch(() => ({}));
      res.json({
        ...info,
        verify: r.ok ? 'OK — Resend API 可达，API key 有效' : 'FAIL',
        apiStatus: r.status,
        apiResp: r.ok ? (d.data ? `${d.data.length} 个域名` : 'OK') : (d.message || JSON.stringify(d)),
      });
    } catch (e) {
      res.json({ ...info, verify: 'FAIL', error: e.message, code: e.code || '-' });
    }
    return;
  }

  try {
    const { getTransporter } = require('./lib/mailer');
    const t = getTransporter();
    await t.verify();
    res.json({ ...info, verify: 'OK — SMTP 可连通且认证通过' });
  } catch (e) {
    res.json({ ...info, verify: 'FAIL', error: e.message, code: e.code || '-' });
  }
});

const server = app.listen(PORT, () => {
  console.log(`[invite-tool] listening on :${PORT}`);
  console.log(`  SMTP: ${smtpConfigured() ? '已配置' : '未配置'}`);
  console.log(`  队列: SMTP 失败时回退到本地 worker（通过 wecom-cli 真发）`);
  console.log(`  口令: ${ACCESS_TOKEN ? '已配置' : '未配置（登录不可用）'}`);
});

process.on('SIGTERM', async () => {
  server.close();
  await closeDb();
});
