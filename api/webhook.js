import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import Anthropic from '@anthropic-ai/sdk';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID;

// In-memory session state (resets on cold start — fine for personal bot)
const sessions = {};

// --- Telegram helpers ---
async function sendMessage(chatId, text, keyboard = null) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
  };
  if (keyboard) body.reply_markup = keyboard;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function editMessage(chatId, messageId, text, keyboard = null) {
  const body = { chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown' };
  if (keyboard) body.reply_markup = keyboard;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function answerCallback(callbackQueryId) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}

async function getFile(fileId) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
  const data = await res.json();
  return `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${data.result.file_path}`;
}

// --- Keyboards ---
const MAIN_MENU = {
  inline_keyboard: [
    [{ text: '💸 Add expense', callback_data: 'add_expense' }, { text: '💰 Add income', callback_data: 'add_income' }],
    [{ text: '📅 This month', callback_data: 'summary_month' }, { text: '📊 This year', callback_data: 'summary_year' }],
    [{ text: '🕐 Recent entries', callback_data: 'recent' }],
  ]
};

const EXPENSE_CATEGORIES = {
  inline_keyboard: [
    [{ text: '🍽 Food', callback_data: 'cat_Food' }, { text: '🚗 Transport', callback_data: 'cat_Transport' }, { text: '💊 Medical', callback_data: 'cat_Medical' }],
    [{ text: '🏠 Rent', callback_data: 'cat_Rent' }, { text: '💡 Utilities', callback_data: 'cat_Utilities' }, { text: '🛍 Shopping', callback_data: 'cat_Shopping' }],
    [{ text: '💼 Business', callback_data: 'cat_Business' }, { text: '🎬 Entertainment', callback_data: 'cat_Entertainment' }, { text: '📦 Other', callback_data: 'cat_Other' }],
    [{ text: '« Back', callback_data: 'main_menu' }],
  ]
};

const INCOME_CATEGORIES = {
  inline_keyboard: [
    [{ text: '💼 Salary', callback_data: 'icat_Salary' }, { text: '💻 Freelance', callback_data: 'icat_Freelance' }],
    [{ text: '🏢 Business', callback_data: 'icat_Business' }, { text: '📈 Investment', callback_data: 'icat_Investment' }],
    [{ text: '🏠 Rental', callback_data: 'icat_Rental' }, { text: '📦 Other', callback_data: 'icat_Other' }],
    [{ text: '« Back', callback_data: 'main_menu' }],
  ]
};

const QUICK_AMOUNTS = {
  inline_keyboard: [
    [{ text: '₹100', callback_data: 'amt_100' }, { text: '₹200', callback_data: 'amt_200' }, { text: '₹500', callback_data: 'amt_500' }],
    [{ text: '₹1,000', callback_data: 'amt_1000' }, { text: '₹2,000', callback_data: 'amt_2000' }, { text: '₹5,000', callback_data: 'amt_5000' }],
    [{ text: '✏️ Type custom amount', callback_data: 'amt_custom' }],
    [{ text: '« Back', callback_data: 'back_to_category' }],
  ]
};

function confirmKeyboard(type) {
  return {
    inline_keyboard: [
      [{ text: '✅ Confirm & save', callback_data: 'confirm_save' }, { text: '❌ Cancel', callback_data: 'main_menu' }],
    ]
  };
}

// --- Google Sheets ---
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

async function saveEntry(entry) {
  const { sheet } = await getSheet();
  const now = new Date();
  await sheet.addRow({
    Date: now.toLocaleDateString('en-IN'),
    Time: now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
    Type: entry.type,
    Amount: entry.amount,
    Category: entry.category,
    Description: entry.description || entry.category,
    Month: now.toLocaleString('en-IN', { month: 'long' }),
    Source: entry.source || 'Button',
  });
}

