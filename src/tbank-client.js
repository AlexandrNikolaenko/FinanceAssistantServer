const ONE_SECOND = 1_000;
const DEFAULT_TIMEOUT_MS = 15 * ONE_SECOND;
const REST_BASE_URL = "https://invest-public-api.tbank.ru/rest";
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 8;
const COUPON_REQUEST_INTERVAL_MS = 180;

let couponRequestGate = Promise.resolve();
let nextCouponRequestAt = 0;

class TBankApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = "TBankApiError";
    this.status = status;
    this.payload = payload;
  }
}

function getEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

class TBankClient {
  constructor() {
    this.token = getEnv("TBANK_TOKEN");
    this.allowInsecureTls = normalizeBoolean(
      process.env.TBANK_ALLOW_INSECURE_TLS,
      true,
    );

    if (this.allowInsecureTls) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }
  }

  async post(method, body) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

      try {
        const response = await fetch(`${REST_BASE_URL}/${method}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        const text = await response.text();
        const payload = text ? JSON.parse(text) : {};

        if (!response.ok) {
          if (
            RETRYABLE_STATUS_CODES.has(response.status) &&
            attempt < MAX_RETRIES
          ) {
            await sleep(getRetryDelayMs(attempt, response.headers));
            continue;
          }

          throw new TBankApiError(
            `T-Bank API returned ${response.status} for ${method}`,
            response.status,
            payload,
          );
        }

        return payload;
      } catch (error) {
        if (
          error instanceof TypeError &&
          error.cause &&
          error.cause.code === "SELF_SIGNED_CERT_IN_CHAIN" &&
          !this.allowInsecureTls
        ) {
          throw new Error(
            "TLS certificate validation failed for T-Bank API. Set TBANK_ALLOW_INSECURE_TLS=true for local development on this machine.",
          );
        }

        if (attempt >= MAX_RETRIES || error instanceof TBankApiError) {
          throw error;
        }

        await sleep(getRetryDelayMs(attempt));
      } finally {
        clearTimeout(timeoutId);
      }
    }
  }

  async getOpenAccounts() {
    const payload = await this.post(
      "tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts",
      {
        status: "ACCOUNT_STATUS_OPEN",
      },
    );

    return payload.accounts ?? [];
  }

  async getPortfolio(accountId) {
    return this.post(
      "tinkoff.public.invest.api.contract.v1.OperationsService/GetPortfolio",
      {
        accountId,
        currency: "RUB",
      },
    );
  }

  async getBondByUid(instrumentUid) {
    const payload = await this.post(
      "tinkoff.public.invest.api.contract.v1.InstrumentsService/BondBy",
      {
        idType: "INSTRUMENT_ID_TYPE_UID",
        id: instrumentUid,
      },
    );

    return payload.instrument;
  }

  async getBonds(instrumentStatus = "INSTRUMENT_STATUS_BASE") {
    const payload = await this.post(
      "tinkoff.public.invest.api.contract.v1.InstrumentsService/Bonds",
      {
        instrumentStatus,
      },
    );

    return payload.instruments ?? [];
  }

  async getBondCoupons(instrumentId, from, to) {
    await waitForCouponRequestSlot();

    const payload = await this.post(
      "tinkoff.public.invest.api.contract.v1.InstrumentsService/GetBondCoupons",
      {
        instrumentId,
        from: from.toISOString(),
        to: to.toISOString(),
      },
    );

    return payload.events ?? [];
  }

  async getLastPrices(instrumentIds) {
    if (instrumentIds.length === 0) {
      return [];
    }

    const payload = await this.post(
      "tinkoff.public.invest.api.contract.v1.MarketDataService/GetLastPrices",
      {
        instrumentId: instrumentIds,
        lastPriceType: "LAST_PRICE_EXCHANGE",
        instrumentStatus: "INSTRUMENT_STATUS_BASE",
      },
    );

    return payload.lastPrices ?? [];
  }
}

function sleep(durationMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function getRetryDelayMs(attempt, headers) {
  const retryAfterHeader = headers?.get?.("retry-after");
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;

  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * ONE_SECOND;
  }

  return Math.min(500 * 2 ** attempt, 5 * ONE_SECOND);
}

async function waitForCouponRequestSlot() {
  let release;
  const previousGate = couponRequestGate;

  couponRequestGate = new Promise((resolve) => {
    release = resolve;
  });

  await previousGate;

  const now = Date.now();
  const waitMs = Math.max(0, nextCouponRequestAt - now);
  nextCouponRequestAt =
    Math.max(now, nextCouponRequestAt) + COUPON_REQUEST_INTERVAL_MS;

  release();

  if (waitMs > 0) {
    await sleep(waitMs);
  }
}

module.exports = {
  TBankApiError,
  TBankClient,
};
