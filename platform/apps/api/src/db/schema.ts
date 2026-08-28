export const schemaSql = `
CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  summary text NOT NULL,
  root_path text NOT NULL UNIQUE,
  config_path text NOT NULL,
  source_kind text NOT NULL DEFAULT 'legacy_local' CHECK (source_kind IN ('legacy_local', 'remote_git')),
  repository_url text,
  repository_host text,
  requested_ref text,
  credential_profile_id text,
  repository_state text NOT NULL DEFAULT 'ready' CHECK (repository_state IN ('importing', 'ready', 'syncing', 'failed')),
  active_revision text,
  definition_mode text NOT NULL DEFAULT 'repository' CHECK (definition_mode IN ('repository', 'managed')),
  definition_version text,
  operation_id uuid,
  operation_kind text CHECK (operation_kind IS NULL OR operation_kind IN ('import', 'sync')),
  operation_state text CHECK (operation_state IS NULL OR operation_state IN ('queued', 'running', 'failed')),
  operation_stage text CHECK (operation_stage IS NULL OR operation_stage IN (
    'validating', 'fetching', 'resolving', 'materializing', 'indexing', 'publishing'
  )),
  operation_progress integer CHECK (operation_progress IS NULL OR operation_progress BETWEEN 0 AND 100),
  operation_message text,
  last_synced_at timestamptz,
  repository_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'legacy_local';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS repository_url text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS repository_host text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS requested_ref text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS credential_profile_id text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS repository_state text NOT NULL DEFAULT 'ready';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS active_revision text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS definition_mode text NOT NULL DEFAULT 'repository';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS definition_version text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS operation_id uuid;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS operation_kind text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS operation_state text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS operation_stage text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS operation_progress integer;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS operation_message text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS repository_error_message text;

UPDATE projects
SET source_kind = 'legacy_local', repository_state = 'ready'
WHERE source_kind IS NULL OR repository_state IS NULL;

DO $project_cloud_checks$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'projects'::regclass AND conname = 'projects_source_kind_check'
  ) THEN
    ALTER TABLE projects ADD CONSTRAINT projects_source_kind_check
      CHECK (source_kind IN ('legacy_local', 'remote_git'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'projects'::regclass AND conname = 'projects_repository_state_check'
  ) THEN
    ALTER TABLE projects ADD CONSTRAINT projects_repository_state_check
      CHECK (repository_state IN ('importing', 'ready', 'syncing', 'failed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'projects'::regclass AND conname = 'projects_definition_mode_check'
  ) THEN
    ALTER TABLE projects ADD CONSTRAINT projects_definition_mode_check
      CHECK (definition_mode IN ('repository', 'managed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'projects'::regclass AND conname = 'projects_remote_source_check'
  ) THEN
    ALTER TABLE projects ADD CONSTRAINT projects_remote_source_check CHECK (
      source_kind = 'legacy_local'
      OR (
        repository_url IS NOT NULL
        AND repository_url ~ '^https://'
        AND repository_host IS NOT NULL
        AND requested_ref IS NOT NULL
        AND definition_mode = 'managed'
        AND definition_version IS NOT NULL
      )
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'projects'::regclass AND conname = 'projects_active_revision_check'
  ) THEN
    ALTER TABLE projects ADD CONSTRAINT projects_active_revision_check CHECK (
      active_revision IS NULL OR active_revision ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'projects'::regclass AND conname = 'projects_operation_check'
  ) THEN
    ALTER TABLE projects ADD CONSTRAINT projects_operation_check CHECK (
      (operation_id IS NULL AND operation_kind IS NULL AND operation_state IS NULL
        AND operation_stage IS NULL AND operation_progress IS NULL AND operation_message IS NULL)
      OR
      (operation_id IS NOT NULL AND operation_kind IN ('import', 'sync')
        AND operation_state IN ('queued', 'running', 'failed')
        AND operation_stage IN ('validating', 'fetching', 'resolving', 'materializing', 'indexing', 'publishing')
        AND operation_progress BETWEEN 0 AND 100 AND operation_message IS NOT NULL)
    );
  END IF;
END
$project_cloud_checks$;

CREATE TABLE IF NOT EXISTS project_agent_settings (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  repo_alias text NOT NULL UNIQUE,
  default_provider_id text NOT NULL DEFAULT 'openai'
    CHECK (default_provider_id IN ('openai', 'lmstudio', 'ollama', 'custom')),
  sandbox_blueprint_id text NOT NULL DEFAULT 'default',
  sandbox_blueprint_version text NOT NULL DEFAULT '1',
  enabled_mcp_server_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (repo_alias ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND length(repo_alias) <= 64),
  CHECK (sandbox_blueprint_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
    AND length(sandbox_blueprint_id) <= 80),
  CHECK (sandbox_blueprint_version ~ '^[A-Za-z0-9][A-Za-z0-9._:+-]*$'
    AND length(sandbox_blueprint_version) <= 128),
  CHECK (jsonb_typeof(enabled_mcp_server_ids) = 'array')
);

-- Existing projects receive collision-free internal aliases. New bind flows
-- replace these with a friendly URL-derived alias through the versioned store.
INSERT INTO project_agent_settings (
  project_id,
  repo_alias,
  default_provider_id,
  sandbox_blueprint_id,
  sandbox_blueprint_version,
  enabled_mcp_server_ids
)
SELECT
  p.id,
  'repo-' || replace(p.id::text, '-', ''),
  'openai',
  'default',
  '1',
  '[]'::jsonb
FROM projects p
ON CONFLICT (project_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS workflow_runs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  objective text NOT NULL,
  change_contract jsonb,
  base_revision text,
  definition_version text,
  status text NOT NULL CHECK (status IN ('active', 'completed')),
  artifact_paths jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS artifact_paths jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS change_contract jsonb;
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS base_revision text;
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS definition_version text;

DO $workflow_run_cloud_checks$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'workflow_runs'::regclass AND conname = 'workflow_runs_base_revision_check'
  ) THEN
    ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_base_revision_check CHECK (
      base_revision IS NULL OR base_revision ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'
    );
  END IF;
END
$workflow_run_cloud_checks$;

CREATE TABLE IF NOT EXISTS managed_workspaces (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('project_snapshot', 'run', 'sandbox')),
  root_path text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('provisioning', 'ready', 'busy', 'failed', 'destroyed')),
  revision text,
  active boolean NOT NULL DEFAULT false,
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  error_message text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (revision IS NULL OR revision ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  CHECK (NOT active OR (purpose = 'project_snapshot' AND state = 'ready')),
  CHECK (state <> 'ready' OR revision IS NOT NULL)
);

DO $managed_workspace_purpose_upgrade$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'managed_workspaces'::regclass
      AND conname = 'managed_workspaces_purpose_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%sandbox%'
  ) THEN
    ALTER TABLE managed_workspaces DROP CONSTRAINT managed_workspaces_purpose_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'managed_workspaces'::regclass
      AND conname = 'managed_workspaces_purpose_check'
  ) THEN
    ALTER TABLE managed_workspaces ADD CONSTRAINT managed_workspaces_purpose_check
      CHECK (purpose IN ('project_snapshot', 'run', 'sandbox'));
  END IF;
END
$managed_workspace_purpose_upgrade$;

ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES managed_workspaces(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS managed_workspaces_active_snapshot_idx
  ON managed_workspaces(project_id) WHERE purpose = 'project_snapshot' AND active;
CREATE INDEX IF NOT EXISTS managed_workspaces_project_idx
  ON managed_workspaces(project_id, purpose, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_workspace_idx
  ON workflow_runs(workspace_id) WHERE workspace_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS knowledge_snapshots (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES managed_workspaces(id) ON DELETE SET NULL,
  revision text NOT NULL CHECK (revision ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  status text NOT NULL CHECK (status IN ('indexing', 'ready', 'failed')),
  manifest_hash text,
  summary jsonb,
  index_data jsonb,
  error_message text,
  indexed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, revision),
  CHECK (manifest_hash IS NULL OR manifest_hash ~ '^[a-f0-9]{64}$'),
  CHECK (
    (status = 'ready' AND manifest_hash IS NOT NULL AND summary IS NOT NULL
      AND index_data IS NOT NULL AND indexed_at IS NOT NULL AND error_message IS NULL)
    OR (status = 'indexing' AND indexed_at IS NULL)
    OR (status = 'failed' AND indexed_at IS NULL AND error_message IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS knowledge_snapshots_project_idx
  ON knowledge_snapshots(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ask_threads (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider_id text NOT NULL CHECK (provider_id IN ('openai', 'lmstudio', 'ollama', 'custom')),
  revision text NOT NULL,
  source_revision text NOT NULL CHECK (source_revision ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  title text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(revision) BETWEEN 1 AND 200)
);

ALTER TABLE ask_threads ADD COLUMN IF NOT EXISTS source_revision text;

UPDATE ask_threads
SET source_revision = (regexp_match(
  revision,
  '(^|git:)([a-f0-9]{40}|[a-f0-9]{64})(:|$)'
))[2]
WHERE source_revision IS NULL
  AND revision ~ '(^|git:)([a-f0-9]{40}|[a-f0-9]{64})(:|$)';

UPDATE ask_threads
SET status = 'archived', updated_at = now()
WHERE source_revision IS NULL;

DO $ask_thread_cloud_checks$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ask_threads'::regclass AND conname = 'ask_threads_source_revision_check'
  ) THEN
    ALTER TABLE ask_threads ADD CONSTRAINT ask_threads_source_revision_check CHECK (
      source_revision IS NULL OR source_revision ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'
    );
  END IF;
END
$ask_thread_cloud_checks$;

CREATE TABLE IF NOT EXISTS ask_messages (
  id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES ask_threads(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0),
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  answer jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (thread_id, sequence),
  CHECK ((role = 'user' AND answer IS NULL) OR (role = 'assistant' AND answer IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ask_threads_project_idx
  ON ask_threads(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS ask_messages_thread_idx
  ON ask_messages(thread_id, sequence);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  turn_state text NOT NULL DEFAULT 'idle'
    CHECK (turn_state IN ('idle', 'running', 'waiting_human', 'interrupted')),
  current_provider_id text NOT NULL
    CHECK (current_provider_id IN ('openai', 'lmstudio', 'ollama', 'custom')),
  last_message_sequence integer NOT NULL DEFAULT 0 CHECK (last_message_sequence >= 0),
  last_event_sequence integer NOT NULL DEFAULT 0 CHECK (last_event_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_session_repositories (
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL REFERENCES managed_workspaces(id) ON DELETE RESTRICT,
  repo_alias text NOT NULL,
  access_mode text NOT NULL CHECK (access_mode IN ('write', 'read')),
  source_revision text NOT NULL CHECK (source_revision ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, project_id),
  UNIQUE (session_id, repo_alias),
  CHECK (repo_alias ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND length(repo_alias) <= 64)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_session_one_write_repository_idx
  ON agent_session_repositories(session_id) WHERE access_mode = 'write';
CREATE INDEX IF NOT EXISTS agent_session_repositories_workspace_idx
  ON agent_session_repositories(workspace_id);

CREATE TABLE IF NOT EXISTS agent_messages (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0),
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  content text NOT NULL,
  provider_id text NOT NULL CHECK (provider_id IN ('openai', 'lmstudio', 'ollama', 'custom')),
  model text,
  client_message_id uuid,
  request_fingerprint text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, sequence),
  UNIQUE (session_id, client_message_id),
  CHECK (request_fingerprint IS NULL OR request_fingerprint ~ '^[a-f0-9]{64}$'),
  CHECK (
    (role = 'user' AND client_message_id IS NOT NULL AND request_fingerprint IS NOT NULL AND model IS NULL)
    OR
    (role = 'assistant' AND client_message_id IS NULL AND request_fingerprint IS NULL
      AND model IS NOT NULL AND status = 'completed')
  )
);

CREATE INDEX IF NOT EXISTS agent_messages_session_idx
  ON agent_messages(session_id, sequence);

CREATE TABLE IF NOT EXISTS agent_tool_calls (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
  call_key text NOT NULL,
  mcp_server_id text NOT NULL,
  tool_name text NOT NULL,
  permission_class text NOT NULL CHECK (permission_class IN (
    'read', 'sandbox_write', 'external_write', 'destructive', 'release'
  )),
  approval text NOT NULL CHECK (approval IN ('not-required', 'required', 'approved', 'denied')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  arguments_sha256 text NOT NULL CHECK (arguments_sha256 ~ '^[a-f0-9]{64}$'),
  output_sha256 text CHECK (output_sha256 IS NULL OR output_sha256 ~ '^[a-f0-9]{64}$'),
  summary text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, call_key),
  CHECK (mcp_server_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$' AND length(mcp_server_id) <= 80),
  CHECK (tool_name ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$' AND length(tool_name) <= 200),
  CHECK (length(call_key) BETWEEN 1 AND 200),
  CHECK (
    permission_class NOT IN ('external_write', 'destructive', 'release')
    OR approval <> 'not-required'
  ),
  CHECK (
    permission_class NOT IN ('external_write', 'destructive', 'release')
    OR status NOT IN ('running', 'completed')
    OR approval = 'approved'
  ),
  CHECK (status <> 'completed' OR (output_sha256 IS NOT NULL AND finished_at IS NOT NULL)),
  CHECK (status <> 'failed' OR (error_message IS NOT NULL AND finished_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS agent_tool_calls_session_idx
  ON agent_tool_calls(session_id, created_at);

CREATE TABLE IF NOT EXISTS agent_human_gates (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
  tool_call_id uuid REFERENCES agent_tool_calls(id) ON DELETE SET NULL,
  category text NOT NULL CHECK (category IN (
    'scope', 'architecture', 'security', 'ddl', 'secret', 'destructive',
    'external_write', 'deployment', 'release'
  )),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  question text NOT NULL,
  choices jsonb NOT NULL,
  selected_choice_id text,
  response_comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (tool_call_id),
  CHECK (jsonb_typeof(choices) = 'array'),
  CHECK (
    (status = 'pending' AND selected_choice_id IS NULL
      AND response_comment IS NULL AND resolved_at IS NULL)
    OR
    (status <> 'pending' AND resolved_at IS NOT NULL)
  ),
  CHECK (status <> 'approved' OR selected_choice_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS agent_human_gates_session_idx
  ON agent_human_gates(session_id, created_at);

CREATE TABLE IF NOT EXISTS agent_events (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0),
  kind text NOT NULL CHECK (kind IN (
    'session.created', 'message.accepted', 'provider.started',
    'tool.started', 'tool.completed', 'tool.failed',
    'sandbox.starting', 'sandbox.ready', 'sandbox.failed',
    'sdlc.run-created', 'sdlc.phase-started', 'sdlc.phase-completed',
    'human-gate.required', 'human-gate.resolved',
    'turn.completed', 'turn.failed',
    'deepwiki.started', 'deepwiki.completed', 'deepwiki.failed'
  )),
  status text NOT NULL CHECK (status IN ('started', 'completed', 'failed', 'waiting')),
  summary text NOT NULL,
  message_id uuid REFERENCES agent_messages(id) ON DELETE SET NULL,
  tool_call_id uuid REFERENCES agent_tool_calls(id) ON DELETE SET NULL,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  workflow_run_id uuid REFERENCES workflow_runs(id) ON DELETE SET NULL,
  phase_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, sequence),
  CHECK (phase_id IS NULL OR phase_id IN (
    'discovery', 'design', 'architecture', 'implementation', 'verification', 'release'
  ))
);

CREATE INDEX IF NOT EXISTS agent_events_session_idx
  ON agent_events(session_id, sequence);

CREATE TABLE IF NOT EXISTS agent_sandboxes (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL UNIQUE REFERENCES managed_workspaces(id) ON DELETE RESTRICT,
  source_revision text NOT NULL CHECK (source_revision ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  blueprint_id text NOT NULL,
  blueprint_version text NOT NULL,
  state text NOT NULL CHECK (state IN ('starting', 'ready', 'busy', 'stopped', 'failed')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id),
  CHECK (blueprint_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$' AND length(blueprint_id) <= 80),
  CHECK (blueprint_version ~ '^[A-Za-z0-9][A-Za-z0-9._:+-]*$'
    AND length(blueprint_version) <= 128)
);

CREATE TABLE IF NOT EXISTS agent_session_runs (
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  trigger_message_id uuid NOT NULL REFERENCES agent_messages(id) ON DELETE RESTRICT,
  workflow_run_id uuid NOT NULL UNIQUE REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, workflow_run_id)
);

CREATE TABLE IF NOT EXISTS deepwiki_generations (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES managed_workspaces(id) ON DELETE RESTRICT,
  revision text NOT NULL CHECK (revision ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  provider_id text NOT NULL CHECK (provider_id IN ('openai', 'lmstudio', 'ollama', 'custom')),
  model text,
  prompt_version text NOT NULL DEFAULT 'deepwiki-v1',
  status text NOT NULL CHECK (status IN (
    'queued', 'scanning', 'generating', 'validating', 'ready', 'failed', 'stale'
  )),
  manifest_hash text CHECK (manifest_hash IS NULL OR manifest_hash ~ '^[a-f0-9]{64}$'),
  content text,
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  error_message text,
  client_request_id uuid,
  generated_at timestamptz,
  stale_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, client_request_id),
  CHECK (jsonb_typeof(citations) = 'array'),
  CHECK (
    (status IN ('ready', 'stale') AND model IS NOT NULL AND content IS NOT NULL
      AND generated_at IS NOT NULL AND error_message IS NULL)
    OR
    (status = 'failed' AND content IS NULL AND generated_at IS NOT NULL AND error_message IS NOT NULL)
    OR
    (status IN ('queued', 'scanning', 'generating', 'validating')
      AND content IS NULL AND generated_at IS NULL AND error_message IS NULL)
  ),
  CHECK ((status = 'stale') = (stale_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS deepwiki_generations_one_active_idx
  ON deepwiki_generations(project_id, revision)
  WHERE status IN ('queued', 'scanning', 'generating', 'validating');
CREATE INDEX IF NOT EXISTS deepwiki_generations_project_idx
  ON deepwiki_generations(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deepwiki_generations_workspace_idx
  ON deepwiki_generations(workspace_id);

CREATE TABLE IF NOT EXISTS run_changesets (
  id uuid PRIMARY KEY,
  workflow_run_id uuid NOT NULL UNIQUE REFERENCES workflow_runs(id) ON DELETE CASCADE,
  base_revision text NOT NULL CHECK (base_revision ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  head_revision text CHECK (head_revision IS NULL OR head_revision ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  dirty boolean NOT NULL,
  files jsonb NOT NULL,
  patch bytea NOT NULL,
  patch_bytes integer NOT NULL CHECK (patch_bytes >= 0),
  patch_sha256 text NOT NULL CHECK (patch_sha256 ~ '^[a-f0-9]{64}$'),
  download_available boolean NOT NULL DEFAULT false,
  generated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(patch) = patch_bytes),
  CONSTRAINT run_changesets_download_check
    CHECK (download_available = (patch_bytes > 0)),
  CONSTRAINT run_changesets_semantic_check
    CHECK (dirty OR (files = '[]'::jsonb AND patch_bytes = 0 AND NOT download_available))
);

ALTER TABLE run_changesets
  ADD COLUMN IF NOT EXISTS download_available boolean NOT NULL DEFAULT false;

UPDATE run_changesets
SET download_available = patch_bytes > 0;

DO $run_changeset_cloud_checks$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'run_changesets'::regclass
      AND conname = 'run_changesets_download_check'
  ) THEN
    ALTER TABLE run_changesets ADD CONSTRAINT run_changesets_download_check
      CHECK (download_available = (patch_bytes > 0));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'run_changesets'::regclass
      AND conname = 'run_changesets_semantic_check'
  ) THEN
    ALTER TABLE run_changesets ADD CONSTRAINT run_changesets_semantic_check
      CHECK (dirty OR (files = '[]'::jsonb AND patch_bytes = 0 AND NOT download_available));
  END IF;
END
$run_changeset_cloud_checks$;

CREATE TABLE IF NOT EXISTS phase_runs (
  id uuid PRIMARY KEY,
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  phase_id text NOT NULL,
  position integer NOT NULL,
  status text NOT NULL CHECK (status IN (
    'pending', 'ready', 'running', 'awaiting_review', 'approved', 'changes_requested', 'failed'
  )),
  architecture_impact jsonb,
  phase_resolution jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_run_id, phase_id),
  UNIQUE (workflow_run_id, position)
);

ALTER TABLE phase_runs ADD COLUMN IF NOT EXISTS architecture_impact jsonb;
ALTER TABLE phase_runs ADD COLUMN IF NOT EXISTS phase_resolution jsonb;

CREATE TABLE IF NOT EXISTS executions (
  id uuid PRIMARY KEY,
  phase_run_id uuid NOT NULL REFERENCES phase_runs(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  selected_artifact_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  selected_output_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  runner_mode text CHECK (runner_mode IS NULL OR runner_mode IN ('real', 'fake')),
  model text,
  reasoning_effort text CHECK (reasoning_effort IS NULL OR reasoning_effort IN (
    'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'
  )),
  command text NOT NULL,
  exit_code integer,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE executions ADD COLUMN IF NOT EXISTS selected_output_keys jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS runner_mode text;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS reasoning_effort text;

-- Early databases added these columns without their CREATE TABLE checks.
-- Preserve the rows while clearing values the current runner cannot interpret.
UPDATE executions
SET runner_mode = NULL
WHERE runner_mode IS NOT NULL AND runner_mode NOT IN ('real', 'fake');

UPDATE executions
SET reasoning_effort = NULL
WHERE reasoning_effort IS NOT NULL
  AND reasoning_effort NOT IN ('minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra');

DO $execution_checks$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'executions'::regclass
      AND conname = 'executions_runner_mode_check'
  ) THEN
    ALTER TABLE executions ADD CONSTRAINT executions_runner_mode_check
      CHECK (runner_mode IS NULL OR runner_mode IN ('real', 'fake'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'executions'::regclass
      AND conname = 'executions_reasoning_effort_check'
  ) THEN
    ALTER TABLE executions ADD CONSTRAINT executions_reasoning_effort_check
      CHECK (reasoning_effort IS NULL OR reasoning_effort IN (
        'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'
      ));
  END IF;
END
$execution_checks$;

CREATE TABLE IF NOT EXISTS artifacts (
  id uuid PRIMARY KEY,
  phase_run_id uuid NOT NULL REFERENCES phase_runs(id) ON DELETE CASCADE,
  execution_id uuid REFERENCES executions(id) ON DELETE CASCADE,
  artifact_key text NOT NULL,
  file_path text NOT NULL,
  content_snapshot text NOT NULL,
  content_hash text NOT NULL,
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN (
    'pending', 'approved', 'changes_requested', 'superseded'
  )),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  revision_source text NOT NULL DEFAULT 'ai' CHECK (revision_source IN ('ai', 'human')),
  parent_artifact_id uuid REFERENCES artifacts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'pending';
ALTER TABLE artifacts ALTER COLUMN execution_id DROP NOT NULL;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS revision integer;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS revision_source text;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS parent_artifact_id uuid REFERENCES artifacts(id) ON DELETE SET NULL;

-- Existing databases stored revisions implicitly as execution history. Number
-- them deterministically before applying the non-null and uniqueness rules.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY phase_run_id, artifact_key
           ORDER BY created_at, id
         )::integer AS revision
  FROM artifacts
)
UPDATE artifacts a
SET revision = ranked.revision
FROM ranked
WHERE a.id = ranked.id AND a.revision IS NULL;

UPDATE artifacts
SET revision_source = CASE WHEN execution_id IS NULL THEN 'human' ELSE 'ai' END
WHERE revision_source IS NULL;

WITH ordered AS (
  SELECT id,
         lag(id) OVER (
           PARTITION BY phase_run_id, artifact_key
           ORDER BY revision, created_at, id
         ) AS parent_artifact_id
  FROM artifacts
)
UPDATE artifacts a
SET parent_artifact_id = ordered.parent_artifact_id
FROM ordered
WHERE a.id = ordered.id
  AND a.revision > 1
  AND a.parent_artifact_id IS NULL;

ALTER TABLE artifacts ALTER COLUMN revision SET DEFAULT 1;
ALTER TABLE artifacts ALTER COLUMN revision SET NOT NULL;
ALTER TABLE artifacts ALTER COLUMN revision_source SET DEFAULT 'ai';
ALTER TABLE artifacts ALTER COLUMN revision_source SET NOT NULL;

-- Replace the first MVP review check once, and avoid repeatedly dropping
-- validated constraints (and taking an avoidable table lock) on every startup.
DO $artifact_checks$
DECLARE
  review_constraint text;
BEGIN
  SELECT pg_get_constraintdef(oid)
  INTO review_constraint
  FROM pg_constraint
  WHERE conrelid = 'artifacts'::regclass
    AND conname = 'artifacts_review_status_check';

  IF review_constraint IS NULL OR position('superseded' IN review_constraint) = 0 THEN
    ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_review_status_check;
    ALTER TABLE artifacts ADD CONSTRAINT artifacts_review_status_check
      CHECK (review_status IN ('pending', 'approved', 'changes_requested', 'superseded'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'artifacts'::regclass
      AND conname = 'artifacts_revision_check'
  ) THEN
    ALTER TABLE artifacts ADD CONSTRAINT artifacts_revision_check CHECK (revision > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'artifacts'::regclass
      AND conname = 'artifacts_revision_source_check'
  ) THEN
    ALTER TABLE artifacts ADD CONSTRAINT artifacts_revision_source_check
      CHECK (revision_source IN ('ai', 'human'));
  END IF;
END
$artifact_checks$;

-- Backfill the current revision when upgrading an early MVP database.
UPDATE artifacts a
SET review_status = CASE
  WHEN pr.status = 'approved' THEN 'approved'
  WHEN pr.status = 'changes_requested' THEN 'changes_requested'
  ELSE a.review_status
END
FROM phase_runs pr
WHERE pr.id = a.phase_run_id
  AND a.review_status = 'pending'
  AND pr.status IN ('approved', 'changes_requested')
  AND a.id = (
    SELECT current.id FROM artifacts current
    WHERE current.phase_run_id = a.phase_run_id
      AND current.artifact_key = a.artifact_key
    ORDER BY current.revision DESC, current.created_at DESC, current.id DESC
    LIMIT 1
  );

-- A single non-superseded row is the current head for each artifact key.
WITH heads AS (
  SELECT DISTINCT ON (phase_run_id, artifact_key) id
  FROM artifacts
  ORDER BY phase_run_id, artifact_key, revision DESC, created_at DESC, id DESC
)
UPDATE artifacts a
SET review_status = 'superseded'
WHERE NOT EXISTS (SELECT 1 FROM heads WHERE heads.id = a.id)
  AND a.review_status <> 'superseded';

CREATE TABLE IF NOT EXISTS reviews (
  id uuid PRIMARY KEY,
  phase_run_id uuid NOT NULL REFERENCES phase_runs(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('approve', 'request_changes')),
  comment text NOT NULL,
  reviewed_artifact_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reviewed_artifact_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS tickets (
  id uuid PRIMARY KEY,
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  source_artifact_id uuid REFERENCES artifacts(id) ON DELETE SET NULL,
  story_key text NOT NULL,
  title text NOT NULL,
  category text NOT NULL,
  source_path text NOT NULL,
  content_snapshot text NOT NULL,
  content_hash text NOT NULL,
  acceptance_criteria_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog', 'todo', 'in_progress', 'done')),
  position integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_run_id, story_key)
);

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS acceptance_criteria_count integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS execution_events (
  id uuid PRIMARY KEY,
  execution_id uuid NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (execution_id, sequence)
);

CREATE INDEX IF NOT EXISTS workflow_runs_project_idx ON workflow_runs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS phase_runs_workflow_idx ON phase_runs(workflow_run_id, position);
CREATE INDEX IF NOT EXISTS artifacts_phase_idx ON artifacts(phase_run_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_phase_key_revision_idx
  ON artifacts(phase_run_id, artifact_key, revision);
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_phase_key_head_idx
  ON artifacts(phase_run_id, artifact_key)
  WHERE review_status <> 'superseded';
CREATE INDEX IF NOT EXISTS executions_phase_idx ON executions(phase_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS execution_events_execution_idx ON execution_events(execution_id, sequence);
CREATE INDEX IF NOT EXISTS tickets_run_status_idx ON tickets(workflow_run_id, active, status, position);

-- A local API restart must not leave a phase permanently stuck in running.
WITH interrupted AS (
  UPDATE executions
  SET status = 'failed',
      error = 'API restarted before this execution completed',
      finished_at = now()
  WHERE status IN ('queued', 'running')
  RETURNING phase_run_id
)
UPDATE phase_runs
SET status = 'failed', updated_at = now()
WHERE id IN (SELECT phase_run_id FROM interrupted);
`;
