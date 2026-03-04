@echo off
cd /d "%~dp0"
echo.
echo  Helots Watch UI
echo  ---------------
echo  Keys: arrow-keys navigate  Enter open file
echo        p plan  r review  n slinger  l log  s stream  q quit
echo.
node watch.mjs %*
