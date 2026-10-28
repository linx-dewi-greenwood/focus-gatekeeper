@echo off
rem Native messaging host for the browser extension: starts the hub if it is not running.
rem Do not print anything here - stdout is reserved for the browser protocol.
set ELECTRON_RUN_AS_NODE=1
"%~dp0node_modules\electron\dist\electron.exe" "%~dp0src\launcher.js" %*
