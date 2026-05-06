# 🏗️ Infrastructure as Code Review — Lens Skill Pack

Covers: Dockerfile, Terraform (.tf), Docker Compose, GitHub Actions / GitLab CI workflows.

## Quality bar
- Only comment if a senior DevOps/platform engineer's first reaction would be "good catch," not "yeah I know."
- Don't comment on: variable naming style, comment formatting, whitespace, anything a linter (tflint, hadolint) handles automatically.

## [correctness]
- `COPY . .` before installing dependencies in a Dockerfile — invalidates the dependency cache layer on every source change; install deps first.
- `CMD` / `ENTRYPOINT` using shell form (`CMD "app"`) instead of exec form (`CMD ["app"]`) — shell form spawns a shell that swallows signals, breaking graceful shutdown.
- Multi-stage Dockerfile where the final stage `COPY --from=builder` references a path that doesn't exist in the builder stage.
- Terraform resource with `count` or `for_each` removed — Terraform will destroy then recreate instead of migrating; use `moved` blocks.
- `terraform apply` target (`-target`) used in a shared module — leaves state partially applied and inconsistent.
- Docker Compose `depends_on` without `condition: service_healthy` — container starts before dependency is ready.
- GitHub Actions workflow step that `curl | bash` without pinning the script version — non-deterministic on re-run.
- Workflow `if:` condition that silently skips required steps on forks or PRs from external contributors.

## [security]
- Secrets or credentials hardcoded in any IaC file (Terraform variable defaults, Compose environment values, workflow `env:` blocks).
- Docker base image using a mutable tag (`latest`, `stable`, `3`) instead of a pinned digest (`image@sha256:…`) — image can change silently between builds.
- GitHub Actions third-party action referenced by branch or tag (`uses: owner/action@main`) instead of a full commit SHA — supply-chain attack vector.
- Container running as `root` (no `USER` instruction in Dockerfile, or `user:` not set in Compose) — unnecessary privilege escalation if compromised.
- Overly broad IAM role or policy in Terraform (`"*"` actions or resources) — violates least privilege.
- Sensitive outputs in Terraform not marked `sensitive = true` — values appear in plan/apply logs and state.
- Terraform state stored in an unencrypted backend without access controls.
- `privileged: true` in Compose or Kubernetes manifest — grants full host kernel access to the container.
- Port `0.0.0.0` binding for an internal-only service — exposes to all network interfaces including public.
- `DOCKER_BUILDKIT` secrets not used for build-time secrets — secrets baked into image layers.
- Workflow `pull_request_target` trigger with code checkout from the PR branch — arbitrary code execution from a fork PR.
- Environment variable containing a secret passed to a `run:` step that may be logged on error.

## [data_integrity]
- Terraform resource deletion that will cause data loss (RDS instance, S3 bucket, EBS volume) without `prevent_destroy = true` lifecycle rule.
- `terraform state rm` or `import` without a plan review — state diverges from reality.
- Docker volume mount overwriting container files at startup (e.g., mounting an empty host directory over `/data`) — silently destroys container-baked data.
- Compose or Kubernetes config map change that requires a pod restart but no rolling update is triggered.
- GitHub Actions artifact or cache key not versioned — stale cache from a previous run silently used after dependency changes.

## [api_contracts]
- Terraform module input variable removed or renamed without updating all callers.
- Output value removed from a Terraform module that downstream modules reference.
- Terraform provider version constraint widened (`>= 3.0` instead of `~> 3.70`) — allows major version jumps that introduce breaking changes.
- Docker image tag used by other services changed without coordinating consumers.
- GitHub Actions reusable workflow input or secret renamed — silently breaks callers that pass the old name.

## [maintainability]
- Hardcoded region, account ID, or environment name that should be a variable or data source.
- Terraform resource not tagged with required tags (team, environment, cost-center) — breaks cost attribution and ownership.
- `null_resource` or `local-exec` provisioner used for work that a proper Terraform resource handles — fragile, not idempotent.
- Dockerfile layer order not optimized for cache — frequently changing files copied before rarely changing dependencies.
- Monolithic workflow job that should be split (build / test / deploy are separate concerns with different retry characteristics).
- TODO/FIXME in IaC without a tracking issue.
