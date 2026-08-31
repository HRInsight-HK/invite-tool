// SMTP 直发：默认用 Resend（Render 可连通），发件人显示名"人力资源部"
// 若用户想继续用 exmail，可通过 Render 环境变量 SMTP_HOST/SMTP_PORT/SMTP_USER 覆盖
//
// 通道优先级（2026-08-31）：
//   1. BREVO_API_KEY     → Brevo HTTP API（sender 邮箱验证即可发任意收件人，无需 DNS）
//   2. SMTP_HOST 含 resend（默认） → Resend HTTP API
//      ⚠️ Resend 免费版 onboarding@resend.dev 只能发给注册邮箱自己，外网收件人会被 403
//   3. 其他 SMTP_HOST    → nodemailer SMTP（Render 封 465/587/25，基本走不通）
//
// ⚠️ Brevo 发件人最终结论（2026-08-31 21:30 定案）：
//   - hr_support@insightelectionhk.com 的邮箱验证【已完成】（验证码 904422，active=true），
//     但 Brevo 对自定义域名发件人还有域名认证关卡：insightelectionhk.com 必须发布
//     SPF/DKIM 记录指向 Brevo 才允许实际发信。实测 21:23/21:26 两封均被拒：
//     "sender is not valid. Validate your sender or authenticate your domain"。
//     域名 DNS 无权限改（用户无 IT 支持），此路不通。
//   - hkinsight.hr@gmail.com（Brevo 账号邮箱）：freemail 域名无需域名认证，
//     实测 delivered+opened 全通，是【唯一可用发件人】。
//   - 显示名"人力资源部" + Reply-To=HR_Support，候选人看到的是
//     "人力资源部 <hkinsight.hr@gmail.com>"，点回复进企微公共邮箱。
//   - 如未来接管了域名 DNS（加 Brevo SPF/DKIM），设 Render 环境变量
//     BREVO_SENDER=HR_Support@insightelectionhk.com 即可一键切回。
const nodemailer = require('nodemailer');

const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.resend.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10);
const SMTP_USER = process.env.SMTP_USER || 'resend';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || '人力资源部';
// Brevo 通道发件人：唯一可用 = 已验证的 Gmail（自定义域名 hr_support 被域名认证关卡挡住）
const BREVO_SENDER = process.env.BREVO_SENDER || 'hkinsight.hr@gmail.com';
// Resend / SMTP 通道的发件人（Brevo 通道不使用）
const SMTP_FROM_ADDR = process.env.SMTP_FROM_ADDR || (
  SMTP_HOST.includes('resend') ? 'onboarding@resend.dev' : 'HR_Support@insightelectionhk.com'
);
// 候选人点"回复"时投到的地址（用人资对外邮箱，候选人回信进企微公共邮箱）
const REPLY_TO = process.env.REPLY_TO || 'HR_Support@insightelectionhk.com';

let transporter = null;

function smtpConfigured() {
  return !!SMTP_PASS;
}

function getTransporter() {
  if (!smtpConfigured()) {
    const err = new Error('SMTP 未配置：请在 Render 环境变量中设置 SMTP_PASS（Resend API key 或 SMTP 密码）');
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      connectionTimeout: 15000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
  }
  return transporter;
}

function describeErr(err) {
  return [
    `code=${err.code || '-'}`,
    `errno=${err.errno || '-'}`,
    `syscall=${err.syscall || '-'}`,
    `address=${err.address || '-'}`,
    `port=${err.port || '-'}`,
  ].join(' ');
}

// 判断当前是否走 Resend（Render 免费层屏蔽 SMTP 端口 465/587/25，
// 所以 Resend 必须走 HTTP API 而不是 SMTP）
function isResend() {
  return (process.env.SMTP_HOST || 'smtp.resend.com').includes('resend');
}

// Brevo HTTP API（443 端口，Render 可用）
// 特点：只要在 Brevo 后台验证过 sender 邮箱（HR_Support 收一封验证邮件点链接），
// 就能给任意收件人（163/qq/gmail）发信，不需要改域名 DNS。
async function sendViaBrevoApi({ to, subject, body, html }) {
  const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': BREVO_API_KEY,
      'Content-Type': 'application/json',
      'accept': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: SMTP_FROM_NAME, email: BREVO_SENDER },
      to: Array.isArray(to) ? to.map(e => ({ email: e })) : [{ email: to }],
      subject,
      textContent: body,
      ...(html ? { htmlContent: html } : {}),
      replyTo: { email: REPLY_TO },
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(`Brevo API ${resp.status}: ${data.message || data.code || JSON.stringify(data)}`);
    err.code = 'BREVO_API_FAIL';
    throw err;
  }
  return { messageId: data.messageId || data.messageId?.toString() || '', from: BREVO_SENDER };
}

// Resend HTTP API（走 443，绕过 Render SMTP 端口封锁）
async function sendViaResendApi({ to, subject, body, html }) {
  const payload = {
    from: `${SMTP_FROM_NAME} <${SMTP_FROM_ADDR}>`,
    to: Array.isArray(to) ? to : [to],
    subject,
    // 同时提供 text 与 html：客户端不支持 HTML 时自动回退纯文本
    text: body,
    reply_to: REPLY_TO,
  };
  if (html) payload.html = html;
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SMTP_PASS}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(`Resend API ${resp.status}: ${data.message || data.error || JSON.stringify(data)}`);
    err.code = 'RESEND_API_FAIL';
    throw err;
  }
  return { messageId: data.id || '', from: SMTP_FROM_ADDR };
}

async function sendMail({ to, subject, body, html }) {
  // 优先 Brevo（能发任意收件人），其次 Resend HTTP API，最后 SMTP
  if (BREVO_API_KEY) {
    try {
      return await sendViaBrevoApi({ to, subject, body, html });
    } catch (err) {
      const wrapped = new Error(`邮件发送失败：${err.message}`);
      wrapped.code = err.code || 'SEND_FAILED';
      wrapped.cause = err;
      throw wrapped;
    }
  }
  // Resend 走 HTTP API；其他服务商走 SMTP
  if (isResend()) {
    try {
      return await sendViaResendApi({ to, subject, body, html });
    } catch (err) {
      const wrapped = new Error(`邮件发送失败：${err.message}`);
      wrapped.code = err.code || 'SEND_FAILED';
      wrapped.cause = err;
      throw wrapped;
    }
  }
  try {
    const info = await getTransporter().sendMail({
      from: `"${SMTP_FROM_NAME}" <${SMTP_FROM_ADDR}>`,
      to,
      subject,
      text: body,
      html: html || undefined,
      replyTo: REPLY_TO,
    });
    return { messageId: info.messageId || '', from: SMTP_FROM_ADDR };
  } catch (err) {
    const wrapped = new Error(`邮件发送失败：${err.message || err} [${describeErr(err)}]`);
    wrapped.code = err.code || 'SEND_FAILED';
    wrapped.cause = err;
    throw wrapped;
  }
}

module.exports = { sendMail, smtpConfigured, describeErr, getTransporter };
