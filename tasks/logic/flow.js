const db = require("../services/db");
const { flowQueue } = require("../services/queue");
const { sendDiscordAdminAlert } = require("./utils");
const crypto = require("crypto");
const { callOpenAICompatibleLLMWithRetry } = require("../services/llm");
const browserService = require("../services/browser");
const { agentQueue } = require("../services/queue");
const { encode } = require("gpt-tokenizer/encoding/cl100k_base");
const {
    agents: {
        jarvis: {
            buildRichOutputPrompt,
            buildDataTableSystemPrompt,
            buildDataTableSchemaPrompt,
            buildDataTableOpsPrompt,
            buildDataTableDocUpdatePrompt,
        },
    },
} = require("../prompts");

const { updateDocumentInDataTable } = require("./datatable");

async function getFlow({ flow_id, account_id }) {
    const tasksDB = await db.getTasksDB();
    const { rows } = await tasksDB.query(
        `SELECT * FROM browserable.flows WHERE id = $1 AND account_id = $2`,
        [flow_id, account_id]
    );
    return rows[0];
}

async function removeJobById({ jobId }) {
    const job = await agentQueue.getJob(jobId);
    if (job) {
        await job.remove();
    }
}

async function removeFlowJobById({ jobId }) {
    const job = await flowQueue.getJob(jobId);
    if (job) {
        await job.remove();
    }
}

flowQueue.process("task-creator-job", async (job, done) => {
    try {
        const tasksDB = await db.getTasksDB();
        const { flowId, accountId, userId } = job.data;
        const flow = await getFlow({ flow_id: flowId, account_id: accountId });

        const { rows: users } = await tasksDB.query(
            `SELECT settings, name FROM browserable.users WHERE id = $1`,
            [userId]
        );
        const timezoneOffsetInSeconds =
            users[0]?.settings?.timezoneOffsetInSeconds || 0;
        const userName = users[0].name;

        const { task, metadata } = flow;
        const { agent_codes } = metadata;

        let columns = [];

        if (
            agent_codes &&
            agent_codes.length > 0 &&
            agent_codes.includes("DEEPRESEARCH_AGENT")
        ) {
            columns = [
                {
                    key: "report",
                    name: "Report",
                    type: "string",
                    description: "Deepresearch report",
                },
                {
                    key: "sources",
                    name: "Sources",
                    type: "string",
                    description: "Sources used to generate the report",
                },
                {
                    key: "learnings",
                    name: "Learnings",
                    type: "string",
                    description: "Learnings from the research",
                },
            ];
        } else {
            const systemPrompt = buildDataTableSystemPrompt({
                userName: userName,
                timezoneOffsetInSeconds: timezoneOffsetInSeconds,
            });

            const schemaPrompt = buildDataTableSchemaPrompt({
                task,
                userName: userName,
                timezoneOffsetInSeconds: timezoneOffsetInSeconds,
            });

            const response = await callOpenAICompatibleLLMWithRetry({
                messages: [
                    {
                        role: "system",
                        content: systemPrompt,
                    },
                    {
                        role: "user",
                        content: schemaPrompt,
                    },
                ],
                metadata: {
                    flowId,
                    accountId,
                    userId,
                    usecase: "datatable_schema",
                },
                models: [
                    "gemini-2.5-flash",
                    "deepseek-chat",
                    "gpt-4o-mini",
                    "claude-3-5-haiku",
                    "qwen-plus",
                ],
                maxTokens: 2000,
                max_attempts: 4,
            });

            columns = response.columns;
        }

        // save this in metadata
        metadata.dtSchema = columns;

        await tasksDB.query(
            `UPDATE browserable.flows SET metadata = $1 WHERE id = $2`,
            [JSON.stringify(metadata), flowId]
        );

        // if all went well, check if the flow is active
        if (flow.status === "active") {
            await changeFlowStatus({
                flow_id: flowId,
                account_id: accountId,
                status: "active",
                currentStatus: "inactive",
                user_id: userId,
            });
        }
    } catch (err) {
        console.log(err);

        await changeFlowStatus({
            flow_id: flowId,
            account_id: accountId,
            status: "inactive",
            currentStatus: "active",
            user_id: userId,
        });

        await addFlowUserLog({
            flowId,
            accountId,
            userId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: "Flow failed to create task",
                        },
                    ],
                },
            ],
        });

        await addFlowDebugLog({
            flowId,
            accountId,
            userId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: "Flow failed to create task",
                            associatedData: [
                                {
                                    type: "code",
                                    code: {
                                        err,
                                        job,
                                    },
                                },
                            ],
                        },
                    ],
                },
            ],
        });
    }
    done();
});

