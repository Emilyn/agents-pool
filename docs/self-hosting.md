# Self-hosting the agentpool team server

The team server gives a group of developers one web app where they log in, connect repositories, and hand tasks to the agent pool. Each task runs in its own Docker container, and the server opens the pull request (GitHub) or merge request (GitLab).

```
browser ──► agentpool server ──► docker run agentpool-worker work <task>   (one container per task)
              │  accounts, encrypted repo tokens,         │  sees only that repo's clone and the model key
              │  clones, event logs, PR/MR creation       ▼
              └────────────── repo clone on disk ◄── agents edit a git worktree, commit, QA, review
```

## What you need

- A Linux or macOS machine or VM with Node 20+, git, and Docker (the server talks to the Docker daemon).
- An `ANTHROPIC_API_KEY` for the agents. Workers cannot use a personal Claude login.
- A way to serve HTTPS (a reverse proxy such as Caddy or nginx) if anyone other than you will use it.

## 1. Install and build

```sh
git clone https://github.com/Emilyn/agents-pool && cd agents-pool
npm install && npm run build
docker build -t agentpool-worker .
```

The worker image contains Node, Python, git, make and a compiler. If your repositories need other toolchains (Java, Go, .NET, a database client), build your own image `FROM agentpool-worker` and pass it with `--image`.

## 2. Start the server

```sh
export ANTHROPIC_API_KEY=sk-ant-...
export AGENTPOOL_SECRET="$(openssl rand -hex 32)"     # protects stored repo tokens; keep it, or the key file in the data dir
node dist/cli.js server \
  --data-dir /srv/agentpool \
  --host 127.0.0.1 --port 4317 \
  --public-url https://agents.example.com \
  --max-budget-usd 20 --concurrency 3
```

Open the URL and create the admin account (the first visit is the setup screen). The admin adds everyone else under **People**.

Settings can also come from the environment: `AGENTPOOL_DATA_DIR`, `AGENTPOOL_HOST`, `AGENTPOOL_PORT`, `AGENTPOOL_PUBLIC_URL`, `AGENTPOOL_EXECUTOR`, `AGENTPOOL_IMAGE`, `AGENTPOOL_WORKER_NETWORK`, `AGENTPOOL_CONCURRENCY`, `AGENTPOOL_MAX_BUDGET_USD`, `AGENTPOOL_GIT_NAME`, `AGENTPOOL_GIT_EMAIL`.

### HTTPS

The server speaks plain HTTP. Put it behind a TLS proxy and set `--public-url` to the https address so session cookies are marked `Secure`. Caddy example:

```
agents.example.com {
  reverse_proxy 127.0.0.1:4317
}
```

Do not expose the port directly. The server warns at startup if it listens beyond localhost without an https public URL.

### Keep it running

Use your usual process manager. A minimal systemd unit:

```ini
[Service]
User=agentpool
EnvironmentFile=/etc/agentpool.env
ExecStart=/usr/bin/node /opt/agents-pool/dist/cli.js server --data-dir /srv/agentpool --public-url https://agents.example.com
Restart=on-failure
```

The user must be in the `docker` group. Tasks are event-sourced: if the server restarts, running tasks stop and show as paused, and anyone can press **Resume**.

## 3. Connect a repository

In the web app choose **Connect a repository**, paste the repository URL and an access token.

| Host | Token | Permissions needed |
| --- | --- | --- |
| GitHub | Fine-grained personal access token limited to that repository | Contents: read and write. Pull requests: read and write. Metadata: read. |
| GitLab | Personal or project access token | `api` scope, Developer role or higher |

The server checks the token against the host, stores it encrypted (AES-256-GCM, key from `AGENTPOOL_SECRET` or `<data>/secret.key`), and clones the repository into its data directory. The token is never shown again and is never given to the containers: pushing and opening the request happen in the server. A token that can read but not push still works for tasks, and the repository page tells you pull requests will not open.

Use a token for a bot or service account rather than a person if you can. Everyone on the server can start tasks in every connected repository, using that token for the pull request, and the request is opened under the token's identity. The task history records which person asked.

Self-hosted GitHub Enterprise or GitLab: open **Self-hosted server** in the connect dialog and set the server type (and the API URL if it is not the default).

## 4. Give it tasks

Pick the repository, press **New task**, describe the work (or give a Jira issue), choose the branch to start from, and decide whether the plan needs approval and whether to open the pull request automatically. Agents work in a fresh container; you answer their questions and approve plans in the web app.

Per-repository behaviour lives in the repository itself: commit `.agentpool/config.json` (test and setup commands, budgets) and optionally `.agentpool/agents/` and `.agentpool/skills/`. The server uses the version on the repository's default branch. See the main README.

## How tasks are isolated

Each task runs `docker run` with:

- only that repository's clone mounted (read-write), nothing else from the host
- all Linux capabilities dropped, `no-new-privileges`, a process limit, CPU and memory limits (`--worker-cpus`, `--worker-memory`)
- the server's user id, a throwaway `/tmp`
- environment limited to the model key and an allowlist (proxy settings, package registry URLs, plus names you add in `AGENTPOOL_WORKER_ENV`). Repository tokens, Jira credentials and the server secret are never passed.
- a time limit (`--timeout-minutes`, default 60) after which the container is killed

What this does not do:

- **Network egress is open by default.** Agents need the model API and package registries, and a prompt-injected agent could send repository contents elsewhere. Run workers on a Docker network with an egress filter (`--worker-network`) if that matters to you.
- **The model key is inside the container.** Agents can read it. Use a key with a spend limit.
- **The Docker daemon is a powerful dependency.** Anyone who controls the server user controls Docker. Do not run the server itself inside a container with the Docker socket mounted unless you accept that.
- **Repository code runs in the container.** Tests and install scripts execute there. That is the point of the container, but it is not a defence against a determined attacker with a kernel exploit; use gVisor or a dedicated VM for untrusted repositories.
- **Prompt injection is not solved.** Task text, ticket text and repository files can all carry instructions. The pull request is the control point: someone reviews it before it merges.

## Operations

- **Backups:** the data directory (`db.json`, `repos/`, `secret.key`). Without `secret.key` or `AGENTPOOL_SECRET`, stored tokens cannot be decrypted and repositories must be reconnected.
- **Disk:** each connected repository is a full clone plus a worktree per task. Remove finished worktrees with `agentpool clean <task-id> --repo <data>/repos/<repo-id>/repo`, or remove and reconnect a repository.
- **Upgrading:** pull, `npm run build`, rebuild the worker image, restart the server. Tasks that were running resume from their event log.
- **No-isolation mode:** `--executor local` runs workers as plain child processes without containers. Use it for development or a team that fully trusts its repositories.

## Limits of this version

- One server process; accounts and repositories are stored in a JSON file, not a database. Fine for a team, not for hundreds of concurrent users.
- No SSO or OAuth sign-in, no per-repository permissions (everyone can use every repository), and no webhooks. Tasks start from the web app, not from issues or comments.
- Password login with lockout and server-side sessions; no two-factor.
- The Docker path has been tested by unit tests of the generated `docker run` arguments, not against a live Docker daemon in CI yet.
