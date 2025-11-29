## VAD-based WebRTC Recorder (React + Python)

This project is a minimal end-to-end example of a **WebRTC + VAD-based audio recorder** with a **React (Vite) frontend** and a **Python FastAPI backend**.

- **Frontend**: WebRTC microphone capture + simple energy-based VAD in the browser.
- **Behavior**: Start only when speech is detected, stop automatically when speech ends.
- **Backend**: Python FastAPI service that accepts the recorded audio and saves it to disk.

---

### Project Structure

- `frontend/` – Vite + React + TypeScript single-page app
- `backend/` – FastAPI app with an `/upload` endpoint
- `backend/requirements.txt` – Python dependencies for the backend

---

### Running the Frontend (React + Vite)

From the `frontend` directory:

```bash
cd frontend
npm install        # already run once, safe to run again
npm run dev        # frontend dev server on http://localhost:5173
```

---

### Running the Backend (FastAPI)

Create and activate a virtual environment (recommended) and install dependencies:

```bash
cd backend
python -m venv .venv
# Windows PowerShell:
.venv\Scripts\Activate.ps1

pip install -r requirements.txt
```

Start the backend server:

```bash
uvicorn main:app --reload --port 8000
```

The backend exposes:

- `GET /health` – health check
- `POST /upload` – accepts an audio file and stores it in `backend/recordings/`

---

### How the Recorder Works

1. Frontend asks for microphone access via WebRTC (`getUserMedia`).
2. A Web Audio `ScriptProcessorNode` computes the RMS energy of the input signal.
3. When RMS exceeds a threshold, **recording starts** (MediaRecorder).
4. When RMS stays below the threshold for a short time window, **recording stops**.
5. The resulting audio blob is posted to `POST http://localhost:8000/upload`.

You can tune the **VAD threshold** and **silence duration** inside `frontend/src/App.tsx`.


