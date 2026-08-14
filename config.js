// ЗАПОЛНИ ПОСЛЕ ДЕПЛОЯ WORKER'А И APPS SCRIPT (см. README.md)
window.TRAINER_CONFIG = {
  // URL твоего Cloudflare Worker (шаг 5/7, вызовы Claude API)
  // пример: "https://set-trainer-proxy.твой-акк.workers.dev"
  WORKER_URL: "https://set-trainer-proxy.rfwwt5v2c7.workers.dev",

  // Тот же токен, что ты положил в Worker (wrangler secret put TRAINER_TOKEN)
  WORKER_TOKEN: "UmEnYaRaStUtZyBy32",

  // URL твоего Google Apps Script Web App (хранение истории в Sheets)
  // пример: "https://script.google.com/macros/s/XXXXX/exec"
  SHEETS_URL: "https://script.google.com/macros/s/AKfycbzmO6rDVhfSE7JjStuzpDFOiqRjlWGvQr9VRXtwhTEm3n2TLslTddSfbcyANjobOuOt/exec",

  // Тот же токен, что ты положил в Apps Script Script Properties (TRAINER_TOKEN)
  SHEETS_TOKEN: "UmEnYaRaStUtZyBy32"
};
