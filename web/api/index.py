"""Vercel serverless entry point: serves the FastAPI backend at /api/* next to the static site."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server.main import app  # noqa: E402,F401
