@echo off
cd /d "%~dp0"
start "" /b npm.cmd run desktop >nul 2>&1
