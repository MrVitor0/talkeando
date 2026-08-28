@echo off
rem Opens two Talkeando client windows pointed at the hosted/prod API (whatever
rem client\native\Talkeando.Client\talkeando.settings.json says). No local
rem server or Postgres. Use dev.cmd for the full LOCAL stack instead.
rem
rem   clients                       alice + bob windows, builds UI + native first
rem   clients -SkipBuild            reuse both UI and native build outputs
rem   clients -Profiles alice,carol pick which profiles to open
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\clients.ps1" %*
