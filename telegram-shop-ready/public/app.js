const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

const state = {
  products: [],
  category: 'Все',
  cart: JSON.parse(localStorage.getItem('cart') || '{}')
};

const $ = (id) => document.getElementById(id);

function money(cents) {
  return `${(cents / 100).toFixed(2)} €`;
}

function saveCart() {
  localStorage.setItem('cart', JSON.stringify(state.cart));
}

function cartEntries() {
  return Object.entries(state.cart)
    .map(([id, quantity]) => {
      const product = state.products.find(p => p.id === Number(id));
      return product ? { product, quantity } : null;
    })
    .filter(Boolean);
}

function renderCategories() {
  const categories = ['Все', ...new Set(state.products.map(p => p.category).filter(Boolean))];
  $('categories').innerHTML = categories.map(c => `
    <button class="category ${c === state.category ? 'active' : ''}" data-category="${escapeHtml(c)}">${escapeHtml(c)}</button>
  `).join('');

  document.querySelectorAll('[data-category]').forEach(btn => {
    btn.onclick = () => {
      state.category = btn.dataset.category;
      renderCategories();
      renderProducts();
    };
  });
}

function renderProducts() {
  const list = state.category === 'Все'
    ? state.products
    : state.products.filter(p => p.category === state.category);

  if (!list.length) {
    $('products').innerHTML = '<div class="empty">Товаров пока нет</div>';
    return;
  }

  $('products').innerHTML = list.map(p => `
    <article class="product">
      <img src="${escapeAttr(p.image || 'https://placehold.co/600x600?text=Product')}" alt="">
      <div class="product-body">
        <h3>${escapeHtml(p.name)}</h3>
        <p>${escapeHtml(p.description || '')}</p>
        <div class="price">${money(p.price)}</div>
        <button class="primary" data-add="${p.id}">Добавить</button>
      </div>
    </article>
  `).join('');

  document.querySelectorAll('[data-add]').forEach(btn => {
    btn.onclick = () => addToCart(Number(btn.dataset.add));
  });
}

function addToCart(id) {
  state.cart[id] = (state.cart[id] || 0) + 1;
  saveCart();
  renderCart();
  if (tg?.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
  toast('Добавлено в корзину');
}

function renderCart() {
  const entries = cartEntries();
  const count = entries.reduce((s, x) => s + x.quantity, 0);
  const total = entries.reduce((s, x) => s + x.product.price * x.quantity, 0);
  $('cartCount').textContent = count;
  $('cartTotal').textContent = money(total);

  if (!entries.length) {
    $('cartItems').innerHTML = '<div class="empty">Корзина пуста</div>';
    $('checkoutButton').disabled = true;
    $('checkoutButton').style.opacity = .5;
    return;
  }

  $('checkoutButton').disabled = false;
  $('checkoutButton').style.opacity = 1;
  $('cartItems').innerHTML = entries.map(({product, quantity}) => `
    <div class="cart-item">
      <img src="${escapeAttr(product.image || 'https://placehold.co/100x100?text=Product')}" alt="">
      <div class="cart-item-info">
        <strong>${escapeHtml(product.name)}</strong>
        <div>${money(product.price * quantity)}</div>
        <div class="qty">
          <button data-dec="${product.id}">−</button>
          <span>${quantity}</span>
          <button data-inc="${product.id}">+</button>
          <button data-remove="${product.id}">Удалить</button>
        </div>
      </div>
    </div>
  `).join('');

  document.querySelectorAll('[data-inc]').forEach(b => b.onclick = () => changeQty(Number(b.dataset.inc), 1));
  document.querySelectorAll('[data-dec]').forEach(b => b.onclick = () => changeQty(Number(b.dataset.dec), -1));
  document.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => {
    delete state.cart[b.dataset.remove];
    saveCart();
    renderCart();
  });
}

function changeQty(id, delta) {
  state.cart[id] = (state.cart[id] || 0) + delta;
  if (state.cart[id] <= 0) delete state.cart[id];
  saveCart();
  renderCart();
}

function open(id) { $(id).classList.remove('hidden'); }
function close(id) { $(id).classList.add('hidden'); }

$('cartButton').onclick = () => { renderCart(); open('cartSheet'); };
$('closeCart').onclick = () => close('cartSheet');
$('closeCheckout').onclick = () => close('checkoutSheet');

$('checkoutButton').onclick = () => {
  close('cartSheet');
  const user = tg?.initDataUnsafe?.user;
  if (user && !$('name').value) {
    $('name').value = [user.first_name, user.last_name].filter(Boolean).join(' ');
  }
  open('checkoutSheet');
};

$('submitOrder').onclick = async () => {
  const items = cartEntries().map(({product, quantity}) => ({
    productId: product.id,
    quantity
  }));

  if (!items.length) return toast('Корзина пуста');

  const btn = $('submitOrder');
  btn.disabled = true;
  btn.textContent = 'Создаём заказ…';

  try {
    const response = await fetch('/api/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': tg?.initData || ''
      },
      body: JSON.stringify({
        items,
        customer: {
          name: $('name').value,
          phone: $('phone').value,
          address: $('address').value
        }
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Ошибка');

    state.cart = {};
    saveCart();
    renderCart();
    close('checkoutSheet');

    const message = `Заказ #${data.orderId} создан на сумму ${money(data.total)}`;
    if (tg?.showPopup) {
      tg.showPopup({ title: 'Готово', message, buttons: [{ type: 'ok' }] });
    } else {
      toast(message);
    }
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Создать заказ';
  }
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;'
  }[c]));
}
function escapeAttr(value) { return escapeHtml(value); }

let toastTimer;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

async function init() {
  try {
    const res = await fetch('/api/products');
    state.products = await res.json();
    renderCategories();
    renderProducts();
    renderCart();
  } catch {
    $('products').innerHTML = '<div class="empty">Не удалось загрузить каталог</div>';
  }
}

init();
