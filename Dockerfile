FROM python:3.11-slim

# Install curl as required by the app
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Flush print() output straight to `docker logs`
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application files (see .dockerignore)
COPY . .

# One worker process only: the portfolio lock and price caches live in process memory,
# so extra workers would each have their own and could overwrite each other's saves.
# Threads still let requests run concurrently.
CMD ["gunicorn", "--workers", "1", "--threads", "8", "--timeout", "120", \
     "--bind", "0.0.0.0:5050", "--access-logfile", "-", "app:app"]
