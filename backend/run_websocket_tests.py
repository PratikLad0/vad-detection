#!/usr/bin/env python3
"""
Helper script to run WebSocket integration tests.
Ensures backend is running and provides clear instructions.
"""
import subprocess
import sys
import time
import requests
from pathlib import Path

def check_backend_health(api_url: str = "http://localhost:8000") -> bool:
    """Check if backend is running and healthy."""
    try:
        response = requests.get(f"{api_url}/health", timeout=2)
        return response.status_code == 200
    except:
        return False

def main():
    """Run WebSocket tests with backend health check."""
    backend_dir = Path(__file__).parent
    api_url = "http://localhost:8000"
    
    print("=" * 80)
    print("WebSocket Integration Tests")
    print("=" * 80)
    print()
    
    # Check if backend is running
    print("Checking backend health...")
    if not check_backend_health(api_url):
        print(f"❌ Backend is not running at {api_url}")
        print()
        print("Please start the backend first:")
        print("  cd backend")
        print("  uvicorn main:app --host 0.0.0.0 --port 8000")
        print()
        print("Then run this script again.")
        return 1
    
    print(f"✓ Backend is running at {api_url}")
    print()
    
    # Run WebSocket tests
    print("Running WebSocket integration tests...")
    print()
    
    result1 = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/test_websocket_integration.py", "-v", "-s"],
        cwd=backend_dir,
        capture_output=False
    )
    
    print()
    print("Running frontend simulation tests...")
    print()
    
    result2 = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/test_frontend_simulation.py", "-v", "-s"],
        cwd=backend_dir,
        capture_output=False
    )
    
    print()
    print("=" * 80)
    if result1.returncode == 0 and result2.returncode == 0:
        print("✓ All WebSocket tests passed!")
    else:
        print("✗ Some tests failed. Check output above for details.")
    print("=" * 80)
    
    return 0 if (result1.returncode == 0 and result2.returncode == 0) else 1

if __name__ == "__main__":
    sys.exit(main())

