// DB 스키마. 불변 테이블은 트리거로 UPDATE·DELETE를 막는다.
export const MIGRATIONS: { version: string; sql: string }[] = [
  {
    version: "001_init",
    sql: `
create table projects (
  project_id uuid primary key,
  title text not null,
  type text not null,
  phase text not null,
  round int not null default 0,
  state_version int not null,
  state jsonb not null,
  current_plan_version_id uuid,
  unresolved_critical_count int not null default 0,
  end_reason text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table state_snapshots (
  project_id uuid not null references projects(project_id),
  state_version int not null,
  state jsonb not null,
  created_at timestamptz not null,
  primary key (project_id, state_version)
);

create table events (
  event_id uuid primary key,
  project_id uuid not null references projects(project_id),
  action text not null,
  before_version int,
  after_version int not null,
  request_key text not null unique,
  actor text not null,
  reason text,
  result jsonb,
  created_at timestamptz not null
);
create index events_project_idx on events(project_id, created_at);

create table plan_versions (
  plan_version_id uuid primary key,
  project_id uuid not null references projects(project_id),
  parent_version_id uuid,
  version_no int not null,
  content jsonb not null,
  change_summary text not null,
  confirmed_at timestamptz not null,
  unique (project_id, version_no)
);

create table sources (
  project_id uuid not null references projects(project_id),
  source_id text not null,
  revision_of text,
  title text not null,
  body text not null,
  content_hash text not null,
  char_count int not null,
  created_at timestamptz not null,
  primary key (project_id, source_id)
);

create table ai_runs (
  run_id uuid primary key,
  project_id uuid not null references projects(project_id),
  task text not null,
  role text,
  status text not null,
  attempts int not null default 0,
  request_key text not null,
  plan_version_id uuid,
  input_hash text not null,
  prompt_version text not null,
  payload jsonb not null,
  runner_id uuid,
  lease_expires_at timestamptz,
  claimed_at timestamptz,
  result_text text,
  result_json jsonb,
  output_mode text,
  model_slug text,
  provider_request_id text,
  usage jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null,
  finished_at timestamptz
);
create index ai_runs_queue_idx on ai_runs(status, created_at);
create index ai_runs_project_idx on ai_runs(project_id, created_at);

create table output_snapshots (
  output_snapshot_id uuid primary key,
  project_id uuid not null references projects(project_id),
  plan_version_id uuid not null,
  source_set jsonb not null,
  issue_states jsonb not null,
  decision_status jsonb not null,
  created_at timestamptz not null
);

create table artifacts (
  artifact_id uuid primary key,
  output_snapshot_id uuid not null references output_snapshots(output_snapshot_id),
  project_id uuid not null references projects(project_id),
  type text not null,
  content jsonb not null,
  validation jsonb not null,
  unresolved_critical_ids jsonb not null,
  generated_at timestamptz not null
);

create table runners (
  runner_id uuid primary key,
  label text not null,
  host_id text,
  token_hash text not null unique,
  status jsonb not null default '{}'::jsonb,
  created_at timestamptz not null,
  last_seen_at timestamptz,
  revoked_at timestamptz
);

create table pairing_codes (
  code_hash text primary key,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null
);

create table usage_counters (
  scope text primary key,
  count int not null default 0
);

create table app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null
);

create or replace function forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'immutable table: %', tg_table_name;
end;
$$;

create trigger state_snapshots_immutable before update or delete on state_snapshots for each row execute function forbid_mutation();
create trigger events_immutable before update or delete on events for each row execute function forbid_mutation();
create trigger plan_versions_immutable before update or delete on plan_versions for each row execute function forbid_mutation();
create trigger sources_immutable before update or delete on sources for each row execute function forbid_mutation();
create trigger output_snapshots_immutable before update or delete on output_snapshots for each row execute function forbid_mutation();
create trigger artifacts_immutable before update or delete on artifacts for each row execute function forbid_mutation();
`,
  },
];
