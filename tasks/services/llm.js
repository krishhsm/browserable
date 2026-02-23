var axios = require("axios");
const axiosInstance = axios.create({
    withCredentials: true,
});
const db = require("../services/db");

async function fixJsonTextWithLLM({
    text,
    max_tokens = 3000,
    model = "gpt-4o-mini",
    metadata = {},
}) {
    // call the llm with the text and ask it to return properly formatted json
    const response = await callOpenAICompatibleLLMWithRetry({
        messages: [
            {
                role: "user",
                content: `
You are a JSON parser. You are given a JSON string that is not properly formatted. Please fix the JSON string and return it.

JSON string:
${text}

OUTPUT: (JSON ONLY)
ONLY PRINT THE JSON OBJECT AND NOTHING ELSE. PLEASE DO NOT PRINT ANYTHING ELSE.
`,
            },
        ],
        model,
        max_tokens,
        dontTryParser: true,
        metadata,
        max_attempts: 1,
    });

    return response;
}

async function callOpenAICompatibleLLMWithRetry({
    messages,
    model,
    models,
    max_tokens,
    dontTryParser = false,
    metadata = {},
    max_attempts = 3,
    jsonSchema,
}) {
    if (!models && model) {
        models = [model];
    }

    if (models.length < max_attempts) {
        // fill models with the model until the length is max_attempts
        for (let i = models.length; i < max_attempts; i++) {
            models.push(model);
        }
    }

    const accountId = metadata.accountId;
    let accountSpecificModelKeys = {};
    let serverSpecificModelKeys = {};

    if (accountId) {
        const tasksDB = await db.getTasksDB();
        let { rows: llmKeys } = await tasksDB.query(
            `SELECT metadata FROM browserable.accounts WHERE id = $1`,
            [accountId]
        );

        if (llmKeys.length > 0) {
            llmKeys = (llmKeys[0].metadata || {}).userApiKeys || {};

            if (llmKeys["openai"]) {
                accountSpecificModelKeys["gpt-4o"] = llmKeys["openai"];
                accountSpecificModelKeys["gpt-4o-mini"] = llmKeys["openai"];
            }

            if (llmKeys["deepseek"]) {
                accountSpecificModelKeys["deepseek-chat"] = llmKeys["deepseek"];
                accountSpecificModelKeys["deepseek-reasoner"] =
                    llmKeys["deepseek"];
            }

            if (llmKeys["claude"]) {
                accountSpecificModelKeys["claude-3-5-sonnet"] =
                    llmKeys["claude"];
                accountSpecificModelKeys["claude-3-5-haiku"] =
                    llmKeys["claude"];
            }

            if (llmKeys["gemini"]) {
                accountSpecificModelKeys["gemini-2.5-flash"] =
                    llmKeys["gemini"];
            }

            if (llmKeys["qwen"]) {
                accountSpecificModelKeys["qwen-plus"] = llmKeys["qwen"];
            }
        }
    }

    // if (!!process.env.OPENAI_API_KEY) {
    //     serverSpecificModelKeys["gpt-4o"] = process.env.OPENAI_API_KEY;
    //     serverSpecificModelKeys["gpt-4o-mini"] = process.env.OPENAI_API_KEY;
    // }

    if (!!process.env.DEEPSEEK_API_KEY) {
        serverSpecificModelKeys["deepseek-chat"] = process.env.DEEPSEEK_API_KEY;
        serverSpecificModelKeys["deepseek-reasoner"] =
            process.env.DEEPSEEK_API_KEY;
    }

    if (!!process.env.CLAUDE_API_KEY) {
        serverSpecificModelKeys["claude-3-5-sonnet"] =
            process.env.CLAUDE_API_KEY;
        serverSpecificModelKeys["claude-3-5-haiku"] =
            process.env.CLAUDE_API_KEY;
    }

    if (!!process.env.GEMINI_API_KEY) {
        serverSpecificModelKeys["gemini-2.5-flash"] =
            process.env.GEMINI_API_KEY;
    }

    if (!!process.env.QWEN_API_KEY) {
        serverSpecificModelKeys["qwen-plus"] = process.env.QWEN_API_KEY;
    }

    const modelKeys = Object.assign(
        {},
        accountSpecificModelKeys,
        serverSpecificModelKeys
    );

    models = models.filter((model) => modelKeys[model]);

    if (models.length === 0) {
        throw new Error("No valid models found");
    }

    // repeat the last model in the list until the length is max_attempts
    while (models.length < max_attempts) {
        models.push(models[models.length - 1]);
    }

    for (let attempt = 0; attempt < max_attempts; attempt++) {
        try {
            return await callOpenAICompatibleLLM({
                messages,
                model: models[attempt],
                max_tokens,
                dontTryParser,
                metadata,
                attempt,
                modelKeys,
                jsonSchema,
            });
        } catch (e) {
            if (attempt === max_attempts - 1) {
                throw e;
            }
        }
    }
}

