// 简历 AI 识别（规则引擎）：PDF / DOCX / TXT → 结构化台账字段
// 定位：服务端零外呼、零成本的中文简历解析引擎（正则 + 关键词 + 分段启发），
//       识别不到的字段留给 HR 手动补，识别结果仅供参考、保存前需人工核对。
// 依赖 mammoth（docx）与 pdf-parse（pdf）均为懒加载：装包失败不影响服务启动。
//
// 输出字段全部命中 talents 白名单：name/gender/age/education/experience/jobTitle/
//   expectSalary/currentSalary/availableTime/englishLevel/certificates/summary/email/phone

let _mammoth = null;
function getMammoth() {
  if (_mammoth === null) {
    try { _mammoth = require('mammoth'); } catch (e) { _mammoth = false; }
  }
  return _mammoth;
}
let _pdfParse = null;
function getPdfParse() {
  if (_pdfParse === null) {
    try { _pdfParse = require('pdf-parse'); } catch (e) { _pdfParse = false; }
  }
  return _pdfParse;
}

function err(msg, code) { return Object.assign(new Error(msg), { code }); }

// ===== 文本提取 =====
async function extractText(buffer, filename) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (ext === 'pdf') {
    const fn = getPdfParse();
    if (!fn) throw err('PDF 解析组件未就绪（服务器未完成依赖安装），请稍后再试', 'UNSUPPORTED');
    const r = await fn(buffer);
    return String(r && r.text || '');
  }
  if (ext === 'docx') {
    const mm = getMammoth();
    if (!mm) throw err('DOCX 解析组件未就绪（服务器未完成依赖安装），请稍后再试', 'UNSUPPORTED');
    const r = await mm.extractRawText({ buffer });
    return String(r && r.value || '');
  }
  if (ext === 'txt') return buffer.toString('utf8');
  if (ext === 'doc' || ext === 'wps') {
    throw err('旧版 .doc/.wps 无法在线识别：请用 WPS/Word 另存为 .docx 或 PDF 再上传（文件仍会存档）', 'UNSUPPORTED');
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'].includes(ext)) {
    throw err('图片简历暂不支持在线识别：请转成 PDF 后再试（文件仍会存档）', 'UNSUPPORTED');
  }
  throw err('暂不支持该格式，AI 识别支持 PDF / DOCX / TXT', 'UNSUPPORTED');
}

