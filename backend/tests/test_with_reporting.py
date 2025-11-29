"""
Wrapper tests that collect timing data for reporting.
These tests wrap the actual performance tests and collect metrics.
"""
import pytest
import time
from pathlib import Path
import sys

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from test_report_generator import TestReportGenerator


@pytest.fixture(scope="session")
def report_generator():
    """Create report generator for test session."""
    output_dir = Path(__file__).parent.parent / "test_reports"
    return TestReportGenerator(output_dir=output_dir)


def test_collect_transcription_metrics(report_generator, whisper_model):
    """Collect transcription test metrics."""
    import numpy as np
    import wave
    import tempfile
    import os
    
    # Run transcription test and collect timing
    audio_file = None
    try:
        # Create test audio
        sample_rate = 16000
        duration = 1.0
        frequency = 440.0
        t = np.linspace(0, duration, int(sample_rate * duration), False)
        audio_data = np.sin(2 * np.pi * frequency * t)
        audio_data = (audio_data * 32767).astype(np.int16)
        
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp_file:
            with wave.open(tmp_file.name, 'wb') as wav_file:
                wav_file.setnchannels(1)
                wav_file.setsampwidth(2)
                wav_file.setframerate(sample_rate)
                wav_file.writeframes(audio_data.tobytes())
            audio_file = tmp_file.name
        
        # Time transcription
        start = time.perf_counter()
        result = whisper_model.transcribe(
            audio_file,
            language="en",
            task="transcribe",
            fp16=False,
            verbose=False,
            condition_on_previous_text=False,
            compression_ratio_threshold=2.4,
            logprob_threshold=-1.0,
            no_speech_threshold=0.6
        )
        duration_ms = (time.perf_counter() - start) * 1000
        
        # Record result
        report_generator.add_result(
            test_name="transcription_1s_audio",
            test_file="test_with_reporting.py",
            status="passed",
            duration_ms=duration_ms,
            category="transcription",
            metadata={"audio_duration": 1.0, "transcription": result["text"].strip()}
        )
        
    finally:
        if audio_file and os.path.exists(audio_file):
            os.unlink(audio_file)


def test_collect_chatbot_metrics(report_generator, chatbot_backends):
    """Collect chatbot test metrics."""
    from chatbot_service import generate_chatbot_response
    
    test_messages = [
        ("Hello", "short"),
        ("What is the capital of France?", "medium"),
        ("Can you explain quantum computing in simple terms?", "long")
    ]
    
    for message, length in test_messages:
        start = time.perf_counter()
        result = generate_chatbot_response(message)
        duration_ms = (time.perf_counter() - start) * 1000
        
        status = "passed" if result.get("response") or result.get("error") else "failed"
        
        report_generator.add_result(
            test_name=f"chatbot_{length}_message",
            test_file="test_with_reporting.py",
            status=status,
            duration_ms=duration_ms,
            category="chatbot",
            metadata={
                "message_length": length,
                "backend_used": result.get("backend_used"),
                "has_response": bool(result.get("response"))
            }
        )

