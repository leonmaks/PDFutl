@echo off
node "%~dp0scripts\code-oss.mjs" start %*
exit /b %errorlevel%
