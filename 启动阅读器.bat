@echo off
REM 启动山梨阅读器
REM 说明：某些环境会设置 ELECTRON_RUN_AS_NODE=1，导致 Electron 退化成普通 Node，
REM 这里先清掉它，保证窗口能正常打开。
setlocal
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
endlocal
