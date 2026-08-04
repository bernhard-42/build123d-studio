@echo off
rem
rem build123d Studio from the command line.
rem
rem   studio                  open the current directory as the project
rem   studio .                the same, said explicitly
rem   studio C:\path\to\folder  open that folder as the project
rem   studio main.py          open main.py, with its folder as the project
rem
rem Every form starts a new instance.
rem
rem Copy it somewhere on your PATH:
rem
rem   copy "C:\path\to\build123d-studio\studio.cmd" "%USERPROFILE%\bin\studio.cmd"
rem
rem It does not work out where the application is from its own location - once
rem copied it has no relationship to the folder it came from. The application
rem records its location on every start instead, and this reads that. So run
rem build123d Studio once before using this.

setlocal

set "DATA_DIR=%APPDATA%\build123d-studio"
set "LOCATION_FILE=%DATA_DIR%\app-location"

if not exist "%LOCATION_FILE%" (
  echo studio: cannot find build123d Studio.>&2
  echo studio: expected its location in "%LOCATION_FILE%">&2
  echo studio: start the application once and try again.>&2
  exit /b 1
)

set "APP_DIR="
for /f "usebackq delims=" %%L in ("%LOCATION_FILE%") do set "APP_DIR=%%L"

if not defined APP_DIR (
  echo studio: "%LOCATION_FILE%" is empty.>&2
  exit /b 1
)

set "EXE=%APP_DIR%\build123d-studio.exe"
if not exist "%EXE%" (
  echo studio: build123d Studio was last seen at "%APP_DIR%", which is gone.>&2
  echo studio: start it once from where it is installed now.>&2
  exit /b 1
)

rem Resolve before launching. "." and a bare filename mean something only
rem relative to this shell's current directory, and the application is not
rem started from it.
set "TARGET=%~1"
if not defined TARGET set "TARGET=."

if exist "%TARGET%\" (
  for %%P in ("%TARGET%") do set "RESOLVED=%%~fP"
) else if exist "%TARGET%" (
  for %%P in ("%TARGET%") do set "RESOLVED=%%~fP"
) else (
  echo studio: no such file or directory: "%TARGET%">&2
  exit /b 1
)

rem `start` with an empty title, so a quoted path is not mistaken for one, and
rem the launcher returns instead of blocking this console.
start "" "%EXE%" "--open=%RESOLVED%"
endlocal
