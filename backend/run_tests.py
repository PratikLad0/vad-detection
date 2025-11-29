#!/usr/bin/env python3
"""
Script to run backend performance tests and generate a summary report.
"""
import subprocess
import sys
from pathlib import Path

def main():
    """Run all performance tests and display summary."""
    backend_dir = Path(__file__).parent
    tests_dir = backend_dir / "tests"
    
    print("=" * 80)
    print("Running Backend Performance Tests")
    print("=" * 80)
    print()
    
    # Run all tests
    result = subprocess.run(
        [sys.executable, "-m", "pytest", str(tests_dir), "-v", "-s"],
        cwd=backend_dir,
        capture_output=False
    )
    
    print()
    print("=" * 80)
    if result.returncode == 0:
        print("✓ All tests passed!")
    else:
        print("✗ Some tests failed. Check output above for details.")
    print("=" * 80)
    
    return result.returncode

if __name__ == "__main__":
    sys.exit(main())

