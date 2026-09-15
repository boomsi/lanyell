// 附件存储:文件字节落磁盘,消息里只留元数据。
// 两条硬约束:
// 1. 磁盘上的文件名用服务端生成的 id,用户给的文件名只作为元数据 ——
//    用户字符串永远不参与路径拼接,路径穿越这类问题从根上不存在;
// 2. 生命周期与消息一致(1 小时 TTL)。消息是内存态、重启即失,
//    所以附件也必须在启动时清空,否则会留下没有对应消息的孤儿文件。

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// 单文件上限
const MAX_FILE_BYTES = 100 * 1024 * 1024;
// 全部附件合计的磁盘预算:防止反复上传把磁盘写满
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
// 文件名(纯元数据)保留长度:超长名字会撑爆列表 UI
const MAX_NAME_LENGTH = 200;
// 孤儿附件的宽限期:上传成功但消息还没发到的窗口内不能回收,
// 否则扫码发大文件的慢客户端会被自己触发的回收删掉附件
const ORPHAN_GRACE_MS = 5 * 60 * 1000;
// id 白名单:即使 fileId 是构造出来的,也拼不出目录之外
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isSafeId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

// 去掉不成对的代理码元。ES 规定 encodeURIComponent 遇到孤立代理必须抛
// URIError,而下载路由要拿文件名去拼响应头 —— 放过去就是一条请求打死进程。
function stripLoneSurrogates(str) {
  return str
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

// 文件名清洗:去掉控制字符(含 CR/LF,否则响应头可被注入)、路径分隔符,
// 孤立代理,并截断超长名字。只用于展示和 Content-Disposition,不参与路径拼接。
//
// 返回值要直接进 Content-Disposition,所以两条约束缺一不可:
// 1. 截断必须按**码点**而不是 UTF-16 code unit。slice 会把代理对劈成两半,
//    留下一个孤立高位代理,而 encodeURIComponent 遇到它必然抛 URIError;
//    抛点在无 try/catch 的 async handler 里,整个进程会被带走。
//    实测:文件名 = 199 个 a + 一个 emoji,两个请求就能打死板子。
//    按码点截断同时修掉「带 emoji 的名字实际只能存一半长度」的语义偏差。
// 2. 即使输入本身就含孤立代理也要剔除(见上)。这是 sanitizeName 输出契约的
//    一部分 —— 输出一定能被安全编码进响应头,不是靠上游碰巧挡住了。
function sanitizeName(name) {
  const cleaned = String(name === undefined || name === null ? '' : name)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .trim();
  const truncated = Array.from(stripLoneSurrogates(cleaned)).slice(0, MAX_NAME_LENGTH).join('');
  return truncated || 'file';
}

// MIME 类型只用来给列表挑图标,永远不参与响应的 Content-Type ——
// 下载一律 application/octet-stream,不信客户端报的类型
function sanitizeType(type) {
  return String(type === undefined || type === null ? '' : type)
    .replace(/[^\x20-\x7e]/g, '')
    .slice(0, 100);
}

// 从文件头字节判断真实的图片类型,判定不了就返回 null。
//
// 只看魔数,绝不采信客户端报的 MIME:那是 MIME 混淆攻击的入口。
// SVG **不在**白名单里,这是有意的 —— SVG 是能携带脚本的 XML,一旦以
// image/svg+xml 内联下发,用户直接打开那个 URL 就能在板子同源里执行脚本;
// 而缩略图用 <img> 展示,用不到 SVG。其它判定不出来的类型同样不给内联。
function sniffImageType(buf) {
  const starts = (offset, sig) => sig.every((b, i) => buf[offset + i] === b);
  if (buf.length >= 8 && starts(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (buf.length >= 3 && starts(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (buf.length >= 6 && buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.length >= 2 && starts(0, [0x42, 0x4d])) return 'image/bmp';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp' && /^(avif|avis)$/.test(buf.toString('latin1', 8, 12))) return 'image/avif';
  return null;
}

// Content-Disposition:ASCII 回退 + RFC 5987 UTF-8 形式(中文名才不会乱码)。
// 永远是 attachment —— 绝不让上传的内容以内联方式在板子的同源下渲染,
// 否则一个上传的 .html 就是存储型 XSS。
function contentDisposition(name) {
  const safe = sanitizeName(name);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(safe);
}

//   options.dir            存储目录,默认在 os.tmpdir() 下开一个唯一目录
//   options.maxFileBytes   单文件上限
//   options.maxTotalBytes  磁盘预算
function createFileStore(options = {}) {
  const dir = options.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'lanyell-files-'));
  const maxFileBytes = options.maxFileBytes === undefined ? MAX_FILE_BYTES : options.maxFileBytes;
  const maxTotalBytes = options.maxTotalBytes === undefined ? MAX_TOTAL_BYTES : options.maxTotalBytes;
  // id -> { size, createdAt }:内存里记账,省掉每次扫描目录
  const entries = new Map();

  const pathFor = (id) => path.join(dir, id);

  function totalBytes() {
    let sum = 0;
    for (const entry of entries.values()) sum += entry.size;
    return sum;
  }

  // 流式落盘:整个文件不进内存,这是能收大文件的原因。
  // 超限立即中断,并把半截文件删掉 —— 否则被拒的上传会白占磁盘预算。
  // meta = { name, type }:落库的是服务端清洗后的值,之后发送消息时只认这里,
  // 客户端无法在第二步谎报文件名或大小。
  function save(source, meta) {
    const id = crypto.randomUUID();
    const name = sanitizeName(meta && meta.name);
    const type = sanitizeType(meta && meta.type);
    const target = pathFor(id);
    const out = fs.createWriteStream(target);
    let size = 0;
    let settled = false;

    return new Promise((resolve, reject) => {
      const finish = (err) => {
        if (settled) return;
        settled = true;
        // 先摘掉下游再停流:data 监听器注册在 pipe 之前,所以超限时
        // 这一块数据还没写进文件
        source.unpipe(out);
        source.pause();
        out.destroy();
        if (err) {
          fs.rm(target, { force: true }, () => reject(err));
          return;
        }
        entries.set(id, { size: size, name: name, type: type, createdAt: Date.now() });
        resolve({ id: id, size: size, name: name, type: type });
      };

      source.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxFileBytes) {
          finish(Object.assign(new Error('file too large'), { status: 413 }));
          return;
        }
        if (totalBytes() + size > maxTotalBytes) {
          finish(Object.assign(new Error('storage full'), { status: 507 }));
        }
      });
      source.on('error', finish);
      out.on('error', finish);
      out.on('finish', () => finish(null));
      source.pipe(out);
    });
  }

  function remove(id) {
    if (!isSafeId(id) || !entries.has(id)) return false;
    entries.delete(id);
    fs.rmSync(pathFor(id), { force: true });
    return true;
  }

  // 回收没有任何消息引用的附件。宽限期内的不动:上传和发送之间总有一段
  // 网络往返,刚传完就回收会把别人正在发的附件删掉。
  function removeOrphans(liveIds, nowMs) {
    const cutoff = (nowMs === undefined ? Date.now() : nowMs) - ORPHAN_GRACE_MS;
    let removed = 0;
    for (const [id, entry] of Array.from(entries.entries())) {
      if (!liveIds.has(id) && entry.createdAt <= cutoff) {
        remove(id);
        removed++;
      }
    }
    return removed;
  }

  function cleanup() {
    entries.clear();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const entryOf = (id) => (isSafeId(id) && entries.has(id) ? entries.get(id) : null);

  return {
    dir: dir,
    totalBytes: totalBytes,
    has: (id) => entryOf(id) !== null,
    sizeOf: (id) => (entryOf(id) ? entryOf(id).size : null),
    nameOf: (id) => (entryOf(id) ? entryOf(id).name : null),
    typeOf: (id) => (entryOf(id) ? entryOf(id).type : null),
    // 下载路由用:拿不到(不存在或 id 不安全)就返回 null,由调用方回 404
    createReadStream: (id) => (entryOf(id) ? fs.createReadStream(pathFor(id)) : null),
    // 图片预览用:是白名单里的位图才返回 MIME,否则 null(调用方回 404)。
    // 读不出来(文件被外部删掉等)也返回 null —— 预览拿不到只是个 404,
    // 不该让它抛出去,那会打死进程。
    previewType(id) {
      if (!entryOf(id)) return null;
      try {
        const fd = fs.openSync(pathFor(id), 'r');
        const head = Buffer.alloc(16);
        const read = fs.readSync(fd, head, 0, 16, 0);
        fs.closeSync(fd);
        return sniffImageType(head.subarray(0, read));
      } catch (err) {
        return null;
      }
    },
    save: save,
    remove: remove,
    removeOrphans: removeOrphans,
    cleanup: cleanup,
  };
}

module.exports = {
  createFileStore,
  sanitizeName,
  sanitizeType,
  contentDisposition,
  sniffImageType,
  isSafeId,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  ORPHAN_GRACE_MS,
};
