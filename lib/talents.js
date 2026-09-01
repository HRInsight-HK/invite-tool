// 候选人台账（招聘信息台账）数据层
// 集合：talents（候选人主档，对应「招聘总表」）/ jobs（岗位库：JD+HC+BOSS渠道数据）
// 简历文件：GridFS bucket = resumes
//
// 漏斗口径（对齐用户「数据总览」表）：
//   获得简历(0) → 有效简历(1，用人部门评估可面试) → 一面(2) → 二面(3) → 录用(4) → 入职(5)
//   funnelStep 只增不减：淘汰/放弃时保留其到达过的最深阶段
const { ObjectId } = require('mongodb');
const { getDb } = require('./store');

// ===== 阶段机 =====
const STAGES = {
  resume:    { label: '简历入库',        step: 0, group: 'pipeline' },
  screening: { label: '初筛评估',        step: 0, group: 'pipeline' },
  wait1:     { label: '待约一面',        step: 1, group: 'pipeline' },
  i1:        { label: '已约一面',        step: 2, group: 'pipeline' },
  i1done:    { label: '一面完成·待定',   step: 2, group: 'pipeline' },
  wait2:     { label: '待约二面',        step: 3, group: 'pipeline' },
  i2:        { label: '已约二面',        step: 3, group: 'pipeline' },
  i2done:    { label: '二面完成·待定',   step: 3, group: 'pipeline' },
  offer:     { label: '录用·待入职',     step: 4, group: 'pipeline' },
  onboarded: { label: '已入职',          step: 5, group: 'pipeline' },
  rejected:  { label: '已淘汰',          group: 'end' },
  declined:  { label: '候选人放弃',      group: 'end' },
};
const STAGE_KEYS = Object.keys(STAGES);
const FUNNEL_STEPS = [
  { step: 0, key: 'resumes', label: '获得简历' },
  { step: 1, key: 'valid',   label: '有效简历' },
  { step: 2, key: 'i1',      label: '一面' },
  { step: 3, key: 'i2',      label: '二面' },
  { step: 4, key: 'offer',   label: '录用' },
  { step: 5, key: 'onboard', label: '入职' },
];

// 台账可编辑字段（白名单，PATCH/POST 均走这里）
const TALENT_FIELDS = [
  'name', 'gender', 'age', 'education', 'subjectType', 'certificates',
  'summary', 'experience', 'leaveReason', 'availableTime',
  'currentSalary', 'expectSalary', 'englishLevel', 'recommendReason',
  'jobId', 'jobTitle', 'dept', 'recruiter', 'source', 'channel',
  'screenMatch', 'canInterview', 'compositePotential',
  'interview1', 'interview2',
  'offerResult', 'noJoinReason', 'onboardDate', 'probationEnd',
  'email', 'phone', 'notes',
];

function stageLabel(s) { return (STAGES[s] && STAGES[s].label) || s; }

function pickTalentFields(body) {
  const out = {};
  for (const k of TALENT_FIELDS) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  return out;
}

async function getTalentsColl() {
  const db = await getDb();
  return db ? db.collection('talents') : null;
}
async function getJobsColl() {
  const db = await getDb();
  return db ? db.collection('jobs') : null;
}

// ===== 简历文件（GridFS）=====
async function saveResumeFile({ name, contentType, buffer }) {
  const db = await getDb();
  if (!db) throw Object.assign(new Error('数据库暂不可用'), { code: 'DB_DOWN' });
  const grid = new (require('mongodb').GridFSBucket)(db, { bucketName: 'resumes' });
  return await new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };
    // 兜底超时：GridFS 流悬挂时不拖死请求
    const timer = setTimeout(() => done(reject, new Error('简历文件存储超时（20s）')), 20000);
    try {
      const up = grid.openUploadStream(name || 'resume', {
        contentType: contentType || 'application/octet-stream',
        metadata: { uploadedAt: new Date() },
      });
      up.on('error', (e) => done(reject, e));
      // 注意：mongodb 6.x 的 finish 事件不传文件对象参数，用 stream 自身的 id 属性
      up.on('finish', () => done(resolve, up.id.toString()));
      up.end(buffer);
    } catch (e) { done(reject, e); }
  });
}

