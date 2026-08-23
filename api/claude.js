// Vercel Edge Function — Claude API 專用端點（非透傳）
//
// 這支端點刻意「只能做一件事」：跑文章摘要解析。
// model 與 max_tokens 由伺服器決定，呼叫方無法指定——
// 即使端點被匿名濫用，單次成本也有固定天花板，
// 不會出現「對方自帶 Opus 5 開 128K 輸出」把額度一次燒光的情況。
export const config = { runtime: 'edge' };

const MODEL          = 'claude-sonnet-5';   // 釘死，前端不能覆寫
const MAX_TOKENS_CAP = 16000;               // 輸出硬上限
const MAX_BODY_BYTES = 1000000;             // 輸入硬上限（正常文章遠低於此）

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (obj, status) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY not set' }, 500);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: '請求內容過長' }, 413);

  let input;
  try { input = JSON.parse(raw); } catch { return json({ error: '請求格式錯誤' }, 400); }
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    return json({ error: 'messages 格式錯誤' }, 400);
  }

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: Math.min(Number(input.max_tokens) || 4096, MAX_TOKENS_CAP),
      stream:     true,
      system:     typeof input.system === 'string' ? input.system : undefined,
      messages:   input.messages,
    }),
  });

  return new Response(upstream.body, {
    status:  upstream.status,
    headers: { ...CORS, 'Content-Type': upstream.headers.get('Content-Type') || 'text/event-stream' },
  });
}
