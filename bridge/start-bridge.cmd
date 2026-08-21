@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 读取提示词 - 桥接服务
node server.mjs
echo.
echo 服务已退出。按任意键关闭。
pause >nul
