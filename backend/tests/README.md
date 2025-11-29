# Backend Performance Tests

This directory contains unit tests for measuring backend service response times.

## Test Structure

- `test_transcription_performance.py` - Tests Whisper transcription response times
- `test_chatbot_performance.py` - Tests chatbot response generation times
- `test_end_to_end_performance.py` - Tests complete pipeline (audio -> transcription -> chatbot)
- `test_performance_summary.py` - Generates performance summary reports

## Running Tests

### Run all performance tests:
```bash
pytest tests/ -v
```

### Run specific test file:
```bash
pytest tests/test_transcription_performance.py -v
pytest tests/test_chatbot_performance.py -v
pytest tests/test_end_to_end_performance.py -v
```

### Run with detailed output:
```bash
pytest tests/ -v -s
```

### Run only fast tests (exclude slow ones):
```bash
pytest tests/ -v -m "not slow"
```

## Performance Targets

- **Transcription (1s audio)**: < 5000 ms
- **Transcription (3s audio)**: < 10000 ms
- **Transcription (5s audio)**: < 15000 ms
- **Chatbot response (short)**: < 30000 ms
- **End-to-end (1s audio)**: < 35000 ms
- **End-to-end (with diarization)**: < 40000 ms

## Test Output

Each test prints detailed performance metrics including:
- Response time in milliseconds
- Model/backend used
- Input/output previews
- Benchmark statistics (min, max, average)

## Requirements

- pytest
- pytest-asyncio
- pytest-timeout
- All backend dependencies (Whisper, chatbot backends, etc.)

## Notes

- Tests use session-scoped fixtures to load models once for all tests
- Audio files are created on-the-fly and cleaned up automatically
- Tests skip if required models/backends are not available
- Performance targets may vary based on hardware and model size

