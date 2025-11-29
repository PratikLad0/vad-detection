# Quick Start: Test Reporting

## Run Tests and Generate Reports

```bash
# 1. Start backend (in one terminal)
cd backend
uvicorn main:app --host 0.0.0.0 --port 8000

# 2. Run tests (in another terminal)
cd backend
pytest tests/ -v

# Reports are automatically generated in backend/test_reports/
```

## View Reports

After running tests, open the HTML report:

```bash
# Windows
start test_reports\test_report_*.html

# Or find the latest report
python -c "from pathlib import Path; print(max(Path('test_reports').glob('*.html'), key=lambda p: p.stat().st_mtime))"
```

## Report Contents

### Summary Cards
- Total tests run
- Passed/Failed/Skipped counts
- Total execution time

### Performance Metrics Table
- Average, min, max, median response times
- 95th and 99th percentiles
- Standard deviation
- Per category breakdown

### Test Results Table
- Individual test results
- Timing for each test
- Status (passed/failed/skipped)
- Category classification

### Performance Analysis
- Overall summary
- Category performance breakdown
- Performance target comparison
- Actionable recommendations

## Example Output

```
================================================================================
📊 Test Reports Generated:
================================================================================
  JSON: backend/test_reports/test_report_20251129_180000.json
  HTML: backend/test_reports/test_report_20251129_180000.html

  📄 Open HTML report in browser:
     file://C:/genai/VadBasedRecorder/backend/test_reports/test_report_20251129_180000.html
================================================================================
```

## Performance Targets

The report automatically compares results against:
- Transcription: < 5000-15000 ms (depending on audio length)
- Chatbot: < 30000 ms
- End-to-end: < 35000-40000 ms
- WebSocket: < 60000 ms

## Tips

- Reports are generated automatically - no extra steps needed
- HTML reports are interactive and easy to read
- JSON reports are machine-readable for CI/CD
- Reports include recommendations for performance improvements

