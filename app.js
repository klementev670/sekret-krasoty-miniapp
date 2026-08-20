// ==== Настройки ====
// Прокси на стороне бота (см. webapp_server.py) — ключ к сайту здесь не хранится,
// он остаётся только на сервере бота. Подставить реальный https-адрес после публикации.
const PROXY_BASE_URL = "https://laughing-zebra-q59779qr9vxcx74g-8080.app.github.dev/api";

const PER_PAGE = 50;

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

// ==== Состояние ====
let loadedProducts = [];
let currentPage = 1;
let currentQuery = "";
let totalPages = 1;
let isLoading = false;

const CART_STORAGE_KEY = "sk_cart_v1";

/** @type {Map<string, {product: object, qty: number}>} */
const cart = new Map();

function saveCart() {
  localStorage.setItem(CART_STORAGE_KEY, JSON.stringify([...cart.values()]));
}

function loadCart() {
  try {
    const raw = localStorage.getItem(CART_STORAGE_KEY);
    const items = raw ? JSON.parse(raw) : [];
    for (const { product, qty } of items) {
      cart.set(String(product.id), { product, qty });
    }
  } catch {
    // повреждённые данные в хранилище — начинаем с пустой корзины
  }
}

// ==== DOM ====
const catalogEl = document.getElementById("catalog");
const loadMoreWrap = document.getElementById("load-more-wrap");
const loadMoreBtn = document.getElementById("load-more-btn");
const searchInput = document.getElementById("search-input");
const cartBtn = document.getElementById("cart-btn");
const cartCountEl = document.getElementById("cart-count");

const productSheet = document.getElementById("product-sheet");
const productSheetContent = document.getElementById("product-sheet-content");

const cartSheet = document.getElementById("cart-sheet");
const cartItemsEl = document.getElementById("cart-items");
const cartTotalEl = document.getElementById("cart-total-value");

const checkoutForm = document.getElementById("checkout-form");
const checkoutStatus = document.getElementById("checkout-status");

// ==== Утилиты ====
async function proxyFetch(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const res = await fetch(`${PROXY_BASE_URL}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Ошибка ${res.status}`);
  }
  return data;
}

function formatPrice(value) {
  return `${Number(value).toLocaleString("ru-RU")} ₽`;
}

function stockLabel(stockStatus) {
  if (stockStatus === "instock") return "В наличии";
  if (stockStatus === "onbackorder") return "Под заказ";
  return "Нет в наличии";
}

function isPurchasable(product) {
  return product.stock_status === "instock" || product.stock_status === "onbackorder";
}

// ==== Каталог ====
async function loadCatalog({ reset = false } = {}) {
  if (isLoading) return;
  isLoading = true;

  if (reset) {
    currentPage = 1;
    loadedProducts = [];
    catalogEl.innerHTML = `<p class="state-msg">Загружаем каталог…</p>`;
  }

  try {
    const params = new URLSearchParams({ page: String(currentPage), per_page: String(PER_PAGE) });
    if (currentQuery) params.set("search", currentQuery);

    const data = await proxyFetch(`/products?${params.toString()}`);
    const items = (data.items || []).filter(isPurchasable);
    totalPages = data.total_pages || 1;

    loadedProducts = reset ? items : [...loadedProducts, ...items];
    renderCatalog(loadedProducts);
    loadMoreWrap.hidden = currentPage >= totalPages;
  } catch (err) {
    console.error(err);
    catalogEl.innerHTML = `<p class="state-msg">Не удалось загрузить каталог. Потяните вниз, чтобы обновить, или откройте бота ещё раз.</p>`;
    loadMoreWrap.hidden = true;
  } finally {
    isLoading = false;
  }
}

function renderCatalog(list) {
  if (!list.length) {
    catalogEl.innerHTML = `<p class="state-msg">Ничего не найдено</p>`;
    return;
  }
  catalogEl.innerHTML = "";
  for (const p of list) {
    const card = document.createElement("div");
    card.className = "product-card";
    card.innerHTML = `
      <img class="product-card__img" src="${p.image || ""}" alt="${p.name}" loading="lazy" />
      <div class="product-card__body">
        <div class="product-card__name">${p.name}</div>
        <div class="product-card__stock">${stockLabel(p.stock_status)}</div>
        <div class="product-card__price">${formatPrice(p.price)}</div>
      </div>
    `;
    card.addEventListener("click", () => openProduct(p));
    catalogEl.appendChild(card);
  }
}

loadMoreBtn.addEventListener("click", () => {
  currentPage += 1;
  loadCatalog();
});

let searchDebounce;
searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    currentQuery = searchInput.value.trim();
    loadCatalog({ reset: true });
  }, 400);
});

// ==== Карточка товара ====
async function openProduct(productSummary) {
  showSheet(productSheet);
  productSheetContent.innerHTML = `<p class="state-msg">Загружаем…</p>`;
  let product = productSummary;
  try {
    product = await proxyFetch(`/products/${productSummary.id}`);
  } catch {
    // если не удалось получить подробности — показываем то, что уже есть из каталога
  }
  renderProductSheet(product);
}

