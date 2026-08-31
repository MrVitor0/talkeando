@echo off
rem Talkeando local dev launcher. Runs the backend and desktop clients locally,
rem while using the configured data/SFU services. See scripts\dev.ps1 for details.
rem
rem   dev              full stack + two client windows
rem   dev -Reset       wipe local sessions (and the Docker DB only when selected)
rem   dev -SkipUiBuild skip the npm build (no UI source changes since last run)
rem   dev -NoClients   backend only, don't open the client windows
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev.ps1" %*
