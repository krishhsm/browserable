const {
    agents: {
        deepresearch: {
            buildGenerateSerpsPrompt,
            buildProcessSerpsPrompt,
            buildParseSearchResultsPrompt,
        },
    },
} = require("../../prompts");
const { callOpenAICompatibleLLMWithRetry } = require("../../services/llm");
const browserService = require("../../services/browser");
const { encode } = require("gpt-tokenizer/encoding/cl100k_base");

// V1 is pure scraping.
// V2 we might do interactions as well.

async function generateSerps({
    task,
    numSerps,
    learningsTrail,
    runId,
    nodeId,
    flowId,
    agentCode,
    accountId,
}) {
    const messages = buildGenerateSerpsPrompt({
        task,
        numSerps,
        learningsTrail,
    });

    const response = await callOpenAICompatibleLLMWithRetry({
        messages,
        models: [
            "gemini-2.5-flash",
            "deepseek-chat",
            "gpt-4o-mini",
            "claude-3-5-haiku",
            "qwen-plus",
        ],
        metadata: {
            runId,
            nodeId,
            flowId,
            agentCode,
            accountId,
            usecase: "generate-serps",
        },
        max_attempts: 4,
    });

    const serps = response.serps;

    return serps;
}

async function searchAndScrape({
    query,
    maxUrls,
    runId,
    nodeId,
    flowId,
    accountId,
    agentCode,
}) {
    try {
        let results = [];
        let scrapedPageContent = "";

        try {
            let gSearchResults = await browserService.scrape({
                url: `https://www.google.com/search?q=${encodeURIComponent(
                    query
                )}`,
                onlyMainContent: true,
                formats: ["html", "markdown", "links"],
            });

            scrapedPageContent = `
------
HTML
-------
${gSearchResults?.data?.html || ""}
`;

            // trim the scrapedPageContent to 60000 characters
            scrapedPageContent = scrapedPageContent.slice(0, 60000);

            // console.log("scrapedPageContent", scrapedPageContent);
        } catch (err) {
            console.log("Error scraping search results", err);
        }

        if (scrapedPageContent) {
            try {
                const response = await callOpenAICompatibleLLMWithRetry({
                    messages: buildParseSearchResultsPrompt({
                        pageContent: scrapedPageContent,
                        searchQuery: query,
                    }),
                    models: [
                        "gemini-2.5-flash",
                        "deepseek-chat",
                        "gpt-4o-mini",
                        "claude-3-5-haiku",
                        "qwen-plus",
                    ],
                    max_attempts: 4,
                    metadata: {
                        runId,
                        nodeId,
                        flowId,
                        agentCode,
                        accountId,
                        usecase: "parse-search-results",
                    },
                });

                results = response.results;
            } catch (err) {
                console.log("Error parsing search results", err);
            }
        }

        // console.log("gSearchResults", results, query);

        // slice gSearchResults.data.links to maxUrls
        const links = results.map((result) => result.url).slice(0, maxUrls);

        // scrape each link
        let scrapedLinks = await Promise.all(
            links.map(async (link) => {
                try {
                    const scrapeResult = await browserService.scrape({
                        url: link,
                        onlyMainContent: true,
                        formats: ["markdown", "links"],
                    });

                    // console.log("scrapeResult", scrapeResult, link);

                    return {
                        url: link,
                        content: scrapeResult?.data?.markdown || "",
                    };
                } catch (err) {
                    console.log("Error scraping link", err);
                    return null;
                }
            })
        );

        scrapedLinks = scrapedLinks.filter(
            (data) => !!data && data.content && data.content.trim().length > 0
        );

        let scrapedContent = "";

        for (const scrapedLink of scrapedLinks) {
            scrapedContent += `# ${scrapedLink.url}\n\n${scrapedLink.content}\n\n`;
        }

        // trim the scrapedContent to 60000 characters
        scrapedContent = scrapedContent.slice(0, 60000);

        const processSerpsResponse = await callOpenAICompatibleLLMWithRetry({
            messages: buildProcessSerpsPrompt({
                query,
                scrapedContent,
            }),
            models: [
                "gemini-2.5-flash",
                "deepseek-chat",
                "gpt-4o-mini",
                "claude-3-5-haiku",
                "qwen-plus",
            ],
            metadata: {
                runId,
                nodeId,
                flowId,
                agentCode,
                accountId,
                usecase: "process-serps",
            },
            max_attempts: 4,
        });

        const { learnings, followupQuestions } = processSerpsResponse;

        return {
            urls: scrapedLinks.map((link) => link.url),
            learnings,
            followupQuestions,
            searchPageContent: scrapedPageContent,
            searchPageResults: results,
            scrapedLinks,
        };
    } catch (err) {
        console.log("Error searching and scraping", err);
        return {
            urls: [],
            learnings: [],
            followupQuestions: [],
        };
    }
}

module.exports = {
    generateSerps,
    searchAndScrape,
};
