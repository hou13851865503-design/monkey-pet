@echo off
:: 桌面小猴宠物启动脚本（无需 node/npm 在 PATH，直接拉起本地 electron）
cd /d "%~dp0"
start "" "node_modules\electron\dist\electron.exe" .
