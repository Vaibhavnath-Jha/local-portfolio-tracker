import json
import uuid
import os
import csv
import io
import re
import math
import copy
import secrets
import tempfile
import threading
import functools
import subprocess
import urllib.parse
from datetime import datetime, timedelta
from dateutil.relativedelta import relativedelta
import requests as req
import pdfplumber
from flask import Flask, render_template, jsonify, request, session, redirect, url_for
from werkzeug.exceptions import HTTPException
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)
# Pre-accounts location of the single portfolio. It is handed to the first account that signs up.
PORTFOLIO_FILE = os.environ.get("PORTFOLIO_FILE") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "data", "portfolio.json"
)
DATA_DIR = os.path.dirname(PORTFOLIO_FILE)
USERS_FILE = os.path.join(DATA_DIR, "users.json")
USERS_DIR = os.path.join(DATA_DIR, "users")
SECRET_KEY_FILE = os.path.join(DATA_DIR, "secret_key")
ALLOW_SIGNUP = os.environ.get("ALLOW_SIGNUP", "1") == "1"

MARKET_TYPES = ("stock", "etf", "gold_etf", "mutual_fund", "crypto")
# Identifiers for market types that aren't priced by Yahoo ticker (see each region's yahoo_types)
IDENTIFIER_FIELDS = {
    "mutual_fund": ("scheme_code", "Scheme code"),
    "crypto": ("coin_id", "Coin ID"),
}
COMPOUNDING_PERIODS = {"monthly": 12, "quarterly": 4, "half_yearly": 2, "yearly": 1}
CURRENCY_SYMBOLS = {"INR": "₹", "EUR": "€", "USD": "$"}

# Each region is a separate portfolio, valued in its own currency
REGIONS = {
    "in": {
        "name": "India",
        "endpoint": "index",
        "currency": "INR",
        "file": "portfolio.json",
        "types": {
            "stock": "Stock (NSE/BSE)", "etf": "ETF", "gold_etf": "Gold ETF", "mutual_fund": "Mutual Fund",
            "crypto": "Cryptocurrency", "pf": "Provident Fund (PF)", "fd": "Fixed Deposit (FD)",
        },
        "yahoo_types": ("stock", "etf", "gold_etf"),
        "ticker_suffix": ".NS",
        "cpi_country": "IN",
        "default_inflation": 1.05,
        "benchmark": {"ticker": "^NSEI", "label": "Nifty 50"},
        "imports": True,
        "category_labels": {},
    },
    "de": {
        "name": "Germany",
        "endpoint": "germany",
        "currency": "EUR",
        "file": "portfolio_de.json",
        "types": {
            "stock": "Stock", "etf": "ETF", "gold_etf": "Gold ETC", "mutual_fund": "Mutual Fund",
            "crypto": "Cryptocurrency", "fd": "Fixed Deposit (Festgeld)",
        },
        # German and global funds are listed on Yahoo too (e.g. 0P0000XXXX.F), so everything goes by ticker
        "yahoo_types": ("stock", "etf", "gold_etf", "mutual_fund"),
        "ticker_suffix": ".DE",
        "cpi_country": "DE",
        "default_inflation": 1.02,
        # iShares Core MSCI World on Xetra, as a EUR-priced stand-in for the index
        "benchmark": {"ticker": "EUNL.DE", "label": "MSCI World"},
        "imports": False,
        "category_labels": {"gold_etf": "Gold ETCs"},
    },
}

# Yahoo quotes some listings in minor units (pence, cents)
MINOR_UNIT_CURRENCIES = {"GBp": "GBP", "GBX": "GBP", "ZAc": "ZAR", "ILA": "ILS"}

# In-memory price cache
_price_cache = {}
_historical_cache = {}
_fx_cache = {}

_portfolio_lock = threading.RLock()
_users_lock = threading.Lock()


def write_json_atomic(path, data, mode=0o644):
    """Write to a temp file and atomically swap it in, so a crash mid-write can't corrupt the file."""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=directory, prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp_path, mode)
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise


def portfolio_file(region):
    """The signed-in user's portfolio for a region. Usernames are restricted to [a-z0-9_-], so they're safe as folder names."""
    return os.path.join(USERS_DIR, session["user"], REGIONS[region]["file"])


def load_portfolio(region):
    path = portfolio_file(region)
    if not os.path.exists(path):
        return {"investments": []}
    with open(path, "r") as f:
        return json.load(f)


def save_portfolio(data, region):
    write_json_atomic(portfolio_file(region), data)


def request_region():
    region = request.args.get("region", "in")
    if region not in REGIONS:
        raise ValidationError("Unknown region '{}'".format(region))
    return region


def identifier_field(region, inv_type):
    """(field, label) that identifies a market investment's price source in this region."""
    if inv_type in REGIONS[region]["yahoo_types"]:
        return "ticker", "Ticker"
    return IDENTIFIER_FIELDS[inv_type]


def locked(view):
    """Hold the portfolio lock for the duration of a request that modifies portfolio.json."""
    @functools.wraps(view)
    def wrapper(*args, **kwargs):
        with _portfolio_lock:
            return view(*args, **kwargs)
    return wrapper


# --- Accounts ---

USERNAME_RE = re.compile(r"^[a-z0-9_-]{3,32}$")


def load_secret_key():
    """Sessions are signed with this key; keeping it in data/ means logins survive restarts."""
    if os.environ.get("SECRET_KEY"):
        return os.environ["SECRET_KEY"]
    if not os.path.exists(SECRET_KEY_FILE):
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(SECRET_KEY_FILE, "w") as f:
            f.write(secrets.token_hex(32))
        os.chmod(SECRET_KEY_FILE, 0o600)
    with open(SECRET_KEY_FILE) as f:
        return f.read().strip()


app.secret_key = load_secret_key()
app.config.update(
    SESSION_COOKIE_SAMESITE="Lax",
    # Set to 1 when the app is only reached over HTTPS (e.g. through Caddy), so the cookie is never sent in clear text
    SESSION_COOKIE_SECURE=os.environ.get("SESSION_COOKIE_SECURE") == "1",
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
)


def load_users():
    if not os.path.exists(USERS_FILE):
        return {}
    with open(USERS_FILE, "r") as f:
        return json.load(f)


def signup_allowed():
    # The first account can always be created, otherwise ALLOW_SIGNUP=0 on a fresh install would lock everyone out
    return ALLOW_SIGNUP or not load_users()


