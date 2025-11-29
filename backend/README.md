# Backend - VAD WebRTC Recorder API

FastAPI backend for the VAD-based audio recorder. Handles file uploads, storage, and provides health check endpoints.

## Prerequisites

- **Python** 3.9+
- **pip** (Python package manager)
- **FFmpeg** (required for Whisper audio processing)
- **RAM**: Minimum 4GB, 8GB+ recommended (for Hugging Face models)
- **Storage**: 5-10GB free space (for models and dependencies)
- **GPU** (optional): NVIDIA GPU with CUDA for faster Hugging Face inference

### Installing FFmpeg

**Windows:**
1. Download FFmpeg from: https://www.gyan.dev/ffmpeg/builds/
2. Extract the zip file to a location (e.g., `C:\ffmpeg`)
3. Add FFmpeg to your system PATH:
   - Open System Properties → Environment Variables
   - Edit the "Path" variable
   - Add the path to the `bin` folder (e.g., `C:\ffmpeg\bin`)
4. Verify installation: Open PowerShell/CMD and run `ffmpeg -version`

**Linux:**
```bash
sudo apt-get update
sudo apt-get install ffmpeg
```

**macOS:**
```bash
brew install ffmpeg
```

## Installation

1. **Create Virtual Environment**:

```bash
# Windows PowerShell:
python -m venv .venv
.venv\Scripts\Activate.ps1

# Windows CMD:
python -m venv .venv
.venv\Scripts\activate.bat

# Linux/Mac:
python3 -m venv .venv
source .venv/bin/activate
```

2. **Install Dependencies**:

```bash
pip install -r requirements.txt
```

**Note on Hugging Face:**
- Models download automatically on first use (350MB-1.5GB depending on model)
- For CPU usage: No additional setup needed
- For GPU usage: Install CUDA toolkit and ensure GPU drivers are compatible

## Development

Run the development server:

```bash
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

The API will be available at `http://localhost:8000`

API documentation:
- Swagger UI: `http://localhost:8000/docs`
- ReDoc: `http://localhost:8000/redoc`

## Production Deployment

### Using Uvicorn

```bash
uvicorn main:app --host 0.0.0.0 --port 8000 --workers 4
```

### Environment Variables

Set the following environment variables:

```bash
# API Configuration
export API_URL=https://your-api-domain.com
export ALLOWED_ORIGINS=https://your-frontend-domain.com,http://localhost:5173

# File Upload Settings
export MAX_FILE_SIZE_MB=50

# Storage
export RECORDINGS_DIR=/path/to/recordings
```

### Using Process Manager (PM2)

```bash
pm2 start "uvicorn main:app --host 0.0.0.0 --port 8000" --name vad-recorder-api
```

### Using systemd (Linux)

Create `/etc/systemd/system/vad-recorder.service`:

```ini
[Unit]
Description=VAD Recorder API
After=network.target

[Service]
User=www-data
WorkingDirectory=/path/to/backend
Environment="PATH=/path/to/venv/bin"
ExecStart=/path/to/venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
Restart=always

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl enable vad-recorder
sudo systemctl start vad-recorder
```

## API Endpoints

### `GET /health`

Health check endpoint. Returns system status and recordings count.

**Response**:
```json
{
  "status": "ok",
  "version": "1.0.0",
  "recordings_count": 5
}
```

### `POST /upload`

Upload audio or text file.

**Request**:
- Method: `POST`
- Content-Type: `multipart/form-data`
- Body: Form data with `file` field

**Supported File Types**:
- Audio: `.webm`, `.opus`, `.ogg`, `.wav`, `.m4a`
- Text: `.txt`

**Response**:
```json
{
  "status": "ok",
  "filename": "recording-20241129-120000-123456.webm",
  "size": 12345,
  "path": "recordings/recording-20241129-120000-123456.webm"
}
```

**Error Responses**:
- `400 Bad Request`: Invalid file type or empty file
- `413 Payload Too Large`: File exceeds size limit
- `500 Internal Server Error`: Server error

