# agentpool

A self-hosted pool of role-based AI agents for your repositories. Connect a repo, give the pool a task (typed, or from a Jira issue), answer its questions, approve its plan, and review the pull request it opens.

A planner reads the repo and proposes a plan. You approve it. A developer implements it on an isolated branch, QA verifies it by running things, and a reviewer reads the diff. Every task runs in its own Docker container; the result is a branch with one commit per step and a pull request (GitHub) or merge request (GitLab) whose description lists the evidence and what the agents were unsure about.

Two ways to run it:

| | Team server | Local |
| --- | --- | --- |
| Command | `agentpool server` | `agentpool run ...` or `agentpool serve` |
| For | A team: accounts, connected repos, tasks from the browser | One developer, in a checkout they already have |
| Repos | Connect by URL and access token; the server keeps a clone | The repo you are standing in |
| Isolation | One Docker container per task | Git worktree on your machine (not a sandbox) |
| Guide | [docs/self-hosting.md](docs/self-hosting.md) | [How to use it](#how-to-use-it) below |

## Team server in five minutes

```sh
npm install && npm run build
docker build -t agentpool-worker .
export ANTHROPIC_API_KEY=sk-ant-...  AGENTPOOL_SECRET="$(openssl rand -hex 32)"
node dist/cli.js server --data-dir ./agentpool-data
```

Open http://127.0.0.1:4317, create the admin account, add people, **Connect a repository** (URL plus an access token with write access to contents and pull requests), then **New task**. Put it behind HTTPS before anyone else uses it, and read [what the isolation does and does not cover](docs/self-hosting.md#how-tasks-are-isolated).

## Quick start

Needs Node 20+, git, and Claude credentials (`ANTHROPIC_API_KEY`, or an existing Claude Code login).

```sh
npm install
npm run build
npm link                    # puts `agentpool` on your PATH, or use `node dist/cli.js`

cd /path/to/your/repo       # must have at least one commit
agentpool run "Add a CSV export to the reports page"
```

Try the whole flow with fake agents first, at no cost:

```sh
agentpool run --runner dry-run "Anything [ask] [qa-fail-once]"
```

## How to use it

### 1. Install once

```sh
git clone https://github.com/Emilyn/agents-pool && cd agents-pool
npm install && npm run build && npm link     # `agentpool` is now on your PATH
```

Give it Claude access with `ANTHROPIC_API_KEY`, or rely on an existing Claude Code login. Then check a repository is ready:

```sh
cd /path/to/your/repo
agentpool doctor
```

`doctor` reports what is missing (git, commits, test command, tokens) and exits non-zero only on hard failures. Warnings, such as no Jira token, are fine if you do not use that feature.

### 2. Point it at an existing repository

Nothing needs to be installed in your repo. On the first run agentpool creates a `.agentpool/` folder and adds the run and worktree folders to `.git/info/exclude`, so `git status` stays clean. Your own checkout is never modified: agents work on a copy (a git worktree) on a new branch `agentpool/<run-id>`, starting from your current `HEAD` (or `--base <branch>`). Uncommitted changes are not seen by the agents.

Optional but worthwhile: commit a `.agentpool/config.json` so the run can verify things itself.

```json
{ "commands": { "setup": "npm ci", "test": "npm test" } }
```

Test, lint and build commands are auto-detected for Node, Python, Go, Rust, Java and Make projects; set them only when detection is wrong or missing. `doctor` shows what it found.

### 3. Run a task

```sh
agentpool run "Add a CSV export to the reports page"          # typed task
agentpool run --task-file ticket.md                           # longer description
agentpool run --jira PROJ-123                                 # Jira Cloud issue
agentpool run --jira PROJ-123 --open-pr --jira-comment        # all the way to a PR, link posted on the ticket
agentpool run --runner dry-run "Anything [ask]"               # fake agents, free, to learn the flow
```

Or start the web app with `agentpool serve` and use the **New run** button; the CLI and the web app share the same runs.

### 4. Answer when the agents need you

In a terminal you are prompted. Otherwise the run parks and waits, and you answer from the CLI or the web app:

```sh
agentpool status                       # what is it waiting for?
agentpool answer <run-id> Q-1 "table"
agentpool approve <run-id>             # approve the plan (or: reject <run-id> "reason")
agentpool resume <run-id>
```

You will be asked about three things: blocking questions from the planner, approval of the plan before any code is written (skip with `--autonomy auto`), and a decision when QA or the reviewer still object after `--max-rounds`.

### 5. Review the result

```sh
agentpool status                       # phase, spend, what is next
cat .agentpool/runs/<run-id>/MR.md     # summary, plan, test evidence, QA, review, doubts
git log --oneline <base>..agentpool/<run-id>
agentpool log <run-id>                 # everything that happened
```

Read the **"What the agents were unsure about"** section of `MR.md` first, and check the **Status** line: a run that could not clear QA or review is marked NOT ready rather than hidden. Test results in the "Test evidence" table were run by agentpool itself, not reported by an agent.

### 6. Open the pull or merge request

```sh
export GITHUB_TOKEN=...                # or GITLAB_TOKEN (or run `gh auth login`)
agentpool pr <run-id> --dry-run        # show what would be pushed
agentpool pr <run-id>                  # push the branch and open it (draft unless ready)
```

Do this by hand instead if you prefer: the commands are at the bottom of `MR.md`.

### 7. Clean up

```sh
agentpool list                         # all runs in this repo
agentpool clean <run-id>               # remove the worktree; the branch stays
```

### Good habits

- Start with small, well-described tasks. The planner asks questions when the answer changes the plan, so a vague task costs a round trip rather than a wrong guess.
- Use `--budget-usd` to cap spend per run (default $10) and `--assume-defaults` for unattended runs that must never wait.
- If a run fails a step (network, budget, a malformed agent reply), `agentpool resume <run-id>` retries from where it stopped.
- Treat ticket text and task text as untrusted input, and run in a container or VM for code you do not trust: the safety notes below explain why.

### Troubleshooting

| Symptom | Fix |
| --- | --- |
| `This repository has no commits yet` | Make an initial commit; agents branch from a commit. |
| Run finishes "NOT ready: tests fail" | Look at the Test evidence in `MR.md`. If the tests also failed before the change, the baseline was already red. |
| `No GitHub token found` / `No GitLab token found` | Set `GITHUB_TOKEN` or `GITLAB_TOKEN`; nothing is pushed until a token is found. |
| `Cannot tell whether <host> is GitHub or GitLab` | Add `"git": {"host": "gitlab"}` to `.agentpool/config.json`. |
| `The base branch ... does not exist on origin` | Push the base branch, or start the run with `--base` set to a branch the remote has. |
| `Jira is not configured` | Set `JIRA_EMAIL`, `JIRA_API_TOKEN`, and `JIRA_BASE_URL` (or paste the full issue URL). |
| Web app says wrong host or token | Open it from the URL `agentpool serve` printed; it only accepts localhost. |

## Local web app (`agentpool serve`)

```sh
agentpool serve            # http://127.0.0.1:4317, for the repository you are in
```

A local page over the same event logs the CLI uses, so you can mix them: start a run in the browser, answer from the terminal, or the reverse.

- Run list with live status; a timeline that shows agent handoffs, **objections**, questions and decisions as they happen (system detail is a toggle).
- A "needs you" panel for blocking questions (option buttons plus free text), plan approval, and the stuck-after-rounds decision.
- Start a run from a typed task or a Jira issue, with real or dry-run agents; open the pull / merge request with a button; read the generated MR text.
- Local only: it listens on 127.0.0.1, rejects other Host and Origin headers, and every write needs a per-process token that the page fetches from the server. There are no accounts; anyone who can reach your localhost session can act as you, so do not forward the port.
- Runs execute inside the server process. Stopping the server stops the agents; `agentpool resume <id>` continues them.

## Tickets and pull requests

```sh
agentpool doctor                                   # checks tools, credentials, remote, config
agentpool run --jira PROJ-123 --open-pr            # task from Jira Cloud, PR/MR when done
agentpool run --jira https://acme.atlassian.net/browse/PROJ-123 "use the existing csv helper"
agentpool pr [run-id] [--dry-run] [--no-draft]     # open the request for a finished run later
```

- **GitHub and GitLab** are detected from the remote URL (github.com, gitlab.com, or a name containing "gitlab"). Self-hosted servers need `"git": {"host": "github"|"gitlab"}` in `.agentpool/config.json` (optionally `apiUrl`, the full API root, and `remote`).
- **Tokens** come from the environment and are never written to disk or logs: `GITHUB_TOKEN`/`GH_TOKEN` (or `gh auth login`), `GITLAB_TOKEN`. The token is checked before anything is pushed.
- The request is a **draft unless the run is ready for review**; `--draft` / `--no-draft` override. Running `pr` twice returns the existing request instead of opening a second one. The base branch must exist on the remote.
- **Jira Cloud** uses `JIRA_EMAIL` and `JIRA_API_TOKEN` (an Atlassian API token), plus `JIRA_BASE_URL` unless you paste the issue URL or set `"jira": {"baseUrl": ...}`. The ticket becomes the task, the request title is `KEY: summary`, and the agents are told ticket text is untrusted. Text you type alongside `--jira` is added as extra instructions. `agentpool jira PROJ-123` previews the task. `--jira-comment` posts the request link back on the ticket; it is off by default because it writes to a shared system.

## How a run works

```
task -> baseline -> plan -> [you approve] -> build -> QA -> review -> MR.md
                      |                       ^       |       |
                 questions                    +-------+-------+  objections, up to --max-rounds
              (park and wait)
```

1. **Baseline.** The run creates a branch `agentpool/<run-id>` in a worktree under `.agentpool/worktrees/`, detects the stack and test command, installs dependencies, and runs the tests once. Failures that already exist are recorded so nobody is blamed for them.
2. **Plan.** The planner (read-only) writes steps and acceptance criteria. It may raise a blocking question only when the answer changes the plan. Everything else becomes a logged assumption.
3. **Approval.** You approve or reject the plan. `--autonomy auto` skips this gate.
4. **Build.** The developer implements the plan in the worktree. The run commits the result.
5. **QA.** QA verifies each acceptance criterion by running something and may add test files. Afterwards the run re-runs the project's tests itself. If QA says pass and the tests fail, the run records a fail.
6. **Review.** The reviewer reads the diff. Its verdict follows its findings: any blocker or major finding means changes requested.
7. **Rounds.** QA and reviewer objections go back to the developer as typed messages, up to `--max-rounds` (default 2). After that the run parks and asks a person whether to finish anyway.
8. **Result.** `MR.md` has the summary, plan, decisions, test evidence, QA and review results, and a section listing what the agents were unsure about, plus the commands to push and open the request.

## Waiting for people

Questions and approvals are first-class, not chat messages. In a terminal the CLI prompts you. Without a terminal (or with `--no-interactive`) the run parks and exits. Answer from anywhere that has the repo:

```sh
agentpool status                         # what is it waiting for?
agentpool answer <run-id> Q-1 "table"    # answer a question
agentpool approve <run-id>               # or: agentpool reject <run-id> "reason"
agentpool resume <run-id>                # carry on
```

`--assume-defaults` means never wait: recommended answers are taken, and a stuck run finishes flagged as not ready.

## Commands

| Command | What it does |
| --- | --- |
| `run [task...]` | Start a run. `--task-file`, `--repo`, `--base`, `--autonomy`, `--runner`, `--model`, `--max-rounds`, `--budget-usd`, `--agent-budget-usd`, `--assume-defaults`, `--skip-baseline`, `--no-interactive`, `--jira`, `--open-pr`, `--draft`/`--no-draft`, `--jira-comment` |
| `resume [run-id]` | Continue a parked, failed or interrupted run |
| `status [run-id]` | Phase, spend, and what to do next |
| `list` | Runs in this repository |
| `log [run-id]` | Full event history (`--json` for raw lines) |
| `answer`, `approve`, `reject` | Human actions on a parked run |
| `agents` | The agents that would run here, including repo overrides |
| `pr [run-id]` | Push the branch and open the GitHub PR / GitLab MR. `--remote`, `--host`, `--draft`, `--no-draft`, `--jira-comment`, `--dry-run` |
| `jira <key\|url>` | Preview a Jira Cloud issue as a task |
| `doctor` | Check setup |
| `serve` | Local web app for the current repository (`--port`, `--repo`) |
| `server` | Team server: accounts, connected repos, a container per task. See [docs/self-hosting.md](docs/self-hosting.md) |
| `work <run-id>` | Internal: what a task container runs to drive a run to its next stopping point |
| `clean <run-id>` | Remove a run's worktree; the branch stays |

## Agents and skills are files

Each agent is a markdown file with YAML frontmatter. The body is its system prompt. Built-ins live in [`agents/`](agents) and [`skills/`](skills).

```markdown
---
name: qa
role: Verifies the change against the acceptance criteria and adds tests
tools: [Read, Glob, Grep, Edit, Write, Bash]
writeScope: ["**/*.test.*", "test/**", "tests/**"]
maxTurns: 40
skills: [handoff-format, verify-by-running]
---
You are QA on a software delivery team...
```

- `tools` is the only set of tools the agent can use.
- `writeScope` is enforced after every step. Files outside it are reverted and the violation is recorded and shown in `MR.md`. An empty list means read-only.
- `skills` are markdown files in `skills/` appended to the prompt.

A repository can add or replace agents and skills by committing them under `.agentpool/agents/` and `.agentpool/skills/`. Repo files win by name. Optional `.agentpool/config.json`:

```json
{
  "commands": { "setup": "npm ci", "test": "npm test", "lint": "npm run lint" },
  "autonomy": "plan-approval",
  "maxRounds": 2,
  "budgetUsd": 10,
  "agentBudgetUsd": 3,
  "model": "..."
}
```

An empty string for a command switches off what was auto-detected.

## Design notes

- **Event-sourced.** Everything that happens is appended to `.agentpool/runs/<id>/events.jsonl`. Run state is always folded from that log, so a run can stop anywhere and resume, and `agentpool log` shows exactly what happened.
- **Agents do not chat.** Each returns a typed JSON result. The run turns results into messages (`handoff`, `objection`, `question`, `decision`) and builds the next agent's brief from them. Malformed JSON gets one repair attempt.
- **Evidence over claims.** The run executes the test command itself and records the result next to what QA claimed.
- **Isolation.** Each run works in its own git worktree on its own branch. Your checkout is never touched. Step commits skip git hooks; your CI still runs on the pushed branch.
- **Cost control.** Per-run budget (`--budget-usd`), per-agent-step budget and turn limits. A run that hits its budget stops as failed.
- **Agent runtime.** Each agent runs through the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) with its own tool allowlist, working directory and limits. The `AgentRunner` interface in `src/runner.ts` is the seam for other runtimes.

## Safety, as it stands

This section is about the local CLI and `serve`. The team server runs each task in a container; see [docs/self-hosting.md](docs/self-hosting.md#how-tasks-are-isolated) for what that covers.


Agents run with `acceptEdits` permissions and can use the tools their definition lists, including Bash for the developer, QA and reviewer. The worktree and write-scope checks limit what lands in the branch, but this is **not a sandbox**: a Bash command can still reach anything your user account can. Run it in a container or VM for anything you do not trust. Treat task text pasted from tickets as untrusted input.

## What is not here yet

- Jira Server / Data Center, other trackers, and updating a pull request after review comments
- Product owner, architect, UX, and separate frontend and backend roles
- Hosted multi-tenant service, SSO / OAuth sign-in, per-repository permissions, webhooks (tasks from issues or comments), and a database instead of a JSON file
- Repo zones for mixed modern and legacy code, and learning from corrections
- Real sandboxing, and agent-to-agent threads with humans joining mid-conversation
- Independent proposals and disagreement cards between agents

## Development

```sh
npm test            # unit tests and orchestrator tests with scripted agents
npm run typecheck
npm run dev -- run --runner dry-run "..."
```
