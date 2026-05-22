const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 8766;
const COOKIE_FILE = path.join(__dirname, '.ones-cookie');
const HTML_FILE = path.join(__dirname, 'requirement-manager.html');

// CORS headers
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function readCookie() {
  try {
    return fs.readFileSync(COOKIE_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

function proxyToOnes(targetUrl, req, res) {
  const parsed = new URL(targetUrl);
  const cookie = readCookie();

  const options = {
    hostname: parsed.hostname,
    port: 443,
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
    rejectUnauthorized: false,
  };

  if (cookie) {
    options.headers['Cookie'] = cookie;
  }

  const proxyReq = https.request(options, (proxyRes) => {
    let body = '';
    proxyRes.on('data', (chunk) => body += chunk);
    proxyRes.on('end', () => {
      // Check if redirected to SSO login (cookie expired)
      if (body.includes('ssosv.sankuai.com') || body.includes('统一登录')) {
        res.writeHead(401, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'cookie_expired', message: 'Ones 登录已过期，请重新获取 Cookie' }));
        return;
      }

      res.writeHead(proxyRes.statusCode, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(body);
    });
  });

  proxyReq.on('error', (err) => {
    res.writeHead(502, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'proxy_error', message: '代理请求失败: ' + err.message }));
  });

  proxyReq.setTimeout(15000, () => {
    proxyReq.destroy();
    res.writeHead(504, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'timeout', message: '请求超时' }));
  });

  proxyReq.end();
}

const server = http.createServer((req, res) => {
  const reqUrl = url.parse(req.url, true);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Proxy endpoint
  if (reqUrl.pathname === '/api/proxy') {
    const targetUrl = reqUrl.query.url;
    if (!targetUrl) {
      res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing_url', message: '缺少 url 参数' }));
      return;
    }

    // Only allow proxying to ones.sankuai.com
    if (!targetUrl.includes('ones.sankuai.com')) {
      res.writeHead(403, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden', message: '仅支持代理 ones.sankuai.com 的请求' }));
      return;
    }

    proxyToOnes(targetUrl, req, res);
    return;
  }

  // Cookie helper page
  if (reqUrl.pathname === '/cookie-helper') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>获取 Ones Cookie</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 60px auto; padding: 20px; line-height: 1.8; }
  code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; }
  .step { margin-bottom: 24px; }
  .note { color: #EF4444; font-weight: bold; }
  textarea { width: 100%; height: 80px; font-family: monospace; font-size: 13px; padding: 10px; }
  button { padding: 10px 24px; font-size: 15px; cursor: pointer; background: #3B82F6; color: #fff; border: none; border-radius: 6px; }
  button:hover { background: #2563EB; }
  .success { color: #16A34A; display: none; }
</style>
</head>
<body>
<h2>获取 Ones 登录 Cookie</h2>
<div class="step">
  <strong>步骤 1：</strong>打开 <a href="https://ones.sankuai.com" target="_blank">ones.sankuai.com</a> 并确保已登录
</div>
<div class="step">
  <strong>步骤 2：</strong>在 Ones 页面按 <code>F12</code> 打开开发者工具，切换到 <code>Console</code> 面板
</div>
<div class="step">
  <strong>步骤 3：</strong>粘贴以下代码并回车，复制输出的 Cookie：
  <br><br>
  <code style="display:block;background:#1e293b;color:#e2e8f0;padding:12px;border-radius:6px;word-break:break-all;">
    document.cookie.split('; ').filter(c => c.includes('ssoid') || c.includes('token') || c.includes('session') || c.includes('TGC')).join('; ')
  </code>
</div>
<div class="step">
  <strong>步骤 4：</strong>将复制的内容粘贴到下方并保存：
  <br><br>
  <textarea id="cookieInput" placeholder="粘贴 Cookie 到这里..."></textarea>
  <br><br>
  <button onclick="save()">保存 Cookie</button>
  <span class="success" id="successMsg">已保存！代理服务器现在可以使用 Ones API 了。</span>
</div>
<script>
function save() {
  var val = document.getElementById('cookieInput').value.trim();
  if (!val) return;
  fetch('/api/save-cookie', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookie: val })
  }).then(function() {
    document.getElementById('successMsg').style.display = 'inline';
  });
}
</script>
</body>
</html>`);
    return;
  }

  // Save cookie endpoint
  if (reqUrl.pathname === '/api/save-cookie' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        fs.writeFileSync(COOKIE_FILE, data.cookie || '', 'utf8');
        res.writeHead(200, CORS_HEADERS);
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, CORS_HEADERS);
        res.end(JSON.stringify({ error: 'invalid_json' }));
      }
    });
    return;
  }

  // Health check
  if (reqUrl.pathname === '/api/health') {
    const hasCookie = !!readCookie();
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', cookieConfigured: hasCookie }));
    return;
  }

  // Serve the HTML page
  if (reqUrl.pathname === '/' || reqUrl.pathname === '/index.html') {
    try {
      const html = fs.readFileSync(HTML_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
    }
    return;
  }

  res.writeHead(404, CORS_HEADERS);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('');
  console.log('  需求池本地代理服务器已启动');
  console.log('  ────────────────────────────');
  console.log('  页面地址: http://localhost:' + PORT);
  console.log('  Cookie 配置: http://localhost:' + PORT + '/cookie-helper');
  console.log('  代理接口: http://localhost:' + PORT + '/api/proxy?url=...');
  console.log('');
  const hasCookie = !!readCookie();
  if (!hasCookie) {
    console.log('  ⚠️  尚未配置 Ones Cookie，API 代理可能无法使用');
    console.log('  请访问 http://localhost:' + PORT + '/cookie-helper 配置');
    console.log('');
  } else {
    console.log('  ✅ Ones Cookie 已配置');
    console.log('');
  }
});
