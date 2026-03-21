import crypto from 'crypto';

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const conversationHistory = {};

const SYSTEM_PROMPT = `你是 Porta 的 AI 補助顧問「玥」，專門幫助台灣用戶找到最適合的政府補助資源。

你擁有完整的台灣政府補助資料庫，涵蓋以下類別：
- 補助：租金補貼、生育給付、育兒津貼、節能補助、SBIR研發補助、SIIR服務業補助、TIIP產業升級等
- 貸款/融資：青年創業貸款、微型創業鳳凰貸款、中小企業信保基金、農業貸款等
- 法律/諮詢：法律扶助基金會、勞資爭議調解、消費者保護、智慧財產諮詢等
- 課程/職訓：在職進修補助（3年10萬）、失業職訓、數位轉型培訓等
- 稅務：所得稅退稅、研發投資抵減、房屋稅自住優惠、地價稅優惠等
- 其他資源：就學貸款、弱勢助學、社區發展補助等

【對話原則】
1. 先了解用戶的身份和需求（個人/小店家/社區/租屋者），再推薦最適合的補助
2. 每次推薦 2-3 個最相關的補助，不要一次列太多
3. 說明具體的申請步驟和聯絡方式
4. 語氣親切、專業，使用繁體中文
5. 如果用戶問的補助不在你的資料庫，誠實說明並建議查詢政府官網

【回覆格式】
- LINE 不支援 Markdown，不要用 ** 粗體 ** 或 # 標題
- 用數字列表（1. 2. 3.）或換行分隔
- 每則回覆控制在 300 字以內，保持簡潔
- 重要資訊用📌或✅標記，讓視覺更清晰`;

function verifySignature(body, signature) {
  const hash = crypto
    .createHmac('SHA256', LINE_CHANNEL_SECRET)
    .update(body)
    .digest('base64');
  return hash === signature;
}

async function callClaude(userId, userMessage) {
  if (!conversationHistory[userId]) {
    conversationHistory[userId] = [];
  }

  conversationHistory[userId].push({
    role: 'user',
    content: userMessage,
  });

  if (conversationHistory[userId].length > 20) {
    conversationHistory[userId] = conversationHistory[userId].slice(-20);
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: conversationHistory[userId],
    }),
  });

  const data = await response.json();
  const assistantMessage = data.content[0].text;

  conversationHistory[userId].push({
    role: 'assistant',
    content: assistantMessage,
  });

  return assistantMessage;
}

async function replyToLine(replyToken, message) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LINE_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text: message }],
    }),
  });
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).send('Porta LINE Bot is running ✅');
  }

  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const signature = req.headers['x-line-signature'];
  const rawBody = JSON.stringify(req.body);

  if (!verifySignature(rawBody, signature)) {
    return res.status(401).send('Unauthorized');
  }

  const events = req.body.events || [];

  for (const event of events) {
    if (event.type !== 'message' || event.message.type !== 'text') {
      continue;
    }

    const userId = event.source.userId;
    const userMessage = event.message.text;
    const replyToken = event.replyToken;

    try {
      const reply = await callClaude(userId, userMessage);
      await replyToLine(replyToken, reply);
    } catch (error) {
      console.error('Error:', error);
      await replyToLine(
        replyToken,
        '抱歉，系統暫時無法回應，請稍後再試。如需急用可直接撥打相關機關電話。'
      );
    }
  }

  res.status(200).send('OK');
}
