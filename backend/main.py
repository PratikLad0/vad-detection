import os
import logging
import tempfile
import shutil
from datetime import datetime
from pathlib import Path
from typing import Optional
import io
import base64
from dotenv import load_dotenv


def safe_b64decode(data: str) -> bytes:
    """
    Safely decode base64 string, adding padding if necessary.
    
    Base64 strings must have length that is a multiple of 4.
    Missing padding is added with '=' characters.
    """
    try:
        # Remove any whitespace
        data = data.strip()
        
        # Add padding if needed
        missing_padding = len(data) % 4
        if missing_padding:
            data += '=' * (4 - missing_padding)
        
        return base64.b64decode(data)
    except Exception as e:
        # Use logging directly since logger may not be initialized yet
        logging.error(f"Base64 decode error: {e}, data length: {len(data) if data else 0}")
        raise

# Load environment variables FIRST, before importing modules that need them
load_dotenv()

from fastapi import FastAPI, HTTPException, status, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel
from contextlib import asynccontextmanager
import json
import whisper
from speaker_diarization import diarize_audio
from chatbot_service import generate_chatbot_response, initialize_chatbot_backends

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Configuration from environment variables
ALLOWED_ORIGINS = os.getenv(
    "ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
).split(",")

# Get the directory where this script is located (backend directory)
BACKEND_DIR = Path(__file__).parent.resolve()
# Make RECORDINGS_DIR absolute - resolve relative to backend directory
recordings_path = os.getenv("RECORDINGS_DIR", "recordings")
RECORDINGS_DIR = (BACKEND_DIR / recordings_path).resolve() if not Path(recordings_path).is_absolute() else Path(recordings_path)

# Ensure recordings directory exists
RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
logger.info(f"Recordings directory: {RECORDINGS_DIR}")

# Initialize Whisper model (lazy loading)
_whisper_model: Optional[whisper.Whisper] = None
WHISPER_MODEL_NAME = os.getenv("WHISPER_MODEL", "base")  # tiny, base, small, medium, large (tiny is fastest for 300ms target)

# Global device preference (cpu or cuda)
_USE_GPU: Optional[bool] = None


