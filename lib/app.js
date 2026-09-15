// 应用接线:把 store、附件存储、请求处理器装配成一个整体。
//
// 为什么单独拎出来:lanyell 有两个入口 —— CLI 的 server.js 和桌面端的
// app/sidecar.js。两边各接一遍线的话,给 createHandler 加一个依赖就会漏掉
// 其中一个,而且漏掉的那个没有任何测试覆盖(测试 import 的是 server.js)。
// 附件就是这么漏的:sidecar 少传了 files,桌面端点下载会直接崩进程。
// 接线放在这里,两个入口走同一条被测试覆盖的路径。

const { createStore } = require('./store');
const { createFileStore } = require('./files');
const { createHandler } = require('./routes');

function createApp(html, options = {}) {
  // 附件目录随进程走:消息是内存态、重启即失,文件也必须一起走
  const files = createFileStore(options.files);
  const store = createStore({
    ...options.store,
    removeFile: (id) => files.remove(id),
    // 上传成功、消息却始终没发出去的附件,靠同一个扫描周期回收
    sweepFiles: (liveIds, nowMs) => files.removeOrphans(liveIds, nowMs),
  });
  return { files: files, store: store, handler: createHandler(store, html, files) };
}

module.exports = { createApp };