function renderProductSheet(product) {
  const key = String(product.id);
  const inCart = cart.get(key);
  const purchasable = isPurchasable(product);

  productSheetContent.innerHTML = `
    <img class="pd-img" src="${product.image || ""}" alt="${product.name}" />
    <h2 class="pd-name">${product.name}</h2>
    <div class="pd-price">${formatPrice(product.price)}</div>
    <p class="pd-desc">${product.short_description || product.description || ""}</p>
    <button class="pd-add" id="pd-add-btn" ${purchasable ? "" : "disabled"}>
      ${!purchasable ? "Нет в наличии" : inCart ? `В корзине: ${inCart.qty}` : "Добавить в корзину"}
    </button>
  `;
  const btn = document.getElementById("pd-add-btn");
  if (purchasable) {
    btn.addEventListener("click", () => {
      addToCart(product);
      renderProductSheet(product);
    });
  }
}

// ==== Корзина ====
function addToCart(product) {
  const key = String(product.id);
  const existing = cart.get(key);
  cart.set(key, { product, qty: existing ? existing.qty + 1 : 1 });
  updateCartBadge();
  saveCart();
}

function changeQty(productId, delta) {
  const key = String(productId);
  const existing = cart.get(key);
  if (!existing) return;
  const nextQty = existing.qty + delta;
  if (nextQty <= 0) {
    cart.delete(key);
  } else {
    existing.qty = nextQty;
  }
  updateCartBadge();
  renderCart();
  saveCart();
}

function updateCartBadge() {
  const count = [...cart.values()].reduce((sum, item) => sum + item.qty, 0);
  cartCountEl.hidden = count === 0;
  cartCountEl.textContent = String(count);
}

function cartTotal() {
  return [...cart.values()].reduce((sum, item) => sum + Number(item.product.price) * item.qty, 0);
}

function renderCart() {
  if (cart.size === 0) {
    cartItemsEl.innerHTML = `<p class="state-msg">Корзина пуста</p>`;
  } else {
    cartItemsEl.innerHTML = "";
    for (const { product, qty } of cart.values()) {
      const row = document.createElement("div");
      row.className = "cart-item";
      row.innerHTML = `
        <div class="cart-item__name">${product.name}</div>
        <div class="cart-item__qty">
          <button class="qty-btn" data-action="dec">−</button>
          <span>${qty}</span>
          <button class="qty-btn" data-action="inc">+</button>
        </div>
        <div class="cart-item__price">${formatPrice(Number(product.price) * qty)}</div>
      `;
      row.querySelector('[data-action="dec"]').addEventListener("click", () => changeQty(product.id, -1));
      row.querySelector('[data-action="inc"]').addEventListener("click", () => changeQty(product.id, 1));
      cartItemsEl.appendChild(row);
    }
  }
  cartTotalEl.textContent = formatPrice(cartTotal());
}

cartBtn.addEventListener("click", () => {
  renderCart();
  showSheet(cartSheet);
});

// ==== Оформление заказа ====
checkoutForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (cart.size === 0) return;

  const submitBtn = checkoutForm.querySelector(".cf-submit");
  submitBtn.disabled = true;
  checkoutStatus.hidden = true;

  const payload = {
    items: [...cart.values()].map(({ product, qty }) => ({ product_id: product.id, quantity: qty })),
    customer: {
      name: document.getElementById("cf-name").value.trim(),
      phone: document.getElementById("cf-phone").value.trim(),
      email: document.getElementById("cf-email").value.trim(),
      address: document.getElementById("cf-address").value.trim(),
    },
    source: "telegram_bot",
  };

  try {
    const order = await proxyFetch("/orders", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    checkoutStatus.hidden = false;
    checkoutStatus.textContent = `Заказ №${order.order_number || order.order_id} на сумму ${formatPrice(order.total)} оформлен! Мы свяжемся с вами для подтверждения.`;

    if (tg?.sendData) {
      tg.sendData(JSON.stringify({ type: "order_created", order_id: order.order_id }));
    }

    cart.clear();
    updateCartBadge();
    saveCart();

    setTimeout(() => {
      tg?.close();
    }, 2000);
  } catch (err) {
    console.error(err);
    checkoutStatus.hidden = false;
    checkoutStatus.textContent = err.message || "Не получилось оформить заказ. Попробуйте ещё раз чуть позже.";
  } finally {
    submitBtn.disabled = false;
  }
});

// ==== Sheets ====
function showSheet(sheet) {
  sheet.hidden = false;
}
function hideSheet(sheet) {
  sheet.hidden = true;
}
document.querySelectorAll("[data-close]").forEach((el) => {
  el.addEventListener("click", () => {
    hideSheet(productSheet);
    hideSheet(cartSheet);
  });
});

// ==== Старт ====
loadCart();
updateCartBadge();
loadCatalog({ reset: true });