def create_user(username, password, confirm):
    if not USERNAME_RE.match(username):
        raise ValidationError("Username must be 3-32 characters: lowercase letters, digits, - or _")
    if not 8 <= len(password) <= 1024:
        raise ValidationError("Password must be at least 8 characters")
    if password != confirm:
        raise ValidationError("Passwords don't match")
    with _users_lock:
        users = load_users()
        if username in users:
            raise ValidationError("That username is taken")
        if not users and os.path.exists(PORTFOLIO_FILE):
            # The first account takes over the portfolio from before accounts existed
            with _portfolio_lock:
                os.makedirs(os.path.join(USERS_DIR, username), exist_ok=True)
                os.replace(PORTFOLIO_FILE, os.path.join(USERS_DIR, username, "portfolio.json"))
        users[username] = {
            "password_hash": generate_password_hash(password),
            "created": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        write_json_atomic(USERS_FILE, users, mode=0o600)


def start_session(username):
    session.clear()
    session.permanent = True
    session["user"] = username


@app.before_request
def require_login():
    if request.endpoint in ("login", "signup", "static"):
        return None
    if session.get("user") in load_users():
        return None
    session.clear()
    if request.path.startswith("/api/"):
        return jsonify({"status": "error", "message": "Not logged in"}), 401
    return redirect(url_for("login"))


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "GET" and not load_users():
        return redirect(url_for("signup"))
    error = None
    username = request.form.get("username", "").strip().lower()
    if request.method == "POST":
        user = load_users().get(username)
        if user and check_password_hash(user["password_hash"], request.form.get("password", "")):
            start_session(username)
            return redirect(url_for("index"))
        error = "Wrong username or password"
    return render_template("login.html", mode="login", error=error, username=username,
                           allow_signup=signup_allowed())


@app.route("/signup", methods=["GET", "POST"])
def signup():
    if not signup_allowed():
        return redirect(url_for("login"))
    error = None
    username = request.form.get("username", "").strip().lower()
    if request.method == "POST":
        try:
            create_user(username, request.form.get("password", ""), request.form.get("confirm", ""))
        except ValidationError as e:
            error = str(e)
        else:
            start_session(username)
            return redirect(url_for("index"))
    return render_template("login.html", mode="signup", error=error, username=username,
                           first_user=not load_users())


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return redirect(url_for("login"))


# --- Validation ---

class ValidationError(ValueError):
    pass


def _number(value, label, minimum=None, positive=False):
    try:
        n = float(value)
    except (TypeError, ValueError):
        raise ValidationError("{} must be a number".format(label))
    if not math.isfinite(n):
        raise ValidationError("{} must be a number".format(label))
    if positive and n <= 0:
        raise ValidationError("{} must be greater than 0".format(label))
    if minimum is not None and n < minimum:
        raise ValidationError("{} must be at least {}".format(label, minimum))
    return n


def _date(value, label):
    try:
        return datetime.strptime(value, "%Y-%m-%d")
    except (TypeError, ValueError):
        raise ValidationError("{} must be a date (YYYY-MM-DD)".format(label))


def check_transaction(t):
    try:
        _date(t.get("date"), "Date")
        _number(t.get("quantity"), "Quantity")
        _number(t.get("buy_price"), "Price", minimum=0)
    except ValidationError as e:
        raise ValidationError("Transaction {}: {}".format(t.get("date") or t.get("id") or "", e))


def check_contribution(c):
    try:
        _date(c.get("date"), "Date")
        _number(c.get("amount"), "Amount", minimum=0)
    except ValidationError as e:
        raise ValidationError("Contribution {}: {}".format(c.get("date") or c.get("id") or "", e))


def check_schedule(s):
    _number(s.get("amount"), "Amount", positive=True)
    day = _number(s.get("day", 1), "Day")
    if day != int(day) or not 1 <= day <= 31:
        raise ValidationError("Day must be a whole number from 1 to 31")
    start = _date(s.get("start_date"), "Start date")
    if s.get("end_date"):
        if _date(s["end_date"], "End date") < start:
            raise ValidationError("End date must be on or after the start date")
    if s.get("buy_price") not in (None, ""):
        _number(s["buy_price"], "Buy price", positive=True)


def check_investment_type(inv_type, region):
    if inv_type not in REGIONS[region]["types"]:
        raise ValidationError("Unknown investment type '{}'".format(inv_type))


def investment_problem(inv, region, strict=False):
    """Return a description of what's wrong with an investment, or None if it's usable.

    strict=True additionally requires a name and a non-empty identifier, for user input.
    Stored data is checked non-strictly since imports can leave e.g. an unmatched MF scheme code empty."""
    try:
        inv_type = inv.get("type")
        check_investment_type(inv_type, region)
        if strict and not str(inv.get("name") or "").strip():
            raise ValidationError("Name is required")

        if inv_type == "fd":
            _number(inv.get("principal"), "Principal", positive=True)
            _number(inv.get("interest_rate"), "Interest rate", minimum=0)
            start = _date(inv.get("start_date"), "Start date")
            maturity = _date(inv.get("maturity_date"), "Maturity date")
            if maturity < start:
                raise ValidationError("Maturity date must be on or after the start date")
            if inv.get("compounding", "quarterly") not in COMPOUNDING_PERIODS:
                raise ValidationError("Unknown compounding '{}'".format(inv.get("compounding")))
        elif inv_type == "pf":
            _number(inv.get("interest_rate"), "Interest rate", minimum=0)
            for c in inv.get("contributions", []):
                check_contribution(c)
        else:
            field, label = identifier_field(region, inv_type)
            if field not in inv or (strict and not str(inv.get(field) or "").strip()):
                raise ValidationError("{} is required".format(label))
            for t in inv.get("transactions", []):
                check_transaction(t)

        if inv.get("schedule"):
            check_schedule(inv["schedule"])
    except ValidationError as e:
        return str(e)
    return None


def valid_investments(portfolio, region):
    """Investments that can be valued; broken entries are skipped instead of failing the whole request."""
    return [inv for inv in portfolio.get("investments", []) if investment_problem(inv, region) is None]


def json_body():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ValidationError("Request body must be a JSON object")
    return data


class UpstreamError(Exception):
    """A price or exchange-rate source we depend on didn't answer."""


@app.errorhandler(ValidationError)
def handle_validation_error(e):
    return jsonify({"status": "error", "message": str(e)}), 400


@app.errorhandler(UpstreamError)
def handle_upstream_error(e):
    return jsonify({"status": "error", "message": str(e)}), 502


@app.errorhandler(Exception)
def handle_error(e):
    if isinstance(e, HTTPException):
        if not request.path.startswith("/api/"):
            return e
        return jsonify({"status": "error", "message": e.description}), e.code
    app.logger.exception("Unhandled error on %s", request.path)
    return jsonify({"status": "error", "message": "Server error: {}".format(e)}), 500


def yahoo_fetch(url):
    """Fetch URL via curl to avoid Yahoo's Python requests blocking."""
    try:
        result = subprocess.run(
            ["curl", "-s", "-H", "User-Agent: Mozilla/5.0", url],
            capture_output=True, text=True, timeout=15
        )
        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout)
    except Exception as e:
        print("yahoo_fetch error: {}".format(e))
    return None


def yahoo_chart(ticker, period="1d", interval="1d", range_start=None, range_end=None):
    """Fetch data from Yahoo Finance v8 chart API."""
    url = "https://query1.finance.yahoo.com/v8/finance/chart/{}?interval={}".format(ticker, interval)
    if range_start and range_end:
        p1 = int(datetime.strptime(range_start, "%Y-%m-%d").timestamp())
        p2 = int(datetime.strptime(range_end, "%Y-%m-%d").timestamp())
        url += "&period1={}&period2={}".format(p1, p2)
    else:
        url += "&range={}".format(period)
    data = yahoo_fetch(url)
    if data:
        result = data.get("chart", {}).get("result")
        if result and len(result) > 0:
            return result[0]
    return None


def value_on(series, date_str, days=7):
    """Value in a date -> value dict on date_str, or the closest earlier one within `days` (weekends, holidays)."""
    dt = datetime.strptime(date_str, "%Y-%m-%d")
    for offset in range(days):
        value = series.get((dt - timedelta(days=offset)).strftime("%Y-%m-%d"))
        if value is not None:
            return value
    return None


def fx_rate(frm, to):
    """Today's rate converting one unit of `frm` into `to`, or None if Yahoo has no answer."""
    if frm == to:
        return 1.0
    if (frm, to) not in _fx_cache:
        chart = yahoo_chart("{}{}=X".format(frm, to), period="5d")
        rate = chart.get("meta", {}).get("regularMarketPrice") if chart else None
        if not rate:
            return None  # not cached, so the next request retries
        _fx_cache[(frm, to)] = float(rate)
    return _fx_cache[(frm, to)]


def fx_history(frm, to, start_date, end_date):
    """Daily closing rates frm -> to as a date -> rate dict."""
    cache_key = ("fx", frm, to, start_date)
    if cache_key in _historical_cache:
        return _historical_cache[cache_key]
    rates = {}
    chart = yahoo_chart("{}{}=X".format(frm, to), interval="1d", range_start=start_date, range_end=end_date)
    if chart:
        closes = chart.get("indicators", {}).get("quote", [{}])[0].get("close", [])
        for ts, close in zip(chart.get("timestamp", []), closes):
            if close is not None:
                rates[datetime.fromtimestamp(ts).strftime("%Y-%m-%d")] = float(close)
    _historical_cache[cache_key] = rates
    return rates


def make_fx_converter(frm, to, start_date):
    """Return f(date_str) -> rate converting `frm` into `to` as of that date.
    Today and later use the live rate; days with no historical quote fall back to it as well."""
    if frm == to:
        return lambda date_str: 1.0
    current = fx_rate(frm, to)
    if current is None:
        raise UpstreamError("Could not fetch the {} to {} exchange rate".format(frm, to))
    today = datetime.now().strftime("%Y-%m-%d")
    history = fx_history(frm, to, start_date, today)

    def convert(date_str):
        if date_str >= today:
            return current
        rate = value_on(history, date_str)
        return rate if rate is not None else current

    return convert


def quote_currency(chart, base):
    """(currency, multiplier) for a Yahoo chart's prices; the multiplier turns minor units like pence into pounds."""
    currency = chart.get("meta", {}).get("currency") or base
    if currency in MINOR_UNIT_CURRENCIES:
        return MINOR_UNIT_CURRENCIES[currency], 0.01
    return currency.upper(), 1.0


