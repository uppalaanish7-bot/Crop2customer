const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const VIEWS = [
  "#home-view",
  "#marketplace-view",
  "#product-detail-view",
  "#login-view",
  "#checkout-view",
  "#order-confirmation-view",
  "#dashboard-view",
];

let currentUser = null;
let currentAuthRole = "buyer";
let currentPhone = "";
let authFlowBusy = false;
let selectedPhoto = null;
let sellerProducts = [];
let sellerOrders = [];
let buyerOrders = [];
let activeProductDetail = null;
let activeCheckoutProduct = null;
let activeCheckoutQty = 1;
let pendingBuyProduct = null;
let checkoutIdempotencyKey = "";
let noticeTimer = null;

function showView(selector, scrollTop = true) {
  VIEWS.forEach((v) => {
    const el = $(v);
    if (el) el.classList.toggle("hidden", v !== selector);
  });
  $$("[data-nav]").forEach((link) => {
    const target = link.dataset.nav;
    const isMatch =
      (target === "home" && selector === "#home-view") ||
      (target === "marketplace" &&
        (selector === "#marketplace-view" || selector === "#product-detail-view"));
    link.classList.toggle("active", isMatch);
  });
  const nav = $("#main-nav");
  if (nav && nav.classList.contains("open")) {
    nav.classList.remove("open");
    $("#mobile-menu-toggle")?.setAttribute("aria-expanded", "false");
  }
  if (scrollTop) {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  updateHeaderAuthUI();
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Something went wrong. Please try again.");
  }
  return payload;
}

function showNotice(message, isError = false) {
  const notice = $("#notice");
  if (!notice) return;
  notice.textContent = message;
  notice.classList.toggle("error", isError);
  notice.classList.remove("hidden");
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => notice.classList.add("hidden"), 5500);
}

function showLoginError(message) {
  const box = $("#login-error");
  if (!box) return;
  box.textContent = message;
  box.classList.remove("hidden");
}

function setBusy(button, busy) {
  if (!button) return;
  const label = button.querySelector(".button-label");
  const loader = button.querySelector(".button-loader");
  button.disabled = busy;
  if (label) label.classList.toggle("hidden", busy);
  if (loader) loader.classList.toggle("hidden", !busy);
}

function setAuthFlowBusy(busy) {
  authFlowBusy = busy;
  $$(
    "[data-switch-role], [data-auth-trigger], #resend-otp-btn, #change-phone, #back-home, #nav-dashboard-btn, #logout-button, #phone, #code",
  ).forEach((control) => {
    control.disabled = busy;
  });
}

function money(value) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function updateHeaderAuthUI() {
  const guestActions = $("#nav-guest-actions");
  const userActions = $("#nav-user-actions");
  const badge = $("#nav-user-badge");
  const marketOrdersBtn = $("#market-my-orders-btn");
  const dashboardBtn = $("#nav-dashboard-btn");

  if (currentUser) {
    guestActions?.classList.add("hidden");
    userActions?.classList.remove("hidden");
    const roleLabel = currentUser.role === "seller" ? "Seller Dashboard" : "Buyer Dashboard";
    if (badge) badge.textContent = `${roleLabel} (${currentUser.phone})`;
    if (marketOrdersBtn) {
      marketOrdersBtn.classList.toggle("hidden", currentUser.role !== "buyer");
    }
    const loginViewVisible = !$("#login-view")?.classList.contains("hidden");
    dashboardBtn?.classList.toggle(
      "hidden",
      loginViewVisible && currentUser.role !== currentAuthRole,
    );
  } else {
    guestActions?.classList.remove("hidden");
    userActions?.classList.add("hidden");
    marketOrdersBtn?.classList.add("hidden");
    dashboardBtn?.classList.add("hidden");
  }
}

/* ==================== LANDING DATA & STATS ==================== */
async function loadLandingData() {
  try {
    const [stats, prodData] = await Promise.all([
      api("/api/stats"),
      api("/api/public/products?status=available&perPage=12"),
    ]);
    $("#stat-active-listings").textContent = String(stats.activeListings ?? 0);
    $("#stat-categories").textContent = String(stats.categoriesCount || 8);
    $("#stat-orders-placed").textContent = String(stats.ordersPlaced ?? 0);

    const items = prodData.products || [];
    const featuredContainer = $("#landing-featured-grid");
    const recentContainer = $("#landing-recent-grid");
    if (featuredContainer) {
      featuredContainer.replaceChildren();
      items.slice(0, 3).forEach((p) => featuredContainer.append(buildProductCard(p, { market: true })));
    }
    if (recentContainer) {
      recentContainer.replaceChildren();
      items.slice(0, 6).forEach((p) => recentContainer.append(buildProductCard(p, { market: true })));
    }
  } catch (err) {
    console.error("Failed to load landing data:", err);
  }
}

