# Crop2Costumer — “From Farm to Your Door.”

**Crop2Costumer** is a full-stack farmer-to-customer agricultural marketplace built with **Python (Flask)**, **SQLite**, **Pillow**, and **responsive vanilla HTML5/CSS3/JavaScript**.

Farmers (Sellers) can register with their phone number, upload crop photographs, set prices per unit (`kg`, `quintal`, `bunch`, `dozen`, `crate`, `bag`, etc.), specify crop variety, harvest date, quality grade, and farm location, and manage incoming buyer orders. Customers (Buyers) can explore the shared marketplace, search and filter crops across multiple criteria, inspect detailed crop provenance, and place direct orders with full delivery addresses — **with no online payment gateway friction**.

---

## Key Features Implemented

1. **Brand Identity & Responsive UI (`Crop2Costumer`)**:
   - Designed around a deep forest green (`#1B4332`), warm off-white (`#FAF8F5`), and dark charcoal (`#1C241E`) palette with the official **Crop2Costumer** emblem and tagline *“From Farm to Your Door.”*
   - Complete landing page featuring live database metrics, Featured Crops, Browse by Category, How Crop2Costumer Works, Why Buy Directly From Farmers, Benefits for Farmers, Recently Added Products, Farmer Recruitment banner, FAQ, and responsive mobile navigation.
2. **Role-Separated Phone OTP Authentication (`Buyer` & `Seller`)**:
   - Distinct entry paths for **Continue as Buyer** and **Continue as Seller**.
   - Supports live SMS dispatch via **Twilio** or **Fast2SMS** when configured via environment variables.
   - Includes a safe **Development / Demo Mode** fallback using common OTP **`1234`** when `ENABLE_DEV_OTP=true` and `APP_ENV!=production`, accompanied by a transparent UI banner so the app never silently pretends an SMS was sent.
3. **Farmer-Friendly Seller Dashboard**:
   - KPI summary cards (Total Listings, Active in Marketplace, Sold Out/Unavailable, Orders Received).
   - **Add / Edit Crop Form** with 11 structured fields (Crop Name, Category, Price, Unit, Available Quantity, Crop Variety, Quality Grade, Harvest Date, Farm Location, Availability Status, Description) and client + server image validation (JPEG, PNG, WebP up to 5 MB) with live image preview.
   - Instant stock/availability toggles, listing edits, safe deletion checks, and full order fulfilment status workflow (`Order Placed → Accepted → Preparing → Ready for Dispatch → Dispatched → Delivered` or `Cancelled`).
4. **Shared Buyer Marketplace & Product Detail Page**:
   - Multi-field search across crop name, category, variety, seller/farm name, and farm location.
   - Combined filters for Category, Farm Location, Min/Max Price, Availability Status, and Sorting (Newest, Price Low–High, Price High–Low, Name A–Z) with a one-click **Clear All** action.
5. **Simple Direct Buying Process — No Payment Gateway**:
   - Clicking **Buy Now** opens a dedicated checkout screen collecting recipient Full Name, Mobile Number, House/Street, Village/Town/City, District, State, 6-digit PIN Code, and optional delivery instructions.
   - Uses atomic SQLite `BEGIN IMMEDIATE` transactions and idempotency keys to validate stock on the server, prevent overselling under concurrent requests, decrement stock automatically, and generate a unique `ORD-...` identifier.
   - Buyers can view all orders in **My Orders** and cancel eligible orders (`Order Placed` or `Accepted`), which automatically restores stock to the farmer's listing.

---

## Persistent Data & Image Storage Architecture

- **Structured Database**: `data/marketplace.db` (SQLite 3 with `PRAGMA foreign_keys = ON`).
  - Tables: `users`, `otp_Challenges`, `products`, and `orders`.
  - Existing data is preserved across browser refreshes, server restarts, and different user sessions.
- **Uploaded Crop Images**: `uploads/` directory.
  - Every uploaded image is verified and re-encoded via `Pillow` (`PIL`) to strip potentially unsafe payloads and saved with a UUID filename in `uploads/`, served through `/media/<filename>`.
- **How to Back Up Your Data**:
  - Copy `data/marketplace.db` and the `uploads/` folder to your backup location.

---

## Quick Start Instructions

### Prerequisites
- Python 3.10 or newer

### 1. Run on Windows (PowerShell)
```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
$env:FLASK_SECRET_KEY = python -c "import secrets; print(secrets.token_urlsafe(32))"
python app.py
```

### 2. Run on macOS / Linux (Bash)
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export FLASK_SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")
python3 app.py
```

Open **http://127.0.0.1:5000** in your browser.

---

## Configuring Real SMS OTP Delivery (Production)

By default, `SMS_PROVIDER=none` and `ENABLE_DEV_OTP=true` in local development so you can test immediately using development OTP **`1234`**. Production mode always disables the bypass. Outside production, set `ENABLE_DEV_OTP=false` to require real SMS.

To enable real SMS delivery:
1. Copy `.env.example` and configure either **Twilio** or **Fast2SMS**:
   - **Twilio**: Set `SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER`.
   - **Fast2SMS (India)**: Set `SMS_PROVIDER=fast2sms` and `FAST2SMS_API_KEY`.
2. For production deployment, set:
   ```bash
   export APP_ENV=production
   export ENABLE_DEV_OTP=false
   export COOKIE_SECURE=true
   ```
   When `APP_ENV=production`, the `1234` development bypass is strictly disabled on the server.

## Hosting and durable storage

The default database path is the project-relative `data/marketplace.db`, and uploaded images are stored in `uploads/`. Both survive ordinary local restarts. Many app hosts use an ephemeral filesystem, which can discard SQLite records and uploaded images during redeploys or instance replacement. Mount durable storage and set `DATABASE_PATH` to a SQLite file on that volume and `UPLOAD_DIR` to a directory on the same persistent volume before starting the app. Back up both locations together. Do not use multiple app instances against an ordinary local SQLite file.

For production, configure a long random `FLASK_SECRET_KEY`, `APP_ENV=production`, and `COOKIE_SECURE=true` behind HTTPS. The server refuses to start in production without `FLASK_SECRET_KEY`. Real OTP delivery requires valid credentials for the selected SMS provider (`SMS_PROVIDER=twilio` with Twilio credentials, or `SMS_PROVIDER=fast2sms` with `FAST2SMS_API_KEY`). With no provider credentials, real SMS is unavailable; local demo mode remains available only outside production.

The app can be started with `python app.py` for local demonstration. A production WSGI server can import `app:create_app()`; configure the host's startup command and persistent volume paths accordingly.

---

## Running the Automated Test Suite

Run the comprehensive unit and end-to-end integration tests:

```bash
python3 -m unittest discover -s tests -v
```
