@echo off
rem
rem Create a "build123d Studio" shortcut on the Desktop and in the Start Menu.
rem
rem Double-click this once after unpacking. It creates the shortcuts and exits;
rem it does not start anything and it changes nothing else on the machine.
rem
rem Why a shortcut is needed at all. build123d-studio.exe is Neutralino's own
rem prebuilt runtime, byte for byte, with nothing of ours compiled into it -
rem everything that makes this build123d Studio is beside it in resources.neu,
rem sidecar\, kernel\ and runtime\. Only the *name* is ours, and a filename is
rem not part of the hash.
rem
rem A normal build rewrites our icon and version strings into that executable,
rem and Microsoft Defender scores
rem the result as Trojan:Win32/Wacatac and deletes it. Measured on 0.2.0 and
rem again on 0.3.0, and on a build carrying no metadata at all - so it is not
rem what the resources say, it is that they were rewritten at all. The same
rem binary left alone passes, because millions of copies of that exact hash
rem exist in the world.
rem
rem So the executable keeps its own bytes, and the icon lives on the shortcut
rem this makes rather than inside the file.
rem
rem You can also double-click build123d-studio.exe directly - same application,
rem with Neutralino's icon instead of ours. And studio.cmd opens a particular
rem folder from a terminal.

setlocal

set "HERE=%~dp0"
set "EXE=%HERE%build123d-studio.exe"
set "ICON=%HERE%appIcon.ico"

if not exist "%EXE%" (
  echo.
  echo   build123d-studio.exe is not beside this file.
  echo   Run this from inside the unpacked build123d-studio folder.
  echo.
  pause
  exit /b 1
)

rem WScript.Shell is on every Windows since 2000 and needs nothing installed.
rem
rem WindowStyle stays 1, normal. It was 7 - minimised - while the shortcut
rem pointed at PowerShell, where it stopped a console flashing on the way to the
rem window. Pointing at the application, the same setting tells *its* window to
rem open minimised, so starting it looked like nothing happening at all. There
rem is no console on this path to hide.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$shell = New-Object -ComObject WScript.Shell;" ^
  "foreach ($dir in @($shell.SpecialFolders('Desktop'), (Join-Path $shell.SpecialFolders('StartMenu') 'Programs'))) {" ^
  "  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null };" ^
  "  $link = $shell.CreateShortcut((Join-Path $dir 'build123d Studio.lnk'));" ^
  "  $link.TargetPath = '%EXE%';" ^
  "  $link.WorkingDirectory = '%HERE:~0,-1%';" ^
  "  $link.Description = 'build123d Studio';" ^
  "  $link.WindowStyle = 1;" ^
  "  if (Test-Path -LiteralPath '%ICON%') { $link.IconLocation = '%ICON%' };" ^
  "  $link.Save();" ^
  "  Write-Host ('  created ' + (Join-Path $dir 'build123d Studio.lnk'))" ^
  "}"

echo.
echo   Start build123d Studio from the Desktop or the Start Menu.
echo.
pause

endlocal
