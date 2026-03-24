const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE = process.env.AIRTABLE_BASE;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE;
const AIRTABLE_LOG_TABLE = 'tblVCrX3ZYpOs5Ixa';

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

async function logToAirtable(sessionId, userMessage, aiReply) {
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
    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    const newEntry = `[${now}]\n用戶：${userMessage}\n玥：${aiReply}\n`;
    const nowISO = new Date().toISOString();

    const encoded = encodeURIComponent(`{LINE_ID}="${sessionId}"`);
    const checkRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_LOG_TABLE}?filterByFormula=${encoded}&pageSize=1`,
      { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
    );
    const checkData = await checkRes.json();
    const existing = checkData.records?.[0];

    if (existing) {
      const oldLog = existing.fields['對話紀錄'] || '';
      const oldKeywords = existing.fields['關鍵字'] || '';
      const oldCount = existing.fields['對話次數'] || 0;
      const allKeywords = oldKeywords
        ? [...new Set([...oldKeywords.split(','), ...keywords.split(',')].map(k => k.trim()).filter(Boolean))].join(', ')
        : keywords;
      await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_LOG_TABLE}/${existing.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
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
      await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_LOG_TABLE}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          records: [{
            fields: {
              用戶名稱: '網頁用戶',
              LINE_ID: sessionId,
              來源: '網頁',
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { message, history = [], sessionId } = req.body;
  if (!message) return res.status(400).json({ error: 'Missing message' });

  try {
    const subsidies = await fetchSubsidies();
    const subsidyContext = buildSubsidyContext(subsidies);

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
- 用數字列表或換行分隔
- 每則回覆控制在 300 字以內
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
        messages: [...history, { role: 'user', content: message }],
      }),
    });

    const data = await response.json();
    const reply = data.content[0].text;

    await logToAirtable(sessionId, message, reply);

    return res.status(200).json({ reply });
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: '系統暫時無法回應，請稍後再試。' });
  }
}