// ===== 字段解析 =====
function parseResumeText(rawText) {
  const text = String(rawText || '');
  // PDF 提取常在中文之间插单个空格：只压「CJK + 单个空格/tab + CJK」，保留换行与多空格（字段分隔）
  const nz = text
    .replace(/([\u4e00-\u9fa5，。：；、（）【】·])[ \t\u3000](?=[\u4e00-\u9fa5，。：；、（）【】·])/g, '$1');
  const fields = {};
  const hit = (k, v) => { if (v && !fields[k]) fields[k] = v; };
  const clean = (s) => String(s || '').replace(/^[\s:：、·\-—]+|[\s:：，,。；;、·]+$/g, '');

  // --- 姓名 ---
  let m = nz.match(/姓\s*名\s*[:：]?\s*([\u4e00-\u9fa5·]{2,4})(?![\u4e00-\u9fa5])/);
  if (!m) {
    // 开头即「李强，」式：名字 + 标点
    m = nz.match(/^([\u4e00-\u9fa5·]{2,4})\s*[，,、]/);
  }
  if (!m) {
    const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
    const cand = lines.slice(0, 5).map(s => s.replace(/个人简历|简历|的/g, '').trim())
      .find(s => /^[\u4e00-\u9fa5·]{2,4}$/.test(s));
    if (cand) m = [null, cand];
  }
  hit('name', m && m[1]);

  // --- 电话 / 邮箱 ---
  hit('phone', (nz.match(/1[3-9]\d{9}/) || [])[0]);
  hit('email', (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [])[0]);

  // --- 性别 ---
  let g = (nz.match(/性\s*别\s*[:：]?\s*(男|女)/) || [])[1];
  if (!g) g = (nz.match(/(男|女)\s*[·\/,，、]\s*(?:\d{2}\s*岁|[12][09]\d{2})/) || [])[1];
  if (!g) g = (nz.match(/^[，,]?\s*(男|女)\s*[，,、]/m) || [])[1];
  hit('gender', g);

  // --- 年龄 ---
  let age = (nz.match(/(\d{2})\s*岁/) || [])[1];
  if (!age) {
    let by = (nz.match(/(?:出生|生日|生于)\s*[（(]?[^)）]{0,8}[)）]?\s*[:：]?\s*((?:19|20)\d{2})/) || [])[1];
    if (!by) by = (nz.match(/((?:19|20)\d{2})\s*年?\s*出生/) || [])[1];
    if (!by) by = (nz.match(/^.*?((?:19|20)\d{2})\s*年?\s*生[，,。]/m) || [])[1];
    if (by) age = String(Math.max(16, new Date().getFullYear() - parseInt(by, 10)));
  }
  hit('age', age);

  // --- 学历（取最高）+ 专业 ---
  const EDU = ['博士', '硕士', '研究生', '本科', '学士', '大专', '专科', '中专', '高中'];
  const eduHit = EDU.find(e => nz.includes(e));
  let major = (nz.match(/专\s*业\s*[:：]?\s*([\u4e00-\u9fa5A-Za-z（）()]{2,20})/) || [])[1];
  if (major) {
    major = major.replace(/(学院|大学|毕业|学历|本科|大专|专科|硕士|研究生|博士|至今|主修|方向|应届)+$/g, '').trim() || null;
  }
  if (eduHit && major) hit('education', `${eduHit === '研究生' ? '硕士' : eduHit} · ${major}`);
  else if (eduHit) hit('education', eduHit === '研究生' ? '硕士' : eduHit);
  else if (major) hit('education', major);

  // --- 工作经验 ---
  let wy = (nz.match(/(\d{1,2})\s*年(?:以上)?[^\n。；;]{0,12}经验/) || [])[1];
  if (!wy) wy = (nz.match(/工作(?:年限|经验|年数)\s*[:：]?\s*(\d{1,2})/) || [])[1];
  if (wy) hit('experience', `${wy}年工作经验`);
  else if (/应届|在校生|实习生/.test(nz)) hit('experience', '应届毕业生');

  // --- 求职意向 ---
  hit('jobTitle', clean((nz.match(/(?:求职意向|应聘岗位|应聘职位|意向岗位|期望职位|期望岗位|应聘)\s*[:：]?\s*([^\s，,；;。/／\|]{2,20})/) || [])[1]));

  // --- 薪资 / 到岗 ---
  hit('expectSalary', clean((nz.match(/(?:期望|希望)(?:的)?(?:薪资|薪酬|工资|待遇|月薪|年薪|薪水)\s*[:：]?\s*([^\s，,；;。\n]{1,15})/) || [])[1]));
  hit('currentSalary', clean((nz.match(/(?:目前|当前|现)(?:的)?(?:薪资|薪酬|工资|待遇|月薪|年薪|薪水)\s*[:：]?\s*([^\s，,；;。\n]{1,15})/) || [])[1]));
  hit('availableTime', clean((nz.match(/(?:到岗|到职|入职)(?:时间|日期)?\s*[:：]?\s*([^\s，,；;。\n]{1,15})/) || [])[1]));

  // --- 英语 / 证书 ---
  const CERTS = ['专业八级', '专业四级', 'CET-6', 'CET6', 'CET-4', 'CET4', '英语六级', '英语四级', '英语四六级',
    '雅思', 'IELTS', '托福', 'TOEFL', 'BEC', '教师资格证', '注册会计师', 'CPA', '初级会计', '中级会计',
    '人力资源管理师', '普通话二甲', '法律职业资格', 'PMP', '软考', '计算机二级', '证券从业', '基金从业', '驾驶证', '驾照'];
  let certHits = CERTS.filter(c => new RegExp(c.replace(/-/g, '[-—–]?'), 'i').test(nz));
  // 同义去重：CET-6 已含英语六级，CET-4 已含英语四级
  if (certHits.includes('CET-6')) certHits = certHits.filter(c => !['英语六级', '英语四六级'].includes(c));
  if (certHits.includes('CET-4')) certHits = certHits.filter(c => !['英语四级', '英语四六级'].includes(c));
  if (certHits.length) hit('certificates', [...new Set(certHits)].slice(0, 5).join('、'));
  const oral = (nz.match(/口语\s*[:：]?\s*(流利|良好|熟练|一般|优秀)/) || [])[1];
  if (oral) hit('englishLevel', `口语${oral}`);
  else {
    const engCert = certHits.find(c => /CET|英语|雅思|IELTS|托福|TOEFL|BEC/i.test(c));
    if (engCert) hit('englishLevel', engCert);
  }

  // --- 摘要：自我评价 > 最近公司+技能关键词 ---
  let sum = (nz.match(/自我(?:评价|介绍|描述)\s*[:：]?\s*\n?([\s\S]{10,200}?)(?=\n\s*\n|[【\[]|\n\s*(?:工作|教育|项目|实习|技能|证书|荣誉|培训)|$)/) || [])[1];
  if (sum) sum = sum.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!sum) {
    const company = (nz.match(/([\u4e00-\u9fa5A-Za-z0-9（）()]{2,18}(?:有限公司|股份有限公司|集团公司|电子商务)[\u4e00-\u9fa5A-Za-z0-9（）()]{0,12})/) || [])[1];
    const SKILLS = ['跨境电商', '电商运营', '亚马逊', 'Amazon', '速卖通', 'AliExpress', 'Shopee', 'TikTok', '海外仓',
      '外贸', '跟单', '采购', '供应链', '数据分析', 'Excel', 'SQL', 'Python', 'Java', '前端', '后端',
      '平面设计', 'UI', '视频剪辑', '新媒体', '私域', '社群', '销售', '大客户', '客服',
      '行政管理', '人力资源', '招聘', '薪酬', '考勤', '会计', '出纳', '税务', '粤语', '英语', '日语', '韩语'];
    const sk = SKILLS.filter(s => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(nz)).slice(0, 6);
    const parts = [];
    if (company) parts.push(`最近任职：${company}`);
    if (sk.length) parts.push(`技能：${sk.join('、')}`);
    sum = parts.join('；').slice(0, 120);
  }
  hit('summary', sum || undefined);

  const matched = Object.keys(fields).length;
  return {
    fields,
    matched,
    textPreview: text.replace(/\s{3,}/g, ' ').trim().slice(0, 500),
  };
}

module.exports = { extractText, parseResumeText };
