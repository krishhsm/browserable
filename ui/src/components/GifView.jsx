import React, { useState, useEffect } from "react";
import { useDispatch } from "react-redux";
import { useAppSelector } from "modules/hooks";
import { getFlowRuns } from "../actions/flow";
import { selectFlows, selectUser } from "../selectors";

function GifView({ flowId }) {
  const dispatch = useDispatch();
  const userState = useAppSelector(selectUser);
  const flowState = useAppSelector(selectFlows);
  const { account } = userState;
  const accountId = account?.data?.id;
  const [pageSize] = useState(50);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [regenError, setRegenError] = useState(null);
  const flowRuns = flowState.runs?.[flowId] || {
    data: [],
    pageNumber: 1,
    totalPages: 1,
    loading: false,
  };

  useEffect(() => {
    dispatch(getFlowRuns({ flowId, pageSize, pageNumber: 1, accountId }));
  }, [flowId, pageSize, accountId]);

  // Show loader while fetching initial runs
  if (flowRuns.loading && !flowRuns.data?.length) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="animate-spin">
          <i className="ri-loader-4-line text-2xl text-gray-400"></i>
        </div>
      </div>
    );
  }

  const firstRun = flowRuns.data?.[0];
  const gifUrl = firstRun?.private_data?.gifUrl;
  const runId = firstRun?.id;

  const handleRegenerateGif = async () => {
    if (!flowId || !runId) return;
    setIsRegenerating(true);
    setRegenError(null);
    try {
      const resp = await fetch(
        `${process.env.REACT_APP_TASKS_PUBLIC_URL}/test-utils/gif/${flowId}/${runId}`
      );
      if (!resp.ok) {
        throw new Error(`Failed to regenerate GIF (${resp.status})`);
      }
      await resp.json();
      dispatch(getFlowRuns({ flowId, pageSize, pageNumber: 1, accountId }));
    } catch (err) {
      setRegenError(err.message || "Failed to regenerate GIF");
    } finally {
      setIsRegenerating(false);
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
      <div className="flex items-center gap-3">
        <button
          className="rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          onClick={handleRegenerateGif}
          disabled={isRegenerating || !runId}
        >
          {isRegenerating ? "Regenerating..." : "Reload GIF"}
        </button>
        {regenError ? (
          <div className="text-sm text-red-500">{regenError}</div>
        ) : null}
      </div>
      {gifUrl ? (
        <img
          src={gifUrl}
          alt="Flow GIF"
          className="max-w-full max-h-full border-2 border-gray-300 rounded-md"
        />
      ) : (
        <div className="text-gray-500">GIF not available</div>
      )}
    </div>
  );
}

export default GifView; 
