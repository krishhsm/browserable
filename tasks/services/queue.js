var Queue = require("bull");

const redisUrl = `${process.env.TASKS_REDIS_URL}2`;
const useTls =
    redisUrl.startsWith("rediss://") ||
    String(process.env.REDIS_TLS || "").toLowerCase() === "true" ||
    String(process.env.REDIS_TLS || "") === "1";
const redisConfig = useTls ? { tls: true, enableTLSForSentinelMode: false } : {};

var baseQueue = new Queue("base-queue", redisUrl, {
    redis: redisConfig,
});
var agentQueue = new Queue("agent-queue", redisUrl, {
    redis: redisConfig,
});
var integrationsQueue = new Queue(
    "integrations-queue",
    redisUrl,
    { redis: redisConfig }
);
var flowQueue = new Queue("flow-queue", redisUrl, {
    redis: redisConfig,
});
var vectorQueue = new Queue("vector-queue", redisUrl, {
    redis: redisConfig,
});

const browserQueue = new Queue(
    "browser-queue",
    redisUrl,
    {
        redis: redisConfig,
    }
);

module.exports = {
    baseQueue,
    agentQueue,
    flowQueue,
    integrationsQueue,
    vectorQueue,
    browserQueue,
};