def get_current_price(inv, region):
    """Get current price for a market-traded investment, in the region's currency."""
    cache_key = (region, inv["id"])
    if cache_key in _price_cache:
        return _price_cache[cache_key]

    price = None
    inv_type = inv["type"]
    base = REGIONS[region]["currency"]

    if inv_type in REGIONS[region]["yahoo_types"]:
        ticker = inv["ticker"]
        chart = yahoo_chart(ticker, period="5d")
        if chart:
            price = chart.get("meta", {}).get("regularMarketPrice")
            if price is None:
                closes = chart.get("indicators", {}).get("quote", [{}])[0].get("close", [])
                closes = [c for c in closes if c is not None]
                if closes:
                    price = closes[-1]
            if price is not None:
                currency, unit = quote_currency(chart, base)
                rate = fx_rate(currency, base)
                if rate is None:
                    print("No {} to {} rate for {}".format(currency, base, ticker))
                    price = None
                else:
                    price = float(price) * unit * rate

    elif inv_type == "mutual_fund":
        scheme_code = inv["scheme_code"]
        try:
            resp = req.get("https://api.mfapi.in/mf/{}/latest".format(scheme_code), timeout=10)
            data = resp.json()
            if "data" in data and len(data["data"]) > 0:
                price = float(data["data"][0]["nav"])
        except Exception as e:
            print("Error fetching MF {}: {}".format(scheme_code, e))

    elif inv_type == "crypto":
        coin_id = inv["coin_id"]
        vs = base.lower()
        try:
            resp = req.get(
                "https://api.coingecko.com/api/v3/simple/price?ids={}&vs_currencies={}".format(coin_id, vs),
                timeout=10,
            )
            data = resp.json()
            if coin_id in data:
                price = float(data[coin_id][vs])
        except Exception as e:
            print("Error fetching crypto {}: {}".format(coin_id, e))

    if price is not None:
        price = float(price)
        _price_cache[cache_key] = price
    return price


def calculate_fd_value(inv, as_of_date=None):
    """Calculate FD value with compounding."""
    principal = float(inv["principal"])
    rate = float(inv["interest_rate"]) / 100
    start = datetime.strptime(inv["start_date"], "%Y-%m-%d")
    maturity = datetime.strptime(inv["maturity_date"], "%Y-%m-%d")
    compounding = inv.get("compounding", "quarterly")

    if as_of_date is None:
        as_of_date = datetime.now()
    elif isinstance(as_of_date, str):
        as_of_date = datetime.strptime(as_of_date, "%Y-%m-%d")

    if as_of_date < start:
        return 0
    if as_of_date > maturity:
        return 0

    n_map = {"monthly": 12, "quarterly": 4, "half_yearly": 2, "yearly": 1}
    n = n_map.get(compounding, 4)
    years = (as_of_date - start).days / 365.25
    value = principal * ((1 + rate / n) ** (n * years))
    return round(value, 2)


def calculate_pf_value(inv, as_of_date=None):
    """Calculate PF value with annual compounding on contributions."""
    rate = float(inv["interest_rate"]) / 100
    contributions = inv.get("contributions", [])

    if as_of_date is None:
        as_of_date = datetime.now()
    elif isinstance(as_of_date, str):
        as_of_date = datetime.strptime(as_of_date, "%Y-%m-%d")

    total = 0
    for c in contributions:
        c_date = datetime.strptime(c["date"], "%Y-%m-%d")
        if c_date > as_of_date:
            continue
        years = (as_of_date - c_date).days / 365.25
        amount = float(c["amount"])
        total += amount * ((1 + rate) ** years)
    return round(total, 2)


def get_historical_prices(inv, region, start_date, end_date=None):
    """Get historical prices for market-traded investments, in the region's currency."""
    cache_key = (region, inv["id"], start_date)
    if cache_key in _historical_cache:
        return _historical_cache[cache_key]

    if end_date is None:
        end_date = datetime.now().strftime("%Y-%m-%d")

    prices = {}
    inv_type = inv["type"]
    base = REGIONS[region]["currency"]

    if inv_type in REGIONS[region]["yahoo_types"]:
        chart = yahoo_chart(inv["ticker"], interval="1d", range_start=start_date, range_end=end_date)
        if chart:
            currency, unit = quote_currency(chart, base)
            to_base = None
            if currency != base:
                try:
                    to_base = make_fx_converter(currency, base, start_date)
                except UpstreamError as e:
                    print("{} for {}".format(e, inv["ticker"]))
                    chart = None
        if chart:
            timestamps = chart.get("timestamp", [])
            closes = chart.get("indicators", {}).get("quote", [{}])[0].get("close", [])
            for i, ts in enumerate(timestamps):
                if i < len(closes) and closes[i] is not None:
                    d = datetime.fromtimestamp(ts).strftime("%Y-%m-%d")
                    prices[d] = float(closes[i]) * unit * (to_base(d) if to_base else 1.0)

    elif inv_type == "mutual_fund":
        try:
            resp = req.get("https://api.mfapi.in/mf/{}".format(inv["scheme_code"]), timeout=30)
            data = resp.json()
            if "data" in data:
                for entry in data["data"]:
                    d = datetime.strptime(entry["date"], "%d-%m-%Y").strftime("%Y-%m-%d")
                    if start_date <= d <= end_date:
                        prices[d] = float(entry["nav"])
        except Exception as e:
            print("Error fetching MF history: {}".format(e))

    elif inv_type == "crypto":
        try:
            # CoinGecko free API limits to 365 days of history
            earliest = datetime.strptime(start_date, "%Y-%m-%d")
            max_start = datetime.now() - timedelta(days=364)
            if earliest < max_start:
                earliest = max_start
            start_ts = int(earliest.timestamp())
            end_ts = int(datetime.strptime(end_date, "%Y-%m-%d").timestamp())
            resp = req.get(
                "https://api.coingecko.com/api/v3/coins/{}/market_chart/range"
                "?vs_currency={}&from={}&to={}".format(inv["coin_id"], base.lower(), start_ts, end_ts),
                timeout=30,
            )
            data = resp.json()
            if "prices" in data:
                for ts, price in data["prices"]:
                    d = datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d")
                    prices[d] = float(price)
        except Exception as e:
            print("Error fetching crypto history: {}".format(e))

    _historical_cache[cache_key] = prices
    return prices


def get_inflation_data(region):
    """Fetch the region's CPI data from World Bank API. Returns dict of year -> CPI index.
    Extrapolates missing recent years using last known year-over-year rate."""
    cache_key = ("cpi", region)
    if cache_key in _historical_cache:
        return _historical_cache[cache_key]
    try:
        resp = req.get(
            "https://api.worldbank.org/v2/country/{}/indicator/FP.CPI.TOTL?format=json&per_page=50&date=2000:{}".format(
                REGIONS[region]["cpi_country"], datetime.now().year),
            timeout=10,
        )
        data = resp.json()
        if len(data) > 1 and data[1]:
            cpi = {}
            for entry in data[1]:
                if entry["value"] is not None:
                    cpi[int(entry["date"])] = float(entry["value"])
            # Extrapolate missing years up to current year using last known YoY rate
            if cpi:
                latest = max(cpi.keys())
                current_year = datetime.now().year
                if latest >= 2 and (latest - 1) in cpi:
                    yoy_rate = cpi[latest] / cpi[latest - 1]
                else:
                    yoy_rate = REGIONS[region]["default_inflation"]
                for y in range(latest + 1, current_year + 2):
                    cpi[y] = cpi[y - 1] * yoy_rate
                _historical_cache[cache_key] = cpi
                return cpi
    except Exception as e:
        print("Error fetching CPI data: {}".format(e))
    return None


def make_inflation_adjuster(cpi_data, now):
    """Return f(date_str) -> multiplier that converts rupees on that date into today's rupees.
    Annual CPI is interpolated linearly by day of year."""
    first, last = min(cpi_data), max(cpi_data)

    def cpi_at(dt):
        year = min(max(dt.year, first), last)
        cpi_y = cpi_data[year]
        cpi_next = cpi_data.get(year + 1, cpi_y)
        frac = (dt.timetuple().tm_yday - 1) / 365.0 if dt.year == year else 0.0
        return cpi_y + (cpi_next - cpi_y) * frac

    now_cpi = cpi_at(now)
    factors = {}

    def adjust(date_str):
        if date_str not in factors:
            factors[date_str] = now_cpi / cpi_at(datetime.strptime(date_str, "%Y-%m-%d"))
        return factors[date_str]

    return adjust


@locked
def auto_generate_scheduled(region):
    """Auto-generate pending recurring entries for all investments with schedules."""
    portfolio = load_portfolio(region)
    investments = portfolio.get("investments", [])
    changed = False

    for inv in investments:
        schedule = inv.get("schedule")
        if not schedule or investment_problem(inv, region):
            continue

        amount = float(schedule["amount"])
        day = int(schedule.get("day", 1))
        start = datetime.strptime(schedule["start_date"], "%Y-%m-%d")
        end_str = schedule.get("end_date")
        end = datetime.strptime(end_str, "%Y-%m-%d") if end_str else datetime.now()
        inv_type = inv["type"]

        current = start.replace(day=min(day, 28))
        while current <= end:
            date_str = current.strftime("%Y-%m-%d")

            if inv_type == "pf":
                existing_dates = {c["date"] for c in inv.get("contributions", [])}
                if date_str not in existing_dates:
                    inv.setdefault("contributions", []).append({
                        "id": str(uuid.uuid4())[:8],
                        "date": date_str,
                        "amount": str(amount),
                    })
                    changed = True
            else:
                existing_dates = {t["date"] for t in inv.get("transactions", [])}
                if date_str not in existing_dates:
                    buy_price = schedule.get("buy_price")
                    if buy_price:
                        qty = amount / float(buy_price)
                        inv.setdefault("transactions", []).append({
                            "id": str(uuid.uuid4())[:8],
                            "date": date_str,
                            "quantity": str(round(qty, 4)),
                            "buy_price": str(buy_price),
                        })
                    else:
                        inv.setdefault("transactions", []).append({
                            "id": str(uuid.uuid4())[:8],
                            "date": date_str,
                            "quantity": "0",
                            "buy_price": str(amount),
                        })
                    changed = True

            current += relativedelta(months=1)

    if changed:
        save_portfolio(portfolio, region)

    return changed


