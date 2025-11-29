from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse


app = FastAPI(title="VAD WebRTC Recorder Backend")

# Configure CORS for local frontend dev
origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


RECORDINGS_DIR = Path("recordings")
RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)


@app.post("/upload")
async def upload_audio(file: UploadFile = File(...)):
    """
    Receive a single audio file (e.g. webm/opus) and save it to disk.
    """
    suffix = Path(file.filename).suffix or ".webm"
    timestamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S-%f")
    out_path = RECORDINGS_DIR / f"recording-{timestamp}{suffix}"

    contents = await file.read()
    out_path.write_bytes(contents)

    return JSONResponse({"status": "ok", "filename": out_path.name})


@app.get("/health")
async def health():
    return {"status": "ok"}


# Run with: uvicorn backend.main:app --reload


