export const schemaSql = `
CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  summary text NOT NULL,
  root_path text NOT NULL UNIQUE,
  config_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  objective text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'completed')),
  artifact_paths jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS artifact_paths jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS phase_runs (
  id uuid PRIMARY KEY,
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  phase_id text NOT NULL,
  position integer NOT NULL,
  status text NOT NULL CHECK (status IN (
    'pending', 'ready', 'running', 'awaiting_review', 'approved', 'changes_requested', 'failed'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_run_id, phase_id),
  UNIQUE (workflow_run_id, position)
);

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