def calculate_xirr(cash_flows):
    """Calculate XIRR given a list of (date_string, amount) tuples.
    Negative amounts = money going out (investments), positive = money coming in (current value).
    Returns annualized return as a decimal (e.g. 0.12 for 12%), or None if it can't converge."""
    if not cash_flows or len(cash_flows) < 2:
        return None
    # Parse dates and amounts
    flows = []
    for date_str, amount in cash_flows:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
        flows.append((dt, float(amount)))
    flows.sort(key=lambda x: x[0])
    d0 = flows[0][0]
    # Newton's method to find rate where NPV = 0
    def npv(rate):
        return sum(amt / ((1 + rate) ** ((dt - d0).days / 365.25)) for dt, amt in flows)
    def dnpv(rate):
        return sum(-((dt - d0).days / 365.25) * amt / ((1 + rate) ** ((dt - d0).days / 365.25 + 1)) for dt, amt in flows)
    rate = 0.1  # initial guess
    for _ in range(200):
        n = npv(rate)
        d = dnpv(rate)
        if abs(d) < 1e-12:
            break
        new_rate = rate - n / d
        # Clamp to avoid divergence
        new_rate = max(new_rate, -0.99)
        if abs(new_rate - rate) < 1e-9:
            return round(new_rate * 100, 2)
        rate = new_rate
    # Check if it converged
    if abs(npv(rate)) < 1.0:
        return round(rate * 100, 2)
    return None


def render_page(template, page, **page_config):
    page_config.setdefault("currency", "EUR")
    return render_template(
        template,
        username=session["user"],
        page=page,
        regions=REGIONS,
        currencies=CURRENCY_SYMBOLS,
        page_config=page_config,
    )


def render_region_page(region):
    cfg = REGIONS[region]
    return render_page(
        "index.html", region,
        region=region,
        currency=cfg["currency"],
        yahooTypes=cfg["yahoo_types"],
        tickerSuffix=cfg["ticker_suffix"],
        benchmarkLabel=cfg["benchmark"]["label"],
        categoryLabels=cfg["category_labels"],
    )


@app.route("/")
def index():
    return render_region_page("in")


@app.route("/de")
def germany():
    return render_region_page("de")


@app.route("/combined")
def combined_page():
    return render_page("combined.html", "combined",
                       regions=[{"id": r, "name": cfg["name"], "url": url_for(cfg["endpoint"])}
                                for r, cfg in REGIONS.items()])


@app.route("/api/portfolio")
def get_portfolio():
    summary, _ = portfolio_summary(request_region())
    return jsonify(summary)


def portfolio_summary(region):
    """Value every investment in a region (in its currency).
    Returns (summary, contributions) where contributions are the (date, amount) cash flows put in;
    sells and other withdrawals are negative."""
    # Auto-generate any pending scheduled entries
    auto_generate_scheduled(region)

    portfolio = load_portfolio(region)
    investments = valid_investments(portfolio, region)
    results = []
    total_value = 0
    total_invested = 0
    contributions = []
    holdings_value = 0

    # Broken entries are returned with an error so the UI can show them for fixing,
    # but they're left out of every total
    for inv in portfolio.get("investments", []):
        problem = investment_problem(inv, region)
        if problem:
            results.append({
                **inv,
                "error": problem,
                "current_value": 0,
                "invested": 0,
                "gain_loss": 0,
                "gain_loss_pct": 0,
                "xirr": None,
                "current_price": None,
                "total_quantity": 0,
            })

    for inv in investments:
        item = {**inv}
        inv_type = inv["type"]

        if inv_type == "fd":
            current_value = calculate_fd_value(inv)
            invested = float(inv["principal"]) if current_value > 0 else 0
            item["current_value"] = current_value
            item["invested"] = invested
        elif inv_type == "pf":
            current_value = calculate_pf_value(inv)
            invested = sum(float(c["amount"]) for c in inv.get("contributions", []))
            item["current_value"] = current_value
            item["invested"] = invested
        else:
            price = get_current_price(inv, region)
            transactions = inv.get("transactions", [])
            total_qty = sum(float(t["quantity"]) for t in transactions)
            invested = sum(float(t["quantity"]) * float(t["buy_price"]) for t in transactions)
            current_value = (price * total_qty) if price else 0
            item["current_price"] = price
            item["total_quantity"] = round(total_qty, 2)
            item["current_value"] = round(current_value, 2)
            item["invested"] = round(invested, 2)

        if item["current_value"]:
            item["gain_loss"] = round(item["current_value"] - item["invested"], 2)
            item["gain_loss_pct"] = round(
                ((item["current_value"] - item["invested"]) / item["invested"] * 100) if item["invested"] else 0, 2
            )
        else:
            item["gain_loss"] = 0
            item["gain_loss_pct"] = 0

        # Per-investment XIRR
        today = datetime.now().strftime("%Y-%m-%d")
        inv_flows = []
        if inv_type == "fd":
            if item["current_value"] > 0:
                inv_flows.append((inv["start_date"], -float(inv["principal"])))
                inv_flows.append((today, item["current_value"]))
        elif inv_type == "pf":
            for c in inv.get("contributions", []):
                inv_flows.append((c["date"], -float(c["amount"])))
            if item["current_value"] > 0:
                inv_flows.append((today, item["current_value"]))
        else:
            for t in inv.get("transactions", []):
                amt = float(t["quantity"]) * float(t["buy_price"])
                if amt > 0:
                    inv_flows.append((t["date"], -amt))
            if item["current_value"] > 0:
                inv_flows.append((today, item["current_value"]))
        item["xirr"] = calculate_xirr(inv_flows) if len(inv_flows) >= 2 else None

        total_value += item["current_value"]
        total_invested += item["invested"]
        results.append(item)

        # Cash put in, for the portfolio XIRR (matured FDs have been paid out, so they drop out)
        if inv_type == "fd":
            if item["current_value"] > 0:
                contributions.append((inv["start_date"], float(inv["principal"])))
        elif inv_type == "pf":
            contributions.extend((c["date"], float(c["amount"])) for c in inv.get("contributions", []))
        else:
            contributions.extend((t["date"], float(t["quantity"]) * float(t["buy_price"]))
                                 for t in inv.get("transactions", []))
        if item["current_value"] > 0:
            holdings_value += item["current_value"]

    # Calculate portfolio XIRR
    today = datetime.now().strftime("%Y-%m-%d")
    xirr_flows = [(d, -amount) for d, amount in contributions]
    if holdings_value > 0:
        xirr_flows.append((today, holdings_value))
    xirr_val = calculate_xirr(xirr_flows) if xirr_flows else None

    summary = {
        "investments": results,
        "total_value": round(total_value, 2),
        "total_invested": round(total_invested, 2),
        "total_gain_loss": round(total_value - total_invested, 2),
        "total_gain_loss_pct": round(
            ((total_value - total_invested) / total_invested * 100) if total_invested else 0, 2
        ),
        "xirr": xirr_val,
    }
    return summary, contributions


def _find_existing(investments, inv_type, data, region):
    """Find an existing investment that matches the new one being added."""
    for inv in investments:
        if inv["type"] != inv_type:
            continue
        if inv_type in MARKET_TYPES:
            field, _ = identifier_field(region, inv_type)
            if inv.get(field) == data.get(field):
                return inv
        if inv_type == "pf" and inv.get("name") == data.get("name"):
            return inv
    return None


def _find_investment(portfolio, inv_id):
    for inv in portfolio.get("investments", []):
        if inv["id"] == inv_id:
            return inv
    return None


def _not_found():
    return jsonify({"status": "error", "message": "Investment not found"}), 404