async function findResumeFile(fileId) {
  const db = await getDb();
  if (!db) return null;
  if (!/^[0-9a-f]{24}$/i.test(String(fileId))) return null;
  const grid = new (require('mongodb').GridFSBucket)(db, { bucketName: 'resumes' });
  const files = await db.collection('resumes.files').find({ _id: new ObjectId(String(fileId)) }).limit(1).toArray();
  if (!files.length) return null;
  return { info: files[0], stream: grid.openDownloadStream(files[0]._id) };
}

// ===== 候选人 CRUD =====
async function listTalents({ stage, job, q, page = 1, pageSize = 100, includeImported = true }) {
  const coll = await getTalentsColl();
  if (!coll) return { list: [], total: 0 };
  const query = {};
  if (stage) query.stage = stage;
  if (job) query.jobTitle = { $regex: job, $options: 'i' };
  if (!includeImported) query.imported = { $ne: true };
  if (q) {
    const re = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    query.$or = [{ name: re }, { jobTitle: re }, { dept: re }, { recruiter: re }, { summary: re }];
  }
  const total = await coll.countDocuments(query);
  const list = await coll.find(query, { projection: { history: 0 } })
    .sort({ updatedAt: -1 })
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .toArray();
  return { list: list.map(normId), total };
}

function normId(d) { return { ...d, _id: d._id.toString() }; }

async function getTalent(id) {
  const coll = await getTalentsColl();
  if (!coll || !/^[0-9a-f]{24}$/i.test(id)) return null;
  const d = await coll.findOne({ _id: new ObjectId(id) });
  return d ? normId(d) : null;
}

async function createTalent(body, { aiParsed = false, imported = false } = {}) {
  const coll = await getTalentsColl();
  if (!coll) throw Object.assign(new Error('数据库暂不可用'), { code: 'DB_DOWN' });
  const fields = pickTalentFields(body);
  if (!String(fields.name || '').trim()) {
    throw Object.assign(new Error('姓名必填'), { code: 'BAD_INPUT' });
  }
  const now = new Date();
  const stage = STAGE_KEYS.includes(body.stage) ? body.stage : 'resume';
  const doc = {
    ...fields,
    name: String(fields.name).trim(),
    stage,
    funnelStep: STAGES[stage].step,
    history: [{ stage, note: imported ? '历史数据导入' : '创建候选人', at: now, by: body.by || '' }],
    aiParsed, imported,
    createdAt: now, updatedAt: now,
  };
  if (body.resumeFileId) { doc.resumeFileId = body.resumeFileId; doc.resumeFileName = body.resumeFileName || ''; }
  const r = await coll.insertOne(doc);
  return { ...doc, _id: r.insertedId.toString() };
}

