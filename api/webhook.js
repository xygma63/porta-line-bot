import crypto from 'crypto';

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE = process.env.AIRTABLE_BASE;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE;
const AIRTABLE_LOG_TABLE = 'tblVCrX3ZYpOs5Ixa';

const conversationHistory = {};

async function fetchSubsidies() {
  const records = [];
  let offset = null;
  do {
    let url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?pageSize=100&filterByFormula={審核狀態}="已上線"`;
    if (offset) url += `&offset=${offset}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
    });
    const data = await res.json();
    records.push(...(data.records || []));
    offset = data.offset || null;
  } while (offset);
  return records.map(r => r.fields);
}

function buildSubsidyContext(subsidies) {
  return subsidies.map(s => {
    return [
      `【${s['專案標題'] || ''}】`,
      s['補助形式'] ? `形式：${s['補助形式']}` : '',
      s['適合對象'] ? `適合：${s['適合對象']}` : '',
      s['補助金額'] ? `金額：${s['補助金額']}` : '',
      s['專案期間'] ? `期間：${s['專案期間']}` : '',
      s['專案來源'] ? `來源：${s['專案來源']}` : '',
      s['專案簡介'] ? `簡介：${s['專案簡介'].slice(0, 150)}` : '',
      s['專案攻略'] ? `申請：${s['專案攻略'].slice(0, 150)}` : '',
      s['聯絡資訊'] ? `聯絡：${s['聯絡資訊']}` : '',
      s['專案連結'] ? `連結：${s['專案連結']}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n---\n\n');
}

// 從 LINE 取得用戶顯示名稱
async function getLineUserName(userId) {
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { Authorization: `Bearer ${LINE_ACCESS_TOKEN}` },
    });
    const data = await res.json();
    return data.displayName || '未知用戶';
  } catch {
    return '未知用戶';
  }
}

// 查 Airtable 是否已有此用戶的記錄
async function findUserRecord(userName) {
  const encoded = encodeURIComponent(`{用戶名稱}="${userName}"`);
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_LOG_TABLE}?filterByFormula=${encoded}&pageSize=1`,
    { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
  );
  const data = await res.json();
  const records = data.records || [];
  return records.length > 0 ? records[0] : null;
}

async function logToAirtable(userId, userMessage, aiReply, source = 'LINE') {
  try {
    // 取得關鍵字
    const kwRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 50,
        messages: [{
          role: 'user',
          content: `從以下訊息萃取1-3個補助相關關鍵字，只輸出關鍵字用逗號分隔，不要其他文字：「${userMessage}」`
        }]
      }),
    });
    const kwData = await kwRes.json();
    const keywords = kwData.content?.[0]?.text || '';

    // 取得用戶名稱
    const userName = await getLineUserName(userId);

    // 組對話紀錄這一筆
    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    const newEntry = `[${now}]\n用戶：${userMessage}\n玥：${aiReply}\n`;

    // 查有沒有舊記錄
    const existing = await findUserRecord(userName);
    const nowISO = new Date().toISOString();

    if (existing) {
      // 有舊記錄 → 追加對話
      const oldLog = existing.fields['對話紀錄'] || '';
      const oldKeywords = existing.fields['關鍵字'] || '';
      const oldCount = existing.fields['對話次數'] || 0;
      const allKeywords = oldKeywords
        ? [...new Set([...oldKeywords.split(','), ...keywords.split(',')].map(k => k.trim()).filter(Boolean))].join(', ')
        : keywords;

      await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_LOG_TABLE}/${existing.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${AIRTABLE_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fields: {
            對話紀錄: oldLog + '\n' + newEntry,
            關鍵字: allKeywords,
            最後對話: nowISO,
            對話次數: oldCount + 1,
          }
        }),
      });
    } else {
      // 沒有舊記錄 → 建新記錄
      await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_LOG_TABLE}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${AIRTABLE_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          records: [{
            fields: {
              用戶名稱: userName,
              來源: source,
              對話紀錄: newEntry,
              關鍵字: keywords,
              首次對話: nowISO,
              最後對話: nowISO,
              對話次數: 1,
            }
          }]
        }),
      });
    }
  } catch (e) {
    console.error('Log error:', e);
  }
}

async function callClaude(userId, userMessage, subsidyContext) {
  if (!conversationHistory[userId]) {
    conversationHistory[userId] = [];
  }
  conversationHistory[userId].push({ role: 'user', content: userMessage });
  if (conversationHistory[userId].length > 20) {
    conversationHistory[userId] = conversationHistory[userId].slice(-20);
  }

  const systemPrompt = `你是 Porta 的 AI 補助顧問「玥」，專門幫助台灣用戶找到最適合的政府補助資源。

以下是 Porta 目前收錄的真實補助資料庫，請根據這些資料回答用戶問題：

${subsidyContext}

【對話原則】
1. 只根據上方資料庫的補助內容回答，不要憑空捏造補助內容
2. 先了解用戶的身份和需求，再推薦最適合的補助
3. 每次推薦 2-3 個最相關的補助，不要一次列太多
4. 說明具體的申請步驟和聯絡方式
5. 語氣親切、專業，使用繁體中文
6. 如果資料庫沒有符合的補助，誠實說明並建議查詢政府官網

【回覆格式】
- LINE 不支援 Markdown，不要用 ** 粗體 ** 或 # 標題
- 用數字列表（1. 2. 3.）或換行分隔
- 每則回覆控制在 300 字以內，保持簡潔
- 重要資訊用📌或✅標記`;

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
      system: systemPrompt,
      messages: conversationHistory[userId],
    }),
  });

  const data = await response.json();
  const assistantMessage = data.content[0].text;
  conversationHistory[userId].push({ role: 'assistant', content: assistantMessage });
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

function verifySignature(body, signature) {
  const hash = crypto
    .createHmac('SHA256', LINE_CHANNEL_SECRET)
    .update(body)
    .digest('base64');
  return hash === signature;
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
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const userId = event.source.userId;
    const userMessage = event.message.text;
    const replyToken = event.replyToken;

    try {
      const subsidies = await fetchSubsidies();
      const subsidyContext = buildSubsidyContext(subsidies);
      const reply = await callClaude(userId, userMessage, subsidyContext);
      await Promise.all([
        replyToLine(replyToken, reply),
        logToAirtable(userId, userMessage, reply, 'LINE'),
      ]);
    } catch (error) {
      console.error('Error:', error);
      await replyToLine(replyToken, '抱歉，系統暫時無法回應，請稍後再試。如需急用可直接撥打相關機關電話。');
    }
  }

  res.status(200).send('OK');
}
