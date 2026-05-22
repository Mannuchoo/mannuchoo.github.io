@echo off
set PORT=%1
if "%PORT%"=="" set PORT=3000
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :%PORT%') do set PID=%%a
if defined PID (
 taskkill /PID %PID% /F
 echo Killed PID %PID% on port %PORT%
) else (
 echo No process found on port %PORT%
)
