FROM python:3.11-slim

# Install curl as required by the app
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application files (see .dockerignore)
COPY . .

CMD ["python", "app.py"]
