FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=5000

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY pubg.py screenshot_recognition.py ./
COPY templates ./templates
COPY static ./static
COPY terrain ./terrain

RUN addgroup --system app && adduser --system --ingroup app --no-create-home app
USER app

EXPOSE 5000

CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "2", "--access-logfile", "-", "pubg:app"]
