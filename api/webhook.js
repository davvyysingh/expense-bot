import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import Anthropic from '@anthropic-ai/sdk';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID; // Your personal Telegram chat ID

// --- Telegram helpers ---
async function sendMessage(chatId, text, parseMode = 'Markdown') {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode }),
  });
}

async function getFile(fileId) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
  const data = await res.json();
  return `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${data.result.file_path}`;
}

// --- Google Sheets helper ---
async function getSheet() {
  const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
  await doc.loadInfo();

  // Get or create sheet for current financial year (April-March, Indian FY)
  const now = new Date();
  const fyYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const sheetTitle = `FY ${fyYear}-${String(fyYear + 1).slice(2)}`;

  let sheet = doc.sheetsByTitle[sheetTitle];
  if (!sheet) {
    sheet = await doc.addSheet({ title: sheetTitle });
    await sheet.setHeaderRow(['Date', 'Time', 'Type', 'Amount', 'Category', 'Description', 'Month', 'Source']);
  }
  return { sheet, doc };
}

// --- Claude AI: parse text entry ---
async function parseEntryWithAI(text) {
  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Parse this financial entry and return ONLY a JSON object (no markdown, no explanation):
"${text}"

Return: {"type": "expense" or "income", "amount": number, "category": string, "description": string}

Categories for expense: Food, Transport, Medical, Rent, Utilities, Shopping, Entertainment, Business, Tax, Other
Categories for income: Salary, Business, Freelance, Investment, Rental, Other

If amount is unclear return amount: 0.`
    }]
  });
  try {
    return JSON.parse(response.content[0].text.trim());
  } catch {
    return null;
  }
}

// --- Claude AI: extract from receipt image ---
async function extractFromReceipt(imageUrl) {
  const imageRes = await fetch(imageUrl);
  const buffer = await imageRes.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const contentType = imageRes.headers.get('content-type') || 'image/jpeg';

  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: contentType, data: base64 } },
        { type: 'text', text: `Extract expense details from this receipt. Return ONLY a JSON object:
{"amount": number, "category": string, "description": string, "date": "DD/MM/YYYY or empty string"}

Categories: Food, Transport, Medical, Rent, Utilities, Shopping, Entertainment, Business, Tax, Other
If total amount is unclear, use 0.` }
      ]
    }]
  });
  try {
    return JSON.parse(response.content[0].text.trim());
  } catch {
    return null;
  }
}

// --- Summary logic ---
async function getSummary(period, doc) {
  const now = new Date();
  const fyYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const sheetTitle = `FY ${fyYear}-${String(fyYear + 1).slice(2)}`;
  const sheet = doc.sheetsByTitle[sheetTitle];
  if (!sheet) return '📭 No data found for this financial year yet.';

  const rows = await sheet.getRows();
  const currentMonth = now.toLocaleString('en-IN', { month: 'long' });

  const filtered = period === 'month'
    ? rows.filter(r => r.get('Month') === currentMonth)
    : rows;

  let totalIncome = 0, totalExpense = 0;
  const categories = {};

  for (const row of filtered) {
    const amt = parseFloat(row.get('Amount')) || 0;
    const type = row.get('Type');
    const cat = row.get('Category') || 'Other';
    if (type === 'income') totalIncome += amt;
    else {
      totalExpense += amt;
      categories[cat] = (categories[cat] || 0) + amt;
    }
  }

  const net = totalIncome - totalExpense;
  const label = period === 'month' ? `📅 *${currentMonth} Summary*` : `📊 *${sheetTitle} Summary*`;

  let msg = `${label}\n\n`;
  msg += `✅ Income: ₹${totalIncome.toLocaleString('en-IN')}\n`;
  msg += `❌ Expenses: ₹${totalExpense.toLocaleString('en-IN')}\n`;
  msg += `${net >= 0 ? '💚' : '🔴'} Net: ₹${Math.abs(net).toLocaleString('en-IN')} ${net >= 0 ? 'saved' : 'deficit'}\n`;

  if (Object.keys(categories).length > 0) {
    msg += `\n*Top Expense Categories:*\n`;
    const sorted = Object.entries(categories).sort((a, b) => b[1] - a[1]);
    for (const [cat, amt] of sorted.slice(0, 6)) {
      const pct = totalExpense > 0 ? Math.round((amt / totalExpense) * 100) : 0;
      msg += `• ${cat}: ₹${amt.toLocaleString('en-IN')} (${pct}%)\n`;
    }
  }
  return msg;
}

// --- Main handler ---
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const update = req.body;
  const message = update.message;
  if (!message) return res.status(200).json({ ok: true });

  const chatId = message.chat.id;
  const text = message.text || '';

  // Security: only respond to your chat
  if (ALLOWED_CHAT_ID && String(chatId) !== String(ALLOWED_CHAT_ID)) {
    await sendMessage(chatId, '⛔ Unauthorized.');
    return res.status(200).json({ ok: true });
  }

  try {
    // --- /start ---
    if (text === '/start' || text === '/help') {
      await sendMessage(chatId, `👋 *ExpenseBot - Your Tax Bookkeeper*

*Log an expense:*
\`500 food lunch at restaurant\`
\`1200 transport taxi to airport\`

*Log income:*
\`income 50000 salary march\`
\`income 15000 freelance website project\`

*Get summaries:*
/month — this month's summary
/year — full financial year summary

*Receipt photo:*
Just send a photo of any receipt — I'll extract the details automatically.

All data saved to Google Sheets 📊`);
      return res.status(200).json({ ok: true });
    }

    // --- Monthly summary ---
    if (text === '/month') {
      const { doc } = await getSheet();
      const summary = await getSummary('month', doc);
      await sendMessage(chatId, summary);
      return res.status(200).json({ ok: true });
    }

    // --- Yearly summary ---
    if (text === '/year') {
      const { doc } = await getSheet();
      const summary = await getSummary('year', doc);
      await sendMessage(chatId, summary);
      return res.status(200).json({ ok: true });
    }

    // --- Photo (receipt) ---
    if (message.photo) {
      await sendMessage(chatId, '🔍 Reading your receipt...');
      const photo = message.photo[message.photo.length - 1];
      const fileUrl = await getFile(photo.file_id);
      const extracted = await extractFromReceipt(fileUrl);

      if (!extracted || extracted.amount === 0) {
        await sendMessage(chatId, "❓ Couldn't read this receipt clearly. Please type the entry manually.\nExample: `450 food restaurant bill`");
        return res.status(200).json({ ok: true });
      }

      const { sheet } = await getSheet();
      const now = new Date();
      await sheet.addRow({
        Date: extracted.date || now.toLocaleDateString('en-IN'),
        Time: now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        Type: 'expense',
        Amount: extracted.amount,
        Category: extracted.category,
        Description: extracted.description,
        Month: now.toLocaleString('en-IN', { month: 'long' }),
        Source: 'Receipt Photo',
      });

      await sendMessage(chatId, `✅ *Receipt logged!*\n💸 ₹${extracted.amount.toLocaleString('en-IN')}\n📂 ${extracted.category}\n📝 ${extracted.description}`);
      return res.status(200).json({ ok: true });
    }

    // --- Text entry (expense or income) ---
    if (text && !text.startsWith('/')) {
      const parsed = await parseEntryWithAI(text);

      if (!parsed || parsed.amount === 0) {
        await sendMessage(chatId, `❓ Couldn't understand that. Try:\n\`500 food lunch\`\n\`income 45000 salary\`\n\nOr type /help for all commands.`);
        return res.status(200).json({ ok: true });
      }

      const { sheet } = await getSheet();
      const now = new Date();
      await sheet.addRow({
        Date: now.toLocaleDateString('en-IN'),
        Time: now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        Type: parsed.type,
        Amount: parsed.amount,
        Category: parsed.category,
        Description: parsed.description,
        Month: now.toLocaleString('en-IN', { month: 'long' }),
        Source: 'Manual',
      });

      const emoji = parsed.type === 'income' ? '💰' : '💸';
      const typeLabel = parsed.type === 'income' ? 'Income' : 'Expense';
      await sendMessage(chatId, `${emoji} *${typeLabel} logged!*\n₹${parsed.amount.toLocaleString('en-IN')} · ${parsed.category}\n📝 ${parsed.description}`);
      return res.status(200).json({ ok: true });
    }

  } catch (err) {
    console.error(err);
    await sendMessage(chatId, '⚠️ Something went wrong. Please try again.');
  }

  return res.status(200).json({ ok: true });
}
