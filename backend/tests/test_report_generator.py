"""
Test report generator that collects timing data and generates comprehensive reports.
"""
import json
import time
import statistics
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Any, Optional
from dataclasses import dataclass, asdict, field
from collections import defaultdict


@dataclass
class TestResult:
    """Individual test result with timing data."""
    test_name: str
    test_file: str
    status: str  # passed, failed, skipped
    duration_ms: float
    category: str  # transcription, chatbot, websocket, end_to_end
    metadata: Dict[str, Any] = field(default_factory=dict)
    timestamp: str = ""


@dataclass
class PerformanceMetrics:
    """Performance metrics for a category."""
    category: str
    total_tests: int
    passed: int
    failed: int
    skipped: int
    avg_time_ms: float
    min_time_ms: float
    max_time_ms: float
    median_time_ms: float
    std_dev_ms: float
    p95_time_ms: float
    p99_time_ms: float


class TestReportGenerator:
    """Generates comprehensive test reports with timing analysis."""
    
    def __init__(self, output_dir: Path = None):
        if output_dir is None:
            # Default to backend/test_reports
            output_dir = Path(__file__).parent.parent / "test_reports"
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.results: List[TestResult] = []
        self.start_time = time.time()
    
    def add_result(self, test_name: str, test_file: str, status: str, 
                   duration_ms: float, category: str, metadata: Dict[str, Any] = None,
                   timestamp: str = None):
        """Add a test result."""
        if timestamp is None:
            timestamp = datetime.now().isoformat()
        if metadata is None:
            metadata = {}
        
        self.results.append(TestResult(
            test_name=test_name,
            test_file=test_file,
            status=status,
            duration_ms=duration_ms,
            category=category,
            metadata=metadata,
            timestamp=timestamp
        ))
    
    def calculate_metrics(self, category: str) -> PerformanceMetrics:
        """Calculate performance metrics for a category."""
        category_results = [r for r in self.results if r.category == category and r.status == "passed"]
        
        if not category_results:
            return PerformanceMetrics(
                category=category,
                total_tests=0,
                passed=0,
                failed=0,
                skipped=0,
                avg_time_ms=0,
                min_time_ms=0,
                max_time_ms=0,
                median_time_ms=0,
                std_dev_ms=0,
                p95_time_ms=0,
                p99_time_ms=0
            )
        
        times = [r.duration_ms for r in category_results]
        all_category = [r for r in self.results if r.category == category]
        
        return PerformanceMetrics(
            category=category,
            total_tests=len(all_category),
            passed=len([r for r in all_category if r.status == "passed"]),
            failed=len([r for r in all_category if r.status == "failed"]),
            skipped=len([r for r in all_category if r.status == "skipped"]),
            avg_time_ms=statistics.mean(times),
            min_time_ms=min(times),
            max_time_ms=max(times),
            median_time_ms=statistics.median(times),
            std_dev_ms=statistics.stdev(times) if len(times) > 1 else 0,
            p95_time_ms=self._percentile(times, 95),
            p99_time_ms=self._percentile(times, 99)
        )
    
    def _percentile(self, data: List[float], percentile: int) -> float:
        """Calculate percentile."""
        if not data:
            return 0
        sorted_data = sorted(data)
        index = int(len(sorted_data) * percentile / 100)
        return sorted_data[min(index, len(sorted_data) - 1)]
    
    def generate_json_report(self) -> Path:
        """Generate JSON report."""
        report_data = {
            "generated_at": datetime.now().isoformat(),
            "total_tests": len(self.results),
            "summary": {
                "passed": len([r for r in self.results if r.status == "passed"]),
                "failed": len([r for r in self.results if r.status == "failed"]),
                "skipped": len([r for r in self.results if r.status == "skipped"])
            },
            "categories": {},
            "test_results": [asdict(r) for r in self.results],
            "performance_metrics": {}
        }
        
        # Calculate metrics for each category
        categories = set(r.category for r in self.results)
        for category in categories:
            metrics = self.calculate_metrics(category)
            report_data["categories"][category] = {
                "total": metrics.total_tests,
                "passed": metrics.passed,
                "failed": metrics.failed,
                "skipped": metrics.skipped
            }
            report_data["performance_metrics"][category] = asdict(metrics)
        
        # Save JSON report
        report_file = self.output_dir / f"test_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        with open(report_file, 'w', encoding='utf-8') as f:
            json.dump(report_data, f, indent=2)
        
        return report_file
    
    def generate_html_report(self) -> Path:
        """Generate HTML report with charts and analysis."""
        metrics_by_category = {}
        categories = set(r.category for r in self.results)
        for category in categories:
            metrics_by_category[category] = self.calculate_metrics(category)
        
        html_content = self._generate_html_content(metrics_by_category)
        
        report_file = self.output_dir / f"test_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.html"
        with open(report_file, 'w', encoding='utf-8') as f:
            f.write(html_content)
        
        return report_file
    
    def _generate_html_content(self, metrics_by_category: Dict[str, PerformanceMetrics]) -> str:
        """Generate HTML content for report."""
        total_time = time.time() - self.start_time
        passed = len([r for r in self.results if r.status == "passed"])
        failed = len([r for r in self.results if r.status == "failed"])
        skipped = len([r for r in self.results if r.status == "skipped"])
        
        # Generate performance table rows
        metrics_rows = ""
        for category, metrics in metrics_by_category.items():
            if metrics.total_tests > 0:
                metrics_rows += f"""
                <tr>
                    <td><strong>{category.replace('_', ' ').title()}</strong></td>
                    <td>{metrics.total_tests}</td>
                    <td class="passed">{metrics.passed}</td>
                    <td class="failed">{metrics.failed}</td>
                    <td class="skipped">{metrics.skipped}</td>
                    <td>{metrics.avg_time_ms:.2f} ms</td>
                    <td>{metrics.min_time_ms:.2f} ms</td>
                    <td>{metrics.max_time_ms:.2f} ms</td>
                    <td>{metrics.median_time_ms:.2f} ms</td>
                    <td>{metrics.p95_time_ms:.2f} ms</td>
                    <td>{metrics.std_dev_ms:.2f} ms</td>
                </tr>
                """
        
        # Generate test results table
        test_results_rows = ""
        for result in sorted(self.results, key=lambda x: x.duration_ms, reverse=True):
            status_class = result.status
            test_results_rows += f"""
            <tr class="{status_class}">
                <td>{result.test_name}</td>
                <td>{result.test_file}</td>
                <td>{result.category}</td>
                <td class="{status_class}">{result.status}</td>
                <td>{result.duration_ms:.2f} ms</td>
                <td>{result.timestamp}</td>
            </tr>
            """
        
        # Generate analysis
        analysis = self._generate_analysis(metrics_by_category)
        
        return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Backend Performance Test Report</title>
    <style>
        * {{
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }}
        body {{
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
            color: #333;
            padding: 20px;
        }}
        .container {{
            max-width: 1400px;
            margin: 0 auto;
            background: white;
            border-radius: 10px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            padding: 30px;
        }}
        h1 {{
            color: #2a5298;
            border-bottom: 3px solid #2a5298;
            padding-bottom: 10px;
            margin-bottom: 30px;
        }}
        h2 {{
            color: #1e3c72;
            margin-top: 30px;
            margin-bottom: 15px;
            border-left: 4px solid #2a5298;
            padding-left: 10px;
        }}
        .summary {{
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }}
        .summary-card {{
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            border-radius: 8px;
            text-align: center;
        }}
        .summary-card h3 {{
            font-size: 14px;
            opacity: 0.9;
            margin-bottom: 10px;
        }}
        .summary-card .value {{
            font-size: 32px;
            font-weight: bold;
        }}
        table {{
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 30px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }}
        th {{
            background: #2a5298;
            color: white;
            padding: 12px;
            text-align: left;
            font-weight: 600;
        }}
        td {{
            padding: 10px 12px;
            border-bottom: 1px solid #e0e0e0;
        }}
        tr:hover {{
            background: #f5f5f5;
        }}
        .passed {{
            color: #28a745;
            font-weight: bold;
        }}
        .failed {{
            color: #dc3545;
            font-weight: bold;
        }}
        .skipped {{
            color: #ffc107;
            font-weight: bold;
        }}
        .analysis {{
            background: #f8f9fa;
            border-left: 4px solid #2a5298;
            padding: 20px;
            margin: 20px 0;
            border-radius: 4px;
        }}
        .analysis h3 {{
            color: #2a5298;
            margin-bottom: 15px;
        }}
        .analysis ul {{
            margin-left: 20px;
        }}
        .analysis li {{
            margin: 8px 0;
            line-height: 1.6;
        }}
        .recommendation {{
            background: #fff3cd;
            border-left: 4px solid #ffc107;
            padding: 15px;
            margin: 15px 0;
            border-radius: 4px;
        }}
        .recommendation h4 {{
            color: #856404;
            margin-bottom: 10px;
        }}
        .timestamp {{
            color: #666;
            font-size: 12px;
            text-align: right;
            margin-top: 30px;
        }}
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 Backend Performance Test Report</h1>
        
        <div class="summary">
            <div class="summary-card">
                <h3>Total Tests</h3>
                <div class="value">{len(self.results)}</div>
            </div>
            <div class="summary-card" style="background: linear-gradient(135deg, #28a745 0%, #20c997 100%);">
                <h3>Passed</h3>
                <div class="value">{passed}</div>
            </div>
            <div class="summary-card" style="background: linear-gradient(135deg, #dc3545 0%, #c82333 100%);">
                <h3>Failed</h3>
                <div class="value">{failed}</div>
            </div>
            <div class="summary-card" style="background: linear-gradient(135deg, #ffc107 0%, #ff9800 100%);">
                <h3>Skipped</h3>
                <div class="value">{skipped}</div>
            </div>
            <div class="summary-card" style="background: linear-gradient(135deg, #17a2b8 0%, #138496 100%);">
                <h3>Total Time</h3>
                <div class="value">{total_time:.1f}s</div>
            </div>
        </div>
        
        <h2>📊 Performance Metrics by Category</h2>
        <table>
            <thead>
                <tr>
                    <th>Category</th>
                    <th>Total</th>
                    <th>Passed</th>
                    <th>Failed</th>
                    <th>Skipped</th>
                    <th>Avg Time</th>
                    <th>Min Time</th>
                    <th>Max Time</th>
                    <th>Median</th>
                    <th>P95</th>
                    <th>Std Dev</th>
                </tr>
            </thead>
            <tbody>
                {metrics_rows}
            </tbody>
        </table>
        
        <h2>📋 Detailed Test Results</h2>
        <table>
            <thead>
                <tr>
                    <th>Test Name</th>
                    <th>File</th>
                    <th>Category</th>
                    <th>Status</th>
                    <th>Duration</th>
                    <th>Timestamp</th>
                </tr>
            </thead>
            <tbody>
                {test_results_rows}
            </tbody>
        </table>
        
        <h2>🔍 Performance Analysis</h2>
        <div class="analysis">
            {analysis}
        </div>
        
        <div class="timestamp">
            Generated at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
        </div>
    </div>
