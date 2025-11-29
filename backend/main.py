import os
import logging
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, File, UploadFile, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel
import json

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Configuration from environment variables
API_URL = os.getenv("API_URL", "http://localhost:8000")
ALLOWED_ORIGINS = os.getenv(
    "ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
).split(",")
MAX_FILE_SIZE = int(os.getenv("MAX_FILE_SIZE_MB", "50")) * 1024 * 1024  # 50MB default

# Get the directory where this script is located (backend directory)
BACKEND_DIR = Path(__file__).parent.resolve()
# Make RECORDINGS_DIR absolute - resolve relative to backend directory
recordings_path = os.getenv("RECORDINGS_DIR", "recordings")
RECORDINGS_DIR = (BACKEND_DIR / recordings_path).resolve() if not Path(recordings_path).is_absolute() else Path(recordings_path)

app = FastAPI(
    title="VAD WebRTC Recorder Backend",
    description="Backend API for VAD-based audio recording",
    version="1.0.0",
)

# Security: Trusted Host Middleware
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=["*"],  # TODO: Configure appropriately for production
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    max_age=3600,
)

# Ensure recordings directory exists
RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
logger.info(f"Recordings directory: {RECORDINGS_DIR}")


class HealthResponse(BaseModel):
    status: str
    version: str
    recordings_count: int


class TranscriptionRequest(BaseModel):
    text: str
    session_id: str


@app.get("/health", response_model=HealthResponse)
async def health():
    """Health check endpoint"""
    recordings_count = len(list(RECORDINGS_DIR.glob("*.webm"))) if RECORDINGS_DIR.exists() else 0
    return {
        "status": "ok",
        "version": "1.0.0",
        "recordings_count": recordings_count,
    }


@app.post("/upload")
async def upload_audio(file: UploadFile = File(...)):
    """
    Receive a single audio file (e.g. webm/opus) and save it to disk.
    
    - Validates file size
    - Validates file extension
    - Saves to recordings directory with timestamp
    """
    # Validate file extension
    allowed_extensions = {".webm", ".opus", ".ogg", ".wav", ".m4a", ".txt"}
    file_ext = Path(file.filename or "").suffix.lower()
    
    if file_ext not in allowed_extensions:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid file type. Allowed: {', '.join(allowed_extensions)}",
        )

    # Read file content
    try:
        contents = await file.read()
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to read file: {str(e)}",
        )

    # Validate file size
    if len(contents) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File too large. Maximum size: {MAX_FILE_SIZE / (1024 * 1024):.1f}MB",
        )

    if len(contents) == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File is empty",
        )

    # Generate filename with timestamp
    timestamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S-%f")
    out_path = RECORDINGS_DIR / f"recording-{timestamp}{file_ext}"

    try:
        # Write file to disk
        out_path.write_bytes(contents)
        
        # Return relative path from backend directory for display
        try:
            relative_path = str(out_path.relative_to(BACKEND_DIR))
        except ValueError:
            # If paths can't be made relative, just use the filename
            relative_path = out_path.name
        
        return JSONResponse({
            "status": "ok",
            "filename": out_path.name,
            "size": len(contents),
            "path": relative_path,
        })
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to save file: {str(e)}",
        )


