import React, { useState, useEffect } from "react";
import { connect, useDispatch } from "react-redux";
import { useAppSelector } from "modules/hooks";
import { getLLMCalls } from "../actions/flow";
import { selectFlows, selectUser } from "../selectors";
import JSONViewerPopup from "./JSONViewerPopup";
import { STATUS } from "../literals";
import { readableDate } from "./utils";

function LLMCallsView({ flowId }) {
  const dispatch = useDispatch();
  const [pageSize, setPageSize] = useState(50);
  const [selectedJSON, setSelectedJSON] = useState(null);
  const [jsonType, setJsonType] = useState(null);

  const userState = useAppSelector(selectUser);
  const flowState = useAppSelector(selectFlows);
  const llmCalls = flowState.llmCalls;
  const { user, account } = userState;
  const accountId = account?.data?.id;

  const handlePageSizeChange = (event) => {
    // dont perform if status is running
    if (llmCalls.loading) {
      return;
    }

    setPageSize(Number(event.target.value));
    dispatch(
      getLLMCalls({
        flowId,
        pageSize: Number(event.target.value),
        pageNumber: 1,
        accountId,
      })
    );
  };

  const handlePrevPage = () => {
    // dont perform if status is running
    if (llmCalls.loading) {
      return;
    }

    if (llmCalls.pageNumber > 1) {
      dispatch(
        getLLMCalls({
          flowId,
          pageSize,
          pageNumber: llmCalls.pageNumber - 1,
          accountId,
        })
      );
    }
  };

  const handleNextPage = () => {
    // dont perform if status is running
    if (llmCalls.loading) {
      return;
    }

    if (llmCalls.pageNumber < llmCalls.totalPages) {
      dispatch(
        getLLMCalls({
          flowId,
          pageSize,
          pageNumber: llmCalls.pageNumber + 1,
          accountId,
        })
      );
    }
  };

  const handleRefresh = () => {
    // dont perform if status is running
    if (llmCalls.loading) {
      return;
    }

    dispatch(
      getLLMCalls({
        flowId,
        pageSize,
        pageNumber: llmCalls.pageNumber,
        accountId,
      })
    );
  };

  const handleViewJSON = (data, type) => {
    setSelectedJSON(data);
    setJsonType(type);
  };

  const handleCloseJSON = () => {
    setSelectedJSON(null);
    setJsonType(null);
  };

  const calculateCost = (model, inputTokens, outputTokens) => {
    const rates = {
      "gpt-4o": { input: 2.5 / 1000000, output: 10 / 1000000 },
      "gpt-4o-mini": { input: 0.15 / 1000000, output: 0.6 / 1000000 },
      "claude-3-5-sonnet": { input: 3 / 1000000, output: 15 / 1000000 },
      "claude-3-5-haiku": { input: 0.8 / 1000000, output: 4 / 1000000 },
      "gemini-2.5-flash": { input: 0.3 / 1000000, output: 2.5 / 1000000 },
      "deepseek-chat": { input: 0.27 / 1000000, output: 1.1 / 1000000 },
      "deepseek-reasoner": { input: 0.55 / 1000000, output: 2.19 / 1000000 },
    };

    const modelRates = rates[model] || { input: 0, output: 0 };
    return (
      inputTokens * modelRates.input +
      outputTokens * modelRates.output
    ).toFixed(4);
  };

  const calculateTimeDiff = (created, completed) => {
    if (!completed) return "-";
    const diff = (new Date(completed) - new Date(created)) / 1000;
    return `${diff.toFixed(2)}s`;
  };

  const formatUsecase = (usecase) => {
    if (!usecase) return "-";
    // Convert snake_case or camelCase to Title Case
    return usecase
      .split(/[_\s]|(?=[A-Z])/) // Split on underscore, space, or before capital letters
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ");
  };

  const calculateTotalCost = () => {
    return llmCalls.data
      .reduce((total, call) => {
        const cost = parseFloat(
          calculateCost(
            call.model,
            call.token_meta?.prompt_tokens || 0,
            call.token_meta?.completion_tokens || 0
          )
        );
        return total + cost;
      }, 0)
      .toFixed(4);
  };

  useEffect(() => {
    dispatch(getLLMCalls({ flowId, pageSize, pageNumber: 1, accountId }));
  }, [flowId, pageSize]);

  return (
    <div className="p-4 overflow-y-auto">
      <div className="flex justify-between items-center mb-4">
        {/* <select
          className="px-3 py-1 w-32 border border-gray-300 rounded-md "
          value={pageSize}
          onChange={handlePageSizeChange}
        >
          <option value={50}>50 per page</option>
        </select> */}
        <div></div>

        <div className="flex items-center text-xs gap-2">
          <button
            onClick={handlePrevPage}
            disabled={llmCalls.pageNumber <= 1}
            className={`px-3 py-1  rounded-md border ${
              llmCalls.pageNumber <= 1
                ? "bg-gray-100 text-gray-400 border-gray-200"
                : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
            }`}
          >
            Previous
          </button>
          <span className=" text-gray-600">
            Page {llmCalls.pageNumber} of {llmCalls.totalPages}
          </span>
          <button
            onClick={handleNextPage}
            disabled={llmCalls.pageNumber >= llmCalls.totalPages}
            className={`px-3 py-1  rounded-md border ${
              llmCalls.pageNumber >= llmCalls.totalPages
                ? "bg-gray-100 text-gray-400 border-gray-200"
                : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
            }`}
          >
            Next
          </button>
          <button
            onClick={handleRefresh}
            className="p-1 text-gray-600 hover:text-gray-800"
          >
            <i
              className={`ri-refresh-line block ${llmCalls.loading ? "animate-spin" : ""}`}
            ></i>
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-[1200px] divide-y divide-gray-200">
          <thead className="bg-gray-50 text-black font-semibold">
            <tr>
              <th className="px-6 py-1.5 text-left text-xs font-semibold py-1.5  min-w-[50px]">
                No.
              </th>
              <th className="px-6 py-1.5 text-left text-xs font-semibold py-1.5  min-w-[120px]">
                Time
              </th>
              <th className="px-6 py-1.5 text-left text-xs font-semibold py-1.5  min-w-[120px]">
                Model
              </th>
              <th className="px-6 py-1.5 text-left text-xs font-semibold w-[180px] min-w-[180px]  py-1.5 ">
                Input Tokens
              </th>
              <th className="px-6 py-1.5 text-left text-xs font-semibold    w-[180px] min-w-[180px]  py-1.5 ">
                Output Tokens
              </th>
              <th className="px-6 py-1.5 text-left text-xs font-semibold  py-1.5  min-w-[120px]">
                <span className="text-xs py-1.5">Cost&nbsp;($)</span>
              </th>
              <th className="px-6 py-1.5 text-left text-xs font-semibold py-1.5  min-w-[120px]">
                Usecase
              </th>
              <th className="px-6 py-1.5 text-left text-xs font-semibold py-1.5  min-w-[120px]">
                Prompt
              </th>
              <th className="px-6 py-1.5 text-left text-xs font-semibold py-1.5  min-w-[120px]">
                Response
              </th>
              <th className="px-6 py-1.5 text-left text-xs font-semibold py-1.5  min-w-[120px]">
                TokenMeta
              </th>
              <th className="px-6 py-1.5 text-left text-xs font-semibold py-1.5  min-w-[120px]">
                Metadata
              </th>
              <th className="px-6 py-1.5 text-left text-xs font-semibold py-1.5  min-w-[120px]">
                Created At
              </th>
              <th className="px-6 py-1.5 text-left text-xs font-semibold   py-1.5  min-w-[120px]">
                Completed At
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200 text-xs text-black">
            {llmCalls.data.map((call, index) => (
              <tr key={call.id} className="hover:bg-gray-50 transition-colors duration-150">
                <td className="px-6 py-1.5 whitespace-nowrap  py-1.5 min-w-[50px]">
                  {(llmCalls.pageNumber - 1) * pageSize + index + 1}.
                </td>
                <td className="px-6 py-1.5 whitespace-nowrap  py-1.5 min-w-[100px]">
                  {calculateTimeDiff(call.created_at, call.completed_at)}
                </td>
                <td className="px-6 py-1.5 whitespace-nowrap  py-1.5 min-w-[100px]">
                  {call.model}
                </td>
                <td className="px-6 py-1.5 whitespace-nowrap  py-1.5 min-w-[100px]">
                  {call.token_meta?.prompt_tokens || 0}
                </td>
                <td className="px-6 py-1.5 whitespace-nowrap  py-1.5 min-w-[100px]">
                  {call.token_meta?.completion_tokens || 0}
                </td>
                <td className="px-6 py-1.5 whitespace-nowrap  py-1.5 min-w-[100px]">
                  {calculateCost(
                    call.model,
                    call.token_meta?.prompt_tokens || 0,
                    call.token_meta?.completion_tokens || 0
                  )}
                </td>
                <td className="px-6 py-1.5 whitespace-nowrap  py-1.5 min-w-[100px]">
                  {formatUsecase(call.metadata?.usecase)}
                </td>
                <td className="px-6 py-1.5  py-1.5 min-w-[100px]">
                  <button
                    onClick={() => handleViewJSON(call.prompt, "prompt")}
                    className="text-blue-600 hover:text-blue-800 underline"
                  >
                    View JSON
                  </button>
                </td>
                <td className="px-6 py-1.5  py-1.5 min-w-[100px]">
                  <button
                    onClick={() => handleViewJSON(call.response, "response")}
                    className="text-blue-600 hover:text-blue-800 underline"
                  >
                    View JSON
                  </button>
                </td>
                <td className="px-6 py-1.5  py-1.5 min-w-[100px]">
                  <button
                    onClick={() =>
                      handleViewJSON(call.token_meta, "token meta")
                    }
                    className="text-blue-600 hover:text-blue-800 underline"
                  >
                    View JSON
                  </button>
                </td>
                <td className="px-6 py-1.5  py-1.5 min-w-[100px]">
                  <button
                    onClick={() => handleViewJSON(call.metadata, "metadata")}
                    className="text-blue-600 hover:text-blue-800 underline"
                  >
                    View JSON
                  </button>
                </td>
                <td className="px-6 py-1.5 whitespace-nowrap  py-1.5 min-w-[100px]">
                  {readableDate(call.created_at)}
                </td>
                <td className="px-6 py-1.5 whitespace-nowrap  py-1.5 min-w-[100px]">
                  {call.completed_at
                    ? readableDate(call.completed_at)
                    : "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <JSONViewerPopup
        isOpen={selectedJSON !== null}
        onClose={handleCloseJSON}
        data={selectedJSON}
        type={jsonType}
      />
    </div>
  );
}

export default LLMCallsView;
