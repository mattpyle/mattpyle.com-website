@echo off
rem Open the Steward console findings page. Start the console if it is not running, then open the page.
rem When the port is busy, compare the running console's commit (GET /api/findings) with master's in this checkout.
rem If they differ, stop the console that owns the port, log one line to .cache\console.log naming both commits,
rem and start a fresh one. If they match, or the commit cannot be read, open the page as it is.
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
if errorlevel 1 goto start

rem The port is busy. Compare the running console's commit with master's. A console from before the commit field
rem answers "none" and counts as stale. A console that does not answer, or no git, leaves it running as it is.
set RUNNING=
for /f "delims=" %%c in ('powershell -NoProfile -Command "try { $m = Invoke-RestMethod -TimeoutSec 30 %URL%/api/findings; if ($m.commit) { $m.commit } else { echo none } } catch { }"') do set RUNNING=%%c
set MASTER=
for /f "delims=" %%c in ('git rev-parse --short master 2^>nul') do set MASTER=%%c
if "%RUNNING%"=="" goto running
if "%MASTER%"=="" goto running
if "%RUNNING%"=="%MASTER%" goto running

echo Replacing the console running %RUNNING% with master %MASTER%.
if not exist "%~dp0.cache" mkdir "%~dp0.cache"
echo [%date% %time%] console.cmd replaced the console running %RUNNING% with master %MASTER%.>>"%~dp0.cache\console.log"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:"127\.0\.0\.1:%PORT% .*LISTENING"') do taskkill /T /F /PID %%p >nul 2>&1
rem Wait up to 20 seconds for the port to free.
for /l %%i in (1,1,20) do (
	netstat -ano | findstr /R /C:"127\.0\.0\.1:%PORT% .*LISTENING" >nul || goto start
	ping -n 2 127.0.0.1 >nul
)
echo The old console did not release port %PORT%. Stop it by hand, then try again.
pause
exit /b 1

:running
echo Console already running.
goto wait

:start
echo Starting the console.
if not exist "%~dp0.cache" mkdir "%~dp0.cache"
rem No -Redirect* here: that makes Start-Process pass this window's handles to the console. The log appends: the replace line above is in it.
powershell -NoProfile -Command "Start-Process -WindowStyle Hidden -FilePath cmd.exe -ArgumentList '/c steward console --no-open --port %PORT% >>\"%~dp0.cache\console.log\" 2>&1'"

:wait
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
