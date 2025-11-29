"""
Pytest configuration and shared fixtures for backend tests.
"""
import os
import sys
import tempfile
import pytest
import time
from pathlib import Path
from dotenv import load_dotenv

# Add backend directory to path
BACKEND_DIR = Path(__file__).parent.parent.resolve()
sys.path.insert(0, str(BACKEND_DIR))

# Import report generator
try:
    # Import from tests directory
    tests_dir = Path(__file__).parent
    if str(tests_dir) not in sys.path:
        sys.path.insert(0, str(tests_dir))
    from test_report_generator import TestReportGenerator
    REPORTING_AVAILABLE = True
except ImportError as e:
    REPORTING_AVAILABLE = False
    # Silently fail - reporting is optional

# Global report generator
_report_generator = None

# Load environment variables
load_dotenv(BACKEND_DIR / ".env")

# Auto-detect and configure GPU for tests
def _configure_gpu_for_tests():
    """
    Automatically detect GPU and configure USE_GPU environment variable for tests.
    This ensures tests use GPU when available, without requiring manual configuration.
    """
    # Check if USE_GPU is already explicitly set (respect user preference)
    if os.getenv("USE_GPU"):
        return
    
    # Try to detect GPU availability
    try:
        import torch
        if torch.cuda.is_available():
            gpu_name = torch.cuda.get_device_name(0)
            cuda_version = torch.version.cuda
            os.environ["USE_GPU"] = "true"
            os.environ["HF_DEVICE"] = "cuda"
            print(f"\n✅ GPU detected for tests: {gpu_name} (CUDA {cuda_version})")
            print("   Tests will use GPU acceleration\n")
        else:
            os.environ["USE_GPU"] = "false"
            os.environ["HF_DEVICE"] = "cpu"
            print("\n⚠️  GPU not available - tests will use CPU\n")
    except ImportError:
        # PyTorch not installed, default to CPU
        os.environ["USE_GPU"] = "false"
        os.environ["HF_DEVICE"] = "cpu"
        print("\n⚠️  PyTorch not available - tests will use CPU\n")
    except Exception as e:
        # Any other error, default to CPU
        os.environ["USE_GPU"] = "false"
        os.environ["HF_DEVICE"] = "cpu"
        print(f"\n⚠️  GPU detection failed: {e} - tests will use CPU\n")

# Configure GPU before any tests run
_configure_gpu_for_tests()

# Test configuration
TEST_AUDIO_DURATION_SEC = 2.0  # Duration of test audio files
TEST_SAMPLE_RATE = 16000  # Whisper uses 16kHz


@pytest.fixture(scope="session", autouse=True)
def reset_device_for_tests():
    """
    Reset device configuration at the start of test session.
    This ensures tests use the GPU configuration set by _configure_gpu_for_tests().
    Runs automatically before any tests.
    """
    # Ensure USE_GPU is set (should already be set by _configure_gpu_for_tests)
    if not os.getenv("USE_GPU"):
        _configure_gpu_for_tests()
    
    # Reset main.py's global device state if it's already been initialized
    # This ensures the environment variable is respected even if main.py was imported before
    try:
        import sys
        backend_dir = Path(__file__).parent.parent
        if str(backend_dir) not in sys.path:
            sys.path.insert(0, str(backend_dir))
        
        # Import main module to access its globals (if already imported)
        if 'main' in sys.modules:
            main_module = sys.modules['main']
            # Reset the global _USE_GPU so it re-checks the environment variable
            if hasattr(main_module, '_USE_GPU'):
                main_module._USE_GPU = None
    except Exception:
        # If this fails, it's not critical - prompt_device_choice() checks env var first
        pass
    
    yield


