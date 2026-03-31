#!/bin/bash
cd "$(dirname "$0")/backend"
echo "Starting FastAPI backend on http://localhost:8000"
uvicorn main:app --reload --host 0.0.0.0 --port 8000
