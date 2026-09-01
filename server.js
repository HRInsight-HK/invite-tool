// 面试邀约工具 · 云端服务（独立部署，不依赖实操台账）
// 接口：
//   GET  /api/health   健康检查（含本地 worker 心跳状态）
//   POST /api/login    口令登录 { token }
//   POST /api/preview  生成邮件预览 { 候选人+安排字段 }
//   POST /api/send     入队 → 本地 worker 消费（wecom-cli 真发，发件人=HR_Support@insightelectionhk.com）
//   GET  /api/logs     最近发送记录（含队列处理结果）
//   GET  /api/queue    查看队列状态（pending/processing/done/failed）
//
// 2026-09-01 候选人管理台账（/ledger.html）：
//   /api/talents*（候选人 CRUD+阶段流转+简历 GridFS 入库+CSV 导出）
//   /api/jobs*（岗位库：JD/HC/优先级/BOSS 渠道数据）
//   /api/funnel（招聘漏斗统计：简历→有效→一面→二面→录用→入职）
//   /api/meta（阶段定义）
//
// 2026-09-01 重大变更：发送一律走本地 worker（用户要求发件人必须是 HR_Support@insightelectionhk.com）。
//   Brevo/Gmail 云端直发已停用（Gmail 显示名是代发、域名认证走不通）；worker 离线时入队照常，
//   响应里提示先启动「启动云端worker.bat」，开启后自动补发。
const express = require('express');
const path = require('path');
const { ObjectId } = require('mongodb');
const { buildEmail } = require('./lib/email-builder');
const { smtpConfigured } = require('./lib/mailer');
const { addLog, getLogs, getDb, dbDiag, closeDb } = require('./lib/store');
const T = require('./lib/talents');

const DEPLOY_TAG = 'talent-ledger-v3';
const { enqueue, workerStatus } = require('./lib/queue');

// ===== 进程级异常兜底：记录但不退出（Render 免费层崩了要等重启，先保命再排查）=====
const ERRLOG = [];
function logErr(where, e) {
  const item = {
    at: new Date().toISOString(), where,
    msg: e && e.message ? e.message : String(e),
    stack: String((e && e.stack) || '').slice(0, 1500),
  };
  ERRLOG.unshift(item);
  if (ERRLOG.length > 30) ERRLOG.pop();
  console.error(`[${where}]`, e);
}
process.on('uncaughtException', (e) => logErr('uncaughtException', e));
process.on('unhandledRejection', (e) => logErr('unhandledRejection', e));

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

