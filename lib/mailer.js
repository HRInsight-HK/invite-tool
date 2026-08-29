// SMTP 直发（逻辑移植自实操台账 routes/invite.js，已验证的通道）
// 发件人：HR_Support@insightelectionhk.com，显示名"人力资源部"（对外脱敏）
const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.exmail.qq.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10);
const SMTP_USER = process.env.SMTP_USER || 'HR_Support@insightelectionhk.com';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || '人力资源部';

let transporter = null;

function smtpConfigured() {
  return !!SMTP_PASS;
}

function getTransporter() {
  if (!smtpConfigured()) {
    const err = new Error('SMTP 未配置：请在 Render 环境变量中设置 SMTP_PASS（HR_Support 邮箱的 SMTP 授权码）');
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      // Render 出口在 Singapore，exmail 可能在 IP 限流；缩短连接超时快速失败
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

async function sendMail({ to, subject, body }) {
  try {
    const info = await getTransporter().sendMail({
      from: `"${SMTP_FROM_NAME}" <${SMTP_USER}>`,
      to,
      subject,
      text: body,
    });
    return { messageId: info.messageId || '', from: SMTP_USER };
  } catch (err) {
    const wrapped = new Error(`邮件发送失败：${err.message || err} [${describeErr(err)}]`);
    wrapped.code = err.code || 'SEND_FAILED';
    wrapped.cause = err;
    throw wrapped;
  }
}

module.exports = { sendMail, smtpConfigured, describeErr };
