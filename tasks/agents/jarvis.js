const { callOpenAICompatibleLLMWithRetry } = require("../services/llm");
const { agent: GenerativeAgent } = require("./generative");
const { agent: BrowserableAgent } = require("./browserable");
const { agent: DeepResearchAgent } = require("./deepresearch");
const { createGifFromMessageLogs } = require("../logic/logs");
const { sendEmail } = require("../services/email");
const { z } = require("zod");
const { zodResponseFormat } = require("openai/helpers/zod");
const {
    createFlow,
    updateRunStatus,
    updateNodeStatus,
    updateRunLiveStatus,
    updateNodeLiveStatus,
    createDetailedOutputForNode,
    createUpdatesToDocuments,
    createDetailedOutputWithMessages,
    getNodeAgentLog,
    updateFlowCreatorStatus,
    turnOffFlowIfNoTriggers,
} = require("../logic/flow");
const {
    getDocumentsFromDataTable,
    getDataTableSchema,
    addDocumentsToDataTable,
    updateDocumentInDataTable,
    getDocumentsFromDataTableByFilter,
    getDocumentsFromDataTableByIds,
} = require("../logic/datatable");
const { getReadableFromUTCToLocal } = require("../utils/datetime");
const db = require("../services/db");
const tiktoken = require("tiktoken");
const enc = tiktoken.encoding_for_model("text-embedding-3-small");
const textEncoding = require("text-encoding");
const TextDecoder = textEncoding.TextDecoder;
const MAX_CONTEXT_LENGTH = 50000;
const {
    getSimilarFileChunksHelper,
    getChunkTextsFromIdsHelper,
} = require("../logic/vectors");

const { agentQueue, flowQueue } = require("../services/queue");
const { jarvis: jarvisPrompts } = require("../prompts/agents");
const agentMap = {
    [GenerativeAgent.CODE]: GenerativeAgent,
    [BrowserableAgent.CODE]: BrowserableAgent,
    [DeepResearchAgent.CODE]: DeepResearchAgent,
};
const crypto = require("crypto");
const { sendDiscordAdminAlert } = require("../logic/utils");
const { doneWithSession } = require("../logic/integrations/browser");
const fs = require("fs");
const path = require("path");

function generateUUID() {
    return crypto.randomUUID();
}

const LLM_CALL_LIMIT_PER_THREAD = 100;
const LLM_CALL_LIMIT_PER_NODE = 50;
const LLM_CALL_LIMIT_PER_RUN = 1000;
const LLM_CALL_LIMIT_PER_FLOW_PER_DAY = 1000;
const LLM_CALL_LIMIT_PER_USER_PER_DAY = 1000;
const LOG_TO_FILE =
    String(process.env.LOG_TO_FILE || "").toLowerCase() === "1" ||
    String(process.env.LOG_TO_FILE || "").toLowerCase() === "true";
const LOG_FILE_PATH =
    process.env.LOG_FILE_PATH ||
    path.join(process.cwd(), "logs", "node-logs.jsonl");

async function appendLogToFile({
    segment,
    runId,
    nodeId,
    threadId,
    messages,
}) {
    if (!LOG_TO_FILE) return;
    try {
        const dir = path.dirname(LOG_FILE_PATH);
        fs.mkdirSync(dir, { recursive: true });
        const line = JSON.stringify({
            ts: new Date().toISOString(),
            segment,
            runId,
            nodeId,
            threadId,
            messages,
        });
        await fs.promises.appendFile(LOG_FILE_PATH, line + "\n");
    } catch (e) {
        console.error("Failed to append log to file:", e);
    }
}

async function countLLMCallsForThread({ threadId }) {
    const tasksDB = await db.getTasksDB();
    const { rows: calls } = await tasksDB.query(
        `SELECT COUNT(*) FROM browserable.llm_calls WHERE metadata->>'thread_id' = $1`,
        [threadId]
    );
    return calls[0].count;
}

async function countLLMCallsForNode({ nodeId }) {
    const tasksDB = await db.getTasksDB();
    const { rows: calls } = await tasksDB.query(
        `SELECT COUNT(*) FROM browserable.llm_calls WHERE metadata->>'node_id' = $1`,
        [nodeId]
    );
    return calls[0].count;
}

async function countLLMCallsForRun({ runId }) {
    const tasksDB = await db.getTasksDB();
    const { rows: calls } = await tasksDB.query(
        `SELECT COUNT(*) FROM browserable.llm_calls WHERE metadata->>'run_id' = $1`,
        [runId]
    );
    return calls[0].count;
}

async function countLLMCallsForFlowToday({ flowId }) {
    const tasksDB = await db.getTasksDB();
    const { rows: calls } = await tasksDB.query(
        `SELECT COUNT(*) FROM browserable.llm_calls WHERE metadata->>'flow_id' = $1 AND created_at >= CURRENT_DATE`,
        [flowId]
    );
    return calls[0].count;
}

async function countLLMCallsForAccountToday({ accountId }) {
    const tasksDB = await db.getTasksDB();
    const { rows: calls } = await tasksDB.query(
        `SELECT COUNT(*) FROM browserable.llm_calls WHERE metadata->>'account_id' = $1 AND created_at >= CURRENT_DATE`,
        [accountId]
    );
    return calls[0].count;
}

async function checkLLMCallLimits({
    accountId,
    flowId,
    runId,
    threadId,
    nodeId,
}) {
    try {
        const checks = [];

        if (threadId) {
            checks.push(
                countLLMCallsForThread({ threadId }).then((count) => {
                    if (count >= LLM_CALL_LIMIT_PER_THREAD) {
                        throw new Error(
                            `Thread ${threadId} has exceeded LLM call limit of ${LLM_CALL_LIMIT_PER_THREAD}`
                        );
                    }
                })
            );
        }

        if (nodeId) {
            checks.push(
                countLLMCallsForNode({ nodeId }).then((count) => {
                    if (count >= LLM_CALL_LIMIT_PER_NODE) {
                        throw new Error(
                            `Node ${nodeId} has exceeded LLM call limit of ${LLM_CALL_LIMIT_PER_NODE}`
                        );
                    }
                })
            );
        }

        if (runId) {
            checks.push(
                countLLMCallsForRun({ runId }).then((count) => {
                    if (count >= LLM_CALL_LIMIT_PER_RUN) {
                        throw new Error(
                            `Run ${runId} has exceeded LLM call limit of ${LLM_CALL_LIMIT_PER_RUN}`
                        );
                    }
                })
            );
        }

        if (flowId) {
            checks.push(
                countLLMCallsForFlowToday({ flowId }).then((count) => {
                    if (count >= LLM_CALL_LIMIT_PER_FLOW_PER_DAY) {
                        throw new Error(
                            `Flow ${flowId} has exceeded daily LLM call limit of ${LLM_CALL_LIMIT_PER_FLOW_PER_DAY}`
                        );
                    }
                })
            );
        }

        if (accountId) {
            checks.push(
                countLLMCallsForAccountToday({ accountId }).then((count) => {
                    if (count >= LLM_CALL_LIMIT_PER_USER_PER_DAY) {
                        throw new Error(
                            `Account ${accountId} has exceeded daily LLM call limit of ${LLM_CALL_LIMIT_PER_USER_PER_DAY}`
                        );
                    }
                })
            );
        }

        await Promise.all(checks);
        return true; // All checks passed
    } catch (error) {
        console.log("LLM call limit exceeded", error);
        await sendDiscordAdminAlert(
            JSON.stringify({
                message: error.message,
            })
        );

        return false;
    }
}

async function getAvailableAgentsForUser({
    user_id,
    account_id,
    runId,
    threadId,
}) {
    let allAgentCodes = Object.keys(agentMap);

    // get metadata of this run
    const tasksDB = await db.getTasksDB();

    let restrictionList = [];

    if (threadId) {
        const { rows: threads } = await tasksDB.query(
            `SELECT data FROM browserable.threads WHERE id = $1`,
            [threadId]
        );
        const threadMetadata = threads[0].data;
        if (threadMetadata && threadMetadata.agent_codes) {
            restrictionList = threadMetadata.agent_codes;
        }
    } else if (runId) {
        const { rows: runs } = await tasksDB.query(
            `SELECT metadata FROM browserable.runs WHERE id = $1`,
            [runId]
        );
        const runMetadata = runs[0].metadata;
        if (runMetadata && runMetadata.agent_codes) {
            restrictionList = runMetadata.agent_codes;
        }
    }

    if (restrictionList.length > 0) {
        allAgentCodes = allAgentCodes.filter((agentCode) =>
            restrictionList.includes(agentCode)
        );
    }

    // construct an object with agent codes as keys and agent instances as values
    const availableAgents = {};
    for (const agentCode of allAgentCodes) {
        availableAgents[agentCode] = agentMap[agentCode];
    }

    const availableAgentsString = Object.keys(availableAgents)
        .map((agentCode) => {
            return `AGENT CODE: ${agentCode}
AGENT DESCRIPTION: ${availableAgents[agentCode].DETAILS.description}`;
        })
        .join("\n\n");

    return {
        availableAgents,
        availableAgentsString,
    };
}

async function getNodeInfo({ runId, nodeId }) {
    const tasksDB = await db.getTasksDB();
    const { rows } = await tasksDB.query(
        `SELECT * FROM browserable.nodes WHERE id = $1 AND run_id = $2`,
        [nodeId, runId]
    );
    return rows[0];
}

async function saveNodePrivateData({ runId, nodeId, data }) {
    // get current private_data
    const tasksDB = await db.getTasksDB();
    const { rows: nodes } = await tasksDB.query(
        `SELECT private_data FROM browserable.nodes WHERE id = $1 AND run_id = $2`,
        [nodeId, runId]
    );
    const currentPrivateData = nodes[0]?.private_data || {};

    // merge new data with current data
    const mergedData = { ...currentPrivateData, ...data };

    // upsert the data
    await tasksDB.query(
        `UPDATE browserable.nodes SET private_data = $1 WHERE id = $2 AND run_id = $3`,
        [JSON.stringify(mergedData), nodeId, runId]
    );
}

async function upsertRunPrivateData({ runId, data }) {
    // get current private_data
    const tasksDB = await db.getTasksDB();
    const { rows: runs } = await tasksDB.query(
        `SELECT private_data FROM browserable.runs WHERE id = $1`,
        [runId]
    );
    const currentPrivateData = runs[0]?.private_data || {};
    // merge new data with current data
    const mergedData = { ...currentPrivateData, ...data };

    // upsert the data
    await tasksDB.query(
        `UPDATE browserable.runs SET private_data = $1 WHERE id = $2`,
        [JSON.stringify(mergedData), runId]
    );
}

async function getRunPrivateData({ runId }) {
    const tasksDB = await db.getTasksDB();
    const { rows: runs } = await tasksDB.query(
        `SELECT private_data FROM browserable.runs WHERE id = $1`,
        [runId]
    );

    return runs[0]?.private_data || {};
}

// CRUD node data
async function updateNodeKeyVal({ runId, nodeId, data }) {
    const tasksDB = await db.getTasksDB();

    // get current node data
    const { rows: nodes } = await tasksDB.query(
        `SELECT data FROM browserable.nodes WHERE id = $1`,
        [nodeId]
    );
    const currentNodeData = nodes[0].data || {};

    // merge new data with current data
    const mergedData = { ...currentNodeData, ...data };

    // update the node data in the nodes table
    await tasksDB.query(
        `UPDATE browserable.nodes SET data = $1 WHERE id = $2`,
        [JSON.stringify(mergedData), nodeId]
    );
}

// CRUD run data
async function updateRunKeyVal({ runId, data }) {
    const tasksDB = await db.getTasksDB();

    // get current run data
    const { rows: runs } = await tasksDB.query(
        `SELECT data FROM browserable.runs WHERE id = $1`,
        [runId]
    );
    const currentRunData = runs[0].data || {};

    // merge new data with current data
    const mergedData = { ...currentRunData, ...data };

    // update the run data in the runs table
    await tasksDB.query(`UPDATE browserable.runs SET data = $1 WHERE id = $2`, [
        JSON.stringify(mergedData),
        runId,
    ]);
}

// schedule a looper for a node
async function scheduleNodeLooper({
    input,
    runId,
    threadId,
    nodeId,
    delay,
    agentCode,
    sync = false,
}) {
    if (sync) {
        const tasksDB = await db.getTasksDB();
        const { rows: runs } = await tasksDB.query(
            `SELECT user_id, flow_id, account_id, status FROM browserable.runs WHERE id = $1`,
            [runId]
        );
        const run = runs[0];
        const userId = run.user_id;
        const flowId = run.flow_id;
        const accountId = run.account_id;

        // get the input of the node
        const { rows: nodes } = await tasksDB.query(
            `SELECT input FROM browserable.nodes WHERE id = $1`,
            [nodeId]
        );

        if (!input) {
            input = nodes[0].input;
        }

        const agent = agentMap[agentCode];
        await agent._looper({
            input,
            runId,
            nodeId,
            threadId,
            jarvis: {
                ...jarvis,
                user_id: userId,
                flow_id: flowId,
                account_id: accountId,
                thread_id: threadId,
            },
        });
    } else {
        const tasksDB = await db.getTasksDB();
        const { rows: nodes } = await tasksDB.query(
            `SELECT input, agent_code FROM browserable.nodes WHERE id = $1`,
            [nodeId]
        );

        if (!input) {
            input = nodes[0].input;
        }

        if (!agentCode) {
            agentCode = nodes[0].agent_code;
        }

        await agentQueue.add(
            `node-looper`,
            {
                runId,
                threadId,
                nodeId,
                agentCode,
                input,
            },
            {
                delay: delay || 0,
                jobId: `${runId}-${nodeId}-node-looper`,
                removeOnComplete: true,
                attempts: 2,
            }
        );
    }
}

