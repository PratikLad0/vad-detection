# Test Reporting System

## Overview

The test reporting system automatically collects timing data from all tests and generates comprehensive HTML and JSON reports with detailed performance analysis.

## Features

- **Automatic Timing Collection**: All tests are automatically timed
- **Category-based Analysis**: Tests are grouped by category (transcription, chatbot, websocket, end_to_end)
- **Performance Metrics**: Calculates average, min, max, median, P95, P99, and standard deviation
- **HTML Reports**: Beautiful, interactive HTML reports with charts and analysis
- **JSON Reports**: Machine-readable JSON reports for CI/CD integration
- **Performance Targets**: Compares results against performance targets
- **Recommendations**: Provides actionable recommendations based on results

## How It Works

The reporting system uses pytest hooks to automatically:
1. Track test start/end times
2. Categorize tests by type
3. Collect test results and metadata
4. Generate reports after all tests complete

## Running Tests with Reporting

### Automatic Reporting

Reports are generated automatically when you run tests:

```bash
# Run all tests (reports generated automatically)
pytest tests/ -v

# Run specific test category
pytest tests/test_transcription_performance.py -v
pytest tests/test_chatbot_performance.py -v
pytest tests/test_websocket_integration.py -v
```

### Using Report Generator Script

```bash
# Run tests and generate reports
python generate_test_report.py
```

## Report Output

Reports are saved to `backend/test_reports/` directory:

- **HTML Report**: `test_report_YYYYMMDD_HHMMSS.html`
- **JSON Report**: `test_report_YYYYMMDD_HHMMSS.json`

### HTML Report Features

- **Summary Cards**: Total tests, passed, failed, skipped, total time
- **Performance Metrics Table**: Detailed metrics by category
- **Test Results Table**: All individual test results
- **Performance Analysis**: 
  - Overall summary
  - Category performance breakdown
  - Performance target comparison
  - Recommendations

### JSON Report Structure

```json
{
  "generated_at": "2025-11-29T18:00:00",
  "total_tests": 20,
  "summary": {
    "passed": 18,
    "failed": 1,
    "skipped": 1
  },
  "categories": {
    "transcription": {
      "total": 5,
      "passed": 5,
      "failed": 0,
      "skipped": 0
    }
  },
  "performance_metrics": {
    "transcription": {
      "avg_time_ms": 1234.56,
      "min_time_ms": 1000.00,
      "max_time_ms": 1500.00,
      "median_time_ms": 1200.00,
      "p95_time_ms": 1450.00,
      "std_dev_ms": 150.00
    }
  },
  "test_results": [...]
}
```

## Performance Targets

The system compares results against these targets:

| Category | Target | Description |
|----------|--------|-------------|
| Transcription (1s) | < 5000 ms | Short audio transcription |
| Transcription (3s) | < 10000 ms | Medium audio transcription |
| Transcription (5s) | < 15000 ms | Long audio transcription |
| Chatbot (short) | < 30000 ms | Short message response |
| Chatbot (medium) | < 30000 ms | Medium message response |
| Chatbot (long) | < 30000 ms | Long message response |
| End-to-end (1s) | < 35000 ms | Complete flow with 1s audio |
| End-to-end (with diarization) | < 40000 ms | Complete flow with diarization |
| WebSocket (complete flow) | < 60000 ms | Full WebSocket flow |

## Viewing Reports

### HTML Report

Open the HTML file in your browser:
```bash
# Windows
start test_reports/test_report_*.html

# Linux/Mac
open test_reports/test_report_*.html
# or
xdg-open test_reports/test_report_*.html
```

### JSON Report

Parse with any JSON tool:
```bash
# Pretty print
cat test_reports/test_report_*.json | python -m json.tool

# Extract specific metrics
python -c "import json; data=json.load(open('test_reports/test_report_*.json')); print(data['performance_metrics'])"
```

## CI/CD Integration

### GitHub Actions Example

```yaml
- name: Run tests and generate reports
  run: |
    cd backend
    pytest tests/ -v
    
- name: Upload test reports
  uses: actions/upload-artifact@v3
  with:
    name: test-reports
    path: backend/test_reports/
```

### Parse JSON in CI

```yaml
- name: Check performance targets
  run: |
    python -c "
    import json
    import sys
    report = json.load(open('backend/test_reports/test_report_*.json'))
    metrics = report['performance_metrics']
    
    # Check transcription performance
    if metrics['transcription']['avg_time_ms'] > 5000:
        print('⚠ Transcription too slow')
        sys.exit(1)
    "
```

## Customization

### Change Report Output Directory

Modify `conftest.py`:
```python
output_dir = Path("/custom/path/test_reports")
```

### Add Custom Metrics

Extend `TestReportGenerator` class:
```python
def add_custom_metric(self, category: str, metric_name: str, value: float):
    # Add custom metric collection
    pass
```

### Custom Performance Targets

Modify `_generate_analysis()` method in `test_report_generator.py` to add custom targets.

## Troubleshooting

### Reports Not Generated

- Check that `test_report_generator.py` is in `tests/` directory
- Verify pytest hooks are working: `pytest --collect-only`
- Check for import errors in `conftest.py`

### Missing Test Data

- Ensure tests are using the reporting fixtures
- Check that test categories are correctly identified
- Verify test timing is being collected

### HTML Report Not Displaying

- Check browser console for errors
- Verify HTML file is valid
- Try opening in different browser

## Examples

### View Latest Report

```bash
# Find latest HTML report
ls -t backend/test_reports/*.html | head -1

# Open in browser
python -m webbrowser $(ls -t backend/test_reports/*.html | head -1)
```

### Extract Performance Summary

```python
import json
from pathlib import Path

# Find latest report
reports_dir = Path("backend/test_reports")
latest_json = max(reports_dir.glob("test_report_*.json"), key=lambda p: p.stat().st_mtime)

# Load and analyze
with open(latest_json) as f:
    report = json.load(f)

print("Performance Summary:")
for category, metrics in report["performance_metrics"].items():
    print(f"{category}: {metrics['avg_time_ms']:.2f} ms (avg)")
```

## Next Steps

- Add trend analysis (compare with previous runs)
- Generate charts/graphs in HTML report
- Add regression detection
- Export to CSV for spreadsheet analysis
- Integrate with monitoring systems

