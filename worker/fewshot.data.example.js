// Шаблон формата few-shot данных. Скопируй в fewshot.data.js (этот файл в
// .gitignore, не коммитится) и заполни своими примерами из CSV.

export const FEWSHOT_MASK = [
  {
    context: `[АЖ-другой или АЖ-я] Краткое описание ситуации + рефрейминг/фраза манипуляции.`,
    mask: `Значимость`,
    inversion: `ничтожность`,
  },
];

export const FEWSHOT_PUNCHLINE = [
  {
    context: `Краткое описание ситуации + рефрейминг.`,
    mask: `Значимость`,
    inversion: `ничтожность`,
    punchline: `Текст панчлайна`,
    verdict: `hit`, // "hit" | "partial" | "miss"
    category: `2`, // "0" | "1" | "1b" | "2" | "3" | "4" | "5" | null — см. типологию в worker/claude-proxy.js
    caution: null, // текст предупреждения, только если category="5", иначе null
    explanation: `Почему именно так — короткое обоснование для калибровки модели.`,
  },
];
