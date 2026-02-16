const { baseAgent, BaseAgent } = require("./base");

class GenerativeAgent extends BaseAgent {
    constructor() {
        super();
        this.CODE = "GENERATIVE_AGENT";
        this.DETAILS = {
            description: `What agent does: Gives you an agent to call OpenAI compatible LLMs.
        When to use: Use this agent to call open ai explicitly for simple input (question) and output (answer) tasks.
        Speciality: The agent will figure out best model to use (if you do not specify one)
        Things to know: This agent is a simple vanilla dumb agent. Right now, you give one question (string) that it passes to LLMs to get a answer (string) and passed back. Essentially text to text.`,
            input: {
                parameters: {
                    task: "The task to be performed by the agent.",
                },
                required: ["task"],
                types: {
                    task: "string",
                },
            },
            output: {
                parameters: {
                    output: "The output of the agent (answer)",
                },
                required: ["output"],
                types: {
                    output: "string",
                },
            },
        };
    }

    getActions() {
        let baseActions = JSON.parse(JSON.stringify(super.getBaseActions()));
        baseActions.end = {
            description: "Ends this agent and gives handle back to the runner. Action code is 'end' NOT 'ACTION end' no need for extra garbage values in code..",
            input: {
                parameters: {
                    reasoning: "The reason for ending the agent. Give a detailed reasoning for ending the agent.",
                    output: "The output of the agent. Include ALL THE DETAILS FROM YOUR PROCESSING SO FAR. THE OUTPUT MUST INCLUDE ALL THE ANSWERS GENERATED WITHOUT ANY SUMMARIZING OR LOSING CONTEXT. REALLY DOUBLE DOWN ON THE DETAILS. THIS IS SO THAT THE NEXT AGENT CAN PICK UP FROM WHERE YOU LEFT OFF.",
                },
                required: [
                    "reasoning",
                    "output",
                ],
                types: {
                    reasoning: "string",
                    output: "string"
                },
            },
            output: {
                parameters: {
                    output: "The very very detailed output of the agent without any summarizing or losing context. REALLY DOUBLE DOWN ON THE DETAILS. THIS IS SO THAT THE NEXT AGENT CAN PICK UP FROM WHERE YOU LEFT OFF.",
                },
                required: ["output"],
                types: {
                    output: "string"
                },
            },
        };
        return {
            ...baseActions,
            question_answer: {
                description: "Ask Open AI for a question and get an answer",
                input: {
                    parameters: {
                        question: "string",
                        model: "string",
                    },
                    required: ["question"],
                    types: {
                        question: "string",
                        model: "string (one of [gpt-4o, gpt-4o-mini, qwen-plus, claude-3-5-sonnet, claude-3-5-haiku, gemini-2.5-flash, deepseek-chat, deepseek-reasoner])",
                    },
                },
                output: {
                    parameters: {
                        answer: "The output string from the agent",
                    },
                    required: ["answer"],
                    types: {
                        answer: "string",
                    },
                },
            },
        };
    }

    getActionFns() {
        const baseActionFns = super.getBaseActionFns();
        return {
            ...baseActionFns,
            question_answer: this._action_question_answer.bind(this),
        };
    }

    async _action_question_answer({ aiData, jarvis, runId, nodeId, threadId }) {
        const { question, model } = aiData;

        await jarvis.updateNodeStatus({
            agentCode: this.CODE,
            runId,
            nodeId,
            status: "Sending question to LLM",
        });

        const { answer } = await jarvis.callOpenAICompatibleLLMWithRetry({
            messages: [
                {
                    role: "user",
                    content: `Question: ${question}
                    
RULES: 
The answer MUST BE in string format. IF required, you can use markdown to format the answer. But it MUST BE a string.

    Output the answer: (JSON)
    key: "answer"
    value: string answer`,
                },
            ],
            models: [
                model,
                "gemini-2.5-flash",
                "gpt-4o-mini",
                "claude-3-5-haiku",
                "deepseek-chat",
                "qwen-plus",
            ],
            metadata: {
                runId,
                nodeId,
                agentCode: this.CODE,
                actionCode: "question_answer",
                usecase: "question_answer",
                flowId: jarvis.flow_id,
                accountId: jarvis.account_id,
                threadId,
            },
            max_attempts: 3,
        });

        await jarvis.updateNodeStatus({
            agentCode: this.CODE,
            runId,
            nodeId,
            status: "Got answer from LLM",
        });

        await jarvis.updateNodeUserLog({
            agentCode: this.CODE,
            runId,
            nodeId,
            threadId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: "Got answer from Generative Agent",
                            associatedData: [
                                {
                                    type: "markdown",
                                    markdown: question,
                                    name: "Question",
                                },
                                {
                                    type: "markdown",
                                    markdown: answer,
                                    name: "Answer",
                                },
                            ],
                        },
                    ],
                },
            ],
        });

        await jarvis.updateNodeDebugLog({
            runId,
            nodeId,
            threadId,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: "Got answer from Generative Agent",
                            associatedData: [
                                {
                                    type: "code",
                                    code: {
                                        question,
                                        answer,
                                        model,
                                    },
                                    name: "Question and Answer",
                                },
                            ],
                        },
                    ],
                },
            ],
        });

        await jarvis.updateNodeAgentLog({
            agentCode: this.CODE,
            runId,
            nodeId,
            messages: [
                {
                    role: "jarvis",
                    content: answer,
                },
            ],
        });

        await jarvis.scheduleNodeLooper({
            runId,
            nodeId,
            threadId,
            agentCode: this.CODE,
            delay: 0,
        });
    }

    async _init({
        runId,
        nodeId,
        threadId,
        input, // to start the agent
        jarvis,
    }) {
        await jarvis.updateNodeStatus({
            agentCode: this.CODE,
            runId,
            nodeId,
            status: "Started generative agent",
        });

        // any re-usable data can be stored here.
        await jarvis.updateNodeKeyVal({
            agentCode: this.CODE,
            runId,
            nodeId,
            data: {},
        });

        // Delay here is decided deterministically by agent creator. Ex: if any rate limits are present for different models or users.
        await jarvis.scheduleNodeLooper({
            runId,
            nodeId,
            threadId,
            input,
            agentCode: this.CODE,
            delay: 0,
        });
    }

    async _looper({ input, nodeId, threadId, runId, jarvis }) {
        await jarvis.updateNodeStatus({
            agentCode: this.CODE,
            runId,
            nodeId,
            status: "Processing generative agent",
        });

        const action = await jarvis.decideAction({
            runId,
            agentCode: this.CODE,
            nodeId,
            threadId,
            input,
            possibleActions: Object.keys(this.getActions())
        });

        const { actionCode, aiData } = action;

        const actionId = await jarvis.generateUUID();

        // schedule to run the action
        await jarvis.scheduleAction({
            runId,
            agentCode: this.CODE,
            nodeId,
            threadId,
            actionCode,
            actionId,
            aiData,
            delay: aiData.delay || 0,
        });
    }
}

const generativeAgent = new GenerativeAgent();

module.exports = {
    agent: generativeAgent,
    GenerativeAgent,
};
