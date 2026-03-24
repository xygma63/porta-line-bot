const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE = process.env.AIRTABLE_BASE;
const AIRTABLE_FORM_TABLE = 'tbl4xpJojvTxpw8WZ';
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;

const ADMIN_IDS = [
  'Ub92d4bee9d4afd8e4afdd94a01f0497c', // 希小玥
];

async function notifyAdmins(formType, name, contact, source) {
  const message = `📋 收到新表單！\n\n類型：${formType}\n姓名：${name}\n聯絡方式：${contact}\n來源：${source}\n\n👉 請至 Airtable 查看完整內容`;

  await Promise.all(ADMIN_IDS.map(adminId =>
    fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LINE_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        to: adminId,
        messages: [{ type: 'text', text: message }],
      }),
    })
  ));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { formType, name, contact, identity, description, appointmentTime, source } = req.body;
  if (!name || !contact) return res.status(400).json({ error: 'Missing required fields' });

  try {
    await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_FORM_TABLE}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        records: [{
          fields: {
            姓名: name,
            聯絡方式: contact,
            表單類型: formType || '補助詢問',
            身份: identity || '',
            需求說明: description || '',
            預約時間: appointmentTime || '',
            來源: source || '網頁',
            提交時間: new Date().toISOString(),
          }
        }]
      }),
    });

    await notifyAdmins(formType, name, contact, source);

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Form error:', error);
    return res.status(500).json({ error: '提交失敗，請稍後再試' });
  }
}
