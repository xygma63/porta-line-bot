import crypto from 'crypto';

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE = process.env.AIRTABLE_BASE;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE;
const AIRTABLE_LOG_TABLE = 'tblVCrX3ZYpOs5Ixa';

const ADMIN_LINE_ID = 'Ub92d4bee9d4afd8e4afdd94a01f0497c';

const conversationHistory = {};
const userMessageCount = {};

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

function needsHumanIntervention(userMessage, aiReply, userId) {
  const msg = userMessage.toLowerCase();

  const emotionKeywords = ['生氣', '不滿', '抱怨', '爛', '沒用', '失望', '氣死', '白痴', '無言', '怎麼搞的', '投訴'];
  if (emotionKeywords.some(k => msg.includes(k))) {
    return { needed: true, reason: '用戶情緒不佳' };
  }

  const actionKeywords = ['我想提案', '我要申請', '如何提案', '怎麼提案', '幫我申請', '我要開始', '我要合作', '聯絡你們'];
  if (actionKeywords.some(k => msg.includes(k))) {
    return { needed: true, reason: '用戶想申請／提案' };
  }

  const personalKeywords = ['我的資料', '上傳文件', '填表', '需要什麼文件', '怎麼填'];
  if (personalKeywords.some(k => msg.includes(k))) {
    return { needed: true, reason: '用戶需要文件協助' };
  }

  const confusedKeywords = ['你沒有回答', '你沒幫到', '這不是我要的', '答非所問', '不對', '你不懂'];
  if (confusedKeywords.some(k => msg.includes(k))) {
    return { needed: true, reason: 'AI 回答不符需求' };
  }

  const count = userMessageCount[userId] || 0;
  if (count >= 5) {
    return { needed: true, reason: `對話已達 ${count} 次仍未解決` };
  }

  return { needed: false };
}

async function notifyAdmin(userName, userMessage, reason, userId) {
  const message = `🚨 需要人工介入！\n\n用戶：${userName}\n原因：${reason}\n最後訊息：${userMessage}\n\n👉 請至 LINE OA 後台處理對話`;

  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LINE_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to: ADMIN_LINE_ID,
      messages: [{ type: 'text', text: message }],
    }),
  });
}

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

async function findUserRecord(userId) {
  const encoded = encodeURIComponent(`{LINE_ID}="${userId}"`);
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

    const userName = await getLineUserName(userId);
    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    const newEntry = `[${now}]\n用戶：${userMessage}\n玥：${aiReply}\n`;
    const existing = await findUserRecord(userId);
    const nowISO = new Date().toISOString();

    if (existing) {
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
            用戶名稱: userName,
            對話紀錄: oldLog + '\n' + newEntry,
            關鍵字: allKeywords,
            最後對話: nowISO,
            對話次數: oldCount + 1,
          }
        }),
      });
    } else {
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
              LINE_ID: userId,
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
7. 如果用戶想提案或申請，回覆：「感謝您的興趣！我已通知專人為您服務，請稍候片刻 😊」

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

    userMessageCount[userId] = (userMessageCount[userId] || 0) + 1;

    try {
      const subsidies = await fetchSubsidies();
      const subsidyContext = buildSubsidyContext(subsidies);
      const reply = await callClaude(userId, userMessage, subsidyContext);

      const { needed, reason } = needsHumanIntervention(userMessage, reply, userId);
      if (needed) {
        const userName = await getLineUserName(userId);
        await notifyAdmin(userName, userMessage, reason, userId);
        userMessageCount[userId] = 0;
      }

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
