// 邮件文案生成（与本地 send_invite.py 保持 1:1 口径）
// 2026-08-29 起：对外邀约邮件署明主体「明越速（慧视）」并加粗（用户确认）
// 其余仍用通用表述：地址写"公司总部"、签名写"人力资源部"，不出现其他品牌名

const WEEKDAYS_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 邀约主体（署名公司）。可用环境变量 BRAND_NAME 覆盖
const BRAND = process.env.BRAND_NAME || '明越速（慧视）';

const DEFAULTS = {
  address: '深圳市福田区富德生命保险大厦 1103（公司总部）',
  access: '抵达大厦后在一楼前台出示身份证登记，说明来访事由"面试"，乘电梯至 11 层即可。',
  interviewers: '面试详情现场沟通',
  duration: '1 小时',
  time: '14:00',
};

function deadlineClause(deadline) {
  const d = (deadline || '').trim();
  if (!d) return '';
  return `请于 ${d}${d.endsWith('前') ? '' : '前'}`;
}

function weekdayOf(date) {
  if (!date) return '';
  const d = new Date(date + 'T00:00:00');
  if (isNaN(d)) return '';
  return WEEKDAYS_CN[d.getDay()];
}

function buildEmail(data) {
  const name = (data.name || '').trim();
  const email = (data.email || '').trim();
  const job = (data.job || '').trim();
  if (!name) throw new Error('候选人姓名不能为空');
  if (!email) throw new Error('候选人邮箱不能为空');
  if (!job) throw new Error('应聘岗位不能为空');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('候选人邮箱格式不正确');
  if (!data.date) throw new Error('面试日期不能为空');

  const mode = data.mode === 'online' ? 'online' : 'offline';
  const weekday = (data.weekday || '').trim() || weekdayOf(data.date);
  const dateStr = weekday ? `${data.date}（${weekday}）` : data.date;
  const time = data.time || DEFAULTS.time;
  const duration = data.duration || DEFAULTS.duration;
  const deadline = deadlineClause(data.deadline);
  const extra = (data.extra || '').trim();

  // 供 HTML 版复用的结构化字段
  const ctx = {
    name, job, mode, dateStr, time, duration, deadline, extra,
    rows: [], tips: [], lead: '', title: '', brand: BRAND,
  };

  if (mode === 'online') {
    subject = `【面试邀请（线上）】${job} - ${name}`;
    ctx.title = '线上面试邀约';
    ctx.lead = `感谢您的关注。考虑到您目前所在地，本次 <b>${BRAND}</b> <b>${job}</b> 岗位的面试将采用线上形式，安排如下：`;
    ctx.rows = [
      ['面试时间', `${dateStr} ${time}，预计 ${duration}`],
      ['面试形式', '腾讯会议（视频面试）'],
    ];
    if (data.meetLink) ctx.rows.push(['会议链接', data.meetLink]);
    if (data.meetId) ctx.rows.push(['会议号', `${data.meetId}（亦可在腾讯会议 App 首页选择"加入会议"输入）`]);
    ctx.tips = [
      '请提前 5-10 分钟下载腾讯会议并测试摄像头、麦克风及网络环境；',
      '请选择安静、光线充足的独立空间；',
      '着装整洁得体即可，无需穿着正装；',
    ];
    if (deadline) ctx.tips.push(`如时间不便，${deadline}回复本邮件改期。`);

    body =
`${name}，您好：

感谢您的关注。考虑到您目前所在地，本次 ${BRAND} ${job} 岗位的面试将采用线上形式，安排如下：

面试时间：${dateStr} ${time}，预计 ${duration}
面试形式：腾讯会议（视频面试）
${data.meetLink ? `会议链接：${data.meetLink}\n` : ''}${data.meetId ? `会议号：${data.meetId}（亦可在腾讯会议 App 首页选择"加入会议"输入）\n` : ''}
温馨提示：
1. 请提前 5-10 分钟下载腾讯会议并测试摄像头、麦克风及网络环境；
2. 请选择安静、光线充足的独立空间；
3. 着装整洁得体即可，无需穿着正装；
${deadline ? `4. 如时间不便，${deadline}回复本邮件改期。\n` : ''}${extra ? `\n${extra}\n` : ''}
期待与您见面！

${BRAND}
人力资源部`;
  } else {
    const address = (data.address || '').trim() || DEFAULTS.address;
    const access = (data.access || '').trim() || DEFAULTS.access;
    const contact = (data.contact || '').trim();
    const phone = (data.phone || '').trim();
    const interviewers = (data.interviewers || '').trim() || DEFAULTS.interviewers;
    const hr = (data.hr || '').trim();

    subject = `【面试邀请】${job} - ${name}`;

    ctx.title = '面试邀约';
    ctx.lead = `感谢您的关注。经初步沟通，我们诚挚邀请您参加 <b>${BRAND}</b> <b>${job}</b> 岗位的面试，安排如下：`;
    ctx.rows = [
      ['面试时间', `${dateStr} ${time}，预计 ${duration}`],
      ['面试地点', address],
      ['门禁指引', access],
    ];
    if (contact) ctx.rows.push(['到场联系人', `${contact}${phone ? `，${phone}` : ''}（如需改期或到达后找不到路，请直接联系）`]);
    ctx.rows.push(['着装提示', '整洁得体即可，无需穿着正装']);
    ctx.rows.push(['面试环节', interviewers]);
    ctx.tips = [
      '请携带身份证用于一楼前台登记；',
      '建议提前 10 分钟到达，预留登记与等候时间；',
      '如临时有变，请尽早联系到场联系人；',
    ];
    if (deadline) ctx.tips.push(`如时间不便，${deadline}回复本邮件${hr ? `或联系 ${hr}` : ''}改期。`);

    body =
`${name}，您好：

感谢您的关注。经初步沟通，我们诚挚邀请您参加 ${BRAND} ${job} 岗位的面试，安排如下：

面试时间：${dateStr} ${time}，预计 ${duration}
面试地点：${address}
门禁指引：${access}
${contact ? `到场联系人：${contact}${phone ? `，${phone}` : ''}（如需改期或到达后找不到路，请直接联系）\n` : ''}着装提示：整洁得体即可，无需穿着正装

本次面试环节：${interviewers}。
${deadline ? `如时间不便，${deadline}回复本邮件${hr ? `或联系 ${hr}` : ''}改期。\n` : ''}${extra ? `\n${extra}\n` : ''}
期待与您见面！

${BRAND}
人力资源部`;
  }

  return { subject, body, ctx };
}


