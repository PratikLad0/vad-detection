# VAD-based WebRTC Recorder

A production-ready **WebRTC + VAD-based audio recorder** with a **React (Vite) frontend** and a **Python FastAPI backend**. Features wake-word detection ("Hey AI" or "start"), real-time speech transcription, and automatic recording with voice activity detection.

## Features

- 🎤 **Wake Word Detection**: Trigger recording with "Hey AI" or "start"
- 🗣️ **Voice Activity Detection (VAD)**: Automatic recording when speech is detected
- 📝 **Real-time Transcription**: Live speech-to-text during recording
- 💾 **Text File Export**: Optional saving of transcriptions as .txt files
- 🔄 **Retry Logic**: Automatic retry for failed network requests
- 🛡️ **Error Handling**: Comprehensive error boundaries and recovery
- 🎨 **Modern UI**: Full-screen dark/gold theme with Tailwind CSS
- 📊 **Event Logging**: Detailed event logs with toggle visibility
- 🔒 **Production Ready**: Security, validation, and optimization

## Project Structure

```
VadBasedRecorder/
├── frontend/          # React + Vite + TypeScript frontend
│   ├── src/
│   │   ├── components/   # React components
│   │   ├── utils/        # Utilities (logger, API client)
│   │   └── config.ts     # Configuration
│   ├── .env.example     # Environment variables template
│   └── package.json
├── backend/           # FastAPI backend
│   ├── main.py        # API endpoints
│   ├── recordings/    # Saved audio files
│   └── requirements.txt
└── README.md
```

## Prerequisites

- **Node.js** 18+ and npm
- **Python** 3.9+
- **Modern browser** with WebRTC support (Chrome, Firefox, Edge, Safari)

## Quick Start

### 1. Backend Setup

```bash
cd backend
python -m venv .venv

# Windows PowerShell:
.venv\Scripts\Activate.ps1
# Windows CMD:
.venv\Scripts\activate.bat
# Linux/Mac:
source .venv/bin/activate

pip install -r requirements.txt
```

### 2. Frontend Setup

```bash
cd frontend
npm install
```

### 3. Environment Configuration

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` and set your API URL:

```env
VITE_API_URL=http://localhost:8000
VITE_APP_NAME=VAD WebRTC Recorder
VITE_ENVIRONMENT=development
```

### 4. Run Development Servers

**Terminal 1 - Backend:**
```bash
cd backend
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

**Terminal 2 - Frontend:**
```bash
cd frontend
npm run dev
```

Open http://localhost:5173 in your browser.

## Usage Instructions

### First Time Setup

1. **Grant Microphone Permission**: When you first open the app, your browser will ask for microphone permission. Click "Allow" to enable recording.

2. **Start Listening**: Click the "🎤 Start listening" button to begin wake word detection.

3. **Trigger Recording**: Say **"Hey AI"** or **"start"** to trigger a recording session.

### Recording Workflow

1. **Wake Word Detection**: The system listens for "Hey AI" or "start"
   - Status shows: "Listening for wake word..."
   - Energy level indicator shows current audio input

2. **VAD Activation**: After wake word is detected:
   - Status changes to: "VAD active - waiting for speech..."
   - System monitors for speech, noise, or silence

3. **Recording**: When speech is detected:
   - Status: "Recording..."
   - Real-time transcription appears in the transcription box
   - Recording continues until speech ends

4. **Upload**: Recording automatically uploads to the backend
   - Status: "Uploading recording to backend..."
   - File saved to `backend/recordings/` directory

5. **Text File Saving** (Optional):
   - Toggle "Save Text File" switch in the controls panel
   - When enabled, transcriptions are saved as `.txt` files alongside audio recordings
   - Files are saved with format: `transcription-YYYY-MM-DDTHH-MM-SS.txt`

### Controls

- **Save Text File Toggle**: Enable/disable automatic text file saving for transcriptions
- **Show Logs Toggle**: Show/hide detailed event logs
- **Status Display**: Real-time system status and energy levels
- **Event Logs**: Detailed log of all system events (wake word, VAD, uploads)

### Understanding the Status Indicators

- **🟢 Green Dot**: System is listening or recording
- **🔴 Red Pulsing Dot**: Currently recording
- **⚫ Gray Dot**: System idle or error state
- **Energy Level**: Shows current audio input level (0-100%)
- **VAD Status**: Shows current classification (Silence/Noise/Speech)
- **Wake Status**: Shows wake word detection state

