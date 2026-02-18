export interface BrowserableConfig {
  apiKey: string;
  baseURL?: string;
}

export interface CreateTaskOptions {
  task: string;
  agent?: string;
}

export interface PaginationOptions {
  page?: number;
  limit?: number;
}

export interface Task {
  id: string;
  status: 'active' | 'inactive';
  readable_name: string;
}

export interface TaskRun {
  id: string;
  created_at: string;
}

export interface TaskRunStatus {
  status: 'scheduled' | 'running' | 'completed' | 'error';
  detailedStatus?: string;
  latestMessage?: string;
  toolCall?: any;
  liveStatus?: any;
}

export interface TaskRunResult {
  status: 'scheduled' | 'running' | 'completed' | 'error';
  error?: string;
  output?: any;
  dataTable?: any[];
}

export interface TaskRunGifResult {
  status: 'pending' | 'error' | 'completed';
  url?: string;
  error?: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  total?: number;
  page?: number;
  limit?: number;
}

export interface WaitForRunOptions {
  /**
   * Interval in milliseconds between status checks
   * @default 1000
   */
  pollInterval?: number;

  /**
   * Maximum time in milliseconds to wait for completion
   * @default 300000 (5 minutes)
   */
  timeout?: number;

  /**
   * Callback function that will be called on every status change
   */
  onStatusChange?: (status: TaskRunStatus) => void;
} 
