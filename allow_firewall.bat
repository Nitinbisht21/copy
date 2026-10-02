@echo off
:: Virtual Fence - Allow Port 5000 in Windows Firewall
echo ========================================================
echo Virtual Fence: Enabling Wi-Fi Access (Port 5000)
echo ========================================================

:: Check for administrative rights
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [!] Requesting Administrator privileges...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process cmd -ArgumentList '/c \"\"%~f0\"\"' -Verb RunAs"
    exit /b
)

echo [+] Removing any conflicting old rules...
netsh advfirewall firewall delete rule name="VirtualFence Port 5000" >nul 2>&1

echo [+] Adding inbound allow rule for TCP Port 5000...
netsh advfirewall firewall add rule name="VirtualFence Port 5000" dir=in action=allow protocol=TCP localport=5000 profile=any

if %errorLevel% equ 0 (
    echo ========================================================
    echo SUCCESS! Port 5000 is now OPEN for local Wi-Fi devices.
    echo ========================================================
    echo.
    echo On your phone browser (connected to the same Wi-Fi), open:
    echo.
    echo     http://192.168.1.71:5000/track
    echo.
) else (
    echo [!] Failed to add firewall rule. Error code: %errorLevel%
)

echo Press any key to close this window.
pause >nul
