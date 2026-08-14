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
    explanation: `Почему именно так — короткое обоснование для калибровки модели.`,
  },
];