</body>
</html>
"""
    
    def _generate_analysis(self, metrics_by_category: Dict[str, PerformanceMetrics]) -> str:
        """Generate performance analysis and recommendations."""
        analysis_parts = []
        
        # Overall analysis
        total_passed = sum(m.passed for m in metrics_by_category.values())
        total_failed = sum(m.failed for m in metrics_by_category.values())
        total_skipped = sum(m.skipped for m in metrics_by_category.values())
        
        analysis_parts.append(f"""
        <h3>Overall Summary</h3>
        <ul>
            <li><strong>Total Tests:</strong> {len(self.results)}</li>
            <li><strong>Pass Rate:</strong> {(total_passed / len(self.results) * 100) if self.results else 0:.1f}%</li>
            <li><strong>Failed Tests:</strong> {total_failed}</li>
            <li><strong>Skipped Tests:</strong> {total_skipped}</li>
        </ul>
        """)
        
        # Category-specific analysis
        analysis_parts.append("<h3>Category Performance</h3><ul>")
        
        for category, metrics in metrics_by_category.items():
            if metrics.total_tests > 0:
                category_name = category.replace('_', ' ').title()
                pass_rate = (metrics.passed / metrics.total_tests * 100) if metrics.total_tests > 0 else 0
                
                analysis_parts.append(f"""
                <li><strong>{category_name}:</strong>
                    <ul>
                        <li>Average response time: {metrics.avg_time_ms:.2f} ms</li>
                        <li>Fastest: {metrics.min_time_ms:.2f} ms</li>
                        <li>Slowest: {metrics.max_time_ms:.2f} ms</li>
                        <li>95th percentile: {metrics.p95_time_ms:.2f} ms</li>
                        <li>Pass rate: {pass_rate:.1f}%</li>
                    </ul>
                </li>
                """)
        
        analysis_parts.append("</ul>")
        
        # Performance targets analysis
        analysis_parts.append("<h3>Performance Targets</h3><ul>")
        
        targets = {
            "transcription": {"1s": 5000, "3s": 10000, "5s": 15000},
            "chatbot": {"short": 30000, "medium": 30000, "long": 30000},
            "end_to_end": {"1s": 35000, "with_diarization": 40000},
            "websocket": {"complete_flow": 60000}
        }
        
        for category, metrics in metrics_by_category.items():
            if category in targets:
                category_name = category.replace('_', ' ').title()
                for target_name, target_ms in targets[category].items():
                    if metrics.avg_time_ms > target_ms:
                        analysis_parts.append(f"""
                        <li class="recommendation">
                            <strong>⚠️ {category_name} ({target_name}):</strong> 
                            Average time ({metrics.avg_time_ms:.2f} ms) exceeds target ({target_ms} ms) by 
                            {((metrics.avg_time_ms / target_ms - 1) * 100):.1f}%
                        </li>
                        """)
                    else:
                        analysis_parts.append(f"""
                        <li>
                            <strong>✓ {category_name} ({target_name}):</strong> 
                            Average time ({metrics.avg_time_ms:.2f} ms) meets target ({target_ms} ms)
                        </li>
                        """)
        
        analysis_parts.append("</ul>")
        
        # Recommendations
        recommendations = self._generate_recommendations(metrics_by_category)
        if recommendations:
            analysis_parts.append("<h3>Recommendations</h3><ul>")
            for rec in recommendations:
                analysis_parts.append(f"<li>{rec}</li>")
            analysis_parts.append("</ul>")
        
        return "".join(analysis_parts)
    
    def _generate_recommendations(self, metrics_by_category: Dict[str, PerformanceMetrics]) -> List[str]:
        """Generate performance recommendations."""
        recommendations = []
        
        # Check transcription performance
        if "transcription" in metrics_by_category:
            metrics = metrics_by_category["transcription"]
            if metrics.avg_time_ms > 5000:
                recommendations.append(
                    f"Transcription is slow (avg: {metrics.avg_time_ms:.2f} ms). "
                    "Consider using a smaller Whisper model (tiny) or optimizing audio preprocessing."
                )
        
        # Check chatbot performance
        if "chatbot" in metrics_by_category:
            metrics = metrics_by_category["chatbot"]
            if metrics.avg_time_ms > 30000:
                recommendations.append(
                    f"Chatbot response is slow (avg: {metrics.avg_time_ms:.2f} ms). "
                    "Consider using a faster backend (OpenAI) or optimizing model parameters."
                )
        
        # Check end-to-end performance
        if "end_to_end" in metrics_by_category:
            metrics = metrics_by_category["end_to_end"]
            if metrics.avg_time_ms > 35000:
                recommendations.append(
                    f"End-to-end flow is slow (avg: {metrics.avg_time_ms:.2f} ms). "
                    "Consider parallelizing transcription and chatbot processing, or optimizing individual components."
                )
        
        # Check WebSocket performance
        if "websocket" in metrics_by_category:
            metrics = metrics_by_category["websocket"]
            if metrics.std_dev_ms > metrics.avg_time_ms * 0.5:
                recommendations.append(
                    f"WebSocket performance is inconsistent (std dev: {metrics.std_dev_ms:.2f} ms). "
                    "Consider investigating network latency or backend load."
                )
        
        # General recommendations
        if not recommendations:
            recommendations.append("All performance targets are being met. Great job! 🎉")
        
        return recommendations
    
    def generate_all_reports(self) -> Dict[str, Path]:
        """Generate all report formats."""
        return {
            "json": self.generate_json_report(),
            "html": self.generate_html_report()
        }

