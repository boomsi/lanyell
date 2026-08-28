// 消息自动拆分:内容超过单段上限时切成多段存储/广播。
// 切分规则(按优先级):
// 1. 优先在 [0, limit] 范围内最后一个换行符之后切 —— 日志场景天然按行,
//    段边界落在行与行之间,阅读体验最好;
// 2. 找不到换行才按字符位置切,且切点避免落在 UTF-16 代理对中间
//    (否则段尾/段首会出现半个 emoji,复制拼接虽然无损但单段显示会乱码);
// 3. 恒等式 parts.join('') === 原文 —— 前端 Copy 拼接还原全文依赖这一点,
//    由测试固化。

// 单段上限:超过则自动拆分(每段 ≤ 10000 字符)
const SINGLE_PART_LIMIT = 10000;
// 单次发送总量上限:超过直接拒绝 400(防手滑粘贴整个文件)
const TOTAL_LIMIT = 100000;

// 切点 cut 是否落在代理对中间:前一位是高代理且当前位是低代理
function splitsSurrogatePair(str, cut) {
  const prev = str.charCodeAt(cut - 1);
  const curr = str.charCodeAt(cut);
  return prev >= 0xd800 && prev < 0xdc00 && curr >= 0xdc00 && curr <= 0xdfff;
}

// 计算下一段的切点(返回值保证 ≥ 1 且 ≤ limit,避免死循环)
function findCut(rest, limit) {
  const max = Math.min(limit, rest.length);
  // 在 [0, max) 内找最后一个换行,切点 = 换行之后(该换行归属前段)
  const nl = rest.lastIndexOf('\n', max - 1);
  if (nl !== -1) return nl + 1;
  // 无换行:按 max 切;若切断代理对则前移一位(Math.max 兜底保证切点 ≥ 1)
  if (splitsSurrogatePair(rest, max)) return Math.max(1, max - 1);
  return max;
}

// 拆分纯函数:≤ limit 原样返回单段;否则循环切多段
function splitContent(content, limit) {
  if (content.length <= limit) return [content];
  const parts = [];
  let rest = content;
  while (rest.length > limit) {
    const cut = findCut(rest, limit);
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

module.exports = { splitContent, SINGLE_PART_LIMIT, TOTAL_LIMIT };
