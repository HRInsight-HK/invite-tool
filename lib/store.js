// 发送台账存储（MongoDB Atlas，库 invite_tool，集合 logs）
// 存储失败不阻塞发送，仅记录错误日志
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI || '';
const DB_NAME = 'invite_tool';
const COLL = 'logs';

let client = null;
let coll = null;

async function getColl() {
  if (!MONGODB_URI) return null;
  if (coll) return coll;
  try {
    client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    coll = client.db(DB_NAME).collection(COLL);
    return coll;
  } catch (e) {
    console.error('[Store] MongoDB 连接失败（不影响发送，仅不记台账）:', e.message);
    return null;
  }
}

async function addLog(log) {
  try {
    const c = await getColl();
    if (!c) return false;
    await c.insertOne(log);
    return true;
  } catch (e) {
    console.error('[Store] 写台账失败:', e.message);
    return false;
  }
}

async function getLogs(limit = 50) {
  try {
    const c = await getColl();
    if (!c) return [];
    const docs = await c.find({}).sort({ sentAt: -1 }).limit(limit).toArray();
    return docs.map(d => ({
      id: d._id,
      to: d.to,
      candidateName: d.candidateName,
      jobTitle: d.jobTitle,
      mode: d.mode,
      subject: d.subject,
      sentBy: d.sentBy,
      sentAt: d.sentAt,
      messageId: d.messageId,
    }));
  } catch (e) {
    console.error('[Store] 读台账失败:', e.message);
    return [];
  }
}

async function closeDb() {
  if (client) {
    try { await client.close(); } catch (e) {}
  }
}

module.exports = { addLog, getLogs, closeDb };
