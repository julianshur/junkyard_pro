@echo off
REM Hourly scrape launcher for Windows Task Scheduler.
REM Edit the path below to wherever you cloned the scraper folder.

cd /d C:\junkyard\scraper

REM Load secrets. Either set these as Windows user env vars (preferred),
REM or uncomment and fill in here:
REM set TURSO_DATABASE_URL=libsql://your-db.turso.io
REM set TURSO_AUTH_TOKEN=your-readwrite-token
REM set ANTHROPIC_API_KEY=sk-ant-...
REM set FEE_RATE=0.15

node index.js >> scrape.log 2>&1
