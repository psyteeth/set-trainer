/**
 * SET-панчлайн тренажёр — Cloudflare Worker proxy к Claude API.
 *
 * Держит ANTHROPIC_API_KEY в секрете (wrangler secret), фронт на GitHub Pages
 * шлёт сюда только контекст сессии — сам ключ клиенту никогда не виден.
 *
 * Секреты (wrangler secret put ...):
 *   ANTHROPIC_API_KEY  — ключ Anthropic API
 *   TRAINER_TOKEN      — произвольная строка, тот же на фронте (config.js), защита от чужих вызовов
 *
 * Роуты:
 *   POST /api/mask       — шаг 5: распознавание маски
 *   POST /api/punchline  — шаг 7: оценка попадания панчлайна
 */

// Few-shot из CSV "Стычки и рефрейминг" — куратированная выборка, формат см.
// worker/fewshot.data.example.js.
import { FEWSHOT_MASK, FEWSHOT_PUNCHLINE } from "./fewshot.data.js";

const MODEL = "claude-opus-5";
const ANTHROPIC_VERSION = "2023-06-01";

const MASK_TAXONOMY = `
| Маска | Инверсия (больное место под ней) |
|---|---|
| Значимость | ничтожность |
| Сила/Власть | бессилие, слабость |
| Хорошесть/Правильность | плохость, порочность |
| Жертва-старательница | бесполезность стараний, никто не оценит |
| Нужность | ненужность, брошенность |
| Интеллект | тупость |
`;

// Типология SET-панчлайнов, выведенная на 7 зубах личного материала (см.
// "резюме_сепарация_АЖ_СП.md" §8). Ортогональна hit/miss/partial — это ЧТО
// за тип удара, а не попал ли он. Категория 5 — намеренно помечается отдельным
// предупреждением, не хвалится как финальная цель раунда (риск закрепления
// новой формы самообесценивания вместо освобождения от паттерна).
const PUNCHLINE_TYPOLOGY = `
0. Сырое называние триггера — называет, что задело, без панчлайна как такового (предшествует панчлайну, не победа сама по себе).
1. Контр-SET к АЖ — статусный разворот угрозы в ответ на фигуру (легитимный ранний этап после долгого подчинения/заморозки).
1b. Аннигиляционная ярость — усиленный контр-SET: бьёт не по статусу, а по праву фигуры на существование, интенсивнее и архаичнее категории 1.
2. Самоирония/fogging — мишень свой сиюминутный реактивный импульс, назван с юмором; не обвиняет другого. Включает fogging (Manuel Smith) — согласие/усиление критики, чтобы лишить её силы.
3. Точка Б / прямое называние потребности — вне игры статуса вообще; самый зрелый тип, прямой запрос или удержание себя в желаемом без борьбы за оценку.
4. Калибровка масштаба — высмеивание непропорциональности своей реакции на СП относительно реального масштаба вреда от АЖ ("АЖ ждёшь всю жизнь, а тут 2 минуты СП подождать жалко").
5. SET к собственной исторической стратегии выживания — жёстче категории 2: мишень не сиюминутный импульс, а сам паттерн угодничества/подчинения как стратегия целиком, ретроспективный приговор ("я всегда была тряпкой"). РИСКОВАННАЯ категория — может закрепиться как новая форма самообесценивания вместо освобождения от паттерна.
`;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Trainer-Token",
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin) },
  });
}

function buildFigures(figures) {
  return (figures || [])
    .map((f, i) => `${i + 1}. ${f.who}: ${f.what}`)
    .join("\n");
}

// "Ядерная психологическая нагрузка" — необязательная прямая цитата
// внутреннего голоса, введённая на шаге 1 (ТЗ_ядерная_нагрузка_вход.md).
// Не сама ситуация — убеждение, которое срабатывает. Передаём как
// дополнительный контекст всем трём эндпойнтам, когда заполнено: обычно
// прямо называет инверсию раньше, чем модель её выведет из ситуации.
function nuclearLoadLine(nuclearLoad) {
  return nuclearLoad && nuclearLoad.trim()
    ? `\n\nЯдерная психологическая нагрузка (внутренний голос пользователя, прямая цитата): "${nuclearLoad.trim()}"`
    : "";
}

const MASK_SCHEMA = {
  type: "object",
  properties: {
    mask: { type: "string" },
    inversion: { type: "string" },
    reasoning: { type: "string" },
  },
  required: ["mask", "inversion", "reasoning"],
  additionalProperties: false,
};

const HINT_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: ["0", "1", "1b", "2", "3", "4", "5"] },
    direction: { type: "string" },
  },
  required: ["category", "direction"],
  additionalProperties: false,
};

