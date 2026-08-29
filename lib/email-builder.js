// 邮件文案生成（与本地 send_invite.py 保持 1:1 口径）
// 对外文案严禁公司品牌名（明越/速卓/慧视/Insight），一律通用表述

const WEEKDAYS_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

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

  let subject, body;

  if (mode === 'online') {
    subject = `【面试邀请（线上）】${job} - ${name}`;
    body =
`${name}，您好：

感谢您的关注。考虑到您目前所在地，本次 ${job} 的面试将采用线上形式，安排如下：

面试时间：${dateStr} ${time}，预计 ${duration}
面试形式：腾讯会议（视频面试）
${data.meetLink ? `会议链接：${data.meetLink}\n` : ''}${data.meetId ? `会议号：${data.meetId}（亦可在腾讯会议 App 首页选择"加入会议"输入）\n` : ''}
温馨提示：
1. 请提前 5-10 分钟下载腾讯会议并测试摄像头、麦克风及网络环境；
2. 请选择安静、光线充足的独立空间；
3. 着装整洁得体即可，无需穿着正装；
${deadline ? `4. 如时间不便，${deadline}回复本邮件改期。\n` : ''}${extra ? `\n${extra}\n` : ''}
期待与您见面！

人力资源部`;
  } else {
    const address = (data.address || '').trim() || DEFAULTS.address;
    const access = (data.access || '').trim() || DEFAULTS.access;
    const contact = (data.contact || '').trim();
    const phone = (data.phone || '').trim();
    const interviewers = (data.interviewers || '').trim() || DEFAULTS.interviewers;
    const hr = (data.hr || '').trim();

    subject = `【面试邀请】${job} - ${name}`;
    body =
`${name}，您好：

感谢您的关注。经初步沟通，我们诚挚邀请您参加 ${job} 的面试，安排如下：

面试时间：${dateStr} ${time}，预计 ${duration}
面试地点：${address}
门禁指引：${access}
${contact ? `到场联系人：${contact}${phone ? `，${phone}` : ''}（如需改期或到达后找不到路，请直接联系）\n` : ''}着装提示：整洁得体即可，无需穿着正装

本次面试环节：${interviewers}。
${deadline ? `如时间不便，${deadline}回复本邮件${hr ? `或联系 ${hr}` : ''}改期。\n` : ''}${extra ? `\n${extra}\n` : ''}
期待与您见面！

人力资源部`;
  }

  return { subject, body };
}

module.exports = { buildEmail, DEFAULTS };
