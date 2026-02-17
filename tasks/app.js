var createError = require("http-errors");
var express = require("express");
var path = require("path");
var cookieParser = require("cookie-parser");
var cors = require("cors");
var logger = require("morgan");
const { createBullBoard } = require("@bull-board/api");
const { BullAdapter } = require("@bull-board/api/bullAdapter");
const { ExpressAdapter } = require("@bull-board/express");
const fs = require("fs");

var indexRouter = require("./routes/index");
var otpRouter = require("./routes/otp");
var helpersRouter = require("./routes/helpers");
var jarvisRouter = require("./routes/jarvis");
var flowsRouter = require("./routes/flow");
var accountRouter = require("./routes/account");
var userRouter = require("./routes/user");
var baseIntegrationsRouter = require("./routes/integrations/base");
var apiRouter = require("./routes/api");
var {
    baseQueue,
    agentQueue,
    integrationsQueue,
    flowQueue,
    browserQueue,
    vectorQueue,
} = require("./services/queue");

// Import queue processors
require("./logic/integrations/base");
require("./logic/integrations/browser");

const browserService = require("./services/browser");

var {
    getUserFromToken,
    createLoginToken,
    createUser,
    setUserDetails,
} = require("./logic/user");
var { createAccountForUser, getAccountsOfUser } = require("./logic/account");
var db = require("./services/db");

const LOG_TO_FILE =
    String(process.env.LOG_TO_FILE || "").toLowerCase() === "1" ||
    String(process.env.LOG_TO_FILE || "").toLowerCase() === "true";
const LOG_FILE_PATH =
    process.env.LOG_FILE_PATH || path.join(process.cwd(), "logs", "node-logs.jsonl");

function appendConsoleLog(level, args) {
    if (!LOG_TO_FILE) return;
    try {
        const dir = path.dirname(LOG_FILE_PATH);
        fs.mkdirSync(dir, { recursive: true });
        const message = args
            .map((arg) => {
                if (typeof arg === "string") return arg;
                try {
                    return JSON.stringify(arg);
                } catch (e) {
                    return String(arg);
                }
            })
            .join(" ");
        const line = JSON.stringify({
            ts: new Date().toISOString(),
            segment: "console",
            level,
            pid: process.pid,
            message,
        });
        fs.promises.appendFile(LOG_FILE_PATH, line + "\n").catch(() => {});
    } catch (e) {
        // never throw from logger
    }
}

const originalConsoleLog = console.log.bind(console);
const originalConsoleWarn = console.warn.bind(console);
const originalConsoleError = console.error.bind(console);

console.log = (...args) => {
    originalConsoleLog(...args);
    appendConsoleLog("log", args);
};
console.warn = (...args) => {
    originalConsoleWarn(...args);
    appendConsoleLog("warn", args);
};
console.error = (...args) => {
    originalConsoleError(...args);
    appendConsoleLog("error", args);
};

async function setupBaseUser() {
    const user_id = await createUser({
        email: process.env.ADMIN_EMAIL,
    });

    // if there's no account for this user, create one
    const accounts = await getAccountsOfUser({ userId: user_id });
    if (accounts.length === 0) {
        await createAccountForUser({
            userId: user_id,
            accountName: "@admin",
            role: "admin",
            metadata: {},
            emailId: process.env.ADMIN_EMAIL,
            possibleExistingAccountId: "@admin",
            suggestedAccountId: "@admin",
        });
    } else if (accounts.length === 1 && !!Number(process.env.SINGLE_USER_MODE)) {
        // if it's single user mode, and if user's metadata has browser api keys, we need to reset the clients
        if (accounts[0].metadata && accounts[0].metadata.userBrowserApiKeys) {
            await browserService.resetClients({
                hyperbrowserApiKey:
                    accounts[0].metadata.userBrowserApiKeys.hyperBrowser,
                browserbaseApiKey:
                    accounts[0].metadata.userBrowserApiKeys.browserbase,
                steelApiKey: accounts[0].metadata.userBrowserApiKeys.steel,
                browserbaseProjectId:
                    accounts[0].metadata.userBrowserApiKeys.browserbaseProjectId,
            });
        }
    }
}

// setting up base user for default mode
if (!!Number(process.env.SINGLE_USER_MODE)) {
    setupBaseUser();
}

var app = express();

if (process.env.NODE_ENV == "production") {
    app.set("trust proxy", 1);
}

// view engine setup
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "hbs");

app.use(logger("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

app.use("/", indexRouter);
app.use("/otp", otpRouter);
app.use("/jarvis", jarvisRouter);
app.use("/flow", flowsRouter);
app.use("/account", accountRouter);
app.use("/user", userRouter);
app.use("/api/v1", apiRouter);
app.use("/helpers", helpersRouter);
app.use("/integrations/base", baseIntegrationsRouter);
// Queue monitor
const serverAdapter = new ExpressAdapter();
const { addQueue, removeQueue, setQueues, replaceQueues } = createBullBoard({
    queues: [
        new BullAdapter(baseQueue),
        new BullAdapter(agentQueue),
        new BullAdapter(integrationsQueue),
        new BullAdapter(flowQueue),
        new BullAdapter(browserQueue),
        new BullAdapter(vectorQueue),
    ],
    serverAdapter: serverAdapter,
});
serverAdapter.setBasePath("/admin/queues");
app.use("/admin/queues", serverAdapter.getRouter());

const companion = require("@uppy/companion");
const UPPY_OPTIONS = {
    filePath: "/",
    server: {
        protocol: !!Number(process.env.DEBUG) ? "http" : "https",
        host: process.env.DOMAIN,
        path: "/companion",
    },
    secret: process.env.SECRET,
    debug: !!Number(process.env.DEBUG),
    providerOptions: {
        s3: {
            key: process.env.S3_KEY,
            secret: process.env.S3_SECRET,
            bucket: process.env.S3_BUCKET,
            endpoint: process.env.S3_ENDPOINT,
            region: "us-east-1",
            acl: process.env.COMPANION_AWS_ACL || "public-read",
            object_url: { public: true },
            getKey: (req, fileName) => {
                return req.query.metadata?.fileName || fileName;
            },
        },
    },
    object_url: { public: true },
    corsOrigins: process.env.COMPANION_CLIENT_ORIGINS,
    uploadUrls: process.env.COMPANION_UPLOAD_URLS,
};
const companionApp = companion.app(UPPY_OPTIONS);

console.log("process.env.COMPANION_AWS_ACL", process.env.COMPANION_AWS_ACL);

app.use(
    "/companion",
    cors({
        origin: process.env.COMPANION_CLIENT_ORIGINS.split(","),
    }),
    companionApp
);

// Add test utils route
const testUtilsRouter = require("./routes/test-utils");
app.use("/test-utils", testUtilsRouter);

// Health check endpoint
app.get("/health", (req, res) => {
    res.status(200).json({
        status: "healthy",
        version: require("./version").VERSION,
        timestamp: new Date().toISOString(),
    });
});

// catch 404 and forward to error handler
app.use(function (req, res, next) {
    next(createError(404));
});

// error handler
app.use(function (err, req, res, next) {
    // set locals, only providing error in development
    res.locals.message = err.message;
    res.locals.error = req.app.get("env") === "development" ? err : {};

    // render the error page
    res.status(err.status || 500);
    res.render("error");
});

module.exports = app;
