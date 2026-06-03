export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }), { status: 500 });
  }

  const { documentText, analysisGoal } = await req.json();

  if (!documentText || documentText.trim().length < 50) {
    return new Response(JSON.stringify({ error: '文件內容太短，無法分析' }), { status: 400 });
  }

  const systemPrompt = `你是一位資深商業盡職調查顧問，服務對象為集團大股東及董事會成員。
你的任務是根據所提供的文件，從法律、公司經營、財務三個專業面向進行深入分析。
請以嚴謹、專業的繁體中文撰寫，語氣如頂級法律事務所或顧問公司出具的正式報告。
每個面向必須包含：風險等級評估（高/中/低）、主要發現（條列式）、詳細分析、具體建議行動。`;

  const userContent = `分析目標：${analysisGoal?.trim() || '全面評估此文件對大股東的影響與潛在風險'}

請嚴格按照以下格式輸出完整分析報告（使用 Markdown）：

## 法律面分析

**風險等級：** [高 / 中 / 低]

**主要發現：**
- [發現 1]
- [發現 2]

**詳細分析：**
[法律風險、合規狀況、合約條款審查、股東權益保障等詳細說明，至少 150 字]

**建議行動：**
- [行動 1]
- [行動 2]

---

## 公司經營面分析

**風險等級：** [高 / 中 / 低]

**主要發現：**
- [發現 1]
- [發現 2]

**詳細分析：**
[公司治理結構、管理層品質、營運策略、市場競爭地位等詳細說明，至少 150 字]

**建議行動：**
- [行動 1]
- [行動 2]

---

## 財務面分析

**風險等級：** [高 / 中 / 低]

**主要發現：**
- [發現 1]
- [發現 2]

**詳細分析：**
[財務健康狀況、資本結構、獲利能力、現金流管理等詳細說明，至少 150 字]

**建議行動：**
- [行動 1]
- [行動 2]

---

## 執行摘要

[針對大股東決策所需，提供 200-300 字的整體評估結論，包含最優先處理的風險事項與具體行動建議]

---

待分析文件：

${documentText}`;

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 4096,
      stream: true,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'text/event-stream',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