@app.route("/api/investment", methods=["POST"])
@locked
def add_investment():
    data = json_body()
    region = request_region()
    portfolio = load_portfolio(region)
    inv_type = data.get("type")
    check_investment_type(inv_type, region)
    if data.get("transaction"):
        check_transaction(data["transaction"])
    if data.get("contribution"):
        check_contribution(data["contribution"])

    # Check if this investment already exists — if so, append transaction
    existing = _find_existing(portfolio.get("investments", []), inv_type, data, region)

    if existing and inv_type in MARKET_TYPES:
        if data.get("transaction"):
            t = data["transaction"]
            t["id"] = str(uuid.uuid4())[:8]
            existing.setdefault("transactions", []).append(t)
        save_portfolio(portfolio, region)
        return jsonify({"status": "ok", "id": existing["id"]})

    if existing and inv_type == "pf":
        if data.get("contribution"):
            c = data["contribution"]
            c["id"] = str(uuid.uuid4())[:8]
            existing.setdefault("contributions", []).append(c)
        if data.get("interest_rate") is not None:
            existing["interest_rate"] = _number(data["interest_rate"], "Interest rate", minimum=0)
        save_portfolio(portfolio, region)
        return jsonify({"status": "ok", "id": existing["id"]})

    # No existing match — create new investment
    inv_id = str(uuid.uuid4())[:8]
    investment = {"id": inv_id, "type": inv_type, "name": data.get("name"), "category": data.get("category", inv_type)}

    if inv_type in MARKET_TYPES:
        field, _ = identifier_field(region, inv_type)
        investment[field] = data.get(field)
        investment["transactions"] = []
        if data.get("transaction"):
            t = data["transaction"]
            t["id"] = str(uuid.uuid4())[:8]
            investment["transactions"].append(t)

    elif inv_type == "pf":
        investment["interest_rate"] = data.get("interest_rate")
        investment["contributions"] = []
        if data.get("contribution"):
            c = data["contribution"]
            c["id"] = str(uuid.uuid4())[:8]
            investment["contributions"].append(c)

    elif inv_type == "fd":
        investment["principal"] = data.get("principal")
        investment["interest_rate"] = data.get("interest_rate")
        investment["start_date"] = data.get("start_date")
        investment["maturity_date"] = data.get("maturity_date")
        investment["compounding"] = data.get("compounding", "quarterly")

    problem = investment_problem(investment, region, strict=True)
    if problem:
        raise ValidationError(problem)

    portfolio["investments"].append(investment)
    save_portfolio(portfolio, region)
    return jsonify({"status": "ok", "id": inv_id})


@app.route("/api/investment/<inv_id>", methods=["DELETE"])
@locked
def delete_investment(inv_id):
    region = request_region()
    portfolio = load_portfolio(region)
    portfolio["investments"] = [i for i in portfolio["investments"] if i["id"] != inv_id]
    save_portfolio(portfolio, region)
    _price_cache.pop((region, inv_id), None)
    return jsonify({"status": "ok"})


@app.route("/api/investment/<inv_id>", methods=["PUT"])
@locked
def edit_investment(inv_id):
    data = json_body()
    region = request_region()
    portfolio = load_portfolio(region)
    original = _find_investment(portfolio, inv_id)
    if not original:
        return _not_found()

    # Apply the edit to a copy and only keep it if the result is valid
    inv = copy.deepcopy(original)
    inv["name"] = data.get("name", inv.get("name"))

    # Handle type change
    new_type = data.get("type")
    if new_type and new_type != inv["type"]:
        inv["type"] = new_type
        inv["category"] = data.get("category", new_type)

    inv_type = inv["type"]

    # Update type-specific fields
    check_investment_type(inv_type, region)
    if inv_type in MARKET_TYPES:
        field, _ = identifier_field(region, inv_type)
        if data.get(field):
            inv[field] = data[field]
        inv.setdefault("transactions", [])
    elif inv_type == "pf":
        if "interest_rate" in data:
            inv["interest_rate"] = data["interest_rate"]
        inv.setdefault("contributions", [])
    elif inv_type == "fd":
        for key in ("principal", "interest_rate", "start_date", "maturity_date", "compounding"):
            if key in data:
                inv[key] = data[key]

    if not str(inv.get("name") or "").strip():
        raise ValidationError("Name is required")
    problem = investment_problem(inv, region)
    if problem:
        raise ValidationError(problem)

    original.clear()
    original.update(inv)
    save_portfolio(portfolio, region)
    _price_cache.pop((region, inv_id), None)
    return jsonify({"status": "ok"})


@app.route("/api/investment/<inv_id>/transaction", methods=["POST"])
@locked
def add_transaction(inv_id):
    data = json_body()
    region = request_region()
    portfolio = load_portfolio(region)
    inv = _find_investment(portfolio, inv_id)
    if not inv:
        return _not_found()
    t = {**data, "id": str(uuid.uuid4())[:8]}
    if inv["type"] == "pf":
        check_contribution(t)
        inv.setdefault("contributions", []).append(t)
    else:
        check_transaction(t)
        inv.setdefault("transactions", []).append(t)
    save_portfolio(portfolio, region)
    return jsonify({"status": "ok"})


@app.route("/api/investment/<inv_id>/transaction/<txn_id>", methods=["DELETE"])
@locked
def delete_transaction(inv_id, txn_id):
    region = request_region()
    portfolio = load_portfolio(region)
    inv = _find_investment(portfolio, inv_id)
    if not inv:
        return _not_found()
    if inv["type"] == "pf":
        inv["contributions"] = [c for c in inv.get("contributions", []) if c.get("id") != txn_id]
    else:
        inv["transactions"] = [t for t in inv.get("transactions", []) if t.get("id") != txn_id]
    save_portfolio(portfolio, region)
    return jsonify({"status": "ok"})


@app.route("/api/investment/<inv_id>/transaction/<txn_id>", methods=["PUT"])
@locked
def edit_transaction(inv_id, txn_id):
    data = json_body()
    region = request_region()
    portfolio = load_portfolio(region)
    inv = _find_investment(portfolio, inv_id)
    if not inv:
        return _not_found()
    if inv["type"] == "pf":
        fields, check, entries = ("date", "amount"), check_contribution, inv.get("contributions", [])
    else:
        fields, check, entries = ("date", "quantity", "buy_price"), check_transaction, inv.get("transactions", [])
    entry = next((e for e in entries if e.get("id") == txn_id), None)
    if not entry:
        return jsonify({"status": "error", "message": "Transaction not found"}), 404
    updated = {**entry, **{k: data[k] for k in fields if k in data}}
    check(updated)
    entry.update(updated)
    save_portfolio(portfolio, region)
    return jsonify({"status": "ok"})


@app.route("/api/refresh", methods=["POST"])
def refresh_prices():
    global _price_cache, _historical_cache, _fx_cache
    _price_cache = {}
    _historical_cache = {}
    _fx_cache = {}
    return jsonify({"status": "ok"})


@app.route("/api/exchange-rate")
def exchange_rate():
    """Today's rate from the region's currency into ?to=."""
    base = REGIONS[request_region()]["currency"]
    to = request.args.get("to", "")
    if to not in CURRENCY_SYMBOLS:
        raise ValidationError("Unknown currency '{}'".format(to))
    rate = fx_rate(base, to)
    if rate is None:
        raise UpstreamError("Could not fetch the {} to {} exchange rate".format(base, to))
    return jsonify({"rate": rate})


def investment_dates(investments):
    """Every date money went into (or out of) these investments."""
    dates = []
    for inv in investments:
        if inv["type"] == "fd":
            dates.append(inv["start_date"])
        elif inv["type"] == "pf":
            dates.extend(c["date"] for c in inv.get("contributions", []))
        else:
            dates.extend(t["date"] for t in inv.get("transactions", []))
    return dates


def weekly_dates(start_date, end_date):
    """Weekly date points from start_date, always ending on end_date."""
    current = datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.strptime(end_date, "%Y-%m-%d")
    date_points = []
    while current <= end:
        date_points.append(current.strftime("%Y-%m-%d"))
        current += timedelta(days=7)
    if date_points and date_points[-1] != end_date:
        date_points.append(end_date)
    return date_points


@app.route("/api/historical")
def historical():
    return jsonify(portfolio_history(
        request_region(),
        view=request.args.get("view", "value"),  # "value", "returns", or "current"
        use_inflation=request.args.get("inflation", "false") == "true",
        use_benchmark=request.args.get("benchmark", "false") == "true",
    ))


