@echo off
chcp 65001 >nul
title 物料管家
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js 22 或更高版本：https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules\express" (
  echo 首次运行，正在安装依赖…
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

echo 正在启动物料管家… 关闭本窗口即可停止服务
node src/server.js
pause