/* ==================== PRODUCT CARD BUILDER ==================== */
function buildProductCard(product, options = {}) {
  const card = el("article", "product-card");

  const imageWrap = el("div", "product-image-wrap");
  const image = el("img", "product-image");
  image.src = product.imageUrl;
  image.alt = `${product.name} — ${product.category || "Agricultural Crop"}`;
  image.loading = "lazy";
  image.onerror = () => {
    image.onerror = null;
    image.src = "/static/images/crop_tomatoes.jpg";
  };

  const badgeRow = el("div", "badge-row");
  const isAvailable = product.status === "available" && Number(product.availableQuantity) > 0;
  const statusText = isAvailable
    ? `In Stock · ${product.availableQuantity} ${product.unit}`
    : product.status === "unavailable"
    ? "Unavailable"
    : "Sold Out";
  const statusBadge = el(
    "span",
    `status-badge${isAvailable ? "" : " sold"}`,
    statusText
  );
  const catBadge = el("span", "category-pill", product.category || "Produce");
  badgeRow.append(statusBadge, catBadge);
  imageWrap.append(image, badgeRow);

  const content = el("div", "product-content");
  const top = el("div", "product-topline");
  const title = el("h3", "product-title", product.name);
  const priceBox = el("div", "product-price-box");
  priceBox.append(
    el("span", "product-price", money(product.price)),
    el("span", "product-unit", `per ${product.unit || "kg"}`)
  );
  top.append(title, priceBox);

  const metaList = el("div", "product-meta-list");
  metaList.append(
    el("span", "", `🌾 ${product.farmName || product.sellerName || "Direct Farmer"}`),
    el("span", "", `📍 ${product.farmLocation || "Local Farm"}`)
  );
  if (product.variety) {
    metaList.append(el("span", "", `🏷️ ${product.variety}`));
  }
  if (product.harvestDate) {
    metaList.append(el("span", "", `🗓️ Harvest: ${product.harvestDate}`));
  }

  const desc = el("p", "product-description", product.description);
  content.append(top, metaList, desc);

  const actions = el("div", "card-actions");
  if (options.sellerManage) {
    const toggleBtn = el(
      "button",
      "btn btn-secondary btn-sm",
      product.status === "available" ? "Mark Unavailable" : "Mark Available"
    );
    toggleBtn.type = "button";
    toggleBtn.addEventListener("click", () => toggleProductAvailability(product));

    const editBtn = el("button", "btn btn-outline btn-sm", "Edit");
    editBtn.type = "button";
    editBtn.addEventListener("click", () => editProduct(product));

    const delBtn = el("button", "btn btn-outline-danger btn-sm", "Delete");
    delBtn.type = "button";
    delBtn.addEventListener("click", () => deleteProduct(product));

    actions.append(toggleBtn, editBtn, delBtn);
  } else {
    const detailBtn = el("button", "btn btn-outline btn-sm", "View Details");
    detailBtn.type = "button";
    detailBtn.addEventListener("click", () => openProductDetail(product.id));

    const buyBtn = el(
      "button",
      "btn btn-primary btn-sm",
      isAvailable ? "Buy Now" : "Sold Out"
    );
    buyBtn.type = "button";
    buyBtn.disabled = !isAvailable;
    buyBtn.addEventListener("click", () => initiateBuyFlow(product, 1));

    actions.append(detailBtn, buyBtn);
  }

  content.append(actions);
  card.append(imageWrap, content);
  return card;
}

/* ==================== MARKETPLACE DISCOVERY & FILTERS ==================== */
async function loadMarket() {
  const loading = $("#market-loading");
  const grid = $("#market-grid");
  const empty = $("#market-empty");
  const error = $("#market-error");
  const summary = $("#market-results-summary");

  loading?.classList.remove("hidden");
  error?.classList.add("hidden");
  empty?.classList.add("hidden");
  try {
    const params = new URLSearchParams({
      q: ($("#market-search")?.value || "").trim(),
      category: $("#market-category")?.value || "all",
      location: ($("#market-location")?.value || "").trim(),
      minPrice: ($("#market-min-price")?.value || "").trim(),
      maxPrice: ($("#market-max-price")?.value || "").trim(),
      status: $("#market-status")?.value || "available",
      sort: $("#market-sort")?.value || "newest",
    });
    const result = await api(`/api/public/products?${params.toString()}`);
    const items = result.products || [];
    grid.replaceChildren();
    items.forEach((p) => grid.append(buildProductCard(p, { market: true })));
    empty?.classList.toggle("hidden", items.length > 0);
    if (summary) {
      summary.textContent = `Showing ${items.length} crop listing${items.length === 1 ? "" : "s"}`;
    }
  } catch (err) {
    grid.replaceChildren();
    if ($("#market-error-message")) $("#market-error-message").textContent = err.message;
    error?.classList.remove("hidden");
    if (summary) summary.textContent = "Crop listings are temporarily unavailable";
  } finally {
    loading?.classList.add("hidden");
  }
}

async function enterBuyerMarketplace(user) {
  currentUser = user;
  currentAuthRole = "buyer";
  updateHeaderAuthUI();
  if (pendingBuyProduct) {
    const pending = pendingBuyProduct;
    pendingBuyProduct = null;
    openCheckoutView(pending.product, pending.quantity);
    return;
  }
  showView("#marketplace-view");
  await loadMarket();
}

function resetMarketFilters() {
  if ($("#market-search")) $("#market-search").value = "";
  if ($("#market-category")) $("#market-category").value = "all";
  if ($("#market-location")) $("#market-location").value = "";
  if ($("#market-min-price")) $("#market-min-price").value = "";
  if ($("#market-max-price")) $("#market-max-price").value = "";
  if ($("#market-status")) $("#market-status").value = "available";
  if ($("#market-sort")) $("#market-sort").value = "newest";
  loadMarket();
}

/* ==================== PRODUCT DETAIL VIEW ==================== */
async function openProductDetail(productId) {
  try {
    const { product } = await api(`/api/public/products/${productId}`);
    activeProductDetail = product;
    renderProductDetail(product);
    showView("#product-detail-view");
  } catch (err) {
    showNotice(err.message, true);
  }
}