agentQueue.add(
    "check-for-failed-jobs",
    {},
    {
        repeat: {
            every: 2 * 60 * 1000,
        },
    }
);

agentQueue.process("check-for-failed-jobs", async (job, done) => {
    try {
        const jobs = await agentQueue.getJobs(["failed"]);

        for (const job of jobs) {
            try {
                sendDiscordAdminAlert(
                    JSON.stringify({
                        message: `Job failed`,
                        job,
                    })
                );
            } catch (err) {
                console.log("Failed to send Discord admin alert", err);
            }
        }

        const pickNodeJobs = jobs.filter((job) => job.name === "pick-node");

        for (const job of pickNodeJobs) {
            const { runId } = job.data;

            const tasksDB = await db.getTasksDB();
            const { rows: runs } = await tasksDB.query(
                `SELECT user_id, flow_id, account_id FROM browserable.runs WHERE id = $1`,
                [runId]
            );
            const run = runs[0];
            const userId = run.user_id;
            const flowId = run.flow_id;
            const accountId = run.account_id;

            await endRun({
                runId,
                userId,
                accountId,
                error: "Pick node failed",
            });

            await job.remove();
        }

        const scheduledPickNodeJobs = jobs.filter(
            (job) => job.name === "schedule-pick-node"
        );

        for (const job of scheduledPickNodeJobs) {
            const { runId } = job.data;

            const tasksDB = await db.getTasksDB();
            const { rows: runs } = await tasksDB.query(
                `SELECT user_id, flow_id, account_id FROM browserable.runs WHERE id = $1`,
                [runId]
            );
            const run = runs[0];
            const userId = run.user_id;
            const flowId = run.flow_id;
            const accountId = run.account_id;

            await endRun({
                runId,
                userId,
                accountId,
                error: "Schedule pick node failed",
            });

            await job.remove();
        }

        // find all the jobs with name "task-creator-job"
        const agentInitJobs = jobs.filter((job) => job.name === "agent-init");
        // for each job, mark a flow as failed. move active to inactive, and remove the job
        for (const job of agentInitJobs) {
            const { runId } = job.data;

            const tasksDB = await db.getTasksDB();
            const { rows: runs } = await tasksDB.query(
                `SELECT user_id, flow_id, account_id FROM browserable.runs WHERE id = $1`,
                [runId]
            );
            const run = runs[0];
            const userId = run.user_id;
            const flowId = run.flow_id;
            const accountId = run.account_id;

            await endRun({
                runId,
                userId,
                accountId,
                error: "Agent initialization failed",
            });

            await job.remove();
        }

        // find all the jobs with name "node-looper"
        const nodeLooperJobs = jobs.filter((job) => job.name === "node-looper");
        for (const job of nodeLooperJobs) {
            const { runId } = job.data;

            const tasksDB = await db.getTasksDB();
            const { rows: runs } = await tasksDB.query(
                `SELECT user_id, flow_id, account_id FROM browserable.runs WHERE id = $1`,
                [runId]
            );
            const run = runs[0];
            const userId = run.user_id;
            const flowId = run.flow_id;
            const accountId = run.account_id;

            await endRun({
                runId,
                userId,
                accountId,
                error: "Node looper failed",
            });

            await job.remove();
        }

        // find all the jobs with name "run-action"
        const runActionJobs = jobs.filter((job) => job.name === "run-action");
        for (const job of runActionJobs) {
            const { runId } = job.data;

            const tasksDB = await db.getTasksDB();
            const { rows: runs } = await tasksDB.query(
                `SELECT user_id, flow_id, account_id FROM browserable.runs WHERE id = $1`,
                [runId]
            );
            const run = runs[0];
            const userId = run.user_id;
            const flowId = run.flow_id;
            const accountId = run.account_id;

            await endRun({
                runId,
                userId,
                accountId,
                error: "Run action failed",
            });

            await job.remove();
        }

        // find all jarvis-queue-job jobs
        const jarvisQueueJobs = jobs.filter(
            (job) => job.name === "jarvis-queue-job"
        );
        for (const job of jarvisQueueJobs) {
            const { functionArgs } = job.data;

            const { runId } = functionArgs;

            const tasksDB = await db.getTasksDB();
            const { rows: runs } = await tasksDB.query(
                `SELECT user_id, flow_id, account_id FROM browserable.runs WHERE id = $1`,
                [runId]
            );
            const run = runs[0];
            const userId = run.user_id;
            const flowId = run.flow_id;
            const accountId = run.account_id;

            await endRun({
                runId,
                userId,
                accountId,
                error: "Jarvis queue job failed",
            });

            await job.remove();
        }

        // find all the jobs with the name "end-node"
        const endNodeJobs = jobs.filter((job) => job.name === "end-node");
        for (const job of endNodeJobs) {
            const { runId, nodeId } = job.data;

            const tasksDB = await db.getTasksDB();
            const { rows: runs } = await tasksDB.query(
                `SELECT user_id, account_id FROM browserable.runs WHERE id = $1`,
                [runId]
            );
            const userId = runs[0].user_id;
            const accountId = runs[0].account_id;

            await endRun({
                runId,
                userId,
                accountId,
                error: "End node failed",
            });

            await job.remove();
        }
    } catch (err) {
        console.error("Error in check-for-failed-jobs", err);
        sendDiscordAdminAlert(
            JSON.stringify({
                heading: "Error in check-for-failed-jobs for agent queue",
                error: err.message,
                stack: err.stack,
            })
        );
    }
    done();
});

async function scheduleQueueJob({ code, functionToCall, functionArgs }) {
    await agentQueue.add(
        `jarvis-queue-job`,
        { code, functionToCall, functionArgs },
        { removeOnComplete: false, attempts: 2 }
    );
}

// schedule looper
async function scheduleAgentInit({
    runId,
    nodeId,
    input,
    threadId,
    accountId,
    agentCode,
    delay,
}) {
    await agentQueue.add(
        `agent-init`,
        {
            runId,
            nodeId,
            threadId,
            accountId,
            agentCode,
            input,
        },
        {
            delay: delay || 0,
            jobId: `${runId}-${nodeId}-agent-init`,
            removeOnComplete: true,
            attempts: 2,
        }
    );
}

// schedule an action for a node
async function scheduleAction({
    runId,
    nodeId,
    threadId,
    actionCode,
    actionId,
    aiData,
    delay,
    sync = false,
}) {
    if (!sync) {
        await agentQueue.add(
            `run-action`,
            {
                runId,
                nodeId,
                actionCode,
                actionId,
                aiData,
                threadId,
            },
            {
                delay: delay || 0,
                jobId: `${runId}-${nodeId}-run-action`,
                removeOnComplete: true,
                attempts: 2,
            }
        );
    } else {
        await runActionHelper({
            runId,
            nodeId,
            actionCode,
            threadId,
            actionId,
            aiData,
        });
    }
}

async function getThreadData({ runId, threadId }) {
    const tasksDB = await db.getTasksDB();
    const { rows: threads } = await tasksDB.query(
        `SELECT data FROM browserable.threads WHERE id = $1`,
        [threadId]
    );
    return threads[0].data;
}

async function updateThreadData({ runId, threadId, data }) {
    // get the current data
    const tasksDB = await db.getTasksDB();
    const { rows: threads } = await tasksDB.query(
        `SELECT data FROM browserable.threads WHERE id = $1`,
        [threadId]
    );
    const currentData = threads[0].data || {};

    // merge new data with current data
    const mergedData = { ...currentData, ...data };

    await tasksDB.query(
        `UPDATE browserable.threads SET data = $1 WHERE id = $2`,
        [JSON.stringify(mergedData), threadId]
    );
}