@app.post("/transcription")
async def save_transcription(request: TranscriptionRequest):
    """
    Receive transcription text and append it to a session log file.
    
    - Creates/updates a session log file per session_id
    - Appends transcription with timestamp
    - Saves to recordings directory
    """
    try:
        # Create session log file path
        session_log_path = RECORDINGS_DIR / f"{request.session_id}.txt"
        
        # Prepare log entry with timestamp
        timestamp = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC")
        log_entry = f"[{timestamp}]\n{request.text}\n\n"
        
        # Check if file exists (to log if it's a new file or append)
        file_exists = session_log_path.exists()
        
        # Append to session log file
        with open(session_log_path, "a", encoding="utf-8") as f:
            f.write(log_entry)
        
        # Log to console
        text_preview = request.text[:100] + "..." if len(request.text) > 100 else request.text
        logger.info(
            f"Transcription saved - Session: {request.session_id}, "
            f"File: {session_log_path.name}, "
            f"Text length: {len(request.text)} chars, "
            f"Preview: {text_preview}"
        )
        
        if not file_exists:
            logger.info(f"Created new session log file: {session_log_path}")
        
        return JSONResponse({
            "status": "ok",
            "message": f"Transcription saved to session log",
            "session_id": request.session_id,
            "log_file": session_log_path.name,
            "log_path": str(session_log_path),
            "text_length": len(request.text),
        })
    except Exception as e:
        logger.error(f"Failed to save transcription: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to save transcription: {str(e)}",
        )


@app.get("/recordings")
async def list_recordings(limit: int = 10):
    """List recent recordings"""
    if not RECORDINGS_DIR.exists():
        return {"recordings": []}
    
    recordings = sorted(
        RECORDINGS_DIR.glob("*.webm"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )[:limit]
    
    return {
        "recordings": [
            {
                "filename": r.name,
                "size": r.stat().st_size,
                "modified": datetime.fromtimestamp(r.stat().st_mtime).isoformat(),
            }
            for r in recordings
        ]
    }


@app.get("/transcription-logs")
async def list_transcription_logs():
    """List all transcription log files (session .txt files)"""
    if not RECORDINGS_DIR.exists():
        return {"logs": []}
    
    log_files = sorted(
        RECORDINGS_DIR.glob("*.txt"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    
    logs_info = []
    for log_file in log_files:
        try:
            # Read first few lines to get session info
            with open(log_file, "r", encoding="utf-8") as f:
                lines = f.readlines()
                entry_count = len([l for l in lines if l.startswith("[")])
                first_entry = lines[0].strip() if lines else "No entries"
        except Exception as e:
            logger.warning(f"Error reading log file {log_file.name}: {e}")
            entry_count = 0
            first_entry = "Error reading file"
        
        logs_info.append({
            "session_id": log_file.stem,
            "filename": log_file.name,
            "size": log_file.stat().st_size,
            "modified": datetime.fromtimestamp(log_file.stat().st_mtime).isoformat(),
            "entry_count": entry_count,
            "first_entry": first_entry,
        })
    
    return {"logs": logs_info}


@app.get("/transcription-logs/{session_id}")
async def get_transcription_log(session_id: str):
    """Get the full content of a specific session log file"""
    if not RECORDINGS_DIR.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Recordings directory not found",
        )
    
    log_file = RECORDINGS_DIR / f"{session_id}.txt"
    
    if not log_file.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Log file for session {session_id} not found",
        )
    
    try:
        with open(log_file, "r", encoding="utf-8") as f:
            content = f.read()
        
        return {
            "session_id": session_id,
            "filename": log_file.name,
            "content": content,
            "size": len(content),
            "modified": datetime.fromtimestamp(log_file.stat().st_mtime).isoformat(),
        }
    except Exception as e:
        logger.error(f"Error reading log file {log_file.name}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to read log file: {str(e)}",
        )


@app.get("/recordings/{filename}")
async def get_recording_file(filename: str):
    """Download/serve a specific audio recording file"""
    if not RECORDINGS_DIR.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Recordings directory not found",
        )
    
    # Security: prevent path traversal
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid filename",
        )
    
    file_path = RECORDINGS_DIR / filename
    
    if not file_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Recording file {filename} not found",
        )
    
    # Validate it's an audio file
    allowed_extensions = {".webm", ".opus", ".ogg", ".wav", ".m4a"}
    if file_path.suffix.lower() not in allowed_extensions:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid file type",
        )
    
    return FileResponse(
        path=str(file_path),
        filename=filename,
        media_type="audio/webm" if file_path.suffix == ".webm" else "audio/ogg"
    )


