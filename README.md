# PUBG-stats
Сбор информации с PUBG API по последним играм и вывод некоторой статистики, полученной с апишки

## Запуск в Docker

Создайте `.env` на основе `.env.example` и укажите действительный `PUBG_API_KEY`, затем выполните:


https://developer.pubg.com/apps?locale=en

```bash
docker compose up --build
```

Приложение будет доступно по адресу `http://localhost:5000`.