def portfolio_history(region, view="value", use_inflation=False, use_benchmark=False, start_date=None, fx=None):
    """Weekly portfolio value and amount invested for a region.

    start_date starts the series earlier than the first investment (so regions can share one timeline).
    fx(date_str) converts the region's currency into another one as of that date."""
    portfolio = load_portfolio(region)
    investments = valid_investments(portfolio, region)
    all_dates = investment_dates(investments)

    if not all_dates:
        return {"dates": [], "values": [], "invested": []}

    now = datetime.now()
    start_date = min(all_dates + ([start_date] if start_date else []))
    end_date = now.strftime("%Y-%m-%d")

    # Fetch historical prices for all market investments
    hist_prices = {}
    for inv in investments:
        if inv["type"] in MARKET_TYPES:
            hist_prices[inv["id"]] = get_historical_prices(inv, region, start_date, end_date)

    date_points = weekly_dates(start_date, end_date)

    # Inflation adjustment expresses everything in today's money: each point's value is scaled by
    # its own date's factor, and each contribution by the factor of the date it was invested.
    # Currency conversion works the same way, with that date's exchange rate.
    def adj(date_str):
        return 1.0
    if use_inflation:
        cpi_data = get_inflation_data(region)
        if cpi_data:
            adj = make_inflation_adjuster(cpi_data, now)
    if fx:
        inflation_adj = adj

        def adj(date_str):
            return inflation_adj(date_str) * fx(date_str)

    values = []
    invested_values = []
    for dp in date_points:
        total = 0
        total_invested = 0
        dp_dt = datetime.strptime(dp, "%Y-%m-%d")

        for inv in investments:
            inv_type = inv["type"]

            if inv_type == "fd":
                maturity = datetime.strptime(inv["maturity_date"], "%Y-%m-%d") if inv.get("maturity_date") else None
                start = datetime.strptime(inv["start_date"], "%Y-%m-%d")
                if view == "current":
                    # Skip matured FDs in current holdings view
                    if maturity and now > maturity:
                        continue
                    if dp_dt >= start:
                        total += calculate_fd_value(inv, dp)
                    else:
                        # Extrapolate backwards: discount the principal
                        principal = float(inv["principal"])
                        rate = float(inv["interest_rate"]) / 100
                        compounding = inv.get("compounding", "quarterly")
                        n_map = {"monthly": 12, "quarterly": 4, "half_yearly": 2, "yearly": 1}
                        n = n_map.get(compounding, 4)
                        years_back = (start - dp_dt).days / 365.25
                        total += principal / ((1 + rate / n) ** (n * years_back))
                elif dp_dt >= start:
                    fd_val = calculate_fd_value(inv, dp)
                    total += fd_val
                    if fd_val > 0:
                        total_invested += float(inv["principal"]) * adj(inv["start_date"])

            elif inv_type == "pf":
                total += calculate_pf_value(inv, dp)
                total_invested += sum(float(c["amount"]) * adj(c["date"])
                                      for c in inv.get("contributions", []) if c["date"] <= dp)

            else:
                transactions = inv.get("transactions", [])
                price = value_on(hist_prices.get(inv["id"], {}), dp)
                if price is None:
                    continue

                if view == "current":
                    qty = sum(float(t["quantity"]) for t in transactions)
                else:
                    active_txns = [t for t in transactions if t["date"] <= dp]
                    qty = sum(float(t["quantity"]) for t in active_txns)
                    invested = sum(float(t["quantity"]) * float(t["buy_price"]) * adj(t["date"]) for t in active_txns)
                    total_invested += invested

                total += price * qty

        total *= adj(dp)
        values.append(round(total, 2))
        invested_values.append(round(total_invested, 2))

    result = {"dates": date_points, "values": values, "invested": invested_values}

    # Add the region's benchmark index (Nifty 50, MSCI World) if requested
    # Simulates: "what if all the money invested went into the index instead?"
    if use_benchmark and date_points:
        nifty_inv = {"id": "_benchmark", "type": "stock", "ticker": REGIONS[region]["benchmark"]["ticker"]}
        nifty_prices = get_historical_prices(nifty_inv, region, date_points[0], date_points[-1])

        def get_nifty_price(date_str):
            return value_on(nifty_prices, date_str)

        # Collect all cash flows: (date, amount) for each investment
        # For zero-cost acquisitions, use market value at acquisition date
        # Negative amounts represent exits (sells, FD maturities) to mirror total_invested
        cash_flows = []
        for inv in investments:
            inv_type = inv["type"]
            if inv_type == "fd":
                cash_flows.append((inv["start_date"], float(inv["principal"])))
                # "Sell" Nifty 50 units at maturity — mirrors how total_invested drops to 0 after maturity
                if inv.get("maturity_date"):
                    cash_flows.append((inv["maturity_date"], -float(inv["principal"])))
            elif inv_type == "pf":
                for c in inv.get("contributions", []):
                    cash_flows.append((c["date"], float(c["amount"])))
            else:
                inv_prices = hist_prices.get(inv["id"], {})
                for t in inv.get("transactions", []):
                    qty = float(t["quantity"])
                    buy_price = float(t["buy_price"])
                    if buy_price > 0:
                        amt = qty * buy_price
                    elif qty > 0 and inv_prices:
                        # Zero-cost acquisition: use market value at acquisition date
                        mkt_price = value_on(inv_prices, t["date"])
                        amt = qty * mkt_price if mkt_price else 0
                    else:
                        amt = 0
                    cash_flows.append((t["date"], amt))

        # Sort cash flows by date
        cash_flows.sort(key=lambda x: x[0])

        # For each cash flow, compute Nifty units bought or sold
        nifty_units = []  # list of (date, units_delta) — negative for sells/exits
        for cf_date, cf_amount in cash_flows:
            if cf_amount == 0:
                continue
            price = get_nifty_price(cf_date)
            if price and price > 0:
                nifty_units.append((cf_date, cf_amount / price))

        # Portfolio Value / Returns benchmark: "what if every rupee invested went into Nifty 50?"
        # For each date point, sum units accumulated so far × current Nifty price
        benchmark_values = []
        cf_idx = 0
        cumulative_units = 0.0
        for dp in date_points:
            # Accumulate units from cash flows up to this date
            while cf_idx < len(nifty_units) and nifty_units[cf_idx][0] <= dp:
                cumulative_units += nifty_units[cf_idx][1]
                cumulative_units = max(0.0, cumulative_units)
                cf_idx += 1
            nifty_price = get_nifty_price(dp)
            if nifty_price is not None and cumulative_units > 0:
                benchmark_values.append(round(cumulative_units * nifty_price * adj(dp), 2))
            else:
                benchmark_values.append(None)
        result["benchmark"] = benchmark_values

    return result


@app.route("/api/historical-allocation")
def historical_allocation():
    """Return allocation breakdown by category at each date point."""
    region = request_region()
    portfolio = load_portfolio(region)
    investments = valid_investments(portfolio, region)
    all_dates = investment_dates(investments)

    if not all_dates:
        return jsonify({"dates": [], "allocations": {}})

    start_date = min(all_dates)
    end_date = datetime.now().strftime("%Y-%m-%d")

    # Fetch historical prices for all market investments
    hist_prices = {}
    for inv in investments:
        if inv["type"] in MARKET_TYPES:
            hist_prices[inv["id"]] = get_historical_prices(inv, region, start_date, end_date)

    date_points = weekly_dates(start_date, end_date)

    # Track values per category at each date point
    categories = set()
    # Initialize: list of dicts, one per date point
    alloc_per_date = [{} for _ in date_points]

    for dp_idx, dp in enumerate(date_points):
        dp_dt = datetime.strptime(dp, "%Y-%m-%d")

        for inv in investments:
            inv_type = inv["type"]
            cat = inv.get("category", inv_type)
            val = 0

            if inv_type == "fd":
                start = datetime.strptime(inv["start_date"], "%Y-%m-%d")
                if dp_dt >= start:
                    val = calculate_fd_value(inv, dp)
            elif inv_type == "pf":
                val = calculate_pf_value(inv, dp)
            else:
                price = value_on(hist_prices.get(inv["id"], {}), dp)
                if price is not None:
                    active_txns = [t for t in inv.get("transactions", []) if t["date"] <= dp]
                    qty = sum(float(t["quantity"]) for t in active_txns)
                    val = price * qty

            if val > 0:
                categories.add(cat)
                alloc_per_date[dp_idx][cat] = alloc_per_date[dp_idx].get(cat, 0) + val

    # Build response: allocations keyed by category, each a list parallel to dates
    allocations = {}
    for cat in categories:
        allocations[cat] = [round(alloc_per_date[i].get(cat, 0), 2) for i in range(len(date_points))]

    return jsonify({"dates": date_points, "allocations": allocations})


# --- Combined view across regions ---
# Every amount is converted at the exchange rate of its own date, so the totals include currency gains/losses.

def display_currency():
    currency = request.args.get("currency", "EUR")
    if currency not in CURRENCY_SYMBOLS:
        raise ValidationError("Unknown currency '{}'".format(currency))
    return currency


def _gain_pct(value, invested):
    return round((value - invested) / invested * 100, 2) if invested else 0


