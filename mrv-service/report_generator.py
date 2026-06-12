import io
import base64
import uuid
from pathlib import Path
from datetime import datetime
from jinja2 import Environment, FileSystemLoader, select_autoescape
from weasyprint import HTML

class ReportGenerator:
    """Generates an MRV report HTML and PDF.
    The HTML is rendered with Jinja2 using the template at
    `templates/mrv_report.html`. The PDF is generated via WeasyPrint.
    """

    def __init__(self) -> None:
        # Locate the templates directory relative to this file
        base_dir = Path(__file__).resolve().parent
        self.templates_path = base_dir / "templates"
        self.env = Environment(
            loader=FileSystemLoader(str(self.templates_path)),
            autoescape=select_autoescape(["html", "xml"]),
        )
        # Ensure a local reports directory exists for fallback storage
        self.reports_dir = base_dir / "reports"
        self.reports_dir.mkdir(parents=True, exist_ok=True)

    def _render_html(self, context: dict) -> str:
        template = self.env.get_template("mrv_report.html")
        return template.render(**context)

    def _generate_ndvi_chart(self, ndvi_data, baseline_ndvi):
        """Generate a base64 encoded PNG chart of NDVI values."""
        try:
            import matplotlib.pyplot as plt
            import matplotlib.dates as mdates
            
            # Reset matplotlib to non-interactive backend
            plt.switch_backend('Agg')

            months = [datetime.strptime(d['month'], '%Y-%m') for d in ndvi_data]
            values = [d['ndvi_mean'] for d in ndvi_data]

            plt.figure(figsize=(10, 4))
            plt.plot(months, values, marker='o', color='#008080', linewidth=2)
            plt.axhline(y=baseline_ndvi, color='#ff7f0e', linestyle='--', label='Baseline')
            
            plt.title('Monthly NDVI Analysis (24 Months)')
            plt.xlabel('Month')
            plt.ylabel('NDVI Mean')
            plt.grid(True, linestyle=':', alpha=0.6)
            plt.legend()
            
            # Format x-axis dates
            plt.gca().xaxis.set_major_formatter(mdates.DateFormatter('%b %Y'))
            plt.gca().xaxis.set_major_locator(mdates.MonthLocator(interval=3))
            plt.gcf().autofmt_xdate()

            buf = io.BytesIO()
            plt.savefig(buf, format='png', bbox_inches='tight')
            plt.close()
            buf.seek(0)
            return base64.b64encode(buf.read()).decode('utf-8')
        except Exception as e:
            print(f"Chart generation failed: {e}")
            return ""

    def generate_report(self, project_id: int, score, ndvi_data, polygon_geojson):
        """Render HTML, convert to PDF, and return file paths."""
        report_id = f"MRV-{project_id}-{uuid.uuid4().hex[:8].upper()}"
        generated_at = datetime.utcnow().strftime('%d %B %Y, %H:%M UTC')
        
        # Generate chart
        ndvi_chart_b64 = self._generate_ndvi_chart(ndvi_data, score.baseline_ndvi)

        # Build a context dict for the template
        context = {
            "project_id": project_id,
            "report_id": report_id,
            "generated_at": generated_at,
            "score": score,
            "trust_score": score.trust_score,
            "confidence": score.confidence,
            "ndvi_data": ndvi_data,
            "ndvi_chart_b64": ndvi_chart_b64,
            "polygon": polygon_geojson,
        }
        html_content = self._render_html(context)

        # Write HTML to a temporary file
        html_file = self.reports_dir / f"mrv_report_{project_id}_{uuid.uuid4().hex}.html"
        html_file.write_text(html_content, encoding="utf-8")

        # Generate PDF
        pdf_file = self.reports_dir / f"mrv_report_{project_id}_{uuid.uuid4().hex}.pdf"
        HTML(string=html_content).write_pdf(target=str(pdf_file))

        return str(pdf_file), str(html_file)
