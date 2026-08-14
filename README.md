# SET-панчлайн тренажёр

Мобильный HTML-тренажёр (GitHub Pages) по ТЗ `ТЗ_зубной_тренажёр.md`. 7 шагов: зуб → параллельные фигуры → признание → роль (АЖ-другой/АЖ-я) → маска → панчлайн → оценка.

Статика на GitHub Pages ключ Claude API хранить не может — поэтому шаги 5 и 7 (живые вызовы Claude) идут через отдельный Cloudflare Worker-прокси, ключ лежит только там. История сессий пишется в твой Google Sheet через Apps Script Web App.

## Архитектура

```
GitHub Pages (index.html, статика)
        │  fetch (без ключа)
        ▼
Cloudflare Worker (worker/claude-proxy.js) ── ANTHROPIC_API_KEY (секрет)
        │
        ▼
   Claude API

GitHub Pages ──fetch──▶ Google Apps Script Web App (sheets/Code.gs) ──▶ твой Google Sheet
```

## Установка

### 1. Cloudflare Worker (проксирует Claude API)

Нужен аккаунт Cloudflare (бесплатный) и `wrangler` CLI:

```bash
npm install -g wrangler
cd worker
wrangler login
wrangler deploy
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put TRAINER_TOKEN
```

`TRAINER_TOKEN` — придумай любую случайную строку, она же пойдёт в `config.js`. `wrangler deploy` выведет URL вида `https://set-trainer-proxy.<твой-акк>.workers.dev` — это `WORKER_URL`.

### 2. Google Sheets (история сессий)

1. Создай новый Google Sheet.
2. Extensions → Apps Script, вставь содержимое `sheets/Code.gs`.
3. Project Settings → Script Properties → добавь `TRAINER_TOKEN` (та же строка, что и выше, можно и другую — главное чтобы совпадала с `SHEETS_TOKEN` в config.js).
4. Deploy → New deployment → тип **Web app**, Execute as: **Me**, Who has access: **Anyone**.
5. Скопируй URL веб-приложения (`.../exec`) — это `SHEETS_URL`.

### 3. config.js

Заполни `config.js` в корне репозитория:

```js
window.TRAINER_CONFIG = {
  WORKER_URL: "https://set-trainer-proxy.XXXX.workers.dev",
  WORKER_TOKEN: "тот-же-токен-что-в-wrangler-secret",
  SHEETS_URL: "https://script.google.com/macros/s/XXXX/exec",
  SHEETS_TOKEN: "тот-же-токен-что-в-script-properties",
};
```

### 4. GitHub Pages

Запушь репозиторий на GitHub, включи Pages (Settings → Pages → Deploy from branch → `main` / root). Тренажёр будет на `https://<user>.github.io/<repo>/`.

## Few-shot из CSV

Примеры из `Стычки_и_рефреймин_2 (Responses).csv` калибруют промпты шагов 5 и 7 под реальные случаи (в т.ч. паттерн самоиронии в СП-категории для АЖ-я). Они лежат в `worker/fewshot.data.js` — **этот файл в `.gitignore` и никогда не коммитится в публичный репо** (личные данные с реальными семейными деталями и матом). `worker/claude-proxy.js` импортирует из него.

- Формат/шаблон без личных данных — `worker/fewshot.data.example.js`.
- `worker/fewshot.data.js` нужен локально у тебя при каждом `wrangler deploy` (из `worker/`) — без него деплой упадёт с ошибкой импорта. Если клонируешь репо на новую машину — скопируй `fewshot.data.example.js` → `fewshot.data.js` и заполни заново (или скопируй файл напрямую, не через git).
- "Ощущения победы" из CSV откалиброваны в verdict: `сочняк! да, это оно!` → hit, `ну как бы да, или ну в общем` → partial, `не понятно/сопротивление/залупа` → miss.

## Открытые решения (зафиксированы по обсуждению)

- Шаг 7 — только текстовый разбор (без числового индикатора уверенности).
- История — в Google Sheets (не localStorage), см. выше.
- CSV-данные — только few-shot в промпте, тренажёр не дописывает туда новые записи автоматически.
