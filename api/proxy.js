// Vercel Serverless Function — 字卡上傳（Vercel Blob）+ LINE 推播 + Sheets 記錄
//
// 圖床從 litterbox.catbox.moe 換成 Vercel Blob，原因見 2026-08-23 的生產錯誤紀錄：
// litterbox 是免費匿名圖床、無 SLA，間歇回傳 HTML 格式的 500 錯誤頁，
// 7 天內造成 4 次推播全失敗（8/17、8/18、8/19、8/21）。
// 舊版沒有重試也沒有逾時，且用 Promise.all 全有全無——一張圖失敗，兩張都不送。
//
// 本版三項改變：
//   1. 改用 Vercel Blob（永久保存，解決 litterbox 72 小時過期造成的破圖）
//   2. 上傳加重試與逾時
//   3. 改用 allSettled：一張失敗仍會把另一張送出去，而不是整包放棄
import { put } from '@vercel/blob';

// 2026-08-27：補上存取控制。在此之前這支端點是 CORS '*' 且無驗證——
// 任何人都能往本站的 Vercel Blob 塞圖片，並觸發 LINE 推播洗版。
// 收件人是寫死的環境變數，所以外人無法指定收件對象，但濫用成本仍由本站承擔。
function isAllowedOrigin(origin) {
  try {
    const u = new URL(origin);
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
    if (u.protocol !== 'https:') return false;
    return u.hostname.startsWith('academic-share') && u.hostname.endsWith('.vercel.app');
  } catch { return false; }
}

export const config = {
  api: { bodyParser: { sizeLimit: '16mb' } },
};

const UPLOAD_TRIES   = 3;
const UPLOAD_TIMEOUT = 12000;

/** 指數退避重試 */
async function withRetry(fn, label, tries = UPLOAD_TRIES) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      console.warn(`[${label}] 第 ${i + 1}/${tries} 次失敗：${e.message}`);
      if (i < tries - 1) await new Promise(r => setTimeout(r, 400 * 2 ** i));
    }
  }
  throw new Error(`${label} 連續 ${tries} 次失敗：${last?.message || last}`);
}