def prompt_device_choice() -> bool:
    """
    Prompt user to choose between CPU or CUDA (GPU).
    Returns True if GPU should be used, False for CPU.
    Also sets USE_GPU environment variable for other modules.
    """
    # Check if USE_GPU is set in environment (for non-interactive use)
    use_gpu_env = os.getenv("USE_GPU", "").lower()
    if use_gpu_env in ("true", "1", "yes", "cuda"):
        os.environ["USE_GPU"] = "true"  # Ensure it's set for other modules
        return True
    elif use_gpu_env in ("false", "0", "no", "cpu"):
        os.environ["USE_GPU"] = "false"  # Ensure it's set for other modules
        return False
    
    # Check if running in non-interactive mode (Docker, systemd, etc.)
    if not os.isatty(0):  # No TTY available
        # Default to CPU for non-interactive mode
        # Use logging directly since logger may not be initialized when this is called early
        logging.info("Non-interactive mode detected - defaulting to CPU")
        logging.info("Set USE_GPU=true in environment to use GPU")
        os.environ["USE_GPU"] = "false"
        return False
    
    # Check GPU availability first
    gpu_available = False
    gpu_name = None
    try:
        import torch
        if torch.cuda.is_available():
            gpu_available = True
            gpu_name = torch.cuda.get_device_name(0)
    except ImportError:
        pass
    
    # Interactive prompt
    print("\n" + "=" * 60)
    print("Device Selection")
    print("=" * 60)
    
    if gpu_available:
        print(f"✅ GPU Available: {gpu_name}")
        print("\nChoose device:")
        print("  1. CUDA (GPU) - Faster, requires GPU")
        print("  2. CPU - Slower, works on all systems")
        print()
        
        while True:
            try:
                choice = input("Enter choice (1 for GPU, 2 for CPU) [1]: ").strip()
                if not choice:
                    choice = "1"  # Default to GPU if available
                
                if choice == "1":
                    print("✅ Using GPU (CUDA)")
                    os.environ["USE_GPU"] = "true"  # Set for other modules
                    return True
                elif choice == "2":
                    print("✅ Using CPU")
                    os.environ["USE_GPU"] = "false"  # Set for other modules
                    return False
                else:
                    print("❌ Invalid choice. Please enter 1 or 2.")
            except (EOFError, KeyboardInterrupt):
                print("\n⚠️  Interrupted - defaulting to CPU")
                os.environ["USE_GPU"] = "false"
                return False
    else:
        print("ℹ️  GPU not available - using CPU")
        print("   To enable GPU: See GPU_SETUP.md")
        os.environ["USE_GPU"] = "false"
        return False


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Startup and shutdown events for FastAPI application.
    Pre-loads models and initializes services.
    """
    # Startup
    logger.info("=" * 60)
    logger.info("Starting VAD WebRTC Recorder Backend...")
    logger.info("=" * 60)
    
    # Get device preference (will prompt user if interactive)
    device = get_device()
    
    # Log device information
    if device == "cuda":
        try:
            import torch
            gpu_name = torch.cuda.get_device_name(0)
            cuda_version = torch.version.cuda
            gpu_memory = torch.cuda.get_device_properties(0).total_memory / (1024**3)  # GB
            logger.info(f"✅ Using GPU: {gpu_name}")
            logger.info(f"   CUDA Version: {cuda_version}")
            logger.info(f"   GPU Memory: {gpu_memory:.1f} GB")
            logger.info("   GPU acceleration enabled for:")
            logger.info("     - Whisper transcription")
            logger.info("     - Speaker diarization")
        except Exception as e:
            logger.warning(f"⚠️  GPU info unavailable: {e}")
    else:
        logger.info("ℹ️  Using CPU mode")
        logger.info("   To use GPU: Set USE_GPU=true or restart and choose GPU option")
    
    # Initialize Chatbot backends
    chatbot_status = initialize_chatbot_backends()
    
    logger.info("=" * 60)
    logger.info("Backend startup complete!")
    logger.info("=" * 60)
    
    yield
    
    # Shutdown
    logger.info("Shutting down backend...")


app = FastAPI(
    title="VAD WebRTC Recorder Backend",
    description="Backend API for VAD-based audio recording",
    version="1.0.0",
    lifespan=lifespan,
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
    allow_methods=["GET", "POST", "OPTIONS", "WEBSOCKET"],
    allow_headers=["*"],
    max_age=3600,
)

def check_ffmpeg():
    """Check if FFmpeg is available"""
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path:
        logger.info(f"FFmpeg found at: {ffmpeg_path}")
        return True
    else:
        logger.warning("FFmpeg not found in PATH. Whisper requires FFmpeg to process audio files.")
        logger.warning("Please install FFmpeg: https://ffmpeg.org/download.html")
        return False

# Check FFmpeg on startup
if not check_ffmpeg():
    logger.error("=" * 60)
    logger.error("WARNING: FFmpeg is not installed or not in PATH!")
    logger.error("Whisper transcription will not work without FFmpeg.")
    logger.error("Please install FFmpeg from: https://ffmpeg.org/download.html")
    logger.error("For Windows: Download from https://www.gyan.dev/ffmpeg/builds/")
    logger.error("After installation, ensure 'ffmpeg.exe' is in your system PATH.")
    logger.error("=" * 60)

def get_device() -> str:
    """Get the device to use (cpu or cuda) based on user preference and availability"""
    global _USE_GPU
    
    # Initialize device preference if not set
    if _USE_GPU is None:
        _USE_GPU = prompt_device_choice()
    
    # Check if GPU is actually available
    if _USE_GPU:
        try:
            import torch
            if torch.cuda.is_available():
                return "cuda"
            else:
                logger.warning("GPU requested but not available - falling back to CPU")
                return "cpu"
        except ImportError:
            logger.warning("GPU requested but PyTorch not available - falling back to CPU")
            return "cpu"
    
    return "cpu"


def get_whisper_model():
    """Lazy load Whisper model with GPU support if available"""
    global _whisper_model
    if _whisper_model is None:
        # Check for FFmpeg first
        if not check_ffmpeg():
            raise RuntimeError(
                "FFmpeg is not installed or not in PATH. "
                "Please install FFmpeg from https://ffmpeg.org/download.html "
                "and ensure it's in your system PATH."
            )
        
        # Get device preference
        device = get_device()
        
        if device == "cuda":
            try:
                import torch
                logger.info(f"GPU detected: {torch.cuda.get_device_name(0)}")
                logger.info(f"CUDA version: {torch.version.cuda}")
            except ImportError:
                device = "cpu"
                logger.warning("PyTorch not available, falling back to CPU")
        
        logger.info(f"Loading Whisper model: {WHISPER_MODEL_NAME} on {device}")
        try:
            _whisper_model = whisper.load_model(WHISPER_MODEL_NAME, device=device)
            logger.info(f"Whisper model loaded successfully on {device}")
        except Exception as e:
            logger.error(f"Failed to load Whisper model: {str(e)}")
            raise RuntimeError(f"Failed to load Whisper model: {str(e)}")
    return _whisper_model


class HealthResponse(BaseModel):
    status: str
    version: str
    recordings_count: int


@app.get("/health", response_model=HealthResponse)
async def health():
    """Health check endpoint"""
    recordings_count = len(list(RECORDINGS_DIR.glob("*.webm"))) if RECORDINGS_DIR.exists() else 0
    
    # Check FFmpeg availability
    ffmpeg_available = check_ffmpeg()
    if not ffmpeg_available:
        logger.warning("Health check: FFmpeg not available")
    
    return {
        "status": "ok" if ffmpeg_available else "warning",
        "version": "1.0.0",
        "recordings_count": recordings_count,
    }


@app.websocket("/ws/audio")
async def websocket_audio_stream(websocket: WebSocket):
    """
    WebSocket endpoint for real-time audio streaming and transcription.
    Receives audio chunks, buffers them, and transcribes when speech segment ends.
    """
    await websocket.accept()
    logger.info("WebSocket connection established")
    
    session_id: Optional[str] = None
    audio_buffer = io.BytesIO()
    model = None
    
    try:
        # Initialize Whisper model
        try:
            model = get_whisper_model()
        except Exception as model_error:
            error_msg = f"Failed to initialize Whisper model: {str(model_error)}"
            logger.error(error_msg)
            await websocket.send_json({
                "type": "error",
                "message": error_msg
            })
            return
        
        while True:
            # Receive message from client
            try:
                data = await websocket.receive()
            except RuntimeError as e:
                # Handle case where disconnect message was already received
                if "disconnect" in str(e).lower() or "Cannot call" in str(e):
                    logger.info("WebSocket disconnect detected")
                    break
                raise
            
            if "text" in data:
                # JSON message (control)
                message = json.loads(data["text"])
                msg_type = message.get("type")
                
                if msg_type == "session":
                    session_id = message.get("session_id")
                    logger.info(f"Session started: {session_id}")
                    await websocket.send_json({"type": "session_ack", "session_id": session_id})
                
                elif msg_type == "audio_chunk":
                    # Base64 encoded audio chunk
                    chunk_data = message.get("data")
                    if chunk_data:
                        try:
                            chunk_bytes = safe_b64decode(chunk_data)
                            audio_buffer.write(chunk_bytes)
                            await websocket.send_json({"type": "chunk_received"})
                        except Exception as e:
                            logger.error(f"Error decoding audio chunk: {e}")
                            await websocket.send_json({
                                "type": "error",
                                "message": f"Failed to decode audio chunk: {str(e)}"
                            })
                    else:
                        # Empty chunk - acknowledge but don't add to buffer
                        await websocket.send_json({"type": "chunk_received"})
                
                elif msg_type == "segment_end":
                    # Speech segment ended, transcribe the buffer
                    if audio_buffer.tell() > 0:
                        audio_buffer.seek(0)
                        audio_data = audio_buffer.read()
                        
                        if len(audio_data) > 0:
                            # Save to temp file for Whisper
                            tmp_path = None
                            try:
                                with tempfile.NamedTemporaryFile(delete=False, suffix=".webm") as tmp_file:
                                    tmp_file.write(audio_data)
                                    tmp_path = tmp_file.name
                                
                                # Verify temp file exists and has content
                                if not os.path.exists(tmp_path):
                                    raise FileNotFoundError(f"Temporary file not created: {tmp_path}")
                                
                                file_size = os.path.getsize(tmp_path)
                                if file_size == 0:
                                    logger.warning("Audio buffer is empty, skipping transcription")
                                    await websocket.send_json({
                                        "type": "error",
                                        "message": "Empty audio buffer"
                                    })
                                else:
                                    if model is None:
                                        error_msg = "Whisper model not initialized"
                                        logger.error(error_msg)
                                        await websocket.send_json({
                                            "type": "error",
                                            "message": error_msg
                                        })
                                    else:
                                        # Transcribe with ultra-fast settings optimized for speed
                                        result = model.transcribe(
                                            tmp_path, 
                                            language="en",
                                            task="transcribe",
                                            fp16=False,  # Use fp32 for compatibility
                                            verbose=False,  # Reduce logging overhead
                                            condition_on_previous_text=False,  # Faster - don't condition on previous text
                                            compression_ratio_threshold=2.4,  # Faster processing
                                            logprob_threshold=-1.0,  # Lower threshold for faster results
                                            no_speech_threshold=0.6,  # Faster detection
                                            # Additional performance optimizations
                                            initial_prompt=None,  # Skip prompt for speed
                                            word_timestamps=False,  # Disable word timestamps for speed
                                        )
                                        transcription = result["text"].strip()
                                        
                                        # Perform speaker diarization (for logging only, not sent to frontend)
                                        speaker_info = None
                                        try:
                                            diarization_results = diarize_audio(tmp_path, num_speakers=None)
                                            if diarization_results:
                                                speaker_info = diarization_results[0] if diarization_results else None
                                        except Exception as diarization_error:
                                            logger.warning(f"Speaker diarization failed (non-critical): {str(diarization_error)}")
                                        
                                        # Save to session log with speaker info (if transcription exists)
                                        if transcription and session_id:
                                            session_log_path = RECORDINGS_DIR / f"{session_id}.txt"
                                            timestamp = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC")
                                            
                                            # Format log entry with speaker label
                                            speaker_prefix = f"[{speaker_info['speaker_label']}] " if speaker_info and speaker_info.get('speaker_label') else ""
                                            log_entry = f"[{timestamp}] {speaker_prefix}{transcription}\n\n"
                                            
                                            with open(session_log_path, "a", encoding="utf-8") as f:
                                                f.write(log_entry)
                                        
                                        # Always generate and send chatbot response, even if transcription is empty
                                        if transcription:
                                            try:
                                                chatbot_result = generate_chatbot_response(transcription)
                                                
                                                if chatbot_result.get("error"):
                                                    logger.warning(f"Chatbot error: {chatbot_result['error']}")
                                                    await websocket.send_json({
                                                        "type": "chatbot_response",
                                                        "response": None,
                                                        "error": chatbot_result["error"],
                                                        "backend_used": chatbot_result.get("backend_used", "guardrails"),
                                                        "transcription": transcription
                                                    })
                                                elif chatbot_result.get("response"):
                                                    await websocket.send_json({
                                                        "type": "chatbot_response",
                                                        "response": chatbot_result["response"],
                                                        "backend_used": chatbot_result.get("backend_used", "unknown"),
                                                        "error": None,
                                                        "transcription": transcription
                                                    })
                                                else:
                                                    logger.warning("Chatbot failed to generate response")
                                                    await websocket.send_json({
                                                        "type": "chatbot_response",
                                                        "response": None,
                                                        "error": chatbot_result.get("error", "Chatbot failed to generate response"),
                                                        "backend_used": chatbot_result.get("backend_used") or "unknown",
                                                        "transcription": transcription
                                                    })
                                            except Exception as chatbot_error:
                                                logger.error(f"Chatbot error: {str(chatbot_error)}", exc_info=True)
                                                # Always send chatbot_response even if chatbot fails, so frontend knows what happened
                                                await websocket.send_json({
                                                    "type": "chatbot_response",
                                                    "response": None,
                                                    "error": f"Chatbot error: {str(chatbot_error)}",
                                                    "backend_used": "error",
                                                    "transcription": transcription
                                                })
                                        else:
                                            # Empty transcription - still send response so frontend knows
                                            logger.warning("Empty transcription received, sending empty response")
                                            await websocket.send_json({
                                                "type": "chatbot_response",
                                                "response": None,
                                                "error": "No speech detected in audio segment",
                                                "backend_used": "none",
                                                "transcription": ""
                                            })
                            
                            except FileNotFoundError as e:
                                error_msg = f"File not found: {str(e)}. This may indicate FFmpeg is not installed."
                                logger.error(error_msg)
                                await websocket.send_json({
                                    "type": "error",
                                    "message": error_msg
                                })
                            except Exception as e:
                                error_msg = f"Transcription error: {str(e)}"
                                logger.error(error_msg, exc_info=True)
                                
                                # Provide helpful error message for common issues
                                if "ffmpeg" in str(e).lower() or "winerror 2" in str(e).lower():
                                    error_msg = "FFmpeg not found. Please install FFmpeg from https://ffmpeg.org/download.html"
                                
                                await websocket.send_json({
                                    "type": "error",
                                    "message": error_msg
                                })
                            finally:
                                # Cleanup temp file
                                if tmp_path and os.path.exists(tmp_path):
                                    try:
                                        os.unlink(tmp_path)
                                    except Exception as cleanup_error:
                                        logger.warning(f"Failed to cleanup temp file: {cleanup_error}")
                            
                            # Clear buffer
                            audio_buffer = io.BytesIO()
                            logger.info(f"🧹 Audio buffer cleared for session {session_id}")
                    else:
                        logger.warning(f"⚠️ Audio buffer is empty (tell() <= 0) for session {session_id}, cannot process segment_end")
                        await websocket.send_json({
                            "type": "error",
                            "message": "No audio data received before segment_end"
                        })
                    
                    await websocket.send_json({"type": "segment_processed"})
                    logger.info(f"✅ Sent segment_processed for session {session_id}")
                
                elif msg_type == "close":
                    break
            
            elif "bytes" in data:
                # Binary audio data
                audio_buffer.write(data["bytes"])
                try:
                    await websocket.send_json({"type": "chunk_received"})
                except Exception:
                    # Client disconnected, break the loop
                    logger.info("WebSocket disconnected while sending response")
                    break
    
    except WebSocketDisconnect:
        logger.info("WebSocket disconnected")
    except RuntimeError as e:
        # Handle "Cannot call receive once a disconnect message has been received"
        if "disconnect" in str(e).lower() or "Cannot call" in str(e):
            logger.info("WebSocket disconnect detected (RuntimeError)")
        else:
            logger.error(f"WebSocket RuntimeError: {str(e)}", exc_info=True)
            try:
                await websocket.send_json({"type": "error", "message": str(e)})
            except:
                pass
    except Exception as e:
        logger.error(f"WebSocket error: {str(e)}", exc_info=True)
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except:
            pass
    finally:
        try:
            audio_buffer.close()
        except:
            pass
