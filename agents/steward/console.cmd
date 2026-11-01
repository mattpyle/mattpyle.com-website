@echo off
rem Open the Steward console findings page. Start the console if it is not running, then open the page.
rem Desktop shortcut: right-click console.cmd, Create shortcut, drag the shortcut to the desktop.
rem Icon: shortcut Properties, Change Icon, browse to %~dp0..\..\public\favicon.ico
setlocal
cd /d "%~dp0"
set PORT=8766
set URL=http://127.0.0.1:%PORT%

where steward >nul 2>&1
if errorlevel 1 (
	echo The Steward CLI is not on PATH. Run npm link from agents\steward, then try again.
	pause
	exit /b 1
)

netstat -ano | findstr /R /C:"127\.0\.0\.1:%PORT% .*LISTENING" >nul
if errorlevel 1 (
	echo Starting the console.
	if not exist "%~dp0.cache" mkdir "%~dp0.cache"
	rem No -Redirect* here: that makes Start-Process pass this window's handles to the console.
	powershell -NoProfile -Command "Start-Process -WindowStyle Hidden -FilePath cmd.exe -ArgumentList '/c steward console --no-open --port %PORT% >\"%~dp0.cache\console.log\" 2>&1'"
) else (
	echo Console already running.
)

rem Wait up to 20 seconds for the console to answer. Its root redirects to /findings.
for /l %%i in (1,1,20) do (
	curl -s -o nul -w "%%{http_code}" %URL%/ | findstr /R "^302$ ^200$" >nul && goto open
	ping -n 2 127.0.0.1 >nul
)
echo The console did not answer on %URL%. See %~dp0.cache\console.log.
pause
exit /b 1

:open
start "" %URL%/findings
