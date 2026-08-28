// Vercel Edge Function — Claude API 專用端點（非透傳）
//
// 這支端點刻意「只能做一件事」：跑文章摘要解析與翻譯。
// 模型與 max_tokens 由伺服器決定，呼叫方只能從白名單選「用途」——
// 即使端點被濫用，單次成本也有固定天花板。
//
// 2026-08-27 補上存取控制。原因：在此之前這支端點是「匿名可用的 Claude 代理」——
// 任何人只要知道網址就能用本站的 API key 跑 sonnet-5，實測 curl 無憑證即可打通，
// 且沒有任何 log，用量燒光了才會從帳單發現。
// 單次成本上限擋的是「一次燒多少」，擋不住「誰能用、用幾次」。
export const config = { runtime: 'edge' };

// 前端只能指定「用途」，不能指定模型名稱——維持釘死的性質。
// 兩個選項都是已知成本的模型，共用同一個 max_tokens 上限，
// 所以這個白名單不會放大濫用風險（haiku 反而更便宜）。
const MODELS = {
  analyze:   'claude-sonnet-5',    // Step 1：萃取與判斷，需要理解力
  translate: 'claude-haiku-4-5',   // Step 2：翻譯，較機械，成本約三分之一
};
const DEFAULT_TIER   = 'analyze';
const MAX_TOKENS_CAP = 16000;               // 輸出硬上限
const MAX_BODY_BYTES = 1000000;             // 輸入硬上限（正常文章遠低於此）

/** 允許的來源。preview 部署網址每次不同，所以用前後綴比對而非白名單列舉。 */
function isAllowedOrigin(origin) {
  try {
    const u = new URL(origin);
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
    if (u.protocol !== 'https:') return false;
    return u.hostname.startsWith('academic-share') && u.hostname.endsWith('.vercel.app');
  } catch { return false; }
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin':  origin && isAllowedOrigin(origin) ? origin : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary':                         'Origin',
  };
}

const json = (obj, status, origin) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });

export default async function handler(req) {
  const origin = req.headers.get('origin');
  const ip     = req.headers.get('x-forwarded-for') || 'unknown';
  const log = (result, extra = {}) =>
    console.log(JSON.stringify({ ep: 'claude', result, origin: origin || null, ip, ...extra }));

  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders(origin) });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405, origin);

  // ── 存取控制 ──────────────────────────────────────────────
  // 2026-08-28 依需求移除通行碼，改以來源為唯一門檻，讓使用者不必輸入任何東西。
  // 瀏覽器對 POST 一律會帶 Origin（同源也會），所以「缺 Origin」代表不是瀏覽器發的，
  // 直接擋掉——這能攔住絕大多數不解析網頁、直接打端點的自動掃描腳本。
  // 擋不住存心偽造 Origin 的人；這是刻意接受的取捨，換取零輸入的使用體驗。
  if (!origin || !isAllowedOrigin(origin)) {
    log('denied_origin');
    return json({ error: '來源不允許' }, 403, origin);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY not set' }, 500, origin);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    log('too_large', { bytes: raw.length });
    return json({ error: '請求內容過長' }, 413, origin);
  }

  let input;
  try { input = JSON.parse(raw); } catch { return json({ error: '請求格式錯誤' }, 400, origin); }
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    return json({ error: 'messages 格式錯誤' }, 400, origin);
  }

  const maxTokens = Math.min(Number(input.max_tokens) || 4096, MAX_TOKENS_CAP);
  // 只接受白名單內的用途字串，其餘一律退回預設
  const tier  = Object.prototype.hasOwnProperty.call(MODELS, input.tier) ? input.tier : DEFAULT_TIER;
  const model = MODELS[tier];
  log('allowed', { bytes: raw.length, maxTokens, tier });

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream:     true,
      system:     typeof input.system === 'string' ? input.system : undefined,
      messages:   input.messages,
    }),
  });

  if (!upstream.ok) log('upstream_error', { status: upstream.status });

  return new Response(upstream.body, {
    status:  upstream.status,
    headers: { ...corsHeaders(origin), 'Content-Type': upstream.headers.get('Content-Type') || 'text/event-stream' },
  });
}