function renderProductDetail(product) {
  const container = $("#product-detail-container");
  if (!container) return;
  container.replaceChildren();

  const isAvailable = product.status === "available" && Number(product.availableQuantity) > 0;

  const grid = el("div", "detail-grid");
  const imgBox = el("div", "detail-image-box");
  const img = el("img", "");
  img.src = product.imageUrl;
  img.alt = product.name;
  img.onerror = () => {
    img.onerror = null;
    img.src = "/static/images/crop_tomatoes.jpg";
  };
  imgBox.append(img);

  const infoCol = el("div", "detail-info-col");
  const eyebrow = el(
    "span",
    "section-eyebrow",
    `${product.category} · ${product.qualityGrade || "Standard Grade"}`
  );
  const title = el("h1", "page-title", product.name);

  const priceBanner = el("div", "detail-price-banner");
  priceBanner.append(
    el("strong", "", money(product.price)),
    el("span", "", `per ${product.unit} · Direct Farm Price`)
  );

  const desc = el("p", "", product.description);

  const specs = el("div", "detail-specs-grid");
  const addSpec = (label, val) => {
    if (!val) return;
    const b = el("div", "spec-box");
    b.append(el("span", "", label), el("strong", "", String(val)));
    specs.append(b);
  };
  addSpec("Available Stock", `${product.availableQuantity} ${product.unit}`);
  addSpec("Status", isAvailable ? "Available for Immediate Order" : "Sold Out / Unavailable");
  addSpec("Farmer / Seller", product.sellerName);
  addSpec("Farm Location", product.farmLocation);
  if (product.variety) addSpec("Crop Variety", product.variety);
  if (product.harvestDate) addSpec("Harvest Date", product.harvestDate);
  if (product.sellerPhone) addSpec("Seller Contact", product.sellerPhone);

  infoCol.append(eyebrow, title, priceBanner, desc, specs);

  if (isAvailable) {
    const purchaseBox = el("div", "detail-purchase-box");
    const qtyWrap = el("div", "detail-qty-field");
    const qtyLabel = el("label", "", `Quantity (${product.unit})`);
    qtyLabel.setAttribute("for", "detail-qty-input");
    const qtyInput = el("input", "");
    qtyInput.id = "detail-qty-input";
    qtyInput.type = "number";
    qtyInput.min = "0.5";
    qtyInput.max = String(product.availableQuantity);
    qtyInput.step = "0.5";
    qtyInput.value = String(Math.min(1, product.availableQuantity));
    qtyWrap.append(qtyLabel, qtyInput);

    const buyBtn = el("button", "btn btn-primary btn-lg", "Buy Now — Enter Delivery Address →");
    buyBtn.type = "button";
    buyBtn.addEventListener("click", () => {
      const q = parseFloat(qtyInput.value) || 1;
      if (q <= 0 || q > product.availableQuantity) {
        showNotice(`Please select a quantity between 0.5 and ${product.availableQuantity} ${product.unit}.`, true);
        return;
      }
      initiateBuyFlow(product, q);
    });

    purchaseBox.append(qtyWrap, buyBtn);
    infoCol.append(purchaseBox);
  } else {
    const soldBanner = el(
      "div",
      "alert-box alert-error",
      "This crop listing is currently unavailable or sold out and cannot be ordered."
    );
    infoCol.append(soldBanner);
  }

  grid.append(imgBox, infoCol);
  container.append(grid);
}

/* ==================== BUY & CHECKOUT FLOW (NO PAYMENT GATEWAY) ==================== */
function initiateBuyFlow(product, quantity = 1) {
  if (!currentUser || currentUser.role !== "buyer") {
    pendingBuyProduct = { product, quantity };
    switchAuthRole("buyer");
    showNotice("Please sign in as a Buyer with your mobile number to place this crop order.");
    return;
  }
  if (currentUser.phone === product.sellerPhone) {
    showNotice("You cannot purchase a crop listing uploaded by your own phone number.", true);
    return;
  }
  openCheckoutView(product, quantity);
}

