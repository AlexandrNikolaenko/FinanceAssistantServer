const cors = require("cors");
const dotenv = require("dotenv");
const express = require("express");

const { getBondYields } = require("./bonds-service");
const { TBankApiError } = require("./tbank-client");

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 4000);

function getSingleQueryValue(value) {
  return typeof value === "string" ? value : undefined;
}

app.use(
  cors({
    origin: true,
  }),
);
app.use(express.json());

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/bonds", async (request, response) => {
  try {
    const payload = await getBondYields({
      page: getSingleQueryValue(request.query.page),
      pageSize: getSingleQueryValue(request.query.pageSize),
      maturityDateFrom: getSingleQueryValue(request.query.maturityDateFrom),
      maturityDateTo: getSingleQueryValue(request.query.maturityDateTo),
      riskLevel: getSingleQueryValue(request.query.riskLevel),
      amortization: getSingleQueryValue(request.query.amortization),
      currency: getSingleQueryValue(request.query.currency),
      couponType: getSingleQueryValue(request.query.couponType),
    });
    response.json(payload);
  } catch (error) {
    const isTBankError = error instanceof TBankApiError;

    response.status(isTBankError ? error.status : 500).json({
      message: error.message || "Unexpected server error",
      details: isTBankError ? error.payload : undefined,
    });
  }
});

app.listen(port, () => {
  console.log(`Backend is listening on http://localhost:${port}`);
});
