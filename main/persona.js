'use strict';

/**
 * 人设：把设置里的角色卡 + 当前场景 + 记忆拼成系统提示词。
 * 这里决定了"像不像个人"，比模型本身更影响体感。
 */

const memory = require('./memory');

function hourGreeting(h) {
  if (h < 5) return '凌晨';
  if (h < 11) return '上午';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  if (h < 23) return '晚上';
  return '深夜';
}

function buildSystem(cfg, ctx = {}) {
  const p = cfg.persona || {};
  const name = p.name || '小满';
  const call = p.callUser || '老板';
  const lines = [];

  lines.push(`你的名字是${name}。${p.style || ''}`);
  lines.push(`你叫他「${call}」。`);
  lines.push('你在语音里说话，所以只输出能直接念出来的内容：不用 Markdown、不用表情、不用括号描述动作、不写序号。');

  const notes = memory.snapshot().notes;
  if (notes.length) {
    lines.push(`关于他，你已经知道（自然使用，不要生硬复读）：${notes.slice(-10).join('；')}`);
  }

  const tops = memory.topGames(3).filter((g) => g.minutes >= 20);
  if (tops.length) {
    lines.push(
      `他常玩的游戏：${tops.map((g) => `${g.game}（累计约${g.minutes}分钟）`).join('、')}。`
    );
  }

  const h = new Date().getHours();
  lines.push(`现在是${hourGreeting(h)}${h}点。`);

  if (ctx.game) {
    lines.push(`他当前窗口是「${ctx.game}」，大概率在玩这个。${ctx.fullscreen ? '游戏是全屏的。' : ''}`);
  } else {
    lines.push('他现在不在游戏里，可能在桌面或者看网页。');
  }

  if (ctx.hasImage) {
    lines.push(
      '下面附了一张他现在的屏幕截图。先看清楚画面里到底有什么，只在能确定的地方开口；' +
        '看不清就说不确定，绝对不要编造画面里没有的细节。'
    );
  }

  lines.push('回复控制在两句话以内，除非他明确要你多说。像朋友插话，不要每次都反问。');
  return lines.join('\n');
}

function buildMessages(cfg, ctx) {
  const n = Math.max(2, Math.min(40, Number(cfg.memoryTurns) || 12));
  const history = memory.recent(n).map((t) => ({ role: t.role, content: t.content }));
  const messages = [{ role: 'system', content: buildSystem(cfg, ctx) }, ...history];
  return messages;
}

module.exports = { buildSystem, buildMessages };