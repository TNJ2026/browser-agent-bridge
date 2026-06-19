@echo off
setlocal

set "ENV_FILE=%BROWSER_AGENT_BRIDGE_ENV_FILE%"
if "%ENV_FILE%"=="" set "ENV_FILE=%USERPROFILE%\.browser-agent-bridge.env"
if exist "%ENV_FILE%" (
    for /f "usebackq tokens=* delims=" %%x in ("%ENV_FILE%") do (
        if not "%%x"=="" set "%%x"
    )
)

set "BROWSER_AGENT_BRIDGE_EXTENSION_ID=aodcpicfepmdmpfaflncbndcicoemdje"

python "%~dp0host.py" %*

endlocal