async function callOpenAICompatibleLLM({
    messages,
    model,
    max_tokens,
    dontTryParser = false,
    metadata = {},
    modelKeys = {},
    jsonSchema,
}) {
    const tasksDB = await db.getTasksDB();
    const createdAt = new Date();
    let copyOfMessages = JSON.parse(JSON.stringify(messages));

    const models = {
        "qwen-plus": {
            endpoint:
                "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
            apiKey: modelKeys["qwen-plus"],
            actualModel: "qwen-plus",
            supportedImageAs: "base64",
            supportedJsonSchema: true, // yet to test this.
            supportedJsonOutput: true, // yet to test this.
        },
        "gpt-4o": {
            endpoint: "https://api.openai.com/v1/chat/completions",
            apiKey: modelKeys["gpt-4o"],
            actualModel: "gpt-4o",
            supportedImageAs: !!Number(process.env.SINGLE_USER_MODE)
                ? "base64"
                : "url",
            supportedJsonSchema: true,
            supportedJsonOutput: true,
        },
        "gpt-4o-mini": {
            endpoint: "https://api.openai.com/v1/chat/completions",
            apiKey: modelKeys["gpt-4o-mini"],
            actualModel: "gpt-4o-mini",
            supportedImageAs: !!Number(process.env.SINGLE_USER_MODE)
                ? "base64"
                : "url",
            supportedJsonSchema: true,
            supportedJsonOutput: true,
        },
        "gemini-2.5-flash": {
            endpoint:
                "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
            apiKey: modelKeys["gemini-2.5-flash"],
            actualModel: "gemini-2.5-flash",
            supportedImageAs: "base64",
            supportedJsonSchema: true,
            supportedJsonOutput: true,
        },
        "deepseek-chat": {
            endpoint: "https://api.deepseek.com/chat/completions",
            apiKey: modelKeys["deepseek-chat"],
            actualModel: "deepseek-chat",
            supportedImageAs: "",
            supportedJsonSchema: true,
            supportedJsonOutput: true,
        },
        "deepseek-reasoner": {
            endpoint: "https://api.deepseek.com/chat/completions",
            apiKey: modelKeys["deepseek-reasoner"],
            actualModel: "deepseek-reasoner",
            supportedImageAs: "",
            supportedJsonSchema: false,
            supportedJsonOutput: true,
        },
        "claude-3-5-sonnet": {
            endpoint: "https://api.anthropic.com/v1/chat/completions",
            apiKey: modelKeys["claude-3-5-sonnet"],
            actualModel: "claude-3-5-sonnet-latest",
            supportedImageAs: "base64",
            supportedJsonSchema: false,
            supportedJsonOutput: false,
        },
        "claude-3-5-haiku": {
            endpoint: "https://api.anthropic.com/v1/chat/completions",
            apiKey: modelKeys["claude-3-5-haiku"],
            actualModel: "claude-3-5-haiku-latest",
            supportedImageAs: "base64",
            supportedJsonSchema: false,
            supportedJsonOutput: false,
        },
    };

    // Insert initial record without response
    const initialInsertResult = await tasksDB.query(
        `INSERT INTO browserable.llm_calls (prompt, model, metadata, created_at, account_id) VALUES ($1::json, $2, $3::json, $4, $5) RETURNING id`,
        [
            JSON.stringify(messages),
            model,
            JSON.stringify(metadata),
            createdAt,
            metadata.accountId || null,
        ]
    );
    const callId = initialInsertResult.rows[0].id;
    let res;

    try {
        const supportedImageAs = models[model].supportedImageAs;

        if (supportedImageAs === "base64") {
            // if any image is present, convert the url to base64
            for (let i = 0; i < copyOfMessages.length; i++) {
                if (Array.isArray(copyOfMessages[i].content)) {
                    for (let j = 0; j < copyOfMessages[i].content.length; j++) {
                        if (copyOfMessages[i].content[j].type === "image_url") {
                            const fetchedImg = await axios.get(
                                copyOfMessages[i].content[j].image_url.url,
                                {
                                    responseType: "arraybuffer",
                                }
                            );
                            const base64Image = Buffer.from(
                                fetchedImg.data
                            ).toString("base64");
                            const mimeType = fetchedImg.headers["content-type"];
                            copyOfMessages[i].content[j] = {
                                type: "image_url",
                                image_url: {
                                    url: `data:${mimeType};base64,${base64Image}`,
                                },
                            };
                        }
                    }
                }
            }
        } else if (!supportedImageAs) {
            // this model doesn't support images but the person is asking for it. for now we fallback to gpt-4o
            // check if gpt-4o is available
            if (modelKeys["gpt-4o"]) {
                model = "gpt-4o";
            } else {
                throw new Error("No valid image models found");
            }
        }

        res = await axiosInstance.post(
            models[model].endpoint,
            {
                model: models[model].actualModel,
                response_format: { type: "json_object" },
                // temperature: 1,
                max_tokens: max_tokens || 3000,
                // top_p: 1,
                // frequency_penalty: 0,
                // presence_penalty: 0,
                messages: copyOfMessages,
                ...(models[model].supportedJsonSchema && jsonSchema
                    ? {
                          response_format: jsonSchema
                      }
                    : models[model].supportedJsonOutput
                    ? { response_format: { type: "json_object" } }
                    : {}),
            },
            {
                headers: {
                    Authorization: `Bearer ${models[model].apiKey}`,
                },
            }
        );

        // Process response
        let jsonText = res.data.choices[0].message.content;
        jsonText = jsonText.trim();
        if (jsonText.startsWith("```json") && jsonText.endsWith("```")) {
            jsonText = jsonText.slice(6, -3);
        }
        jsonText = jsonText.trim();

        const jsonResponse = JSON.parse(jsonText);

        const tokenMeta = res.data.usage;

        // Update record with successful response
        await tasksDB.query(
            `UPDATE browserable.llm_calls SET response = $1::json, completed_at = $2, token_meta = $3::json WHERE id = $4`,
            [
                JSON.stringify(jsonResponse),
                new Date(),
                JSON.stringify(tokenMeta),
                callId,
            ]
        );

        return jsonResponse;
    } catch (e) {
        console.log("Error in callOpenAICompatibleLLM", e);

        if (!dontTryParser && res && res.data.choices[0].message.content) {
            try {
                const fixedJson = await fixJsonTextWithLLM({
                    text: res.data.choices[0].message.content,
                    model,
                    max_tokens,
                    metadata,
                });

                // Update record with fixed response
                await tasksDB.query(
                    `UPDATE browserable.llm_calls SET response = $1::json, completed_at = $2 WHERE id = $3`,
                    [JSON.stringify(fixedJson), new Date(), callId]
                );

                return fixedJson;
            } catch (fixError) {
                // Update record with error response
                await tasksDB.query(
                    `UPDATE browserable.llm_calls SET response = $1::json, completed_at = $2 WHERE id = $3`,
                    [
                        JSON.stringify({
                            error: fixError.message,
                            originalResponse:
                                res.data.choices[0].message.content,
                        }),
                        new Date(),
                        callId,
                    ]
                );

                throw fixError;
            }
        } else {
            // Update record with error response
            await tasksDB.query(
                `UPDATE browserable.llm_calls SET response = $1::json, completed_at = $2 WHERE id = $3`,
                [JSON.stringify({ error: e.message }), new Date(), callId]
            );

            throw e;
        }
    }
}

async function updateMetadataOfLLMCall({
    uniqueKeyInMetadata,
    uniqueValInMetadata,
    metadataToUpdate,
}) {
    const tasksDB = await db.getTasksDB();

    // get the llm calls with metadata that has the uniqueKeyInMetadata and uniqueValInMetadata
    const llmCalls = await tasksDB.query(
        `SELECT id, metadata FROM browserable.llm_calls WHERE metadata->>'${uniqueKeyInMetadata}' = $1`,
        [uniqueValInMetadata]
    );

    // update the metadata of the llm calls
    for (const llmCall of llmCalls.rows) {
        llmCall.metadata = {
            ...(llmCall.metadata || {}),
            ...(metadataToUpdate || {}),
        };

        await tasksDB.query(
            `UPDATE browserable.llm_calls SET metadata = $1::json WHERE id = $2`,
            [JSON.stringify(llmCall.metadata), llmCall.id]
        );
    }
}

module.exports = {
    updateMetadataOfLLMCall,
    callOpenAICompatibleLLMWithRetry,
};
