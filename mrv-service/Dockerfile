# Production Dockerfile for NEVARA MRV Service
FROM python:3.11-slim

# Install system dependencies for WeasyPrint and Postgres
RUN apt-get update && apt-get install -y \
    python3-pip \
    python3-setuptools \
    python3-wheel \
    python3-cffi \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libgdk-pixbuf2.0-0 \
    libffi-dev \
    shared-mime-info \
    libpq-dev \
    gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create reports directory
RUN mkdir -p reports

# Expose the service port
EXPOSE 8001

# Default command runs the API
# For workers, the command should be overridden to 'python worker.py'
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
