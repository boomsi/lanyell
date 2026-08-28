// Port listening with fallback: try startPort; on EADDRINUSE bump +1 while
// allowed, and resolve the port we actually landed on.
//
// 只有"默认端口"场景允许回退(用户没有表达过端口意愿,替他找下一个空的
// 是贴心);显式指定的端口禁止回退 —— 那是用户点名的端口,悄悄换掉比报错
// 更糟糕。CLI 入口和桌面壳 sidecar 都按这个语义调用。

const PORT_UPPER_BOUND = 65535;

// maxTries: 最多尝试的端口个数(含 startPort)。到达上限仍被占则 reject。
function listenWithFallback(server, startPort, host, allowFallback, maxTries = 100) {
  return new Promise((resolve, reject) => {
    const lastPort = Math.min(startPort + Math.max(1, maxTries) - 1, PORT_UPPER_BOUND);

    function attempt(port) {
      const onError = (err) => {
        server.off('listening', onListening);
        if (err.code === 'EADDRINUSE') {
          const next = port + 1;
          if (allowFallback && next <= lastPort) {
            attempt(next); // 端口没绑上,server 可直接再次 listen
            return;
          }
          reject(Object.assign(
            new Error('port ' + startPort + (allowFallback
              ? '-' + lastPort + ' are all in use.'
              : ' is already in use.')),
            { code: 'EADDRINUSE' }
          ));
          return;
        }
        reject(err); // EACCES 等其他错误:换端口救不了,原样上抛
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(server.address().port); // 实际端口(支持 0 = 系统分配)
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    }

    attempt(startPort);
  });
}

module.exports = { listenWithFallback };
