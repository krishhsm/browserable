var express = require("express");
var router = express.Router();
var cors = require("cors");
var { getReadableFromUTCToLocal } = require("../utils/datetime");
var { createFlow, changeFlowStatus } = require("../logic/flow");
var {
    callOpenAICompatibleLLMWithRetry,
    updateMetadataOfLLMCall,
} = require("../services/llm");
var { getRunStatus, getMostRecentRun } = require("../logic/flow");
var {
    processUserInputForRun,
    processUserInputForNode,
    getAvailableTriggers,
    endRun,
} = require("../agents/jarvis");
var db = require("../services/db");
const {
    getDocumentsFromDataTable,
    getDataTableSchema,
} = require("../logic/datatable");
const { getGifStatus } = require("../logic/logs");

// Middleware to validate API key and get account/user info
const validateApiKey = async (req, res, next) => {
    const api_key = req.headers["x-api-key"];

    if (!api_key) {
        return res.json({ success: false, error: "API key is required" });
    }

    try {
        const tasksDB = await db.getTasksDB();
        const { rows } = await tasksDB.query(
            `SELECT account_id, user_id FROM browserable.api_keys WHERE api_key = $1`,
            [api_key]
        );

        if (rows.length === 0) {
            return res.json({ success: false, error: "Invalid API key" });
        }

        req.account_id = rows[0].account_id;
        req.user_id = rows[0].user_id;
        next();
    } catch (e) {
        console.log(e);
        res.json({ success: false, error: e.message });
    }
};

// Create task
router.post("/task/create", cors(), validateApiKey, async (req, res) => {
    const { task, agent = "BROWSER_AGENT", tools = [] } = req.body;

    if (!task) {
        return res.json({ success: false, error: "Task is required" });
    }

    try {
        const uniqueKeyInMetadata = "generator";
        const uniqueValInMetadata = Date.now();

        // Generate readable name and description
        const llmResponse = await callOpenAICompatibleLLMWithRetry({
            messages: [
                {
                    role: "system",
                    content: `Create a simple readable_name (max 4-5 words) and readable_description (max 2-3 sentences) based on the user's inital message.`,
                },
                {
                    role: "user",
                    content: `Initial message: ${task}
                    
Output format: (JSON)
{
    "readable_name": "<readable_name>",
    "readable_description": "<readable_description>"
}
ONLY output the JSON, nothing else.`,
                },
            ],
            metadata: {
                [uniqueKeyInMetadata]: uniqueValInMetadata,
                usecase: "generator",
                accountId: req.account_id,
            },
            models: [
                "gemini-2.5-flash",
                "deepseek-chat",
                "gpt-4o-mini",
                "claude-3-5-haiku",
                "qwen-plus",
            ],
            max_attempts: 4,
        });

        let finalTriggers = ["once|0|"];
        let readableDescriptionOfTriggers = "Runs once immediately.";

        const { flowId } = await createFlow({
            flow: {
                account_id: req.account_id,
                readable_name: llmResponse?.readable_name || "Flow",
                readable_description:
                    llmResponse?.readable_description || "Flow",
                user_id: req.user_id,
                task: task,
                triggers: finalTriggers,
                data: {},
                status: "active",
                metadata: {
                    agent_codes: [agent],
                    initMessage: task,
                    readableDescriptionOfTriggers,
                    tools: tools || [],
                },
            },
        });

        await updateMetadataOfLLMCall({
            uniqueKeyInMetadata,
            uniqueValInMetadata,
            metadataToUpdate: {
                flowId,
            },
        });

        res.json({ success: true, data: { taskId: flowId } });
    } catch (e) {
        console.log(e);
        res.json({ success: false, error: e.message });
    }
});

// Get task run status
router.get(
    "/task/:taskId/run/:runId?/status",
    cors(),
    validateApiKey,
    async (req, res) => {
        const { taskId } = req.params;
        const runId = req.params.runId;

        if (!taskId) {
            return res.json({ success: false, error: "Task ID is required" });
        }

        try {
            // If runId is not provided, get the most recent run
            let finalRunId = runId;
            if (!finalRunId) {
                finalRunId = await getMostRecentRun({
                    taskId,
                    accountId: req.account_id,
                });
                if (!finalRunId) {
                    return res.json({
                        success: true,
                        data: {
                            status: null,
                            toolCall: null,
                            liveStatus: null,
                            sessionId: null,
                        },
                    });
                }
            }

            const runStatus = await getRunStatus({
                runId: finalRunId,
                taskId,
                accountId: req.account_id,
            });

            res.json({
                success: true,
                data: runStatus,
            });
        } catch (e) {
            console.log(e);
            res.json({ success: false, error: e.message });
        }
    }
);