function openCheckoutView(product, quantity = 1) {
  activeCheckoutProduct = product;
  activeCheckoutQty = Math.min(Math.max(0.5, Number(quantity) || 1), Number(product.availableQuantity) || 1);
  checkoutIdempotencyKey = `chk-${product.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  $("#checkout-product-id").value = String(product.id);
  $("#checkout-unit-label").textContent = product.unit;
  const qtyInput = $("#checkout-quantity");
  qtyInput.max = String(product.availableQuantity);
  qtyInput.value = String(activeCheckoutQty);
  $("#checkout-stock-hint").textContent = `Maximum available from farmer: ${product.availableQuantity} ${product.unit}`;

  if (currentUser) {
    if (!$("#checkout-fullname").value && currentUser.fullName) {
      $("#checkout-fullname").value = currentUser.fullName;
    }
    $("#checkout-mobile").value = currentUser.phone || "";
    if (!$("#checkout-city").value && currentUser.location) {
      $("#checkout-city").value = currentUser.location;
    }
  }
  $("#checkout-error")?.classList.add("hidden");
  updateCheckoutSummary();
  showView("#checkout-view");
}

function updateCheckoutSummary() {
  if (!activeCheckoutProduct) return;
  const qty = Math.max(0, parseFloat($("#checkout-quantity")?.value) || 0);
  const total = qty * activeCheckoutProduct.price;
  $("#checkout-live-total").textContent = money(total);

  const summaryBox = $("#checkout-summary-content");
  if (!summaryBox) return;
  summaryBox.replaceChildren();

  const img = el("img", "order-thumb");
  img.src = activeCheckoutProduct.imageUrl;
  img.alt = activeCheckoutProduct.name;
  img.style.width = "100%";
  img.style.height = "150px";
  img.style.marginBottom = "12px";

  const title = el("h4", "", activeCheckoutProduct.name);
  title.style.margin = "0 0 6px";

  const sellerLine = el("p", "field-hint", `Seller: ${activeCheckoutProduct.sellerName} (${activeCheckoutProduct.farmLocation})`);
  const breakdown = el("div", "confirmation-details-box");
  breakdown.style.margin = "14px 0 0";
  breakdown.innerHTML = `
    <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
      <span>Unit Price:</span>
      <strong>${money(activeCheckoutProduct.price)} / ${activeCheckoutProduct.unit}</strong>
    </div>
    <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
      <span>Selected Quantity:</span>
      <strong>${qty} ${activeCheckoutProduct.unit}</strong>
    </div>
    <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
      <span>Payment Mode:</span>
      <strong>Direct / No Online Gateway</strong>
    </div>
    <div style="display:flex;justify-content:space-between;padding-top:8px;border-top:1px solid var(--border);font-size:16px;">
      <strong>Order Total:</strong>
      <strong style="color:var(--forest);">${money(total)}</strong>
    </div>
  `;
  summaryBox.append(img, title, sellerLine, breakdown);
}

/* ==================== AUTHENTICATION FLOW ==================== */
function switchAuthRole(role) {
  if (authFlowBusy) return;
  currentAuthRole = role === "seller" ? "seller" : "buyer";
  const isSeller = currentAuthRole === "seller";
  currentPhone = "";

  $("#switch-role-buyer")?.classList.toggle("active", !isSeller);
  $("#switch-role-seller")?.classList.toggle("active", isSeller);
  $("#seller-onboarding-fields")?.classList.toggle("hidden", !isSeller);
  $("#phone").value = "";

  $("#auth-role-eyebrow").textContent = isSeller
    ? "SELLER ACCOUNT · FARMER PORTAL"
    : "BUYER ACCOUNT · CUSTOMER PORTAL";
  $("#login-title").textContent = isSeller
    ? "List Your Harvest & Reach Customers Directly"
    : "Buy Fresh Crops Directly From Farmers";
  $("#login-subtitle").textContent = isSeller
    ? "Sign in with your mobile number to upload crop listings, manage inventory, and fulfil buyer orders."
    : "Sign in with your mobile number to order fresh farm produce with doorstep address delivery.";

  $("#auth-step-indicator").textContent = `STEP 1 OF 2 · ${isSeller ? "SELLER" : "BUYER"} MOBILE LOGIN`;
  $("#auth-card-heading").textContent = isSeller ? "Continue as Seller" : "Continue as Buyer";

  $("#phone-form")?.classList.remove("hidden");
  $("#code-form")?.classList.add("hidden");
  $("#login-error")?.classList.add("hidden");
  $("#code").value = "";
  showView("#login-view");
}

/* ==================== BUYER & SELLER DASHBOARDS ==================== */
async function openDashboard(user) {
  currentUser = user;
  currentAuthRole = user.role;
  updateHeaderAuthUI();

  const isSeller = user.role === "seller";
  $("#dashboard-eyebrow").textContent = isSeller
    ? "FARMER / SELLER DASHBOARD"
    : "BUYER MARKETPLACE DASHBOARD";
  $("#dashboard-title").textContent = isSeller
    ? user.farmName || user.fullName || "Your Farm Storefront"
    : user.fullName ? `Welcome, ${user.fullName}` : "Your Buyer Account";
  $("#dashboard-description").textContent = isSeller
    ? "Upload available crops, manage stock quantities, and fulfil incoming customer orders."
    : "Review your direct farm orders, delivery addresses, and order fulfilment status.";
  $("#account-chip").textContent = `${isSeller ? "Seller" : "Buyer"} · ${user.phone}`;

  $("#seller-add-crop-top-btn")?.classList.toggle("hidden", !isSeller);
  $("#buyer-dashboard-section")?.classList.toggle("hidden", isSeller);
  $("#seller-section")?.classList.toggle("hidden", !isSeller);

  // Pre-fill profile form
  if ($("#profile-fullname")) $("#profile-fullname").value = user.fullName || "";
  if ($("#profile-farmname")) $("#profile-farmname").value = user.farmName || "";
  if ($("#profile-location")) $("#profile-location").value = user.location || "";
  if ($("#profile-bio")) $("#profile-bio").value = user.bio || "";
  $("#profile-farm-group")?.classList.toggle("hidden", !isSeller);

  if (!isSeller && pendingBuyProduct) {
    const pending = pendingBuyProduct;
    pendingBuyProduct = null;
    openCheckoutView(pending.product, pending.quantity);
    return;
  }

  showView("#dashboard-view");
  $("#loading")?.classList.remove("hidden");
  try {
    if (isSeller) {
      await Promise.all([loadSellerProducts(), loadSellerOrders()]);
    } else {
      await loadBuyerOrders();
    }
  } catch (err) {
    showNotice(err.message, true);
  } finally {
    $("#loading")?.classList.add("hidden");
  }
}

async function loadBuyerOrders() {
  const result = await api("/api/orders");
  buyerOrders = result.orders || [];
  $("#buyer-order-count").textContent = String(buyerOrders.length);
  $("#buyer-tab-order-count").textContent = String(buyerOrders.length);

  const container = $("#purchases-grid");
  container.replaceChildren();
  buyerOrders.forEach((ord) => container.append(buildOrderCard(ord, { isSeller: false })));
  $("#purchases-empty")?.classList.toggle("hidden", buyerOrders.length > 0);
}

async function loadSellerProducts() {
  const result = await api("/api/seller/products");
  sellerProducts = result.products || [];

  const total = sellerProducts.length;
  const active = sellerProducts.filter((p) => p.status === "available" && p.availableQuantity > 0).length;
  const inactive = total - active;

  $("#seller-kpi-total").textContent = String(total);
  $("#seller-kpi-active").textContent = String(active);
  $("#seller-kpi-inactive").textContent = String(inactive);

  renderSellerProductsList();
}

function renderSellerProductsList() {
  const filter = $("#seller-filter")?.value || "all";
  const filtered = sellerProducts.filter((item) => {
    if (filter === "available") return item.status === "available" && item.availableQuantity > 0;
    if (filter === "sold") return item.status !== "available" || item.availableQuantity <= 0;
    return true;
  });

  const container = $("#seller-grid");
  container.replaceChildren();
  filtered.forEach((p) => container.append(buildProductCard(p, { sellerManage: true })));
  $("#seller-empty")?.classList.toggle("hidden", filtered.length > 0);
}

async function loadSellerOrders() {
  const result = await api("/api/seller/orders");
  sellerOrders = result.orders || [];
  $("#seller-kpi-orders").textContent = String(sellerOrders.length);
  $("#seller-tab-orders-count").textContent = String(sellerOrders.length);

  const container = $("#sales-grid");
  container.replaceChildren();
  sellerOrders.forEach((ord) => container.append(buildOrderCard(ord, { isSeller: true })));
  $("#sales-empty")?.classList.toggle("hidden", sellerOrders.length > 0);
}

function buildOrderCard(order, { isSeller }) {
  const card = el("article", "order-card");

  const img = el("img", "order-thumb");
  img.src = order.imageUrl;
  img.alt = order.productName;
  img.onerror = () => {
    img.onerror = null;
    img.src = "/static/images/crop_tomatoes.jpg";
  };

  const body = el("div", "order-body");
  const headerLine = el("div", "order-header-line");
  const statusClass =
    order.status === "Cancelled"
      ? "status-cancelled"
      : order.status === "Delivered"
      ? "status-delivered"
      : "";
  headerLine.append(
    el("span", "order-id-pill", order.orderId),
    el("span", `status-pill ${statusClass}`, order.status),
    el("span", "field-hint", `Placed: ${formatDate(order.createdAt)}`)
  );

  const title = el("h3", "product-title", order.productName);
  const meta = el(
    "p",
    "field-hint",
    `Quantity: ${order.quantity} ${order.unit} × ${money(order.unitPrice)}/${order.unit} · ${
      isSeller ? `Buyer Mobile: ${order.buyerPhone}` : `Seller: ${order.sellerPhone}`
    }`
  );

  body.append(headerLine, title, meta);

  if (order.deliveryAddress) {
    const addr = order.deliveryAddress;
    const addrBox = el("div", "order-address-box");
    addrBox.innerHTML = `
      <strong>Delivery Address:</strong> ${addr.fullName} (${addr.mobile})<br>
      ${addr.houseStreet}, ${addr.villageCity}, ${addr.district} District, ${addr.state} — <strong>PIN ${addr.pinCode}</strong>
      ${addr.instructions ? `<br><em>Note: ${addr.instructions}</em>` : ""}
    `;
    body.append(addrBox);
  }

  const actionsCol = el("div", "order-actions-col");
  actionsCol.append(
    el("span", "order-total-price", money(order.totalAmount)),
    el("span", "field-hint", "Payment: Direct / Offline")
  );

  if (!isSeller && order.canBuyerCancel) {
    const cancelBtn = el("button", "btn btn-outline-danger btn-sm", "Cancel Order");
    cancelBtn.type = "button";
    cancelBtn.addEventListener("click", async () => {
      try {
        cancelBtn.disabled = true;
        await api(`/api/orders/${order.orderId}/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "Cancelled by buyer" }),
        });
        showNotice(`Order ${order.orderId} cancelled and stock restored.`);
        await Promise.all([loadBuyerOrders(), loadLandingData()]);
      } catch (err) {
        showNotice(err.message, true);
        cancelBtn.disabled = false;
      }
    });
    actionsCol.append(cancelBtn);
  }

  if (isSeller && Array.isArray(order.allowedSellerTransitions) && order.allowedSellerTransitions.length > 0) {
    const statusSelect = el("select", "");
    statusSelect.setAttribute("aria-label", `Update status for ${order.orderId}`);
    const defaultOpt = el("option", "", "Update Order Status…");
    defaultOpt.value = "";
    statusSelect.append(defaultOpt);
    order.allowedSellerTransitions.forEach((st) => {
      const opt = el("option", "", st === "Cancelled" ? "Reject / Cancel Order" : `Mark as ${st}`);
      opt.value = st;
      statusSelect.append(opt);
    });
    statusSelect.addEventListener("change", async () => {
      const nextStatus = statusSelect.value;
      if (!nextStatus) return;
      try {
        statusSelect.disabled = true;
        await api(`/api/seller/orders/${order.orderId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: nextStatus }),
        });
        showNotice(`Order ${order.orderId} updated to ${nextStatus}.`);
        await Promise.all([loadSellerOrders(), loadSellerProducts()]);
      } catch (err) {
        showNotice(err.message, true);
        statusSelect.disabled = false;
      }
    });
    actionsCol.append(statusSelect);
  }

  card.append(img, body, actionsCol);
  return card;
}

/* ==================== SELLER LISTING MANAGEMENT ==================== */
function openCropForm(isEdit = false) {
  const wrapper = $("#seller-form-wrapper");
  wrapper?.classList.remove("hidden");
  if (!isEdit) {
    resetProductForm();
    if (currentUser?.location && !$("#product-location").value) {
      $("#product-location").value = currentUser.location;
    }
  }
  wrapper?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function editProduct(product) {
  openCropForm(true);
  $("#product-id").value = product.id;
  $("#product-name").value = product.name;
  $("#product-category").value = product.category || "Vegetables";
  $("#product-price").value = product.price;
  $("#product-unit").value = product.unit || "kg";
  $("#product-quantity").value = product.availableQuantity;
  $("#product-variety").value = product.variety || "";
  $("#product-grade").value = product.qualityGrade || "Grade A";
  $("#product-harvest").value = product.harvestDate || "";
  $("#product-location").value = product.farmLocation || "";
  $("#product-status").value = product.status || "available";
  $("#product-description").value = product.description;

  $("#product-form-title").textContent = `Edit Crop Listing: ${product.name}`;
  $("#publish-button").textContent = "Save Listing Changes";
  $("#photo-title").textContent = "Change Crop Photo (Optional)";
  $("#photo-preview").src = product.imageUrl;
  $("#photo-preview").classList.remove("hidden");
  selectedPhoto = null;
}

function resetProductForm() {
  $("#product-form")?.reset();
  $("#product-id").value = "";
  $("#product-form-title").textContent = "Add New Crop Listing";
  $("#publish-button").textContent = "Publish Crop Listing";
  $("#photo-title").textContent = "Upload Crop Photo *";
  $("#photo-preview")?.classList.add("hidden");
  $("#photo-preview")?.removeAttribute("src");
  selectedPhoto = null;
}

async function toggleProductAvailability(product) {
  const nextStatus = product.status === "available" ? "unavailable" : "available";
  const nextQty = nextStatus === "available" && product.availableQuantity <= 0 ? 10 : product.availableQuantity;
  try {
    await api(`/api/seller/products/${product.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: nextStatus, availableQuantity: nextQty }),
    });
    showNotice(`Listing marked as ${nextStatus}.`);
    await Promise.all([loadSellerProducts(), loadLandingData()]);
  } catch (err) {
    showNotice(err.message, true);
  }
}

