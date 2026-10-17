"use strict";
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const { handleChat, createRateLimiter } = require("./groqProxy");

// The key is stored in Google Secret Manager:  firebase functions:secrets:set GROQ_API_KEY
const GROQ_API_KEY = defineSecret("GROQ_API_KEY");
// Optional: change the model at deploy time (default below)
const GROQ_MODEL = defineString("GROQ_MODEL", { default: "llama-3.3-70b-versatile" });

const limiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 40 });

exports.chat = onRequest(
  {
    secrets: [GROQ_API_KEY],     // a secret must be listed here to be readable inside the function
    region: "us-central1",
    maxInstances: 5,             // limits cost if somebody abuses the endpoint
    timeoutSeconds: 30,
    memory: "256MiB",
    invoker: "public",           // the web page calls it without login
  },
  async (req, res) => {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const result = await handleChat(
      { method: req.method, body: req.body, ip: forwarded || req.ip },
      { apiKey: GROQ_API_KEY.value(), model: GROQ_MODEL.value(), limiter }
    );
    res.set("Cache-Control", "no-store");
    res.status(result.status).json(result.json);
  }
);