@app.route("/api/combined")
def combined():
    currency = display_currency()
    today = datetime.now().strftime("%Y-%m-%d")
    summaries = {region: portfolio_summary(region) for region in REGIONS}
    start = min((d for _, contributions in summaries.values() for d, _ in contributions), default=today)

    regions = []
    all_flows = []
    for region, cfg in REGIONS.items():
        summary, contributions = summaries[region]
        fx = make_fx_converter(cfg["currency"], currency, start)
        value = summary["total_value"] * fx(today)
        invested = sum(amount * fx(d) for d, amount in contributions)
        flows = [(d, -amount * fx(d)) for d, amount in contributions]
        all_flows.extend(flows)
        if value > 0:
            flows.append((today, value))
        regions.append({
            "id": region,
            "name": cfg["name"],
            "currency": cfg["currency"],
            "count": len(summary["investments"]),
            "value": round(value, 2),
            "invested": round(invested, 2),
            "gain_loss": round(value - invested, 2),
            "gain_loss_pct": _gain_pct(value, invested),
            "xirr": calculate_xirr(flows) if len(flows) >= 2 else None,
        })

    total_value = sum(r["value"] for r in regions)
    total_invested = sum(r["invested"] for r in regions)
    if total_value > 0:
        all_flows.append((today, total_value))
    return jsonify({
        "currency": currency,
        "regions": regions,
        "total_value": round(total_value, 2),
        "total_invested": round(total_invested, 2),
        "total_gain_loss": round(total_value - total_invested, 2),
        "total_gain_loss_pct": _gain_pct(total_value, total_invested),
        "xirr": calculate_xirr(all_flows) if len(all_flows) >= 2 else None,
    })


@app.route("/api/combined/history")
def combined_history():
    """Weekly value of each region on one shared timeline, plus the combined amount invested."""
    currency = display_currency()
    all_dates = []
    for region in REGIONS:
        all_dates.extend(investment_dates(valid_investments(load_portfolio(region), region)))
    if not all_dates:
        return jsonify({"dates": [], "invested": [], "regions": {}})

    start = min(all_dates)
    dates = weekly_dates(start, datetime.now().strftime("%Y-%m-%d"))
    invested = [0.0] * len(dates)
    series = {}
    for region, cfg in REGIONS.items():
        fx = make_fx_converter(cfg["currency"], currency, start)
        history = portfolio_history(region, start_date=start, fx=fx)
        # A region with no investments comes back empty; otherwise it shares the same weekly dates
        by_date = dict(zip(history["dates"], zip(history["values"], history["invested"])))
        series[region] = [by_date.get(d, (0, 0))[0] for d in dates]
        invested = [total + by_date.get(d, (0, 0))[1] for total, d in zip(invested, dates)]

    return jsonify({"dates": dates, "invested": [round(v, 2) for v in invested], "regions": series})


@app.route("/api/search/stock")
def search_stock():
    """Yahoo ticker search: NSE/BSE listings for India; stocks, ETFs and funds on other exchanges elsewhere."""
    region = request_region()
    q = request.args.get("q", "")
    if len(q) < 2:
        return jsonify([])
    try:
        url = "https://query1.finance.yahoo.com/v1/finance/search?q={}&quotesCount=15&newsCount=0".format(
            urllib.parse.quote(q))
        data = yahoo_fetch(url)
        if not data:
            return jsonify([])
        quotes = data.get("quotes", [])
        results = []
        for quote in quotes:
            exch = quote.get("exchange", "")
            symbol = quote.get("symbol", "")
            name = quote.get("longname") or quote.get("shortname") or symbol
            indian = exch in ("NSI", "NSE", "BSE", "BOM") or symbol.endswith(".NS") or symbol.endswith(".BO")
            if region == "in":
                if indian:
                    exchange_label = "NSE" if (exch in ("NSI", "NSE") or symbol.endswith(".NS")) else "BSE"
                    results.append({"ticker": symbol, "name": name, "exchange": exchange_label})
            elif not indian and quote.get("quoteType") in ("EQUITY", "ETF", "MUTUALFUND"):
                results.append({
                    "ticker": symbol,
                    "name": name,
                    "exchange": "{} · {}".format(quote.get("exchDisp") or exch,
                                                     quote.get("typeDisp") or quote["quoteType"]),
                })
        return jsonify(results)
    except Exception as e:
        print("Stock search error: {}".format(e))
        return jsonify([])


@app.route("/api/search/mf")
def search_mf():
    q = request.args.get("q", "")
    if len(q) < 3:
        return jsonify([])
    try:
        resp = req.get("https://api.mfapi.in/mf/search?q={}".format(q), timeout=10)
        data = resp.json()
        return jsonify(data[:20] if isinstance(data, list) else [])
    except Exception:
        return jsonify([])


@app.route("/api/search/crypto")
def search_crypto():
    q = request.args.get("q", "")
    if len(q) < 2:
        return jsonify([])
    try:
        resp = req.get(
            "https://api.coingecko.com/api/v3/search?query={}".format(q),
            timeout=10,
        )
        data = resp.json()
        coins = data.get("coins", [])[:10]
        return jsonify([{"id": c["id"], "name": c["name"], "symbol": c["symbol"]} for c in coins])
    except Exception:
        return jsonify([])


# Known ETF and Gold ETF symbols for auto-classification
GOLD_ETF_SYMBOLS = {"GOLDBEES", "GOLDCASE", "GOLDETF", "GOLDSHARE", "BSLGOLDETF",
                    "HABORETF", "AXISGOLD", "ABORETF", "IDBIGOLD", "KOTAKGOLD",
                    "LICNETFGSC", "QGOLDHALF", "SBISGOLD", "TATAGOLD"}
ETF_KEYWORDS = {"BEES", "ETF", "NIFTY", "JUNIOR", "SENSEX", "LIQUIDETF", "LIQUID"}

_amfi_cache = None


def fetch_amfi_data():
    """Fetch AMFI scheme data and build ISIN -> scheme_code mapping."""
    global _amfi_cache
    if _amfi_cache is not None:
        return _amfi_cache
    try:
        resp = req.get("https://www.amfiindia.com/spages/NAVAll.txt", timeout=30)
        lines = resp.text.strip().split("\n")
        isin_map = {}
        for line in lines:
            parts = line.split(";")
            if len(parts) >= 5:
                try:
                    scheme_code = parts[0].strip()
                    int(scheme_code)  # verify it's numeric
                    isin1 = parts[1].strip()
                    isin2 = parts[2].strip()
                    scheme_name = parts[3].strip()
                    if isin1:
                        isin_map[isin1] = {"scheme_code": scheme_code, "name": scheme_name}
                    if isin2:
                        isin_map[isin2] = {"scheme_code": scheme_code, "name": scheme_name}
                except ValueError:
                    continue
        _amfi_cache = isin_map
        return isin_map
    except Exception as e:
        print("Error fetching AMFI data: {}".format(e))
        return {}


def classify_eq_symbol(symbol):
    """Classify an equity symbol as stock, etf, or gold_etf."""
    sym_upper = symbol.upper()
    if sym_upper in GOLD_ETF_SYMBOLS:
        return "gold_etf"
    for kw in ETF_KEYWORDS:
        if kw in sym_upper:
            return "etf"
    return "stock"


@app.route("/api/import", methods=["POST"])
@locked
def import_csv():
    if "file" not in request.files:
        return jsonify({"status": "error", "message": "No file uploaded"}), 400

    file = request.files["file"]
    content = file.read().decode("utf-8")
    reader = csv.DictReader(io.StringIO(content))

    portfolio = load_portfolio("in")
    investments = portfolio.get("investments", [])

    # Build set of existing trade_ids for duplicate detection
    existing_trade_ids = set()
    for inv in investments:
        for t in inv.get("transactions", []):
            if t.get("trade_id"):
                existing_trade_ids.add(t["trade_id"])

    # Fetch AMFI data for MF ISIN lookup
    amfi_data = None
    # Cache for EQ symbol -> full name lookups
    eq_name_cache = {}
    imported_count = 0
    skipped_count = 0

    for row in reader:
        segment = row.get("segment", "").strip()
        trade_type = row.get("trade_type", "").strip().lower()
        symbol = row.get("symbol", "").strip()
        isin = row.get("isin", "").strip()
        trade_date = row.get("trade_date", "").strip()
        quantity = row.get("quantity", "0").strip()
        price = row.get("price", "0").strip()
        trade_id = row.get("trade_id", "").strip()

        # Skip duplicates
        if trade_id and trade_id in existing_trade_ids:
            skipped_count += 1
            continue

        # Parse date (handle YYYY-MM-DD format)
        try:
            date_str = datetime.strptime(trade_date, "%Y-%m-%d").strftime("%Y-%m-%d")
        except ValueError:
            continue

        # Make quantity negative for sells
        qty_float = float(quantity)
        if trade_type == "sell":
            qty_float = -abs(qty_float)

        txn = {
            "id": str(uuid.uuid4())[:8],
            "date": date_str,
            "quantity": str(round(qty_float, 2)),
            "buy_price": str(round(float(price), 2)),
        }
        if trade_id:
            txn["trade_id"] = trade_id
            existing_trade_ids.add(trade_id)

        if segment == "EQ":
            inv_type = classify_eq_symbol(symbol)
            exchange = row.get("exchange", "NSE").strip()
            suffix = ".BO" if exchange == "BSE" else ".NS"
            ticker = "{}{}".format(symbol, suffix)

            # Find existing investment with same ticker
            existing = None
            for inv in investments:
                if inv.get("ticker") == ticker and inv["type"] == inv_type:
                    existing = inv
                    break

            if existing:
                existing["transactions"].append(txn)
            else:
                # Look up full name from Yahoo
                if ticker not in eq_name_cache:
                    full_name = symbol
                    chart = yahoo_chart(ticker, period="1d")
                    if chart:
                        meta = chart.get("meta", {})
                        full_name = meta.get("longName") or meta.get("shortName") or symbol
                    eq_name_cache[ticker] = full_name
                display_name = eq_name_cache[ticker]

                investments.append({
                    "id": str(uuid.uuid4())[:8],
                    "type": inv_type,
                    "name": display_name,
                    "category": inv_type,
                    "ticker": ticker,
                    "transactions": [txn],
                })
            imported_count += 1

        elif segment == "MF":
            if amfi_data is None:
                amfi_data = fetch_amfi_data()

            scheme_info = amfi_data.get(isin)
            if not scheme_info:
                scheme_code = ""
                scheme_name = symbol
            else:
                scheme_code = scheme_info["scheme_code"]
                scheme_name = scheme_info["name"]

            # Find existing investment with same scheme_code or ISIN
            existing = None
            for inv in investments:
                if inv["type"] == "mutual_fund":
                    if scheme_code and inv.get("scheme_code") == scheme_code:
                        existing = inv
                        break
                    if inv.get("isin") == isin:
                        existing = inv
                        break

            if existing:
                existing["transactions"].append(txn)
            else:
                investments.append({
                    "id": str(uuid.uuid4())[:8],
                    "type": "mutual_fund",
                    "name": scheme_name,
                    "category": "mutual_fund",
                    "scheme_code": scheme_code,
                    "isin": isin,
                    "transactions": [txn],
                })
            imported_count += 1

    portfolio["investments"] = investments
    save_portfolio(portfolio, "in")

    # Clear caches
    global _price_cache, _historical_cache
    _price_cache = {}
    _historical_cache = {}

    msg = "Imported {} trades".format(imported_count)
    if skipped_count:
        msg += ", skipped {} duplicates".format(skipped_count)

    return jsonify({
        "status": "ok",
        "imported": imported_count,
        "skipped": skipped_count,
        "message": msg,
    })


