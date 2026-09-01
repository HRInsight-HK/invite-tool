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

module.exports = {
  STAGES, STAGE_KEYS, FUNNEL_STEPS, stageLabel,
  listTalents, getTalent, createTalent, updateTalent, moveStage, deleteTalent,
  saveResumeFile, findResumeFile,
  funnelStats,
  listJobs, createJob, updateJob, deleteJob,
};