async function deleteProduct(product) {
  try {
    await api(`/api/seller/products/${product.id}`, { method: "DELETE" });
    showNotice(`“${product.name}” deleted from your listings.`);
    await Promise.all([loadSellerProducts(), loadLandingData()]);
  } catch (err) {
    showNotice(err.message, true);
  }
}

/* ==================== EVENT LISTENERS ==================== */
// Mobile menu toggle
$("#mobile-menu-toggle")?.addEventListener("click", () => {
  const nav = $("#main-nav");
  const isOpen = nav.classList.toggle("open");
  $("#mobile-menu-toggle").setAttribute("aria-expanded", String(isOpen));
});

// Top-level view navigation
$$("[data-nav]").forEach((elNode) => {
  elNode.addEventListener("click", (e) => {
    e.preventDefault();
    const dest = elNode.dataset.nav;
    if (dest === "home") {
      showView("#home-view");
      loadLandingData();
    } else if (dest === "marketplace") {
      showView("#marketplace-view");
      loadMarket();
    }
  });
});

// Smooth section scrolling on landing page
$$("[data-scroll]").forEach((elNode) => {
  elNode.addEventListener("click", (e) => {
    e.preventDefault();
    const targetId = elNode.dataset.scroll;
    showView("#home-view", false);
    const targetEl = document.getElementById(targetId);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
});

// Category card jump to filtered marketplace
$$("[data-category-jump]").forEach((card) => {
  card.addEventListener("click", () => {
    const cat = card.dataset.categoryJump;
    resetMarketFilters();
    if ($("#market-category")) $("#market-category").value = cat;
    showView("#marketplace-view");
    loadMarket();
  });
});

// Auth role triggers
$$("[data-auth-trigger]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const role = btn.dataset.authTrigger;
    if (currentUser && currentUser.role === role) {
      openDashboard(currentUser);
    } else {
      switchAuthRole(role);
    }
  });
});

