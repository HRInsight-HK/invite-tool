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
const { buildEmail } = require('./lib/email-builder');
const { sendMail, smtpConfigured } = require('./lib/mailer');
const { addLog, getLogs, getDb, dbDiag, closeDb } = require('./lib/store');

const DEPLOY_TAG = 'diag-v1';
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
  let subject, body;
  try {
    ({ subject, body } = buildEmail(data));
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
    const { messageId, from } = await sendMail({ to: data.email, subject, body });
    bumpRate();

    const log = {
      to: data.email,
      candidateName: (data.name || '').trim(),
      jobTitle: (data.job || '').trim(),
      mode: data.mode === 'online' ? 'online' : 'offline',
      subject,
      sentBy: (data.operator || 'HR').trim() || 'HR',
      sentAt: new Date().toISOString(),
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
        sentAt: new Date().toISOString(),
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
