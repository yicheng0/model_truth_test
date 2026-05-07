export type Channel = {
  id: string;
  name: string;
  provider_type: string;
  role: ChannelRole;
  base_url?: string | null;
  model_name?: string | null;
  enabled: boolean;
};

export type ChannelRole = 'gold' | 'official_cloud' | 'candidate' | 'negative';

export type TestSuite = {
  id: string;
  name: string;
  description?: string | null;
  version?: string | null;
  visibility?: string;
};

export type TestCase = {
  id: string;
  suite_id: string;
  module: string;
  sort_order: number;
  title: string;
  prompt: string;
  system_prompt?: string | null;
  request_params?: Record<string, unknown> | null;
  scoring_rules?: Record<string, unknown> | null;
  is_hidden?: boolean;
  enabled?: boolean;
};

export type Run = {
  id: string;
  suite_id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'canceled';
  repeat_count: number;
  concurrency: number;
  total_jobs: number;
  completed_jobs: number;
  started_at?: string | null;
  finished_at?: string | null;
  created_at?: string | null;
};

export type RunChannel = {
  id: string;
  run_id: string;
  channel_id: string;
  role_in_run: ChannelRole;
};

export type Result = {
  id: string;
  run_id: string;
  test_case_id: string;
  channel_id: string;
  attempt_index: number;
  normalized_response?: Record<string, any> | null;
  raw_request?: Record<string, any> | null;
  raw_response?: Record<string, any> | null;
  metrics?: Record<string, any> | null;
  score: number;
  labels?: string[] | null;
  created_at?: string | null;
};

export type Comparison = {
  id: string;
  run_id: string;
  test_case_id: string;
  candidate_channel_id: string;
  gold_similarity: number;
  official_cloud_similarity: number;
  protocol_score: number;
  capability_score: number;
  final_score: number;
  labels?: string[] | null;
};

export type Report = {
  id: string;
  run_id: string;
  channel_id: string;
  final_score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'E';
  summary?: string | null;
  evidence?: Record<string, any> | null;
  markdown?: string | null;
};

export type RunResults = {
  run: Run;
  run_channels: RunChannel[];
  results: Result[];
  comparisons: Comparison[];
  reports: Report[];
};
