"""
Lightweight, zero-external-dependency Flask & Werkzeug compatibility layer
for environments where only Python stdlib + Jinja2 + itsdangerous are installed.
"""

import contextvars
import email.parser
import html
import http.cookies
import io
import json
import logging
import mimetypes
import re
import urllib.parse
from pathlib import Path
from wsgiref.simple_server import make_server

from itsdangerous import BadSignature, URLSafeSerializer
from jinja2 import Environment, FileSystemLoader


class RequestEntityTooLarge(Exception):
    pass


_ctx_var = contextvars.ContextVar("flask_compat_ctx", default=None)


class _Proxy:
    def __init__(self, getter):
        object.__setattr__(self, "_getter", getter)

    def _obj(self):
        return object.__getattribute__(self, "_getter")()

    def __getattr__(self, name):
        return getattr(self._obj(), name)

    def __setattr__(self, name, value):
        setattr(self._obj(), name, value)

    def __getitem__(self, key):
        return self._obj()[key]

    def __setitem__(self, key, value):
        self._obj()[key] = value

    def __contains__(self, key):
        return key in self._obj()


class _GNamespace(dict):
    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError:
            raise AttributeError(name)

    def __setattr__(self, name, value):
        self[name] = value


class _SessionDict(dict):
    pass


class _UploadedFile:
    def __init__(self, filename, content_type, data_bytes):
        self.filename = filename
        self.content_type = content_type or "application/octet-stream"
        self.stream = io.BytesIO(data_bytes)


class _FormDict(dict):
    def to_dict(self):
        return dict(self)


class _Request:
    def __init__(self, method="GET", path="/", args=None, form=None, files=None, json_data=None, raw_body=b""):
        self.method = method.upper()
        self.path = path
        self.args = args or {}
        self.form = _FormDict(form or {})
        self.files = files or {}
        self._json_data = json_data
        self.data = raw_body

    def get_json(self, silent=False):
        if self._json_data is not None:
            return self._json_data
        if not self.data:
            return None
        try:
            self._json_data = json.loads(self.data.decode("utf-8"))
            return self._json_data
        except Exception:
            if silent:
                return None
            raise


class Response:
    def __init__(self, body=b"", status=200, headers=None, content_type="text/html; charset=utf-8"):
        if isinstance(body, str):
            self.data = body.encode("utf-8")
        else:
            self.data = bytes(body)
        self.status_code = int(status)
        self.headers = dict(headers or {})
        self.headers.setdefault("Content-Type", content_type)

    def get_json(self):
        try:
            return json.loads(self.data.decode("utf-8"))
        except Exception:
            return None

    def get_data(self, as_text=False):
        return self.data.decode("utf-8", errors="replace") if as_text else self.data

    def close(self):
        pass


g = _Proxy(lambda: _ctx_var.get()["g"])
request = _Proxy(lambda: _ctx_var.get()["request"])
session = _Proxy(lambda: _ctx_var.get()["session"])


def jsonify(*args, **kwargs):
    payload = dict(*args, **kwargs)
    return Response(
        json.dumps(payload),
        status=200,
        content_type="application/json",
    )


def render_template(template_name, **context):
    app = _ctx_var.get()["app"]
    tpl = app._jinja_env.get_template(template_name)
    return Response(tpl.render(**context), status=200, content_type="text/html; charset=utf-8")


def send_from_directory(directory, filename, max_age=None):
    target = Path(directory) / filename
    if not target.is_file():
        return Response(json.dumps({"error": "File not found."}), status=404, content_type="application/json")
    mime, _ = mimetypes.guess_type(str(target))
    headers = {}
    if max_age is not None:
        headers["Cache-Control"] = f"public, max-age={int(max_age)}"
    return Response(target.read_bytes(), status=200, headers=headers, content_type=mime or "application/octet-stream")


def _parse_multipart(body_bytes, content_type):
    m = re.search(r'boundary=([^;]+)', content_type)
    if not m:
        return {}, {}
    boundary = m.group(1).strip().strip('"').encode("utf-8")
    form = {}
    files = {}
    parts = body_bytes.split(b"--" + boundary)
    for part in parts[1:]:
        part = part.strip(b"\r\n")
        if not part or part == b"--":
            continue
        if part.endswith(b"--"):
            part = part[:-2].rstrip(b"\r\n")
        if b"\r\n\r\n" not in part:
            continue
        raw_headers, content = part.split(b"\r\n\r\n", 1)
        header_msg = email.parser.BytesHeaderParser().parsebytes(raw_headers + b"\r\n\r\n")
        disp = header_msg.get("Content-Disposition", "")
        name_m = re.search(r'name="([^"]+)"', disp)
        if not name_m:
            continue
        field_name = name_m.group(1)
        fn_m = re.search(r'filename="([^"]*)"', disp)
        if fn_m:
            filename = fn_m.group(1)
            ctype = header_msg.get_content_type()
            files[field_name] = _UploadedFile(filename, ctype, content)
        else:
            form[field_name] = content.decode("utf-8", errors="replace")
    return form, files


