@echo off
rem Talkeando local dev launcher. Brings up Postgres + server, ensures the
rem alice/bob accounts, builds the UI, and opens two client windows (one per
rem profile) for two-account / P2P testing. See scripts\dev.ps1 for details.
rem
rem   dev              full stack + two client windows
rem   dev -Reset       wipe the DB and local sessions first, then bring it up
rem   dev -SkipUiBuild skip the npm build (no UI source changes since last run)
rem   dev -NoClients   backend only, don't open the client windows
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev.ps1" %*
