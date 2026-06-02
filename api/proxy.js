// Vercel Serverless Function — Litterbox upload + LINE push
export const config = {
  api: { bodyParser: { sizeLimit: '16mb' } },
};

function buildMultipart(boundary, imgBuf, mimeType) {
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="reqtype"\r\n\r\nfileupload\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="time"\r\n\r\n72h\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="fileToUpload"; filename="card.jpg"\r\nContent-Type: ${mimeType}\r\n\r\n`,
  ];
  return Buffer.concat([
    Buffer.from(parts.join('')),
    imgBuf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

async function uploadToLitterbox(base64, mimeType) {
  const imgBuf   = Buffer.from(base64, 'base64');
  const boundary = 'FormBoundary' + Date.now().toString(16) + Math.random().toString(16).slice(2);
  const body     = buildMultipart(boundary, imgBuf, mimeType);
  const res = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', {
    method:  'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const url = (await res.text()).trim();
  if (!url.startsWith('http')) throw new Error('圖片上傳失敗: ' + url);
  return url;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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
    });
    if (!r.ok) throw new Error(`LINE API ${r.status}: ${await r.text()}`);
    return r;
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

    // ── 雙圖模式（新版：摘要字卡 + 全文版）──
    if (imageSummaryBase64 && imageFullBase64) {
      const [summaryUrl, fullUrl] = await Promise.all([
        uploadToLitterbox(imageSummaryBase64, mimeType),
        uploadToLitterbox(imageFullBase64, mimeType),
      ]);

      const msgs = [
        { type: 'image', originalContentUrl: summaryUrl, previewImageUrl: summaryUrl },
        { type: 'image', originalContentUrl: fullUrl,    previewImageUrl: fullUrl    },
      ];
      if (title || doiUrl) {
        msgs.push({
          type: 'text',
          text: [title ? `📄 ${title}` : '', doiUrl ? `\n🔗 ${doiUrl}` : ''].join(''),
        });
      }

      await linePush(lineUserId, msgs);

      // 記錄至 Google Sheets（非同步）
      // 'both' 模式：同時儲存 abstract + keyPoints，以 \n\n---\n 分隔，供 search 頁重新產生兩張
      const sheetsUrl = process.env.SHEETS_WEBHOOK_URL;
      if (sheetsUrl) {
        const kpText  = Array.isArray(keyPoints) && keyPoints.length > 0
          ? keyPoints.map((p, i) => `${i + 1}. ${p}`).join('\n') : '';
        const absText = abstract || editorial || '';
        const bodyText = absText && kpText ? absText + '\n\n---\n' + kpText : absText || kpText;
        fetch(sheetsUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'text/plain' },
          body:    JSON.stringify({ mode: 'both', titleZh, titleOrig, source, date, body: bodyText, url }),
        }).catch(() => {});
      }

      return res.status(200).json({ ok: true, imageUrl: summaryUrl });
    }

    // ── 單圖模式（resend / 舊版相容）──
    let imageUrl;
    if (_resend && reuseUrl) {
      imageUrl = reuseUrl;
    } else {
      imageUrl = await uploadToLitterbox(imageBase64, mimeType);
    }

    const msgs = [
      { type: 'image', originalContentUrl: imageUrl, previewImageUrl: imageUrl },
    ];
    if (title || doiUrl) {
      msgs.push({
        type: 'text',
        text: [title ? `📄 ${title}` : '', doiUrl ? `\n🔗 ${doiUrl}` : ''].join(''),
      });
    }

    await linePush(lineUserId, msgs);

    // 記錄至 Google Sheets
    const sheetsUrl = process.env.SHEETS_WEBHOOK_URL;
    if (sheetsUrl && !_resend) {
      const bodyText = Array.isArray(keyPoints) && keyPoints.length > 0
        ? keyPoints.map((p, i) => `${i + 1}. ${p}`).join('\n')
        : (abstract || editorial || '');
      fetch(sheetsUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'text/plain' },
        body:    JSON.stringify({ mode, titleZh, titleOrig, source, date, body: bodyText, url }),
      }).catch(() => {});
    }

    res.status(200).json({ ok: true, imageUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
