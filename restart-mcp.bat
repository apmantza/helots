@echo off
cd /d "%~dp0"
echo Killing node.exe processes running mcp-server.ts...
powershell -NoProfile -Command "Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like '*mcp-server*' } | ForEach-Object { Write-Host ('Killed PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo.
echo Done. Now run /mcp in Claude Code to reconnect (Claude will respawn with fresh code).
pause