// create a run
async function createRun({
    runId,
    userId,
    accountId,
    flowId,
    input,
    triggerInput,
    delay,
    initMessage,
}) {
    runId = runId || generateUUID();

    const tasksDB = await db.getTasksDB();

    // get metadata of the flow of this run
    const { rows: flows } = await tasksDB.query(
        `SELECT metadata FROM browserable.flows WHERE id = $1`,
        [flowId]
    );
    const flowMetadata = flows[0].metadata;

    const { rows } = await tasksDB.query(
        `INSERT INTO browserable.runs (id, user_id, account_id, flow_id, input, trigger_input, created_at, status, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8) RETURNING *`,
        [
            runId,
            userId,
            accountId,
            flowId,
            input,
            triggerInput,
            new Date(),
            JSON.stringify(flowMetadata),
        ]
    );

    await updateRunUserLog({
        runId,
        messages: [
            {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: "Starting task.",
                        associatedData: [
                            {
                                type: "markdown",
                                markdown: input,
                                name: "Task",
                            },
                        ],
                    },
                ],
            },
        ],
    });

    await updateRunDebugLog({
        runId,
        messages: [
            {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: "Task started.",
                        associatedData: [
                            {
                                type: "markdown",
                                markdown: input,
                                name: "Task",
                            },
                        ],
                    },
                ],
            },
        ],
    });

    const run = rows[0];

    delay = delay || 0;

    const threadId = generateUUID();

    await tasksDB.query(
        `INSERT INTO browserable.threads (id, run_id, input, data, created_at) VALUES ($1, $2, $3, $4, $5)`,
        [
            threadId,
            runId,
            input,
            JSON.stringify({
                threadLevel: 1,
                ...flowMetadata,
                triggerInput,
            }),
            new Date(),
        ]
    );

    const newNodeId = await generateUUID();

    // insert this new node into the nodes table
    await tasksDB.query(
        `INSERT INTO browserable.nodes (id, run_id, agent_code, input, status, created_at, private_data, thread_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
            newNodeId,
            runId,
            "DECISION_NODE",
            input,
            "ready",
            new Date(),
            JSON.stringify({
                threadId,
                threadLevel: 1,
            }),
            threadId,
        ]
    );

    // schedule a job called "pick-node"
    await agentQueue.add(
        `pick-node`,
        {
            runId,
        },
        { removeOnComplete: true, jobId: `${runId}-pick-node`, attempts: 2 }
    );

    return run;
}

async function sendEmailToUser({ userId, subject, html, text }) {
    const tasksDB = await db.getTasksDB();

    const { rows } = await tasksDB.query(
        `SELECT email FROM browserable.users WHERE id = $1`,
        [userId]
    );

    const email = rows[0].email;

    await sendEmail({ email, subject, html, text });
}

async function errorAtNode({
    runId,
    nodeId,
    accountId,
    userId,
    threadId,
    error,
}) {
    await updateNodeStatus({
        runId,
        nodeId,
        status: "error",
        error,
    });

    // For now, if an error occurs at a node, we end the run as well.
    await endThread({
        runId,
        threadId,
        userId,
        accountId,
        error,
        status: "error",
    });
}

async function endThread({
    runId,
    threadId,
    userId,
    accountId,
    error,
    status,
}) {
    if (error) {
        // add this error to the thread user and debug logs
        await updateRunUserLog({
            runId,
            threadId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: `Error: ${error}`,
                        },
                    ],
                },
            ],
        });

        await updateRunDebugLog({
            runId,
            threadId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: `Error: ${error}`,
                        },
                    ],
                },
            ],
        });
    }

    const threadData = await getThreadData({ runId, threadId });

    // if there is browser session in thread, close it
    if (threadData.sessionId) {
        try {
            console.log(
                "DONE WITH SESSION 1",
                userId,
                accountId,
                threadData.eventId,
                threadData.sessionId
            );

            await doneWithSession({
                user_id: userId,
                account_id: accountId,
                eventId: threadData.eventId,
                sessionId: threadData.sessionId,
            });
        } catch (error) {
            console.log("Error closing browser session. Moving on.", error);
        }
    }

    if (status === "completed") {
        const tasksDB = await db.getTasksDB();

        // check if there are any nodes for this runId that are in 'ready' status
        const { rows: nodes } = await tasksDB.query(
            `SELECT id FROM browserable.nodes WHERE run_id = $1 AND status = 'ready'`,
            [runId]
        );

        if (nodes.length > 0) {
            // then we just schedule pick-node so that gets kicked off
            await agentQueue.add(
                `schedule-pick-node`,
                {
                    runId,
                },
                {
                    removeOnComplete: true,
                }
            );
            return;
        }

        // Looks like all threads are completed. so we close the shop now.
        await endRun({
            runId,
            userId,
            accountId,
            status: "completed",
        });
    } else if (status === "error") {
        // mark all the nodes that are not completed or error in the current thread as error.
        // then check if there are any ready nodes in the current run. if so, schedule a pick-node.
        // else end the run.
        const tasksDB = await db.getTasksDB();
        const { rows: nodes } = await tasksDB.query(
            `SELECT id FROM browserable.nodes WHERE run_id = $1 AND status != 'completed' AND status != 'error' AND thread_id = $2`,
            [runId, threadId]
        );

        for (const node of nodes) {
            await updateNodeStatus({
                runId,
                nodeId: node.id,
                status: "error",
            });
        }

        // check if there are any ready nodes in the current run. if so, schedule a pick-node.
        const { rows: readyNodes } = await tasksDB.query(
            `SELECT id FROM browserable.nodes WHERE run_id = $1 AND status = 'ready'`,
            [runId]
        );

        if (readyNodes.length > 0) {
            // schedule a pick-node
            await agentQueue.add(
                `schedule-pick-node`,
                {
                    runId,
                },
                { removeOnComplete: true }
            );
            return;
        }

        // else end the run.
        await endRun({
            runId,
            userId,
            accountId,
            status: "error",
        });
    }
}

async function endRun({ runId, userId, accountId, error, status }) {
    if (error) {
        status = "error";
    }

    const taskFailure = error || status == "error";

    const tasksDB = await db.getTasksDB();

    await updateRunUserLog({
        runId,
        messages: [
            {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: taskFailure ? `Task failed.` : `Task completed.`,
                    },
                ],
            },
        ],
    });

    await updateRunDebugLog({
        runId,
        messages: [
            {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: taskFailure ? `Task failed.` : `Task completed.`,
                        ...(error
                            ? {
                                  associatedData: [
                                      {
                                          type: "markdown",
                                          markdown: error,
                                          name: "Error",
                                      },
                                  ],
                              }
                            : {}),
                    },
                ],
            },
        ],
    });

    await updateRunStatus({
        runId,
        userId,
        accountId,
        status,
        error,
    });

    await updateRunLiveStatus({
        runId,
        liveStatus: "",
    });

    if (status === "completed" || status === "error") {
        // we need to decide if the flow status should be changed or not.
        // 1. check if the flow status is 'active' or 'inactive'
        // 2. if it is inactive, ignore
        // 3. if it is active, check the triggers of the flow
        // 4. reasons to keep the flow active (for now would be ---> if there's any crontab trigger OR if there's any event.every trigger)
        // 5. if there are such recurring triggers, then ignore. else change the flow status to 'inactive'

        const { rows: runs } = await tasksDB.query(
            `SELECT flow_id FROM browserable.runs WHERE id = $1 AND account_id = $2`,
            [runId, accountId]
        );
        const flowId = runs[0].flow_id;

        if (status === "completed") {
            // lets start a task job that creates a gif for this run
            await agentQueue.add(
                `create-gif`,
                {
                    runId,
                    flowId,
                    accountId,
                },
                { removeOnComplete: true }
            );
        }

        await turnOffFlowIfNoTriggers({ flowId, accountId, userId });
    }
}

async function askUserForInputAtRun({
    runId,
    threadId,
    nodeId,
    tool,
    userId,
    accountId,
}) {
    const toolCallId = generateUUID();

    await updateRunDebugLog({
        runId,
        threadId,
        nodeId,
        messages: [
            {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: "Tool call.",
                        associatedData: [
                            {
                                type: "code",
                                code: {
                                    tool,
                                },
                                name: "Tool",
                            },
                        ],
                    },
                ],
            },
        ],
    });

    await updateRunStatus({
        runId,
        status: "tool_call",
        error: null,
        output: null,
        reasoning: null,
        userId,
        accountId,
        input_wait: {
            tool,
            toolCallId,
            threadId,
            runId,
        },
    });
}

async function askUserForInputAtNode({ runId, nodeId, threadId, tool }) {
    await updateNodeDebugLog({
        runId,
        threadId,
        nodeId,
        messages: [
            {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: `Tool call`,
                        associatedData: [
                            {
                                type: "code",
                                code: {
                                    tool,
                                },
                                name: "Tool",
                            },
                        ],
                    },
                ],
            },
        ],
    });

    const toolCallId = generateUUID();
    await updateNodeStatus({
        runId,
        nodeId,
        status: "tool_call",
        error: null,
        output: null,
        reasoning: null,
        input_wait: {
            toolCallId,
            tool,
            threadId,
            nodeId,
            runId,
        },
    });
}

async function processUserInputForRun({
    runId,
    toolCallId,
    messages,
    userId,
    accountId,
}) {
    // confirm that the input wait id is correct
    const tasksDB = await db.getTasksDB();
    const { rows: runs } = await tasksDB.query(
        `SELECT input_wait FROM browserable.runs WHERE id = $1`,
        [runId]
    );
    const toolCall = runs[0].input_wait;
    if (toolCall && toolCall.toolCallId !== toolCallId) {
        // silent ignore.
        return;
    }

    const { threadId, nodeId } = toolCall;

    // strip off any metadata from the messages for agent log but keep it in user log
    const messagesWithoutMetadata = messages.map((message) => ({
        role: message.role || "user",
        content: message.content,
    }));

    await updateRunAgentLog({
        runId,
        threadId,
        messages: messagesWithoutMetadata,
    });

    await updateRunUserLog({
        runId,
        threadId,
        messages,
    });

    await updateRunDebugLog({
        runId,
        threadId,
        messages,
    });

    await updateRunStatus({
        runId,
        status: "running",
        error: null,
        output: null,
        reasoning: null,
        input_wait: null,
        userId,
        accountId,
    });

    // schedule a job called "pick-node"
    await agentQueue.add(
        `pick-node`,
        {
            runId,
            nodeId,
        },
        { removeOnComplete: true, jobId: `${runId}-pick-node`, attempts: 2 }
    );
}

async function communicateInformationToUserAtRun({
    runId,
    threadId,
    information,
}) {
    // add to userAgentLog
    await updateRunUserLog({
        runId,
        threadId,
        messages: [
            {
                role: "assistant",
                content: [
                    {
                        type: "markdown",
                        markdown: information,
                    },
                ],
            },
        ],
    });

    // update run log that information is communicated to user
    await updateRunAgentLog({
        runId,
        threadId,
        messages: [
            {
                role: "assistant",
                content: `Information communicated to user.`,
            },
        ],
    });

    // update run debug log
    await updateRunDebugLog({
        runId,
        threadId,
        messages: [
            {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: information,
                    },
                ],
            },
        ],
    });
}

async function communicateInformationToUserAtNode({
    runId,
    nodeId,
    information,
}) {
    await updateNodeUserLog({
        runId,
        nodeId,
        messages: [
            {
                role: "assistant",
                content: [
                    {
                        type: "markdown",
                        markdown: information,
                    },
                ],
            },
        ],
    });
}

async function addTriggerForNode({ runId, nodeId, triggerWait }) {
    const tasksDB = await db.getTasksDB();
    await tasksDB.query(
        `UPDATE browserable.nodes SET trigger_wait = $1 WHERE run_id = $2 AND id = $3`,
        [triggerWait, runId, nodeId]
    );
}

async function processTriggerForNode({
    runId,
    nodeId,
    triggerWaitId,
    triggerData,
}) {
    // confirm that the trigger wait id is correct
    const tasksDB = await db.getTasksDB();
    const { rows: nodes } = await tasksDB.query(
        `SELECT input, trigger_wait, thread_id FROM browserable.nodes WHERE id = $1`,
        [nodeId]
    );
    const node = nodes[0];
    if (node.trigger_wait && node.trigger_wait !== triggerWaitId) {
        // silent ignore.
        return;
    }

    await updateNodeStatus({
        runId,
        nodeId,
        status: "running",
        error: null,
        input_wait: null,
        trigger_wait: null,
    });

    // there should be an action in this node called processTrigger
    await scheduleAction({
        runId,
        nodeId,
        threadId: node.thread_id,
        actionCode: "process_trigger",
        actionId: generateUUID(),
        aiData: {
            triggerData,
        },
        delay: 0,
    });
}

async function processUserInputForNode({
    runId,
    nodeId,
    toolCallId,
    messages,
}) {
    // confirm that the input wait id is correct
    const tasksDB = await db.getTasksDB();
    const { rows: nodes } = await tasksDB.query(
        `SELECT input_wait, input, thread_id FROM browserable.nodes WHERE id = $1`,
        [nodeId]
    );
    const toolCall = nodes[0].input_wait;
    if (toolCall && toolCall.toolCallId !== toolCallId) {
        // silent ignore.
        return;
    }

    // strip off any metadata from the messages for agent log but keep it in user log
    const messagesWithoutMetadata = messages.map((message) => ({
        role: message.role || "user",
        content: message.content,
    }));

    await updateNodeAgentLog({
        runId,
        nodeId,
        messages: messagesWithoutMetadata,
        threadId: nodes[0].thread_id,
    });

    await updateNodeUserLog({
        runId,
        nodeId,
        threadId: nodes[0].thread_id,
        messages,
    });

    await updateNodeStatus({
        runId,
        nodeId,
        status: "running",
        error: null,
        input_wait: null,
    });

    await scheduleNodeLooper({
        runId,
        input: nodes[0].input,
        nodeId,
        delay: 0,
        threadId: nodes[0].thread_id,
        agentCode: nodes[0].agent_code,
    });
}

async function updateRunUserLog({ runId, messages, threadId }) {
    const tasksDB = await db.getTasksDB();

    // get flowId from runId in db
    const { rows: runs } = await tasksDB.query(
        `SELECT flow_id FROM browserable.runs WHERE id = $1`,
        [runId]
    );
    const flowId = runs[0].flow_id;

    await tasksDB.query(
        `INSERT INTO browserable.message_logs (run_id, flow_id, messages, segment, created_at, thread_id) VALUES ($1, $2, $3, $4, $5, $6)`,
        [runId, flowId, JSON.stringify(messages), "user", new Date(), threadId]
    );
}

async function updateRunAgentLog({ runId, messages, threadId }) {
    const tasksDB = await db.getTasksDB();

    // get flowId from runId in db
    const { rows: runs } = await tasksDB.query(
        `SELECT flow_id FROM browserable.runs WHERE id = $1`,
        [runId]
    );
    const flowId = runs[0].flow_id;

    await tasksDB.query(
        `INSERT INTO browserable.message_logs (run_id, flow_id, messages, segment, created_at, thread_id) VALUES ($1, $2, $3, $4, $5, $6)`,
        [runId, flowId, JSON.stringify(messages), "agent", new Date(), threadId]
    );
    await appendLogToFile({
        segment: "run_agent",
        runId,
        nodeId: null,
        threadId,
        messages,
    });
}

async function updateRunDebugLog({ runId, threadId, messages }) {
    const tasksDB = await db.getTasksDB();

    // get flowId from runId in db
    const { rows: runs } = await tasksDB.query(
        `SELECT flow_id FROM browserable.runs WHERE id = $1`,
        [runId]
    );
    const flowId = runs[0].flow_id;

    await tasksDB.query(
        `INSERT INTO browserable.message_logs (run_id, flow_id, messages, segment, created_at, thread_id) VALUES ($1, $2, $3, $4, $5, $6)`,
        [runId, flowId, JSON.stringify(messages), "debug", new Date(), threadId]
    );
    await appendLogToFile({
        segment: "run_debug",
        runId,
        nodeId: null,
        threadId,
        messages,
    });
}

async function updateNodeDebugLog({ runId, threadId, nodeId, messages }) {
    const tasksDB = await db.getTasksDB();

    // get flowId from runId in db
    const { rows: runs } = await tasksDB.query(
        `SELECT flow_id FROM browserable.runs WHERE id = $1`,
        [runId]
    );
    const flowId = runs[0].flow_id;

    await tasksDB.query(
        `INSERT INTO browserable.message_logs (node_id, run_id, flow_id, messages, segment, created_at, thread_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
            nodeId,
            runId,
            flowId,
            JSON.stringify(messages),
            "debug",
            new Date(),
            threadId,
        ]
    );
    await appendLogToFile({
        segment: "node_debug",
        runId,
        nodeId,
        threadId,
        messages,
    });
}

async function updateNodeAgentLog({ runId, threadId, nodeId, messages }) {
    const tasksDB = await db.getTasksDB();

    // get flowId from runId in db
    const { rows: runs } = await tasksDB.query(
        `SELECT flow_id FROM browserable.runs WHERE id = $1`,
        [runId]
    );
    const flowId = runs[0].flow_id;

    await tasksDB.query(
        `INSERT INTO browserable.message_logs (node_id, run_id, flow_id, messages, segment, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [nodeId, runId, flowId, JSON.stringify(messages), "agent", new Date()]
    );
    await appendLogToFile({
        segment: "node_agent",
        runId,
        nodeId,
        threadId,
        messages,
    });
}

async function updateNodeUserLog({ runId, threadId, nodeId, messages }) {
    const tasksDB = await db.getTasksDB();

    // get flowId from runId in db
    const { rows: runs } = await tasksDB.query(
        `SELECT flow_id FROM browserable.runs WHERE id = $1`,
        [runId]
    );
    const flowId = runs[0].flow_id;

    await tasksDB.query(
        `INSERT INTO browserable.message_logs (node_id, run_id, flow_id, messages, segment, created_at, thread_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
            nodeId,
            runId,
            flowId,
            JSON.stringify(messages),
            "user",
            new Date(),
            threadId,
        ]
    );
    await appendLogToFile({
        segment: "node_user",
        runId,
        nodeId,
        threadId,
        messages,
    });
}

