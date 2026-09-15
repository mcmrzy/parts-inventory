#!/bin/bash
# 物料管家 · 云服务器一键初始化
# 用法：root 用户登录服务器（云厂商网页控制台粘贴运行），一路自动完成
set -e

echo "== 1/5 安装 Docker（官方仓库，无管道执行）=="
if ! command -v docker >/dev/null 2>&1; then
  if [ -f /etc/apt/sources.list ] || [ -d /etc/apt/sources.list.d ]; then
    # Debian / Ubuntu
    apt-get update
    apt-get install -y ca-certificates curl gnupg
    install -m 0755 -d /etc/apt/keyrings
    . /etc/os-release
    curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  else
    # CentOS / Alibaba / RHEL 系
    yum install -y yum-utils
    yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    yum install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
fi
systemctl enable --now docker
docker --version
docker compose version

echo "== 2/5 目录与 GitHub 部署密钥 =="
mkdir -p /opt/parts-inventory
cd /opt/parts-inventory
if [ ! -f deploy_key ]; then
  ssh-keygen -t ed25519 -f deploy_key -N '' -C parts-deploy
fi

echo "== 3/5 写入编排文件（域名自动 HTTPS）=="
cat > docker-compose.yml <<'EOF'
services:
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
EOF

cat > Caddyfile <<'EOF'
wuliao.jiuxiaoyw.online {
    reverse_proxy app:7860
}
EOF

cat > deploy.sh <<'EOF'
#!/bin/bash
set -e
cd /opt/parts-inventory
if [ ! -d app ]; then
  GIT_SSH_COMMAND="ssh -i /opt/parts-inventory/deploy_key -o StrictHostKeyChecking=no" git clone git@github.com:mcmrzy/parts-inventory.git app
fi
cd app
GIT_SSH_COMMAND="ssh -i /opt/parts-inventory/deploy_key -o StrictHostKeyChecking=no" git pull
docker compose up -d --build
docker image prune -f
EOF
chmod +x deploy.sh

echo "== 4/5 放行端口 =="
if command -v ufw >/dev/null 2>&1; then ufw allow 80,443/tcp 2>/dev/null || true; fi

echo "== 5/5 初始化完成 =="
echo ""
echo "【部署公钥】复制它 → GitHub 仓库 → Settings → Deploy keys → Add deploy key（不勾写入）："
echo ""
cat deploy_key.pub
echo ""
echo "【剩余三步】"
echo "① 域名解析：在你的域名控制台添加 A 记录：wuliao → 本服务器公网 IP"
echo "② GitHub 仓库 → Settings → Secrets and variables → Actions："
echo "   新增 Secret：SERVER_HOST=本服务器公网IP"
echo "   新增 Secret：SERVER_USER=root"
echo "   新增 Secret：SERVER_PASSWORD=服务器密码"
echo "   新增 Variable：DEPLOY_ENABLED=true"
echo "③ 首次部署：GitHub 仓库 Actions → CI/CD → Run workflow，或本地推送一次代码"
echo "之后每次 git push 都会自动部署，访问 https://wuliao.jiuxiaoyw.online（自动 HTTPS）"
