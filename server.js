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
const { smtpConfigured } = require('./lib/mailer');
const { addLog, getLogs, getDb, closeDb } = require('./lib/store');
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
    smtpReady: smtpConfigured(),
    queueReady: !!db,
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
    // 入队 → 本地 worker 轮询消费，走 wecom-cli 真发邮件
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

    // 同步写一条 pending 记录到 logs（前端能立刻看到任务创建）
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
      message: '已加入发送队列，本地客户端会在数秒内通过「人事小助手（内用）」代发邮件',
    });
  } catch (e) {
    if (e.code === 'QUEUE_UNAVAILABLE') {
      // 队列不可用：降级返回全文，让前端提示"复制全文"
      return res.status(503).json({
        error: e.message,
        subject,
        body,
        fallback: 'copy',
      });
    }
    console.error('[Send] 入队失败:', e.message);
    res.status(500).json({ error: '入队失败：' + e.message });
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

const server = app.listen(PORT, () => {
  console.log(`[invite-tool] listening on :${PORT}`);
  console.log(`  SMTP: ${smtpConfigured() ? '已配置' : '未配置'}`);
  console.log(`  队列: 写入 Atlas（云端只入队，本地 worker 消费并通过 wecom-cli 真发）`);
  console.log(`  口令: ${ACCESS_TOKEN ? '已配置' : '未配置（登录不可用）'}`);
});

process.on('SIGTERM', async () => {
  server.close();
  await closeDb();
});
