import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;
const RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const PAY_TO = "0x0b699db8ded26d3f8a1f1bf2aa90498c5f83c012";
const FACILITATOR = "https://x402.org/facilitator";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ORIGIN = process.env.API_PUBLIC_URL || `http://localhost:${PORT}`;

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, PAYMENT-SIGNATURE");
  res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

async function rpc(method, params = []) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

app.get("/", (req, res) => {
  res.json({
    name: "BaseChain Agent API",
    network: "Base Mainnet",
    chainId: 8453,
    endpoints: ["/network", "/block", "/gas", "/usdc", "/token", "/paid/network"]
  });
});

app.get("/network", async (req, res) => {
  try {
    const [chainId, block] = await Promise.all([
      rpc("eth_chainId"), rpc("eth_blockNumber")
    ]);
    res.json({
      network: "Base Mainnet",
      chainId: Number(chainId),
      latestBlock: parseInt(block, 16),
      status: "online"
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/block", async (req, res) => {
  try {
    const block = await rpc("eth_getBlockByNumber", ["latest", false]);
    res.json({
      number: parseInt(block.number, 16),
      hash: block.hash,
      timestamp: parseInt(block.timestamp, 16),
      transactions: block.transactions.length
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/gas", async (req, res) => {
  try {
    const price = await rpc("eth_gasPrice");
    res.json({
      gasPriceWei: BigInt(price).toString(),
      gasPriceGwei: Number(BigInt(price)) / 1e9
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/usdc", (req, res) => {
  res.json({
    network: "Base Mainnet",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    contract: USDC
  });
});

app.get("/token", (req, res) => {
  const address = req.query.address;
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: "Provide a valid token contract address" });
  }
  res.json({
    network: "Base Mainnet",
    contract: address,
    note: "Token metadata lookup is not implemented yet."
  });
});

const paymentOption = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "5000",
  asset: USDC,
  payTo: PAY_TO,
  maxTimeoutSeconds: 120,
  extra: { name: "USD Coin", version: "2" }
};

app.post("/paid/network", async (req, res) => {
  const resource = {
    url: `${ORIGIN}/paid/network`,
    description: "Live Base Mainnet network information",
    mimeType: "application/json",
    serviceName: "BaseChain Agent API"
  };

  const offer = {
    x402Version: 2,
    error: "Payment required",
    resource,
    accepts: [paymentOption]
  };

  const encoded = req.get("PAYMENT-SIGNATURE");

  if (!encoded) {
    return res.status(402)
      .set("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(offer)).toString("base64"))
      .json(offer);
  }

  try {
    const payment = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    const body = {
      x402Version: 2,
      paymentPayload: payment,
      paymentRequirements: paymentOption
    };

    const headers = { "content-type": "application/json" };

    const verifyResponse = await fetch(`${FACILITATOR}/verify`, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    const verified = await verifyResponse.json();

    if (!verifyResponse.ok || !verified.isValid) {
      return res.status(402).json({
        error: "Payment verification failed",
        details: verified.invalidReason || verified.error
      });
    }

    const settleResponse = await fetch(`${FACILITATOR}/settle`, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    const settlement = await settleResponse.json();

    if (!settleResponse.ok || !settlement.success) {
      return res.status(502).json({ error: "Payment settlement failed" });
    }

    const [chainId, block] = await Promise.all([
      rpc("eth_chainId"), rpc("eth_blockNumber")
    ]);

    return res.status(200)
      .set("PAYMENT-RESPONSE", Buffer.from(JSON.stringify(settlement)).toString("base64"))
      .json({
        network: "Base Mainnet",
        chainId: Number(chainId),
        latestBlock: parseInt(block, 16),
        status: "online"
      });
  } catch (error) {
    return res.status(502).json({ error: error.message });
  }
});


app.get("/openapi.json", (req, res) => {
  res.json({
    openapi: "3.0.3",
    info: {
      title: "BaseChain Agent API",
      version: "1.0.0",
      description: "Base Mainnet network information API"
    },
    paths: {
      "/paid/network": {
        post: {
          summary: "Get live Base network information",
          "x-payment-info": paymentOption,
          responses: {
            "200": { description: "Network information returned after payment" },
            "402": { description: "USDC payment required" }
          }
        }
      }
    }
  });
});

export default app;

if (!process.env.VERCEL) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`BaseChain Agent API running on port ${PORT}`);
    console.log(`Payment recipient: ${PAY_TO}`);
  });
}