flowQueue.add(
    "check-for-failed-jobs",
    {},
    {
        repeat: {
            every: 2 * 60 * 1000,
        },
    }
);

flowQueue.process("check-for-failed-jobs", async (job, done) => {
    try {
        const jobs = await flowQueue.getJobs(["failed"]);

        // find all the jobs with name "task-creator-job"
        const taskCreatorJobs = jobs.filter(
            (job) => job.name === "task-creator-job"
        );
        // for each job, mark a flow as failed. move active to inactive, and remove the job
        for (const job of taskCreatorJobs) {
            const { flowId, accountId, userId } = job.data;

            await addFlowUserLog({
                flowId,
                accountId,
                userId,
                messages: [
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: "Flow failed to create task",
                            },
                        ],
                    },
                ],
            });

            await addFlowDebugLog({
                flowId,
                accountId,
                userId,
                messages: [
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: "Flow failed to create task",
                                associatedData: [
                                    {
                                        type: "code",
                                        code: {
                                            job,
                                        },
                                    },
                                ],
                            },
                        ],
                    },
                ],
            });

            await changeFlowStatus({
                flow_id: flowId,
                account_id: accountId,
                status: "inactive",
                currentStatus: "active",
                user_id: userId,
            });

            await job.remove();

            sendDiscordAdminAlert(
                JSON.stringify(
                    {
                        header: "Flow failed to create task",
                        body: {
                            flowId,
                            accountId,
                            userId,
                            job,
                        },
                    },
                    null,
                    2
                )
            );
        }

        // run creator jobs
        const creatorJobs = jobs.filter((job) => job.name === "create-run");
        for (const job of creatorJobs) {
            // one run failed at creating stage itself
            const {
                runId,
                userId,
                accountId,
                flowId,
                initMessage,
                input,
                triggerInput,
                triggerType,
            } = job.data;

            // convey in the flow that the run failed
            await addFlowUserLog({
                flowId,
                accountId,
                userId,
                messages: [
                    {
                        role: "assistant",
                        content: [
                            { type: "text", text: "Run failed to create" },
                        ],
                    },
                ],
            });

            await addFlowDebugLog({
                flowId,
                accountId,
                userId,
                messages: [
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: "Run failed to create",
                                associatedData: [
                                    {
                                        type: "code",
                                        code: {
                                            job,
                                        },
                                    },
                                ],
                            },
                        ],
                    },
                ],
            });

            await turnOffFlowIfNoTriggers({ flowId, accountId, userId });

            await job.remove();
        }
    } catch (err) {
        console.log(err);
        // send an alert to admins in discord about this
        sendDiscordAdminAlert(
            JSON.stringify({
                header: "Flow failed to create task",
                body: {
                    error: err.message,
                    stacktrace: err.stack,
                },
            })
        );
    }

    done();
});

