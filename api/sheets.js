// GET /api/sheets — 從 Google Apps Script 讀取文章記錄
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  const sheetsUrl = process.env.SHEETS_WEBHOOK_URL;
  if (!sheetsUrl) return res.status(500).json({ error: 'SHEETS_WEBHOOK_URL not set' });

  try {
    const resp = await fetch(sheetsUrl, { redirect: 'follow' });
    const raw = await resp.text();
    if (!resp.ok) {
      return res.status(500).json({ error: `Apps Script HTTP ${resp.status}`, raw: raw.slice(0, 300) });
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(500).json({ error: 'Apps Script response is not JSON', raw: raw.slice(0, 300) });
    }
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