async function updateFlowUserLog({ flowId, messages }) {
    const tasksDB = await db.getTasksDB();

    await tasksDB.query(
        `INSERT INTO browserable.message_logs (flow_id, messages, segment, created_at) VALUES ($1, $2, $3, $4)`,
        [flowId, JSON.stringify(messages), "user", new Date()]
    );
}

async function updateFlowAgentLog({ flowId, messages }) {
    const tasksDB = await db.getTasksDB();

    await tasksDB.query(
        `INSERT INTO browserable.message_logs (flow_id, messages, segment, created_at) VALUES ($1, $2, $3, $4)`,
        [flowId, JSON.stringify(messages), "agent", new Date()]
    );
}

async function updateFlowDebugLog({ flowId, messages }) {
    const tasksDB = await db.getTasksDB();

    await tasksDB.query(
        `INSERT INTO browserable.message_logs (flow_id, messages, segment, created_at) VALUES ($1, $2, $3, $4)`,
        [flowId, JSON.stringify(messages), "debug", new Date()]
    );
}

async function endNode({
    runId,
    nodeId,
    status,
    output,
    threadId,
    reasoning,
    sync = false,
    schemaStructuredOutput,
}) {
    if (sync) {
        await endNodeWorker({
            runId,
            nodeId,
            status,
            output,
            reasoning,
            schemaStructuredOutput,
        });
    } else {
        await agentQueue.add(
            `end-node`,
            {
                runId,
                nodeId,
                status,
                threadId,
                output,
                reasoning,
                schemaStructuredOutput,
            },
            {
                removeOnComplete: true,
                jobId: `${runId}-end-node-${nodeId}`,
                attempts: 2,
            }
        );
    }
}