@app.route("/api/import/pf", methods=["POST"])
@locked
def import_pf():
    """Import PF contributions from EPFO passbook PDFs."""
    if "file" not in request.files:
        return jsonify({"status": "error", "message": "No file uploaded"}), 400

    files = request.files.getlist("file")
    portfolio = load_portfolio("in")
    investments = portfolio.get("investments", [])

    # Find or create PF investment
    pf_inv = None
    for inv in investments:
        if inv["type"] == "pf":
            pf_inv = inv
            break

    total_imported = 0
    total_skipped = 0
    detected_rate = None

    for file in files:
        pdf = pdfplumber.open(file)
        for page_num, page in enumerate(pdf.pages):
            tables = page.extract_tables()
            if not tables:
                continue
            table = tables[0]

            for row in table:
                if not row or not row[0]:
                    continue
                # Contribution rows have date in DD-MM-YYYY format in column 1
                # and 'CR' in column 2
                if len(row) >= 9 and row[2] == 'CR' and row[1]:
                    try:
                        txn_date = datetime.strptime(row[1], "%d-%m-%Y").strftime("%Y-%m-%d")
                    except (ValueError, TypeError):
                        continue

                    # Parse employee + employer contribution
                    try:
                        employee = float(row[6].replace(",", "")) if row[6] else 0
                        employer = float(row[7].replace(",", "")) if row[7] else 0
                    except (ValueError, TypeError):
                        continue

                    amount = employee + employer
                    if amount <= 0:
                        continue

                    # Create PF investment if it doesn't exist
                    if pf_inv is None:
                        pf_inv = {
                            "id": str(uuid.uuid4())[:8],
                            "type": "pf",
                            "name": "Provident Fund (EPF)",
                            "category": "pf",
                            "interest_rate": "8.25",
                            "contributions": [],
                        }
                        investments.append(pf_inv)

                    # Duplicate detection by date
                    existing_dates = {c["date"] for c in pf_inv.get("contributions", [])}
                    if txn_date in existing_dates:
                        total_skipped += 1
                        continue

                    pf_inv.setdefault("contributions", []).append({
                        "id": str(uuid.uuid4())[:8],
                        "date": txn_date,
                        "amount": str(amount),
                    })
                    total_imported += 1

                # Try to detect interest rate from interest row
                if row[0] and "Int. Updated" in str(row[0]) and len(row) >= 7:
                    try:
                        employee_int = float(row[6].replace(",", "")) if row[6] else 0
                        if employee_int > 0 and pf_inv:
                            # Store the interest info but don't change rate automatically
                            pass
                    except (ValueError, TypeError):
                        pass

    portfolio["investments"] = investments
    save_portfolio(portfolio, "in")

    msg = "Imported {} PF contributions".format(total_imported)
    if total_skipped:
        msg += ", skipped {} duplicates".format(total_skipped)

    return jsonify({
        "status": "ok",
        "imported": total_imported,
        "skipped": total_skipped,
        "message": msg,
    })


@app.route("/api/investment/<inv_id>/schedule", methods=["POST"])
@locked
def set_schedule(inv_id):
    """Set up a recurring schedule for an investment (SIP or PF contributions)."""
    data = json_body()
    check_schedule(data)
    region = request_region()
    portfolio = load_portfolio(region)
    inv = None
    for i in portfolio.get("investments", []):
        if i["id"] == inv_id:
            inv = i
            break
    if not inv:
        return jsonify({"status": "error", "message": "Investment not found"}), 404

    inv["schedule"] = {
        "amount": data["amount"],
        "day": int(data.get("day", 1)),
        "frequency": data.get("frequency", "monthly"),
        "start_date": data["start_date"],
        "end_date": data.get("end_date"),  # None = ongoing
    }

    save_portfolio(portfolio, region)
    return jsonify({"status": "ok"})


@app.route("/api/investment/<inv_id>/schedule", methods=["DELETE"])
@locked
def delete_schedule(inv_id):
    """Remove recurring schedule from an investment."""
    region = request_region()
    portfolio = load_portfolio(region)
    for inv in portfolio.get("investments", []):
        if inv["id"] == inv_id:
            inv.pop("schedule", None)
            save_portfolio(portfolio, region)
            return jsonify({"status": "ok"})
    return jsonify({"status": "error", "message": "Investment not found"}), 404


@app.route("/api/investment/<inv_id>/generate", methods=["POST"])
@locked
def generate_recurring(inv_id):
    """Generate recurring contributions/transactions from schedule or custom params."""
    data = json_body()
    check_schedule(data)
    region = request_region()
    portfolio = load_portfolio(region)
    inv = None
    for i in portfolio.get("investments", []):
        if i["id"] == inv_id:
            inv = i
            break
    if not inv:
        return jsonify({"status": "error", "message": "Investment not found"}), 404

    amount = float(data["amount"])
    day = int(data.get("day", 1))
    start_date = datetime.strptime(data["start_date"], "%Y-%m-%d")
    end_date_str = data.get("end_date")
    end_date = datetime.strptime(end_date_str, "%Y-%m-%d") if end_date_str else datetime.now()
    buy_price = data.get("buy_price")  # For SIPs — price per unit at time of purchase

    inv_type = inv["type"]
    generated = 0
    skipped = 0

    current = start_date.replace(day=min(day, 28))
    while current <= end_date:
        date_str = current.strftime("%Y-%m-%d")

        if inv_type == "pf":
            existing_dates = {c["date"] for c in inv.get("contributions", [])}
            if date_str in existing_dates:
                skipped += 1
            else:
                inv.setdefault("contributions", []).append({
                    "id": str(uuid.uuid4())[:8],
                    "date": date_str,
                    "amount": str(amount),
                })
                generated += 1
        else:
            # Market investments (SIP) — amount is total invested, need price
            existing_dates = {t["date"] for t in inv.get("transactions", [])}
            if date_str in existing_dates:
                skipped += 1
            else:
                if buy_price:
                    qty = amount / float(buy_price)
                    inv.setdefault("transactions", []).append({
                        "id": str(uuid.uuid4())[:8],
                        "date": date_str,
                        "quantity": str(round(qty, 4)),
                        "buy_price": str(buy_price),
                    })
                else:
                    inv.setdefault("transactions", []).append({
                        "id": str(uuid.uuid4())[:8],
                        "date": date_str,
                        "quantity": "0",
                        "buy_price": str(amount),
                    })
                generated += 1

        current += relativedelta(months=1)

    save_portfolio(portfolio, region)
    return jsonify({
        "status": "ok",
        "generated": generated,
        "skipped": skipped,
        "message": "Generated {} entries, skipped {} duplicates".format(generated, skipped),
    })


if __name__ == "__main__":
    app.run(
        host=os.environ.get("FLASK_HOST", "127.0.0.1"),
        port=5050,
        debug=os.environ.get("FLASK_DEBUG", "1") == "1",
    )
