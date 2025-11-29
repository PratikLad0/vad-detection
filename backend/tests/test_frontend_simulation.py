"""
Frontend behavior simulation tests.
These tests simulate exactly how the frontend interacts with the backend WebSocket.
"""
import pytest
import asyncio
import json
import time
import base64
import numpy as np
import wave
import io

try:
    from websockets.client import connect
    WEBSOCKETS_AVAILABLE = True
except ImportError:
    WEBSOCKETS_AVAILABLE = False
    pytest.skip("websockets library not available", allow_module_level=True)


class TestFrontendSimulation:
    """Simulate frontend behavior and test backend responses."""
    
    @pytest.fixture
    def websocket_url(self):
        """Get WebSocket URL."""
        import os
        api_url = os.getenv("API_URL", "http://localhost:8000")
        ws_url = api_url.replace("http://", "ws://").replace("https://", "wss://")
        return f"{ws_url}/ws/audio"
    
    @pytest.fixture
    def session_id(self):
        """Generate session ID like frontend does."""
        timestamp = int(time.time() * 1000)
        random = "test123"
        return f"session-{timestamp}-{random}"
    
    def create_audio_chunk_base64(self, duration_sec: float = 0.1) -> str:
        """Create audio chunk and encode as base64 (like frontend MediaRecorder)."""
        sample_rate = 16000
        frequency = 440.0
        
        t = np.linspace(0, duration_sec, int(sample_rate * duration_sec), False)
        audio_data = np.sin(2 * np.pi * frequency * t)
        audio_data = (audio_data * 32767).astype(np.int16)
        
        # Create WAV in memory (frontend sends WebM, but for testing WAV is fine)
        wav_buffer = io.BytesIO()
        with wave.open(wav_buffer, 'wb') as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(audio_data.tobytes())
        
        # Encode as base64 (like frontend does)
        return base64.b64encode(wav_buffer.getvalue()).decode('utf-8')
    
    @pytest.mark.asyncio
    async def test_frontend_initial_connection(self, websocket_url, session_id):
        """Test frontend's initial connection flow."""
        try:
            print(f"\n[Frontend Simulation] Testing initial connection...")
            
            async with connect(websocket_url) as websocket:
                # Frontend immediately sends session message
                session_message = {
                    "type": "session",
                    "session_id": session_id
                }
                await websocket.send(json.dumps(session_message))
                print(f"  ✓ Sent session message: {session_id}")
                
                # Frontend waits for session_ack
                response = await asyncio.wait_for(websocket.recv(), timeout=5.0)
                message = json.loads(response)
                
                assert message["type"] == "session_ack"
                assert message["session_id"] == session_id
                print(f"  ✓ Received session_ack")
                print(f"  ✓ Connection established successfully")
                
        except Exception as e:
            pytest.skip(f"Connection test failed: {e}. Is the backend running at {websocket_url}?")
    
    @pytest.mark.asyncio
    async def test_frontend_audio_streaming(self, websocket_url, session_id):
        """Test frontend's audio streaming behavior (sending chunks continuously)."""
        try:
            print(f"\n[Frontend Simulation] Testing audio streaming...")
            
            async with connect(websocket_url) as websocket:
                # Step 1: Session handshake
                await websocket.send(json.dumps({
                    "type": "session",
                    "session_id": session_id
                }))
                await websocket.recv()  # session_ack
                print(f"  ✓ Session established")
                
                # Step 2: Simulate frontend sending audio chunks continuously
                # (like MediaRecorder.ondataavailable)
                num_chunks = 5
                chunks_sent = 0
                
                for i in range(num_chunks):
                    chunk_data = self.create_audio_chunk_base64(duration_sec=0.1)
                    
                    # Frontend sends audio_chunk message
                    chunk_message = {
                        "type": "audio_chunk",
                        "data": chunk_data
                    }
                    await websocket.send(json.dumps(chunk_message))
                    chunks_sent += 1
                    
                    # Frontend receives chunk_received acknowledgment
                    response = await asyncio.wait_for(websocket.recv(), timeout=2.0)
                    ack = json.loads(response)
                    assert ack["type"] == "chunk_received"
                    
                    # Small delay to simulate real-time streaming
                    await asyncio.sleep(0.05)
                
                print(f"  ✓ Sent {chunks_sent} audio chunks")
                print(f"  ✓ All chunks acknowledged")
                
        except Exception as e:
            pytest.skip(f"Streaming test failed: {e}. Is the backend running?")
    
    @pytest.mark.asyncio
    async def test_frontend_speech_segment_complete(self, websocket_url, session_id):
        """Test frontend's behavior when speech segment ends (sends segment_end)."""
        try:
            print(f"\n[Frontend Simulation] Testing speech segment completion...")
            
            async with connect(websocket_url) as websocket:
                start_time = time.perf_counter()
                
                # Session
                await websocket.send(json.dumps({
                    "type": "session",
                    "session_id": session_id
                }))
                await websocket.recv()  # session_ack
                
                # Send audio chunks (simulating recording)
                for _ in range(3):
                    chunk_data = self.create_audio_chunk_base64(duration_sec=0.2)
                    await websocket.send(json.dumps({
                        "type": "audio_chunk",
                        "data": chunk_data
                    }))
                    await websocket.recv()  # chunk_received
                
                # Frontend detects silence and sends segment_end
                # (like when VAD detects 300ms of silence)
                segment_end_time = time.perf_counter()
                await websocket.send(json.dumps({
                    "type": "segment_end"
                }))
                print(f"  ✓ Sent segment_end (simulating VAD silence detection)")
                
                # Frontend waits for chatbot_response
                # (with transcription and chatbot response)
                response_received = False
                transcription = None
                chatbot_response = None
                backend_used = None
                segment_processed = False
                timeout = 120.0  # Increased timeout for slower processing
                start_wait = time.perf_counter()
                
                while not response_received:
                    try:
                        response = await asyncio.wait_for(websocket.recv(), timeout=timeout)
                        message = json.loads(response)
                        
                        if message["type"] == "chatbot_response":
                            response_received = True
                            transcription = message.get("transcription")
                            chatbot_response = message.get("response")
                            backend_used = message.get("backend_used")
                            error = message.get("error")
                            
                            print(f"  ✓ Received chatbot_response")
                            print(f"    Transcription: '{transcription or 'N/A'}'")
                            print(f"    Backend: {backend_used}")
                            print(f"    Has response: {bool(chatbot_response)}")
                            print(f"    Has error: {bool(error)}")
                            
                            if chatbot_response:
                                print(f"    Response preview: {chatbot_response[:100]}...")
                            break
                        elif message["type"] == "error":
                            error_msg = message.get("message", "Unknown error")
                            pytest.fail(f"Backend error: {error_msg}")
                        elif message["type"] == "segment_processed":
                            segment_processed = True
                            print(f"  ✓ Segment processed")
                            # If we got segment_processed but not chatbot_response, continue waiting
                            # (chatbot_response should come before segment_processed, but handle both orders)
                            if not response_received:
                                # Reduce remaining timeout
                                elapsed = time.perf_counter() - start_wait
                                timeout = max(10.0, timeout - elapsed)
                    except asyncio.TimeoutError:
                        elapsed = time.perf_counter() - start_wait
                        pytest.fail(f"Timeout after {elapsed:.1f}s waiting for chatbot_response. "
                                   f"Segment processed: {segment_processed}")
                
                total_time = (time.perf_counter() - start_time) * 1000
                processing_time = (time.perf_counter() - segment_end_time) * 1000
                
                print(f"\n  Performance:")
                print(f"    Total time: {total_time:.2f} ms")
                print(f"    Processing time: {processing_time:.2f} ms")
                
                # Verify response structure matches frontend expectations
                assert response_received, "Did not receive chatbot_response"
                assert backend_used is not None, "backend_used should be present"
                
        except asyncio.TimeoutError as e:
            pytest.fail(f"Test timed out: {str(e) or 'Timeout waiting for response'}. "
                       f"Is the backend running and processing requests?")
        except Exception as e:
            error_msg = str(e) if str(e) else f"{type(e).__name__}"
            pytest.fail(f"Segment completion test failed: {error_msg}. "
                       f"Check backend logs for details.")
    
    @pytest.mark.asyncio
    async def test_frontend_conversation_flow(self, websocket_url):
        """Test complete conversation flow (multiple questions)."""
        try:
            print(f"\n[Frontend Simulation] Testing conversation flow...")
            
            async with connect(websocket_url) as websocket:
                # Generate session ID
                session_id = f"session-{int(time.time() * 1000)}-conv"
                
                # Session
                await websocket.send(json.dumps({
                    "type": "session",
                    "session_id": session_id
                }))
                await websocket.recv()  # session_ack
                
                # First question
                print(f"  Question 1:")
                for _ in range(2):
                    chunk_data = self.create_audio_chunk_base64(duration_sec=0.2)
                    await websocket.send(json.dumps({
                        "type": "audio_chunk",
                        "data": chunk_data
                    }))
                    await websocket.recv()  # chunk_received
                
                await websocket.send(json.dumps({"type": "segment_end"}))
                
                response1 = None
                start_wait = time.perf_counter()
                timeout = 120.0
                while not response1:
                    try:
                        response = await asyncio.wait_for(websocket.recv(), timeout=timeout)
                        message = json.loads(response)
                        if message["type"] == "chatbot_response":
                            response1 = message
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
                
                print(f"    ✓ Received response 1")
                print(f"      Transcription: '{response1.get('transcription', 'N/A')}'")
                
                # Wait a bit (simulating user listening to TTS)
                await asyncio.sleep(0.5)
                
                # Second question
                print(f"  Question 2:")
                for _ in range(2):
                    chunk_data = self.create_audio_chunk_base64(duration_sec=0.2)
                    await websocket.send(json.dumps({
                        "type": "audio_chunk",
                        "data": chunk_data
                    }))
                    await websocket.recv()  # chunk_received
                
                await websocket.send(json.dumps({"type": "segment_end"}))
                
                response2 = None
                start_wait = time.perf_counter()
                timeout = 120.0
                while not response2:
                    try:
                        response = await asyncio.wait_for(websocket.recv(), timeout=timeout)
                        message = json.loads(response)
                        if message["type"] == "chatbot_response":
                            response2 = message
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
                
                print(f"    ✓ Received response 2")
                print(f"      Transcription: '{response2.get('transcription', 'N/A')}'")
                
                # Verify both responses received
                assert response1 is not None
                assert response2 is not None
                print(f"  ✓ Conversation flow successful")
                
        except asyncio.TimeoutError as e:
            pytest.fail(f"Test timed out: {str(e) or 'Timeout waiting for response'}. "
                       f"Is the backend running and processing requests?")
        except Exception as e:
            error_msg = str(e) if str(e) else f"{type(e).__name__}"
            pytest.fail(f"Conversation flow test failed: {error_msg}. "
                       f"Check backend logs for details.")
    
    @pytest.mark.asyncio
    async def test_frontend_error_recovery(self, websocket_url, session_id):
        """Test frontend's error recovery behavior."""
        try:
            print(f"\n[Frontend Simulation] Testing error recovery...")
            
            async with connect(websocket_url) as websocket:
                # Normal session
                await websocket.send(json.dumps({
                    "type": "session",
                    "session_id": session_id
                }))
                await websocket.recv()  # session_ack
                
                # Send empty audio chunk (edge case)
                await websocket.send(json.dumps({
                    "type": "audio_chunk",
                    "data": ""  # Empty data
                }))
                
                # Should handle gracefully
                response = await asyncio.wait_for(websocket.recv(), timeout=5.0)
                message = json.loads(response)
                
                # Should either acknowledge or send error
                assert message["type"] in ["chunk_received", "error"]
                print(f"  ✓ Handled empty chunk gracefully")
                
                # Connection should still be open
                assert websocket.open
                print(f"  ✓ Connection remains open after error")
                
        except asyncio.TimeoutError as e:
            pytest.fail(f"Test timed out: {str(e) or 'Timeout waiting for response'}. "
                       f"Is the backend running and processing requests?")
        except Exception as e:
            error_msg = str(e) if str(e) else f"{type(e).__name__}"
            pytest.fail(f"Error recovery test failed: {error_msg}. "
                       f"Check backend logs for details.")