async function createFlow({ flow }) {
    let {
        readable_name,
        readable_description,
        user_id,
        account_id,
        task,
        triggers,
        data = {},
        status,
        metadata = {},
    } = flow || {};

    // triggers can be
    // "once|<delay>|" ---> instantly creates a run with the delay
    // "crontab|<crontab_string>|" ---> creates a task with the crontab string to run as long as it is active
    // "live_url_id|<live_url_id>|" ---> users can open our UI with this live URL id to create a run
    // "webhook_url_id|<webhook_url_id>|" ---> users can ping this webhook URL to create a run
    // "email_unique_id|<email_unique_id>|" ---> users can email this email to create a run
    // event.once|<event_id>|" ---> integrations can parse this event id to create a run
    // event.every|<event_id>|" ---> integrations can parse this event id to create a run
    triggers = triggers || ["once|0|"];

    status = status || "active";
    if (status !== "active" && status !== "inactive") {
        status = "active";
    }

    if (metadata.tools) {
        // for now we only support function calling
        metadata.tools = metadata.tools.filter((x) => x.type === "function");
    }

    const flowId = crypto.randomUUID();
    const tasksDB = await db.getTasksDB();

    const date = new Date();

    const { rows } = await tasksDB.query(
        `INSERT INTO browserable.flows (id, readable_name, readable_description, user_id, account_id, task, triggers, data, status, metadata, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [
            flowId,
            readable_name || "",
            readable_description || "",
            user_id,
            account_id,
            task,
            JSON.stringify(triggers),
            JSON.stringify(data),
            status,
            JSON.stringify(
                Object.assign({}, metadata || {}, {
                    creatorStatus: "Creating task",
                })
            ),
            date,
            date,
        ]
    );

    // add the init message to the user messages log
    await tasksDB.query(
        `INSERT INTO browserable.message_logs (flow_id, messages, segment, created_at) VALUES ($1, $2, $3, $4)`,
        [
            flowId,
            JSON.stringify([{ role: "user", content: task }]),
            "user",
            new Date(),
        ]
    );

    flowQueue.add(
        "task-creator-job",
        {
            flowId,
            accountId: account_id,
            userId: user_id,
        },
        {
            attempts: 2,
            removeOnComplete: false,
            jobId: `${flowId}-task-creator-job`,
        }
    );

    return {
        ...rows[0],
        flowId,
    };
}

async function changeFlowStatus({
    flow_id,
    user_id,
    account_id,
    status,
    currentStatus,
}) {
    // status can be "active" or "inactive"
    const tasksDB = await db.getTasksDB();

    await tasksDB.query(
        `UPDATE browserable.flows SET status = $1, updated_at = $2 WHERE id = $3 AND status = $4`,
        [status, new Date(), flow_id, currentStatus]
    );

    const flow = await getFlow({ flow_id, account_id });

    if (!flow) {
        return;
    }

    // if the current status is "active" and the new status is "inactive"
    // - once -> nothing to do
    // - crontab -> delete the crontab task from bull queue
    // - live_url_id -> nothing to do
    // - webhook_url_id -> nothing to do
    // - email_unique_id -> nothing to do
    // - event.once -> nothing to do
    // - event.every -> nothing to do
    if (currentStatus === "active" && status === "inactive") {
        const triggers = flow.triggers;
        for (const trigger of triggers) {
            const [triggerType, triggerData, ...rest] = trigger.split("|");
            if (triggerType === "crontab") {
                const [crontab] = triggerData.split("|");
                await removeFlowJobById(`${flow_id}-${crontab}`);
            }
        }

        // if there are any active runs of this flow, change their status to "completed" so it doesn't run anymore. with output and reasoning as "Manual abort"
        // if there any active nodes of this flow's runs, change their status to "completed" so it doesn't run anymore
        // In any of the nodes, if the private_data has sessionId field, then it's a browser session. End it

        const { rows: runs } = await tasksDB.query(
            `SELECT id FROM browserable.runs WHERE flow_id = $1 AND status <> 'completed' AND status <> 'error'`,
            [flow_id]
        );

        for (const run of runs) {
            await updateRunStatus({
                runId: run.id,
                status: "error",
                error: "",
                output: "Manual abort",
                userId: user_id,
                accountId: account_id,
                reasoning: "Manual abort",
                input_wait: null,
            });

            await updateRunLiveStatus({
                runId: run.id,
                liveStatus: "",
            });

            // Get all the nodes of this run with status <> 'completed' and status <> 'error'
            const { rows: nodes } = await tasksDB.query(
                `SELECT id FROM browserable.nodes WHERE run_id = $1 AND status <> 'completed' AND status <> 'error'`,
                [run.id]
            );

            for (const node of nodes) {
                // // remove any node-looper jobs in agentsQueue with this runId as part of the data
                // await removeJobById(`${run.id}-${node.id}-node-looper`);
                // // remove any run-action jobs in actionsQueue with this runId as part of the data
                // await removeJobById(`${run.id}-${node.id}-run-action`);
                // // remove any process-trigger jobs in integrationsQueue with this runId as part of the data
                // await removeJobById(`${run.id}-${node.id}-process-trigger`);
                // // remove any run-looper jobs in agentsQueue with this runId as part of the data
                // await removeJobById(`${run.id}-${node.id}-run-looper`);
            }
        }

        const { rows: nodes } = await tasksDB.query(
            `SELECT id, run_id, private_data->>'sessionId' AS sessionId FROM browserable.nodes WHERE run_id IN (SELECT id FROM browserable.runs WHERE flow_id = $1) AND status <> 'completed' AND status <> 'error'`,
            [flow_id]
        );

        for (const node of nodes) {
            await updateNodeStatus({
                runId: node.run_id,
                nodeId: node.id,
                status: "completed",
                error: "",
                input_wait: null,
            });

            await updateNodeLiveStatus({
                runId: node.run_id,
                nodeId: node.id,
                liveStatus: "",
            });

            if (node.sessionId) {
                await browserService.stopSession({
                    sessionId: node.sessionId,
                });
            }
        }

        await updateFlowCreatorStatus({
            flowId: flow_id,
            status: "",
        });
    }

    // if the current status is "inactive" and the new status is "active"
    // - once -> trigger the flow
    // - crontab -> create a crontab task in bull queue
    // - live_url_id -> nothing to do
    // - webhook_url_id -> nothing to do
    // - email_unique_id -> nothing to do
    // - event.once -> nothing to do
    // - event.every -> nothing to do
    if (currentStatus === "inactive" && status === "active") {
        // get triggers
        const triggers = flow.triggers;
        for (const trigger of triggers) {
            const [triggerType, triggerData, ...rest] = trigger.split("|");
            if (triggerType === "once") {
                const [delay] = triggerData.split("|");
                let runId = "";
                runId = crypto.randomUUID();

                // For a once-trigger, there is no input
                flowQueue.add(
                    "create-run",
                    {
                        runId,
                        accountId: account_id,
                        userId: user_id,
                        flowId: flow_id,
                        input: flow.task,
                        triggerInput: "",
                        triggerType: "once",
                        initMessage: flow.metadata?.initMessage,
                    },
                    {
                        delay: delay || 0,
                        removeOnComplete: true,
                    }
                );
            } else if (triggerType === "crontab") {
                const [crontab] = triggerData.split("|");

                flowQueue.add(
                    "create-run",
                    {
                        userId: user_id,
                        accountId: account_id,
                        flowId: flow_id,
                        input: flow.task,
                        triggerInput: crontab,
                        triggerType: "crontab",
                        initMessage: flow.metadata?.initMessage,
                    },
                    {
                        jobId: `${flow_id}-${crontab}`,
                        repeat: {
                            cron: crontab,
                        },
                    }
                );
            }
            // we don't need to do anything for others
        }
    }
}

async function getExistingKeysOfAFlow({ flowId, skipRunId }) {
    const tasksDB = await db.getTasksDB();
    // for all the runs of this flow, in structured_output, get the set of keys
    const { rows: existingKeyRows } = await tasksDB.query(
        `SELECT DISTINCT json_object_keys(structured_output) AS key FROM browserable.runs WHERE flow_id = $1 AND structured_output IS NOT NULL AND json_typeof(structured_output) = 'object' AND id <> $2`,
        [flowId, skipRunId]
    );

    let keys = [];
    for (const row of existingKeyRows) {
        keys.push(row.key);
    }

    // get most recent sample structured_output for this flow that is not null and is an object
    const { rows: sampleStructuredOutputRows } = await tasksDB.query(
        `SELECT structured_output FROM browserable.runs WHERE flow_id = $1 AND structured_output IS NOT NULL AND json_typeof(structured_output) = 'object' AND id <> $2 ORDER BY created_at DESC LIMIT 1`,
        [flowId, skipRunId]
    );

    let sample = null;

    if (sampleStructuredOutputRows.length > 0) {
        sample = sampleStructuredOutputRows[0].structured_output;
    }

    return {
        keys,
        sample,
    };
}

async function createStructuredOutput({ runId, detailedOutput }) {
    // get output and reasoning from the run
    const tasksDB = await db.getTasksDB();
    const { rows: runs } = await tasksDB.query(
        `SELECT output, reasoning, input, trigger_input, flow_id, account_id FROM browserable.runs WHERE id = $1`,
        [runId]
    );

    let { keys, sample } = await getExistingKeysOfAFlow({
        flowId: runs[0]?.flow_id,
        skipRunId: runId,
    });

    const output = runs[0]?.output;
    const reasoning = runs[0]?.reasoning;
    const input = runs[0]?.input;
    const trigger_input = runs[0]?.trigger_input;

    const logs = [];

    const { rows: messageLogs } = await tasksDB.query(
        `SELECT messages, created_at FROM browserable.message_logs WHERE flow_id = $1 AND segment = 'user' ORDER BY created_at`,
        [runs[0]?.flow_id]
    );

    for (const log of messageLogs) {
        for (const message of log.messages) {
            if (typeof message.content === "string") {
                message.content = [
                    {
                        type: "text",
                        text: message.content,
                    },
                ];
            }

            if (message.content.length > 0) {
                for (const content of message.content) {
                    if (content.type === "text") {
                        logs.push({
                            role: message.role,
                            content: content.text,
                        });
                    } else if (content.type === "markdown") {
                        logs.push({
                            role: message.role,
                            content: content.markdown,
                        });
                    }
                }
            }
        }
    }

    const messages = [
        {
            role: "system",
            content:
                "You are a helpful assistant that creates a structured output from a given task, it's output and reasoning.",
        },
        {
            role: "user",
            content: `
TASK FOR YOU: Given a todo, output and reasoning, create a structured output.

TODO: ${input}
${trigger_input || ""}

OUTPUT: ${output}

REASONING: ${reasoning}

COMPLETE CONTEXT WITH USER MESSAGES: ${JSON.stringify(logs)}

KEYS BEING USED SO FAR: ${keys.length > 0 ? keys.join(", ") : "none"}

SAMPLE STRUCTURED OUTPUT: ${sample ? JSON.stringify(sample) : "none"}

OUTPUT: JSON object with keys as the keys in the sample structured output and values as the values in the output. For value types, you can refer to the sample structured output. But only following types are allowed: string, number, boolean.
1. If there are no existing keys or sample structured output, then you can create keys and values of any type by yourself. 
2. If there are existing keys, try to make sure you cover those keys in the output.
3. Sample structured output is just for your reference. You can ignore the actual content of it.
4. You can also add new keys that are not present in the sample structured output if it makes sense.
5. User might have provided context on what keys/ data they need. You can refer to that context to create the structured output.

Keys you can avoid:
1. What the task is about
2. When is it run
3. What the trigger is about
4. Focus solely on the end result of the task and how to present that information.
5. Don't include any information about what keys are used and not used.
6. If you need to provide structured information, then markdown string is allowed.
7. MANDATORILY, include a key called "Status" in the output. The value of this key must be "SUCCESS" (if the task was completed successfully) or "FAILURE" (if the run is a failure).
8. All key names must be human readable (Don't use underscores or hyphens or any other special characters unless necessary).

Good key formats:
1. "Name"
2. "Name of the person"

Bad key formats:
1. "name"
2. "name_of_the_person"
3. "NameOfThePerson"

IMPORTANT:
If you need to provide structured information, format it as a markdown string instead of a nested JSON object.

PRINT ONLY THE JSON OBJECT AND NOTHING ELSE.

THE OBJECT MUST NOT HAVE ANY NESTED VALUES. ALL VALUES MUST BE STRING (CAN BE MARKDOWN OR TEXT), BOOLEAN OR NUMBER.
            `,
        },
    ];

    const response = await callOpenAICompatibleLLMWithRetry({
        messages,
        models: [
            "gemini-2.5-flash",
            "deepseek-chat",
            "gpt-4o-mini",
            "claude-3-5-haiku",
            "qwen-plus",
        ],
        max_attempts: 5,
        max_tokens: 4000,
        metadata: {
            runId,
            flowId: runs[0]?.flow_id,
            accountId: runs[0]?.account_id,
            usecase: "structured_output",
        },
    });

    const structuredOutput = response;
    structuredOutput["REPORT"] = detailedOutput;

    await tasksDB.query(
        `UPDATE browserable.runs SET structured_output = $1 WHERE id = $2`,
        [JSON.stringify(structuredOutput), runId]
    );
}

async function turnOffFlowIfNoTriggers({ flowId, accountId, userId }) {
    const tasksDB = await db.getTasksDB();
    const {
        rows: [flow],
    } = await tasksDB.query(
        `SELECT status, triggers FROM browserable.flows WHERE id = $1 AND account_id = $2`,
        [flowId, accountId]
    );
    const flowStatus = flow.status;

    if (flowStatus === "inactive") {
        return;
    }

    const triggers = flow.triggers;

    let shouldKeepFlowActive = false;

    for (const trigger of triggers) {
        const [triggerType, triggerData, ...rest] = trigger.split("|");
        if (triggerType === "crontab") {
            const [crontab] = triggerData.split("|");
            shouldKeepFlowActive = true;
        } else if (triggerType === "event.every") {
            shouldKeepFlowActive = true;
        }
    }

    if (!shouldKeepFlowActive) {
        await changeFlowStatus({
            flow_id: flowId,
            user_id: userId,
            account_id: accountId,
            status: "inactive",
            currentStatus: flowStatus,
        });
    }
}

async function updateRunStatus({
    runId,
    status,
    error,
    output,
    userId,
    accountId,
    reasoning,
    input_wait,
}) {
    const tasksDB = await db.getTasksDB();

    // get the current status first

    const { rows: runs } = await tasksDB.query(
        `SELECT status FROM browserable.runs WHERE id = $1`,
        [runId]
    );
    const currentStatus = runs[0].status;

    // if the current status is "completed" or "error", then ignore
    if (currentStatus === "completed" || currentStatus === "error") {
        return;
    }

    await tasksDB.query(
        `UPDATE browserable.runs SET status = $1, error = $2, output = $3, reasoning = $4, input_wait = $5 WHERE id = $6`,
        [status, error, output, reasoning, input_wait, runId]
    );
}

// NODE = AGENT'S instance inside a run. Reason why it is called node and not an agent is because a single agent can be used multiple times in a run.
async function updateNodeStatus({
    runId,
    nodeId,
    error,
    status,
    input_wait,
    trigger_wait,
}) {
    const tasksDB = await db.getTasksDB();

    // get the current status first
    const { rows: nodes } = await tasksDB.query(
        `SELECT status FROM browserable.nodes WHERE run_id = $1 AND id = $2`,
        [runId, nodeId]
    );
    const currentStatus = nodes[0].status;

    // if the current status is "completed" or "error", then ignore
    if (currentStatus === "completed" || currentStatus === "error") {
        return;
    }

    await tasksDB.query(
        `UPDATE browserable.nodes SET status = $1, error = $2, input_wait = $3, trigger_wait = $4 WHERE run_id = $5 AND id = $6`,
        [status, error, input_wait, trigger_wait, runId, nodeId]
    );
}

async function updateRunLiveStatus({ runId, liveStatus }) {
    const tasksDB = await db.getTasksDB();

    await tasksDB.query(
        `UPDATE browserable.runs SET live_status = $1 WHERE id = $2`,
        [liveStatus, runId]
    );
}

async function updateNodeLiveStatus({ runId, nodeId, liveStatus }) {
    const tasksDB = await db.getTasksDB();

    await tasksDB.query(
        `UPDATE browserable.nodes SET live_status = $1 WHERE run_id = $2 AND id = $3`,
        [liveStatus, runId, nodeId]
    );
}

async function getNodeAgentLog({ runId, nodeId }) {
    const tasksDB = await db.getTasksDB();
    const { rows: nodes } = await tasksDB.query(
        `SELECT messages, created_at FROM browserable.message_logs WHERE run_id = $1 AND node_id = $2 AND segment = 'agent' ORDER BY created_at ASC`,
        [runId, nodeId]
    );
    return nodes;
}

async function addFlowUserLog({ flowId, accountId, userId, messages }) {
    const tasksDB = await db.getTasksDB();
    await tasksDB.query(
        `INSERT INTO browserable.message_logs (flow_id, messages, segment, created_at) VALUES ($1, $2, $3, $4)`,
        [flowId, JSON.stringify(messages), "user", new Date()]
    );
}

async function addFlowDebugLog({ flowId, accountId, userId, messages }) {
    const tasksDB = await db.getTasksDB();
    await tasksDB.query(
        `INSERT INTO browserable.message_logs (flow_id, messages, segment, created_at) VALUES ($1, $2, $3, $4)`,
        [flowId, JSON.stringify(messages), "debug", new Date()]
    );
}

async function detailedOutputHelper({
    messages,
    runId,
    nodeId,
    flowId,
    accountId,
    input,
    outputData,
    output,
    outputGenerated,
    userId,
    attempt = 0,
    jsonSchema,
}) {
    // Iteratively go through the messages (with chunking at 10000 tokens) and iteratively call the LLM to get the detailed output and reasoning
    let completed = false;
    let maxTokens = 10000;

    while (!completed) {
        let currentChunks = [];
        let currentChunkTokens = 0;

        while (currentChunkTokens < maxTokens && messages.length > 0) {
            const message = messages.pop();

            if (
                Array.isArray(message.content) &&
                message.content.length > 0 &&
                message.content[0].type === "image_url"
            ) {
                // skip image urls
                continue;
            } else {
                if (!message.content) {
                    continue;
                }
                let content =
                    typeof message.content === "string"
                        ? message.content
                        : Array.isArray(message.content)
                        ? message.content
                              .map((c) =>
                                  typeof c === "string"
                                      ? c
                                      : c.text
                                      ? c.text
                                      : c.markdown
                                      ? c.markdown
                                      : ""
                              )
                              .join("")
                        : typeof message.content === "object"
                        ? message.content.text
                            ? message.content.text
                            : message.content.markdown
                            ? message.content.markdown
                            : ""
                        : "";
                // trim content to max 3000 words
                content = content.split(" ").slice(0, 3000).join(" ");
                const tokens = encode(content).length;
                currentChunks.push({
                    role:
                        message.role === "user" || message.role === "assistant"
                            ? message.role
                            : "user",
                    content: content,
                });
                currentChunkTokens += tokens;
            }
        }

        updateRunStatus({
            runId,
            status: "Learning from the work so far",
            error: null,
            output: null,
            reasoning: null,
            userId,
            accountId,
        });

        const promptMessages = buildRichOutputPrompt({
            messagesExchanged: currentChunks,
            outputGeneratedSoFar: outputGenerated || {},
            outputData,
            input,
            output,
        });

        const response = await callOpenAICompatibleLLMWithRetry({
            messages: promptMessages,
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
                accountId,
                usecase: "detailed_output",
            },
            max_attempts: 4,
            jsonSchema,
        });

        outputGenerated = response.outputGenerated;

        if (messages.length === 0) {
            completed = true;
        }
    }

    updateRunStatus({
        runId,
        status: "Completed learning from the work so far",
        error: null,
        output: null,
        reasoning: null,
        userId,
        accountId,
    });

    return outputGenerated;
}

async function createDetailedOutputWithMessages({
    messages,
    input,
    runId,
    nodeId,
    flowId,
    accountId,
    userId,
}) {
    const detailedOutput = await detailedOutputHelper({
        messages,
        runId,
        flowId,
        input,
        accountId,
        userId,
        outputData: [
            {
                key: "report",
                name: "Report",
                description: "Detailed report",
                type: "markdown",
            },
        ],
    });

    return detailedOutput;
}

async function createUpdatesToDocuments({
    flowId,
    runId,
    nodeId,
    shortlistedDocuments,
    userId,
    accountId,
    task,
    dtSchema,
    learnedRows,
}) {
    const tasksDB = await db.getTasksDB();

    const { rows: users } = await tasksDB.query(
        `SELECT name, settings->>'timezoneOffsetInSeconds' as timezone_offset FROM browserable.users WHERE id = $1`,
        [userId]
    );
    const userName = users[0].name;
    const timezoneOffsetInSeconds = users[0].timezone_offset;

    const prompt = buildDataTableDocUpdatePrompt({
        task,
        userName,
        timezoneOffsetInSeconds,
        shortlistedDocuments,
        learnedRows,
        dtSchema,
    });

    const response = await callOpenAICompatibleLLMWithRetry({
        messages: [{ role: "user", content: prompt }],
        models: [
            "gemini-2.5-flash",
            "deepseek-chat",
            "gpt-4o-mini",
            "claude-3-5-haiku",
        ],
        max_tokens: 4000,
        metadata: {
            runId,
            nodeId,
            flowId,
            accountId,
            usecase: "datatable_docs_update",
        },
        max_attempts: 4,
    });

    const updates = response.updates;
    const updateSummary = response.updateSummary;
    let finalUpdates = [];

    if (updates && updates.length > 0) {
        for (const update of updates) {
            // make sure update has rowId
            if (!update.rowId) {
                continue;
            }
            finalUpdates.push(update);
        }
    }

    return {
        success: true,
        summaryOfUpdates: updateSummary,
        updatedDocuments: finalUpdates,
    };
}

async function createDetailedOutputForNode({
    runId,
    nodeId,
    userId,
    input,
    output,
    outputData,
    useHistory,
    jsonSchema,
}) {
    const tasksDB = await db.getTasksDB();

    const { rows: runs } = await tasksDB.query(
        `SELECT flow_id, account_id FROM browserable.runs WHERE id = $1`,
        [runId]
    );
    const flowId = runs[0].flow_id;
    const accountId = runs[0].account_id;

    const nodes = await getNodeAgentLog({ runId, nodeId });

    let messages = [];

    if (useHistory) {
        for (const node of nodes) {
            for (const message of node.messages) {
                messages.push(message);
            }
        }
    }

    const detailedOutput = await detailedOutputHelper({
        messages,
        runId,
        nodeId,
        flowId,
        input,
        accountId,
        outputData,
        output,
        userId,
        jsonSchema,
    });

    return detailedOutput;
}

async function updateFlowCreatorStatus({ flowId, status }) {
    const tasksDB = await db.getTasksDB();

    // update metadata.creatorStatus field of the flow. since its a json field, get the object, update and insert back.
    const { rows: flows } = await tasksDB.query(
        `SELECT metadata FROM browserable.flows WHERE id = $1`,
        [flowId]
    );
    const flow = flows[0];
    let metadata = flow.metadata;
    metadata.creatorStatus = status;
    await tasksDB.query(
        `UPDATE browserable.flows SET metadata = $1 WHERE id = $2`,
        [JSON.stringify(metadata), flowId]
    );

    return {
        success: true,
    };
}

async function getMostRecentRun({ taskId, accountId }) {
    const tasksDB = await db.getTasksDB();
    const { rows: recentRuns } = await tasksDB.query(
        `SELECT id FROM browserable.runs 
    WHERE flow_id = $1 AND account_id = $2 
    ORDER BY created_at DESC LIMIT 1`,
        [taskId, accountId]
    );
    if (recentRuns.length > 0) {
        return recentRuns[0].id;
    } else {
        return null;
    }
}

async function getRunStatus({
    runId,
    taskId,
    accountId,
    retainToolCallIds = false,
}) {
    const tasksDB = await db.getTasksDB();
    // Get run status
    const { rows: runs } = await tasksDB.query(
        `SELECT status, input_wait, id, live_status, private_data->>'workingOnNodeId' AS working_on_node_id 
            FROM browserable.runs 
            WHERE id = $1 AND flow_id = $2 AND account_id = $3`,
        [runId, taskId, accountId]
    );

    if (runs.length === 0) {
        return {
            status: null,
            toolCall: null,
            liveStatus: null,
        }
    }

    let runStatus = runs[0].status;
    let toolCall = runs[0].input_wait;
    let liveStatus = runs[0].live_status;
    let runStatusCopy = runStatus;

    if (runStatus === "running" && runs[0].working_on_node_id) {
        const { rows: nodes } = await tasksDB.query(
            `SELECT status, live_status, input_wait, id 
                FROM browserable.nodes 
                WHERE run_id = $1 AND id = $2`,
            [runs[0].id, runs[0].working_on_node_id]
        );

        if (nodes.length > 0 && nodes[0].live_status) {
            liveStatus = nodes[0].live_status;
        }

        if (nodes.length > 0 && runStatus !== "tool_call") {
            runStatus = nodes[0].status;

            if (
                nodes[0].input_wait &&
                nodes[0].status === "tool_call" &&
                nodes[0].input_wait != "completed"
            ) {
                toolCall = nodes[0].input_wait;
            }
        }
    }

    if (toolCall && !retainToolCallIds) {
        // delete nodeId, threadId, runId from toolCall
        delete toolCall.nodeId;
        delete toolCall.threadId;
        delete toolCall.runId;
    }

    return {
        status:
            runStatusCopy === "completed"
                ? "completed"
                : runStatusCopy === "error"
                ? "error"
                : runStatusCopy === "pending"
                ? "scheduled"
                : "running",
        detailedStatus: runStatus,
        toolCall,
        liveStatus,
    };
}

module.exports = {
    createFlow,
    changeFlowStatus,
    updateRunStatus,
    updateNodeStatus,
    updateRunLiveStatus,
    updateNodeLiveStatus,
    getNodeAgentLog,
    createDetailedOutputForNode,
    createUpdatesToDocuments,
    createDetailedOutputWithMessages,
    updateFlowCreatorStatus,
    turnOffFlowIfNoTriggers,
    getRunStatus,
    getMostRecentRun
};
