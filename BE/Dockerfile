# Build from project root: docker build -f BE/Dockerfile .

# ── Build stage ───────────────────────────────────────────────────────────────
FROM python:3.12-slim AS builder

WORKDIR /app

COPY BE/requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM python:3.12-slim

WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /install /usr/local

# Copy backend source
COPY BE/ ./BE/

# Copy src/data_sources.py (imported by BE at runtime)
COPY src/data_sources.py ./src/data_sources.py

# Create the data directory for SQLite (ephemeral on Cloud Run)
RUN mkdir -p ./data

# Expose port (Cloud Run injects PORT=8080 at runtime)
ENV PORT=8080
EXPOSE 8080

# Run uvicorn directly (no reload in prod)
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT} --app-dir /app/BE"]