const PUNCHLINE_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["hit", "miss", "partial"] },
    category: {
      anyOf: [
        { type: "string", enum: ["0", "1", "1b", "2", "3", "4", "5"] },
        { type: "null" },
      ],
    },
    explanation: { type: "string" },
    caution: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["verdict", "category", "explanation", "caution"],
  additionalProperties: false,
};

// Structured outputs (output_config.format) — the API guarantees the response
// text is valid JSON matching the schema. Before this, we asked the model to
// "respond in JSON" via prompt instructions and hand-parsed the text with a
// regex + JSON.parse; an unescaped quote or stray character in the model's
// own prose (e.g. quoting the user's punchline) would break that parse and
// surface as "Не удалось оценить панчлайн: Expected ',' or '}' ...". Schema
// enforcement removes that whole failure class.
async function callClaude(env, system, userText, schema) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system,
      messages: [{ role: "user", content: userText }],
      output_config: { format: { type: "json_schema", schema } },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  if (data.stop_reason === "refusal") {
    throw new Error("Модель отказалась отвечать (refusal). Переформулируй ввод.");
  }
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("Пустой ответ модели.");
  return JSON.parse(textBlock.text);
}

async function handleMask(env, body) {
  const { tooth, figures, role, userGuess, nuclearLoad } = body;

  const fewshotBlock = FEWSHOT_MASK.length
    ? "\n\nПримеры (few-shot, реальные случаи):\n" +
      FEWSHOT_MASK.map((e) => `Контекст: ${e.context}\nМаска: ${e.mask} → инверсия: ${e.inversion}`).join("\n\n")
    : "";

  const system = `Ты — ассистент психологического тренажёра "SET-панчлайн" (зубной тренажёр). Твоя единственная задача на этом шаге — распознать защитную МАСКУ и её инверсию (больное место под маской) по описанию ситуации пользователя.

Роль в сессии определена так:
- АЖ-другой: моё поведение должно подстроиться под фигуру → распознаём маску ФИГУРЫ (чего она добивается, что защищает).
- АЖ-я: другой должен подстроиться под меня → распознаём СВОЮ маску, которую пользователь скрывает за требованием к другому.

Таксономия-ориентир (не жёсткий классификатор, можно называть маску свободно, если она точнее описывает случай):
${MASK_TAXONOMY}
${fewshotBlock}

Если во входе есть «Ядерная психологическая нагрузка» — это прямая цитата пользователя, обычно уже в форме «оценка происходящего — ущербный вывод о себе» (например: «она на меня плюёт — я ничтожество»). Вторая половина после тире — почти готовая инверсия в разговорной форме. Используй её как сильный якорь: итоговое поле "inversion" должно быть согласовано с ней по смыслу (можно переформулировать точнее термином из таксономии, но не игнорировать и не уводить в другую тему).

Поле "reasoning" — 2-4 предложения, почему именно эта маска, на основе конкретики из текста пользователя.`;

  const userText = `Зуб (точка входа, шаг 1):
${tooth}

Параллельные фигуры (шаг 2):
${buildFigures(figures)}

Роль (шаг 4): ${role === "aj-other" ? "АЖ-другой (моё поведение должно подстроиться)" : "АЖ-я (другой должен подстроиться под меня)"}
${userGuess ? `\nСобственная догадка пользователя о маске (учти, но не следуй слепо): ${userGuess}` : ""}${nuclearLoadLine(nuclearLoad)}`;

  const parsed = await callClaude(env, system, userText, MASK_SCHEMA);
  return { mask: parsed.mask, inversion: parsed.inversion, reasoning: parsed.reasoning };
}

