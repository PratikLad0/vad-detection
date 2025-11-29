"""
Unit tests for measuring Whisper transcription performance.
"""
import time
import pytest
import tempfile
import os
from pathlib import Path
import numpy as np
import wave

from main import get_whisper_model, WHISPER_MODEL_NAME


class TestTranscriptionPerformance:
    """Test transcription response times."""
    
    @pytest.fixture(autouse=True)
    def setup(self, whisper_model):
        """Setup test fixtures."""
        self.model = whisper_model
    
    def create_test_audio(self, duration_sec: float = 2.0, sample_rate: int = 16000) -> str:
        """Create a test audio file with specified duration."""
        # Generate a simple sine wave
        frequency = 440.0  # A4 note
        t = np.linspace(0, duration_sec, int(sample_rate * duration_sec), False)
        audio_data = np.sin(2 * np.pi * frequency * t)
        # Normalize to 16-bit range
        audio_data = (audio_data * 32767).astype(np.int16)
        
        # Create temporary WAV file
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp_file:
            with wave.open(tmp_file.name, 'wb') as wav_file:
                wav_file.setnchannels(1)  # Mono
                wav_file.setsampwidth(2)  # 16-bit
                wav_file.setframerate(sample_rate)
                wav_file.writeframes(audio_data.tobytes())
            
            return tmp_file.name
    
    def cleanup_audio_file(self, filepath: str):
        """Clean up temporary audio file."""
        if os.path.exists(filepath):
            os.unlink(filepath)
    
    def test_transcription_short_audio(self):
        """Test transcription time for short audio (1 second)."""
        audio_file = self.create_test_audio(duration_sec=1.0)
        
        try:
            start_time = time.perf_counter()
            
            result = self.model.transcribe(
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
            
            end_time = time.perf_counter()
            elapsed_time = (end_time - start_time) * 1000  # Convert to milliseconds
            
            transcription = result["text"].strip()
            
            print(f"\n[Transcription Performance] Short audio (1s):")
            print(f"  Model: {WHISPER_MODEL_NAME}")
            print(f"  Response time: {elapsed_time:.2f} ms")
            print(f"  Transcription: '{transcription}'")
            
            # Assert reasonable performance (should be under 5 seconds for tiny model)
            assert elapsed_time < 5000, f"Transcription took too long: {elapsed_time:.2f} ms"
            
        finally:
            self.cleanup_audio_file(audio_file)
    
    def test_transcription_medium_audio(self):
        """Test transcription time for medium audio (3 seconds)."""
        audio_file = self.create_test_audio(duration_sec=3.0)
        
        try:
            start_time = time.perf_counter()
            
            result = self.model.transcribe(
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
            
            end_time = time.perf_counter()
            elapsed_time = (end_time - start_time) * 1000  # Convert to milliseconds
            
            transcription = result["text"].strip()
            
            print(f"\n[Transcription Performance] Medium audio (3s):")
            print(f"  Model: {WHISPER_MODEL_NAME}")
            print(f"  Response time: {elapsed_time:.2f} ms")
            print(f"  Transcription: '{transcription}'")
            
            # Assert reasonable performance
            assert elapsed_time < 10000, f"Transcription took too long: {elapsed_time:.2f} ms"
            
        finally:
            self.cleanup_audio_file(audio_file)
    
    def test_transcription_long_audio(self):
        """Test transcription time for long audio (5 seconds)."""
        audio_file = self.create_test_audio(duration_sec=5.0)
        
        try:
            start_time = time.perf_counter()
            
            result = self.model.transcribe(
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
            
            end_time = time.perf_counter()
            elapsed_time = (end_time - start_time) * 1000  # Convert to milliseconds
            
            transcription = result["text"].strip()
            
            print(f"\n[Transcription Performance] Long audio (5s):")
            print(f"  Model: {WHISPER_MODEL_NAME}")
            print(f"  Response time: {elapsed_time:.2f} ms")
            print(f"  Transcription: '{transcription}'")
            
            # Assert reasonable performance
            assert elapsed_time < 15000, f"Transcription took too long: {elapsed_time:.2f} ms"
            
        finally:
            self.cleanup_audio_file(audio_file)
    
    def test_transcription_benchmark_multiple_runs(self):
        """Benchmark transcription with multiple runs to get average time."""
        audio_file = self.create_test_audio(duration_sec=2.0)
        num_runs = 3
        times = []
        
        try:
            for i in range(num_runs):
                start_time = time.perf_counter()
                
                result = self.model.transcribe(
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
                
                end_time = time.perf_counter()
                elapsed_time = (end_time - start_time) * 1000
                times.append(elapsed_time)
            
            avg_time = sum(times) / len(times)
            min_time = min(times)
            max_time = max(times)
            
            print(f"\n[Transcription Benchmark] {num_runs} runs:")
            print(f"  Model: {WHISPER_MODEL_NAME}")
            print(f"  Average time: {avg_time:.2f} ms")
            print(f"  Min time: {min_time:.2f} ms")
            print(f"  Max time: {max_time:.2f} ms")
            print(f"  Times: {[f'{t:.2f}' for t in times]} ms")
            
            # Assert reasonable average performance
            assert avg_time < 5000, f"Average transcription time too high: {avg_time:.2f} ms"
            
        finally:
            self.cleanup_audio_file(audio_file)