$$("[data-switch-role]").forEach((btn) => {
  btn.addEventListener("click", () => switchAuthRole(btn.dataset.switchRole));
});

$("#nav-dashboard-btn")?.addEventListener("click", () => {
  if (currentUser) openDashboard(currentUser);
});

$("#market-my-orders-btn")?.addEventListener("click", () => {
  if (currentUser) openDashboard(currentUser);
});

$("#back-home")?.addEventListener("click", () => showView("#home-view"));
$("#detail-back-btn")?.addEventListener("click", () => {
  showView("#marketplace-view");
  loadMarket();
});
$("#checkout-back-btn")?.addEventListener("click", () => {
  if (activeCheckoutProduct) {
    renderProductDetail(activeCheckoutProduct);
    showView("#product-detail-view");
  } else {
    showView("#marketplace-view");
  }
});

// Phone OTP Request
async function requestOtpFlow(button = $("#request-otp-btn")) {
  if (authFlowBusy) return null;
  $("#login-error")?.classList.add("hidden");
  currentPhone = ($("#phone")?.value || "").trim();
  setAuthFlowBusy(true);
  setBusy(button, true);
  try {
    const result = await api("/api/auth/request-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: currentAuthRole, phone: currentPhone }),
    });
    const banner = $("#otp-mode-banner");
    const badge = banner?.querySelector(".banner-badge");
    const message = $("#otp-mode-message");
    const codeHint = $("#otp-code-hint");
    const smsSent = Boolean(result.smsSent);
    const demoMode = Boolean(result.demoMode);
    banner?.classList.toggle("sms-auth-banner", smsSent);
    badge?.classList.toggle("sms-auth-badge", smsSent);
    if (badge) {
      badge.textContent = smsSent ? "SMS VERIFICATION" : "DEMO AUTHENTICATION MODE";
    }
    if (message) {
      message.textContent = smsSent
        ? result.message || "An SMS verification code was sent to your phone number."
        : demoMode
          ? `No real SMS was sent. Demo authentication is active; enter development OTP ${
              result.demoCode || "1234"
            }.`
          : result.message || "No SMS was sent. Please request a new verification code.";
    }
    if (codeHint) {
      codeHint.textContent = smsSent
        ? "Enter the verification code sent to your phone by SMS."
        : demoMode
          ? "Enter the 4-digit development OTP (1234)."
          : "Enter the verification code sent to your phone.";
    }
    $("#code").placeholder = smsSent ? "SMS code" : "1234";

    $("#code").value = "";
    $("#auth-step-indicator").textContent = "STEP 2 OF 2 · VERIFY OTP CODE";
    $("#auth-card-heading").textContent = `Verify ${currentPhone}`;
    $("#phone-form")?.classList.add("hidden");
    $("#code-form")?.classList.remove("hidden");
    return result;
  } catch (err) {
    showLoginError(err.message);
    return null;
  } finally {
    setBusy(button, false);
    setAuthFlowBusy(false);
    if (!$("#code-form")?.classList.contains("hidden")) $("#code")?.focus();
  }
}