// 台账简历文件走 base64 JSON 上传，放宽到 16mb（解码后 ≤12MB）
app.use(express.json({ limit: '16mb' }));
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
  let worker = null;
  if (db) {
    try { worker = await workerStatus(); } catch (_) { worker = null; }
  }
  res.json({
    status: 'ok',
    service: 'invite-tool',
    tag: DEPLOY_TAG,
    smtpReady: smtpConfigured(),
    queueReady: !!db,
    worker,
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
  let subject, body;
  try {
    const built = buildEmail(data);
    subject = built.subject;
    body = built.body;
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

  // 2026-09-01 起一律入队由本地 worker 发（发件人必须是 HR_Support@insightelectionhk.com），
  // 不再云端直发（Brevo/Gmail 停用）。worker 离线时也入队（不丢数据），开启后自动补发。
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
        duration: data.duration || '',
        hr: data.contact || data.hr || '',
        meetLink: data.meetLink || '',
        meetId: data.meetId || '',
        contact: data.contact || '',
        phone: data.phone || '',
        address: data.address || '',
        access: data.access || '',
        interviewers: data.interviewers || '',
        deadline: data.deadline || '',
        extra: data.extra || '',
        attachPpt: !!data.attachPpt,
      },
    });
    bumpRate();
    const ws = await workerStatus().catch(() => ({ alive: false }));
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
    const autoMeet = data.mode === 'online' && !(data.meetLink || '').trim() && !(data.meetId || '').trim();
    res.json({
      success: true,
      queued: true,
      queueId: id,
      subject,
      workerAlive: !!ws.alive,
      sender: 'HR_Support@insightelectionhk.com',
      autoMeet,
      message: !ws.alive
        ? '已入队，但本地 worker 未运行——双击「启动云端worker.bat」，开启后自动发出'
        : autoMeet
          ? '已入队：worker 正在自动创建腾讯会议（约进企微日程）并以 HR_Support 发出，约 10 秒完成'
          : '已入队：本地 worker 正在以 HR_Support@insightelectionhk.com 发出（几秒内完成）',
    });
  } catch (qe) {
    if (qe.code === 'QUEUE_UNAVAILABLE') {
      return res.status(503).json({ error: qe.message, subject, body, fallback: 'copy' });
    }
    console.error('[Send] 入队失败:', qe.message);
    res.status(500).json({ error: '发送失败：' + qe.message });
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

// ===== 候选人管理台账（2026-09-01）=====

// 阶段定义（前端渲染下拉用）
app.get('/api/meta', auth, (req, res) => {
  res.json({ stages: T.STAGES, stageKeys: T.STAGE_KEYS, funnelSteps: T.FUNNEL_STEPS });
});

// 进程错误日志（排查线上崩溃用，保留最近 30 条）
app.get('/api/errors', auth, (req, res) => {
  res.json({ errors: ERRLOG });
});

// 漏斗统计
app.get('/api/funnel', auth, async (req, res) => {
  try {
    res.json(await T.funnelStats());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 岗位库 CRUD
app.get('/api/jobs', auth, async (req, res) => {
  try { res.json({ jobs: await T.listJobs() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/jobs', auth, async (req, res) => {
  try { res.json({ success: true, job: await T.createJob(req.body || {}) }); }
  catch (e) { res.status(e.code === 'BAD_INPUT' ? 400 : 500).json({ error: e.message }); }
});
app.patch('/api/jobs/:id', auth, async (req, res) => {
  try {
    const job = await T.updateJob(req.params.id, req.body || {});
    if (!job) return res.status(404).json({ error: '岗位不存在或无字段更新' });
    res.json({ success: true, job });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/jobs/:id', auth, async (req, res) => {
  try { res.json({ ok: true, deleted: await T.deleteJob(req.params.id) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 候选人列表（?stage=&job=&q=&page=&pageSize=&onlyNew=1）
app.get('/api/talents', auth, async (req, res) => {
  try {
    const r = await T.listTalents({
      stage: req.query.stage || '',
      job: req.query.job || '',
      q: req.query.q || '',
      page: Math.max(1, parseInt(req.query.page || '1', 10) || 1),
      pageSize: Math.min(300, parseInt(req.query.pageSize || '100', 10) || 100),
      includeImported: req.query.onlyNew !== '1',
    });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// CSV 导出（注意：必须在 /api/talents/:id 之前注册）
app.get('/api/talents/export', auth, async (req, res) => {
  try {
    const { list } = await T.listTalents({ page: 1, pageSize: 300 });
    const esc = (v) => {
      if (v == null) return '';
      if (typeof v === 'object') v = JSON.stringify(v);
      const s = String(v).replace(/"/g, '""');
      return /[",\n\r]/.test(s) ? `"${s}"` : s;
    };
    const header = ['更新时间', '招聘岗位', '责任人', '姓名', '性别', '年龄', '学历/专业', '文/理工/商科',
      '证书', '候选人摘要', '工作经验', '离职原因', '到岗时间', '目前薪资', '期望薪资', '英语口语',
      '推荐原因', '简历文件', '筛选结论', '是否可面试', '复合潜质',
      '一面日期', '一面结果', '一面反馈1', '一面反馈2',
      '二面日期', '二面结果', '二面反馈1', '二面反馈2',
      '录用结果', '不入职原因', '入职时间', '预计转正', '当前阶段', '来源', '渠道', '邮箱', '电话', '备注'];
    const rows = list.map(t => [
      t.updatedAt ? new Date(t.updatedAt).toLocaleString('zh-CN') : '',
      t.jobTitle || '', t.recruiter || '', t.name || '', t.gender || '', t.age || '',
      t.education || '', t.subjectType || '', t.certificates || '',
      t.summary || '', t.experience || '', t.leaveReason || '', t.availableTime || '',
      t.currentSalary || '', t.expectSalary || '', t.englishLevel || '', t.recommendReason || '',
      t.resumeFileName || '', t.screenMatch || '', t.canInterview || '', t.compositePotential || '',
      (t.interview1 && t.interview1.date) || '', (t.interview1 && t.interview1.result) || '',
      (t.interview1 && t.interview1.feedback1) || '', (t.interview1 && t.interview1.feedback2) || '',
      (t.interview2 && t.interview2.date) || '', (t.interview2 && t.interview2.result) || '',
      (t.interview2 && t.interview2.feedback1) || '', (t.interview2 && t.interview2.feedback2) || '',
      t.offerResult || '', t.noJoinReason || '', t.onboardDate || '', t.probationEnd || '',
      T.stageLabel(t.stage), t.source || '', t.channel || '', t.email || '', t.phone || '', t.notes || '',
    ].map(esc).join(','));
    const csv = '\uFEFF' + header.join(',') + '\r\n' + rows.join('\r\n');
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="recruitment-ledger-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 新建候选人（可携带简历文件 base64 → GridFS）
app.post('/api/talents', auth, async (req, res) => {
  const body = req.body || {};
  try {
    let resumeFileId = '', resumeFileName = '';
    if (body.resumeFile && body.resumeFile.dataBase64) {
      const buf = Buffer.from(body.resumeFile.dataBase64, 'base64');
      if (buf.length > 12 * 1024 * 1024) {
        return res.status(400).json({ error: '简历文件超过 12MB，请压缩后重试' });
      }
      resumeFileName = body.resumeFile.name || 'resume';
      resumeFileId = await T.saveResumeFile({
        name: resumeFileName, contentType: body.resumeFile.contentType, buffer: buf,
      });
    }
    const talent = await T.createTalent({ ...body, resumeFileId, resumeFileName }, {
      aiParsed: !!body.aiParsed,
    });
    res.json({ success: true, talent });
  } catch (e) {
    res.status(e.code === 'BAD_INPUT' ? 400 : (e.code === 'DB_DOWN' ? 503 : 500)).json({ error: e.message });
  }
});

// 候选人详情
app.get('/api/talents/:id', auth, async (req, res) => {
  const t = await T.getTalent(req.params.id);
  if (!t) return res.status(404).json({ error: '候选人不存在' });
  res.json({ talent: t });
});

// 字段更新（阶段流转走 /stage）
app.patch('/api/talents/:id', auth, async (req, res) => {
  try {
    const t = await T.updateTalent(req.params.id, req.body || {});
    if (!t) return res.status(404).json({ error: '候选人不存在或无字段更新' });
    res.json({ success: true, talent: t });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 阶段流转 { stage, note, by }
app.post('/api/talents/:id/stage', auth, async (req, res) => {
  try {
    const t = await T.moveStage(req.params.id, req.body || {});
    if (!t) return res.status(404).json({ error: '候选人不存在' });
    res.json({ success: true, talent: t });
  } catch (e) {
    res.status(e.code === 'BAD_INPUT' ? 400 : 500).json({ error: e.message });
  }
});

// 删除（仅测试/误录数据；正常流转用阶段「已淘汰/候选人放弃」）
app.delete('/api/talents/:id', auth, async (req, res) => {
  try { res.json({ ok: true, deleted: await T.deleteTalent(req.params.id) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 简历下载（<a> 标签无法带 header → 支持 ?t= 口令参数）
app.get('/api/talents/:id/resume', async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.query.t || '');
  if (!ACCESS_TOKEN || token !== ACCESS_TOKEN) {
    return res.status(401).json({ error: '口令不正确' });
  }
  const t = await T.getTalent(req.params.id);
  if (!t || !t.resumeFileId) return res.status(404).json({ error: '该候选人没有简历文件' });
  const file = await T.findResumeFile(t.resumeFileId);
  if (!file) return res.status(404).json({ error: '简历文件已丢失' });
  res.set({
    'Content-Type': file.info.contentType || 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.info.filename || 'resume')}`,
  });
  file.stream.pipe(res);
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
  console.log(`  通道: 一律本地 worker 发（wecom-cli，发件人 HR_Support@insightelectionhk.com）`);
  console.log(`  口令: ${ACCESS_TOKEN ? '已配置' : '未配置（登录不可用）'}`);
});

process.on('SIGTERM', async () => {
  server.close();
  await closeDb();
});
