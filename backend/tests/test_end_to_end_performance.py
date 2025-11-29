"""
End-to-end performance tests for the complete audio processing pipeline.
"""
import time
import pytest
import tempfile
import os
import numpy as np
import wave
from pathlib import Path

from main import get_whisper_model
from chatbot_service import generate_chatbot_response
from speaker_diarization import diarize_audio


class TestEndToEndPerformance:
    """Test end-to-end response times for the complete pipeline."""
    
    @pytest.fixture(autouse=True)
    def setup(self, whisper_model, chatbot_backends):
        """Setup test fixtures."""
        self.whisper_model = whisper_model
        self.backend_status = chatbot_backends
    
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
    
    def test_end_to_end_pipeline_short(self):
        """Test complete pipeline: audio -> transcription -> chatbot response."""
        audio_file = self.create_test_audio(duration_sec=1.0)
        
        try:
            # Step 1: Transcription
            transcription_start = time.perf_counter()
            result = self.whisper_model.transcribe(
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
            transcription_end = time.perf_counter()
            transcription_time = (transcription_end - transcription_start) * 1000
            
            transcription = result["text"].strip()
            
            # Step 2: Chatbot response
            chatbot_start = time.perf_counter()
            chatbot_result = generate_chatbot_response(transcription)
            chatbot_end = time.perf_counter()
            chatbot_time = (chatbot_end - chatbot_start) * 1000
            
            # Total time
            total_time = transcription_time + chatbot_time
            
            print(f"\n[End-to-End Performance] Short audio (1s):")
            print(f"  Transcription time: {transcription_time:.2f} ms")
            print(f"  Chatbot time: {chatbot_time:.2f} ms")
            print(f"  Total time: {total_time:.2f} ms")
            print(f"  Backend used: {chatbot_result.get('backend_used', 'unknown')}")
            print(f"  Transcription: '{transcription}'")
            
            # Assert reasonable performance
            assert total_time < 35000, f"End-to-end pipeline took too long: {total_time:.2f} ms"
            
        finally:
            self.cleanup_audio_file(audio_file)
    
    def test_end_to_end_pipeline_with_diarization(self):
        """Test complete pipeline including speaker diarization."""
        audio_file = self.create_test_audio(duration_sec=2.0)
        
        try:
            # Step 1: Transcription
            transcription_start = time.perf_counter()
            result = self.whisper_model.transcribe(
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
            transcription_end = time.perf_counter()
            transcription_time = (transcription_end - transcription_start) * 1000
            
            transcription = result["text"].strip()
            
            # Step 2: Speaker diarization (non-critical, but measure it)
            diarization_start = time.perf_counter()
            try:
                diarization_results = diarize_audio(audio_file, num_speakers=None)
                diarization_end = time.perf_counter()
                diarization_time = (diarization_end - diarization_start) * 1000
                diarization_success = True
            except Exception as e:
                diarization_time = 0
                diarization_success = False
                print(f"  Diarization failed (non-critical): {e}")
            
            # Step 3: Chatbot response
            chatbot_start = time.perf_counter()
            chatbot_result = generate_chatbot_response(transcription)
            chatbot_end = time.perf_counter()
            chatbot_time = (chatbot_end - chatbot_start) * 1000
            
            # Total time
            total_time = transcription_time + diarization_time + chatbot_time
            
            print(f"\n[End-to-End Performance] With diarization (2s):")
            print(f"  Transcription time: {transcription_time:.2f} ms")
            print(f"  Diarization time: {diarization_time:.2f} ms ({'success' if diarization_success else 'failed'})")
            print(f"  Chatbot time: {chatbot_time:.2f} ms")
            print(f"  Total time: {total_time:.2f} ms")
            print(f"  Backend used: {chatbot_result.get('backend_used', 'unknown')}")
            
            # Assert reasonable performance (diarization is optional)
            assert total_time < 40000, f"End-to-end pipeline took too long: {total_time:.2f} ms"
            
        finally:
            self.cleanup_audio_file(audio_file)
    
    def test_end_to_end_benchmark(self):
        """Benchmark the complete end-to-end pipeline."""
        audio_file = self.create_test_audio(duration_sec=2.0)
        num_runs = 3
        times = []
        
        try:
            for i in range(num_runs):
                # Transcription
                transcription_start = time.perf_counter()
                result = self.whisper_model.transcribe(
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
                transcription = result["text"].strip()
                
                # Chatbot
                chatbot_result = generate_chatbot_response(transcription)
                end_time = time.perf_counter()
                
                total_time = (end_time - transcription_start) * 1000
                times.append(total_time)
            
            avg_time = sum(times) / len(times)
            min_time = min(times)
            max_time = max(times)
            
            print(f"\n[End-to-End Benchmark] {num_runs} runs:")
            print(f"  Average time: {avg_time:.2f} ms")
            print(f"  Min time: {min_time:.2f} ms")
            print(f"  Max time: {max_time:.2f} ms")
            print(f"  Times: {[f'{t:.2f}' for t in times]} ms")
            
            # Assert reasonable average performance
            assert avg_time < 35000, f"Average end-to-end time too high: {avg_time:.2f} ms"
            
        finally:
            self.cleanup_audio_file(audio_file)