async function updateTalent(id, body) {
  const coll = await getTalentsColl();
  if (!coll || !/^[0-9a-f]{24}$/i.test(id)) return null;
  const fields = pickTalentFields(body);
  if (!Object.keys(fields).length) return getTalent(id);
  const r = await coll.findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: { ...fields, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  const doc = r && (r.value || r); // 兼容驱动 v5/v6 返回结构
  return doc ? normId(doc) : null;
}

// 阶段流转（funnelStep 只增不减 + history 追加）
async function moveStage(id, { stage, note = '', by = '' }) {
  const coll = await getTalentsColl();
  if (!coll || !/^[0-9a-f]{24}$/i.test(id)) return null;
  if (!STAGE_KEYS.includes(stage)) {
    throw Object.assign(new Error(`未知阶段：${stage}`), { code: 'BAD_INPUT' });
  }
  const cur = await coll.findOne({ _id: new ObjectId(id) }, { projection: { stage: 1, funnelStep: 1 } });
  if (!cur) return null;
  const newStep = Math.max(cur.funnelStep || 0, STAGES[stage].step);
  const r = await coll.findOneAndUpdate(
    { _id: new ObjectId(id) },
    {
      $set: { stage, funnelStep: newStep, stageNote: note || '', updatedAt: new Date() },
      $push: { history: { stage, note, at: new Date(), by } },
    },
    { returnDocument: 'after' },
  );
  const doc = r && (r.value || r); // 兼容驱动 v5/v6 返回结构
  return doc ? normId(doc) : null;
}

async function deleteTalent(id) {
  const coll = await getTalentsColl();
  if (!coll || !/^[0-9a-f]{24}$/i.test(id)) return 0;
  const r = await coll.deleteOne({ _id: new ObjectId(id) });
  return r.deletedCount;
}

// ===== 漏斗统计 =====
async function funnelStats() {
  const coll = await getTalentsColl();
  if (!coll) return { totals: [], stageCounts: [], byJob: [] };
  const [total, stepAgg, stageAgg, jobAgg] = await Promise.all([
    coll.countDocuments({}),
    coll.aggregate([
      { $group: { _id: '$funnelStep', count: { $sum: 1 } } },
    ]).toArray(),
    coll.aggregate([
      { $group: { _id: '$stage', count: { $sum: 1 } } },
    ]).toArray(),
    coll.aggregate([
      { $match: { jobTitle: { $ne: '', $exists: true } } },
      { $group: {
        _id: '$jobTitle',
        dept: { $first: '$dept' },
        resumes: { $sum: 1 },
        valid: { $sum: { $cond: [{ $gte: ['$funnelStep', 1] }, 1, 0] } },
        i1: { $sum: { $cond: [{ $gte: ['$funnelStep', 2] }, 1, 0] } },
        i2: { $sum: { $cond: [{ $gte: ['$funnelStep', 3] }, 1, 0] } },
        offer: { $sum: { $cond: [{ $gte: ['$funnelStep', 4] }, 1, 0] } },
        onboard: { $sum: { $cond: [{ $eq: ['$funnelStep', 5] }, 1, 0] } },
        inProgress: { $sum: { $cond: [{ $in: ['$stage', ['wait1', 'i1', 'i1done', 'wait2', 'i2', 'i2done']] }, 1, 0] } },
      } },
      { $sort: { resumes: -1 } },
      { $limit: 12 },
    ]).toArray(),
  ]);
  const stepMap = {};
  stepAgg.forEach(d => { stepMap[d._id] = d.count; });
  // 累计口径：step>=N 都算到达过 N
  const totals = FUNNEL_STEPS.map(fs => {
    let count = 0;
    for (const [k, v] of Object.entries(stepMap)) {
      if (Number(k) >= fs.step) count += v;
    }
    return { key: fs.key, label: fs.label, count };
  });
  totals.unshift({ key: 'total', label: '总候选人', count: total });
  const stageCounts = stageAgg
    .filter(d => d._id)
    .map(d => ({ stage: d._id, label: stageLabel(d._id), count: d.count }))
    .sort((a, b) => STAGE_KEYS.indexOf(a.stage) - STAGE_KEYS.indexOf(b.stage));
  const byJob = jobAgg.map(d => ({
    jobTitle: d._id, dept: d.dept || '', resumes: d.resumes,
    valid: d.valid, i1: d.i1, i2: d.i2, offer: d.offer, onboard: d.onboard, inProgress: d.inProgress,
  }));
  return { totals, stageCounts, byJob };
}

// ===== 岗位库 =====
const JOB_FIELDS = ['dept', 'title', 'hc', 'requestDate', 'planDate', 'priority', 'status', 'jd', 'notes',
  'bossViews', 'bossApplies', 'bossChats'];

async function listJobs() {
  const coll = await getJobsColl();
  if (!coll) return [];
  const list = await coll.find({}).sort({ status: 1, _id: -1 }).toArray();
  return list.map(normId);
}

async function createJob(body) {
  const coll = await getJobsColl();
  if (!coll) throw Object.assign(new Error('数据库暂不可用'), { code: 'DB_DOWN' });
  if (!String(body.title || '').trim()) {
    throw Object.assign(new Error('岗位名称必填'), { code: 'BAD_INPUT' });
  }
  const doc = {};
  for (const k of JOB_FIELDS) if (body[k] !== undefined) doc[k] = body[k];
  const now = new Date();
  const r = await coll.insertOne({
    ...doc, title: String(body.title).trim(),
    status: ['open', 'paused', 'closed'].includes(body.status) ? body.status : 'open',
    createdAt: now, updatedAt: now,
  });
  return { ...doc, _id: r.insertedId.toString() };
}

async function updateJob(id, body) {
  const coll = await getJobsColl();
  if (!coll || !/^[0-9a-f]{24}$/i.test(id)) return null;
  const fields = {};
  for (const k of JOB_FIELDS) if (body[k] !== undefined) fields[k] = body[k];
  if (!Object.keys(fields).length) return null;
  const r = await coll.findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: { ...fields, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  const doc = r && (r.value || r); // 兼容驱动 v5/v6 返回结构
  return doc ? normId(doc) : null;
}

async function deleteJob(id) {
  const coll = await getJobsColl();
  if (!coll || !/^[0-9a-f]{24}$/i.test(id)) return 0;
  const r = await coll.deleteOne({ _id: new ObjectId(id) });
  return r.deletedCount;
}

// ===== WPS 问卷自动同步（2026-09-01）=====
// WPS 问卷题目文本 → 台账字段（关键词匹配；题目做 key、答案做 value）
const WPS_FIELD_MAP = [
  ['手机|电话|联系方式|联系号码|mobile|phone', 'phone'],
  ['邮箱|email|e-mail|电子邮箱|邮件', 'email'],
  ['性别', 'gender'],
  ['年龄|岁数', 'age'],
  ['学历|文化程度|教育背景|最高学历', 'educationLevel'],
  ['专业', 'major'],
  ['学校|院校|毕业院校|毕业学校', 'school'],
  ['工作年限|工作年数|工作经验|从业年限', 'experience'],
  ['期望薪资|期望工资|期望薪酬|期望月薪|期望待遇', 'expectSalary'],
  ['目前薪资|当前薪资|目前工资|现薪资|目前月薪', 'currentSalary'],
  ['到岗时间|到岗日期|可到岗|最快到岗', 'availableTime'],
  ['求职意向|应聘岗位|意向岗位|应聘职位|期望岗位|期望职位|意向职位', 'jobIntent'],
  ['英语|口语|外语水平', 'englishLevel'],
  ['自我介绍|自我评价|个人简介|个人介绍', 'selfIntro'],
  ['现居|居住地|所在城市|现住|居住城市', 'city'],
  ['证书|资格证|资质|持有证书', 'certificates'],
  ['一级部门', 'dept1'],
  ['二级部门|组别|条线', 'dept2'],
  ['内部备注|备注|其他说明|补充说明', 'wpsNotes'],
];

function mapWpsAnswers(flat) {
  const out = {};
  for (const [pat, key] of WPS_FIELD_MAP) {
    const re = new RegExp(pat, 'i');
    for (const [q, a] of Object.entries(flat || {})) {
      const val = (Array.isArray(a) ? a.join('；') : String(a == null ? '' : a)).trim();
      if (val && re.test(q) && out[key] === undefined) out[key] = val.slice(0, 300);
    }
  }
  return out;
}

// WPS 问卷提交 → talents：手机号 > 邮箱 > 姓名（唯一）去重，命中则补空缺字段，未命中则新建档
async function upsertFromWps({ name = '', email = '', phone = '', job = '', flat = {}, candidateId = '', submittedAt = new Date() }) {
  const coll = await getTalentsColl();
  if (!coll) throw Object.assign(new Error('数据库暂不可用'), { code: 'DB_DOWN' });
  name = String(name || '').trim();
  const m = mapWpsAnswers(flat);
  const answers = Object.entries(flat || {})
    .filter(([q]) => q && !/^answerContents/.test(q) && !/^(rid|formId|submitId|openId|userId|timestamp|createTime|updateTime|submitTime|event)$/i.test(q))
    .map(([q, a]) => ({ q: String(q).slice(0, 60), a: (Array.isArray(a) ? a.join('；') : String(a == null ? '' : a)).slice(0, 500) }))
    .slice(0, 40);
  if (!name) return { action: 'skipped', reason: 'no_name' };

  const tel = String(m.phone || phone || '').trim();
  const mail = String(m.email || email || '').trim();
  let doc = null;
  if (tel) doc = await coll.findOne({ phone: tel });
  if (!doc && mail) {
    doc = await coll.findOne({ email: { $regex: '^' + mail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', $options: 'i' } });
  }
  if (!doc && name) {
    const same = await coll.find({ name }).limit(2).toArray();
    if (same.length === 1) doc = same[0];
  }

  if (doc) {
    const patch = {};
    const fill = (k, v) => { if (v && !doc[k]) patch[k] = v; };
    fill('phone', tel); fill('email', mail);
    fill('gender', m.gender); fill('age', m.age);
    fill('experience', m.experience); fill('englishLevel', m.englishLevel);
    fill('certificates', m.certificates); fill('expectSalary', m.expectSalary);
    fill('currentSalary', m.currentSalary); fill('availableTime', m.availableTime);
    if (m.educationLevel && m.major && !doc.education) patch.education = `${m.educationLevel} · ${m.major}`.slice(0, 60);
    else fill('education', m.educationLevel);
    if (m.school && !(doc.education || '').includes(m.school)) {
      patch.education = ((patch.education || doc.education || '') + `（${m.school}）`).slice(0, 80);
    }
    fill('jobTitle', m.jobIntent || job);
    if (m.selfIntro && !doc.summary) patch.summary = m.selfIntro.slice(0, 300);
    if ((m.dept1 || m.dept2) && !doc.dept) patch.dept = [m.dept1, m.dept2].filter(Boolean).join(' / ').slice(0, 60);
    const notesAdd = [m.wpsNotes, m.city ? `现居：${m.city}` : ''].filter(Boolean).join('；');
    if (notesAdd && !doc.notes) patch.notes = notesAdd.slice(0, 200);
    const set = { wpsSyncedAt: submittedAt, updatedAt: new Date() };
    if (candidateId) set.wpsCandidateId = candidateId;
    Object.assign(set, patch);
    await coll.updateOne({ _id: doc._id }, {
      $set: set,
      $push: { history: { stage: doc.stage, note: `WPS 问卷提交，已同步（${answers.length} 项）`, at: submittedAt, by: 'WPS' } },
    });
    return { action: 'merged', talentId: doc._id.toString(), filled: Object.keys(patch) };
  }

  // 未命中 → 新建档（阶段=简历入库，渠道=WPS 问卷）
  const now = new Date();
  const docNew = {
    name, stage: 'resume', funnelStep: 0,
    history: [{ stage: 'resume', note: `WPS 问卷自动建档（${answers.length} 项信息）`, at: now, by: 'WPS' }],
    channel: 'WPS 问卷',
    wpsAnswers: answers, wpsSyncedAt: submittedAt,
    createdAt: now, updatedAt: now,
  };
  if (candidateId) docNew.wpsCandidateId = candidateId;
  if (tel) docNew.phone = tel;
  if (mail) docNew.email = mail;
  for (const [k, v] of Object.entries({
    gender: m.gender, age: m.age, experience: m.experience, englishLevel: m.englishLevel,
    certificates: m.certificates, expectSalary: m.expectSalary, currentSalary: m.currentSalary,
    availableTime: m.availableTime,
  })) { if (v) docNew[k] = v; }
  if (m.educationLevel || m.major) docNew.education = [m.educationLevel, m.major].filter(Boolean).join(' · ').slice(0, 60);
  if (m.school && docNew.education) docNew.education = (docNew.education + `（${m.school}）`).slice(0, 80);
  if (m.jobIntent || job) docNew.jobTitle = String(m.jobIntent || job).slice(0, 60);
  if (m.selfIntro) docNew.summary = m.selfIntro.slice(0, 300);
  if (m.dept1 || m.dept2) docNew.dept = [m.dept1, m.dept2].filter(Boolean).join(' / ').slice(0, 60);
  const notesNew = [m.wpsNotes, m.city ? `现居：${m.city}` : ''].filter(Boolean).join('；');
  if (notesNew) docNew.notes = notesNew.slice(0, 200);
  const r = await coll.insertOne(docNew);
  return { action: 'created', talentId: r.insertedId.toString(), filled: [] };
}

// ===== 面试结果快捷记录 =====
// round: 1|2  result: pass(通过→下一阶段) | fail(不通过→淘汰) | potential(待定→标记有机会)
async function recordInterviewResult(id, { round, result, note = '', by = '' }) {
  const coll = await getTalentsColl();
  if (!coll || !/^[0-9a-f]{24}$/i.test(id)) return null;
  if (![1, 2, '1', '2'].includes(round)) {
    throw Object.assign(new Error('面试轮次必须是 1 或 2'), { code: 'BAD_INPUT' });
  }
  if (!['pass', 'fail', 'potential'].includes(result)) {
    throw Object.assign(new Error('结果必须是 pass / fail / potential'), { code: 'BAD_INPUT' });
  }
  const r = Number(round);
  const cur = await coll.findOne({ _id: new ObjectId(id) });
  if (!cur) return null;
  const key = r === 1 ? 'interview1' : 'interview2';
  const resultLabel = result === 'pass' ? '通过' : result === 'fail' ? '不通过' : '待定';
  const today = new Date();
  const dstr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const iv = { ...(cur[key] || {}), result: resultLabel };
  if (!iv.date) iv.date = dstr;

  let stage;
  if (result === 'pass') stage = r === 1 ? 'wait2' : 'offer';
  else if (result === 'fail') stage = 'rejected';
  else stage = r === 1 ? 'i1done' : 'i2done';

  // 防阶段倒退：当前漏斗深度已超过目标阶段时只记结果、不改阶段（如二面待定时补记一面通过）
  if (result !== 'fail' && (STAGES[stage].step || 0) < (cur.funnelStep || 0)) stage = cur.stage;
  const newStep = Math.max(cur.funnelStep || 0, STAGES[stage].step);

  const set = { [key]: iv, stage, funnelStep: newStep, stageNote: note || '', updatedAt: today };
  set.flag = result === 'potential' ? 'potential' : ''; // 有机会标记 / 清除
  const histNote = `${r === 1 ? '一面' : '二面'}${resultLabel}${note ? '：' + note : ''}${result === 'potential' ? '（标记有机会）' : ''}`;
  await coll.updateOne({ _id: cur._id }, {
    $set: set,
    $push: { history: { stage, note: histNote, at: today, by } },
  });
  return getTalent(id);
}

// ===== 邀约联动：发邀约时给匹配候选人追加历史记录（不自动改阶段）=====
async function linkInvite({ name = '', email = '', phone = '' }, { jobTitle = '', mode = '', by = '' } = {}) {
  const coll = await getTalentsColl();
  if (!coll || !name) return null;
  const or = [];
  if (email) or.push({ email });
  if (phone) or.push({ phone });
  let doc = or.length ? await coll.findOne({ name, $or: or }) : null;
  if (!doc) {
    const same = await coll.find({ name }).limit(2).toArray();
    if (same.length === 1) doc = same[0];
  }
  if (!doc) return null;
  const note = `面试邀约邮件已发送${jobTitle ? '（' + jobTitle + '）' : ''}${mode ? ' · ' + mode : ''}`;
  await coll.updateOne({ _id: doc._id }, {
    $set: { lastInviteAt: new Date() },
    $inc: { inviteCount: 1 },
    $push: { history: { stage: doc.stage, note, at: new Date(), by } },
  });
  return doc._id.toString();
}

// ===== 数据分析聚合（来源/渠道/学历/经验/月度趋势）=====
function classifyEdu(s) {
  s = String(s || '');
  if (/博士/.test(s)) return '博士';
  if (/硕士|研究生/.test(s)) return '硕士';
  if (/本科|学士/.test(s)) return '本科';
  if (/大专|专科/.test(s)) return '大专';
  if (/中专|中职|高中|中学/.test(s)) return '高中及以下';
  return '未填写';
}
function classifyExp(s) {
  s = String(s || '');
  if (!s.trim()) return '未填写';
  // 1) 明确的「N年（工作）经验」写法
  const m = s.match(/(\d{1,2})\s*年/);
  let y = m ? parseInt(m[1], 10) : 0;
  // 2) 完整履历文本（多段「2023.03-至今 xxx」）：按最早年份估算总年限
  if (!y) {
    const nowY = new Date().getFullYear();
    const years = [...s.matchAll(/(?:19|20)\d{2}/g)].map(x => parseInt(x[0], 10))
      .filter(v => v >= 1990 && v <= nowY);
    if (years.length) y = Math.max(0, nowY - Math.min(...years));
  }
  if (y) {
    if (y < 3) return '1-2年';
    if (y < 5) return '3-4年';
    if (y < 10) return '5-9年';
    return '10年以上';
  }
  // 3) 无年份信号：关键词兜底
  if (/应届|在校|实习/.test(s)) return '应届生';
  return '其他';
}
async function analytics() {
  const coll = await getTalentsColl();
  if (!coll) return { total: 0, source: [], channel: [], education: [], experience: [], monthly: [] };
  const docs = await coll.find({}, {
    projection: { source: 1, channel: 1, education: 1, experience: 1, createdAt: 1 },
  }).toArray();
  const srcMap = {}, chMap = {}, eduMap = {}, expMap = {}, monMap = {};
  const bump = (m, k) => { m[k] = (m[k] || 0) + 1; };
  for (const d of docs) {
    bump(srcMap, (d.source || '').trim() || '未填写');
    bump(chMap, (d.channel || '').trim() || '未填写');
    bump(eduMap, classifyEdu(d.education));
    bump(expMap, classifyExp(d.experience));
    const dt = d.createdAt instanceof Date ? d.createdAt : (d.createdAt ? new Date(d.createdAt) : null);
    if (dt && !isNaN(dt.getTime())) bump(monMap, `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`);
  }
  const toArr = (m) => Object.entries(m).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
  const monthly = Object.entries(monMap).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, count]) => ({ label, count }));
  return {
    total: docs.length,
    source: toArr(srcMap).slice(0, 8),
    channel: toArr(chMap).slice(0, 8),
    education: toArr(eduMap),
    experience: toArr(expMap),
    monthly,
  };
}

module.exports = {
  STAGES, STAGE_KEYS, FUNNEL_STEPS, stageLabel,
  listTalents, getTalent, createTalent, updateTalent, moveStage, deleteTalent,
  saveResumeFile, findResumeFile,
  funnelStats,
  listJobs, createJob, updateJob, deleteJob,
  upsertFromWps, recordInterviewResult, linkInvite, analytics,
};
