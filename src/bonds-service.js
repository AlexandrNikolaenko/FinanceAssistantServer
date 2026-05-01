const { TBankClient } = require("./tbank-client");

const BANK_COMMISSION_RATE = 0.003;
const TAX_RATE = 0.13;
const MS_PER_DAY = 24 * 60 * 60 * 1_000;
const UNIVERSE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 20;
const COUPON_EVENTS_TTL_MS = 12 * 60 * 60 * 1_000;
const DEFAULT_FILTERS = {
  riskLevel: "all",
  amortization: "all",
  currency: "rub",
  couponType: "all",
};

let marketUniverseCache = {
  fetchedAt: null,
  expiresAt: 0,
  instruments: [],
};

const couponEventsCache = new Map();

function quotationToNumber(value) {
  if (!value) {
    return 0;
  }

  const units = Number(value.units ?? 0);
  const nano = Number(value.nano ?? 0);

  return units + nano / 1_000_000_000;
}

function normalizeDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeDateStart(value) {
  if (!value) {
    return null;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeDateEnd(value) {
  if (!value) {
    return null;
  }

  const date = new Date(`${value}T23:59:59.999Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function roundNumber(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function differenceInDays(from, to) {
  if (!from || !to) {
    return null;
  }

  return Math.ceil((to.getTime() - from.getTime()) / MS_PER_DAY);
}

function formatDate(value) {
  return value ? value.toISOString() : null;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeSelectValue(value, fallback) {
  if (!value) {
    return fallback;
  }

  return String(value).trim().toLowerCase();
}

function isTradableBond(instrument, now) {
  const maturityDate = normalizeDate(instrument.maturityDate);

  return (
    instrument.apiTradeAvailableFlag &&
    (instrument.buyAvailableFlag || instrument.sellAvailableFlag) &&
    !instrument.otcFlag &&
    instrument.tradingStatus === "SECURITY_TRADING_STATUS_NORMAL_TRADING" &&
    (!maturityDate || maturityDate.getTime() > now.getTime())
  );
}

async function getMarketUniverse(client, now) {
  if (marketUniverseCache.expiresAt > now.getTime()) {
    return marketUniverseCache;
  }

  const instruments = await client.getBonds("INSTRUMENT_STATUS_BASE");
  const tradableBonds = instruments
    .filter((instrument) => isTradableBond(instrument, now))
    .sort((left, right) => {
      const leftDate = normalizeDate(left.maturityDate)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const rightDate =
        normalizeDate(right.maturityDate)?.getTime() ?? Number.MAX_SAFE_INTEGER;

      if (leftDate !== rightDate) {
        return leftDate - rightDate;
      }

      return left.ticker.localeCompare(right.ticker);
    });

  marketUniverseCache = {
    fetchedAt: now.toISOString(),
    expiresAt: now.getTime() + UNIVERSE_TTL_MS,
    instruments: tradableBonds,
  };

  return marketUniverseCache;
}

function matchesMaturityDateFilter(instrument, from, to) {
  const maturityDate = normalizeDate(instrument.maturityDate);

  if (!maturityDate) {
    return false;
  }

  if (from && maturityDate.getTime() < from.getTime()) {
    return false;
  }

  if (to && maturityDate.getTime() > to.getTime()) {
    return false;
  }

  return true;
}

function mapRiskLevel(value) {
  const normalized = String(value || "").toLowerCase();

  if (normalized.includes("low")) {
    return "RISK_LEVEL_LOW";
  }

  if (normalized.includes("moderate") || normalized.includes("medium")) {
    return "RISK_LEVEL_MODERATE";
  }

  if (normalized.includes("high")) {
    return "RISK_LEVEL_HIGH";
  }

  return "unknown";
}

function matchesAdditionalFilters(instrument, filters) {
  const instrumentRiskLevel = mapRiskLevel(instrument.riskLevel);
  const instrumentCurrency = String(instrument.currency || "").toLowerCase();
  const hasAmortization = Boolean(instrument.amortizationFlag);
  const couponType = instrument.floatingCouponFlag ? "floating" : "fixed";

  if (filters.riskLevel !== "all" && instrumentRiskLevel !== filters.riskLevel) {
    return false;
  }

  if (filters.amortization === "yes" && !hasAmortization) {
    return false;
  }

  if (filters.amortization === "no" && hasAmortization) {
    return false;
  }

  if (filters.currency !== "all" && instrumentCurrency !== filters.currency) {
    return false;
  }

  if (filters.couponType !== "all" && couponType !== filters.couponType) {
    return false;
  }

  return true;
}

function getCouponEligibilityBoundary(coupon) {
  return normalizeDate(coupon.fixDate) ?? normalizeDate(coupon.couponDate);
}

async function getCouponEvents(client, instrument, now) {
  const cached = couponEventsCache.get(instrument.uid);

  if (cached && cached.expiresAt > now.getTime()) {
    return cached.events;
  }

  const maturityDate = normalizeDate(instrument.maturityDate);
  const rangeEnd = maturityDate
    ? new Date(maturityDate.getTime() + 7 * MS_PER_DAY)
    : new Date(now.getTime() + 10 * 365 * MS_PER_DAY);
  const events = await client.getBondCoupons(instrument.uid, now, rangeEnd);

  couponEventsCache.set(instrument.uid, {
    events,
    expiresAt: now.getTime() + COUPON_EVENTS_TTL_MS,
  });

  return events;
}

function buildBondMetrics({ instrument, lastPrice, coupons, now }) {
  const nominal = quotationToNumber(instrument.nominal);
  const nkd = quotationToNumber(instrument.aciValue);
  const marketPricePercent = lastPrice ? quotationToNumber(lastPrice.price) : null;
  const price =
    marketPricePercent === null || nominal <= 0
      ? null
      : (nominal * marketPricePercent) / 100;
  const maturityDate = normalizeDate(instrument.maturityDate);

  const remainingCoupons = coupons
    .filter((coupon) => {
      const boundary = getCouponEligibilityBoundary(coupon);
      return boundary ? boundary.getTime() > now.getTime() : false;
    })
    .sort(
      (left, right) =>
        new Date(left.couponDate).getTime() - new Date(right.couponDate).getTime(),
    );

  const remainingCouponCount = remainingCoupons.length;
  const totalCouponIncome = remainingCoupons.reduce(
    (total, coupon) => total + quotationToNumber(coupon.payOneBond),
    0,
  );
  const couponAmount =
    remainingCouponCount > 0 ? totalCouponIncome / remainingCouponCount : 0;
  const lastCouponDate =
    remainingCouponCount > 0
      ? normalizeDate(remainingCoupons[remainingCouponCount - 1].couponDate)
      : null;
  const lastCouponOrMaturityDate =
    maturityDate && lastCouponDate
      ? maturityDate.getTime() >= lastCouponDate.getTime()
        ? maturityDate
        : lastCouponDate
      : maturityDate ?? lastCouponDate;
  const daysToMaturity = differenceInDays(now, maturityDate ?? lastCouponOrMaturityDate);
  const commission = price === null ? null : BANK_COMMISSION_RATE * (price + nkd);
  const purchaseCost =
    price === null || commission === null ? null : price + nkd + commission;
  const grossAnnualYield =
    purchaseCost && daysToMaturity && daysToMaturity > 0
      ? Math.pow(
          (nominal + couponAmount * remainingCouponCount) / purchaseCost,
          365 / daysToMaturity,
        ) - 1
      : null;
  const tax = couponAmount * remainingCouponCount * TAX_RATE;
  const netAnnualIncomeRub =
    grossAnnualYield === null || purchaseCost === null
      ? null
      : purchaseCost * grossAnnualYield - tax;
  const netYield =
    netAnnualIncomeRub === null || purchaseCost === null || purchaseCost + tax <= 0
      ? null
      : netAnnualIncomeRub / (purchaseCost + tax);

  return {
    figi: instrument.figi,
    instrumentUid: instrument.uid,
    ticker: instrument.ticker,
    classCode: instrument.classCode,
    name: instrument.name,
    quantity: null,
    nominal: roundNumber(nominal),
    price: roundNumber(price),
    nkd: roundNumber(nkd),
    couponAmount: roundNumber(couponAmount),
    remainingCouponCount,
    lastCouponOrMaturityDate: formatDate(lastCouponOrMaturityDate),
    bankCommission: roundNumber(commission),
    grossAnnualYieldPercent: roundNumber(
      grossAnnualYield === null ? null : grossAnnualYield * 100,
      4,
    ),
    tax: roundNumber(tax),
    netAnnualIncomeRub: roundNumber(netAnnualIncomeRub),
    netYieldPercent: roundNumber(netYield === null ? null : netYield * 100, 4),
    currency: instrument.currency || "rub",
    maturityDate: formatDate(maturityDate),
    daysToMaturity,
    totalCouponIncome: roundNumber(totalCouponIncome),
    couponCountCalculation: "eligible_future_coupons",
    marketPricePercent: roundNumber(marketPricePercent, 4),
    lastPriceUpdatedAt: formatDate(normalizeDate(lastPrice?.time)),
  };
}

async function getBondYields(options = {}) {
  const client = new TBankClient();
  const now = new Date();
  const universe = await getMarketUniverse(client, now);
  const maturityDateFrom = normalizeDateStart(options.maturityDateFrom);
  const maturityDateTo = normalizeDateEnd(options.maturityDateTo);
  const filters = {
    riskLevel: normalizeSelectValue(options.riskLevel, DEFAULT_FILTERS.riskLevel),
    amortization: normalizeSelectValue(
      options.amortization,
      DEFAULT_FILTERS.amortization,
    ),
    currency: normalizeSelectValue(options.currency, DEFAULT_FILTERS.currency),
    couponType: normalizeSelectValue(options.couponType, DEFAULT_FILTERS.couponType),
  };
  const requestedPageSize = Number(options.pageSize || DEFAULT_PAGE_SIZE);
  const pageSize = clamp(
    Number.isFinite(requestedPageSize) ? requestedPageSize : DEFAULT_PAGE_SIZE,
    1,
    MAX_PAGE_SIZE,
  );

  const filteredInstruments = universe.instruments.filter((instrument) =>
    matchesMaturityDateFilter(instrument, maturityDateFrom, maturityDateTo) &&
    matchesAdditionalFilters(instrument, filters),
  );
  const totalCount = filteredInstruments.length;
  const totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / pageSize);
  const requestedPage = Number(options.page || 1);
  const page =
    totalPages === 0
      ? 1
      : clamp(Number.isFinite(requestedPage) ? requestedPage : 1, 1, totalPages);
  const pageStart = (page - 1) * pageSize;
  const pagedInstruments = filteredInstruments.slice(pageStart, pageStart + pageSize);
  const lastPrices = await client.getLastPrices(
    pagedInstruments.map((instrument) => instrument.uid),
  );
  const lastPriceMap = new Map(
    lastPrices.map((lastPrice) => [lastPrice.instrumentUid, lastPrice]),
  );

  const bonds = await Promise.all(
    pagedInstruments.map(async (instrument) => {
      const coupons = await getCouponEvents(client, instrument, now);

      return buildBondMetrics({
        instrument,
        lastPrice: lastPriceMap.get(instrument.uid),
        coupons,
        now,
      });
    }),
  );

  return {
    source: "market",
    market: "MOEX",
    universeFetchedAt: universe.fetchedAt,
    fetchedAt: now.toISOString(),
    count: bonds.length,
    page,
    pageSize,
    totalCount,
    totalPages,
    filters: {
      maturityDateFrom: options.maturityDateFrom || null,
      maturityDateTo: options.maturityDateTo || null,
      riskLevel: filters.riskLevel,
      amortization: filters.amortization,
      currency: filters.currency,
      couponType: filters.couponType,
    },
    bonds,
  };
}

module.exports = {
  getBondYields,
};