@pytest.fixture
def temp_audio_file():
    """Create a temporary audio file for testing."""
    import wave
    import numpy as np
    
    # Create a simple sine wave audio file (silence for testing)
    sample_rate = TEST_SAMPLE_RATE
    duration = TEST_AUDIO_DURATION_SEC
    frequency = 440.0  # A4 note
    
    # Generate audio data
    t = np.linspace(0, duration, int(sample_rate * duration), False)
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
        
        yield tmp_file.name
    
    # Cleanup
    if os.path.exists(tmp_file.name):
        os.unlink(tmp_file.name)


@pytest.fixture
def temp_webm_file():
    """Create a minimal WebM file for testing (mock audio data)."""
    # Create a minimal WebM file with dummy data
    # In real tests, this would be actual WebM audio data
    with tempfile.NamedTemporaryFile(delete=False, suffix=".webm") as tmp_file:
        # Write minimal WebM header (simplified)
        tmp_file.write(b'\x1a\x45\xdf\xa3')  # EBML header
        tmp_file.write(b'\x42\x86')  # EBML version
        tmp_file.write(b'\x81\x01')  # EBML read version
        # Add some dummy data
        tmp_file.write(b'\x00' * 1000)  # 1KB of dummy data
        tmp_file.flush()
        
        yield tmp_file.name
    
    # Cleanup
    if os.path.exists(tmp_file.name):
        os.unlink(tmp_file.name)


@pytest.fixture
def sample_transcription_text():
    """Sample transcription text for testing."""
    return "Hello, this is a test transcription for performance testing."


@pytest.fixture
def sample_user_message():
    """Sample user message for chatbot testing."""
    return "What is the capital of France?"


@pytest.fixture(scope="session")
def whisper_model():
    """Load Whisper model once for all tests (session scope)."""
    try:
        # Import here to avoid circular imports
        import sys
        from pathlib import Path
        backend_dir = Path(__file__).parent.parent
        if str(backend_dir) not in sys.path:
            sys.path.insert(0, str(backend_dir))
        
        # Ensure USE_GPU is set before loading model
        # (This should already be set by _configure_gpu_for_tests, but ensure it)
        if not os.getenv("USE_GPU"):
            _configure_gpu_for_tests()
        
        from main import get_whisper_model, get_device
        
        # Get device info for logging
        device = get_device()
        use_gpu = os.getenv("USE_GPU", "").lower() in ("true", "1", "yes", "cuda")
        
        if use_gpu and device == "cuda":
            try:
                import torch
                gpu_name = torch.cuda.get_device_name(0)
                print(f"\n📊 Loading Whisper model on GPU: {gpu_name}")
            except:
                pass
        
        model = get_whisper_model()
        
        # Log which device the model is actually using
        if hasattr(model, 'device'):
            print(f"✅ Whisper model loaded on device: {model.device}")
        
        yield model
    except Exception as e:
        pytest.skip(f"Whisper model not available: {e}")


@pytest.fixture(scope="session")
def chatbot_backends():
    """Initialize chatbot backends once for all tests (session scope)."""
    try:
        # Import here to avoid circular imports
        import sys
        from pathlib import Path
        backend_dir = Path(__file__).parent.parent
        if str(backend_dir) not in sys.path:
            sys.path.insert(0, str(backend_dir))
        
        # Ensure USE_GPU is set before initializing backends
        if not os.getenv("USE_GPU"):
            _configure_gpu_for_tests()
        
        # Log GPU configuration for chatbot
        use_gpu = os.getenv("USE_GPU", "").lower() in ("true", "1", "yes", "cuda")
        if use_gpu:
            try:
                import torch
                if torch.cuda.is_available():
                    gpu_name = torch.cuda.get_device_name(0)
                    print(f"\n📊 Initializing chatbot backends on GPU: {gpu_name}")
            except:
                pass
        
        from chatbot_service import initialize_chatbot_backends, HF_DEVICE
        
        status = initialize_chatbot_backends()
        
        # Log which device is being used
        if use_gpu:
            print(f"✅ Chatbot backends initialized (HF_DEVICE: {HF_DEVICE})")
        
        yield status
    except Exception as e:
        pytest.skip(f"Chatbot backends not available: {e}")


