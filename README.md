# Local Investment Portfolio Tracker

A local, self-hosted portfolio tracker for Indian investors that don't want online portfolio trackers to sell their financial data.

Track stocks, mutual funds, commodities, crypto, Provident Fund contributions, and Fixed Deposits — all in one place with live prices and historical charts.

![Python](https://img.shields.io/badge/Python-3.9+-blue) ![Flask](https://img.shields.io/badge/Flask-Backend-green)

## Features

### Asset Types
- **Stocks & ETFs** — NSE/BSE listed equities and ETFs (live prices via Yahoo Finance)
- **Gold ETFs** — Tracked separately for allocation visibility
- **Mutual Funds** — NAV fetched from mfapi.in, search by name or scheme code
- **Crypto** — Live prices via CoinGecko API (INR)
- **Provident Fund** — Monthly contribution tracking with configurable interest rate and annual compounding
- **Fixed Deposits** — Principal, rate, tenor with monthly/quarterly/half-yearly/yearly compounding options

### Portfolio Dashboard
- Total portfolio value, total invested, gain/loss summary, and **XIRR** (annualized return accounting for irregular cash flows)
- Allocation breakdown with two views:
  - **Category** — Equity, Debt, Commodities, Crypto (click a section to drill down)
  - **Detailed** — Stocks, ETFs, Mutual Funds, Gold ETFs, Crypto, PF, FD
- **Historical allocation slider** — Scrub through time to see how your allocation breakdown changed week by week
- Filter investments by **Current / Past / All** and by **asset class** (Equity, Debt, Commodities, Crypto)
- **Per-investment XIRR** column and a **totals row** that updates based on active filters
- Manual price refresh
- INR default with USD conversion toggle

### Historical Charts
- **Portfolio Value** — Two-line chart showing portfolio value vs amount invested over time, making profit/loss visible at a glance
- **Returns %** — Percentage return over time with a 0% baseline
- **Current Holdings** — What your current holdings would have been worth historically (backwards projection)
- **Nifty 50 benchmark** toggle — overlay Nifty 50 performance on any chart view to compare against the index
- **Amount Invested** toggle — optionally show/hide the invested amount line
- **Inflation adjustment** toggle using World Bank India CPI data (with monthly interpolation and extrapolation for recent years)
- **Time range filters** — 1M, 3M, 6M, 1Y, 3Y, 5Y, and MAX to zoom into any period (defaults to MAX)

### Import
- **Zerodha Tradebook** — Import CSV files (both EQ and MF segments)
  - Auto-classifies stocks vs ETFs vs gold ETFs
  - Resolves mutual fund ISINs via AMFI data
  - Duplicate trade detection using Zerodha trade IDs
  - Multi-file upload support
- **EPFO Passbook** — Import PF contribution PDFs downloaded from the EPFO Member Portal
  - Extracts monthly employee + employer contributions
  - Creates/merges into existing PF investment
  - Duplicate detection by date

### Recurring Investments
- Set up recurring schedules for SIPs and PF contributions
- Schedules auto-generate entries each time you open the app
- **Bulk generate past entries** — backfill months of SIP/PF contributions in one click (e.g., "₹5,000/month on the 15th from Jan 2024")
- View, edit, and delete active schedules from the Recurring modal
- Investments with active schedules show a **recurring** badge

### Investment Management
- Add investments manually with ticker/fund search
- Investments with the same ticker/fund are automatically merged
- Add, edit, and delete individual transactions
- Edit investment-level details (name, type, ticker)
- Transactions sorted newest-first
- Matured FDs automatically excluded from portfolio totals

## Tech Stack

- **Backend:** Python Flask with JSON file storage (`data/portfolio.json`)
- **Frontend:** Single-page HTML with vanilla JS, Chart.js, and Flatpickr
- **APIs:**
  - Yahoo Finance v8 (stocks/ETFs — fetched via `curl` to avoid TLS blocking)
  - [mfapi.in](https://www.mfapi.in/) (mutual fund NAV and history)
  - [AMFI India](https://www.amfiindia.com/) (ISIN to scheme code mapping)
  - [CoinGecko](https://www.coingecko.com/en/api) (crypto prices, free tier — 365-day history limit)
  - [World Bank](https://data.worldbank.org/) (India CPI for inflation adjustment)
  - [ExchangeRate API](https://open.er-api.com/) (INR/USD conversion)

## Setup

### Prerequisites
- Python 3.9+
- `curl` (used for Yahoo Finance API calls)

### Installation

```bash
# Clone the repository
git clone https://github.com/inesane/local-portfolio-tracker.git
cd local-portfolio-tracker

# Install dependencies
pip install -r requirements.txt

# Run the app
python3 app.py
```

The app runs at `http://localhost:5050`.

### Running with Docker

```bash
docker compose up -d --build
```

The app is served at `http://127.0.0.1:5050` (only reachable from your machine). Portfolio data lives in `./data/portfolio.json` on the host, which is shared with non-Docker runs.

### Importing Data

**Zerodha Trades:**
1. Download your tradebook(s) from Zerodha Console (separate CSVs for EQ and MF segments; tradebooks have 365 day limits so you'll need to download multiple)
2. Click **Import** in the app, select "Zerodha Tradebook (CSV)"
3. Select one or more CSV files and import
4. Duplicates are automatically skipped based on trade IDs

**EPFO Provident Fund:**
1. Download your passbook PDF(s) from the [EPFO Member Portal](https://passbook.epfindia.gov.in/MemberPassBook/Login)
2. Click **Import** in the app, select "EPFO Passbook (PDF)"
3. Select one or more PDF files and import
4. Contributions (employee + employer) are extracted and merged

### Setting Up Recurring Investments

1. Click the **Recurring** button in the header
2. Select an investment, set amount, day of month, and start date
3. Click **"Save as Recurring"** to auto-generate future entries on each app load
4. Or click **"Generate Past Entries"** for a one-time backfill

## Data Storage

All portfolio data is stored locally in `data/portfolio.json` (override with the `PORTFOLIO_FILE` environment variable). No data is sent to any server — API calls are only made to fetch live/historical prices.

## Future Plans

- **Asset rebalancing suggestions** — Target allocation vs actual allocation with rebalance recommendations. Expected CAGR/YoY returns based on current asset split.
- **Export** — Download portfolio data as CSV/Excel
- **More Investments** - Real estate, US investments (most probably in a separate sheet/tab)
