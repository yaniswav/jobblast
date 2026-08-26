import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

const options: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
};

if (!isProduction) {
  options.transport = {
    target: "pino-pretty",
    options: { colorize: true },
  };
}

export const logger = pino(options);