$("#phone-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  await requestOtpFlow();
});

$("#resend-otp-btn")?.addEventListener("click", async () => {
  const result = await requestOtpFlow($("#resend-otp-btn"));
  if (result) {
    showNotice(
      result.smsSent
        ? "A new SMS verification code was sent."
        : "A new demo verification code is ready.",
    );
  }
});

$("#change-phone")?.addEventListener("click", () => {
  $("#phone-form")?.classList.remove("hidden");
  $("#code-form")?.classList.add("hidden");
  $("#login-error")?.classList.add("hidden");
  $("#auth-step-indicator").textContent = "STEP 1 OF 2 · MOBILE NUMBER";
});

$("#code-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (authFlowBusy) return;
  const button = $("#verify-otp-btn");
  $("#login-error")?.classList.add("hidden");
  setAuthFlowBusy(true);
  setBusy(button, true);
  try {
    const result = await api("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: currentAuthRole,
        phone: currentPhone,
        code: ($("#code")?.value || "").trim(),
        fullName: ($("#auth-fullname")?.value || "").trim(),
        farmName: ($("#auth-farmname")?.value || "").trim(),
      }),
    });
    showNotice(`Signed in as ${result.user.role === "seller" ? "Seller" : "Buyer"} (${result.user.phone}).`);
    if (result.user.role === "buyer") {
      await enterBuyerMarketplace(result.user);
    } else {
      await openDashboard(result.user);
    }
  } catch (err) {
    showLoginError(err.message);
  } finally {
    setBusy(button, false);
    setAuthFlowBusy(false);
  }
});

// Logout
$("#logout-button")?.addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
    currentUser = null;
    pendingBuyProduct = null;
    updateHeaderAuthUI();
    showNotice("You have been logged out.");
    showView("#home-view");
    loadLandingData();
  } catch (err) {
    showNotice(err.message, true);
  }
});

// Profile management
$("#open-profile-modal-btn")?.addEventListener("click", () => {
  $("#profile-edit-panel")?.classList.toggle("hidden");
});
$("#close-profile-btn")?.addEventListener("click", () => {
  $("#profile-edit-panel")?.classList.add("hidden");
});
$("#profile-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const payload = {
      fullName: $("#profile-fullname").value.trim(),
      farmName: $("#profile-farmname").value.trim(),
      location: $("#profile-location").value.trim(),
      bio: $("#profile-bio").value.trim(),
    };
    const res = await api("/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    currentUser = res.user;
    $("#profile-edit-panel")?.classList.add("hidden");
    showNotice("Profile updated.");
    await openDashboard(currentUser);
  } catch (err) {
    showNotice(err.message, true);
  }
});

// Marketplace Search & Filter Controls
let marketSearchTimer = null;
$("#market-search")?.addEventListener("input", () => {
  clearTimeout(marketSearchTimer);
  marketSearchTimer = setTimeout(loadMarket, 240);
});
$("#market-search-btn")?.addEventListener("click", loadMarket);
$("#market-retry-btn")?.addEventListener("click", loadMarket);
$("#market-category")?.addEventListener("change", loadMarket);
$("#market-sort")?.addEventListener("change", loadMarket);
$("#market-status")?.addEventListener("change", loadMarket);
$("#apply-filters-btn")?.addEventListener("click", loadMarket);
$("#clear-filters-btn")?.addEventListener("click", resetMarketFilters);
$("#empty-reset-filters")?.addEventListener("click", resetMarketFilters);

// Checkout Quantity & Submit
$("#checkout-quantity")?.addEventListener("input", updateCheckoutSummary);

