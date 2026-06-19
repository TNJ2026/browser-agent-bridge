@echo off
setlocal

:: Load security token from user profile env file
set "ENV_FILE=%USERPROFILE%\.browser-agent-bridge.env"
if exist "%ENV_FILE%" (
    for /f "usebackq tokens=* delims=" %%x in ("%ENV_FILE%") do (
        set "%%x"
    )
)

:: Set stable Extension ID
set "BROWSER_AGENT_BRIDGE_EXTENSION_ID=aodcpicfepmdmpfaflncbndcicoemdje"

:: Launch Python host
python "%~dp0host.py" %*

endlocal
