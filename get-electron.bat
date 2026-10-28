@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0hub"
set "LOG=%~dp0get-electron.log"
echo ==== start %date% %time% > "%LOG%"

echo [尝试 1] 从国内镜像 npmmirror 下载 Electron（约 100 MB）...
echo ==== try mirror >> "%LOG%"
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
node node_modules\electron\install.js >> "%LOG%" 2>&1
if exist "node_modules\electron\dist\electron.exe" goto :ok

echo [尝试 2] 通过本机代理 127.0.0.1:7890 从 GitHub 下载 ...
echo ==== try proxy 7890 >> "%LOG%"
set "ELECTRON_MIRROR="
set "HTTPS_PROXY=http://127.0.0.1:7890"
set "ELECTRON_GET_USE_PROXY=1"
set "GLOBAL_AGENT_HTTPS_PROXY=http://127.0.0.1:7890"
node node_modules\electron\install.js >> "%LOG%" 2>&1
if exist "node_modules\electron\dist\electron.exe" goto :ok

echo electron.exe MISSING >> "%LOG%"
echo 两种方式都失败了，见 get-electron.log
goto :end

:ok
echo electron.exe OK >> "%LOG%"
type node_modules\electron\dist\version >> "%LOG%" 2>&1
echo 完成。现在可以运行“启动中控.bat”试试。

:end
echo ==== done %date% %time% >> "%LOG%"
pause
endlocal
(goto) 2>nul & del "%~f0"
