import sys
import os
from pathlib import Path

# Allow imports from src/ (for data_sources.py) and BE/ itself
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).parent))
# Support Docker layout: /app/src and /app/BE
sys.path.insert(0, "/app/src")
sys.path.insert(0, "/app/BE")

# ── Load .env before anything else ───────────────────────────────────────────
try:
    from dotenv import load_dotenv
    # backend/.env takes priority over root .env
    load_dotenv(Path(__file__).parent / ".env", override=False)
    load_dotenv(Path(__file__).parent.parent / ".env", override=False)
except ImportError:
    print("[WARN] python-dotenv not installed — env vars must be set manually.")
    print("       Run: pip3 install python-dotenv")

try:
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware
    import uvicorn
except ImportError:
    print("Missing deps. Run:  pip3 install fastapi uvicorn python-multipart")
    raise

from database import init_db
from routes import router

# ── CORS origins ─────────────────────────────────────────────────────────────
# Comma-separated list of allowed origins, e.g.:
#   CORS_ORIGINS=http://localhost:5173,https://app.yourdomain.com
_raw_origins = os.environ.get("CORS_ORIGINS", "")
ALLOWED_ORIGINS = [o.strip() for o in _raw_origins.split(",") if o.strip()] or ["*"]

app = FastAPI(title="Strategy Lab", version="2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)

init_db()

if __name__ == "__main__":
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "5000"))
    print("\n" + "=" * 55)
    print(f"  ⚡ Strategy Lab v2  →  http://{host}:{port}")
    print("=" * 55 + "\n")
    uvicorn.run("main:app", host=host, port=port, reload=True,
                app_dir=str(Path(__file__).parent))
