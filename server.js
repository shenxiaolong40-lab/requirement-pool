const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { execSync, exec } = require('child_process');

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
      'X-Requested-With': 'XMLHttpRequest',
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

function agentBrowser(args) {
  try {
    return execSync('npx agent-browser ' + args, {
      timeout: 15000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch (e) {
    return null;
  }
}

function extractOnesData(onesUrl, res) {
  // Navigate to the Ones page
  const gotoResult = agentBrowser('goto "' + onesUrl + '"');
  if (!gotoResult || gotoResult.includes('登录')) {
    res.writeHead(401, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_authenticated', message: '请先在浏览器中登录 Ones' }));
    return;
  }

  // Get page title
  const title = agentBrowser('get title') || '';

  // Get snapshot
  const snapshot = agentBrowser('snapshot') || '';

  // Parse data from snapshot
  const data = {};

  // Title: remove prefix like 【需求】
  data.title = title.replace(/^【[^】]*】/, '').trim();

  // Priority
  const priMatch = snapshot.match(/优先级[^]*?StaticText "([^"]*)"/);
  if (priMatch) {
    const priMap = { '紧急': 'P0', '高': 'P1', '中': 'P2', '低': 'P3' };
    data.priority = priMap[priMatch[1]] || 'P1';
  }

  // Status
  const statusMatch = snapshot.match(/状态[^]*?StaticText "([^"]*)"/);
  if (statusMatch) {
    const stMap = { '规划中': '待评审', '待评审': '待评审', '评审中': '待评审',
      '待开发': '待开发', '开发中': '开发中', '实现中': '开发中',
      '已完成': '已完成', '已发布': '已完成', '已取消': '已取消', '已拒绝': '已取消' };
    data.status = stMap[statusMatch[1]] || '待评审';
  }

  // Iteration - match pattern like "保险260611迭代" (Chinese chars + alphanumeric + 迭代)
  const iterMatch = snapshot.match(/([一-龥]*\w+迭代)/);
  if (iterMatch) {
    data.iteration = iterMatch[1];
  }

  // Creator - find nearest StaticText after 创建者
  const creatorSection = snapshot.split('创建者')[1];
  if (creatorSection) {
    const cm = creatorSection.match(/StaticText "([^"]+)"/);
    if (cm) data.creator = cm[1].trim();
  }
  // Fallback: use first assignee as creator
  if (!data.creator) {
    const assigneeSection = snapshot.split('指派给')[1];
    if (assigneeSection) {
      const am = assigneeSection.match(/StaticText "([^"]+)"/);
      if (am) data.creator = am[1].trim();
    }
  }

  // PRD 文档链接：从需求资产中提取
  try {
    // 查找包含 PRD 的 radio 行
    var prdRadioLine = '';
    var snapshotLines = snapshot.split('\n');
    for (var i = 0; i < snapshotLines.length; i++) {
      if (snapshotLines[i].indexOf('radio') !== -1 && snapshotLines[i].indexOf('PRD') !== -1) {
        prdRadioLine = snapshotLines[i];
        break;
      }
    }
    if (prdRadioLine) {
      // 找到 radio 后面的第一个 button ref
      var afterRadioIdx = snapshot.indexOf(prdRadioLine) + prdRadioLine.length;
      var afterRadio = snapshot.substring(afterRadioIdx);
      var btnMatch = afterRadio.match(/button "[^"]*" \[ref=(e\d+)\]/);
      if (btnMatch) {
        var editBtnRef = btnMatch[1];
        agentBrowser('click @' + editBtnRef);
        var updatedSnapshot = agentBrowser('snapshot') || '';
        // 提取链接地址
        var linkTextboxIdx = updatedSnapshot.indexOf('请输入链接地址');
        if (linkTextboxIdx !== -1) {
          var afterTextbox = updatedSnapshot.substring(linkTextboxIdx);
          var urlMatch = afterTextbox.match(/(https?:\/\/[^\s"]+)/);
          if (urlMatch) {
            data.docLink = urlMatch[1];
          }
        }
        // 关闭编辑弹窗
        var cancelMatch = updatedSnapshot.match(/button "取消" \[ref=(e\d+)\]/);
        if (cancelMatch) {
          agentBrowser('click @' + cancelMatch[1]);
        }
      }
    }
    // 备用：直接从快照中查找 km.sankuai.com/collabpage/ 链接
    if (!data.docLink) {
      var kmMatch = snapshot.match(/https:\/\/km\.sankuai\.com\/collabpage\/\d+/);
      if (kmMatch && prdRadioLine) data.docLink = kmMatch[0];
    }
  } catch (e) {
    // 文档链接提取失败，忽略
  }

  res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 200, data: data }));
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

  // Ones page data extraction via agent-browser
  if (reqUrl.pathname === '/api/ones-extract') {
    const onesUrl = reqUrl.query.url;
    if (!onesUrl || !onesUrl.includes('ones.sankuai.com')) {
      res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_url' }));
      return;
    }

    extractOnesData(onesUrl, res);
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