def _encode_multipart(data_dict):
    boundary = "----Crop2CostumerBoundary7MA4YWxkTrZu0gW"
    chunks = []
    for k, v in (data_dict or {}).items():
        if isinstance(v, tuple):
            stream, filename = v[0], v[1]
            raw = stream.read() if hasattr(stream, "read") else bytes(stream)
            mime, _ = mimetypes.guess_type(filename)
            mime = mime or "image/png"
            chunks.append(
                f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"; filename="{filename}"\r\nContent-Type: {mime}\r\n\r\n'.encode("utf-8")
                + raw
                + b"\r\n"
            )
        else:
            chunks.append(
                f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode("utf-8")
            )
    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


class _TestClient:
    def __init__(self, app):
        self.app = app
        self.session_data = {}

    def _request(self, method, url, json_payload=None, data=None, content_type=None):
        parsed = urllib.parse.urlsplit(url)
        path = parsed.path or "/"
        args = {k: v[0] if len(v) == 1 else v for k, v in urllib.parse.parse_qs(parsed.query, keep_blank_values=True).items()}
        form = {}
        files = {}
        raw_body = b""
        if json_payload is not None:
            raw_body = json.dumps(json_payload).encode("utf-8")
            content_type = "application/json"
        elif data is not None:
            if content_type and "multipart/form-data" in content_type:
                raw_body, content_type = _encode_multipart(data)
                form, files = _parse_multipart(raw_body, content_type)
            elif isinstance(data, dict):
                form = {k: str(v) for k, v in data.items()}
            elif isinstance(data, (bytes, bytearray)):
                raw_body = bytes(data)

        req = _Request(
            method=method,
            path=path,
            args=args,
            form=form,
            files=files,
            json_data=json_payload,
            raw_body=raw_body,
        )
        return self.app._dispatch(req, self.session_data)

    def get(self, url, **kwargs):
        return self._request("GET", url, **kwargs)

    def post(self, url, json=None, data=None, content_type=None):
        return self._request("POST", url, json_payload=json, data=data, content_type=content_type)

    def patch(self, url, json=None, data=None, content_type=None):
        return self._request("PATCH", url, json_payload=json, data=data, content_type=content_type)

    def delete(self, url, json=None, data=None, content_type=None):
        return self._request("DELETE", url, json_payload=json, data=data, content_type=content_type)