# Pytest hooks for reporting
def pytest_configure(config):
    """Initialize report generator at session start."""
    global _report_generator
    if REPORTING_AVAILABLE:
        output_dir = BACKEND_DIR / "test_reports"
        _report_generator = TestReportGenerator(output_dir=output_dir)
        # Store in config for access in other hooks
        config._report_generator = _report_generator


def pytest_runtest_setup(item):
    """Store test start time."""
    item._test_start_time = time.perf_counter()


def pytest_runtest_teardown(item, nextitem):
    """Collect test results after test completes."""
    global _report_generator
    if not REPORTING_AVAILABLE or not _report_generator:
        return
    
    if not hasattr(item, '_test_start_time'):
        return
    
    duration_ms = (time.perf_counter() - item._test_start_time) * 1000
    
    # Determine category
    test_name = item.name
    # Get test file path (use modern item.path if available, fallback to item.fspath)
    try:
        # Try modern pytest API first (pytest 7+)
        if hasattr(item, 'path') and isinstance(item.path, Path):
            test_file = str(item.path.relative_to(BACKEND_DIR))
        elif hasattr(item, 'fspath'):
            # Handle both pathlib.Path and LocalPath (py.path)
            if hasattr(item.fspath, 'relative_to'):
                # It's already a pathlib.Path
                test_file = str(item.fspath.relative_to(BACKEND_DIR))
            else:
                # It's a LocalPath (py.path), convert to pathlib.Path
                test_file = str(Path(item.fspath).relative_to(BACKEND_DIR))
        else:
            # Fallback: use nodeid
            test_file = item.nodeid.split("::")[0] if "::" in item.nodeid else "unknown"
    except (AttributeError, ValueError, TypeError):
        # Fallback: use string representation or nodeid
        try:
            test_file = str(item.fspath).replace(str(BACKEND_DIR), "").lstrip(os.sep)
        except (AttributeError, ValueError, TypeError):
            test_file = item.nodeid.split("::")[0] if "::" in item.nodeid else "unknown"
    category = "other"
    
    if "transcription" in test_name.lower() or "transcription" in test_file.lower():
        category = "transcription"
    elif "chatbot" in test_name.lower() or "chatbot" in test_file.lower():
        category = "chatbot"
    elif "websocket" in test_name.lower() or "websocket" in test_file.lower():
        category = "websocket"
    elif "frontend" in test_name.lower() or "frontend" in test_file.lower():
        category = "websocket"
    elif "end_to_end" in test_name.lower() or "end_to_end" in test_file.lower():
        category = "end_to_end"
    
    # Get status from test outcome
    status = "passed"
    if hasattr(item, '_test_outcome'):
        if item._test_outcome == "failed":
            status = "failed"
        elif item._test_outcome == "skipped":
            status = "skipped"
    
    # Add result
    _report_generator.add_result(
        test_name=test_name,
        test_file=test_file,
        status=status,
        duration_ms=duration_ms,
        category=category,
        metadata={}
    )


@pytest.hookimpl(tryfirst=True, hookwrapper=True)
def pytest_runtest_makereport(item, call):
    """Store test outcome for reporting."""
    outcome = yield
    rep = outcome.get_result()
    item._test_outcome = rep.outcome


def pytest_sessionfinish(session, exitstatus):
    """Generate reports after all tests complete."""
    global _report_generator
    if REPORTING_AVAILABLE and _report_generator:
        try:
            reports = _report_generator.generate_all_reports()
            print(f"\n{'='*80}")
            print("📊 Test Reports Generated:")
            print(f"{'='*80}")
            print(f"  JSON: {reports['json']}")
            print(f"  HTML: {reports['html']}")
            print(f"\n  📄 Open HTML report in browser:")
            print(f"     file://{reports['html'].absolute()}")
            print(f"{'='*80}\n")
        except Exception as e:
            print(f"\n⚠ Failed to generate reports: {e}\n")
            import traceback
            traceback.print_exc()