/** 上傳一張字卡到 Vercel Blob，回傳公開網址 */
async function uploadCard(base64, mimeType, kind) {
  const buf  = Buffer.from(base64, 'base64');
  const day  = new Date().toISOString().slice(0, 10);
  const name = `cards/${day}/${kind}.jpg`;
  return withRetry(async () => {
    const { url } = await put(name, buf, {
      access:          'public',
      contentType:     mimeType || 'image/jpeg',
      addRandomSuffix: true,
      abortSignal:     AbortSignal.timeout(UPLOAD_TIMEOUT),
    });
    if (!url) throw new Error('Blob 未回傳網址');
    return url;
  }, `上傳${kind}`);
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  const ip     = req.headers['x-forwarded-for'] || 'unknown';
  const log = (result, extra = {}) =>
    console.log(JSON.stringify({ ep: 'proxy', result, origin: origin || null, ip, ...extra }));

  res.setHeader('Access-Control-Allow-Origin', origin && isAllowedOrigin(origin) ? origin : 'null');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── 存取控制（與 api/claude.js 同一把通行碼）──────────────
  // 2026-08-28 依需求移除通行碼，改以來源為唯一門檻，讓使用者不必輸入任何東西。
  // 瀏覽器對 POST 一律會帶 Origin（同源也會），所以「缺 Origin」代表不是瀏覽器發的。
  if (!origin || !isAllowedOrigin(origin)) {
    log('denied_origin');
    return res.status(403).json({ error: '來源不允許' });
  }
  log('allowed');

  const lineToken  = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const lineUserId = process.env.LINE_TARGET_USER_ID;
  if (!lineToken || !lineUserId) {
    return res.status(500).json({ error: 'LINE env vars not set' });
  }

  async function linePush(to, messages) {
    const r = await fetch('https://api.line.me/v2/bot/message/push', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${lineToken}` },
      body:    JSON.stringify({ to, messages }),
      signal:  AbortSignal.timeout(UPLOAD_TIMEOUT),
    });
    if (!r.ok) throw new Error(`LINE API ${r.status}: ${await r.text()}`);
    return r;
  }

  function writeSheets(payload) {
    const sheetsUrl = process.env.SHEETS_WEBHOOK_URL;
    if (!sheetsUrl) return;
    fetch(sheetsUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' },
      body:    JSON.stringify(payload),
    }).catch(() => {});
  }

  try {
    const {
      imageBase64, imageSummaryBase64, imageFullBase64,
      mimeType = 'image/jpeg',
      title, url, imageUrl: reuseUrl, _resend, _test,
      mode, titleZh, titleOrig, source, date, abstract, keyPoints, editorial,
    } = req.body;

    // ── 純文字連線測試 ──
    if (_test) {
      await linePush(lineUserId, [{ type: 'text', text: title || '木木人AI 連線測試 ✅' }]);
      return res.status(200).json({ ok: true, message: 'test ok' });
    }

    const doiUrl = url ? (url.startsWith('http') ? url : `https://doi.org/${url}`) : '';
    const textMsg = (title || doiUrl)
      ? { type: 'text', text: [title ? `📄 ${title}` : '', doiUrl ? `\n🔗 ${doiUrl}` : ''].join('') }
      : null;

    // ── 雙圖模式（摘要字卡 + 全文版）──
    if (imageSummaryBase64 && imageFullBase64) {
      const settled = await Promise.allSettled([
        uploadCard(imageSummaryBase64, mimeType, 'summary'),
        uploadCard(imageFullBase64,    mimeType, 'full'),
      ]);

      const urls = settled.map(s => (s.status === 'fulfilled' ? s.value : null));
      const failed = settled.filter(s => s.status === 'rejected').map(s => s.reason?.message || String(s.reason));

      if (!urls.some(Boolean)) {
        console.error('兩張圖片皆上傳失敗', failed);
        return res.status(502).json({ error: '圖片上傳失敗，兩張都沒成功：' + failed.join(' / ') });
      }

      const msgs = urls.filter(Boolean)
        .map(u => ({ type: 'image', originalContentUrl: u, previewImageUrl: u }));
      if (textMsg) msgs.push(textMsg);

      await linePush(lineUserId, msgs);

      // 'both' 模式：abstract + keyPoints 以 \n\n---\n 分隔，供 search 頁重新產生兩張
      const kpText  = Array.isArray(keyPoints) && keyPoints.length > 0
        ? keyPoints.map((p, i) => `${i + 1}. ${p}`).join('\n') : '';
      const absText = abstract || editorial || '';
      const bodyText = absText && kpText ? absText + '\n\n---\n' + kpText : absText || kpText;
      writeSheets({ mode: 'both', titleZh, titleOrig, source, date, body: bodyText, url });

      return res.status(200).json({
        ok: true,
        imageUrl: urls[0] || urls[1],
        sent: msgs.filter(m => m.type === 'image').length,
        ...(failed.length ? { partial: true, failed } : {}),
      });
    }

    // ── 單圖模式（resend / 舊版相容）──
    let imgUrl;
    if (_resend && reuseUrl) {
      imgUrl = reuseUrl;
    } else {
      imgUrl = await uploadCard(imageBase64, mimeType, 'card');
    }

    const msgs = [{ type: 'image', originalContentUrl: imgUrl, previewImageUrl: imgUrl }];
    if (textMsg) msgs.push(textMsg);
    await linePush(lineUserId, msgs);

    if (!_resend) {
      const bodyText = Array.isArray(keyPoints) && keyPoints.length > 0
        ? keyPoints.map((p, i) => `${i + 1}. ${p}`).join('\n')
        : (abstract || editorial || '');
      writeSheets({ mode, titleZh, titleOrig, source, date, body: bodyText, url });
    }

    res.status(200).json({ ok: true, imageUrl: imgUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