// ===== HTML 排版正文（对标录用通知邮件视觉）=====
// 邮件客户端兼容性：只用 table 布局 + 内联样式，不用 flex/grid/外部 CSS
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildHtml(ctx) {
  const rowsHtml = ctx.rows.map(([label, value], i) => {
    const bg = i % 2 === 0 ? '#FFFFFF' : '#FFF9F7';
    return (
      `<tr><td style="padding:10px 14px;background:${bg};color:#9A8B90;font-size:13px;`
      + `width:88px;vertical-align:top;white-space:nowrap;border-bottom:1px solid #FBEDEF;">${esc(label)}</td>`
      + `<td style="padding:10px 14px;background:${bg};color:#1F1F1F;font-size:14px;`
      + `line-height:1.7;border-bottom:1px solid #FBEDEF;">${esc(value)}</td></tr>`
    );
  }).join('');

  const tipsHtml = ctx.tips.map((t, i) =>
    `<tr><td style="padding:4px 0;color:#5A4E52;font-size:14px;line-height:1.8;">`
    + `<span style="color:#D8553F;font-weight:600;">${i + 1}.</span>&nbsp;${esc(t)}</td></tr>`
  ).join('');

  const extraHtml = ctx.extra
    ? `<tr><td style="padding:4px 0;color:#1F1F1F;font-size:14px;line-height:1.8;">${esc(ctx.extra)}</td></tr>`
    : '';

  const FONT = `-apple-system,'PingFang SC','Microsoft YaHei',sans-serif`;

  return `<div style="margin:0;padding:0;background:#FFFFFF;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF;">
<tr><td style="height:8px;line-height:8px;font-size:0;background:#FBE9EF;">&nbsp;</td></tr>
<tr><td align="center" style="padding:0 12px;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:620px;">

<tr><td style="padding:32px 8px 0;">
  <div style="font-size:11px;letter-spacing:4px;color:#D8553F;font-weight:600;font-family:${FONT};">INTERVIEW · 面 试 邀 约</div>
</td></tr>

<tr><td style="padding:10px 8px 0;">
  <div style="font-size:26px;font-weight:700;color:#111111;letter-spacing:1px;line-height:1.3;font-family:${FONT};">${esc(ctx.title)}</div>
</td></tr>

<tr><td style="padding:12px 8px 0;">
  <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#F4A89B;"></span>
  <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#F4A89B;margin-left:6px;"></span>
  <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#F4A89B;margin-left:6px;"></span>
</td></tr>

<tr><td style="padding:8px 8px 0;">
  <div style="font-size:11px;color:#AAAAAA;letter-spacing:2px;font-family:${FONT};">HR · INTERVIEW · INVITATION</div>
</td></tr>

<tr><td style="padding:22px 8px 0;">
  <div style="height:1px;line-height:1px;font-size:0;background:#F3E7EB;">&nbsp;</div>
</td></tr>

<tr><td style="padding:22px 8px 0;">
  <div style="font-size:15px;color:#1F1F1F;line-height:1.9;font-family:${FONT};">
    ${esc(ctx.name)}，您好：<br><br>${ctx.lead}
  </div>
</td></tr>

<tr><td style="padding:18px 8px 0;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-left:4px solid #D8553F;background:#FFF5F2;border-radius:3px;">
    <tr><td style="padding:6px 14px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">${rowsHtml}</table>
    </td></tr>
  </table>
</td></tr>

<tr><td style="padding:24px 8px 0;">
  <div style="font-size:13px;letter-spacing:2px;color:#D8553F;font-weight:600;margin-bottom:8px;font-family:${FONT};">温 馨 提 示</div>
  <table width="100%" cellpadding="0" cellspacing="0" border="0">${tipsHtml}${extraHtml}</table>
</td></tr>

<tr><td style="padding:30px 8px 0;">
  <div style="height:1px;line-height:1px;font-size:0;background:#F3E7EB;">&nbsp;</div>
</td></tr>

<tr><td style="padding:18px 8px 28px;">
  <div style="font-size:15px;color:#1F1F1F;line-height:1.9;font-family:${FONT};">
    期待与您见面！<br><br>
    <span style="font-weight:700;">${esc(ctx.brand)}</span><br>
    <span style="font-weight:700;">人力资源部</span>
  </div>
  <div style="font-size:11px;color:#AAAAAA;letter-spacing:2px;margin-top:6px;font-family:${FONT};">HUMAN RESOURCES</div>
</td></tr>

</table>
</td></tr>
</table>
</div>`;
}


module.exports = { buildEmail, buildHtml, DEFAULTS };
