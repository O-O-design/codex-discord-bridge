@echo off
cd /d "%~dp0"
echo Opening Codex login...
".\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe" login
echo.
echo Codex login command finished.
pause
