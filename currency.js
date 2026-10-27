'use strict';
// Display currencies. The base currency is INR: every amount in the DB is stored in INR paise and all commission
// maths stays in INR. Other currencies are for display (and for the amount a member types when requesting a
// withdrawal, which is converted to INR at the current admin-set rate).
const { db } = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS currencies (
  code TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  rate_per_inr REAL NOT NULL CHECK (rate_per_inr > 0),   -- units of this currency for 1 INR
  decimals INTEGER NOT NULL DEFAULT 2 CHECK (decimals BETWEEN 0 AND 3),
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

// Approximate default rates (admin can edit them at /admin/currencies). 1 INR = rate units.
const DEFAULT_CURRENCIES = [
  ['INR', '₹', 'Indian Rupee', 1, 2],
  ['ZAR', 'R', 'South African Rand', 0.205, 2],
  ['USD', '$', 'US Dollar', 0.0114, 2],
  ['GBP', '£', 'British Pound', 0.0086, 2],
  ['EUR', '€', 'Euro', 0.0098, 2],
  ['AED', 'AED ', 'UAE Dirham', 0.0419, 2],
  ['CAD', 'C$', 'Canadian Dollar', 0.0159, 2],
  ['AUD', 'A$', 'Australian Dollar', 0.0175, 2],
  ['SGD', 'S$', 'Singapore Dollar', 0.0148, 2],
  ['MYR', 'RM', 'Malaysian Ringgit', 0.0483, 2],
  ['NPR', 'Rs ', 'Nepalese Rupee', 1.6, 2],
  ['BDT', '৳', 'Bangladeshi Taka', 1.39, 2],
  ['LKR', 'Rs ', 'Sri Lankan Rupee', 3.45, 2],
  ['NGN', '₦', 'Nigerian Naira', 16.9, 2],
  ['KES', 'KSh ', 'Kenyan Shilling', 1.47, 2],
];
{
  const ins = db.prepare('INSERT OR IGNORE INTO currencies(code, symbol, name, rate_per_inr, decimals) VALUES (?,?,?,?,?)');
  db.transaction(() => DEFAULT_CURRENCIES.forEach(c => ins.run(...c)))();
}

// Countries (also used for payout country). flag = ISO 3166-1 alpha-2 (emoji flag), currency = display currency.
const COUNTRIES = [
  { name: 'India', iso: 'IN', currency: 'INR' },
  { name: 'South Africa', iso: 'ZA', currency: 'ZAR' },
  { name: 'United Arab Emirates', iso: 'AE', currency: 'AED' },
  { name: 'United States', iso: 'US', currency: 'USD' },
  { name: 'United Kingdom', iso: 'GB', currency: 'GBP' },
  { name: 'Canada', iso: 'CA', currency: 'CAD' },
  { name: 'Australia', iso: 'AU', currency: 'AUD' },
  { name: 'Singapore', iso: 'SG', currency: 'SGD' },
  { name: 'Malaysia', iso: 'MY', currency: 'MYR' },
  { name: 'Nepal', iso: 'NP', currency: 'NPR' },
  { name: 'Bangladesh', iso: 'BD', currency: 'BDT' },
  { name: 'Sri Lanka', iso: 'LK', currency: 'LKR' },
  { name: 'Nigeria', iso: 'NG', currency: 'NGN' },
  { name: 'Kenya', iso: 'KE', currency: 'KES' },
  { name: 'Germany', iso: 'DE', currency: 'EUR' },
  { name: 'France', iso: 'FR', currency: 'EUR' },
  { name: 'Netherlands', iso: 'NL', currency: 'EUR' },
  { name: 'Ireland', iso: 'IE', currency: 'EUR' },
  { name: 'Other', iso: null, currency: 'USD' },
];
const COUNTRY_NAMES = COUNTRIES.map(c => c.name);
const DEFAULT_COUNTRY = 'India';
const flag = (iso) => iso ? String.fromCodePoint(...[...iso].map(ch => 0x1F1E6 + ch.charCodeAt(0) - 65)) : '🌐';
COUNTRIES.forEach(c => { c.flag = flag(c.iso); });
const countryInfo = (name) => COUNTRIES.find(c => c.name === name) || COUNTRIES[0];
const validCountry = (name) => COUNTRY_NAMES.includes(name);

const allCurrencies = () => db.prepare('SELECT * FROM currencies ORDER BY (code<>\'INR\'), code').all();
const getCurrency = (code) => db.prepare('SELECT * FROM currencies WHERE code=?').get(code);
const INR = () => getCurrency('INR');

// Currency for a country: its mapped currency if enabled, otherwise INR (base).
function currencyForCountry(name) {
  const c = getCurrency(countryInfo(name).currency);
  return c && c.enabled ? c : INR();
}

function fmt(value, cur) {
  const d = cur.decimals;
  const s = Math.abs(value).toLocaleString(cur.code === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const sym = String(cur.symbol || '').trim();
  return (value < 0 ? '-' : '') + sym + (sym.length > 1 && /[A-Za-z]$/.test(sym) ? ' ' : '') + s; // "AED 41.90", "R205.00"
}
// INR paise -> amount in `cur` (rounded to its decimals)
function convert(paise, cur) {
  const f = Math.pow(10, cur.decimals);
  return Math.round((Number(paise || 0) / 100) * cur.rate_per_inr * f) / f;
}
// Amount typed in `cur` -> INR paise at the current rate
function toINRPaise(amount, cur) { return Math.round((amount / cur.rate_per_inr) * 100); }
const formatter = (cur) => (paise) => fmt(convert(paise, cur), cur);

module.exports = { COUNTRIES, COUNTRY_NAMES, DEFAULT_COUNTRY, countryInfo, validCountry, allCurrencies, getCurrency, currencyForCountry, fmt, convert, toINRPaise, formatter };
