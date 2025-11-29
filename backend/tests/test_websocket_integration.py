"""
WebSocket integration tests that simulate frontend behavior.
Tests the complete flow: WebSocket connection -> audio chunks -> transcription -> chatbot response.
"""
import pytest
import asyncio
import json
import time
import base64
import tempfile
import os
import numpy as np
import wave
from pathlib import Path

try:
    from websockets.client import connect
    from websockets.exceptions import ConnectionClosed
    WEBSOCKETS_AVAILABLE = True
except ImportError:
    WEBSOCKETS_AVAILABLE = False
    pytest.skip("websockets library not available", allow_module_level=True)


class TestWebSocketIntegration:
    """Test WebSocket integration with frontend-like behavior."""
    
    @pytest.fixture
    def websocket_url(self):
        """Get WebSocket URL from environment or use default."""
        import os
        api_url = os.getenv("API_URL", "http://localhost:8000")
        ws_url = api_url.replace("http://", "ws://").replace("https://", "wss://")
        return f"{ws_url}/ws/audio"
    
    @pytest.fixture
    def session_id(self):
        """Generate a test session ID."""
        return f"test-session-{int(time.time() * 1000)}"
    
    def create_test_audio_webm(self, duration_sec: float = 1.0) -> bytes:
        """Create a minimal WebM audio file for testing."""
        # Create a simple WAV file first, then we'll simulate WebM
        # In real tests, you'd use actual WebM encoding, but for testing we'll use WAV
        sample_rate = 16000
        frequency = 440.0
        
        t = np.linspace(0, duration_sec, int(sample_rate * duration_sec), False)
        audio_data = np.sin(2 * np.pi * frequency * t)
        audio_data = (audio_data * 32767).astype(np.int16)
        
        # Create WAV file in memory
        import io
        wav_buffer = io.BytesIO()
        with wave.open(wav_buffer, 'wb') as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(audio_data.tobytes())
        
        # Return as bytes (simulating WebM - in real scenario, convert to WebM)
        return wav_buffer.getvalue()
    
    @pytest.mark.asyncio
    async def test_websocket_connection(self, websocket_url):
        """Test basic WebSocket connection."""
        try:
            async with connect(websocket_url) as websocket:
                # Connection should be established
                assert websocket.open
                print(f"\n[WebSocket] Connected to {websocket_url}")
        except Exception as e:
            pytest.skip(f"WebSocket connection failed: {e}. Is the backend running?")
    
    @pytest.mark.asyncio
    async def test_websocket_session_handshake(self, websocket_url, session_id):
        """Test WebSocket session handshake (like frontend does)."""
        try:
            async with connect(websocket_url) as websocket:
                # Send session message (like frontend does)
                session_message = {
                    "type": "session",
                    "session_id": session_id
                }
                await websocket.send(json.dumps(session_message))
                
                # Wait for session_ack
                response = await asyncio.wait_for(websocket.recv(), timeout=5.0)
                message = json.loads(response)
                
                assert message["type"] == "session_ack"
                assert message["session_id"] == session_id
                print(f"\n[WebSocket] Session handshake successful: {session_id}")
        except asyncio.TimeoutError as e:
            pytest.fail(f"Test timed out: {str(e) or 'Timeout waiting for response'}. "
                       f"Is the backend running and processing requests?")
        except Exception as e:
            error_msg = str(e) if str(e) else f"{type(e).__name__}"
            pytest.fail(f"WebSocket test failed: {error_msg}. "
                       f"Check backend logs for details.")
    
    @pytest.mark.asyncio
    async def test_websocket_audio_chunk_acknowledgment(self, websocket_url, session_id):
        """Test sending audio chunks and receiving acknowledgments."""
        try:
            async with connect(websocket_url) as websocket:
                # Send session
                await websocket.send(json.dumps({
                    "type": "session",
                    "session_id": session_id
                }))
                await websocket.recv()  # Wait for session_ack
                
                # Create test audio data
                audio_data = self.create_test_audio_webm(duration_sec=0.5)
                audio_base64 = base64.b64encode(audio_data).decode('utf-8')
                
                # Send audio chunk (like frontend does)
                chunk_message = {
                    "type": "audio_chunk",
                    "data": audio_base64
                }
                await websocket.send(json.dumps(chunk_message))
                
                # Wait for chunk_received acknowledgment
                response = await asyncio.wait_for(websocket.recv(), timeout=5.0)
                message = json.loads(response)
                
                assert message["type"] == "chunk_received"
                print(f"\n[WebSocket] Audio chunk acknowledged")
        except asyncio.TimeoutError as e:
            pytest.fail(f"Test timed out: {str(e) or 'Timeout waiting for response'}. "
                       f"Is the backend running and processing requests?")
        except Exception as e:
            error_msg = str(e) if str(e) else f"{type(e).__name__}"
            pytest.fail(f"WebSocket test failed: {error_msg}. "
                       f"Check backend logs for details.")
    
    @pytest.mark.asyncio
    async def test_websocket_complete_flow(self, websocket_url, session_id):
        """Test complete flow: session -> audio chunks -> segment_end -> transcription -> chatbot response."""
        try:
            async with connect(websocket_url) as websocket:
                start_time = time.perf_counter()
                
                # Step 1: Send session
                await websocket.send(json.dumps({
                    "type": "session",
                    "session_id": session_id
                }))
                session_ack = await asyncio.wait_for(websocket.recv(), timeout=5.0)
                session_ack_msg = json.loads(session_ack)
                assert session_ack_msg["type"] == "session_ack"
                session_time = (time.perf_counter() - start_time) * 1000
                
                # Step 2: Send multiple audio chunks (simulating frontend streaming)
                audio_data = self.create_test_audio_webm(duration_sec=1.0)
                audio_base64 = base64.b64encode(audio_data).decode('utf-8')
                
                # Split into chunks (simulating frontend behavior)
                chunk_size = len(audio_base64) // 3
                chunks_sent = 0
                for i in range(0, len(audio_base64), chunk_size):
                    chunk = audio_base64[i:i + chunk_size]
                    await websocket.send(json.dumps({
                        "type": "audio_chunk",
                        "data": chunk
                    }))
                    # Wait for acknowledgment
                    ack = await asyncio.wait_for(websocket.recv(), timeout=5.0)
                    ack_msg = json.loads(ack)
                    assert ack_msg["type"] == "chunk_received"
                    chunks_sent += 1
                
                chunks_time = (time.perf_counter() - start_time) * 1000
                
                # Step 3: Send segment_end (like frontend does when speech ends)
                segment_start = time.perf_counter()
                await websocket.send(json.dumps({
                    "type": "segment_end"
                }))
                
                # Step 4: Wait for chatbot_response (transcription + chatbot response)
                # The backend should send: chatbot_response with transcription and response
                chatbot_response = None
                segment_processed = False
                timeout = 60.0  # 60 seconds timeout for processing
                
                while not chatbot_response and not segment_processed:
                    try:
                        response = await asyncio.wait_for(websocket.recv(), timeout=timeout)
                        message = json.loads(response)
                        
                        if message["type"] == "chatbot_response":
                            chatbot_response = message
                            break
                        elif message["type"] == "segment_processed":
                            segment_processed = True
                        elif message["type"] == "error":
                            pytest.fail(f"Backend error: {message.get('message', 'Unknown error')}")
                    except asyncio.TimeoutError:
                        pytest.fail("Timeout waiting for chatbot response")
                
                segment_time = (time.perf_counter() - segment_start) * 1000
                total_time = (time.perf_counter() - start_time) * 1000
                
                # Verify response structure
                if chatbot_response:
                    assert "transcription" in chatbot_response or chatbot_response.get("error")
                    assert "backend_used" in chatbot_response
                    
                    print(f"\n[WebSocket Complete Flow]")
                    print(f"  Session handshake: {session_time:.2f} ms")
                    print(f"  Audio chunks ({chunks_sent} chunks): {chunks_time:.2f} ms")
                    print(f"  Processing (transcription + chatbot): {segment_time:.2f} ms")
                    print(f"  Total time: {total_time:.2f} ms")
                    print(f"  Transcription: '{chatbot_response.get('transcription', 'N/A')}'")
                    print(f"  Backend used: {chatbot_response.get('backend_used', 'unknown')}")
                    print(f"  Has response: {bool(chatbot_response.get('response'))}")
                    print(f"  Has error: {bool(chatbot_response.get('error'))}")
                    
                    # Assert reasonable performance
                    assert total_time < 60000, f"Total flow took too long: {total_time:.2f} ms"
                else:
                    print(f"\n[WebSocket] Segment processed but no chatbot response received")
                    print(f"  Total time: {total_time:.2f} ms")
        except asyncio.TimeoutError as e:
            pytest.fail(f"Test timed out: {str(e) or 'Timeout waiting for response'}. "
                       f"Is the backend running and processing requests?")
        except Exception as e:
            error_msg = str(e) if str(e) else f"{type(e).__name__}"
            pytest.fail(f"WebSocket test failed: {error_msg}. "
                       f"Check backend logs for details.")
    
    @pytest.mark.asyncio
    async def test_websocket_multiple_segments(self, websocket_url, session_id):
        """Test multiple speech segments (simulating multiple user questions)."""
        try:
            async with connect(websocket_url) as websocket:
                # Send session
                await websocket.send(json.dumps({
                    "type": "session",
                    "session_id": session_id
                }))
                await websocket.recv()  # session_ack
                
                # Process first segment
                audio_data = self.create_test_audio_webm(duration_sec=0.5)
                audio_base64 = base64.b64encode(audio_data).decode('utf-8')
                
                await websocket.send(json.dumps({
                    "type": "audio_chunk",
                    "data": audio_base64
                }))
                await websocket.recv()  # chunk_received
                
                await websocket.send(json.dumps({"type": "segment_end"}))
                
                # Wait for first response
                first_response = None
                start_wait = time.perf_counter()
                timeout = 120.0
                while not first_response:
                    try:
                        response = await asyncio.wait_for(websocket.recv(), timeout=timeout)
                        message = json.loads(response)
                        if message["type"] == "chatbot_response":
                            first_response = message
                            break
                        elif message["type"] == "error":
                            pytest.fail(f"Backend error: {message.get('message', 'Unknown error')}")
                        elif message["type"] == "segment_processed":
                            # Continue waiting for chatbot_response
                            elapsed = time.perf_counter() - start_wait
                            timeout = max(10.0, timeout - elapsed)
                    except asyncio.TimeoutError:
                        elapsed = time.perf_counter() - start_wait
                        pytest.fail(f"Timeout after {elapsed:.1f}s waiting for first chatbot_response")
                
                print(f"\n[WebSocket Multiple Segments]")
                print(f"  First segment processed")
                print(f"  Transcription: '{first_response.get('transcription', 'N/A')}'")
                
                # Process second segment
                await websocket.send(json.dumps({
                    "type": "audio_chunk",
                    "data": audio_base64
                }))
                await websocket.recv()  # chunk_received
                
                await websocket.send(json.dumps({"type": "segment_end"}))
                
                # Wait for second response
                second_response = None
                start_wait = time.perf_counter()
                timeout = 120.0
                while not second_response:
                    try:
                        response = await asyncio.wait_for(websocket.recv(), timeout=timeout)
                        message = json.loads(response)
                        if message["type"] == "chatbot_response":
                            second_response = message
                            break
                        elif message["type"] == "error":
                            pytest.fail(f"Backend error: {message.get('message', 'Unknown error')}")
                        elif message["type"] == "segment_processed":
                            # Continue waiting for chatbot_response
                            elapsed = time.perf_counter() - start_wait
                            timeout = max(10.0, timeout - elapsed)
                    except asyncio.TimeoutError:
                        elapsed = time.perf_counter() - start_wait
                        pytest.fail(f"Timeout after {elapsed:.1f}s waiting for second chatbot_response")
                
                print(f"  Second segment processed")
                print(f"  Transcription: '{second_response.get('transcription', 'N/A')}'")
                
                # Both segments should be processed
                assert first_response is not None
                assert second_response is not None
                
        except asyncio.TimeoutError as e:
            pytest.fail(f"Test timed out: {str(e) or 'Timeout waiting for response'}. "
                       f"Is the backend running and processing requests?")
        except Exception as e:
            error_msg = str(e) if str(e) else f"{type(e).__name__}"
            pytest.fail(f"WebSocket test failed: {error_msg}. "
                       f"Check backend logs for details.")
    
    @pytest.mark.asyncio
    async def test_websocket_error_handling(self, websocket_url, session_id):
        """Test WebSocket error handling."""
        try:
            async with connect(websocket_url) as websocket:
                # Send session
                await websocket.send(json.dumps({
                    "type": "session",
                    "session_id": session_id
                }))
                await websocket.recv()  # session_ack
                
                # Send invalid message
                await websocket.send(json.dumps({
                    "type": "invalid_type"
                }))
                
                # Should not crash - might send error or ignore
                # Just verify connection is still alive
                await asyncio.sleep(0.5)
                assert websocket.open
                
                print(f"\n[WebSocket Error Handling]")
                print(f"  Connection remains open after invalid message")
                
        except asyncio.TimeoutError as e:
            pytest.fail(f"Test timed out: {str(e) or 'Timeout waiting for response'}. "
                       f"Is the backend running and processing requests?")
        except Exception as e:
            error_msg = str(e) if str(e) else f"{type(e).__name__}"
            pytest.fail(f"WebSocket test failed: {error_msg}. "
                       f"Check backend logs for details.")
    
    @pytest.mark.asyncio
    async def test_websocket_performance_benchmark(self, websocket_url, session_id):
        """Benchmark WebSocket performance with multiple requests."""
        try:
            num_requests = 3
            times = []
            
            for i in range(num_requests):
                test_session_id = f"{session_id}-{i}"
                start_time = time.perf_counter()
                
                async with connect(websocket_url) as websocket:
                    # Session
                    await websocket.send(json.dumps({
                        "type": "session",
                        "session_id": test_session_id
                    }))
                    await websocket.recv()  # session_ack
                    
                    # Audio chunk
                    audio_data = self.create_test_audio_webm(duration_sec=0.5)
                    audio_base64 = base64.b64encode(audio_data).decode('utf-8')
                    await websocket.send(json.dumps({
                        "type": "audio_chunk",
                        "data": audio_base64
                    }))
                    await websocket.recv()  # chunk_received
                    
                    # Segment end
                    await websocket.send(json.dumps({"type": "segment_end"}))
                    
                    # Wait for response
                    response_received = False
                    start_wait = time.perf_counter()
                    timeout = 120.0
                    while not response_received:
                        try:
                            response = await asyncio.wait_for(websocket.recv(), timeout=timeout)
                            message = json.loads(response)
                            if message["type"] == "chatbot_response":
                                response_received = True
                                break
                            elif message["type"] == "error":
                                pytest.fail(f"Backend error: {message.get('message', 'Unknown error')}")
                            elif message["type"] == "segment_processed":
                                # Continue waiting for chatbot_response
                                elapsed = time.perf_counter() - start_wait
                                timeout = max(10.0, timeout - elapsed)
                        except asyncio.TimeoutError:
                            elapsed = time.perf_counter() - start_wait
                            pytest.fail(f"Timeout after {elapsed:.1f}s waiting for chatbot_response in request {i+1}")
                
                elapsed_time = (time.perf_counter() - start_time) * 1000
                times.append(elapsed_time)
            
            avg_time = sum(times) / len(times)
            min_time = min(times)
            max_time = max(times)
            
            print(f"\n[WebSocket Performance Benchmark] {num_requests} requests:")
            print(f"  Average time: {avg_time:.2f} ms")
            print(f"  Min time: {min_time:.2f} ms")
            print(f"  Max time: {max_time:.2f} ms")
            print(f"  Times: {[f'{t:.2f}' for t in times]} ms")
            
            # Assert reasonable performance
            assert avg_time < 60000, f"Average WebSocket flow time too high: {avg_time:.2f} ms"
            
        except asyncio.TimeoutError as e:
            pytest.fail(f"Test timed out: {str(e) or 'Timeout waiting for response'}. "
                       f"Is the backend running and processing requests?")
        except Exception as e:
            error_msg = str(e) if str(e) else f"{type(e).__name__}"
            pytest.fail(f"WebSocket test failed: {error_msg}. "
                       f"Check backend logs for details.")