async function getSummary(period) {
  const { doc } = await getSheet();
  const now = new Date();
  const fyYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const sheetTitle = `FY ${fyYear}-${String(fyYear + 1).slice(2)}`;
  const sheet = doc.sheetsByTitle[sheetTitle];
  if (!sheet) return '📭 No data yet for this financial year.';

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
  const label = period === 'month'
    ? `📅 *${currentMonth} Summary*`
    : `📊 *FY ${fyYear}-${String(fyYear + 1).slice(2)} Summary*`;

  let msg = `${label}\n\n`;
  msg += `✅ Income: ₹${totalIncome.toLocaleString('en-IN')}\n`;
  msg += `❌ Expenses: ₹${totalExpense.toLocaleString('en-IN')}\n`;
  msg += `${net >= 0 ? '💚' : '🔴'} Net: ₹${Math.abs(net).toLocaleString('en-IN')} ${net >= 0 ? 'saved' : 'deficit'}\n`;

  if (Object.keys(categories).length > 0) {
    msg += `\n*By category:*\n`;
    const sorted = Object.entries(categories).sort((a, b) => b[1] - a[1]);
    for (const [cat, amt] of sorted.slice(0, 6)) {
      const pct = totalExpense > 0 ? Math.round((amt / totalExpense) * 100) : 0;
      const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
      msg += `${bar} ${cat}: ₹${amt.toLocaleString('en-IN')} (${pct}%)\n`;
    }
  }
  return msg;
}

async function getRecent() {
  const { doc } = await getSheet();
  const now = new Date();
  const fyYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const sheetTitle = `FY ${fyYear}-${String(fyYear + 1).slice(2)}`;
  const sheet = doc.sheetsByTitle[sheetTitle];
  if (!sheet) return '📭 No entries yet.';

  const rows = await sheet.getRows();
  const last8 = rows.slice(-8).reverse();
  if (last8.length === 0) return '📭 No entries yet.';

  let msg = `🕐 *Recent entries*\n\n`;
  for (const row of last8) {
    const type = row.get('Type') === 'income' ? '💰' : '💸';
    const amt = parseFloat(row.get('Amount') || 0).toLocaleString('en-IN');
    msg += `${type} ${row.get('Date')} · ${row.get('Category')} · ₹${amt}\n`;
    if (row.get('Description') && row.get('Description') !== row.get('Category')) {
      msg += `   _${row.get('Description')}_\n`;
    }
  }
  return msg;
}

// --- Fallback regex parser ---
function parseEntryWithRegex(text) {
  const lower = text.toLowerCase().trim();
  const isIncome = /^(income|received|salary|got paid)/.test(lower);
  const amountMatch = text.match(/\d+(?:,\d+)*(?:\.\d+)?/);
  if (!amountMatch) return null;
  const amount = parseFloat(amountMatch[0].replace(/,/g, ''));
  if (!amount) return null;

  const categoryMap = {
    Food:          ['food','lunch','dinner','breakfast','chai','tea','coffee','restaurant','dhaba','swiggy','zomato','grocery','groceries','snack','meal'],
    Transport:     ['transport','uber','ola','taxi','auto','bus','train','metro','fuel','petrol','diesel','cab','rickshaw'],
    Medical:       ['medical','medicine','doctor','hospital','pharmacy','clinic','health','chemist','dental'],
    Rent:          ['rent','house','flat','apartment','pg','hostel'],
    Utilities:     ['electricity','water','gas','internet','wifi','broadband','bill','recharge','mobile','phone','dth'],
    Shopping:      ['shopping','clothes','shirt','shoes','amazon','flipkart','myntra','mall'],
    Entertainment: ['movie','netflix','hotstar','prime','spotify','game','concert'],
    Business:      ['business','office','stationery','meeting','client'],
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

async function parseEntry(text) {
  const regexResult = parseEntryWithRegex(text);
  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Parse this into JSON. Reply with ONLY the raw JSON object, no backticks, no explanation.
Input: "${text}"
Output: {"type":"expense","amount":500,"category":"Food","description":"lunch at dhaba"}
type = expense or income, amount = number, category = Food/Transport/Medical/Rent/Utilities/Shopping/Entertainment/Business/Tax/Salary/Freelance/Investment/Rental/Other`
      }]
    });
    const raw = response.content[0].text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.amount === 'number' && parsed.amount > 0 && parsed.type) return parsed;
  } catch (e) {
    console.error('AI parse failed:', e.message);
  }
  return regexResult;
}

// --- Receipt reading ---
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
category: Food/Transport/Medical/Rent/Utilities/Shopping/Entertainment/Business/Tax/Other. If amount unclear, use 0.` }
      ]
    }]
  });
  try {
    const raw = response.content[0].text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    return JSON.parse(raw);
  } catch { return null; }
}

