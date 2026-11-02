const { getDefaultConfig } = require('expo/metro-config');
const { withUniwindConfig } = require('uniwind/metro');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

// 登录诊断日志：只记录账号名与服务器响应，绝不记录密码。定位完成后可删除。
const LOGIN_DEBUG_LOG = path.join(__dirname, '.login-debug.log');

function logLoginDebug(requestBody, statusCode, responseBody) {
  let account = '';
  try {
    account = JSON.parse(requestBody).Account ?? '';
  } catch { /* 忽略解析失败 */ }
  const line = `[${new Date().toLocaleTimeString()}] 账号="${account}" -> HTTP ${statusCode} 响应=${responseBody.slice(0, 300)}\n`;
  try { fs.appendFileSync(LOGIN_DEBUG_LOG, line); } catch { /* 忽略写入失败 */ }
  console.log(`[登录诊断] ${line.trim()}`);
}

const config = getDefaultConfig(__dirname);

config.transformer.getTransformOptions = async () => ({
  transform: {
    experimentalImportSupport: true,
    inlineRequires: true,
  },
});

// Web 端开发代理：浏览器直接请求 Lucky 服务会被 CORS 拦截（OPTIONS 预检 403），
// 因此 web 端把请求发到本开发服务器的 /proxy/<origin 编码>/<path>，由 Node 转发。
// 仅影响 `npm run web` 的开发服务器，原生构建不会经过这里。
const PROXY_PREFIX = '/proxy/';

function parseProxyTarget(raw) {
  const slashIndex = raw.indexOf('/');
  const encodedOrigin = slashIndex === -1 ? raw : raw.slice(0, slashIndex);
  const suffix = slashIndex === -1 ? '/' : raw.slice(slashIndex);
  let origin;
  try {
    origin = decodeURIComponent(encodedOrigin);
  } catch {
    return undefined;
  }
  // 兼容 WebSocket 发来的 ws:// / wss:// 形式
  if (/^ws:\/\//i.test(origin)) origin = origin.replace(/^ws:/i, 'http:');
  if (/^wss:\/\//i.test(origin)) origin = origin.replace(/^wss:/i, 'https:');
  if (!/^https?:\/\//i.test(origin)) return undefined;
  const target = new URL(origin.replace(/\/+$/, '') + suffix);
  return target;
}

function upstreamRequestOptions(target, req) {
  const isHttps = target.protocol === 'https:';
  const headers = { ...req.headers };
  headers.host = target.host;
  headers.origin = target.origin;
  headers.referer = target.origin + '/';
  delete headers['accept-encoding'];
  return {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    method: req.method,
    path: target.pathname + target.search,
    headers,
  };
}

function proxyHttpRequest(req, res) {
  const target = parseProxyTarget(req.url.slice(PROXY_PREFIX.length));
  if (!target) {
    res.statusCode = 400;
    res.end('invalid proxy target');
    return;
  }
  const isLogin = target.pathname === '/api/login' && req.method === 'POST';
  const requestChunks = [];
  if (isLogin) {
    req.on('data', (chunk) => {
      if (requestChunks.length < 16) requestChunks.push(Buffer.from(chunk));
    });
  }
  const mod = target.protocol === 'https:' ? https : http;
  const upstream = mod.request(upstreamRequestOptions(target, req), (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    if (isLogin) {
      const responseChunks = [];
      upstreamRes.on('data', (chunk) => {
        if (responseChunks.length < 16) responseChunks.push(Buffer.from(chunk));
      });
      upstreamRes.on('end', () => {
        const responseBody = Buffer.concat(responseChunks).toString('utf8');
        const requestBody = Buffer.concat(requestChunks).toString('utf8');
        logLoginDebug(requestBody, upstreamRes.statusCode ?? 0, responseBody);
        res.end(responseBody);
      });
      return;
    }
    upstreamRes.pipe(res);
  });
  upstream.on('error', (error) => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`代理请求失败: ${error.message}`);
  });
  req.pipe(upstream);
}

function proxyWebSocket(req, socket, head) {
  const target = parseProxyTarget(req.url.slice(PROXY_PREFIX.length));
  if (!target) {
    socket.destroy();
    return;
  }
  const mod = target.protocol === 'https:' ? https : http;
  const upstreamReq = mod.request(upstreamRequestOptions(target, req));
  upstreamReq.end(head);
  upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    let handshake = `HTTP/${upstreamRes.httpVersion} ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n`;
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (value !== undefined) handshake += `${key}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`;
    }
    socket.write(handshake + '\r\n');
    if (upstreamHead?.length) socket.write(upstreamHead);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
    const teardown = () => {
      upstreamSocket.destroy();
      socket.destroy();
    };
    upstreamSocket.on('error', teardown);
    socket.on('error', teardown);
    upstreamSocket.on('close', teardown);
    socket.on('close', teardown);
  });
  upstreamReq.on('response', (upstreamRes) => {
    // 目标拒绝升级时把它的响应原样回给浏览器
    let text = `HTTP/${upstreamRes.httpVersion} ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n`;
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (value !== undefined) text += `${key}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`;
    }
    socket.end(text + '\r\n');
  });
  upstreamReq.on('error', () => socket.destroy());
}

// Metro 不暴露底层 http.Server，只能通过补丁截获 upgrade 事件来转发 WebSocket。
function patchUpgradeOnce() {
  const originalEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (event, ...args) {
    if (event === 'upgrade') {
      const [req, socket, head] = args;
      if (typeof req.url === 'string' && req.url.startsWith(PROXY_PREFIX)) {
        proxyWebSocket(req, socket, head);
        return true;
      }
    }
    return originalEmit.call(this, event, ...args);
  };
}

patchUpgradeOnce();

config.server = {
  ...config.server,
  enhanceMiddleware: (metroMiddleware) => {
    return (req, res, next) => {
      if (typeof req.url === 'string' && req.url.startsWith(PROXY_PREFIX)) {
        proxyHttpRequest(req, res);
        return;
      }
      metroMiddleware(req, res, next);
    };
  },
};

module.exports = withUniwindConfig(config, {
  cssEntryFile: './src/global.css',
  dtsFile: './src/uniwind-types.d.ts',
});
