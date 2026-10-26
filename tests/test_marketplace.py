import io
import os
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from PIL import Image

os.environ.setdefault("FLASK_SECRET_KEY", "test-secret-key-not-for-production")

import app as marketplace


class Crop2CostumerMarketplaceTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.original_data = marketplace.DATA_DIR
        self.original_uploads = marketplace.UPLOAD_DIR
        self.original_database = marketplace.DATABASE
        marketplace.DATA_DIR = self.root / "data"
        marketplace.UPLOAD_DIR = self.root / "uploads"
        marketplace.DATABASE = marketplace.DATA_DIR / "test.db"
        self.app = marketplace.create_app(
            {
                "TESTING": True,
                "SECRET_KEY": "test-secret",
                "SEED_DEMO_DATA": False,
                "ENABLE_DEV_OTP": True,
            }
        )
        self.client = self.app.test_client()

    def tearDown(self):
        marketplace.DATA_DIR = self.original_data
        marketplace.UPLOAD_DIR = self.original_uploads
        marketplace.DATABASE = self.original_database
        self.tempdir.cleanup()

    def login(self, role, phone, code=None):
        otp = code or marketplace.DEMO_CODE
        req = self.client.post("/api/auth/request-code", json={"role": role, "phone": phone})
        self.assertEqual(req.status_code, 200, req.get_json())
        response = self.client.post(
            "/api/auth/verify",
            json={"role": role, "phone": phone, "code": otp, "fullName": "Test User", "farmName": "Green Farm"},
        )
        self.assertEqual(response.status_code, 200, response.get_json())
        return response

    def image_upload(self, filename="crop.png", image_format="PNG"):
        stream = io.BytesIO()
        Image.new("RGB", (60, 60), (40, 120, 60)).save(stream, format=image_format)
        stream.seek(0)
        return (stream, filename)

    def create_product(
        self,
        name="Heirloom Red Tomatoes",
        category="Vegetables",
        price="45.00",
        unit="kg",
        quantity="20",
        variety="Desi Natu",
        location="Atmakur, Nandyal",
    ):
        response = self.client.post(
            "/api/seller/products",
            data={
                "name": name,
                "category": category,
                "price": price,
                "unit": unit,
                "quantity": quantity,
                "variety": variety,
                "qualityGrade": "Grade A",
                "harvestDate": "2026-10-25",
                "farmLocation": location,
                "status": "available",
                "description": "Freshly harvested red tomatoes directly from our family farm.",
                "photo": self.image_upload(),
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 201, response.get_json())
        return response

    def test_scenario_a_and_b_seller_creates_and_buyer_discovers_filters(self):
        # Scenario A: Seller signs in with OTP 1234 and publishes a listing
        self.login("seller", "+919876543210", code="1234")
        created = self.create_product(
            name="Sona Masoori Paddy",
            category="Grains & Cereals",
            price="3200",
            unit="quintal",
            quantity="15",
            variety="BPT 5204",
            location="Kurnool, AP",
        )
        prod_id = created.get_json()["id"]
        seller_list = self.client.get("/api/seller/products").get_json()["products"]
        self.assertEqual(len(seller_list), 1)
        self.assertEqual(seller_list[0]["name"], "Sona Masoori Paddy")
        self.assertEqual(seller_list[0]["availableQuantity"], 15.0)
        self.assertEqual(seller_list[0]["unit"], "quintal")

        # Verify uploaded image is served persistently
        img_res = self.client.get(seller_list[0]["imageUrl"])
        self.assertEqual(img_res.status_code, 200)
        img_res.close()

        # Scenario B: Separate buyer session discovers, searches, and filters the listing
        self.client.post("/api/logout")
        self.login("buyer", "+919876543211", code="1234")

        all_prods = self.client.get("/api/public/products").get_json()["products"]
        self.assertEqual(len(all_prods), 1)

        # Search by variety
        by_variety = self.client.get("/api/public/products?q=BPT+5204").get_json()["products"]
        self.assertEqual(len(by_variety), 1)

        # Filter by category & location & price range
        filtered = self.client.get(
            "/api/public/products?category=Grains+%26+Cereals&location=Kurnool&minPrice=1000&maxPrice=4000"
        ).get_json()["products"]
        self.assertEqual(len(filtered), 1)

        # Filter mismatch returns empty
        empty_filter = self.client.get("/api/public/products?category=Fruits").get_json()["products"]
        self.assertEqual(len(empty_filter), 0)

        # Product detail endpoint
        detail = self.client.get(f"/api/public/products/{prod_id}").get_json()["product"]
        self.assertEqual(detail["name"], "Sona Masoori Paddy")
        self.assertEqual(detail["variety"], "BPT 5204")

    def test_scenario_c_and_d_order_placement_stock_update_status_and_persistence(self):
        self.login("seller", "+919876543212", code="1234")
        prod_id = self.create_product(name="Organic Spinach", price="30", unit="bunch", quantity="10").get_json()["id"]
        self.client.post("/api/logout")

        self.login("buyer", "+919876543213", code="1234")
        # Excessive quantity is rejected
        excessive = self.client.post(
            f"/api/products/{prod_id}/purchase",
            json={
                "quantity": 25,
                "fullName": "Buyer One",
                "mobile": "+919876543213",
                "houseStreet": "12 Main Road",
                "villageCity": "Atmakur",
                "district": "Nandyal",
                "state": "Andhra Pradesh",
                "pinCode": "518422",
            },
        )
        self.assertEqual(excessive.status_code, 409)

        # Valid order placement with address
        order_res = self.client.post(
            f"/api/products/{prod_id}/purchase",
            json={
                "quantity": 4,
                "fullName": "Lakshmi Devi",
                "mobile": "+919876543213",
                "houseStreet": "H.No 8-44, Temple Street",
                "villageCity": "Atmakur",
                "district": "Nandyal",
                "state": "Andhra Pradesh",
                "pinCode": "518422",
                "instructions": "Deliver before 10 AM",
                "idempotencyKey": "unique-order-key-1",
            },
        )
        self.assertEqual(order_res.status_code, 201, order_res.get_json())
        order_data = order_res.get_json()
        order_id = order_data["orderId"]
        self.assertTrue(order_id.startswith("ORD-"))
        self.assertEqual(order_data["order"]["totalAmount"], 120.0)
        self.assertEqual(order_data["order"]["deliveryAddress"]["pinCode"], "518422")

        # Stock decremented from 10 to 6
        updated_prod = self.client.get(f"/api/public/products/{prod_id}").get_json()["product"]
        self.assertEqual(updated_prod["availableQuantity"], 6.0)

        # Seller reviews and updates order status
        self.client.post("/api/logout")
        self.login("seller", "+919876543212", code="1234")
        seller_orders = self.client.get("/api/seller/orders").get_json()["orders"]
        self.assertEqual(len(seller_orders), 1)
        self.assertEqual(seller_orders[0]["orderId"], order_id)

        status_patch = self.client.patch(
            f"/api/seller/orders/{order_id}",
            json={"status": "Accepted"},
        )
        self.assertEqual(status_patch.status_code, 200)

        # Scenario D: Restart application and verify persistence
        restarted_app = marketplace.create_app(
            {"TESTING": True, "SECRET_KEY": "test-secret", "SEED_DEMO_DATA": False, "ENABLE_DEV_OTP": True}
        )
        restarted_client = restarted_app.test_client()
        restarted_client.post(
            "/api/auth/verify",
            json={"role": "buyer", "phone": "+919876543213", "code": "1234"},
        )
        persisted_orders = restarted_client.get("/api/orders").get_json()["orders"]
        self.assertEqual(len(persisted_orders), 1)
        self.assertEqual(persisted_orders[0]["status"], "Accepted")

        # Buyer cancels order while in Accepted state -> stock restores to 10
        cancel_res = restarted_client.post(f"/api/orders/{order_id}/cancel", json={"reason": "Change of plans"})
        self.assertEqual(cancel_res.status_code, 200)
        restored_prod = restarted_client.get(f"/api/public/products/{prod_id}").get_json()["product"]
        self.assertEqual(restored_prod["availableQuantity"], 10.0)

    def test_scenario_e_permissions_and_production_otp_safeguard(self):
        # Buyer cannot access seller endpoints
        self.login("buyer", "+919876543214", code="1234")
        self.assertEqual(self.client.get("/api/seller/products").status_code, 401)
        self.assertEqual(self.client.post("/api/seller/products").status_code, 401)
        self.client.post("/api/logout")

        # Seller A creates product; Seller B cannot modify or delete it
        self.login("seller", "+919876543215", code="1234")
        prod_id = self.create_product().get_json()["id"]
        self.client.post("/api/logout")

        self.login("seller", "+919876543216", code="1234")
        self.assertEqual(
            self.client.patch(f"/api/seller/products/{prod_id}", json={"name": "Hack", "price": 10, "description": "Valid description"}).status_code,
            404,
        )
        self.assertEqual(self.client.delete(f"/api/seller/products/{prod_id}").status_code, 404)

        # Production mode disables 1234 fallback when SMS provider is not configured
        prod_app = marketplace.create_app(
            {
                "TESTING": True,
                "SECRET_KEY": "prod-secret",
                "APP_ENV": "production",
                "ENABLE_DEV_OTP": True,
                "SMS_PROVIDER": "none",
            }
        )
        prod_client = prod_app.test_client()
        self.assertFalse(prod_app.config["ENABLE_DEV_OTP"])
        self.assertEqual(
            prod_client.post("/api/auth/request-code", json={"role": "buyer", "phone": "+919876543299"}).status_code,
            503,
        )
        self.assertEqual(
            prod_client.post("/api/auth/verify", json={"role": "buyer", "phone": "+919876543299", "code": "1234"}).status_code,
            400,
        )

    def test_auth_role_separation_and_returning_sessions(self):
        phone = "+919876543220"
        buyer_response = self.login("buyer", phone)
        buyer_id = buyer_response.get_json()["user"]["id"]
        self.assertEqual(self.client.get("/api/session").get_json()["user"]["role"], "buyer")
        self.assertEqual(self.client.get("/api/seller/products").status_code, 401)

        self.client.post("/api/logout")
        returning_buyer = self.login("buyer", phone).get_json()["user"]
        self.assertEqual(returning_buyer["id"], buyer_id)

        self.client.post("/api/logout")
        seller = self.login("seller", phone).get_json()["user"]
        self.assertNotEqual(seller["id"], buyer_id)
        self.assertEqual(seller["role"], "seller")
        self.assertEqual(self.client.get("/api/session").get_json()["user"]["id"], seller["id"])
        self.assertEqual(self.client.get("/api/orders").status_code, 401)

        self.client.post("/api/logout")
        returning_seller = self.login("seller", phone).get_json()["user"]
        self.assertEqual(returning_seller["id"], seller["id"])

    def test_auth_validation_expiration_attempt_limit_and_sms_failure(self):
        phone = "+919876543221"
        normalized = self.client.post(
            "/api/auth/request-code",
            json={"role": "buyer", "phone": "9876543221"},
        )
        self.assertEqual(normalized.status_code, 200, normalized.get_json())
        verified = self.client.post(
            "/api/auth/verify",
            json={"role": "buyer", "phone": "+91 9876543221", "code": "1234"},
        )
        self.assertEqual(verified.status_code, 200, verified.get_json())
        self.assertEqual(verified.get_json()["user"]["phone"], "+919876543221")

        invalid = self.client.post(
            "/api/auth/request-code",
            json={"role": "buyer", "phone": "not-a-phone"},
        )
        self.assertEqual(invalid.status_code, 400)
        international = self.client.post(
            "/api/auth/request-code",
            json={"role": "buyer", "phone": "+14155552671"},
        )
        self.assertEqual(international.status_code, 400)

        request = self.client.post(
            "/api/auth/request-code",
            json={"role": "buyer", "phone": phone},
        )
        self.assertEqual(request.status_code, 200)
        self.assertTrue(request.get_json()["demoMode"])
        self.assertFalse(request.get_json()["smsSent"])

        for _ in range(5):
            wrong_code = self.client.post(
                "/api/auth/verify",
                json={"role": "buyer", "phone": phone, "code": "9999"},
            )
            self.assertEqual(wrong_code.status_code, 400)
        locked = self.client.post(
            "/api/auth/verify",
            json={"role": "buyer", "phone": phone, "code": "1234"},
        )
        self.assertEqual(locked.status_code, 429)

        self.client.post("/api/auth/request-code", json={"role": "buyer", "phone": phone})
        with closing(sqlite3.connect(marketplace.DATABASE)) as db:
            db.execute(
                "UPDATE otp_Challenges SET expires_at = ? WHERE phone = ? AND role = 'buyer'",
                ("2000-01-01T00:00:00+00:00", phone),
            )
            db.commit()
        expired = self.client.post(
            "/api/auth/verify",
            json={"role": "buyer", "phone": phone, "code": "1234"},
        )
        self.assertEqual(expired.status_code, 400)
        self.assertIn("expired", expired.get_json()["error"].lower())

        sms_unavailable_app = marketplace.create_app(
            {
                "TESTING": True,
                "SECRET_KEY": "test-secret",
                "SEED_DEMO_DATA": False,
                "ENABLE_DEV_OTP": False,
                "SMS_PROVIDER": "none",
            }
        )
        sms_unavailable_response = sms_unavailable_app.test_client().post(
            "/api/auth/request-code",
            json={"role": "buyer", "phone": "+919876543222"},
        )
        self.assertEqual(sms_unavailable_response.status_code, 503)

    def test_otp_request_throttle(self):
        phone = "+919876543224"
        for _ in range(5):
            response = self.client.post(
                "/api/auth/request-code", json={"role": "buyer", "phone": phone}
            )
            self.assertEqual(response.status_code, 200, response.get_json())
        throttled = self.client.post(
            "/api/auth/request-code", json={"role": "buyer", "phone": phone}
        )
        self.assertEqual(throttled.status_code, 429)
        self.assertIn("10 minutes", throttled.get_json()["error"])

    def test_production_sms_otp_works_without_development_bypass(self):
        sms_app = marketplace.create_app(
            {
                "TESTING": True,
                "SECRET_KEY": "prod-test-secret",
                "APP_ENV": "production",
                "ENABLE_DEV_OTP": True,
                "SEED_DEMO_DATA": False,
                "SMS_PROVIDER": "twilio",
                "TWILIO_ACCOUNT_SID": "test-account",
                "TWILIO_AUTH_TOKEN": "test-token",
                "TWILIO_FROM_NUMBER": "+15005550006",
            }
        )
        self.assertFalse(sms_app.config["ENABLE_DEV_OTP"])
        client = sms_app.test_client()
        with patch("app.urllib.request.urlopen") as send_sms, patch(
            "app.secrets.randbelow", return_value=456
        ):
            send_sms.return_value.__enter__.return_value.status = 201
            request = client.post(
                "/api/auth/request-code",
                json={"role": "buyer", "phone": "+919876543223"},
            )

        self.assertEqual(request.status_code, 200)
        self.assertTrue(request.get_json()["smsSent"])
        self.assertFalse(request.get_json()["demoMode"])
        self.assertNotIn("demoCode", request.get_json())
        with closing(sqlite3.connect(marketplace.DATABASE)) as db:
            sms_code = db.execute(
                "SELECT otp_code FROM otp_Challenges WHERE phone = ? AND role = 'buyer' ORDER BY id DESC LIMIT 1",
                ("+919876543223",),
            ).fetchone()[0]
        self.assertEqual(sms_code, "1456")

        bypass = client.post(
            "/api/auth/verify",
            json={"role": "buyer", "phone": "+919876543223", "code": "1234"},
        )
        self.assertEqual(bypass.status_code, 400)
        verified = client.post(
            "/api/auth/verify",
            json={"role": "buyer", "phone": "+919876543223", "code": sms_code},
        )
        self.assertEqual(verified.status_code, 200, verified.get_json())

    def test_session_secret_is_random_in_development_and_required_in_production(self):
        with patch.dict(os.environ, {}, clear=True):
            first = marketplace.create_app({"TESTING": True, "SEED_DEMO_DATA": False})
            second = marketplace.create_app({"TESTING": True, "SEED_DEMO_DATA": False})
        self.assertNotEqual(first.secret_key, "crop2costumer-dev-secret-key-change-in-prod")
        self.assertNotEqual(first.secret_key, second.secret_key)

        with patch.dict(os.environ, {"APP_ENV": "production"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "FLASK_SECRET_KEY"):
                marketplace.create_app()

    def test_simultaneous_buyers_cannot_oversell_single_stock_item(self):
        self.login("seller", "+919876543217", code="1234")
        product_id = self.create_product(quantity="1").get_json()["id"]
        buyers = [self.app.test_client(), self.app.test_client()]
        for client, phone in zip(buyers, ("+919876543218", "+919876543219")):
            client.post(
                "/api/auth/verify",
                json={"role": "buyer", "phone": phone, "code": "1234"},
            )

        start_together = threading.Barrier(2)

        def buy(client):
            start_together.wait()
            return client.post(f"/api/products/{product_id}/purchase", json={"quantity": 1}).status_code

        with ThreadPoolExecutor(max_workers=2) as executor:
            statuses = list(executor.map(buy, buyers))
        self.assertCountEqual(statuses, [201, 409])
        self.assertEqual(len(self.client.get("/api/seller/orders").get_json()["orders"]), 1)


if __name__ == "__main__":
    unittest.main()
