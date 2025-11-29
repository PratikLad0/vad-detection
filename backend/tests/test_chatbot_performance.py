"""
Unit tests for measuring chatbot response generation performance.
"""
import time
import pytest
from chatbot_service import generate_chatbot_response, initialize_chatbot_backends


class TestChatbotPerformance:
    """Test chatbot response generation times."""
    
    @pytest.fixture(autouse=True)
    def setup(self, chatbot_backends):
        """Setup test fixtures."""
        self.backend_status = chatbot_backends
    
    def test_chatbot_response_short_message(self):
        """Test chatbot response time for short message."""
        user_message = "Hello"
        
        start_time = time.perf_counter()
        result = generate_chatbot_response(user_message)
        end_time = time.perf_counter()
        
        elapsed_time = (end_time - start_time) * 1000  # Convert to milliseconds
        
        print(f"\n[Chatbot Performance] Short message:")
        print(f"  Input: '{user_message}'")
        print(f"  Response time: {elapsed_time:.2f} ms")
        print(f"  Backend used: {result.get('backend_used', 'unknown')}")
        print(f"  Has response: {bool(result.get('response'))}")
        print(f"  Has error: {bool(result.get('error'))}")
        if result.get('response'):
            print(f"  Response preview: {result['response'][:100]}...")
        
        # Assert we got a result (either response or error)
        assert result is not None
        assert result.get('backend_used') is not None
        
        # Assert reasonable performance (should be under 30 seconds for local models)
        if result.get('response'):
            assert elapsed_time < 30000, f"Chatbot response took too long: {elapsed_time:.2f} ms"
    
    def test_chatbot_response_medium_message(self):
        """Test chatbot response time for medium message."""
        user_message = "What is the capital of France and what is its population?"
        
        start_time = time.perf_counter()
        result = generate_chatbot_response(user_message)
        end_time = time.perf_counter()
        
        elapsed_time = (end_time - start_time) * 1000  # Convert to milliseconds
        
        print(f"\n[Chatbot Performance] Medium message:")
        print(f"  Input: '{user_message}'")
        print(f"  Response time: {elapsed_time:.2f} ms")
        print(f"  Backend used: {result.get('backend_used', 'unknown')}")
        print(f"  Has response: {bool(result.get('response'))}")
        if result.get('response'):
            print(f"  Response preview: {result['response'][:100]}...")
        
        # Assert we got a result
        assert result is not None
        assert result.get('backend_used') is not None
        
        # Assert reasonable performance
        if result.get('response'):
            assert elapsed_time < 30000, f"Chatbot response took too long: {elapsed_time:.2f} ms"
    
    def test_chatbot_response_long_message(self):
        """Test chatbot response time for long message."""
        user_message = "Can you explain the theory of relativity in simple terms? I want to understand how time and space are related according to Einstein's theory."
        
        start_time = time.perf_counter()
        result = generate_chatbot_response(user_message)
        end_time = time.perf_counter()
        
        elapsed_time = (end_time - start_time) * 1000  # Convert to milliseconds
        
        print(f"\n[Chatbot Performance] Long message:")
        print(f"  Input length: {len(user_message)} characters")
        print(f"  Response time: {elapsed_time:.2f} ms")
        print(f"  Backend used: {result.get('backend_used', 'unknown')}")
        print(f"  Has response: {bool(result.get('response'))}")
        if result.get('response'):
            print(f"  Response preview: {result['response'][:100]}...")
        
        # Assert we got a result
        assert result is not None
        assert result.get('backend_used') is not None
        
        # Assert reasonable performance
        if result.get('response'):
            assert elapsed_time < 30000, f"Chatbot response took too long: {elapsed_time:.2f} ms"
    
    def test_chatbot_response_guardrails(self):
        """Test chatbot response time for filtered content (guardrails)."""
        # Use a message that actually triggers guardrails (contains bad word)
        user_message = "This is a test message with inappropriate content"
        
        # Import check_content_guardrails directly to test it separately
        from chatbot_service import check_content_guardrails
        
        # Test guardrails check directly (should be very fast)
        start_time = time.perf_counter()
        is_safe, error_msg = check_content_guardrails(user_message)
        guardrails_time = (time.perf_counter() - start_time) * 1000
        
        print(f"\n[Chatbot Performance] Guardrails check:")
        print(f"  Input: '{user_message}'")
        print(f"  Guardrails check time: {guardrails_time:.2f} ms")
        print(f"  Is safe: {is_safe}")
        
        # Guardrails check itself should be very fast (under 10ms)
        assert guardrails_time < 10, f"Guardrails check took too long: {guardrails_time:.2f} ms"
        
        # Now test with a message that actually triggers guardrails
        bad_message = "This message contains fuck and shit"
        start_time = time.perf_counter()
        result = generate_chatbot_response(bad_message)
        end_time = time.perf_counter()
        
        elapsed_time = (end_time - start_time) * 1000
        
        print(f"\n[Chatbot Performance] Guardrails blocking:")
        print(f"  Input: '{bad_message}'")
        print(f"  Response time: {elapsed_time:.2f} ms")
        print(f"  Backend used: {result.get('backend_used', 'unknown')}")
        print(f"  Has error: {bool(result.get('error'))}")
        
        # When guardrails blocks, it should be very fast (under 100ms)
        assert result.get('backend_used') == 'guardrails', "Guardrails should have blocked this message"
        assert elapsed_time < 100, f"Guardrails blocking took too long: {elapsed_time:.2f} ms"
    
    def test_chatbot_benchmark_multiple_runs(self):
        """Benchmark chatbot with multiple runs to get average time."""
        user_message = "What is 2+2?"
        num_runs = 3
        times = []
        results = []
        
        for i in range(num_runs):
            start_time = time.perf_counter()
            result = generate_chatbot_response(user_message)
            end_time = time.perf_counter()
            
            elapsed_time = (end_time - start_time) * 1000
            times.append(elapsed_time)
            results.append(result)
        
        avg_time = sum(times) / len(times)
        min_time = min(times)
        max_time = max(times)
        
        print(f"\n[Chatbot Benchmark] {num_runs} runs:")
        print(f"  Input: '{user_message}'")
        print(f"  Average time: {avg_time:.2f} ms")
        print(f"  Min time: {min_time:.2f} ms")
        print(f"  Max time: {max_time:.2f} ms")
        print(f"  Times: {[f'{t:.2f}' for t in times]} ms")
        print(f"  Backend used: {results[0].get('backend_used', 'unknown')}")
        
        # Assert reasonable average performance
        if results[0].get('response'):
            assert avg_time < 30000, f"Average chatbot response time too high: {avg_time:.2f} ms"
    
    def test_chatbot_backend_comparison(self):
        """Compare response times across different backends (if available)."""
        user_message = "Hello, how are you?"
        backend_times = {}
        
        # Test each available backend
        if self.backend_status.get('llama', False):
            # Force llama backend
            import os
            original_backend = os.getenv('CHATBOT_BACKEND', 'llama')
            os.environ['CHATBOT_BACKEND'] = 'llama'
            
            try:
                from chatbot_service import generate_chatbot_response
                start_time = time.perf_counter()
                result = generate_chatbot_response(user_message)
                end_time = time.perf_counter()
                elapsed_time = (end_time - start_time) * 1000
                backend_times['llama'] = elapsed_time
            finally:
                os.environ['CHATBOT_BACKEND'] = original_backend
        
        if self.backend_status.get('huggingface', False):
            # Force huggingface backend
            import os
            original_backend = os.getenv('CHATBOT_BACKEND', 'llama')
            os.environ['CHATBOT_BACKEND'] = 'huggingface'
            
            try:
                from chatbot_service import generate_chatbot_response
                start_time = time.perf_counter()
                result = generate_chatbot_response(user_message)
                end_time = time.perf_counter()
                elapsed_time = (end_time - start_time) * 1000
                backend_times['huggingface'] = elapsed_time
            finally:
                os.environ['CHATBOT_BACKEND'] = original_backend
        
        if backend_times:
            print(f"\n[Chatbot Backend Comparison]:")
            print(f"  Input: '{user_message}'")
            for backend, elapsed_time in backend_times.items():
                print(f"  {backend}: {elapsed_time:.2f} ms")
        else:
            pytest.skip("No backends available for comparison")

