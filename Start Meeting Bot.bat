@echo off
rem Windows: double-click this file to start Meeting Bot.
cd /d "%~dp0"
title Meeting Bot

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed ^(it is needed to run Meeting Bot^).
  echo Install Node.js 22 LTS or newer from https://nodejs.org , then double-click this file again.
  start "" "https://nodejs.org/en/download"
  echo.
  pause
  exit /b 1
)

node scripts\launch.js %*
if errorlevel 1 (
  echo.
  pause
)
