// 云服务器初始化：Docker + 部署目录 + GitHub 部署密钥 + 编排文件
// 用法: PI_PW='服务器密码' PI_HOST=jiuxiaoyw.online node scripts/server-bootstrap.mjs
import { Client } from 'ssh2';
import fs from 'node:fs';

const host = process.env.PI_HOST || 'jiuxiaoyw.online';
const password = process.env.PI_PW || '';
if (!password) { console.error('缺少 PI_PW'); process.exit(1); }

const conn = new Client();
const COMPOSE = `services:
  app:
    build: .
    restart: unless-stopped
    environment:
      - TZ=Asia/Shanghai
    volumes:
      - ./data:/app/data
      - ./photos:/app/photos
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - app
volumes:
  caddy_data:
  caddy_config:
`;
const CADDYFILE = `wuliao.jiuxiaoyw.online {
    reverse_proxy app:7860
`;
const COMPOSE_CLOSED = COMPOSE + '}';
const CADDY_CLOSED = CADDYFILE + '}';

conn.on('ready', () => {
  const run = (cmd, label, timeoutMs = 300000) => new Promise((resolve) => {
    console.log('\n===== ' + label + ' =====');
    conn.exec(cmd, { readyTimeout: 20000 }, (err, stream) => {
      if (err) { console.log('EXEC-ERR:', err.message); return resolve(''); }
      let out = '';
      stream.on('close', () => { resolve(out); });
      stream.on('data', (d) => { const s = d.toString(); out += s; process.stdout.write(s.slice(0, 400)); });
      stream.stderr.on('data', (d) => { const s = d.toString(); out += s; process.stdout.write(s.slice(0, 200)); });
    });
    if (timeoutMs) setTimeout(() => { try { stream?.end(); } catch {} }, timeoutMs);
  });

  (async () => {
    // 0) 系统信息
    const os = await run('head -2 /etc/os-release; free -m | head -2; nproc', '系统信息');
    // 1) Docker
    const dv = await run('docker --version 2>/dev/null || echo NO_DOCKER', '检查 Docker');
    if (dv.includes('NO_DOCKER')) {
      console.log('>>> 安装 Docker（阿里云镜像，需 2-5 分钟）…');
      await run('curl -fsSL https://get.docker.com | sh -s -- --mirror Aliyun', '安装 Docker', 600000);
      await run('systemctl enable --now docker && docker --version', '启动 Docker');
    }
    // 2) 目录 + 部署密钥
    await run('mkdir -p /opt/parts-inventory', '创建目录');
    const keyGen = await run('cd /opt/parts-inventory && [ -f deploy_key ] || ssh-keygen -t ed25519 -f deploy_key -N "" -C parts-deploy', '生成 GitHub 部署密钥');
    const pub = await run('cat /opt/parts-inventory/deploy_key.pub', '部署公钥');
    // 3) 编排文件
    await run('cat > /opt/parts-inventory/docker-compose.yml << \'EOC\'\n' + COMPOSE_CLOSED + '\nEOC', '写入 docker-compose.yml');
    await run('cat > /opt/parts-inventory/Caddyfile << \'EOC\'\n' + CADDY_CLOSED + '\nEOC', '写入 Caddyfile');
    // 4) 一键部署脚本（CI 会调用）
    const deploySh = `#!/bin/bash
set -e
cd /opt/parts-inventory
if [ ! -d app ]; then
  GIT_SSH_COMMAND="ssh -i /opt/parts-inventory/deploy_key -o StrictHostKeyChecking=no" git clone git@github.com:mcmrzy/parts-inventory.git app
fi
cd app
GIT_SSH_COMMAND="ssh -i /opt/parts-inventory/deploy_key -o StrictHostKeyChecking=no" git pull
docker compose up -d --build
docker image prune -f
`;
    await run('cat > /opt/parts-inventory/deploy.sh << \'EOC\'\n' + deploySh + '\nEOC\nchmod +x /opt/parts-inventory/deploy.sh', '写入 deploy.sh');
    console.log('\n========== 初始化完成 ==========');
    console.log('【部署公钥】请到 GitHub 仓库 → Settings → Deploy keys → Add，粘贴以下公钥（只读即可）：');
    console.log((await run('cat /opt/parts-inventory/deploy_key.pub', '', 10000)) || pub);
    console.log('【还需你完成】');
    console.log('1. 域名解析：添加 A 记录 wuliao → 服务器公网 IP');
    console.log('2. GitHub 仓库 → Settings → Secrets → actions 新增：SERVER_HOST(服务器IP)、SERVER_USER(root)、SERVER_PASSWORD(服务器密码)');
    console.log('3. GitHub 仓库 → Settings → Variables → actions 新增：DEPLOY_ENABLED=true');
    conn.end();
  })();
}).on('error', (e) => {
  console.error('SSH 连接失败:', e.message);
  process.exit(1);
}).connect({
  host,
  port: 22,
  username: 'root',
  password,
  readyTimeout: 25000,
  tryKeyboard: true
});
