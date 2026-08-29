// 面试邀约工具 · 云端服务（独立部署，不依赖实操台账）
// 接口：
//   GET  /api/health   健康检查
//   POST /api/login    口令登录 { token }
//   POST /api/preview  生成邮件预览 { 候选人+安排字段 }
//   POST /api/send     SMTP 直发 + 记台账 { ...字段 }
//   GET  /api/logs     最近发送记录
const express = require('express');
const path = require('path');
const { buildEmail } = require('./lib/email-builder');
const { sendMail, smtpConfigured } = require('./lib/mailer');
const { addLog, getLogs, closeDb } = require('./lib/store');

const app = express();
const PORT = process.env.PORT || 8788;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';

// 简单限流：每天 50 封（内存级，重启清零）
const DAILY_LIMIT = 50;
const counter = { date: '', count: 0 };
function checkRate() {
  const today = new Date().toISOString().slice(0, 10);
  if (counter.date !== today) { counter.date = today; counter.count = 0; }
  return counter.count < DAILY_LIMIT;
}
function bumpRate() {
  counter.count += 1;
}

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

app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  service: 'invite-tool',
  smtpReady: smtpConfigured(),
  time: new Date().toISOString(),
}));

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
    };
    const stored = await addLog(log);

    res.json({ success: true, subject, messageId, stored, sender: from });
  } catch (e) {
    if (e.code === 'SMTP_NOT_CONFIGURED') {
      return res.status(503).json({ error: e.message, subject, body, fallback: 'copy' });
    }
    console.error('[Send] 失败:', e.message);
    res.status(500).json({ error: '邮件发送失败：' + (e.response || e.message) });
  }
});

app.get('/api/logs', auth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
  const logs = await getLogs(limit);
  res.json({ logs });
});

const server = app.listen(PORT, () => {
  console.log(`[invite-tool] listening on :${PORT}`);
  console.log(`  SMTP: ${smtpConfigured() ? '已配置' : '未配置（发送接口将返回 503，可先复制全文手动发）'}`);
  console.log(`  口令: ${ACCESS_TOKEN ? '已配置' : '未配置（登录不可用）'}`);
});

process.on('SIGTERM', async () => {
  server.close();
  await closeDb();
});