// Get task run result
router.get(
    "/task/:taskId/run/:runId?/result",
    cors(),
    validateApiKey,
    async (req, res) => {
        const { taskId } = req.params;
        const runId = req.params.runId;

        if (!taskId) {
            return res.json({ success: false, error: "Task ID is required" });
        }

        try {
            const tasksDB = await db.getTasksDB();

            // If runId is not provided, get the most recent run
            let finalRunId = runId;
            if (!finalRunId) {
                finalRunId = await getMostRecentRun({
                    taskId,
                    accountId: req.account_id,
                });
                if (!finalRunId) {
                    return res.json({
                        success: true,
                        data: {
                            status: null,
                            error: null,
                            output: null,
                            dataTable: [],
                        },
                    });
                }
            }

            // Get run details
            const { rows: runs } = await tasksDB.query(
                `SELECT status, error, output 
            FROM browserable.runs 
            WHERE id = $1 AND flow_id = $2 AND account_id = $3`,
                [finalRunId, taskId, req.account_id]
            );

            if (runs.length === 0) {
                return res.json({
                    success: true,
                    data: {
                        status: null,
                        error: null,
                        output: null,
                        dataTable: [],
                    },
                });
            }

            // Get results table documents
            const { documents } = await getDocumentsFromDataTable({
                flowId: taskId,
                accountId: req.account_id,
                userId: req.user_id,
                page: 1,
                pageSize: 100,
            });

            // remove _id, flowId, accountId from documents
            documents.forEach((document) => {
                delete document._id;
                delete document.flowId;
                delete document.accountId;
                delete document.subTask;
            });

            res.json({
                success: true,
                data: {
                    status:
                        runs[0].status === "pending"
                            ? "scheduled"
                            : runs[0].status === "completed"
                            ? "completed"
                            : runs[0].status === "error"
                            ? "error"
                            : "running",
                    ...(runs[0].error && { error: runs[0].error }),
                    ...(runs[0].output && { output: runs[0].output }),
                    dataTable: documents,
                },
            });
        } catch (e) {
            console.log(e);
            res.json({ success: false, error: e.message });
        }
    }
);

// Stop a task run
router.put(
    "/task/:taskId/run/:runId?/stop",
    cors(),
    validateApiKey,
    async (req, res) => {
        const { taskId } = req.params;
        let runId = req.params.runId;

        if (!taskId) {
            return res.json({ success: false, error: "Task ID is required" });
        }

        try {
            const tasksDB = await db.getTasksDB();
            if (!runId) {
                runId = await getMostRecentRun({
                    taskId,
                    accountId: req.account_id,
                });
                if (!runId) {
                    return res.json({
                        success: false,
                        error: "Run ID is required",
                    });
                }
            }

            // get the run details
            const { rows: runs } = await tasksDB.query(
                `SELECT id, status FROM browserable.runs 
            WHERE id = $1 AND flow_id = $2 AND account_id = $3`,
                [runId, taskId, req.account_id]
            );

            if (runs.length === 0) {
                return res.json({ success: false, error: "Run not found" });
            }

            const run = runs[0];

            if (run.status === "completed" || run.status === "error") {
                return res.json({
                    success: false,
                    error: "Run already completed",
                });
            }

            await endRun({
                runId,
                userId: req.user_id,
                accountId: req.account_id,
                error: "API abort",
                status: "error",
            });

            res.json({ success: true });
        } catch (e) {
            console.log(e);
            res.json({ success: false, error: e.message });
        }
    }
);

// Handle tool input for a task run
router.post(
    "/task/:taskId/run/:runId?/tool-input",
    cors(),
    validateApiKey,
    async (req, res) => {
        const { taskId } = req.params;
        let runId = req.params.runId;
        const { input, toolCallId } = req.body;

        if (!taskId) {
            return res.json({ success: false, error: "Task ID is required" });
        }

        if (!input) {
            return res.json({ success: false, error: "Input is required" });
        }

        try {
            // If runId not provided, get the most recent run
            if (!runId) {
                runId = await getMostRecentRun({
                    taskId,
                    accountId: req.account_id,
                });
                if (!runId) {
                    return res.json({
                        success: false,
                        error: "No active run found",
                    });
                }
            }

            // Get the run status
            const runStatus = await getRunStatus({
                runId,
                accountId: req.account_id,
                taskId,
                retainToolCallIds: true,
            });

            // If toolCallId is provided, verify it matches current tool call
            if (toolCallId && runStatus.toolCall && runStatus.toolCall.id !== toolCallId) {
                return res.json({
                    success: false,
                    error: "Tool call ID mismatch",
                });
            }

            if (!runStatus.toolCall) {
                return res.json({
                    success: false,
                    error: "Run is not waiting for tool input",
                });
            }

            // Process the input based on whether it's a node-level or run-level tool call
            if (runStatus.detailedStatus === "tool_call" && runStatus.toolCall.nodeId) {
                await processUserInputForNode({
                    nodeId: runStatus.toolCall.nodeId,
                    runId,
                    toolCallId: toolCallId || runStatus.toolCall.id,
                    messages: input,
                });
            } else if (runStatus.detailedStatus === "tool_call" && !runStatus.toolCall.nodeId) {
                await processUserInputForRun({
                    runId,
                    toolCallId: toolCallId || runStatus.toolCall.id,
                    messages: input,
                    userId: req.user_id,
                    accountId: req.account_id,
                });
            } else {
                return res.json({
                    success: false,
                    error: "Run is not waiting for tool input",
                });
            }

            res.json({ success: true });
        } catch (e) {
            console.log(e);
            res.json({ success: false, error: e.message });
        }
    }
);