$("#checkout-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!activeCheckoutProduct) return;
  const errBox = $("#checkout-error");
  errBox?.classList.add("hidden");
  const btn = $("#confirm-order-btn");
  setBusy(btn, true);

  try {
    const payload = {
      productId: activeCheckoutProduct.id,
      quantity: parseFloat($("#checkout-quantity").value),
      fullName: $("#checkout-fullname").value.trim(),
      mobile: $("#checkout-mobile").value.trim(),
      houseStreet: $("#checkout-street").value.trim(),
      villageCity: $("#checkout-city").value.trim(),
      district: $("#checkout-district").value.trim(),
      state: $("#checkout-state").value.trim(),
      pinCode: $("#checkout-pincode").value.trim(),
      instructions: $("#checkout-instructions").value.trim(),
      idempotencyKey: checkoutIdempotencyKey,
    };
    const res = await api(`/api/products/${activeCheckoutProduct.id}/purchase`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const ord = res.order;
    const confBox = $("#confirmation-details-box");
    if (confBox && ord) {
      confBox.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:14px;">
          <div><strong>Order ID:</strong> <code>${ord.orderId}</code></div>
          <div><strong>Status:</strong> ${ord.status}</div>
          <div><strong>Crop Ordered:</strong> ${ord.productName}</div>
          <div><strong>Quantity:</strong> ${ord.quantity} ${ord.unit}</div>
          <div><strong>Total Order Value:</strong> ${money(ord.totalAmount)}</div>
          <div><strong>Seller Contact:</strong> ${ord.sellerPhone}</div>
        </div>
        <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border);font-size:13px;">
          <strong>Delivery Address Snapshot:</strong><br>
          ${ord.deliveryAddress.fullName} (${ord.deliveryAddress.mobile}), ${ord.deliveryAddress.houseStreet}, ${ord.deliveryAddress.villageCity}, ${ord.deliveryAddress.district}, ${ord.deliveryAddress.state} — PIN ${ord.deliveryAddress.pinCode}
        </div>
      `;
    }
    showNotice(`Order ${res.orderId} confirmed!`);
    await loadLandingData();
    showView("#order-confirmation-view");
  } catch (err) {
    if (errBox) {
      errBox.textContent = err.message;
      errBox.classList.remove("hidden");
    }
  } finally {
    setBusy(btn, false);
  }
});

$("#confirm-view-orders-btn")?.addEventListener("click", () => {
  if (currentUser) openDashboard(currentUser);
});
$("#confirm-continue-shopping-btn")?.addEventListener("click", () => {
  showView("#marketplace-view");
  loadMarket();
});

// Buyer Dashboard Tabs
$$("[data-buyer-tab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    if (tab.dataset.buyerTab === "explore") {
      showView("#marketplace-view");
      loadMarket();
    }
  });
});

// Seller Dashboard Tabs & Form Triggers
$("#seller-add-crop-top-btn")?.addEventListener("click", () => openCropForm(false));
$("#seller-empty-add-btn")?.addEventListener("click", () => openCropForm(false));
$("#seller-empty-cta-btn")?.addEventListener("click", () => openCropForm(false));
$("#close-crop-form-btn")?.addEventListener("click", () => {
  $("#seller-form-wrapper")?.classList.add("hidden");
  resetProductForm();
});
$("#cancel-edit")?.addEventListener("click", () => {
  $("#seller-form-wrapper")?.classList.add("hidden");
  resetProductForm();
});

$$("[data-seller-section]").forEach((button) => {
  button.addEventListener("click", async () => {
    $$("[data-seller-section]").forEach((tab) => {
      const active = tab === button;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    const showProducts = button.dataset.sellerSection === "products";
    $("#seller-products-panel")?.classList.toggle("hidden", !showProducts);
    $("#sales-panel")?.classList.toggle("hidden", showProducts);
    if (!showProducts) {
      await loadSellerOrders().catch((e) => showNotice(e.message, true));
    }
  });
});

$("#seller-filter")?.addEventListener("change", renderSellerProductsList);

$("#photo")?.addEventListener("change", () => {
  const file = $("#photo").files[0];
  if (!file) return;
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    showNotice("Use a JPEG, PNG, or WebP image.", true);
    $("#photo").value = "";
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showNotice("Image must be 5 MB or smaller.", true);
    $("#photo").value = "";
    return;
  }
  selectedPhoto = file;
  $("#photo-preview").src = URL.createObjectURL(file);
  $("#photo-preview").classList.remove("hidden");
});

$("#product-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const productId = $("#product-id").value;
  const formData = new FormData(form);
  formData.delete("photo");
  if (selectedPhoto) formData.set("photo", selectedPhoto);

  const requestUrl = productId ? `/api/seller/products/${productId}` : "/api/seller/products";
  let requestOptions;
  if (productId && !selectedPhoto) {
    requestOptions = {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(formData)),
    };
  } else {
    requestOptions = {
      method: productId ? "PATCH" : "POST",
      body: formData,
    };
  }

  const submitBtn = $("#publish-button");
  submitBtn.disabled = true;
  try {
    await api(requestUrl, requestOptions);
    showNotice(productId ? "Crop listing updated." : "Crop listing published to marketplace!");
    resetProductForm();
    $("#seller-form-wrapper")?.classList.add("hidden");
    await Promise.all([loadSellerProducts(), loadLandingData()]);
  } catch (err) {
    showNotice(err.message, true);
  } finally {
    submitBtn.disabled = false;
  }
});

/* ==================== INITIALIZATION ==================== */
(async function initApp() {
  await loadLandingData();
  try {
    const { user } = await api("/api/session");
    if (user) {
      if (user.role === "buyer") {
        await enterBuyerMarketplace(user);
      } else {
        await openDashboard(user);
      }
    }
  } catch (err) {
    showNotice(`Could not restore your signed-in session. ${err.message}`, true);
  }
})();
