#!/usr/bin/env bash
# Start the Allocate NC backend (FastAPI, :8000) and web app (Vite, :5173) together. Ctrl+C stops both.
set -e
cd "$(dirname "$0")"
(cd web && ../.venv/bin/uvicorn server.main:app --port 8000) &
API=$!
trap 'kill $API 2>/dev/null' EXIT
cd web && npm run dev