async function handlePunchline(env, body) {
  const { tooth, figures, role, mask, inversion, punchline, nuclearLoad } = body;

  const fewshotBlock = FEWSHOT_PUNCHLINE.length
    ? "\n\nПримеры (few-shot, реальные случаи):\n" +
      FEWSHOT_PUNCHLINE.map(
        (e) =>
          `Контекст: ${e.context}\nМаска/инверсия: ${e.mask} / ${e.inversion}\nПанчлайн: "${e.punchline}"\nВердикт: ${e.verdict}${e.category ? `\nКатегория: ${e.category}` : ""}${e.caution ? `\nПредупреждение: ${e.caution}` : ""}\nПочему: ${e.explanation}`
      ).join("\n\n")
    : "";

  const system = `Ты — ассистент психологического тренажёра "SET-панчлайн". Твоя задача — оценить, попал ли SET-панчлайн пользователя в инверсию (больное место) распознанной маски, или ударил мимо, и дополнительно классифицировать его тип.

Правила оценки попадания:
- АЖ-другой: панчлайн должен деидеализировать МАСКУ ФИГУРЫ — бить в конкретную инверсию, не по личности целиком и не "надменным презрением".
- АЖ-я: панчлайн должен быть самоиронией над СОБСТВЕННОЙ маской/манёвром пользователя (пример калибровки: "ебать я упиваюсь своим превосходством" — попадание; общее рассуждение о ситуации без иронии над собой — мимо).
- Попадание = точный удар в названную инверсию. Мимо = удар по личности целиком, по случайной характеристике, общие слова, или явный обход (интеллектуализация вместо удара).

Дополнительно классифицируй панчлайн по этой типологии (одна категория, наиболее подходящая; если ничего не подходит ярко — null):
${PUNCHLINE_TYPOLOGY}
Если категория "5" — это ВАЖНО отметить отдельным предупреждением в поле "caution": риск, что жёсткость к себе закрепится как новая форма самообесценивания, а не как освобождение от паттерна. Не хвали категорию 5 как финальную цель раунда. Для всех остальных категорий (включая null) поле "caution" — null.

Поле "explanation" — содержательный разбор в 3-6 предложений: попал или нет и почему именно, без баллов и чек-листов — живой разбор.`;

  const userText = `Зуб: ${tooth}

Фигуры:
${buildFigures(figures)}

Роль: ${role === "aj-other" ? "АЖ-другой" : "АЖ-я"}
Распознанная маска: ${mask}
Инверсия (больное место): ${inversion}${nuclearLoadLine(nuclearLoad)}

Панчлайн пользователя: "${punchline}"`;

  const parsed = await callClaude(env, system, userText, PUNCHLINE_SCHEMA);
  return {
    verdict: parsed.verdict,
    explanation: parsed.explanation,
    category: parsed.category || null,
    caution: parsed.caution || null,
  };
}

async function handleHint(env, body) {
  const { tooth, figures, role, mask, inversion, nuclearLoad } = body;

  const system = `Ты — ассистент психологического тренажёра "SET-панчлайн". Пользователь просит подсказку НАПРАВЛЕНИЯ удара перед тем, как сам(а) сформулирует панчлайн — сам панчлайн придумывает пользователь, не ты.

Правило мишени, ОБЯЗАТЕЛЬНО согласованное с тем, как потом будет оцениваться попадание:
- АЖ-другой: удар должен деидеализировать МАСКУ ФИГУРЫ — мишень фигура, не сам пользователь. Категории 1, 1b, 4 сюда подходят напрямую; категория 2 (самоирония) подходит только если направление явно указывает бить по маске фигуры, а не по своему импульсу.
- АЖ-я: удар должен быть самоиронией пользователя над СОБСТВЕННОЙ маской/манёвром — мишень сам пользователь. Категории 2, 5 сюда подходят; категория 5 указывай с осторожностью (см. ниже).

Типология типов удара:
${PUNCHLINE_TYPOLOGY}

Если во входе есть «Ядерная психологическая нагрузка» — её вторая половина (после тире) обычно называет ущербный вывод о себе, то есть почти готовую формулировку инверсии. Направление удара должно целить именно туда, а не в другую тему, даже если распознанная инверсия сформулирована другими словами.

Задача: выбрать одну наиболее подходящую категорию для этой ситуации (с учётом правила мишени выше) и дать направление — на что именно целиться и какого характера должен быть удар (жанр, мишень, тон), в 1-2 предложения.

ЖЁСТКОЕ ПРАВИЛО: НЕ пиши сам панчлайн и не давай конкретных фраз, реплик или готовых формулировок, которые можно скопировать и произнести как есть. Только направление и характер — пользователь сам подбирает слова. Если категория "5" — упомяни в направлении, что это рискованный тип (не финальная цель раунда).`;

  const userText = `Зуб: ${tooth}

Фигуры:
${buildFigures(figures)}

Роль: ${role === "aj-other" ? "АЖ-другой" : "АЖ-я"}
Распознанная маска: ${mask}
Инверсия (больное место): ${inversion}${nuclearLoadLine(nuclearLoad)}`;

  const parsed = await callClaude(env, system, userText, HINT_SCHEMA);
  return { category: parsed.category, direction: parsed.direction };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);

    if (env.TRAINER_TOKEN) {
      const token = request.headers.get("X-Trainer-Token");
      if (token !== env.TRAINER_TOKEN) {
        return json({ error: "unauthorized" }, 401, origin);
      }
    }

    try {
      let body = {};
      if (request.method === "POST") {
        body = await request.json();
      }

      if (url.pathname === "/api/mask" && request.method === "POST") {
        return json(await handleMask(env, body), 200, origin);
      }
      if (url.pathname === "/api/punchline" && request.method === "POST") {
        return json(await handlePunchline(env, body), 200, origin);
      }
      if (url.pathname === "/api/hint" && request.method === "POST") {
        return json(await handleHint(env, body), 200, origin);
      }

      return json({ error: "not found" }, 404, origin);
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 500, origin);
    }
  },
};
