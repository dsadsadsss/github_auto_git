// Cloudflare Worker - 定时向 GitHub 仓库提交时间文件 + 监控页面

export default {
  async scheduled(event, env, ctx) {
    const repos = getRepoConfigs(env);
    console.log(`Found ${repos.length} repositories to update`);
    
    const results = await Promise.allSettled(
      repos.map(repo => updateRepo(repo))
    );
    
    // 保存执行结果到 KV
    const statusData = results.map((result, index) => ({
      repo: repos[index].repo,
      index: repos[index].index,
      status: result.status === 'fulfilled' ? 'success' : 'failed',
      time: new Date().toISOString(),
      message: result.status === 'fulfilled' 
        ? 'Commit successful' 
        : result.reason?.message || 'Unknown error'
    }));
    
    // 存储到 KV (如果配置了)
    if (env.STATUS_KV) {
      await env.STATUS_KV.put('latest_status', JSON.stringify(statusData));
    }
    
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        console.log(`✓ Repo ${index + 1} updated successfully`);
      } else {
        console.error(`✗ Repo ${index + 1} failed:`, result.reason);
      }
    });
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 检查密码保护
    if (env.PSWD) {
      const authResult = checkAuth(request, env.PSWD);
      if (authResult) return authResult;
    }
    
    // 路由：监控页面
    if (url.pathname === '/' || url.pathname === '/status') {
      return new Response(getStatusHTML(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }
    
    // 路由：获取状态 API
    if (url.pathname === '/api/status') {
      let statusData = [];
      
      // 尝试从 KV 读取历史数据
      if (env.STATUS_KV) {
        const cached = await env.STATUS_KV.get('latest_status');
        if (cached) {
          statusData = JSON.parse(cached);
        }
      }
      
      return new Response(JSON.stringify(statusData), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    
    // 路由：手动触发执行
    if (url.pathname === '/api/trigger') {
      const repos = getRepoConfigs(env);
      
      if (repos.length === 0) {
        return new Response(JSON.stringify({ error: 'No repositories configured' }), { 
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      const results = await Promise.allSettled(
        repos.map(repo => updateRepo(repo))
      );
      
      const statusData = results.map((result, index) => ({
        repo: repos[index].repo,
        index: repos[index].index,
        status: result.status === 'fulfilled' ? 'success' : 'failed',
        time: new Date().toISOString(),
        message: result.status === 'fulfilled' 
          ? 'Commit successful' 
          : result.reason?.message || 'Unknown error'
      }));
      
      // 保存到 KV
      if (env.STATUS_KV) {
        await env.STATUS_KV.put('latest_status', JSON.stringify(statusData));
      }
      
      return new Response(JSON.stringify(statusData), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    
    return new Response('Not Found', { status: 404 });
  }
};

/**
 * 检查 HTTP Basic Auth 认证
 */
function checkAuth(request, password) {
  const authHeader = request.headers.get('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return new Response('Authentication required', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="GitHub Monitor", charset="UTF-8"',
        'Content-Type': 'text/html; charset=utf-8'
      },
      body: getLoginHTML()
    });
  }
  
  // 解析 Basic Auth
  const base64Credentials = authHeader.slice(6);
  const credentials = atob(base64Credentials);
  const [username, pass] = credentials.split(':');
  
  // 验证密码（用户名可以是任意值）
  if (pass !== password) {
    return new Response('Invalid credentials', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="GitHub Monitor", charset="UTF-8"',
        'Content-Type': 'text/html; charset=utf-8'
      },
      body: getLoginHTML()
    });
  }
  
  return null; // 认证通过
}

/**
 * 从环境变量中获取所有仓库配置
 */
function getRepoConfigs(env) {
  const repos = [];
  let index = 1;
  
  while (true) {
    const key = `GITHUB${index}`;
    const config = env[key];
    
    if (!config) break;
    
    try {
      const parsed = JSON.parse(config);
      if (parsed.token && parsed.repo) {
        repos.push({
          token: parsed.token,
          repo: parsed.repo,
          index: index
        });
      } else {
        console.warn(`${key} missing token or repo field`);
      }
    } catch (e) {
      console.error(`Failed to parse ${key}:`, e.message);
    }
    
    index++;
  }
  
  return repos;
}

/**
 * 更新单个仓库
 */
async function updateRepo(config) {
  const { token, repo, index } = config;
  const [owner, repoName] = repo.split('/');
  
  if (!owner || !repoName) {
    throw new Error(`Invalid repo format: ${repo}. Expected: owner/repo`);
  }
  
  const branch = await getDefaultBranch(owner, repoName, token);
  const latestCommitSha = await getLatestCommit(owner, repoName, branch, token);
  const treeSha = await getTreeSha(owner, repoName, latestCommitSha, token);
  
  const currentTime = new Date().toISOString();
  const blobSha = await createBlob(owner, repoName, currentTime, token);
  const newTreeSha = await createTree(owner, repoName, treeSha, blobSha, token);
  const newCommitSha = await createCommit(owner, repoName, newTreeSha, latestCommitSha, currentTime, token);
  
  await updateRef(owner, repoName, branch, newCommitSha, token);
  
  console.log(`Repo ${index} (${repo}) updated at ${currentTime}`);
  return { success: true, time: currentTime };
}

/**
 * GitHub API 辅助函数
 */
async function githubApi(endpoint, token, options = {}) {
  const url = `https://api.github.com${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Cloudflare-Worker',
      ...options.headers
    }
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub API error (${response.status}): ${error}`);
  }
  
  return response.json();
}

