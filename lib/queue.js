// 队列写入（云端 /send 收到请求后入队，不再直接发邮件）
// 数据存到 Atlas invite_tool.pending 集合；本地 worker 轮询后调用 wecom-cli 发送
const { ObjectId } = require('mongodb');
const { getDb } = require('./store');

async function enqueue(item) {
  const db = await getDb();
  if (!db) {
    const err = new Error('队列服务不可用：MONGODB_URI 未配置或连接失败');
    err.code = 'QUEUE_UNAVAILABLE';
    throw err;
  }
  const col = db.collection('pending');
  const doc = {
    ...item,
    status: 'pending',
    createdAt: new Date(),
    attempts: 0,
  };
  const r = await col.insertOne(doc);
  return { id: r.insertedId.toString(), status: 'pending' };
}

function toOid(id) {
  try { return new ObjectId(id); } catch (e) { return null; }
}

async function markProcessing(id) {
  const db = await getDb();
  if (!db) return;
  const oid = toOid(id);
  if (!oid) return;
  await db.collection('pending').updateOne(
    { _id: oid },
    { $set: { status: 'processing', processingAt: new Date() } }
  );
}

async function markDone(id, result) {
  const db = await getDb();
  if (!db) return;
  const oid = toOid(id);
  if (!oid) return;
  await db.collection('pending').updateOne(
    { _id: oid },
    { $set: { status: 'done', doneAt: new Date(), result } }
  );
}

async function markFailed(id, error) {
  const db = await getDb();
  if (!db) return;
  const oid = toOid(id);
  if (!oid) return;
  await db.collection('pending').updateOne(
    { _id: oid },
    { $set: { status: 'failed', failedAt: new Date(), error: String(error) } }
  );
}

async function listPending(limit = 50) {
  const db = await getDb();
  if (!db) return [];
  return await db.collection('pending')
    .find({ status: 'pending' })
    .sort({ createdAt: 1 })
    .limit(limit)
    .toArray();
}

// 本地 worker 心跳（2026-09-01）：worker 每 10s 向 invite_tool.heartbeat 集合写 ts
// 云端据此判断 worker 在不在线——发送一律走 worker（发件人=HR_Support@insightelectionhk.com）
const WORKER_HEARTBEAT_MS = 2 * 60 * 1000;  // 2 分钟内有心跳视为在线

async function workerStatus(maxAgeMs = WORKER_HEARTBEAT_MS) {
  const db = await getDb();
  if (!db) return { alive: false, lastSeen: null, ageSec: null };
  try {
    const doc = await db.collection('heartbeat').findOne({ _id: 'local' });
    if (!doc || !doc.ts) return { alive: false, lastSeen: null, ageSec: null };
    const last = new Date(doc.ts);
    const age = Date.now() - last.getTime();
    return { alive: age <= maxAgeMs, lastSeen: last, ageSec: Math.round(age / 1000) };
  } catch (e) {
    return { alive: false, lastSeen: null, ageSec: null, error: e.message };
  }
}

module.exports = { enqueue, listPending, markProcessing, markDone, markFailed, workerStatus };