// Get all runs for a task
router.get("/task/:taskId/runs", cors(), validateApiKey, async (req, res) => {
    const { taskId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 30, 30);

    if (!taskId) {
        return res.json({ success: false, error: "Task ID is required" });
    }

    try {
        const tasksDB = await db.getTasksDB();
        const { rows: runs } = await tasksDB.query(
            `SELECT id, created_at FROM browserable.runs 
            WHERE flow_id = $1 AND account_id = $2 
            ORDER BY created_at DESC
            LIMIT $3 OFFSET $4`,
            [taskId, req.account_id, limit, (page - 1) * limit]
        );

        const totalRuns = await tasksDB.query(
            `SELECT COUNT(*) FROM browserable.runs 
            WHERE flow_id = $1 AND account_id = $2`,
            [taskId, req.account_id]
        );

        res.json({
            success: true,
            data: runs,
            total: totalRuns.rows[0].count,
            page,
            limit,
        });
    } catch (e) {
        console.log(e);
        res.json({ success: false, error: e.message });
    }
});

// List all tasks
router.get("/tasks", cors(), validateApiKey, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 30, 30);

    try {
        const tasksDB = await db.getTasksDB();
        const { rows: tasks } = await tasksDB.query(
            `SELECT id, status, readable_name FROM browserable.flows 
            WHERE account_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3`,
            [req.account_id, limit, (page - 1) * limit]
        );

        const totalTasks = await tasksDB.query(
            `SELECT COUNT(*) FROM browserable.flows 
            WHERE account_id = $1`,
            [req.account_id]
        );

        res.json({
            success: true,
            data: tasks,
            total: totalTasks.rows[0].count,
            page,
            limit,
        });
    } catch (e) {
        console.log(e);
        res.json({ success: false, error: e.message });
    }
});

// Stop a task
router.put("/task/:taskId/stop", cors(), validateApiKey, async (req, res) => {
    const { taskId } = req.params;

    if (!taskId) {
        return res.json({ success: false, error: "Task ID is required" });
    }

    try {
        const tasksDB = await db.getTasksDB();

        // get the current status of the task
        const { rows: tasks } = await tasksDB.query(
            `SELECT status FROM browserable.flows 
            WHERE id = $1 AND account_id = $2`,
            [taskId, req.account_id]
        );

        if (tasks.length === 0) {
            return res.json({ success: false, error: "Task not found" });
        }

        const task = tasks[0];

        if (task.status === "inactive") {
            return res.json({ success: false, error: "Task already stopped" });
        }

        await changeFlowStatus({
            flowId: taskId,
            userId: req.user_id,
            accountId: req.account_id,
            status: "inactive",
            currentStatus: task.status,
        });

        res.json({
            success: true,
        });
    } catch (e) {
        console.log(e);
        res.json({ success: false, error: e.message });
    }
});

// Get GIF status for a run
router.get(
    "/task/:taskId/run/:runId?/gif",
    cors(),
    validateApiKey,
    async (req, res) => {
        const { taskId } = req.params;
        const runId = req.params.runId;

        if (!taskId) {
            return res.json({ success: false, error: "Task ID is required" });
        }

        try {
            const result = await getGifStatus({
                flowId: taskId,
                runId,
                accountId: req.account_id,
            });

            res.json(result);
        } catch (e) {
            console.log(e);
            res.json({ success: false, error: e.message });
        }
    }
);

router.get("/check", cors(), validateApiKey, async (req, res) => {
    res.json({ success: true, data: "ok" });
});

router.get("/health", cors(), async (req, res) => {
    res.json({ success: true, data: "ok" });
});

module.exports = router;
