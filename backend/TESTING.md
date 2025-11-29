# Backend Performance Testing Guide

## Overview

This document describes the unit tests created to measure backend service response times. The tests help determine how long each component takes to process requests and generate responses.

## Test Structure

### Test Files

1. **`tests/test_transcription_performance.py`**
   - Measures Whisper transcription response times
   - Tests different audio durations (1s, 3s, 5s)
   - Includes benchmark tests with multiple runs

2. **`tests/test_chatbot_performance.py`**
   - Measures chatbot response generation times
   - Tests different message lengths (short, medium, long)
   - Tests guardrails filtering performance
   - Compares different backends (llama, OpenAI, Hugging Face)

3. **`tests/test_end_to_end_performance.py`**
   - Measures complete pipeline performance
   - Tests: Audio → Transcription → Chatbot Response
   - Includes optional speaker diarization timing
   - End-to-end benchmarks

4. **`tests/test_performance_summary.py`**
   - Generates performance summary reports
   - Shows available backends and their status

## Installation

Install test dependencies:

```bash
pip install -r requirements.txt
```

This will install:
- `pytest` - Testing framework
- `pytest-asyncio` - Async test support
- `pytest-timeout` - Test timeout handling

## Running Tests

### Run All Tests

```bash
# From backend directory
pytest tests/ -v
```

### Run Specific Test File

```bash
# Transcription performance
pytest tests/test_transcription_performance.py -v

# Chatbot performance
pytest tests/test_chatbot_performance.py -v

# End-to-end performance
pytest tests/test_end_to_end_performance.py -v
```

### Run with Detailed Output

```bash
pytest tests/ -v -s
```

The `-s` flag shows print statements (performance metrics).

### Run Performance Summary

```bash
pytest tests/test_performance_summary.py -v
```

## Performance Targets

The tests assert the following performance targets:

| Component | Duration | Target |
|-----------|----------|--------|
| Transcription (1s audio) | < 5000 ms | ✓ |
| Transcription (3s audio) | < 10000 ms | ✓ |
| Transcription (5s audio) | < 15000 ms | ✓ |
| Chatbot response (short) | < 30000 ms | ✓ |
| Chatbot response (medium) | < 30000 ms | ✓ |
| Chatbot response (long) | < 30000 ms | ✓ |
| Guardrails check | < 100 ms | ✓ |
| End-to-end (1s audio) | < 35000 ms | ✓ |
| End-to-end (with diarization) | < 40000 ms | ✓ |

## Test Output

Each test prints detailed performance metrics:

```
[Transcription Performance] Short audio (1s):
  Model: tiny
  Response time: 1234.56 ms
  Transcription: '...'

[Chatbot Performance] Short message:
  Input: 'Hello'
  Response time: 2345.67 ms
  Backend used: llama
  Has response: True
  Response preview: 'Hello! How can I help you today?...'

[End-to-End Performance] Short audio (1s):
  Transcription time: 1234.56 ms
  Chatbot time: 2345.67 ms
  Total time: 3580.23 ms
  Backend used: llama
```

## Benchmark Tests

Benchmark tests run multiple iterations and report:
- Average time
- Minimum time
- Maximum time
- All individual run times

Example output:
```
[Transcription Benchmark] 3 runs:
  Model: tiny
  Average time: 1234.56 ms
  Min time: 1200.00 ms
  Max time: 1300.00 ms
  Times: ['1200.00', '1234.56', '1300.00'] ms
```

## Test Fixtures

The tests use pytest fixtures for setup:

- **`whisper_model`** (session-scoped): Loads Whisper model once for all tests
- **`chatbot_backends`** (session-scoped): Initializes chatbot backends once
- **`temp_audio_file`**: Creates temporary audio files for testing
- **`sample_transcription_text`**: Sample text for testing
- **`sample_user_message`**: Sample user message for chatbot testing

## Notes

1. **Model Loading**: Models are loaded once per test session (not per test) for efficiency
2. **Audio Generation**: Test audio files are generated on-the-fly and cleaned up automatically
3. **Skipping Tests**: Tests skip if required models/backends are not available
4. **Hardware Dependent**: Performance targets may vary based on:
   - CPU/GPU performance
   - Model size (tiny vs base vs large)
   - System load
   - Available memory

## Troubleshooting

### Tests Skip with "Model not available"

- Ensure Whisper model is configured in `.env`
- Ensure chatbot backends are properly configured
- Check that model files exist at specified paths

### Tests Fail with Import Errors

- Ensure you're running from the `backend` directory
- Check that all dependencies are installed: `pip install -r requirements.txt`
- Verify Python path includes the backend directory

### Performance Targets Not Met

- Check system resources (CPU, memory)
- Consider using smaller models (tiny instead of base)
- Reduce test audio duration
- Adjust performance targets in test files if needed

## Continuous Integration

These tests can be integrated into CI/CD pipelines:

```yaml
# Example GitHub Actions
- name: Run performance tests
  run: |
    cd backend
    pytest tests/ -v --tb=short
```

## Next Steps

- Add WebSocket integration tests
- Add load testing for concurrent requests
- Add memory profiling tests
- Create performance regression detection
- Generate performance reports in JSON/HTML format

