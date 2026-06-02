// LINE Webhook — 歡迎訊息 + 回覆 User ID
export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const events    = req.body?.events || [];

  for (const event of events) {
    if (!event.replyToken) continue;
    const userId = event.source?.userId || '無法取得';

    // ── 加好友：送歡迎語 + 引導設定 ──
    if (event.type === 'follow') {
      await fetch('https://api.line.me/v2/bot/message/reply', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${lineToken}` },
        body:    JSON.stringify({
          replyToken: event.replyToken,
          messages: [
            {
              type: 'text',
              text: '您好 👋\n\n我是您的專屬 AI 助理「木木人」\n\n我會幫您把重要的醫療生技資訊，整理成清楚的重點摘要，直接傳送到這裡，不需要您額外操作。',
            },
            {
              type: 'text',
              text: '📋 完成設定只需一步\n\n請傳送任意一則訊息給我，我會立即回覆您的專屬識別碼。\n\n請將識別碼截圖傳給管理員 Marco，即可開始接收資訊 ✅',
            },
          ],
        }),
      });
      continue;
    }

    // ── 傳訊息：回覆 User ID ──
    if (event.type === 'message') {
      await fetch('https://api.line.me/v2/bot/message/reply', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${lineToken}` },
        body:    JSON.stringify({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `您的專屬識別碼：\n${userId}\n\n請截圖傳給管理員 Marco 完成設定 🙏`,
          }],
        }),
      });
    }
  }

  res.status(200).json({ ok: true });
}
