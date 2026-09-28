import 'dotenv/config';
import express from 'express';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { Telegraf, Markup } from 'telegraf';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '';

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is missing. Copy .env.example to .env and set BOT_TOKEN.');
  process.exit(1);
}

const db = new Database(path.join(__dirname, 'shop.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  price INTEGER NOT NULL,
  image TEXT DEFAULT '',
  category TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  username TEXT DEFAULT '',
  customer_name TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  address TEXT DEFAULT '',
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  price INTEGER NOT NULL,
  FOREIGN KEY(order_id) REFERENCES orders(id),
  FOREIGN KEY(product_id) REFERENCES products(id)
);
`);

const count = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
if (count === 0) {
  const insert = db.prepare(`
    INSERT INTO products (name, description, price, image, category)
    VALUES (?, ?, ?, ?, ?)
  `);
  const seed = db.transaction(() => {
    insert.run('Футболка Basic', 'Хлопковая футболка', 1990, 'https://placehold.co/600x600?text=T-shirt', 'Одежда');
    insert.run('Кроссовки Urban', 'Повседневные кроссовки', 5990, 'https://placehold.co/600x600?text=Shoes', 'Обувь');
    insert.run('Рюкзак City', 'Компактный городской рюкзак', 3490, 'https://placehold.co/600x600?text=Bag', 'Аксессуары');
  });
  seed();
}

function validateInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(BOT_TOKEN)
    .digest();

  const calculated = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  const a = Buffer.from(calculated, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const userRaw = params.get('user');
  return userRaw ? JSON.parse(userRaw) : null;
}

function money(cents) {
  return `${(cents / 100).toFixed(2)} €`;
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/products', (req, res) => {
  const products = db.prepare(`
    SELECT id, name, description, price, image, category
    FROM products WHERE active = 1 ORDER BY id DESC
  `).all();
  res.json(products);
});

app.post('/api/orders', (req, res) => {
  try {
    const user = validateInitData(req.headers['x-telegram-init-data']);
    if (!user) return res.status(401).json({ error: 'Telegram session is invalid' });

    const { items, customer } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    const getProduct = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1');
    const normalized = [];
    let total = 0;

    for (const item of items) {
      const product = getProduct.get(Number(item.productId));
      const quantity = Math.max(1, Math.min(99, Number(item.quantity)));
      if (!product || !Number.isInteger(quantity)) continue;
      normalized.push({ product, quantity });
      total += product.price * quantity;
    }

    if (!normalized.length) return res.status(400).json({ error: 'No valid products' });

    const customerName = String(customer?.name || '').trim().slice(0, 120);
    const phone = String(customer?.phone || '').trim().slice(0, 50);
    const address = String(customer?.address || '').trim().slice(0, 500);

    const createOrder = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO orders
        (telegram_id, username, customer_name, phone, address, total)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        user.id,
        user.username || '',
        customerName,
        phone,
        address,
        total
      );

      const orderId = result.lastInsertRowid;
      const insertItem = db.prepare(`
        INSERT INTO order_items (order_id, product_id, quantity, price)
        VALUES (?, ?, ?, ?)
      `);

      for (const row of normalized) {
        insertItem.run(orderId, row.product.id, row.quantity, row.product.price);
      }
      return orderId;
    });

    const orderId = createOrder();

    const summary = normalized
      .map(x => `${x.product.name} × ${x.quantity}`)
      .join(', ');

    const adminText =
      `🛒 Новый заказ #${orderId}\n` +
      `Покупатель: ${customerName || user.first_name || ''} @${user.username || '-'}\n` +
      `Телефон: ${phone || '-'}\n` +
      `Адрес: ${address || '-'}\n` +
      `Товары: ${summary}\n` +
      `Сумма: ${money(total)}`;

    if (ADMIN_CHAT_ID) {
      bot.telegram.sendMessage(ADMIN_CHAT_ID, adminText).catch(console.error);
    }

    res.json({ ok: true, orderId, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  if (!WEBAPP_URL) {
    return ctx.reply('Укажите WEBAPP_URL в файле .env');
  }

  await ctx.reply(
    'Добро пожаловать в магазин! Нажмите кнопку ниже.',
    Markup.inlineKeyboard([
      Markup.button.webApp('🛍 Открыть магазин', WEBAPP_URL)
    ])
  );
});

bot.command('shop', async (ctx) => {
  if (!WEBAPP_URL) return ctx.reply('Укажите WEBAPP_URL в .env');
  await ctx.reply(
    'Открыть магазин:',
    Markup.inlineKeyboard([
      Markup.button.webApp('🛍 Магазин', WEBAPP_URL)
    ])
  );
});

bot.catch((err) => console.error('Telegram bot error:', err));

bot.launch().then(() => console.log('Telegram bot started'));
app.listen(PORT, () => console.log(`Web app: http://localhost:${PORT}`));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