async function getDefaultBranch(owner, repo, token) {
  const data = await githubApi(`/repos/${owner}/${repo}`, token);
  return data.default_branch;
}

async function getLatestCommit(owner, repo, branch, token) {
  const data = await githubApi(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, token);
  return data.object.sha;
}

async function getTreeSha(owner, repo, commitSha, token) {
  const data = await githubApi(`/repos/${owner}/${repo}/git/commits/${commitSha}`, token);
  return data.tree.sha;
}

async function createBlob(owner, repo, content, token) {
  const data = await githubApi(`/repos/${owner}/${repo}/git/blobs`, token, {
    method: 'POST',
    body: JSON.stringify({
      content: content,
      encoding: 'utf-8'
    })
  });
  return data.sha;
}

async function createTree(owner, repo, baseTreeSha, blobSha, token) {
  const data = await githubApi(`/repos/${owner}/${repo}/git/trees`, token, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: [{
        path: 'time.txt',
        mode: '100644',
        type: 'blob',
        sha: blobSha
      }]
    })
  });
  return data.sha;
}

async function createCommit(owner, repo, treeSha, parentSha, time, token) {
  const data = await githubApi(`/repos/${owner}/${repo}/git/commits`, token, {
    method: 'POST',
    body: JSON.stringify({
      message: `Update time.txt - ${time}`,
      tree: treeSha,
      parents: [parentSha]
    })
  });
  return data.sha;
}

async function updateRef(owner, repo, branch, commitSha, token) {
  await githubApi(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, token, {
    method: 'PATCH',
    body: JSON.stringify({
      sha: commitSha,
      force: false
    })
  });
}

/**
 * 生成登录提示页面
 */
function getLoginHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>登录 - GitHub 监控</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    
    .login-container {
      background: white;
      border-radius: 16px;
      padding: 40px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
      max-width: 400px;
      width: 100%;
      text-align: center;
    }
    
    .lock-icon {
      width: 64px;
      height: 64px;
      margin: 0 auto 24px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-size: 32px;
    }
    
    h1 {
      color: #2d3748;
      font-size: 24px;
      margin-bottom: 8px;
    }
    
    .subtitle {
      color: #718096;
      font-size: 14px;
      margin-bottom: 32px;
    }
    
    .message {
      background: #fff5f5;
      border: 1px solid #feb2b2;
      color: #c53030;
      padding: 12px;
      border-radius: 8px;
      font-size: 14px;
      margin-bottom: 24px;
    }
    
    .info {
      background: #ebf8ff;
      border: 1px solid #90cdf4;
      color: #2c5282;
      padding: 12px;
      border-radius: 8px;
      font-size: 13px;
      text-align: left;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="lock-icon">🔒</div>
    <h1>需要身份验证</h1>
    <p class="subtitle">请输入密码访问监控页面</p>
    <div class="message">
      认证失败，请检查密码是否正确
    </div>
    <div class="info">
      <strong>💡 提示：</strong><br>
      • 用户名可以输入任意内容<br>
      • 密码为环境变量 PSWD 设置的值<br>
      • 浏览器会记住您的登录状态
    </div>
  </div>
</body>
</html>`;
}

/**
 * 生成监控页面 HTML
 */
function getStatusHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GitHub 仓库提交监控</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    
    .header {
      background: white;
      border-radius: 12px;
      padding: 30px;
      margin-bottom: 20px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }
    
    h1 {
      color: #2d3748;
      font-size: 28px;
      margin-bottom: 10px;
    }
    
    .subtitle {
      color: #718096;
      font-size: 14px;
    }
    
    .controls {
      display: flex;
      gap: 10px;
      margin-top: 20px;
    }
    
    button {
      background: #667eea;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: all 0.3s;
    }
    
    button:hover {
      background: #5568d3;
      transform: translateY(-2px);
      box-shadow: 0 4px 8px rgba(102, 126, 234, 0.4);
    }
    
    button:disabled {
      background: #cbd5e0;
      cursor: not-allowed;
      transform: none;
    }
    
    .status-grid {
      display: grid;
      gap: 20px;
      grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
    }
    
    .status-card {
      background: white;
      border-radius: 12px;
      padding: 24px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      transition: transform 0.3s;
    }
    
    .status-card:hover {
      transform: translateY(-4px);
      box-shadow: 0 8px 12px rgba(0, 0, 0, 0.15);
    }
    
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    
    .repo-name {
      font-size: 16px;
      font-weight: 600;
      color: #2d3748;
      font-family: 'Courier New', monospace;
      letter-spacing: -0.5px;
    }
    
    .status-badge {
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
    }
    
    .status-success {
      background: #c6f6d5;
      color: #22543d;
    }
    
    .status-failed {
      background: #fed7d7;
      color: #742a2a;
    }
    
    .status-unknown {
      background: #e2e8f0;
      color: #4a5568;
    }
    
    .card-body {
      border-top: 1px solid #e2e8f0;
      padding-top: 16px;
    }
    
    .info-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 8px;
      font-size: 14px;
    }
    
    .info-label {
      color: #718096;
      font-weight: 500;
    }
    
    .info-value {
      color: #2d3748;
      font-weight: 600;
    }
    
    .message {
      margin-top: 12px;
      padding: 12px;
      background: #f7fafc;
      border-radius: 6px;
      font-size: 13px;
      color: #4a5568;
      word-break: break-word;
    }
    
    .loading {
      text-align: center;
      padding: 60px;
      color: white;
      font-size: 18px;
    }
    
    .empty-state {
      background: white;
      border-radius: 12px;
      padding: 60px;
      text-align: center;
      color: #718096;
    }
    
    .empty-state svg {
      width: 64px;
      height: 64px;
      margin-bottom: 16px;
      opacity: 0.5;
    }
    
    .last-updated {
      text-align: center;
      color: white;
      margin-top: 20px;
      font-size: 14px;
      opacity: 0.9;
    }
    
    @media (max-width: 768px) {
      .status-grid {
        grid-template-columns: 1fr;
      }
      
      .controls {
        flex-direction: column;
      }
      
      button {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📊 GitHub 仓库提交监控</h1>
      <p class="subtitle">实时监控自动提交任务状态</p>
      <div class="controls">
        <button onclick="refreshStatus()">🔄 刷新状态</button>
        <button onclick="triggerNow()" id="triggerBtn">▶️ 立即执行</button>
      </div>
    </div>
    
    <div id="content" class="loading">
      <div>⏳ 加载中...</div>
    </div>
    
    <div class="last-updated" id="lastUpdated"></div>
  </div>

  <script>
    function maskRepo(repo) {
      if (!repo || repo.length <= 4) return repo;
      const lastFour = repo.slice(-4);
      const masked = '*'.repeat(repo.length - 4);
      return masked + lastFour;
    }
    
    function formatTime(isoString) {
      if (!isoString) return '-';
      const date = new Date(isoString);
      const now = new Date();
      const diff = now - date;
      
      // 显示相对时间
      const seconds = Math.floor(diff / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);
      
      let relative = '';
      if (days > 0) relative = days + ' 天前';
      else if (hours > 0) relative = hours + ' 小时前';
      else if (minutes > 0) relative = minutes + ' 分钟前';
      else relative = '刚刚';
      
      const absolute = date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      
      return \`\${absolute} (\${relative})\`;
    }
    
    async function loadStatus() {
      try {
        const response = await fetch('/api/status');
        const data = await response.json();
        
        const content = document.getElementById('content');
        
        if (data.length === 0) {
          content.innerHTML = \`
            <div class="empty-state">
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"></path>
              </svg>
              <h3>暂无数据</h3>
              <p>尚未执行过任何任务，请点击"立即执行"按钮开始</p>
            </div>
          \`;
          return;
        }
        
        content.className = 'status-grid';
        content.innerHTML = data.map(item => {
          const statusClass = item.status === 'success' ? 'status-success' : 'status-failed';
          const statusText = item.status === 'success' ? '✓ 成功' : '✗ 失败';
          
          return \`
            <div class="status-card">
              <div class="card-header">
                <div class="repo-name">\${maskRepo(item.repo)}</div>
                <div class="status-badge \${statusClass}">\${statusText}</div>
              </div>
              <div class="card-body">
                <div class="info-row">
                  <span class="info-label">仓库编号</span>
                  <span class="info-value">GITHUB\${item.index}</span>
                </div>
                <div class="info-row">
                  <span class="info-label">最后更新</span>
                  <span class="info-value">\${formatTime(item.time)}</span>
                </div>
                \${item.message ? \`<div class="message">\${item.message}</div>\` : ''}
              </div>
            </div>
          \`;
        }).join('');
        
        document.getElementById('lastUpdated').textContent = 
          '页面更新时间: ' + new Date().toLocaleString('zh-CN');
        
      } catch (error) {
        document.getElementById('content').innerHTML = \`
          <div class="empty-state">
            <h3>加载失败</h3>
            <p>\${error.message}</p>
          </div>
        \`;
      }
    }
    
    async function triggerNow() {
      const btn = document.getElementById('triggerBtn');
      btn.disabled = true;
      btn.textContent = '⏳ 执行中...';
      
      try {
        const response = await fetch('/api/trigger');
        await loadStatus();
        btn.textContent = '✓ 执行完成';
        setTimeout(() => {
          btn.textContent = '▶️ 立即执行';
          btn.disabled = false;
        }, 2000);
      } catch (error) {
        alert('执行失败: ' + error.message);
        btn.textContent = '▶️ 立即执行';
        btn.disabled = false;
      }
    }
    
    function refreshStatus() {
      loadStatus();
    }
    
    // 页面加载时获取状态
    loadStatus();
    
    // 每30秒自动刷新
    setInterval(loadStatus, 30000);
  </script>
</body>
</html>`;
}
