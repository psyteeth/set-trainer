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

// Few-shot из личных данных (CSV "Стычки и рефрейминг") живёт в отдельном
// файле, который НЕ коммитится в git (см. .gitignore в корне репо) — только
// локально у тебя и в задеплоенном Worker'е. worker/fewshot.data.example.js
// показывает формат без личных данных.
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

async function callClaude(env, system, userText) {
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
  return textBlock.text;
}

function extractJson(text) {
  // Модель просят вернуть чистый JSON, но на всякий случай вырезаем блок { ... }
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Не удалось разобрать ответ модели как JSON.");
  return JSON.parse(match[0]);
}

async function handleMask(env, body) {
  const { tooth, figures, role, userGuess } = body;

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

Ответь СТРОГО в формате JSON без markdown-обрамления:
{"mask": "название маски", "inversion": "инверсия/больное место под маской", "reasoning": "2-4 предложения — почему именно эта маска, на основе конкретики из текста пользователя"}`;

  const userText = `Зуб (точка входа, шаг 1):
${tooth}

Параллельные фигуры (шаг 2):
${buildFigures(figures)}

Роль (шаг 4): ${role === "aj-other" ? "АЖ-другой (моё поведение должно подстроиться)" : "АЖ-я (другой должен подстроиться под меня)"}
${userGuess ? `\nСобственная догадка пользователя о маске (учти, но не следуй слепо): ${userGuess}` : ""}`;

  const raw = await callClaude(env, system, userText);
  const parsed = extractJson(raw);
  return { mask: parsed.mask, inversion: parsed.inversion, reasoning: parsed.reasoning };
}

async function handlePunchline(env, body) {
  const { tooth, figures, role, mask, inversion, punchline } = body;

  const fewshotBlock = FEWSHOT_PUNCHLINE.length
    ? "\n\nПримеры (few-shot, реальные случаи):\n" +
      FEWSHOT_PUNCHLINE.map(
        (e) =>
          `Контекст: ${e.context}\nМаска/инверсия: ${e.mask} / ${e.inversion}\nПанчлайн: "${e.punchline}"\nВердикт: ${e.verdict}\nПочему: ${e.explanation}`
      ).join("\n\n")
    : "";

  const system = `Ты — ассистент психологического тренажёра "SET-панчлайн". Твоя задача — оценить, попал ли SET-панчлайн пользователя в инверсию (больное место) распознанной маски, или ударил мимо.

Правила оценки:
- АЖ-другой: панчлайн должен деидеализировать МАСКУ ФИГУРЫ — бить в конкретную инверсию, не по личности целиком и не "надменным презрением".
- АЖ-я: панчлайн должен быть самоиронией над СОБСТВЕННОЙ маской/манёвром пользователя (пример калибровки: "ебать я упиваюсь своим превосходством" — попадание; общее рассуждение о ситуации без иронии над собой — мимо).
- Попадание = точный удар в названную инверсию. Мимо = удар по личности целиком, по случайной характеристике, общие слова, или явный обход (интеллектуализация вместо удара).

Ответь СТРОГО в формате JSON без markdown-обрамления:
{"verdict": "hit" | "miss" | "partial", "explanation": "содержательный разбор в 3-6 предложений: попал или нет и почему именно, без баллов и чек-листов — живой разбор"}`;

  const userText = `Зуб: ${tooth}

Фигуры:
${buildFigures(figures)}

Роль: ${role === "aj-other" ? "АЖ-другой" : "АЖ-я"}
Распознанная маска: ${mask}
Инверсия (больное место): ${inversion}

Панчлайн пользователя: "${punchline}"`;

  const raw = await callClaude(env, system, userText);
  const parsed = extractJson(raw);
  return { verdict: parsed.verdict, explanation: parsed.explanation };
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

      return json({ error: "not found" }, 404, origin);
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 500, origin);
    }
  },
};
