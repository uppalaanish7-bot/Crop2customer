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
   - Includes a no-SMS **Demo Mode** using code **`1234`**. It skips the SMS provider entirely. Local development enables it by default; Vercel production requires the explicit `ALLOW_DEMO_AUTH_IN_PRODUCTION=true` setting. This accepts the shared code for any valid phone number, so it is suitable only when unrestricted account impersonation is acceptable. Vercel Preview keeps it disabled because Preview shares the production database.
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

## Database and Image Storage

- **Local development** uses `data/marketplace.db` (SQLite) and `uploads/`.
- **Production on Vercel** uses PostgreSQL through `DATABASE_URL`. Vercel Functions have a read-only filesystem apart from temporary `/tmp` space, so local SQLite and `uploads/` are not production storage.
- Product photos are validated and re-encoded by Pillow before storage. In production they are stored as PostgreSQL `BYTEA` records and served through `/media/<filename>`; local development keeps using `uploads/`.
- `postgres_schema.sql` defines the PostgreSQL schema while preserving the existing tables and fields.
- `scripts/migrate_sqlite_to_neon.py` makes a timestamped local backup, copies uploaded images without overwriting mismatched objects, refuses a non-empty database destination, copies all five existing tables, and checks row counts. It never deletes the SQLite database or local uploads.

### Recommended Vercel storage setup

The Neon PostgreSQL integration provides the production database. Storing images in PostgreSQL keeps the initial deployment to one managed service and avoids relying on Vercel's temporary filesystem. Database quotas and idle compute limits still apply; a first request after inactivity may take longer.

Configure these Vercel **Production** variables:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Neon pooled PostgreSQL connection string, provided by the Vercel integration |
| `APP_ENV` | `production` |
| `FLASK_SECRET_KEY` | Locally generated strong random secret |
| `COOKIE_SECURE` | `true` |
| `ENABLE_DEV_OTP` | `false` |
| `SEED_DEMO_DATA` | `false` |
| `STORAGE_BACKEND` | `postgres` |
| `SMS_PROVIDER` | `none` until a real SMS provider is configured |

For a presentation deployment, set `SEED_DEMO_DATA=true` to add four clearly labeled sample crops on first startup when the products table is empty. This seed works with both local SQLite and Vercel PostgreSQL.

Keep database and storage credentials server-side in Vercel. Do not put them in `.env.example`, GitHub, templates, JavaScript, or CSS.

After the Neon database is ready, run `python scripts/migrate_sqlite_to_neon.py` locally with `DATABASE_URL` available in the environment. The script backs up the local database and uploads, migrates all five marketplace tables and image files, verifies row counts and image checksums, and leaves the SQLite database and uploads in place.

The Free plan is useful for initial launch testing, but storage limits apply and idle compute starts on demand. A service-level uptime guarantee or more capacity may require a paid plan; do not upgrade without reviewing its current terms and cost.

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

## Hosting and production security

For production, configure a strong `FLASK_SECRET_KEY`, `APP_ENV=production`, `COOKIE_SECURE=true`, and `ENABLE_DEV_OTP=false`. Production requires `DATABASE_URL` and persistent image storage (`postgres` or configured S3); the app refuses to fall back to local SQLite or `uploads/` when production mode is enabled. Without SMS-provider credentials, production OTP requests fail closed rather than using the `1234` development bypass.

The app can be started with `python app.py` for local demonstration. A production WSGI server can import `app:create_app()` after its production database and secrets have been configured.

---

## Running the Automated Test Suite

Run the comprehensive unit and end-to-end integration tests:

```bash
python3 -m unittest discover -s tests -v
```