class Flask:
    def __init__(self, import_name):
        self.import_name = import_name
        self.root_path = Path(__file__).resolve().parent
        self.config = {}
        self.logger = logging.getLogger(import_name)
        self._routes = []
        self._teardowns = []
        self._errorhandlers = {}
        self._jinja_env = Environment(loader=FileSystemLoader(str(self.root_path / "templates")))

    def _compile_rule(self, rule):
        int_params = set(re.findall(r"<int:([a-zA-Z_][a-zA-Z0-9_]*)>", rule))
        def repl(m):
            kind, name = m.group(1), m.group(2)
            if kind == "int":
                return f"(?P<{name}>\d+)"
            if kind == "path":
                return f"(?P<{name}>.+)"
            return f"(?P<{name}>[^/]+)"
        pattern = re.sub(r"<(?:(int|string|path):)?([a-zA-Z_][a-zA-Z0-9_]*)>", repl, rule)
        return re.compile(f"^{pattern}$"), int_params
    def route(self, rule, methods=None):
        methods_set = {m.upper() for m in (methods or ["GET"])}
        regex, int_params = self._compile_rule(rule)

        def decorator(fn):
            self._routes.append((regex, int_params, methods_set, fn))
            return fn

        return decorator

    def get(self, rule):
        return self.route(rule, methods=["GET"])

    def post(self, rule):
        return self.route(rule, methods=["POST"])

    def patch(self, rule):
        return self.route(rule, methods=["PATCH"])

    def delete(self, rule):
        return self.route(rule, methods=["DELETE"])

    def teardown_appcontext(self, fn):
        self._teardowns.append(fn)
        return fn

    def errorhandler(self, exc_cls):
        def decorator(fn):
            self._errorhandlers[exc_cls] = fn
            return fn

        return decorator

    def test_client(self):
        return _TestClient(self)

    def _normalize_response(self, rv):
        if isinstance(rv, tuple):
            resp, status = rv[0], rv[1]
            if isinstance(resp, Response):
                resp.status_code = int(status)
                return resp
            return Response(resp, status=int(status))
        if isinstance(rv, Response):
            return rv
        return Response(str(rv), status=200)

    def _dispatch(self, req, session_store):
        ctx = {
            "app": self,
            "request": req,
            "g": _GNamespace(),
            "session": _SessionDict(session_store),
        }
        token = _ctx_var.set(ctx)
        err_caught = None
        try:
            max_len = self.config.get("MAX_CONTENT_LENGTH")
            if max_len and len(req.data) > max_len:
                raise RequestEntityTooLarge()

            if req.path.startswith("/static/") and req.method == "GET":
                rel = req.path[len("/static/"):]
                return send_from_directory(self.root_path / "static", rel, max_age=3600)

            matched_path = False
            for regex, int_params, methods_set, fn in self._routes:
                m = regex.match(req.path)
                if m:
                    matched_path = True
                    if req.method not in methods_set:
                        continue
                    kwargs = m.groupdict()
                    for p in int_params:
                        if p in kwargs:
                            kwargs[p] = int(kwargs[p])
                    rv = fn(**kwargs)
                    resp = self._normalize_response(rv)
                    session_store.clear()
                    session_store.update(ctx["session"])
                    return resp
            if matched_path:
                return Response(json.dumps({"error": "Method not allowed."}), status=405, content_type="application/json")
            return Response(json.dumps({"error": "Not found."}), status=404, content_type="application/json")
        except Exception as exc:
            err_caught = exc
            for exc_cls, handler in self._errorhandlers.items():
                if isinstance(exc, exc_cls):
                    return self._normalize_response(handler(exc))
            raise
        finally:
            for td in self._teardowns:
                try:
                    td(err_caught)
                except Exception:
                    pass
            _ctx_var.reset(token)

    def wsgi_app(self, environ, start_response):
        method = environ.get("REQUEST_METHOD", "GET").upper()
        path = environ.get("PATH_INFO", "/") or "/"
        query = environ.get("QUERY_STRING", "")
        args = {k: v[0] if len(v) == 1 else v for k, v in urllib.parse.parse_qs(query, keep_blank_values=True).items()}

        try:
            content_length = int(environ.get("CONTENT_LENGTH") or 0)
        except ValueError:
            content_length = 0
        raw_body = environ["wsgi.input"].read(content_length) if content_length > 0 else b""
        content_type = environ.get("CONTENT_TYPE", "")

        form = {}
        files = {}
        if "multipart/form-data" in content_type:
            form, files = _parse_multipart(raw_body, content_type)
        elif "application/x-www-form-urlencoded" in content_type:
            parsed_f = urllib.parse.parse_qs(raw_body.decode("utf-8", errors="replace"), keep_blank_values=True)
            form = {k: v[0] if len(v) == 1 else v for k, v in parsed_f.items()}

        serializer = URLSafeSerializer(self.config.get("SECRET_KEY", "dev-key"))
        cookie_header = environ.get("HTTP_COOKIE", "")
        session_store = {}
        if cookie_header:
            c = http.cookies.SimpleCookie()
            c.load(cookie_header)
            if "session" in c:
                try:
                    session_store = serializer.loads(c["session"].value)
                except BadSignature:
                    session_store = {}

        req = _Request(method=method, path=path, args=args, form=form, files=files, raw_body=raw_body)
        resp = self._dispatch(req, session_store)

        headers = list(resp.headers.items())
        cookie_val = serializer.dumps(dict(session_store))
        headers.append(("Set-Cookie", f"session={cookie_val}; Path=/; HttpOnly; SameSite=Lax"))
        status_line = f"{resp.status_code} OK" if resp.status_code < 400 else f"{resp.status_code} ERROR"
        start_response(status_line, headers)
        return [resp.data]

    def __call__(self, environ, start_response):
        return self.wsgi_app(environ, start_response)

    def run(self, host="127.0.0.1", port=5000, debug=False):
        print(f" * Running Crop2Costumer on http://{host}:{port}")
        with make_server(host, port, self) as httpd:
            httpd.serve_forever()
