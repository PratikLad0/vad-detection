"""
Pytest hooks for collecting test results and generating reports.
"""
import pytest
import time
from pathlib import Path
from test_report_generator import TestReportGenerator

# Global report generator instance
_report_generator: TestReportGenerator = None


def pytest_configure(config):
    """Initialize report generator."""
    global _report_generator
    output_dir = Path(__file__).parent.parent / "test_reports"
    _report_generator = TestReportGenerator(output_dir=output_dir)


def pytest_runtest_setup(item):
    """Called before each test runs."""
    if _report_generator:
        item._test_start_time = time.perf_counter()


def pytest_runtest_teardown(item, nextitem):
    """Called after each test runs."""
    if _report_generator and hasattr(item, '_test_start_time'):
        duration = (time.perf_counter() - item._test_start_time) * 1000  # Convert to ms
        
        # Determine category from test name/path
        test_name = item.name
        test_file = str(item.fspath.relative_to(Path(__file__).parent.parent))
        category = "other"
        
        if "transcription" in test_name.lower() or "transcription" in test_file.lower():
            category = "transcription"
        elif "chatbot" in test_name.lower() or "chatbot" in test_file.lower():
            category = "chatbot"
        elif "websocket" in test_name.lower() or "websocket" in test_file.lower():
            category = "websocket"
        elif "frontend" in test_name.lower() or "frontend" in test_file.lower():
            category = "websocket"  # Frontend simulation is also WebSocket
        elif "end_to_end" in test_name.lower() or "end_to_end" in test_file.lower():
            category = "end_to_end"
        
        # Get test status
        status = "passed"
        if hasattr(item, '_test_outcome'):
            outcome = item._test_outcome
            if outcome == "failed":
                status = "failed"
            elif outcome == "skipped":
                status = "skipped"
        
        # Extract metadata from test if available
        metadata = {}
        if hasattr(item, 'callspec'):
            metadata = item.callspec.params if item.callspec else {}
        
        _report_generator.add_result(
            test_name=test_name,
            test_file=test_file,
            status=status,
            duration_ms=duration,
            category=category,
            metadata=metadata
        )


@pytest.hookimpl(tryfirst=True)
def pytest_runtest_makereport(item, call):
    """Store test outcome for later use."""
    if call.when == "call":
        item._test_outcome = call.outcome
    elif call.when == "setup":
        if call.excinfo is not None:
            item._test_outcome = "failed"
    elif call.when == "teardown":
        if call.excinfo is not None:
            item._test_outcome = "failed"


def pytest_sessionfinish(session, exitstatus):
    """Generate reports after all tests complete."""
    global _report_generator
    if _report_generator:
        print("\n" + "=" * 80)
        print("Generating test reports...")
        print("=" * 80)
        
        try:
            reports = _report_generator.generate_all_reports()
            print(f"\n✓ JSON report: {reports['json']}")
            print(f"✓ HTML report: {reports['html']}")
            print("\nOpen the HTML report in your browser to view detailed analysis!")
        except Exception as e:
            print(f"\n✗ Failed to generate reports: {e}")

