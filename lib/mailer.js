// SMTP 直发：默认用 Resend（Render 可连通），发件人显示名"人力资源部"
// 若用户想继续用 exmail，可通过 Render 环境变量 SMTP_HOST/SMTP_PORT/SMTP_USER 覆盖
const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.resend.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10);
const SMTP_USER = process.env.SMTP_USER || 'resend';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || '人力资源部';
const SMTP_FROM_ADDR = process.env.SMTP_FROM_ADDR || (SMTP_HOST.includes('resend') ? 'onboarding@resend.dev' : 'HR_Support@insightelectionhk.com');

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

async function sendMail({ to, subject, body }) {
  try {
    const info = await getTransporter().sendMail({
      from: `"${SMTP_FROM_NAME}" <${SMTP_FROM_ADDR}>`,
      to,
      subject,
      text: body,
    });
    return { messageId: info.messageId || '', from: SMTP_FROM_ADDR };
  } catch (err) {
    const wrapped = new Error(`邮件发送失败：${err.message || err} [${describeErr(err)}]`);
    wrapped.code = err.code || 'SEND_FAILED';
    wrapped.cause = err;
    throw wrapped;
  }
}

module.exports = { sendMail, smtpConfigured, describeErr };