// --- Main handler ---
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const update = req.body;

  // Handle callback queries (button presses)
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    const msgId = cb.message.message_id;
    const data = cb.data;

    if (ALLOWED_CHAT_ID && String(chatId) !== String(ALLOWED_CHAT_ID)) {
      await answerCallback(cb.id);
      return res.status(200).json({ ok: true });
    }

    await answerCallback(cb.id);
    const session = sessions[chatId] || {};

    if (data === 'main_menu') {
      sessions[chatId] = {};
      await editMessage(chatId, msgId, '👋 *ExpenseBot* — What would you like to do?', MAIN_MENU);
    }
    else if (data === 'add_expense') {
      sessions[chatId] = { type: 'expense' };
      await editMessage(chatId, msgId, '💸 *Add expense* — Pick a category:', EXPENSE_CATEGORIES);
    }
    else if (data === 'add_income') {
      sessions[chatId] = { type: 'income' };
      await editMessage(chatId, msgId, '💰 *Add income* — Pick a category:', INCOME_CATEGORIES);
    }
    else if (data.startsWith('cat_')) {
      const category = data.replace('cat_', '');
      sessions[chatId] = { ...session, category, type: 'expense' };
      await editMessage(chatId, msgId, `💸 *${category}* — Pick an amount:`, QUICK_AMOUNTS);
    }
    else if (data.startsWith('icat_')) {
      const category = data.replace('icat_', '');
      sessions[chatId] = { ...session, category, type: 'income' };
      await editMessage(chatId, msgId, `💰 *${category}* — Pick an amount:`, QUICK_AMOUNTS);
    }
    else if (data === 'back_to_category') {
      if (session.type === 'income') {
        await editMessage(chatId, msgId, '💰 *Add income* — Pick a category:', INCOME_CATEGORIES);
      } else {
        await editMessage(chatId, msgId, '💸 *Add expense* — Pick a category:', EXPENSE_CATEGORIES);
      }
    }
    else if (data.startsWith('amt_')) {
      if (data === 'amt_custom') {
        await editMessage(chatId, msgId, `✏️ *Type the amount* for ${session.category}:\n\nJust send a number, e.g. \`750\``);
        sessions[chatId] = { ...session, waitingForAmount: true };
      } else {
        const amount = parseInt(data.replace('amt_', ''));
        sessions[chatId] = { ...session, amount, waitingForDesc: true };
        const emoji = session.type === 'income' ? '💰' : '💸';
        await editMessage(chatId, msgId,
          `${emoji} *${session.type === 'income' ? 'Income' : 'Expense'}: ₹${amount.toLocaleString('en-IN')} · ${session.category}*\n\nAdd a description? (optional)\nSend a note or tap Confirm to save.`,
          confirmKeyboard()
        );
      }
    }
    else if (data === 'confirm_save') {
      const s = sessions[chatId];
      if (!s || !s.amount || !s.category) {
        await editMessage(chatId, msgId, '⚠️ Session expired. Please start again.', MAIN_MENU);
        return res.status(200).json({ ok: true });
      }
      await saveEntry({ type: s.type, amount: s.amount, category: s.category, description: s.description || s.category });
      sessions[chatId] = {};
      const emoji = s.type === 'income' ? '💰' : '💸';
      await editMessage(chatId, msgId,
        `${emoji} *Saved!*\n\n₹${s.amount.toLocaleString('en-IN')} · ${s.category}${s.description ? '\n_' + s.description + '_' : ''}\n\nWhat's next?`,
        MAIN_MENU
      );
    }
    else if (data === 'summary_month') {
      const summary = await getSummary('month');
      await editMessage(chatId, msgId, summary, { inline_keyboard: [[{ text: '« Back', callback_data: 'main_menu' }]] });
    }
    else if (data === 'summary_year') {
      const summary = await getSummary('year');
      await editMessage(chatId, msgId, summary, { inline_keyboard: [[{ text: '« Back', callback_data: 'main_menu' }]] });
    }
    else if (data === 'recent') {
      const recent = await getRecent();
      await editMessage(chatId, msgId, recent, { inline_keyboard: [[{ text: '« Back', callback_data: 'main_menu' }]] });
    }

    return res.status(200).json({ ok: true });
  }

  // Handle regular messages
  const message = update.message;
  if (!message) return res.status(200).json({ ok: true });

  const chatId = message.chat.id;
  const text = message.text || '';

  if (ALLOWED_CHAT_ID && String(chatId) !== String(ALLOWED_CHAT_ID)) {
    await sendMessage(chatId, '⛔ Unauthorized.');
    return res.status(200).json({ ok: true });
  }

  const session = sessions[chatId] || {};

  try {
    // /start or /help — show main menu
    if (text === '/start' || text === '/help' || text === '/menu') {
      sessions[chatId] = {};
      await sendMessage(chatId, '👋 *ExpenseBot* — What would you like to do?', MAIN_MENU);
      return res.status(200).json({ ok: true });
    }

    // User is in a flow waiting for custom amount
    if (session.waitingForAmount) {
      const amount = parseFloat(text.replace(/,/g, ''));
      if (!amount || isNaN(amount)) {
        await sendMessage(chatId, '⚠️ Please send just a number, e.g. `750`');
        return res.status(200).json({ ok: true });
      }
      sessions[chatId] = { ...session, amount, waitingForAmount: false, waitingForDesc: true };
      const emoji = session.type === 'income' ? '💰' : '💸';
      await sendMessage(chatId,
        `${emoji} *${session.type === 'income' ? 'Income' : 'Expense'}: ₹${amount.toLocaleString('en-IN')} · ${session.category}*\n\nAdd a description? (optional)\nSend a note or tap Confirm to save.`,
        confirmKeyboard()
      );
      return res.status(200).json({ ok: true });
    }

    // User is in a flow waiting for description
    if (session.waitingForDesc && !text.startsWith('/')) {
      sessions[chatId] = { ...session, description: text, waitingForDesc: false };
      const emoji = session.type === 'income' ? '💰' : '💸';
      await sendMessage(chatId,
        `${emoji} *Confirm entry:*\n\nAmount: ₹${session.amount?.toLocaleString('en-IN')}\nCategory: ${session.category}\nDescription: ${text}`,
        confirmKeyboard()
      );
      return res.status(200).json({ ok: true });
    }

    // Photo — receipt scan
    if (message.photo) {
      await sendMessage(chatId, '🔍 Reading your receipt...');
      const photo = message.photo[message.photo.length - 1];
      const fileUrl = await getFile(photo.file_id);
      const extracted = await extractFromReceipt(fileUrl);

      if (!extracted || !extracted.amount || extracted.amount === 0) {
        await sendMessage(chatId, "❓ Couldn't read this receipt clearly. Use the menu to log manually.", MAIN_MENU);
        return res.status(200).json({ ok: true });
      }

      await saveEntry({ type: 'expense', amount: extracted.amount, category: extracted.category, description: extracted.description, source: 'Receipt Photo' });
      await sendMessage(chatId,
        `✅ *Receipt logged!*\n\n💸 ₹${extracted.amount.toLocaleString('en-IN')} · ${extracted.category}\n_${extracted.description}_\n\nWhat's next?`,
        MAIN_MENU
      );
      return res.status(200).json({ ok: true });
    }

    // Free-text entry — parse with AI + regex
    if (text && !text.startsWith('/')) {
      const parsed = await parseEntry(text);
      if (!parsed || !parsed.amount) {
        await sendMessage(chatId,
          `❓ Couldn't understand that.\n\nUse the menu below, or type like:\n\`500 food lunch\`\n\`income 45000 salary\``,
          MAIN_MENU
        );
        return res.status(200).json({ ok: true });
      }

      await saveEntry({ type: parsed.type, amount: parsed.amount, category: parsed.category, description: parsed.description, source: 'Text' });
      const emoji = parsed.type === 'income' ? '💰' : '💸';
      await sendMessage(chatId,
        `${emoji} *Logged!*\n\n₹${parsed.amount.toLocaleString('en-IN')} · ${parsed.category}\n_${parsed.description}_\n\nWhat's next?`,
        MAIN_MENU
      );
      return res.status(200).json({ ok: true });
    }

  } catch (err) {
    console.error('Error:', err);
    await sendMessage(chatId, `⚠️ Error: ${err.message}\n\nTry again:`, MAIN_MENU);
  }

  return res.status(200).json({ ok: true });
}
