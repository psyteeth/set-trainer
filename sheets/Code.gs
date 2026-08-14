/**
 * SET-панчлайн тренажёр — логирование истории в Google Sheets.
 *
 * Установка (см. README.md в этой папке):
 *  1. Создать Google Sheet, открыть Extensions → Apps Script, вставить этот файл.
 *  2. Project Settings → Script Properties → добавить TRAINER_TOKEN (любая строка).
 *  3. Deploy → New deployment → Web app, Execute as: Me, Who has access: Anyone.
 *  4. Скопировать URL веб-приложения в config.js (SHEETS_URL) вместе с тем же
 *     токеном (SHEETS_TOKEN).
 */

const SHEET_NAME = "История";
const HEADERS = [
  "Время",
  "Зуб",
  "Фигуры (кто / что делает)",
  "Роль (АЖ-другой/АЖ-я)",
  "Маска",
  "Инверсия",
  "Панчлайн",
  "Вердикт",
];

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
  }
  return sheet;
}

function checkToken_(token) {
  const expected = PropertiesService.getScriptProperties().getProperty("TRAINER_TOKEN");
  if (!expected) return true; // токен не настроен — доступ открыт (не рекомендуется)
  return token === expected;
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || "{}");
    if (!checkToken_(body.token)) {
      return jsonOut_({ error: "unauthorized" });
    }

    const sheet = getSheet_();
    const figuresText = (body.figures || [])
      .map((f) => `${f.who}: ${f.what}`)
      .join(" | ");

    sheet.appendRow([
      new Date(),
      body.tooth || "",
      figuresText,
      body.role === "aj-other" ? "АЖ-другой" : "АЖ-я",
      body.mask || "",
      body.inversion || "",
      body.punchline || "",
      body.verdict || "",
    ]);

    return jsonOut_({ ok: true });
  } catch (err) {
    return jsonOut_({ error: String(err) });
  }
}

function doGet(e) {
  try {
    const token = e.parameter.token;
    if (!checkToken_(token)) {
      return jsonOut_({ error: "unauthorized" });
    }

    const sheet = getSheet_();
    const values = sheet.getDataRange().getValues();
    const rows = values.slice(1); // без заголовка

    // Только сводка для отображения прогресса — не вся история целиком.
    const summary = rows.map((r) => ({
      time: r[0],
      tooth: r[1],
      role: r[3],
      mask: r[4],
      verdict: r[7],
    }));

    return jsonOut_({ ok: true, count: summary.length, sessions: summary });
  } catch (err) {
    return jsonOut_({ error: String(err) });
  }
}
