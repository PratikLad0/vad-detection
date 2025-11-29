# WebSocket Integration Tests

## Overview

These tests simulate the frontend's behavior and test the complete WebSocket integration flow.

## Test Files

### `test_websocket_integration.py`
Tests the WebSocket protocol and message flow:
- Connection establishment
- Session handshake
- Audio chunk streaming
- Complete flow (audio → transcription → chatbot)
- Multiple segments
- Error handling
- Performance benchmarking

### `test_frontend_simulation.py`
Simulates exact frontend behavior:
- Initial connection flow
- Audio streaming (MediaRecorder-like)
- Speech segment completion (VAD-like)
- Conversation flow (multiple questions)
- Error recovery

## Running Tests

### Prerequisites

1. **Start the backend server**:
   ```bash
   cd backend
   uvicorn main:app --host 0.0.0.0 --port 8000
   ```

2. **Run WebSocket tests**:
   ```bash
   # All WebSocket tests
   pytest tests/test_websocket_integration.py -v -s
   pytest tests/test_frontend_simulation.py -v -s
   
   # Specific test
   pytest tests/test_websocket_integration.py::TestWebSocketIntegration::test_websocket_complete_flow -v -s
   
   # With custom API URL
   API_URL=http://localhost:8000 pytest tests/test_websocket_integration.py -v -s
   ```

## Test Flow

### Complete Flow Test

1. **Connect** to WebSocket endpoint
2. **Send session** message with session ID
3. **Receive session_ack** from backend
4. **Send audio chunks** (base64 encoded)
5. **Receive chunk_received** acknowledgments
6. **Send segment_end** when speech ends
7. **Receive chatbot_response** with:
   - `transcription`: User's speech transcribed
   - `response`: Chatbot's response
   - `backend_used`: Which backend was used
   - `error`: Any error message (if applicable)

### Frontend Simulation

The tests simulate exactly how the frontend behaves:

```python
# 1. Frontend connects
websocket = connect("ws://localhost:8000/ws/audio")

# 2. Frontend sends session immediately
websocket.send({
    "type": "session",
    "session_id": "session-1234567890-abc123"
})

# 3. Frontend receives session_ack
response = websocket.recv()  # {"type": "session_ack", "session_id": "..."}

# 4. Frontend streams audio chunks (from MediaRecorder)
for chunk in audio_chunks:
    websocket.send({
        "type": "audio_chunk",
        "data": base64_encoded_chunk
    })
    ack = websocket.recv()  # {"type": "chunk_received"}

# 5. Frontend detects silence (VAD) and sends segment_end
websocket.send({"type": "segment_end"})

# 6. Frontend waits for chatbot_response
response = websocket.recv()  # {
#   "type": "chatbot_response",
#   "transcription": "Hello",
#   "response": "Hello! How can I help you?",
#   "backend_used": "llama"
# }
```

## Expected Behavior

### Message Types

| Type | Direction | Description |
|------|-----------|------------|
| `session` | Frontend → Backend | Establish session |
| `session_ack` | Backend → Frontend | Session confirmed |
| `audio_chunk` | Frontend → Backend | Audio data (base64) |
| `chunk_received` | Backend → Frontend | Chunk acknowledged |
| `segment_end` | Frontend → Backend | Speech segment ended |
| `chatbot_response` | Backend → Frontend | Transcription + chatbot response |
| `segment_processed` | Backend → Frontend | Segment processing complete |
| `error` | Backend → Frontend | Error occurred |

### Performance Targets

| Test | Target |
|------|--------|
| Session handshake | < 100 ms |
| Audio chunk acknowledgment | < 50 ms |
| Complete flow (1s audio) | < 60 seconds |
| Multiple segments | < 60 seconds each |

## Troubleshooting

### Tests Skip with "Is the backend running?"

- Ensure backend is running: `uvicorn main:app --host 0.0.0.0 --port 8000`
- Check API_URL environment variable matches your backend URL
- Verify WebSocket endpoint is accessible

### Timeout Errors

- Increase timeout in test (default: 60 seconds)
- Check backend logs for errors
- Verify models are loaded (Whisper, chatbot backends)

### Connection Errors

- Check CORS settings in backend
- Verify WebSocket endpoint: `/ws/audio`
- Check firewall/network settings

## Integration with CI/CD

```yaml
# Example GitHub Actions
- name: Start backend
  run: |
    cd backend
    uvicorn main:app --host 0.0.0.0 --port 8000 &
    sleep 10  # Wait for startup
    
- name: Run WebSocket tests
  run: |
    cd backend
    pytest tests/test_websocket_integration.py -v
    pytest tests/test_frontend_simulation.py -v
```

## Notes

- Tests require a running backend instance
- Tests use real WebSocket connections (not mocked)
- Audio data is simulated (not real WebM files)
- Performance may vary based on hardware and model size
- Tests are marked with `@pytest.mark.asyncio` for async support