async function endNodeWorker({
    runId,
    nodeId,
    status,
    output,
    reasoning,
    schemaStructuredOutput,
}) {
    const tasksDB = await db.getTasksDB();

    await updateNodeStatus({
        runId,
        nodeId,
        status,
    });

    const { rows: runs } = await tasksDB.query(
        `SELECT flow_id, account_id, user_id FROM browserable.runs WHERE id = $1`,
        [runId]
    );

    const run = runs[0];

    // get the node data
    const { rows: nodes } = await tasksDB.query(
        `SELECT input, agent_code, private_data, thread_id FROM browserable.nodes WHERE id = $1`,
        [nodeId]
    );
    const nodeData = nodes[0] || {};
    const threadId = nodeData.thread_id;

    // get the thread
    const { rows: threads } = await tasksDB.query(
        `SELECT * FROM browserable.threads WHERE id = $1`,
        [threadId]
    );
    const thread = threads[0] || {};

    const dtSchema = await getDataTableSchema({
        flowId: run.flow_id,
        accountId: run.account_id,
    });

    let learnedRows = [];
    let summary = "";
    let report = "";

    if (schemaStructuredOutput) {
        learnedRows = schemaStructuredOutput;
    } else {
        let outputData = [];

        // add a report key
        outputData.push({
            key: "report",
            type: "markdown",
            readableName: "Report",
            description:
                "Detailed findings of the agent in markdown format. Can be 1000+ words. Maintain a record of all the steps and decisions made by the agent related to the task. Make sure to include all the fields user mentioned in the task. There's no way report can be empty.",
        });

        // add a summary key
        outputData.push({
            key: "summary",
            type: "markdown",
            readableName: "Summary",
            description: "Short summary of the agent's work. 100 words max.",
        });

        outputData.push({
            key: "rows",
            type: `array of objects. Each object in the array should has following keys (and their values according to their description): 
${JSON.stringify(dtSchema, null, 2)}`,
            readableName: "Rows that user wants to see",
            description: "Rows that user wants from this task.",
        });

        const jsonSchema = z.object({
            outputGenerated: z.object({
                summary: z.string(),
                report: z.string(),
                rows: z.array(
                    z.object({
                        ...dtSchema
                            .map((x) => ({
                                [x.key]:
                                    x.type === "markdown"
                                        ? z.string()
                                        : x.type === "number"
                                        ? z.number()
                                        : x.type === "boolean"
                                        ? z.boolean()
                                        : x.type === "string"
                                        ? z.string()
                                        : z.string(),
                            }))
                            .reduce(
                                (acc, curr) => ({
                                    ...acc,
                                    ...curr,
                                }),
                                {}
                            ),
                    })
                ),
            }),
        });

        let structuredOutput = await createDetailedOutputForNode({
            runId,
            nodeId,
            input: nodeData.input,
            outputData,
            output,
            userId: run.user_id,
            useHistory: true,
            jsonSchema: zodResponseFormat(jsonSchema, "outputGenerated"),
        });

        if (structuredOutput && structuredOutput.summary) {
            summary = structuredOutput.summary;
        } else {
            summary = output;
        }

        if (structuredOutput && structuredOutput.report) {
            report = structuredOutput.report;
        } else {
            report = output;
        }

        learnedRows = structuredOutput.rows || [];
    }

    // save structured output in node's private_data
    let private_data = nodeData.private_data || {};
    private_data.structuredOutput = learnedRows;
    saveNodePrivateData({
        runId,
        nodeId,
        data: private_data,
    });

    const { shortlistedDocumentIds } = thread.data || {};

    if (shortlistedDocumentIds && shortlistedDocumentIds.length) {
        const shortlistedDocuments = await getDocumentsFromDataTableByIds({
            flowId: run.flow_id,
            accountId: run.account_id,
            ids: shortlistedDocumentIds,
        });

        // SPECIAL CASE IF THE AGENT CODE IS DEEPRESEARCH_AGENT
        // WHY THIS ISSUE?
        // DR AGENT GENERATES ~6K tokens output.
        // INCLUDING THAT + ORIGINAL DOCUMENT IN PROMPT IS EASY BUT GETTING THE UPDATES TO THE DOCUMENT IS A PAIN GIVEN THE 4K TOKEN LIMIT OF OPEN AI
        // IF USER IS USING LARGE MODELS, THEN IT IS BETTER BUT WE WANT TO KEEP THIS SOLUTION SCALABLE ACROSS LLMs.
        // FOR NOW, WE ASSUME DR, UPDATES THE WHOLE DOCUMENT. IN FUTURE, ONCE OPEN AI INCREASES THE RESPONSE LIMIT, WE CAN REMOVE THIS.
        let summaryOfUpdates = "";

        if (nodeData.agent_code === "DEEPRESEARCH_AGENT") {
            const parseLength = Math.min(
                learnedRows.length,
                shortlistedDocuments.length
            );

            for (let i = 0; i < parseLength; i++) {
                const row = learnedRows[i];
                const document = shortlistedDocuments[i];
                await updateDocumentInDataTable({
                    flowId: run.flow_id,
                    accountId: run.account_id,
                    rowId: document.rowId,
                    dtRow: Object.assign(document, row),
                });
                // We can improve this further by summarizing each value to 2-3 lines
                summaryOfUpdates += `Updated document ${document.id}:
Updated keys of the document: ${Object.keys(row).join(", ")}`;
            }
        } else {
            let { updatedDocuments, summaryOfUpdates: summaryOfUpdates2 } =
                await createUpdatesToDocuments({
                    userId: run.user_id,
                    accountId: run.account_id,
                    runId,
                    nodeId,
                    shortlistedDocuments,
                    learnedRows,
                    task: nodeData.input,
                    dtSchema,
                    flowId: run.flow_id,
                });

            if (updatedDocuments && updatedDocuments.length) {
                for (const updatedDocument of updatedDocuments) {
                    await updateDocumentInDataTable({
                        flowId: run.flow_id,
                        accountId: run.account_id,
                        rowId: updatedDocument.rowId,
                        dtRow: updatedDocument,
                    });
                }
            }

            summaryOfUpdates = summaryOfUpdates2;
        }

        await updateRunAgentLog({
            runId,
            threadId: nodeData.thread_id,
            messages: [
                {
                    role: "jarvis",
                    content: `${nodeData.agent_code} ended.
    
${nodeData.agent_code} summary:
${summary}
    
${summaryOfUpdates}`,
                },
            ],
        });
    } else {
        await updateRunAgentLog({
            runId,
            threadId: nodeData.thread_id,
            messages: [
                {
                    role: "jarvis",
                    content: `${nodeData.agent_code} ended.
    
${nodeData.agent_code} output:
${JSON.stringify(learnedRows, null, 2)}`,
                },
            ],
        });
    }

    // mark this node as completed
    await updateNodeStatus({
        runId,
        nodeId,
        status: "completed",
        error: "",
        input_wait: "",
        trigger_wait: "",
    });

    // add a decision node to the thread
    const newNodeId = await generateUUID();
    const { threadLevel = 1 } = private_data || {};

    // insert this new node into the nodes table
    await tasksDB.query(
        `INSERT INTO browserable.nodes (id, run_id, agent_code, input, status, created_at, private_data, thread_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
            newNodeId,
            runId,
            "DECISION_NODE",
            thread.input,
            "ready",
            new Date(),
            JSON.stringify({
                threadId: thread.id,
                threadLevel,
                parentNodeId: nodeId,
            }),
            thread.id,
        ]
    );

    // schedule a job called "pick-node"
    await agentQueue.add(
        `pick-node`,
        {
            runId,
            nodeId: newNodeId,
        },
        { removeOnComplete: true, jobId: `${runId}-pick-node`, attempts: 2 }
    );
}

async function decideAction({
    runId,
    nodeId,
    threadId,
    input,
    possibleActions,
    agentCode,
    customInstructions,
    models,
}) {
    // in users table there will be a settings column. settings.timezoneOffsetInSeconds is what we need
    const tasksDB = await db.getTasksDB();
    const { rows: users } = await tasksDB.query(
        `SELECT settings, name FROM browserable.users WHERE id in (select user_id from browserable.runs where id = $1)`,
        [runId]
    );
    const timezoneOffsetInSeconds =
        users[0]?.settings?.timezoneOffsetInSeconds || 0;
    const userName = users[0].name;

    // get data of this node
    const { rows: nodes } = await tasksDB.query(
        `SELECT data FROM browserable.nodes WHERE id = $1`,
        [nodeId]
    );
    const nodeData = nodes[0].data || {};

    const { rows: runs } = await tasksDB.query(
        `SELECT status, flow_id, account_id FROM browserable.runs WHERE id = $1`,
        [runId]
    );

    // get flow metadata
    let { rows: flowMetadata } = await tasksDB.query(
        `SELECT metadata FROM browserable.flows WHERE id = $1`,
        [runs[0].flow_id]
    );
    flowMetadata = flowMetadata[0].metadata || {};
    const { tools = [] } = flowMetadata;

    const { lastLimitMessages, lastImageMessage } =
        await convertMessageLogsToLLMFormat({
            run_id: runId,
            node_id: nodeId,
        });

    // thread here
    const { rows: threads } = await tasksDB.query(
        `SELECT * FROM browserable.threads WHERE id = $1`,
        [threadId]
    );

    if (!threads.length) {
        await endRun({
            runId,
            userId,
            accountId,
            error: "Thread not found",
        });
        return;
    }

    let thread = threads[0];

    const limitCheck = await checkLLMCallLimits({
        accountId: runs[0].account_id,
        flowId: runs[0].flow_id,
        runId,
        threadId,
        nodeId,
    });

    if (!limitCheck) {
        await endThread({
            runId,
            threadId,
            userId: runs[0].user_id,
            accountId: runs[0].account_id,
            error: "LLM call limit exceeded",
            status: "error",
        });
        return;
    }

    let { shortlistedDocumentIds = [] } = thread.data || {};

    let shortlistedDocuments = [];

    if (shortlistedDocumentIds.length) {
        shortlistedDocuments = await getDocumentsFromDataTableByIds({
            flowId: runs[0].flow_id,
            accountId: runs[0].account_id,
            ids: shortlistedDocumentIds,
        });
    }

    // get the dtSchema
    const dtSchema = await getDataTableSchema({
        flowId: runs[0].flow_id,
        accountId: runs[0].account_id,
    });

    const agent = agentMap[agentCode];

    const prompt = jarvisPrompts.buildDecideActionPrompt({
        agent,
        possibleActions,
        nodeData,
        lastLimitMessages,
        lastImageMessage,
        shortlistedDocuments,
        userName,
        timezoneOffsetInSeconds,
        customInstructions,
        input,
        dtSchema,
        tools,
    });

    const response = await callOpenAICompatibleLLMWithRetry({
        messages: [
            {
                role: "user",
                content: prompt,
            },
            ...(lastImageMessage ? [lastImageMessage] : []),
        ],
        models: models || [
            "gemini-2.5-flash",
            "deepseek-chat",
            "deepseek-reasoner",
            "gpt-4o",
            "claude-3-5-sonnet",
            "qwen-plus",
        ],
        max_tokens: 3000,
        metadata: {
            runId,
            nodeId,
            threadId,
            flowId: runs[0].flow_id,
            agentCode,
            accountId: runs[0].account_id,
            usecase: "agent_llm",
        },
        max_attempts: 4,
    });

    const { actionCode, aiData, reasoningForPickingAction, updatesToNodeData } =
        response;

    // make these updates to node data
    await updateNodeKeyVal({
        runId,
        nodeId,
        data: updatesToNodeData,
    });

    await updateNodeAgentLog({
        runId,
        nodeId,
        threadId,
        messages: [
            {
                role: "assistant",
                content: `Decided action: ${actionCode} with reasoning: ${reasoningForPickingAction} and args: ${JSON.stringify(
                    aiData,
                    null,
                    2
                )}`,
            },
        ],
    });

    return {
        actionCode,
        aiData,
    };
}

async function decideTaskDataTableOps({
    flowId,
    accountId,
    task,
    triggerInput,
    threadId,
    runId,
    nodeId,
    attempt = 0,
    dtSchema,
    logs = [],
    pageSize = 3,
    page = 1,
    filters = {},
    userName,
    timezoneOffsetInSeconds,
    availableAgentsString,
    parentNodeStructuredOutput = null,
    singleThreadMode,
}) {
    if (singleThreadMode) {
        // In single thread mode, each run adds one single new row to the results table.
        return {
            success: true,
            actionCode: "decided_to_add_or_update_rows",
            data: {
                rows: [
                    {
                        ...(dtSchema.length > 0
                            ? dtSchema
                                  .map(({ key }) => ({
                                      [key]: "",
                                  }))
                                  .reduce(
                                      (acc, curr) => ({ ...acc, ...curr }),
                                      {}
                                  )
                            : {}),
                        subTask: `${task}
    ${triggerInput ? `Trigger input: ${triggerInput}` : ""}`,
                    },
                ],
            },
        };
    }

    if (attempt > 5) {
        await updateNodeUserLog({
            runId,
            threadId,
            nodeId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: "Unable to analyze results table after multiple attempts.",
                        },
                    ],
                },
            ],
        });

        await updateNodeDebugLog({
            runId,
            threadId,
            nodeId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: "Maximum attempts reached for results table analysis",
                            associatedData: [
                                {
                                    type: "code",
                                    code: {
                                        attempts: attempt,
                                        task,
                                        triggerInput,
                                        filters,
                                        pageSize,
                                        page,
                                        logs,
                                        dtSchema,
                                    },
                                    name: "Analysis Failure Details",
                                },
                            ],
                        },
                    ],
                },
            ],
        });

        return {
            success: false,
            error: "Failed to decide what rows to add/update to results table",
        };
    }

    if (!dtSchema) {
        // There's no shortlisted document so far.
        // get the dtschema for this flow
        dtSchema = await getDataTableSchema({
            flowId,
            accountId,
        });

        // get 3 documents from results table
        const {
            documents: documentsFromDataTable,
            total: totalDocumentsFromDataTable,
        } = await getDocumentsFromDataTable({
            flowId,
            accountId,
            pageSize,
            page,
        });

        logs.push({
            type: "Total documents in results table",
            message: `${totalDocumentsFromDataTable}`,
        });

        logs.push({
            type: "Sample documents from results table",
            message: `${JSON.stringify(documentsFromDataTable, null, 2)}`,
        });
    } else {
        // get documents from results table by filter
        const {
            documents: documentsFromDataTable,
            total: totalDocumentsFromDataTable,
        } = await getDocumentsFromDataTableByFilter({
            flowId,
            accountId,
            filters,
            pageSize,
            page,
        });

        logs.push({
            type: "Documents from results table with filter picked.",
            message: `${JSON.stringify(
                {
                    documentsFromDataTable,
                    totalDocumentsFromDataTable,
                    pageSize,
                    page,
                    appliedFilters: filters,
                },
                null,
                2
            )}`,
        });
    }

    await updateNodeUserLog({
        runId,
        threadId,
        nodeId,
        messages: [
            {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: "Analyzing results table.",
                    },
                ],
            },
        ],
    });

    // create a dataTableSchemaPrompt
    const dataTableSchemaPrompt = jarvisPrompts.buildDataTableOpsPrompt({
        dtSchema,
        task,
        triggerInput,
        logs,
        userName,
        timezoneOffsetInSeconds,
        availableAgentsString,
        parentNodeStructuredOutput,
        singleThreadMode,
    });

    const response = await callOpenAICompatibleLLMWithRetry({
        messages: [
            {
                role: "user",
                content: dataTableSchemaPrompt,
            },
        ],
        models: [
            "gemini-2.5-flash",
            "deepseek-chat",
            "gpt-4o-mini",
            "claude-3-5-haiku",
            "qwen-plus",
        ],
        max_tokens: 4000,
        metadata: {
            runId,
            nodeId,
            flowId,
            threadId,
            accountId,
            usecase: "decide_task_data_table_ops",
        },
        max_attempts: 4,
    });

    const { actionCode, thinking, data } = response;

    await updateNodeUserLog({
        runId,
        threadId,
        nodeId,
        messages: [
            {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: thinking,
                    },
                ],
            },
        ],
    });

    await updateNodeDebugLog({
        runId,
        threadId,
        nodeId,
        messages: [
            {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: thinking,
                        associatedData: [
                            {
                                type: "code",
                                code: {
                                    actionCode,
                                    data,
                                    thinking,
                                },
                                name: "Results table analysis",
                            },
                        ],
                    },
                ],
            },
        ],
    });

    if (actionCode === "decided_to_add_or_update_rows") {
        return {
            success: true,
            actionCode,
            data,
        };
    } else if (actionCode === "need_more_info_from_data_table") {
        const { filters, pageSize, page } = data;
        // get documents from results table by filter
        // rerun this function
        return await decideTaskDataTableOps({
            flowId,
            accountId,
            task,
            threadId,
            runId,
            nodeId,
            attempt: attempt + 1,
            dtSchema,
            logs,
            pageSize,
            page,
            filters,
            userName,
            timezoneOffsetInSeconds,
            availableAgentsString,
            parentNodeStructuredOutput,
            singleThreadMode,
            dtSchema,
        });
    } else if (actionCode === "work_on_subtask_before_deciding") {
        return {
            success: true,
            actionCode,
            data,
            thinking,
        };
    } else {
        return {
            success: false,
            error: `Unknown action code while deciding what to do with results table: ${actionCode}`,
        };
    }
}

async function convertMessageLogsToLLMFormat({
    segment = "agent",
    run_id,
    node_id,
    thread_id,
    limit = 15,
}) {
    const tasksDB = await db.getTasksDB();

    let messageLogs = [];

    if (run_id && node_id && !thread_id) {
        let { rows } = await tasksDB.query(
            `SELECT messages, created_at FROM browserable.message_logs WHERE run_id = $1 AND node_id = $2 AND segment = $3 ORDER BY created_at DESC LIMIT $4`,
            [run_id, node_id, segment, limit]
        );

        messageLogs = rows;
    } else if (run_id && thread_id && !node_id) {
        let { rows } = await tasksDB.query(
            `SELECT messages, created_at FROM browserable.message_logs WHERE run_id = $1 AND thread_id = $2 AND segment = $3 ORDER BY created_at DESC LIMIT $4`,
            [run_id, thread_id, segment, limit]
        );

        messageLogs = rows;
    }

    messageLogs = messageLogs.sort(
        (a, b) =>
            new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

    let agentLog = [];
    for (const messageLog of messageLogs) {
        agentLog.push(...messageLog.messages);
    }

    // get only last limit messages from agent log
    let lastLimitMessages = agentLog.slice(-1 * limit);
    let lastImageMessage = null;

    const isImage = (message) => {
        return (
            message.type === "image_url" ||
            message.type === "image" ||
            (message.content.length > 0 &&
                message.content[0].type === "image_url")
        );
    };
    // if last message is an image element, then keep it as a separate element
    if (
        lastLimitMessages.length > 0 &&
        isImage(lastLimitMessages[lastLimitMessages.length - 1])
    ) {
        lastImageMessage = lastLimitMessages[lastLimitMessages.length - 1];
        lastLimitMessages = lastLimitMessages.slice(0, -1);
    }
    // remove any image messages from the last limit messages
    lastLimitMessages = lastLimitMessages.filter(
        (message) => !isImage(message)
    );

    // if user type is "jarvis", change it to "user"
    lastLimitMessages = lastLimitMessages.map((message) => {
        if (message.role === "jarvis") {
            message.role = "assistant";
        }
        return message;
    });
    if (lastImageMessage) {
        if (lastImageMessage.role === "jarvis") {
            lastImageMessage.role = "user";
        }
        if (isImage(lastImageMessage)) {
            if (!lastImageMessage.content[0].image_url) {
                lastImageMessage = null;
            }
        }
    }

    return {
        lastLimitMessages,
        lastImageMessage,
    };
}

async function decideAgent({ runId, preferredNodeId }) {
    try {
        const tasksDB = await db.getTasksDB();

        // if the status of the run is not running, then return
        const { rows: existingRuns } = await tasksDB.query(
            `SELECT * FROM browserable.runs WHERE id = $1`,
            [runId]
        );

        if (existingRuns.length === 0) {
            // shouldn't have happened.
            return;
        }

        const run = existingRuns[0];

        if (
            run.status === "completed" ||
            run.status === "error" ||
            run.status === "tool_call"
        ) {
            return;
        }

        // get the flow metadata
        let flowMetadata = {};
        const { rows: flowMetadataRows } = await tasksDB.query(
            `SELECT metadata FROM browserable.flows WHERE id = $1`,
            [run.flow_id]
        );
        if (flowMetadataRows.length > 0) {
            flowMetadata = flowMetadataRows[0].metadata;
        }

        const tools = flowMetadata.tools || [];

        const singleThreadMode =
            !!flowMetadata.agent_codes.includes("DEEPRESEARCH_AGENT");

        // in users table there will be a settings column. settings.timezoneOffsetInSeconds is what we need
        const { rows: users } = await tasksDB.query(
            `SELECT settings, name, id, email FROM browserable.users WHERE id in (select user_id from browserable.runs where id = $1)`,
            [runId]
        );

        if (users.length === 0) {
            // shouldn't have happened.
            return;
        }

        const user = users[0];

        await updateRunStatus({
            runId,
            status: "running",
            error: null,
            output: null,
            reasoning: null,
            userId: user.id,
            accountId: run.account_id,
        });

        const timezoneOffsetInSeconds =
            user?.settings?.timezoneOffsetInSeconds || 0;
        const userName = user.name;
        const user_id = user.id;
        const email = user.email;

        let node = null;
        let nodeId;

        if (!preferredNodeId) {
            // get the next node that is ready
            const { rows: nodes } = await tasksDB.query(
                `SELECT * FROM browserable.nodes WHERE run_id = $1 AND status = 'ready' ORDER BY private_data->>'threadLevel' ASC, created_at ASC LIMIT 1`,
                [runId]
            );

            if (nodes.length === 0) {
                // shouldn't have happened.
                await endRun({
                    runId,
                    userId: user_id,
                    accountId: run.account_id,
                    error: "Unknown error. No ready nodes found.",
                    status: "error",
                });

                return;
            }

            node = nodes[0];
            nodeId = node.id;
        } else {
            // get the node by id
            const { rows: nodes } = await tasksDB.query(
                `SELECT * FROM browserable.nodes WHERE id = $1`,
                [preferredNodeId]
            );

            if (nodes.length === 0) {
                // shouldn't have happened.
                // end thread
                await endThread({
                    runId,
                    threadId: node.thread_id,
                    userId: user_id,
                    accountId: run.account_id,
                    error: "Unknown error. Node not found.",
                    status: "error",
                });

                return;
            } else if (
                nodes[0].status === "completed" ||
                nodes[0].status === "error"
            ) {
                // end thread
                await endThread({
                    runId,
                    threadId: node.thread_id,
                    userId: user_id,
                    accountId: run.account_id,
                    error: "Unknown error. Node is completed or error.",
                    status: "error",
                });

                return;
            }

            node = nodes[0];
            nodeId = node.id;
        }

        // update run's private_data that we are working on this node
        await upsertRunPrivateData({
            runId,
            data: {
                workingOnNodeId: nodeId,
            },
        });

        const threadId = node.thread_id;

        // get the thread
        const { rows: threads } = await tasksDB.query(
            `SELECT * FROM browserable.threads WHERE id = $1 and run_id = $2`,
            [threadId, runId]
        );

        if (threads.length === 0) {
            // shouldn't have happened.
            // end run
            await endRun({
                runId,
                userId: user_id,
                accountId: run.account_id,
                error: "Unknown error. Thread not found.",
            });

            return;
        }

        const thread = threads[0];

        const limitCheck = await checkLLMCallLimits({
            accountId: run.account_id,
            flowId: run.flow_id,
            runId,
            threadId,
            nodeId,
        });

        if (!limitCheck) {
            await endThread({
                runId,
                threadId,
                userId: user_id,
                accountId: run.account_id,
                error: "LLM call limit exceeded",
                status: "error",
            });
            return;
        }

        const { availableAgents, availableAgentsString } =
            await getAvailableAgentsForUser({
                user_id,
                runId,
                account_id: run.account_id,
                threadId,
            });

        const agentOfNode = node.agent_code;

        if (!agentOfNode) {
            // shouldn't have happened.
            // end thread
            await endThread({
                runId,
                threadId,
                userId: user_id,
                accountId: run.account_id,
                error: "Unknown error. Agent of node not found.",
            });

            return;
        }

        const dataOfThread = thread.data;
        const { triggerInput } = dataOfThread;
        const parentNodeId = node.id;
        const parentThreadLevel = dataOfThread.threadLevel;

        if (agentOfNode === "DECISION_NODE") {
            let parentOfCurrentNodeId = node.private_data?.parentNodeId;
            let parentNodeStructuredOutput = null;
            let parentNodePrivateData = null;
            let parentNodeAgentCode = null;
            if (parentOfCurrentNodeId) {
                const { rows: parentNodes } = await tasksDB.query(
                    `SELECT private_data, agent_code FROM browserable.nodes WHERE id = $1`,
                    [parentOfCurrentNodeId]
                );
                if (parentNodes.length > 0) {
                    parentNodeStructuredOutput =
                        parentNodes[0].private_data?.structuredOutput;
                    parentNodePrivateData = parentNodes[0].private_data || {};
                    parentNodeAgentCode = parentNodes[0].agent_code || null;
                }
            }

            const isDocumentShortlisted =
                dataOfThread.shortlistedDocumentIds &&
                dataOfThread.shortlistedDocumentIds.length > 0;
            const taskInput = thread.input || "";
            const hasCloseCondition =
                /close condition/i.test(taskInput) ||
                /do this only once/i.test(taskInput);
            const browserTaskCompleted =
                parentNodeAgentCode === "BROWSER_AGENT" &&
                parentNodePrivateData?.browser_task_completed === true;

            if (hasCloseCondition && browserTaskCompleted) {
                await updateNodeStatus({
                    runId,
                    nodeId: node.id,
                    status: "completed",
                    input_wait: null,
                    trigger_wait: null,
                });

                await endThread({
                    runId,
                    threadId,
                    userId: user_id,
                    accountId: run.account_id,
                    error: null,
                    status: "completed",
                });
                return;
            }

            await updateNodeStatus({
                runId,
                nodeId: node.id,
                status: "Analyzing the task and deciding next steps.",
                input_wait: null,
                trigger_wait: null,
            });

            await updateNodeDebugLog({
                runId,
                threadId,
                nodeId: node.id,
                messages: [
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: `Analyzing the task and deciding next steps.`,
                                associatedData: [
                                    {
                                        type: "code",
                                        code: {
                                            threadLevel: parentThreadLevel,
                                            input: thread.input,
                                            triggerInput:
                                                triggerInput || "None",
                                            hasShortlistedDocuments:
                                                isDocumentShortlisted
                                                    ? "Yes"
                                                    : "No",
                                        },
                                        name: "Inputs",
                                    },
                                ],
                            },
                        ],
                    },
                ],
            });

            const decideNextNodePostDocument = async ({
                shortlistedDocument,
                shortlistedDocumentIds,
                shortlistedDocuments,
            }) => {
                await updateNodeStatus({
                    runId,
                    nodeId: node.id,
                    status: shortlistedDocument
                        ? "Analyzing the selected row and determining next steps."
                        : "Analyzing the task and determining next steps.",
                    input_wait: null,
                    trigger_wait: null,
                });

                await updateNodeDebugLog({
                    runId,
                    threadId,
                    nodeId: node.id,
                    messages: [
                        {
                            role: "assistant",
                            content: [
                                {
                                    type: "text",
                                    text: `Determining next steps.`,
                                    associatedData: [
                                        {
                                            type: "code",
                                            code: {
                                                documentContext:
                                                    shortlistedDocument
                                                        ? "Using specific document"
                                                        : "No specific document",
                                                documentId: shortlistedDocument
                                                    ? shortlistedDocument.rowId
                                                    : "",
                                                availableAgents,
                                            },
                                            name: "Inputs",
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                });

                const { lastLimitMessages, lastImageMessage } =
                    await convertMessageLogsToLLMFormat({
                        run_id: runId,
                        thread_id: threadId,
                        limit: 15,
                    });

                const prompt = jarvisPrompts.buildDecideAgentPrompt({
                    availableAgents,
                    input: thread.input,
                    triggerInput,
                    shortlistedDocument,
                    lastLimitMessages,
                    lastImageMessage,
                    userName,
                    email,
                    timezoneOffsetInSeconds,
                    tools,
                });

                const response = await callOpenAICompatibleLLMWithRetry({
                    messages: [
                        {
                            role: "user",
                            content: prompt,
                        },
                        ...(lastImageMessage ? [lastImageMessage] : []),
                    ],
                    models: [
                        "gemini-2.5-flash",
                        "deepseek-chat",
                        "deepseek-reasoner",
                        "gpt-4o",
                        "claude-3-5-sonnet",
                        "qwen-plus",
                    ],
                    max_tokens: 3000,
                    metadata: {
                        runId,
                        flowId: run.flow_id,
                        threadId,
                        usecase: "delegator_agent",
                        accountId: run.account_id,
                    },
                    max_attempts: 5,
                });

                const {
                    agentCode,
                    aiData,
                    reasoningForPickingAgent,
                    summaryOfEverythingHappenedSoFar,
                } = response;

                if (agentCode === "end") {
                    // update the current node's status as complete since it's job is done
                    await updateNodeStatus({
                        runId,
                        nodeId: node.id,
                        status: "completed",
                        input_wait: null,
                        trigger_wait: null,
                    });

                    await endThread({
                        runId,
                        threadId,
                        userId: user_id,
                        accountId: run.account_id,
                        error: null,
                        status: "completed",
                    });

                    return;
                } else if (agentCode === "error") {
                    await endThread({
                        runId,
                        threadId,
                        userId: user_id,
                        accountId: run.account_id,
                        error: aiData.error,
                        status: "error",
                    });
                    return;
                } else if (availableAgents[agentCode]) {
                    await updateNodeDebugLog({
                        runId,
                        threadId,
                        nodeId: node.id,
                        messages: [
                            {
                                role: "assistant",
                                content: [
                                    {
                                        type: "text",
                                        text: "Decided on an agent.",
                                        associatedData: [
                                            {
                                                type: "code",
                                                code: response,
                                                name: "Agent Decision Process Output",
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                    });

                    const { task } = aiData;

                    await updateRunAgentLog({
                        runId,
                        threadId,
                        messages: [
                            {
                                role: "assistant",
                                content: `

**Summary of everything happened so far before picking the agent**
${summaryOfEverythingHappenedSoFar}
                        
Decided agent: ${agentCode}

**Reasoning for picking this agent**
${reasoningForPickingAgent}

**Task for this agent**
${task}

**Args for this agent**
\`\`\`json
${JSON.stringify(aiData, null, 2)}
\`\`\`
`,
                            },
                        ],
                    });

                    // update the current node's status as complete since it's job is done
                    await updateNodeStatus({
                        runId,
                        nodeId: node.id,
                        status: "completed",
                        input_wait: null,
                        trigger_wait: null,
                    });

                    const newNodeId = await generateUUID();
                    let newTask = `${task}`;

                    Object.keys(aiData).forEach((key) => {
                        if (key !== "task") {
                            newTask += `\n${key}: ${aiData[key]}`;
                        }
                    });

                    await tasksDB.query(
                        `INSERT INTO browserable.nodes (id, run_id, agent_code, input, status, created_at, private_data, thread_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                        [
                            newNodeId,
                            runId,
                            agentCode,
                            newTask,
                            "ready",
                            new Date(),
                            JSON.stringify({
                                aiData,
                                threadId,
                                parentNodeId,
                                threadLevel: parentThreadLevel,
                                shortlistedDocumentIds,
                                shortlistedDocuments,
                            }),
                            threadId,
                        ]
                    );

                    // schedule pick-node again
                    await agentQueue.add(
                        `schedule-pick-node`,
                        {
                            runId,
                        },
                        {
                            removeOnComplete: true,
                        }
                    );
                    return;
                } else if (
                    tools &&
                    tools.length > 0 &&
                    tools.filter(
                        (x) =>
                            x.type === "function" &&
                            x.function.name === agentCode
                    ).length > 0
                ) {
                    let toolInput = aiData.parameters || aiData;

                    await updateRunAgentLog({
                        runId,
                        threadId,
                        messages: [
                            {
                                role: "assistant",
                                content: `Decided to use tool: ${agentCode} with following input: ${JSON.stringify(
                                    toolInput,
                                    null,
                                    2
                                )}`,
                            },
                        ],
                    });

                    await askUserForInputAtRun({
                        runId,
                        threadId,
                        nodeId: node.id,
                        tool: {
                            name: agentCode,
                            parameters: toolInput,
                        },
                        userId: user_id,
                        accountId: run.account_id,
                    });

                    return;
                } else {
                    await endThread({
                        runId,
                        threadId,
                        userId: user_id,
                        accountId: run.account_id,
                        error: "Unknown error. Invalid agent code.",
                        status: "error",
                    });

                    return;
                }
            };

            if (isDocumentShortlisted) {
                // for now we only send one document
                const shortlistedDocumentId =
                    dataOfThread.shortlistedDocumentIds[0];

                const shortlistedDocuments =
                    await getDocumentsFromDataTableByIds({
                        flowId: run.flow_id,
                        accountId: run.account_id,
                        ids: [shortlistedDocumentId],
                    });

                if (
                    !shortlistedDocuments ||
                    shortlistedDocuments.length === 0
                ) {
                    // shouldn't have happened.
                    // end thread
                    await endThread({
                        runId,
                        threadId,
                        userId: user_id,
                        accountId: run.account_id,
                        error: "Unknown error. Shortlisted document not found.",
                    });

                    return;
                }

                const shortlistedDocument = shortlistedDocuments[0];

                await decideNextNodePostDocument({
                    shortlistedDocument,
                    shortlistedDocumentIds: dataOfThread.shortlistedDocumentIds,
                    shortlistedDocuments,
                });
                return;
            } else {
                const dtSchema = await getDataTableSchema({
                    flowId: run.flow_id,
                    accountId: run.account_id,
                });

                const { success, actionCode, data, error } =
                    await decideTaskDataTableOps({
                        flowId: run.flow_id,
                        accountId: run.account_id,
                        task: node.input,
                        triggerInput,
                        runId,
                        nodeId: node.id,
                        userName,
                        timezoneOffsetInSeconds,
                        availableAgentsString,
                        parentNodeStructuredOutput,
                        singleThreadMode,
                        dtSchema,
                    });

                if (!success) {
                    await endThread({
                        runId,
                        threadId,
                        userId: user_id,
                        accountId: run.account_id,
                        error,
                        status: "errror",
                    });
                    return;
                } else if (actionCode === "work_on_subtask_before_deciding") {
                    const { subTask, agentCode, aiData } = data;

                    // add a nodeuser log for the subtask
                    await updateNodeUserLog({
                        runId,
                        threadId,
                        nodeId: node.id,
                        messages: [
                            {
                                role: "assistant",
                                content: `Decided to work on subtask: ${subTask}`,
                            },
                        ],
                    });

                    await updateNodeDebugLog({
                        runId,
                        threadId,
                        nodeId: node.id,
                        messages: [
                            {
                                role: "assistant",
                                content: [
                                    {
                                        type: "text",
                                        text: `Decided to work on subtask: ${subTask}`,
                                        associatedData: [
                                            {
                                                type: "code",
                                                code: data,
                                                name: "AI Data",
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                    });

                    // mark the current node as completed
                    await updateNodeStatus({
                        runId,
                        nodeId: node.id,
                        status: "completed",
                        input_wait: null,
                        trigger_wait: null,
                    });

                    const newNodeId = await generateUUID();
                    // schedule a new node for this subtask
                    await tasksDB.query(
                        `INSERT INTO browserable.nodes (id, run_id, thread_id, agent_code, input, status, created_at, private_data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                        [
                            newNodeId,
                            runId,
                            threadId,
                            agentCode,
                            subTask,
                            "ready",
                            new Date(),
                            JSON.stringify({
                                threadId,
                                parentNodeId,
                                threadLevel: parentThreadLevel,
                                shortlistedDocumentIds: [],
                                shortlistedDocuments: [],
                                aiData,
                            }),
                        ]
                    );

                    // schedule pick-node again
                    await agentQueue.add(
                        `schedule-pick-node`,
                        {
                            runId,
                        },
                        {
                            removeOnComplete: true,
                        }
                    );

                    return;
                } else if (actionCode === "decided_to_add_or_update_rows") {
                    let documents = [];

                    let documentsWithSubtasks = [];

                    if (actionCode === "decided_to_add_or_update_rows") {
                        const { rows } = data;
                        const rowsToAdd = rows.filter((row) => !row.rowId);
                        const rowsToUpdate = rows.filter((row) => row.rowId);

                        for (const row of rowsToAdd) {
                            const subtask = row.subTask;
                            // remove subtask from row
                            const { subtask: _, ...rest } = row;
                            // add document to datatable
                            const [addedDocument] =
                                await addDocumentsToDataTable({
                                    flowId: run.flow_id,
                                    accountId: run.account_id,
                                    dtRows: [rest],
                                });

                            if (subtask) {
                                documentsWithSubtasks.push({
                                    document: addedDocument,
                                    subtask,
                                });
                            }

                            documents.push(addedDocument);
                        }

                        for (const row of rowsToUpdate) {
                            const subtask = row.subTask;
                            // remove subtask from row
                            const { subtask: _, ...rest } = row;
                            // update document in datatable
                            await updateDocumentInDataTable({
                                flowId: run.flow_id,
                                accountId: run.account_id,
                                dtRow: rest,
                                rowId: row.rowId,
                            });

                            const [updatedDocument] =
                                await getDocumentsFromDataTableByIds({
                                    flowId: run.flow_id,
                                    accountId: run.account_id,
                                    ids: [row.rowId],
                                });

                            if (subtask) {
                                documentsWithSubtasks.push({
                                    document: updatedDocument,
                                    subtask,
                                });
                            }

                            documents.push(updatedDocument);
                        }
                    }

                    // first check how many new documents are there.
                    if (documentsWithSubtasks.length === 0) {
                        if (documents.length > 0) {
                            // it updated multiple documents. no more sub tasks required. we are good here.
                            // update the thread data with the new documents
                            // and move to the next node
                            await updateThreadData({
                                runId,
                                threadId,
                                data: {
                                    shortlistedDocumentIds: documents.map(
                                        (document) => document.rowId
                                    ),
                                    shortlistedDocuments: documents,
                                },
                            });
                            await decideNextNodePostDocument({
                                shortlistedDocument: null,
                                shortlistedDocumentIds: documents.map(
                                    (document) => document.rowId
                                ),
                                shortlistedDocuments: documents,
                            });
                            return;
                        } else {
                            // for now we move to the next node
                            await decideNextNodePostDocument({
                                shortlistedDocument: null,
                                shortlistedDocumentIds: [],
                                shortlistedDocuments: [],
                            });
                            return;
                        }
                    } else if (documentsWithSubtasks.length === 1) {
                        // we can continue within the same thread.
                        // just need to attach the shortlisted document id to the thread. and run pick-node again.
                        await updateThreadData({
                            runId,
                            threadId,
                            data: {
                                shortlistedDocumentIds: [
                                    documentsWithSubtasks[0].document.rowId,
                                ],
                                shortlistedDocuments: [
                                    documentsWithSubtasks[0].document,
                                ],
                            },
                        });

                        await updateNodeUserLog({
                            runId,
                            threadId,
                            nodeId: node.id,
                            messages: [
                                {
                                    role: "assistant",
                                    content: [
                                        {
                                            type: "text",
                                            text: "Shortlisted one row to work on.",
                                        },
                                    ],
                                },
                            ],
                        });

                        await updateNodeDebugLog({
                            runId,
                            threadId,
                            nodeId: node.id,
                            messages: [
                                {
                                    role: "assistant",
                                    content: [
                                        {
                                            type: "text",
                                            text: "Shortlisted one row to work on.",
                                            associatedData: [
                                                {
                                                    type: "code",
                                                    code: {
                                                        ...documentsWithSubtasks[0]
                                                            .document,
                                                        subtask:
                                                            documentsWithSubtasks[0]
                                                                .subtask,
                                                    },
                                                    name: "Shortlisted document",
                                                },
                                            ],
                                        },
                                    ],
                                },
                            ],
                        });

                        await agentQueue.add(
                            `schedule-pick-node`,
                            {
                                runId,
                                nodeId,
                            },
                            {
                                removeOnComplete: true,
                            }
                        );
                        return;
                    } else {
                        const documentIds = documentsWithSubtasks.map(
                            (documentWithSubtask) =>
                                documentWithSubtask.document.rowId
                        );

                        // mark the current node as completed
                        await updateNodeStatus({
                            runId,
                            nodeId: node.id,
                            status: "completed",
                            input_wait: null,
                            trigger_wait: null,
                        });

                        await updateNodeUserLog({
                            runId,
                            threadId,
                            nodeId: node.id,
                            messages: [
                                {
                                    role: "assistant",
                                    content: [
                                        {
                                            type: "text",
                                            text: "Decided to work on multiple rows.",
                                        },
                                    ],
                                },
                            ],
                        });

                        await updateNodeDebugLog({
                            runId,
                            threadId,
                            nodeId: node.id,
                            messages: [
                                {
                                    role: "assistant",
                                    content: [
                                        {
                                            type: "text",
                                            text: "Decided to work on multiple rows.",
                                            associatedData: [
                                                {
                                                    type: "code",
                                                    code: {
                                                        ...documentsWithSubtasks,
                                                    },
                                                    name: "Rows",
                                                },
                                            ],
                                        },
                                    ],
                                },
                            ],
                        });

                        for (let i = 0; i < documentsWithSubtasks.length; i++) {
                            const subtask = documentsWithSubtasks[i].subtask;
                            const document = documentsWithSubtasks[i].document;
                            const documentId = document.rowId;
                            const newThreadId = await generateUUID();
                            const newNodeId = await generateUUID();

                            // Calculate number of decimal places in parent thread level
                            const decimalPlaces =
                                parentThreadLevel.toString().split(".")[1]
                                    ?.length || 0;

                            // Calculate new thread level by adding i+1 at the next decimal place
                            const newThreadLevel = (i) =>
                                parentThreadLevel +
                                (i + 1) / Math.pow(10, decimalPlaces + 1);

                            await tasksDB.query(
                                `INSERT INTO browserable.threads (id, run_id, input, data, created_at) VALUES ($1, $2, $3, $4, $5)`,
                                [
                                    newThreadId,
                                    runId,
                                    subtask,
                                    JSON.stringify({
                                        threadLevel: newThreadLevel(i),
                                        shortlistedDocumentIds: [documentId],
                                        shortlistedDocuments: [document],
                                        agent_codes: thread.data.agent_codes,
                                    }),
                                    new Date(),
                                ]
                            );

                            // schedule a new node for this subtask
                            await tasksDB.query(
                                `INSERT INTO browserable.nodes (id, run_id, thread_id, agent_code, input, status, created_at, private_data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                                [
                                    newNodeId,
                                    runId,
                                    newThreadId,
                                    "DECISION_NODE",
                                    subtask,
                                    "ready",
                                    new Date(),
                                    JSON.stringify({
                                        threadId: newThreadId,
                                        parentNodeId,
                                        threadLevel: newThreadLevel(i),
                                        shortlistedDocumentIds: [documentId],
                                        shortlistedDocuments: [document],
                                    }),
                                ]
                            );
                        }

                        // this thread came to a closure. this will spawn more things but this thread in itself is done.
                        await endThread({
                            runId,
                            threadId,
                            userId: user_id,
                            accountId: run.account_id,
                            status: "completed",
                        });

                        return;
                    }
                } else {
                    await endThread({
                        runId,
                        threadId,
                        userId: user_id,
                        accountId: run.account_id,
                        error: "Unknown error. DT action not found.",
                        status: "error",
                    });
                    return;
                }
                return;
            }
            return;
        }

        if (!availableAgents[agentOfNode]) {
            // shouldn't have happened.
            // end run
            await endThread({
                runId,
                threadId,
                userId: user_id,
                accountId: run.account_id,
                error: "Unknown error. Agent not found.",
                status: "error",
            });

            return;
        }

        // The node we picked is not a decision node.

        // update the node status to running
        await updateNodeStatus({
            runId,
            nodeId: node.id,
            status: "running",
            input_wait: null,
            trigger_wait: null,
        });

        await scheduleAgentInit({
            runId,
            nodeId: node.id,
            input: node.input,
            accountId: run.account_id,
            threadId,
            agentCode: agentOfNode,
            delay: 0,
        });
    } catch (err) {
        console.error("Error in decideAgent", err);

        // send admin discord alert
        sendDiscordAdminAlert(
            JSON.stringify(
                {
                    header: "Flow failed to decide agent",
                    body: { runId, err },
                },
                null,
                2
            )
        );

        const tasksDB = await db.getTasksDB();

        const { rows: runs } = await tasksDB.query(
            `SELECT user_id, account_id FROM browserable.runs WHERE id = $1`,
            [runId]
        );
        const user_id = runs[0].user_id;
        const accountId = runs[0].account_id;

        console.error("Error in decideAgent", err);
        // mark this run as failed
        await endRun({
            runId,
            userId: user_id,
            accountId,
            error: `Unknown error. Error in deciding which agent to run. ${err.message}`,
        });
    }
}

agentQueue.process("create-gif", async (job, done) => {
    const { runId, flowId, accountId } = job.data;
    const { success, error, gifUrl } = await createGifFromMessageLogs({
        runId,
        flowId,
        accountId,
    });

    if (success && gifUrl) {
        // update the gifUrl in the private data of this run
        await upsertRunPrivateData({
            runId,
            data: {
                gifUrl
            }
        });
    }
    done();
});

agentQueue.process("jarvis-queue-job", 4, async (job, done) => {
    const { code, functionToCall, functionArgs } = job.data;
    const agent = agentMap[code];
    const { runId, nodeId, userId, flowId, accountId, threadId } = functionArgs;

    const tasksDB = await db.getTasksDB();
    const { rows: runs } = await tasksDB.query(
        `SELECT status FROM browserable.runs WHERE id = $1`,
        [runId]
    );
    const run = runs[0];

    if (run.status === "completed" || run.status === "error") {
        done();
        return;
    }

    const limitCheck = await checkLLMCallLimits({
        accountId,
        flowId,
        runId,
        threadId,
        nodeId,
    });

    if (!limitCheck) {
        await endThread({
            runId,
            threadId,
            userId,
            accountId,
            error: "LLM call limit exceeded",
            status: "error",
        });
        return;
    }

    try {
        await agent[functionToCall]({
            runId,
            nodeId,
            ...functionArgs,
            jarvis: {
                ...jarvis,
                user_id: userId,
                flow_id: flowId,
                account_id: accountId,
                thread_id: threadId,
            },
        });
    } catch (error) {
        console.error("Error in jarvis-queue-job", error);
        // send discord alert
        sendDiscordAdminAlert(
            JSON.stringify({
                heading: "Error in jarvis-queue-job",
                error: error.message,
                job,
            })
        );

        // mark the run as error
        const { rows: runs } = await tasksDB.query(
            `SELECT user_id, account_id FROM browserable.runs WHERE id = $1`,
            [runId]
        );
        const user_id = runs[0].user_id;
        const accountId = runs[0].account_id;

        await endThread({
            runId,
            threadId,
            userId: user_id,
            accountId,
            error: `Unknown error. Error in running a queue job. ${error.message}`,
            status: "error",
        });
    }

    done();
});

agentQueue.process("end-node", async (job, done) => {
    try {
        const {
            runId,
            nodeId,
            status,
            threadId,
            output,
            reasoning,
            report,
            schemaStructuredOutput,
        } = job.data;

        await endNodeWorker({
            runId,
            nodeId,
            status,
            output,
            reasoning,
            report,
            schemaStructuredOutput,
        });
    } catch (error) {
        console.error("Error in end-node", error);

        const { runId, threadId } = job.data;

        const tasksDB = await db.getTasksDB();
        const { rows: runs } = await tasksDB.query(
            `SELECT user_id, account_id FROM browserable.runs WHERE id = $1`,
            [runId]
        );
        const userId = runs[0].user_id;
        const accountId = runs[0].account_id;

        // end run
        await endThread({
            runId,
            threadId,
            userId,
            accountId,
            error: `Unknown error. Error in ending a node. ${error.message}`,
            status: "error",
        });

        // send discord alert
        sendDiscordAdminAlert(
            JSON.stringify(
                {
                    heading: "Error in end-node",
                    error: error.message,
                    job,
                },
                null,
                2
            )
        );
    }

    done();
});

flowQueue.process("create-run", async (job, done) => {
    try {
        const tasksDB = await db.getTasksDB();
        console.log(`Processing flow ${job.data.flowId}`);

        let {
            runId,
            userId,
            accountId,
            flowId,
            initMessage,
            input,
            triggerInput,
            triggerType,
        } = job.data;
        if (!runId) {
            runId = generateUUID();
        }

        const { rows: users } = await tasksDB.query(
            `SELECT settings, name FROM browserable.users WHERE id = $1`,
            [userId]
        );
        const timezoneOffsetInSeconds =
            users[0].settings.timezoneOffsetInSeconds;

        if (triggerType === "once" || triggerType === "crontab") {
            // we can give the time details here.
            const now = new Date();
            const readableTime = getReadableFromUTCToLocal(
                now,
                timezoneOffsetInSeconds
            );
            triggerInput = triggerInput
                ? `${triggerInput} | Running at ${readableTime}`
                : `Running at ${readableTime}`;
        }

        // create a run
        const run = await createRun({
            runId,
            userId,
            accountId,
            flowId,
            input,
            triggerInput,
            triggerType,
            initMessage,
        });
    } catch (error) {
        console.error("Error in create-run", error);
        // send discord alert
        sendDiscordAdminAlert(
            JSON.stringify(
                {
                    header: "Flow failed to create task",
                    body: {
                        flowId,
                        accountId,
                        userId,
                        job,
                        error,
                    },
                },
                null,
                2
            )
        );
    }

    done();
});

agentQueue.process(`schedule-pick-node`, async (job, done) => {
    // we give a 5 seconds delay since the current pick-node process might still be going on
    // another way to solve this is to use nodeId in the jobId perhaps.
    setTimeout(async () => {
        try {
            const { runId, nodeId } = job.data;

            await agentQueue.add(
                `pick-node`,
                {
                    runId,
                    nodeId,
                },
                {
                    jobId: `${runId}-pick-node`,
                    removeOnComplete: true,
                    attempts: 2,
                }
            );
        } catch (error) {
            console.error("Error in schedule-pick-node", error);

            const { runId, nodeId } = job.data;

            // send discord alert
            sendDiscordAdminAlert(
                JSON.stringify(
                    {
                        header: "Flow failed to schedule to pick an active node",
                        body: {
                            runId,
                            error,
                        },
                    },
                    null,
                    2
                )
            );
        }

        done();
    }, 5000);
});

agentQueue.process(`pick-node`, async (job, done) => {
    try {
        const { runId, nodeId } = job.data;

        await decideAgent({
            runId,
            preferredNodeId: nodeId,
        });
    } catch (error) {
        console.error("Error in pick-node", error);

        const { runId } = job.data;

        // send discord alert
        sendDiscordAdminAlert(
            JSON.stringify(
                {
                    header: "Flow failed to pick an active node",
                    body: {
                        runId,
                        error,
                    },
                },
                null,
                2
            )
        );
    }

    done();
});

agentQueue.process(`agent-init`, async (job, done) => {
    try {
        // we basically call init of the decided agent and let it take over from there.
        const { runId, nodeId, threadId, agentCode, input } = job.data;

        const tasksDB = await db.getTasksDB();
        const { rows: runs } = await tasksDB.query(
            `SELECT user_id, flow_id, account_id FROM browserable.runs WHERE id = $1`,
            [runId]
        );
        const run = runs[0];
        const userId = run.user_id;
        const flowId = run.flow_id;
        const accountId = run.account_id;
        const agent = agentMap[agentCode];

        // threads
        const { rows: threads } = await tasksDB.query(
            `SELECT id, input, data FROM browserable.threads WHERE run_id = $1`,
            [runId]
        );
        const thread = threads[0];

        await agent._init({
            runId,
            nodeId,
            threadId,
            input: thread.input,
            jarvis: {
                ...jarvis,
                user_id: userId,
                flow_id: flowId,
                account_id: accountId,
                thread_id: threadId,
            },
        });
    } catch (error) {
        console.error("Error in agent-init", error);

        // send discord alert
        sendDiscordAdminAlert(
            JSON.stringify({
                heading: "Error in agent-init",
                error: error.message,
            })
        );

        const { runId, nodeId, agentCode, input } = job.data;

        const tasksDB = await db.getTasksDB();
        const { rows: runs } = await tasksDB.query(
            `SELECT user_id, flow_id, account_id FROM browserable.runs WHERE id = $1`,
            [runId]
        );
        const run = runs[0];
        const userId = run.user_id;
        const flowId = run.flow_id;
        const accountId = run.account_id;

        // end the run
        await endThread({
            runId,
            threadId,
            userId,
            accountId,
            error: `Agent initialization failed. ${error.message}`,
            status: "error",
        });
    }

    done();
});

agentQueue.process(`node-looper`, 4, async (job, done) => {
    try {
        const { runId, nodeId, threadId, agentCode, input } = job.data;

        const tasksDB = await db.getTasksDB();
        const { rows: runs } = await tasksDB.query(
            `SELECT user_id, flow_id, account_id, status FROM browserable.runs WHERE id = $1`,
            [runId]
        );
        const run = runs[0];
        const userId = run.user_id;
        const flowId = run.flow_id;
        const accountId = run.account_id;

        // console.log("node-looper", runId, nodeId, agentCode, input);

        // check if the run is not completed or error
        if (run.status === "completed" || run.status === "error") {
            done();
            return;
        }

        const agent = agentMap[agentCode];
        await agent._looper({
            input,
            runId,
            nodeId,
            threadId,
            jarvis: {
                ...jarvis,
                user_id: userId,
                flow_id: flowId,
                account_id: accountId,
                thread_id: threadId,
            },
        });
    } catch (error) {
        console.error("Error in node-looper", error);
        // send discord alert
        sendDiscordAdminAlert(
            JSON.stringify({
                heading: "Error in node-looper",
                error: error.message,
                job,
            })
        );

        const { runId, nodeId, threadId, agentCode, input } = job.data;

        const tasksDB = await db.getTasksDB();
        const { rows: runs } = await tasksDB.query(
            `SELECT user_id, flow_id, account_id FROM browserable.runs WHERE id = $1`,
            [runId]
        );
        const run = runs[0];
        const userId = run.user_id;
        const flowId = run.flow_id;
        const accountId = run.account_id;

        // end the run
        await endThread({
            runId,
            threadId,
            userId,
            accountId,
            error: `Node looper failed. 
${error.message}`,
            status: "error",
        });
    }

    done();
});

agentQueue.process(`process-trigger`, async (job, done) => {
    try {
        const { runId, nodeId, triggerWaitId, triggerData } = job.data;
        await processTriggerForNode({
            runId,
            nodeId,
            triggerWaitId,
            triggerData,
        });
    } catch (error) {
        console.error("Error in process-trigger", error);
    }
    done();
});

async function runActionHelper({
    runId,
    nodeId,
    actionCode,
    threadId,
    actionId,
    aiData,
}) {
    try {
        const tasksDB = await db.getTasksDB();
        const { rows: runs } = await tasksDB.query(
            `SELECT user_id, flow_id, account_id FROM browserable.runs WHERE id = $1`,
            [runId]
        );
        const run = runs[0];
        const userId = run.user_id;
        const flowId = run.flow_id;
        const accountId = run.account_id;

        const limitCheck = await checkLLMCallLimits({
            accountId,
            flowId,
            runId,
            threadId,
            nodeId,
        });

        if (!limitCheck) {
            await endThread({
                runId,
                threadId,
                userId,
                accountId,
                error: "LLM call limit exceeded",
                status: "error",
            });
            return;
        }

        // get flow metadata
        let { rows: flowMetadata } = await tasksDB.query(
            `SELECT metadata FROM browserable.flows WHERE id = $1`,
            [flowId]
        );
        flowMetadata = flowMetadata[0].metadata || {};
        const { tools = [] } = flowMetadata;

        const { rows: nodes } = await tasksDB.query(
            `SELECT agent_code FROM browserable.nodes WHERE id = $1`,
            [nodeId]
        );
        const agentCode = nodes[0].agent_code;

        const agent = agentMap[agentCode];

        if (
            tools.length > 0 &&
            tools.filter((tool) => tool.function.name === actionCode).length > 0
        ) {
            // then this is a tool_call
            await updateNodeAgentLog({
                runId,
                nodeId,
                threadId,
                messages: [
                    {
                        role: "assistant",
                        content: `Asking user for input for tool call ${actionCode} with parameters ${JSON.stringify(
                            aiData
                        )}`,
                    },
                ],
            });

            await askUserForInputAtNode({
                runId,
                nodeId,
                threadId,
                tool: {
                    name: actionCode,
                    parameters: aiData,
                },
            });
            return;
        }

        // if the actionCode is not present in agent.getActionFns(), then throw an error
        if (!agent.getActionFns()[actionCode]) {
            await endThread({
                runId,
                threadId,
                userId,
                accountId,
                error: `Action ${actionCode} not found in agent ${agentCode}`,
                status: "error",
            });

            return;
        }

        await agent.getActionFns()[actionCode]({
            jarvis: {
                ...jarvis,
                user_id: userId,
                flow_id: flowId,
                account_id: accountId,
                thread_id: threadId,
            },
            runId,
            nodeId,
            threadId,
            userId,
            aiData,
            flowId,
            accountId,
        });
    } catch (error) {
        console.error("Error in run-action", error);
        const tasksDB = await db.getTasksDB();
        const { rows: runs } = await tasksDB.query(
            `SELECT user_id, flow_id, account_id FROM browserable.runs WHERE id = $1`,
            [runId]
        );
        const run = runs[0];
        const userId = run.user_id;
        const accountId = run.account_id;

        sendDiscordAdminAlert(
            JSON.stringify({
                heading: "Error in run-action",
                error: error.message,
                data: {
                    runId,
                    nodeId,
                    actionCode,
                    threadId,
                    actionId,
                    aiData,
                },
            })
        );

        await endThread({
            runId,
            threadId,
            userId,
            accountId,
            error: error.message,
            status: "error",
        });
    }
}

agentQueue.process(`run-action`, 4, async (job, done) => {
    const { runId, nodeId, actionCode, threadId, actionId, aiData } = job.data;

    await runActionHelper({
        runId,
        nodeId,
        actionCode,
        threadId,
        actionId,
        aiData,
    });

    done();
});

async function getSimilarFileChunks({
    user_id,
    account_id,
    query,
    file_source,
    max_results = 10,
}) {
    const similarChunks = await getSimilarFileChunksHelper({
        user_id,
        account_id,
        file_source,
        input_text: query,
        max_results,
    });

    return similarChunks;
}

async function getChunkTextsFromIds({ user_id, account_id, chunk_ids }) {
    const chunkTexts = await getChunkTextsFromIdsHelper({
        user_id,
        account_id,
        chunk_ids,
    });

    return chunkTexts.map((chunk) => chunk.chunk_text);
}

async function trimTextToTokenLimit({ text, tokenLimit }) {
    tokenLimit = Math.min(
        Number(tokenLimit || MAX_CONTEXT_LENGTH),
        MAX_CONTEXT_LENGTH
    );
    const tokens = enc.encode(text);
    const trimmedTokens = tokens.slice(0, tokenLimit);
    return new TextDecoder().decode(enc.decode(trimmedTokens));
}

function getAvailableTriggers({ agent_codes }) {
    const allDeets = agent_codes
        .map((code) => {
            const agent = agentMap[code];
            return Object.keys(agent.EVENT_DETAILS || {})
                .map((eventCode) => {
                    return `Event: ${eventCode}
Description: ${agent.EVENT_DETAILS[eventCode].description}`;
                })
                .join("\n\n");
        })
        .filter((x) => x)
        .join("\n\n");
    return allDeets;
}

async function getActionsAndEvents({ agent_codes }) {
    const allDeets = agent_codes
        .map((code) => {
            const agent = agentMap[code];

            const agentActions = agent.getActions();

            const agentActionsString = Object.keys(agentActions)
                .map((actionCode) => {
                    return `Action: ${actionCode}
Description: ${agentActions[actionCode].description}`;
                })
                .join("\n\n");

            let agentEventsString = "";

            if (agent.EVENT_DETAILS) {
                agentEventsString = Object.keys(agent.EVENT_DETAILS)
                    .map((eventCode) => {
                        return `Event: ${eventCode}
Description: ${agent.EVENT_DETAILS[eventCode].description}`;
                    })
                    .join("\n\n");
            }

            return `AGENT: ${agent.CODE}
AGENT DESCRIPTION: ${agent.DETAILS.description}
ACTIONS: ${agentActionsString ? agentActionsString : "None"}
EVENTS: ${agentEventsString ? agentEventsString : "None"}`;
        })
        .join("\n\n-----------------------------------\n\n");

    return allDeets;
}

async function isRunActive({ runId, flowId }) {
    const tasksDB = await db.getTasksDB();
    const { rows: runs } = await tasksDB.query(
        `SELECT status FROM browserable.runs WHERE id = $1`,
        [runId]
    );
    // get flow status
    const { rows: flows } = await tasksDB.query(
        `SELECT status FROM browserable.flows WHERE id = $1`,
        [flowId]
    );

    return (
        runs[0].status !== "completed" &&
        runs[0].status !== "error" &&
        flows[0].status === "active"
    );
}

const jarvis = {
    updateNodeStatus,
    updateNodeKeyVal,
    scheduleNodeLooper,
    errorAtNode,
    decideAction,
    generateUUID,
    scheduleAction,
    sendEmailToUser,
    updateRunUserLog,
    updateNodeUserLog,
    endNode,
    createRun,
    endRun,
    callOpenAICompatibleLLMWithRetry,
    updateNodeAgentLog,
    askUserForInputAtNode,
    processUserInputForRun,
    processUserInputForNode,
    communicateInformationToUserAtRun,
    communicateInformationToUserAtNode,
    getSimilarFileChunks,
    getChunkTextsFromIds,
    trimTextToTokenLimit,
    processTriggerForNode,
    addTriggerForNode,
    getNodeInfo,
    saveNodePrivateData,
    getActionsAndEvents,
    getAvailableAgentsForUser,
    updateRunAgentLog,
    getNodeAgentLog,
    updateNodeLiveStatus,
    upsertRunPrivateData,
    getRunPrivateData,
    updateRunLiveStatus,
    updateNodeDebugLog,
    updateRunDebugLog,
    isRunActive,
    getAvailableTriggers,
    createDetailedOutputForNode,
    createDetailedOutputWithMessages,
    scheduleQueueJob,
    updateFlowUserLog,
    updateFlowAgentLog,
    updateFlowDebugLog,
    updateThreadData,
    updateFlowCreatorStatus,
    getThreadData,
    getDataTableSchema,
};

module.exports = jarvis;