### `GET /recordings`

List recent recordings (if implemented).

**Query Parameters**:
- `limit` (optional): Maximum number of recordings to return (default: 10)

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `API_URL` | API base URL | `http://localhost:8000` |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins | `http://localhost:5173,http://127.0.0.1:5173` |
| `MAX_FILE_SIZE_MB` | Maximum file size in MB | `50` |
| `RECORDINGS_DIR` | Directory for recordings | `recordings` |

### File Storage

- Recordings are saved to `backend/recordings/` by default
- Directory is created automatically if it doesn't exist
- Files are named with timestamp: `recording-YYYYMMDD-HHMMSS-microseconds.ext`
- Text files: `transcription-YYYY-MM-DDTHH-MM-SS.txt`

## Security Features

- ✅ **CORS Protection**: Configurable allowed origins
- ✅ **File Type Validation**: Only allowed extensions accepted
- ✅ **File Size Limits**: Prevents oversized uploads
- ✅ **Input Validation**: Pydantic models for request validation
- ✅ **Error Handling**: Comprehensive error responses
- ✅ **Trusted Host Middleware**: Security headers

## Project Structure

```
backend/
├── main.py              # FastAPI application and endpoints
├── recordings/          # Saved audio and text files (gitignored)
├── requirements.txt     # Python dependencies
└── README.md           # This file
```

## Dependencies

- `fastapi`: Web framework
- `uvicorn`: ASGI server
- `python-multipart`: Form data parsing
- `pydantic`: Data validation

## Troubleshooting

### Port Already in Use

```bash
# Find process using port 8000
# Windows:
netstat -ano | findstr :8000

# Linux/Mac:
lsof -i :8000

# Kill process or use different port
uvicorn main:app --port 8001
```

### Permission Errors

Ensure the backend has write permissions to the recordings directory:

```bash
# Linux/Mac:
chmod 755 recordings
chown -R user:user recordings
```

### CORS Errors

- Verify `ALLOWED_ORIGINS` includes your frontend URL
- Check browser console for CORS error details
- Ensure backend is running and accessible

### File Upload Fails

- Check file size is within `MAX_FILE_SIZE_MB` limit
- Verify file extension is allowed
- Check disk space in recordings directory
- Review server logs for detailed errors

## Logging

The application logs to stdout/stderr. For production, consider:

- Using a logging framework (e.g., `structlog`)
- Configuring log rotation
- Sending logs to a centralized service

## Testing

### Manual API Testing

```bash
# Test health endpoint
curl http://localhost:8000/health

# Test file upload
curl -X POST -F "file=@test.webm" http://localhost:8000/upload
```

### Automated Performance Tests

Run comprehensive performance tests with automatic reporting:

```bash
# Run all tests (reports generated automatically)
pytest tests/ -v

# Run specific test categories
pytest tests/test_transcription_performance.py -v
pytest tests/test_chatbot_performance.py -v
pytest tests/test_websocket_integration.py -v
pytest tests/test_frontend_simulation.py -v

# Run with detailed output
pytest tests/ -v -s
```

### Test Reports

Tests automatically generate comprehensive HTML and JSON reports with:
- **Performance Metrics**: Average, min, max, median, P95, P99, standard deviation
- **Category Analysis**: Transcription, chatbot, WebSocket, end-to-end
- **Performance Targets**: Automatic comparison against targets
- **Recommendations**: Actionable performance improvement suggestions

Reports are saved to `backend/test_reports/` after each test run.

**View HTML Report:**
```bash
# Find and open latest report
python -c "from pathlib import Path; import webbrowser; report = max(Path('test_reports').glob('*.html'), key=lambda p: p.stat().st_mtime); webbrowser.open(f'file://{report.absolute()}')"
```

See [tests/README_REPORTING.md](tests/README_REPORTING.md) for detailed documentation.

## License

MIT

