import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import Anthropic from '@anthropic-ai/sdk';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID;

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

// --- Fallback regex parser (works without AI) ---
function parseEntryWithRegex(text) {
  const lower = text.toLowerCase().trim();
  const isIncome = /^(income|received|salary|got paid)/.test(lower);

  const amountMatch = text.match(/\d+(?:,\d+)*(?:\.\d+)?/);
  if (!amountMatch) return null;
  const amount = parseFloat(amountMatch[0].replace(/,/g, ''));
  if (!amount) return null;

  const categoryMap = {
    Food:          ['food','lunch','dinner','breakfast','chai','tea','coffee','restaurant','dhaba','swiggy','zomato','grocery','groceries','snack','meal','eating','eat'],
    Transport:     ['transport','uber','ola','taxi','auto','bus','train','metro','fuel','petrol','diesel','cab','rickshaw','travel'],
    Medical:       ['medical','medicine','doctor','hospital','pharmacy','clinic','health','chemist','dental'],
    Rent:          ['rent','house','flat','apartment','pg','hostel','accommodation'],
    Utilities:     ['electricity','water','gas','internet','wifi','broadband','bill','recharge','mobile','phone','dth'],
    Shopping:      ['shopping','clothes','shirt','shoes','amazon','flipkart','myntra','mall','market'],
    Entertainment: ['movie','movies','netflix','hotstar','prime','spotify','game','games','concert','outing'],
    Business:      ['business','office','stationery','meeting','client','supplies'],
    Tax:           ['tax','gst','tds'],
    Salary:        ['salary','ctc','payroll','wages'],
    Freelance:     ['freelance','project','consulting'],
    Investment:    ['investment','mutual fund','sip','stocks','shares','fd'],
    Rental:        ['rental income','rent received','tenant'],
  };

  let category = 'Other';
  for (const [cat, keywords] of Object.entries(categoryMap)) {
    if (keywords.some(k => lower.includes(k))) { category = cat; break; }
  }

  const afterAmount = text.slice(text.indexOf(amountMatch[0]) + amountMatch[0].length).trim();
  const description = afterAmount || text;

  const incomeCategories = ['Salary', 'Freelance', 'Investment', 'Rental'];
  const type = isIncome ? 'income' : (incomeCategories.includes(category) ? 'income' : 'expense');

  return { type, amount, category, description };
}

// --- Claude AI: parse text entry (with regex fallback) ---
async function parseEntry(text) {
  const regexResult = parseEntryWithRegex(text);

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Parse this into JSON. Reply with ONLY the raw JSON object, nothing else, no markdown backticks.

Input: "${text}"

Output format: {"type":"expense","amount":500,"category":"Food","description":"lunch at dhaba"}

type = expense or income
amount = number
category = one of: Food, Transport, Medical, Rent, Utilities, Shopping, Entertainment, Business, Tax, Salary, Freelance, Investment, Rental, Other`
      }]
    });

    const raw = response.content[0].text.trim()
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/, '')
      .trim();

    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.amount === 'number' && parsed.amount > 0 && parsed.type) {
      return parsed;
    }
  } catch (e) {
    console.error('AI parse failed, using regex:', e.message);
  }

  return regexResult;
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
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: contentType, data: base64 } },
        { type: 'text', text: `Extract expense from this receipt. Reply with ONLY raw JSON, no backticks.
{"amount":450,"category":"Food","description":"restaurant bill","date":"23/04/2025"}
category: Food, Transport, Medical, Rent, Utilities, Shopping, Entertainment, Business, Tax, Other
If amount unclear, use 0.` }
      ]
    }]
  });

  try {
    const raw = response.content[0].text.trim()
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/, '')
      .trim();
    return JSON.parse(raw);
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
  const filtered = period === 'month' ? rows.filter(r => r.get('Month') === currentMonth) : rows;

  let totalIncome = 0, totalExpense = 0;
  const categories = {};

  for (const row of filtered) {
    const amt = parseFloat(row.get('Amount')) || 0;
    const type = row.get('Type');
    const cat = row.get('Category') || 'Other';
    if (type === 'income') totalIncome += amt;
    else { totalExpense += amt; categories[cat] = (categories[cat] || 0) + amt; }
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

  if (ALLOWED_CHAT_ID && String(chatId) !== String(ALLOWED_CHAT_ID)) {
    await sendMessage(chatId, '⛔ Unauthorized.');
    return res.status(200).json({ ok: true });
  }

  try {
    if (text === '/start' || text === '/help') {
      await sendMessage(chatId, `👋 *ExpenseBot - Your Tax Bookkeeper*

*Log an expense:*
\`500 food lunch\`
\`1200 transport uber\`
\`800 medical doctor visit\`

*Log income:*
\`income 50000 salary\`
\`income 15000 freelance project\`

*Summaries:*
/month — this month
/year — full financial year

*Receipt:*
Send any receipt photo 📷

All data saved to Google Sheets 📊`);
      return res.status(200).json({ ok: true });
    }

    if (text === '/month') {
      const { doc } = await getSheet();
      await sendMessage(chatId, await getSummary('month', doc));
      return res.status(200).json({ ok: true });
    }

    if (text === '/year') {
      const { doc } = await getSheet();
      await sendMessage(chatId, await getSummary('year', doc));
      return res.status(200).json({ ok: true });
    }

    if (message.photo) {
      await sendMessage(chatId, '🔍 Reading your receipt...');
      const photo = message.photo[message.photo.length - 1];
      const fileUrl = await getFile(photo.file_id);
      const extracted = await extractFromReceipt(fileUrl);

      if (!extracted || !extracted.amount || extracted.amount === 0) {
        await sendMessage(chatId, "❓ Couldn't read this receipt clearly. Please type it:\nExample: `450 food restaurant bill`");
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

    if (text && !text.startsWith('/')) {
      const parsed = await parseEntry(text);

      if (!parsed || !parsed.amount) {
        await sendMessage(chatId, `❓ Couldn't find an amount. Try:\n\`500 food lunch\`\n\`income 45000 salary\`\n\nType /help for all commands.`);
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
    console.error('Handler error:', err);
    await sendMessage(chatId, `⚠️ Error: ${err.message}`);
  }

  return res.status(200).json({ ok: true });
}
