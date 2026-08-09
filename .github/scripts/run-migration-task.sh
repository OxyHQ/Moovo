#!/usr/bin/env bash
#
# Run ONE migration phase as a one-shot ECS task and fail if it did not succeed.
#
# Usage: run-migration-task.sh <pre|post|all>
#
# In a script rather than inline YAML because the interesting part is the exit
# handling, and that is the part a reviewer must be able to read: an ECS task
# that fails is not an error from the AWS CLI's point of view — `run-task`
# returns 0 as soon as the task is ACCEPTED. A workflow that only checked the
# CLI's exit code would report a green deploy for a migration that threw, which
# is precisely the failure this step exists to prevent.
#
# The migration runs INSIDE the VPC as a Fargate task, not on the GitHub runner.
# That is not a stylistic choice: the database is `postgres.internal.oxy.so`,
# private DNS on the shared RDS instance, and a hosted runner cannot resolve or
# reach it. The image is therefore the only thing that can apply a migration,
# which is why the Dockerfile carries `dist/db/migrate.js` and its `.sql` files.
#
# Environment (set by the workflow):
#   CLUSTER, APP, PG_DATABASE     from the workflow's `env:` block
#   TASK_DEFINITION               the service's live task definition ARN
#   CONTAINER_NAME                the container to override within it
#   NETWORK_CONFIGURATION         the service's awsvpc config, as compact JSON
set -euo pipefail

# The three values `@oxyhq/db` accepts as a `run` (its MIGRATION_RUNS). `all` is
# the cutover escape hatch, not a normal release: it applies destructive
# migrations while the previous image is still serving, which is only safe when
# there is no previous image serving this schema.
PHASE="${1:?usage: run-migration-task.sh <pre|post|all>}"
case "$PHASE" in
  pre | post | all) ;;
  *)
    echo "::error::unknown migration phase '$PHASE' (expected pre, post or all)"
    exit 1
    ;;
esac

: "${CLUSTER:?CLUSTER is required}"
: "${APP:?APP is required}"
: "${PG_DATABASE:?PG_DATABASE is required}"
: "${TASK_DEFINITION:?TASK_DEFINITION is required}"
: "${CONTAINER_NAME:?CONTAINER_NAME is required}"
: "${NETWORK_CONFIGURATION:?NETWORK_CONFIGURATION is required}"

# The task definition must carry DATABASE_URL, or the migrator has nothing to
# open. Checked HERE rather than left to the task, because the task's own
# failure is a container exit deep in a CloudWatch log stream, while this names
# the missing piece and the file that supplies it. The migrator does still
# refuse on its own (verified: exit 1 with no DATABASE_URL) — this is the
# earlier, clearer of two real guards, never the only one.
#
# The way it actually disappears is worth naming, because it is not a typo in
# this repo: DATABASE_URL was added to the task definition by hand
# (oxy-moovo:1 -> :2) and, at the time of writing, is declared in no terraform.
# A routine `terraform apply` in oxy-infra therefore REMOVES it — it strips a
# live-but-undeclared secret — which rolls the service back to a task definition
# the current image cannot migrate against. That has already happened twice to a
# sibling service. So a sudden failure here most likely means an apply ran, not
# that anyone edited this workflow; the fix is in oxy-infra, not in this file.
if ! aws ecs describe-task-definition --task-definition "$TASK_DEFINITION" \
      --query 'taskDefinition.containerDefinitions[].secrets[].name' --output text |
      grep -qw DATABASE_URL; then
  echo "::error::task definition $TASK_DEFINITION does not supply DATABASE_URL, so the $PHASE migration has no database to open. It is provisioned in oxy-infra (terraform-uswest2/) and must reach the task definition before this deploy can migrate."
  exit 1
fi

# `--target-database` is the migrator's own guard: it refuses to run unless this
# name matches the database DATABASE_URL resolves to, so a task pointed at the
# wrong database fails instead of migrating some other Oxy app's, on a server
# they share.
OVERRIDES=$(jq -nc \
  --arg name "$CONTAINER_NAME" \
  --arg db "$PG_DATABASE" \
  --arg phase "$PHASE" \
  '{containerOverrides: [{name: $name, command: [
      "node", "packages/backend/dist/db/migrate.js",
      ("--target-database=" + $db),
      ("--phase=" + $phase)
  ]}]}')

echo "running $PHASE migration task on $CLUSTER using $TASK_DEFINITION"
TASK_ARN=$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$TASK_DEFINITION" \
  --launch-type FARGATE \
  --count 1 \
  --network-configuration "$NETWORK_CONFIGURATION" \
  --overrides "$OVERRIDES" \
  --started-by "deploy-$PHASE-migration" \
  --query 'tasks[0].taskArn' --output text)

if [ -z "$TASK_ARN" ] || [ "$TASK_ARN" = "None" ]; then
  echo "::error::the $PHASE migration task was not accepted by ECS"
  exit 1
fi
echo "task: $TASK_ARN"

aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"

# Read the exit code of the container we overrode BY NAME. Indexing [0] would
# silently read a sidecar's status if one is ever added to the task definition.
EXIT_CODE=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query "tasks[0].containers[?name=='$CONTAINER_NAME'].exitCode | [0]" --output text)
STOP_REASON=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].stoppedReason' --output text)

# A container that never started has NO exit code — `None`, not 0. Treating that
# as success is the single easiest way to ship an unmigrated database, so it is
# handled before the numeric comparison rather than falling into it.
if [ "$EXIT_CODE" = "None" ] || [ -z "$EXIT_CODE" ]; then
  echo "::error::the $PHASE migration container never ran (stoppedReason: $STOP_REASON)"
  exit 1
fi

if [ "$EXIT_CODE" != "0" ]; then
  echo "::error::the $PHASE migration failed with exit code $EXIT_CODE (stoppedReason: $STOP_REASON)"
  exit 1
fi

echo "$PHASE migration completed"
