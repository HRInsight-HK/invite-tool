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

module.exports = { enqueue, listPending, markProcessing, markDone, markFailed };