### Tips

- **Clear Speech**: Speak clearly for better transcription accuracy
- **Quiet Environment**: Reduces false noise detection
- **Browser Compatibility**: Use Chrome or Edge for best speech recognition support
- **HTTPS Required**: In production, HTTPS is required for microphone access
- **File Management**: Recordings are saved in `backend/recordings/` - manage disk space accordingly

## Production Deployment

### Frontend Build

```bash
cd frontend
npm run build
```

The production build will be in `frontend/dist/`. Serve it with a static file server (nginx, Apache, etc.).

### Backend Deployment

Set environment variables:

```bash
export API_URL=https://your-api-domain.com
export ALLOWED_ORIGINS=https://your-frontend-domain.com
export MAX_FILE_SIZE_MB=50
export RECORDINGS_DIR=/path/to/recordings
```

Run with production server:

```bash
uvicorn backend.main:app --host 0.0.0.0 --port 8000 --workers 4
```

Or use a process manager like PM2 or systemd.

### Docker Deployment (Optional)

Create `docker-compose.yml`:

```yaml
version: '3.8'
services:
  backend:
    build: ./backend
    ports:
      - "8000:8000"
    environment:
      - ALLOWED_ORIGINS=https://your-frontend.com
    volumes:
      - ./backend/recordings:/app/recordings

  frontend:
    build: ./frontend
    ports:
      - "80:80"
    environment:
      - VITE_API_URL=http://backend:8000
```

## API Endpoints

### `GET /health`
Health check endpoint. Returns:
```json
{
  "status": "ok",
  "version": "1.0.0",
  "recordings_count": 5
}
```

### `POST /upload`
Upload audio or text file. Accepts:
- Audio files: `.webm`, `.opus`, `.ogg`, `.wav`, `.m4a`
- Text files: `.txt` (for transcriptions)

Returns:
```json
{
  "status": "ok",
  "filename": "recording-20241129-120000-123456.webm",
  "size": 12345,
  "path": "recordings/recording-20241129-120000-123456.webm"
}
```

### `GET /recordings?limit=10`
List recent recordings.

## Configuration

### Frontend Environment Variables

- `VITE_API_URL`: Backend API URL (default: `http://localhost:8000`)
- `VITE_APP_NAME`: Application name
- `VITE_ENVIRONMENT`: `development` or `production`

### Backend Environment Variables

- `API_URL`: API base URL
- `ALLOWED_ORIGINS`: Comma-separated list of allowed CORS origins
- `MAX_FILE_SIZE_MB`: Maximum file size in MB (default: 50)
- `RECORDINGS_DIR`: Directory to save recordings (default: `recordings`)

## Security Features

- ✅ Input validation (file type, size)
- ✅ CORS configuration
- ✅ Error handling and logging
- ✅ File size limits
- ✅ Trusted host middleware
- ✅ Secure headers

## Browser Compatibility

- ✅ Chrome/Edge 90+
- ✅ Firefox 88+
- ✅ Safari 14+
- ⚠️ Speech Recognition: Chrome/Edge only (WebKit Speech API)

## Troubleshooting

### Microphone Permission Denied
- Check browser settings
- Ensure HTTPS in production (required for microphone access)
- Check browser console for errors

### Upload Fails
- Verify backend is running
- Check CORS configuration
- Verify file size is within limits
- Check network connectivity

### Speech Recognition Not Working
- Use Chrome or Edge browser (Web Speech API support)
- Check microphone permissions
- Verify browser supports Web Speech API
- Check browser console for errors

### Text Files Not Saving
- Ensure "Save Text File" toggle is enabled
- Verify transcription was generated (check transcription box)
- Check backend logs for upload errors
- Ensure backend has write permissions to recordings directory

## Development

### Code Quality

```bash
# Frontend linting
cd frontend
npm run lint

# Type checking
npm run type-check  # if configured
```

### Project Structure

- **Error Boundaries**: `frontend/src/components/ErrorBoundary.tsx`
- **API Client**: `frontend/src/utils/api.ts` (with retry logic)
- **Logger**: `frontend/src/utils/logger.ts`
- **Configuration**: `frontend/src/config.ts`

## License

MIT

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## Support

For issues and questions, please open an issue on GitHub.
