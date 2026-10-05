import * as NodeCrypto from "node:crypto";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Exit from "effect/Exit";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Request from "effect/Request";
import * as RequestResolver from "effect/RequestResolver";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  TrimmedNonEmptyString,
  type GitHubAccountBinding,
  type GitHubLoginStartResult,
  type GitHubLoginStatus,
  type GitHubLoginStatusInput,
  type SourceControlRepositoryVisibility,
  type VcsError,
} from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import { parseGitHubAuthStatus } from "./gitHubAuthStatus.ts";
import * as GitHubGraphQlBudget from "./githubGraphQlBudget.ts";
import * as SourceControlRateLimit from "./SourceControlRateLimit.ts";
import {
  decodeGitHubPullRequestEntries,
  decodeGitHubPullRequestJson,
  decodeGitHubPullRequestListJson,
  type NormalizedGitHubPullRequestRecord,
} from "./gitHubPullRequests.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

const SelectedAccountEnv = Context.Reference<NodeJS.ProcessEnv | null | undefined>(
  "t3/sourceControl/SelectedAccountEnv",
  { defaultValue: () => null },
);

/** Server-local credential scope; never put its value in RPC payloads or cache keys. */
export const PinnedGitHubCredential = Context.Reference<{
  readonly host: string;
  readonly token: Redacted.Redacted<string>;
  readonly credentialFingerprint: string;
} | null>("t3/sourceControl/PinnedGitHubCredential", { defaultValue: () => null });

export const AllowGitHubReserve = Context.Reference<boolean>(
  "t3/sourceControl/AllowGitHubReserve",
  { defaultValue: () => false },
);

function commandHosts(args: ReadonlyArray<string>): Array<string | null> {
  const hosts: Array<string | null> = [];
  const repositoryHost = (repository: string | undefined) => {
    if (repository === undefined) return null;
    if (/^https?:\/\//i.test(repository)) {
      try {
        return new URL(repository).host.toLowerCase();
      } catch {
        return null;
      }
    }
    const parts = repository.split("/");
    return parts.length === 3 ? parts[0]!.toLowerCase() : null;
  };
  if (args[0] === "repo" && args[1] === "view") hosts.push(repositoryHost(args[2]));
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--hostname") hosts.push(args[++index]?.toLowerCase() ?? null);
    else if (arg.startsWith("--hostname=")) hosts.push(arg.slice(11).toLowerCase());
    else if (arg === "--repo" || arg === "-R") hosts.push(repositoryHost(args[++index]));
    else if (arg.startsWith("--repo=")) hosts.push(repositoryHost(arg.slice(7)));
    else if (arg.startsWith("-R")) hosts.push(repositoryHost(arg.slice(2)));
    else if (/^https?:\/\//i.test(arg)) hosts.push(repositoryHost(arg));
  }
  return hosts;
}

function targetsVerifiedHost(args: ReadonlyArray<string>, host: string): boolean {
  const hosts = commandHosts(args);
  return hosts.length > 0 && hosts.every((target) => target === host);
}

const gitHubCliFailureFields = {
  command: Schema.Literal("gh"),
  cwd: Schema.String,
  cause: Schema.Defect(),
  account: Schema.optional(TrimmedNonEmptyString),
} as const;

export class GitHubCliUnavailableError extends Schema.TaggedError<GitHubCliUnavailableError>()(
  "GitHubCliUnavailableError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "GitHub CLI (`gh`) is required but not available on PATH.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubCliAuthenticationError extends Schema.TaggedError<GitHubCliAuthenticationError>()(
  "GitHubCliAuthenticationError",
  {
    ...gitHubCliFailureFields,
    reason: Schema.optional(TrimmedNonEmptyString),
  },
) {
  get detail(): string {
    return (
      this.reason ??
      (this.account
        ? `GitHub account ${this.account} is selected for this project but is not authenticated. Add that account with \`gh auth login\` and retry.`
        : "GitHub CLI is not authenticated. Run `gh auth login` and retry.")
    );
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubCliRateLimitError extends Schema.TaggedError<GitHubCliRateLimitError>()(
  "GitHubCliRateLimitError",
  { ...gitHubCliFailureFields, retryAt: Schema.optionalKey(Schema.Finite) },
) {
  get detail(): string {
    return "GitHub API rate limit exceeded. Run `gh api rate_limit` to inspect the quota and reset time.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubPullRequestNotFoundError extends Schema.TaggedError<GitHubPullRequestNotFoundError>()(
  "GitHubPullRequestNotFoundError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "Pull request not found. Check the PR number or URL and try again.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubCliCommandError extends Schema.TaggedError<GitHubCliCommandError>()(
  "GitHubCliCommandError",
  { ...gitHubCliFailureFields, httpStatus: Schema.optional(Schema.Int) },
) {
  get detail(): string {
    return "GitHub CLI command failed.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubCliLoginError extends Schema.TaggedError<GitHubCliLoginError>()(
  "GitHubCliLoginError",
  {
    ...gitHubCliFailureFields,
    reason: TrimmedNonEmptyString,
  },
) {
  get detail(): string {
    return this.reason;
  }

  override get message(): string {
    return `GitHub CLI failed in beginLogin: ${this.detail}`;
  }
}
const isGitHubCliLoginError = Schema.is(GitHubCliLoginError);

const gitHubCliDecodeFields = {
  command: Schema.Literal("gh"),
  cwd: Schema.String,
  cause: Schema.Defect(),
} as const;

export class GitHubPullRequestListDecodeError extends Schema.TaggedError<GitHubPullRequestListDecodeError>()(
  "GitHubPullRequestListDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid PR list JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in listOpenPullRequests: ${this.detail}`;
  }
}

export class GitHubChangeRequestListDecodeError extends Schema.TaggedError<GitHubChangeRequestListDecodeError>()(
  "GitHubChangeRequestListDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid change request JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in listChangeRequests: ${this.detail}`;
  }
}

export class GitHubPullRequestDecodeError extends Schema.TaggedError<GitHubPullRequestDecodeError>()(
  "GitHubPullRequestDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid pull request JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in getPullRequest: ${this.detail}`;
  }
}

export class GitHubRepositoryDecodeError extends Schema.TaggedError<GitHubRepositoryDecodeError>()(
  "GitHubRepositoryDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid repository JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in getRepositoryCloneUrls: ${this.detail}`;
  }
}

export const GitHubCliError = Schema.Union([
  GitHubCliUnavailableError,
  GitHubCliAuthenticationError,
  GitHubCliRateLimitError,
  GitHubPullRequestNotFoundError,
  GitHubCliCommandError,
  GitHubCliLoginError,
  GitHubPullRequestListDecodeError,
  GitHubChangeRequestListDecodeError,
  GitHubPullRequestDecodeError,
  GitHubRepositoryDecodeError,
]);
export type GitHubCliError = typeof GitHubCliError.Type;

export const isGitHubCliError = Schema.is(GitHubCliError);

export function fromVcsError(
  context: {
    readonly command: "gh";
    readonly cwd: string;
    readonly account?: string;
  },
  error: VcsError,
): GitHubCliError {
  if (
    error._tag === "VcsProcessSpawnError" &&
    error.cause instanceof PlatformError.PlatformError &&
    error.cause.reason._tag === "NotFound" &&
    error.cause.reason.module === "ChildProcess" &&
    error.cause.reason.method === "spawn"
  ) {
    return new GitHubCliUnavailableError({ ...context, cause: error });
  }

  if (error._tag === "VcsProcessExitError") {
    if (error.failureKind === "authentication") {
      return new GitHubCliAuthenticationError({ ...context, cause: error });
    }
    if (error.failureKind === "rate-limited") {
      return new GitHubCliRateLimitError({ ...context, cause: error });
    }
    if (error.failureKind === "not-found") {
      return new GitHubPullRequestNotFoundError({ ...context, cause: error });
    }
  }

  return new GitHubCliCommandError({ ...context, cause: error });
}

export interface GitHubPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state?: "open" | "closed" | "merged";
  readonly isDraft?: boolean;
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
  readonly updatedAt?: string;
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

function pullRequestSummary(input: NormalizedGitHubPullRequestRecord): GitHubPullRequestSummary {
  const { updatedAt, ...summary } = input;
  return {
    ...summary,
    ...(Option.isSome(updatedAt) ? { updatedAt: DateTime.formatIso(updatedAt.value) } : {}),
  };
}

export interface GitHubRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export class GitHubCli extends Context.Service<
  GitHubCli,
  {
    readonly execute: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly timeoutMs?: number;
      /** Piped to the child's stdin, for payloads that must never appear in argv. */
      readonly stdin?: string;
      readonly env?: NodeJS.ProcessEnv;
      readonly maxOutputBytes?: number;
      readonly account?: string;
      readonly rateLimitHost?: string;
      readonly allowReserve?: boolean;
      readonly acceptNotModified?: boolean;
    }) => Effect.Effect<VcsProcess.VcsProcessOutput, GitHubCliError>;

    readonly getAccountBinding: (input: {
      readonly cwd: string;
    }) => Effect.Effect<GitHubAccountBinding, GitHubCliError>;

    readonly setAccountBinding: (input: {
      readonly cwd: string;
      readonly account: string | null;
    }) => Effect.Effect<GitHubAccountBinding, GitHubCliError>;

    readonly beginLogin: (input: {
      readonly cwd: string;
    }) => Effect.Effect<GitHubLoginStartResult, GitHubCliError>;

    readonly getLoginStatus: (input: GitHubLoginStatusInput) => Effect.Effect<GitHubLoginStatus>;

    readonly logoutAccount: (input: {
      readonly cwd: string;
      readonly account: string;
      readonly host: string;
    }) => Effect.Effect<void, GitHubCliError>;

    readonly listOpenPullRequests: (input: {
      readonly cwd: string;
      readonly headSelector: string;
      readonly limit?: number;
      readonly rateLimitHost?: string;
    }) => Effect.Effect<ReadonlyArray<GitHubPullRequestSummary>, GitHubCliError>;

    /**
     * Pull requests whose head is `headSelector`, in the repository `gh pr list` would read in
     * `cwd`. Lookups on one repository that arrive together share one GraphQL document; a
     * checkout whose repository gh could pick another way is asked through `gh pr list`.
     */
    readonly listPullRequestsByHead: (input: {
      readonly cwd: string;
      readonly headSelector: string;
      readonly state: "open" | "closed" | "merged" | "all";
      readonly limit: number;
      /** The checkout's GitHub host. Without it the lookup is not batched. */
      readonly rateLimitHost?: string;
    }) => Effect.Effect<ReadonlyArray<NormalizedGitHubPullRequestRecord>, GitHubCliError>;

    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly rateLimitHost?: string;
    }) => Effect.Effect<GitHubPullRequestSummary, GitHubCliError>;

    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly account?: string;
    }) => Effect.Effect<GitHubRepositoryCloneUrls, GitHubCliError>;

    readonly createRepository: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly visibility: SourceControlRepositoryVisibility;
      readonly account?: string;
    }) => Effect.Effect<GitHubRepositoryCloneUrls, GitHubCliError>;

    readonly createPullRequest: (input: {
      readonly cwd: string;
      readonly baseBranch: string;
      readonly headSelector: string;
      readonly title: string;
      readonly bodyFile: string;
    }) => Effect.Effect<void, GitHubCliError>;

    readonly getDefaultBranch: (input: {
      readonly cwd: string;
      readonly rateLimitHost?: string;
    }) => Effect.Effect<string | null, GitHubCliError>;

    readonly checkoutPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly force?: boolean;
    }) => Effect.Effect<void, GitHubCliError>;
  }
>()("t3/sourceControl/GitHubCli") {}

const RawGitHubRepositoryCloneUrlsSchema = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});
const decodeRawGitHubRepositoryCloneUrls = Schema.decodeEffect(
  Schema.fromJsonString(RawGitHubRepositoryCloneUrlsSchema),
);

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawGitHubRepositoryCloneUrlsSchema>,
): GitHubRepositoryCloneUrls {
  return {
    nameWithOwner: raw.nameWithOwner,
    url: raw.url,
    sshUrl: raw.sshUrl,
  };
}

export function extractGitHubDeviceCode(text: string): string | null {
  return text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/u)?.[1] ?? null;
}

/**
 * `gh repo create` prints the canonical URL of the new repository on stdout
 * (e.g. `https://github.com/owner/repo`). Reading it back here avoids a
 * follow-up `gh repo view`, which can race GitHub's GraphQL eventual
 * consistency window and falsely report the just-created repo as missing.
 */
function deriveRepositoryCloneUrlsFromCreateOutput(
  stdout: string,
  repository: string,
): GitHubRepositoryCloneUrls {
  const fallbackHost = "github.com";
  const match = stdout.match(/https?:\/\/[^\s]+/);
  if (match) {
    const cleaned = match[0].replace(/\.git$/, "");
    try {
      const parsed = new URL(cleaned);
      const pathname = parsed.pathname.replace(/^\/+|\/+$/g, "");
      const segments = pathname.split("/").filter(Boolean);
      if (segments.length === 2) {
        const nameWithOwner = `${segments[0]}/${segments[1]}`;
        return {
          nameWithOwner,
          url: `${parsed.origin}/${nameWithOwner}`,
          sshUrl: `git@${parsed.host}:${nameWithOwner}.git`,
        };
      }
    } catch {
      // Fall through to the input-derived defaults below.
    }
  }
  return {
    nameWithOwner: repository,
    url: `https://${fallbackHost}/${repository}`,
    sshUrl: `git@${fallbackHost}:${repository}.git`,
  };
}

type PullRequestListState = "open" | "closed" | "merged" | "all";

const PULL_REQUEST_LIST_JSON_FIELDS =
  "number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,closedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner";
/** The `gh pr list --json` fields above, as GraphQL selects them. */
const PULL_REQUEST_NODE_SELECTION =
  "number title url baseRefName headRefName state isDraft mergedAt closedAt updatedAt isCrossRepository headRepository { name nameWithOwner } headRepositoryOwner { login }";
const GRAPHQL_STATES: Record<PullRequestListState, ReadonlyArray<string>> = {
  open: ["OPEN"],
  closed: ["CLOSED"],
  merged: ["MERGED"],
  all: ["OPEN", "CLOSED", "MERGED"],
};
/**
 * Head lookups per GraphQL document. A document of a hundred costs one point, the same as one
 * `gh pr list`, but half that keeps each answer near half a second.
 */
const HEAD_LOOKUPS_PER_DOCUMENT = 50;
/**
 * How long a head lookup waits for company. Branch discovery reaches GitHub only after each
 * branch's own git reads, so lookups started together arrive tens of milliseconds apart.
 */
const HEAD_LOOKUP_BATCH_WINDOW = "50 millis";
/** A full document is 5,000 rows of well under 2 KB each. */
const HEAD_LOOKUP_MAX_OUTPUT_BYTES = 16_000_000;
const RATE_LIMIT_READING = "query { rateLimit { cost limit remaining resetAt } }";

class PullRequestsByHeadRead extends Request.Class<
  {
    readonly cwd: string;
    readonly host: string;
    readonly owner: string;
    readonly name: string;
    readonly headRefName: string;
    readonly state: PullRequestListState;
    readonly limit: number;
  },
  ReadonlyArray<NormalizedGitHubPullRequestRecord>,
  GitHubCliError
> {}

const GraphQlVariables = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Array(Schema.String)]),
);
/** A GraphQL request body for `gh api graphql --input -`. */
const encodeGraphQlRequest = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ query: Schema.String, variables: GraphQlVariables })),
);

/** One aliased `pullRequests` connection per lookup, each head and state passed as a variable. */
function buildPullRequestsByHeadQuery(
  lookups: ReadonlyArray<Pick<PullRequestsByHeadRead, "headRefName" | "state" | "limit">>,
): { readonly document: string; readonly variables: typeof GraphQlVariables.Type } {
  const variables: Record<string, string | ReadonlyArray<string>> = {};
  const declarations: string[] = ["$owner: String!", "$name: String!"];
  const selections: string[] = [];
  for (const [index, lookup] of lookups.entries()) {
    variables[`h${index}`] = lookup.headRefName;
    variables[`s${index}`] = GRAPHQL_STATES[lookup.state];
    declarations.push(`$h${index}: String!`, `$s${index}: [PullRequestState!]`);
    // `gh pr list` orders the same way, so a head with more matches than the limit keeps the
    // same rows.
    selections.push(
      `    h${index}: pullRequests(headRefName: $h${index}, states: $s${index}, first: ${lookup.limit}, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${PULL_REQUEST_NODE_SELECTION} } }`,
    );
  }
  return {
    document: `query PullRequestsByHead(${declarations.join(", ")}) {\n  repository(owner: $owner, name: $name) {\n${selections.join("\n")}\n  }\n}`,
    variables,
  };
}

/** The reset time of a `rateLimit` reading, which sets when the next one is due. */
const decodeRateLimitReading = (raw: string) =>
  Result.map(
    decodeJsonResult(
      Schema.Struct({
        data: Schema.Struct({ rateLimit: Schema.Struct({ resetAt: Schema.String }) }),
      }),
    )(raw),
    (reading) => reading.data.rateLimit.resetAt,
  );

const decodePullRequestsByHead = decodeJsonResult(
  Schema.Struct({
    data: Schema.Struct({
      repository: Schema.Record(
        Schema.String,
        Schema.NullOr(Schema.Struct({ nodes: Schema.Array(Schema.Unknown) })),
      ),
    }),
  }),
);

/**
 * The repository `gh pr list` reads in a checkout, picked the way gh picks one without a
 * prompt: the remote `gh repo set-default` marked, else the first of upstream, github, origin
 * (in any case), else the only remote. `remotes` is `git remote -v` output and `resolved` is the output of
 * `git config --get-regexp '^remote\..*\.gh-resolved$'`.
 *
 * Null whenever gh might weigh the remotes differently: a remote on another host or under an
 * SSH alias, more than one mark, or several remotes with none of those names. Callers then
 * ask gh itself.
 */
export function selectGitHubBaseRepository(input: {
  readonly remotes: string;
  readonly resolved: string;
  readonly host: string;
}): { readonly owner: string; readonly name: string } | null {
  const host = input.host.toLowerCase();
  const repositories = new Map<string, { readonly owner: string; readonly name: string }>();
  for (const line of input.remotes.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/u.exec(line.trim());
    if (!match) continue;
    const [remoteHost, owner, name, ...rest] = normalizeGitRemoteUrl(match[2]!).split("/");
    if (remoteHost !== host || !owner || !name || rest.length > 0) return null;
    repositories.set(match[1]!, { owner, name });
  }
  const marks = input.resolved
    .split("\n")
    .map((line) => /^remote\.(.+)\.gh-resolved\s+(\S+)$/u.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null && repositories.has(match[1]!));
  if (marks.length > 1) return null;
  const [mark] = marks;
  if (mark) {
    if (mark[2] === "base") return repositories.get(mark[1]!) ?? null;
    const [owner, name, ...rest] = mark[2]!.toLowerCase().split("/");
    return owner && name && rest.length === 0 ? { owner, name } : null;
  }
  // gh sorts remotes by these names, case-insensitively, and takes the first. A tie for the
  // top place has no defined winner.
  const score = (remoteName: string) =>
    ["origin", "github", "upstream"].indexOf(remoteName.toLowerCase()) + 1;
  const ranked = [...repositories.entries()].toSorted(
    ([left], [right]) => score(right) - score(left),
  );
  const [top, next] = ranked;
  return top !== undefined && (next === undefined || score(top[0]) > score(next[0]))
    ? top[1]
    : null;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const spawner = yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner);
  const serviceScope = yield* Effect.scope;
  let activeLogin: {
    readonly loginId: string;
    readonly child: ChildProcessSpawner.ChildProcessHandle;
    readonly authenticatedAccountsBefore: ReadonlySet<string>;
    userCode: string | null;
  } | null = null;
  let nextLoginId = 0;
  const loginStatuses = new Map<string, GitHubLoginStatus>();
  const setLoginStatus = (loginId: string, status: GitHubLoginStatus) => {
    loginStatuses.delete(loginId);
    loginStatuses.set(loginId, status);
    if (loginStatuses.size <= 20) return;
    const oldestLoginId = loginStatuses.keys().next().value;
    if (oldestLoginId !== undefined) loginStatuses.delete(oldestLoginId);
  };
  const getLoginStatus: GitHubCli["Service"]["getLoginStatus"] = (input) =>
    Effect.sync(
      () =>
        loginStatuses.get(input.loginId) ?? {
          status: "failed",
          detail: "This GitHub sign-in session is no longer available. Start again.",
        },
    );

  const readAccount = Effect.fn("GitHubCli.readAccount")(function* (input: {
    readonly cwd: string;
    readonly local: boolean;
  }) {
    const result = yield* vcsProcess
      .run({
        operation: "GitHubCli.readAccount",
        command: "git",
        args: ["config", ...(input.local ? ["--local"] : []), "--get", "github.account"],
        cwd: input.cwd,
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 4_000,
      })
      .pipe(
        Effect.mapError(
          (error) => new GitHubCliCommandError({ command: "gh", cwd: input.cwd, cause: error }),
        ),
      );
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      return yield* new GitHubCliCommandError({
        command: "gh",
        cwd: input.cwd,
        cause: new Error(`Git could not read github.account (exit ${result.exitCode}).`),
      });
    }
    const account = result.stdout.trim();
    return account.length > 0 ? account : null;
  });

  const getAccountBinding: GitHubCli["Service"]["getAccountBinding"] = Effect.fn(
    "GitHubCli.getAccountBinding",
  )(function* (input) {
    const localAccount = yield* readAccount({ cwd: input.cwd, local: true });
    if (localAccount !== null) {
      return { account: localAccount, source: "repository" };
    }
    const inheritedAccount = yield* readAccount({ cwd: input.cwd, local: false });
    return inheritedAccount === null
      ? { account: null, source: "none" }
      : { account: inheritedAccount, source: "inherited" };
  });

  const resolveTokenForAccount = Effect.fn("GitHubCli.resolveTokenForAccount")(function* (
    cwd: string,
    account: string,
  ) {
    const tokenResult = yield* vcsProcess
      .run({
        operation: "GitHubCli.resolveAccountToken",
        command: "gh",
        args: ["auth", "token", "--hostname", "github.com", "--user", account],
        cwd,
        env: { GH_TOKEN: "", GITHUB_TOKEN: "" },
        timeoutMs: 5_000,
        maxOutputBytes: 4_000,
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new GitHubCliAuthenticationError({ command: "gh", cwd, account, cause: error }),
        ),
      );
    const token = tokenResult.stdout.trim();
    if (token.length === 0) {
      return yield* new GitHubCliAuthenticationError({
        command: "gh",
        cwd,
        account,
        cause: new Error("GitHub CLI returned an empty token for the selected account."),
      });
    }
    return { GH_TOKEN: token };
  });

  const resolveAccountEnv = Effect.fn("GitHubCli.resolveAccountEnv")(function* (cwd: string) {
    const configuredAccount = yield* readAccount({ cwd, local: false });
    if (configuredAccount !== null) {
      return yield* resolveTokenForAccount(cwd, configuredAccount);
    }

    const statusResult = yield* vcsProcess
      .run({
        operation: "GitHubCli.resolveAvailableAccounts",
        command: "gh",
        args: ["auth", "status", "--json", "hosts"],
        cwd,
        env: { GH_TOKEN: "", GITHUB_TOKEN: "" },
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 16_000,
      })
      .pipe(
        Effect.mapError(
          (error) => new GitHubCliAuthenticationError({ command: "gh", cwd, cause: error }),
        ),
      );
    const accounts = parseGitHubAuthStatus(statusResult.stdout).accounts.filter(
      (account) => account.host === "github.com" && account.authenticated,
    );
    if (accounts.length > 1) {
      return yield* new GitHubCliAuthenticationError({
        command: "gh",
        cwd,
        reason:
          "Multiple GitHub accounts are signed in. Choose an account for this project before continuing.",
        cause: new Error("GitHub account selection is required."),
      });
    }
    const onlyAccount = accounts[0]?.account;
    return onlyAccount ? yield* resolveTokenForAccount(cwd, onlyAccount) : undefined;
  });
  const accountEnvCache = yield* Cache.make({
    capacity: 512,
    timeToLive: Duration.seconds(2),
    lookup: resolveAccountEnv,
  });

  const setAccountBinding: GitHubCli["Service"]["setAccountBinding"] = Effect.fn(
    "GitHubCli.setAccountBinding",
  )(function* (input) {
    const result = yield* vcsProcess
      .run({
        operation: "GitHubCli.setAccountBinding",
        command: "git",
        args:
          input.account === null
            ? ["config", "--local", "--unset-all", "github.account"]
            : ["config", "--local", "--replace-all", "github.account", input.account],
        cwd: input.cwd,
        allowNonZeroExit: input.account === null,
        timeoutMs: 5_000,
        maxOutputBytes: 4_000,
      })
      .pipe(
        Effect.mapError(
          (error) => new GitHubCliCommandError({ command: "gh", cwd: input.cwd, cause: error }),
        ),
      );
    if (input.account === null && result.exitCode !== 0 && result.exitCode !== 5) {
      return yield* new GitHubCliCommandError({
        command: "gh",
        cwd: input.cwd,
        cause: new Error(`Git could not clear github.account (exit ${result.exitCode}).`),
      });
    }
    yield* Cache.invalidate(accountEnvCache, input.cwd);
    return yield* getAccountBinding({ cwd: input.cwd });
  });

  const readAuthenticatedAccounts = Effect.fn("GitHubCli.readAuthenticatedAccounts")(function* (
    cwd: string,
  ) {
    const result = yield* vcsProcess
      .run({
        operation: "GitHubCli.readAuthenticatedAccounts",
        command: "gh",
        args: ["auth", "status", "--json", "hosts"],
        cwd,
        env: { GH_TOKEN: "", GITHUB_TOKEN: "" },
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 16_000,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new GitHubCliLoginError({
              command: "gh",
              cwd,
              reason: "GitHub CLI could not inspect the signed-in accounts.",
              cause,
            }),
        ),
      );
    return new Set(
      parseGitHubAuthStatus(result.stdout)
        .accounts.filter((account) => account.host === "github.com" && account.authenticated)
        .map((account) => account.account),
    );
  });

  const resolveCompletedLoginAccount = Effect.fn("GitHubCli.resolveCompletedLoginAccount")(
    function* (session: NonNullable<typeof activeLogin>, cwd: string) {
      const authenticatedAccountsAfter = yield* readAuthenticatedAccounts(cwd);
      const addedAccount = [...authenticatedAccountsAfter].find(
        (account) => !session.authenticatedAccountsBefore.has(account),
      );
      if (addedAccount) return { account: addedAccount, alreadyAuthenticated: false };

      const result = yield* vcsProcess
        .run({
          operation: "GitHubCli.resolveCompletedLoginAccount",
          command: "gh",
          args: ["api", "user", "--jq", ".login"],
          cwd,
          env: { GH_TOKEN: "", GITHUB_TOKEN: "" },
          timeoutMs: 5_000,
          maxOutputBytes: 4_000,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new GitHubCliLoginError({
                command: "gh",
                cwd,
                reason: "GitHub sign-in completed, but the account could not be identified.",
                cause,
              }),
          ),
        );
      const account = result.stdout.trim();
      if (!account) {
        return yield* new GitHubCliLoginError({
          command: "gh",
          cwd,
          reason: "GitHub sign-in completed, but the account could not be identified.",
          cause: new Error("GitHub CLI returned an empty account name."),
        });
      }
      return {
        account,
        alreadyAuthenticated: session.authenticatedAccountsBefore.has(account),
      };
    },
  );

  const beginLogin: GitHubCli["Service"]["beginLogin"] = Effect.fn("GitHubCli.beginLogin")(
    function* (input) {
      if (activeLogin?.userCode) {
        return {
          loginId: activeLogin.loginId,
          verificationUri: "https://github.com/login/device",
          userCode: activeLogin.userCode,
        };
      }
      if (activeLogin) {
        return yield* new GitHubCliLoginError({
          command: "gh",
          cwd: input.cwd,
          reason: "A GitHub sign-in is already starting. Try again in a moment.",
          cause: new Error("GitHub login process is already running."),
        });
      }

      if (Option.isNone(spawner)) {
        return yield* new GitHubCliLoginError({
          command: "gh",
          cwd: input.cwd,
          reason: "GitHub sign-in is unavailable in this environment.",
          cause: new Error("Child process spawning is unavailable."),
        });
      }
      const authenticatedAccountsBefore = yield* readAuthenticatedAccounts(input.cwd);

      const child = yield* spawner.value
        .spawn(
          ChildProcess.make(
            "gh",
            [
              "auth",
              "login",
              "--hostname",
              "github.com",
              "--git-protocol",
              "ssh",
              "--skip-ssh-key",
              "--web",
            ],
            {
              cwd: input.cwd,
              env: { GH_TOKEN: "", GITHUB_TOKEN: "" },
              stdin: { stream: Stream.empty, endOnDone: true },
            },
          ),
        )
        .pipe(
          Effect.provideService(Scope.Scope, serviceScope),
          Effect.mapError(
            (cause) =>
              new GitHubCliLoginError({
                command: "gh",
                cwd: input.cwd,
                reason: "GitHub CLI could not start the browser sign-in flow.",
                cause,
              }),
          ),
        );
      const session: {
        readonly loginId: string;
        readonly child: ChildProcessSpawner.ChildProcessHandle;
        readonly authenticatedAccountsBefore: ReadonlySet<string>;
        userCode: string | null;
      } = {
        loginId: `github-login-${++nextLoginId}`,
        child,
        authenticatedAccountsBefore,
        userCode: null,
      };
      activeLogin = session;
      setLoginStatus(session.loginId, { status: "pending" });
      const deviceCode = yield* Deferred.make<GitHubLoginStartResult, GitHubCliError>();
      let output = "";

      const observeLogin = child.all.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            output = `${output}${chunk}`.slice(-8_000);
            const userCode = extractGitHubDeviceCode(output);
            if (session.userCode !== null || userCode === null) return;
            session.userCode = userCode;
            yield* Deferred.succeed(deviceCode, {
              loginId: session.loginId,
              verificationUri: "https://github.com/login/device",
              userCode,
            });
          }),
        ),
        Effect.andThen(child.exitCode),
        Effect.flatMap((exitCode) => {
          if (session.userCode === null) {
            const error = new GitHubCliLoginError({
              command: "gh",
              cwd: input.cwd,
              reason: "GitHub CLI ended before producing a device code.",
              cause: new Error(`GitHub login exited with code ${exitCode}.`),
            });
            setLoginStatus(session.loginId, { status: "failed", detail: error.detail });
            return Deferred.fail(deviceCode, error);
          }
          if (exitCode !== 0) {
            setLoginStatus(session.loginId, {
              status: "failed",
              detail: "GitHub sign-in did not complete. Try again.",
            });
            return Effect.void;
          }
          return resolveCompletedLoginAccount(session, input.cwd).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                setLoginStatus(session.loginId, { status: "succeeded", ...result });
              }),
            ),
            Effect.andThen(Cache.invalidateAll(accountEnvCache)),
          );
        }),
        Effect.catch((cause) =>
          Effect.gen(function* () {
            const error = isGitHubCliLoginError(cause)
              ? cause
              : new GitHubCliLoginError({
                  command: "gh",
                  cwd: input.cwd,
                  reason: "GitHub CLI sign-in output could not be read.",
                  cause,
                });
            setLoginStatus(session.loginId, { status: "failed", detail: error.detail });
            yield* Deferred.fail(deviceCode, error);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (activeLogin === session) activeLogin = null;
          }),
        ),
      );
      yield* observeLogin.pipe(Effect.forkIn(serviceScope));

      return yield* Deferred.await(deviceCode).pipe(
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () =>
            child.kill().pipe(
              Effect.ignore,
              Effect.andThen(
                Effect.sync(() => {
                  if (activeLogin === session) activeLogin = null;
                  setLoginStatus(session.loginId, {
                    status: "failed",
                    detail: "GitHub CLI did not produce a device code in time.",
                  });
                }),
              ),
              Effect.andThen(
                Effect.fail(
                  new GitHubCliLoginError({
                    command: "gh",
                    cwd: input.cwd,
                    reason: "GitHub CLI did not produce a device code in time.",
                    cause: new Error("Timed out waiting for GitHub device code."),
                  }),
                ),
              ),
            ),
        }),
      );
    },
  );

  const logoutAccount: GitHubCli["Service"]["logoutAccount"] = Effect.fn("GitHubCli.logoutAccount")(
    function* (input) {
      yield* vcsProcess
        .run({
          operation: "GitHubCli.logoutAccount",
          command: "gh",
          args: ["auth", "logout", "--hostname", input.host, "--user", input.account],
          cwd: input.cwd,
          env: { GH_TOKEN: "", GITHUB_TOKEN: "" },
          timeoutMs: 15_000,
          maxOutputBytes: 4_000,
        })
        .pipe(
          Effect.mapError((error) =>
            fromVcsError(
              {
                command: "gh",
                cwd: input.cwd,
                ...(input.account ? { account: input.account } : {}),
              },
              error,
            ),
          ),
        );
      yield* Cache.invalidateAll(accountEnvCache);
    },
  );

  const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;
  const limits = yield* SourceControlRateLimit.SourceControlRateLimit;

  const resolveCommandEnv = Effect.fn("GitHubCli.resolveCommandEnv")(function* (
    input: Parameters<GitHubCli["Service"]["execute"]>[0],
  ) {
    const selectedEnv = yield* SelectedAccountEnv;
    if (selectedEnv !== null) return selectedEnv;
    const credential = yield* PinnedGitHubCredential;
    const host =
      commandHosts(input.args).find((host) => host !== null) ??
      input.rateLimitHost ??
      input.env?.GH_HOST ??
      "github.com";
    if (
      credential !== null ||
      host !== "github.com" ||
      input.env?.GH_TOKEN ||
      input.env?.GITHUB_TOKEN
    )
      return input.env;
    const accountEnv = input.account
      ? yield* resolveTokenForAccount(input.cwd, input.account)
      : yield* Cache.get(accountEnvCache, input.cwd);
    return accountEnv === undefined ? input.env : { ...accountEnv, ...input.env };
  });

  const executeRaw: GitHubCli["Service"]["execute"] = Effect.fn("GitHubCli.executeRaw")(
    function* (input) {
      const credential = yield* PinnedGitHubCredential;
      if (credential !== null && !targetsVerifiedHost(input.args, credential.host)) {
        return yield* new GitHubCliCommandError({
          command: "gh",
          cwd: input.cwd,
          cause: new Error("The GitHub command does not target the verified credential's host."),
        });
      }
      const token = credential === null ? undefined : Redacted.value(credential.token);
      const env =
        credential === null
          ? yield* resolveCommandEnv(input)
          : {
              ...input.env,
              GH_HOST: credential.host,
              GH_TOKEN: token,
              GITHUB_TOKEN: token,
              GH_ENTERPRISE_TOKEN: token,
              GITHUB_ENTERPRISE_TOKEN: token,
              GH_DEBUG: "",
            };
      if (input.args[0] === "auth" && input.args[1] === "token" && env?.GH_TOKEN) {
        return {
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: env.GH_TOKEN,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }
      const result = yield* vcsProcess
        .run({
          operation: "GitHubCli.execute",
          command: "gh",
          args: input.args,
          cwd: input.cwd,
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          ...(input.acceptNotModified ? { allowNonZeroExit: true } : {}),
          ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
          ...(env !== undefined ? { env } : {}),
          ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
        })
        .pipe(Effect.mapError((error) => fromVcsError({ command: "gh", cwd: input.cwd }, error)));
      if (result.exitCode !== 0 && input.acceptNotModified) {
        const status = /^HTTP\/\S+ (\d+)/.exec(result.stdout)?.[1];
        if (status !== "304" || !input.args.includes("--include")) {
          const context = { command: "gh" as const, cwd: input.cwd, cause: undefined };
          const headers = result.stdout.split(/\r?\n\r?\n/, 1)[0] ?? "";
          const header = (name: string) =>
            new RegExp(`^${name}:\\s*(.*)$`, "im").exec(headers)?.[1]?.trim();
          if (
            status === "429" ||
            (status === "403" &&
              (header("x-ratelimit-remaining") === "0" ||
                header("retry-after") !== undefined ||
                /rate limit/i.test(result.stderr)))
          ) {
            const now = DateTime.toEpochMillis(yield* DateTime.now);
            const reset = Number(header("x-ratelimit-reset")) * 1_000;
            const retryAt =
              SourceControlRateLimit.retryAtFromHeader(header("retry-after"), now) ??
              (Number.isFinite(reset) && reset > now ? reset : undefined);
            return yield* new GitHubCliRateLimitError({
              ...context,
              ...(retryAt === undefined ? {} : { retryAt }),
            });
          }
          if (status === "401") return yield* new GitHubCliAuthenticationError(context);
          return yield* new GitHubCliCommandError({
            ...context,
            ...(status === undefined ? {} : { httpStatus: Number(status) }),
          });
        }
      }
      return result;
    },
  );

  /**
   * A GraphQL `rateLimit` reading per host and credential, so the budget knows the balance
   * before reads that cannot report their own cost (`gh pr list`). GraphQL documents keep it
   * current in between. Each reading costs one point and is redone at the reset, or after ten
   * minutes so a `gh auth switch` is not priced against the old account for a whole hour.
   */
  const budgetReading = yield* Cache.makeWith(
    (key: string) => {
      const host = key.split("\0")[0]!;
      return executeRaw({
        cwd: globalThis.process.cwd(),
        args: ["api", "graphql", "--hostname", host, "-f", `query=${RATE_LIMIT_READING}`],
      }).pipe(
        Effect.tap((result) => budget.observe(host, result.stdout)),
        Effect.flatMap((result) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((now) => {
              const resetAtMs = Date.parse(
                decodeRateLimitReading(result.stdout).pipe(
                  Result.match({ onFailure: () => "", onSuccess: (reading) => reading }),
                ),
              );
              // A reset that is missing or already past (a skewed clock) waits a minute, so a
              // bad reading cannot ask again on every read.
              return Duration.millis(
                Number.isFinite(resetAtMs) && resetAtMs > now
                  ? Math.min(resetAtMs - now, 600_000)
                  : 60_000,
              );
            }),
          ),
        ),
      );
    },
    {
      capacity: 32,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? exit.value : Duration.minutes(1)),
    },
  );
  /**
   * Runs a GraphQL-priced read under its host's pause and the GraphQL budget. `run` receives
   * the document with `rateLimit` added, so a GraphQL read can report what it spent; a CLI read
   * ignores it and is priced at one point.
   */
  const guardedRead = <A>(input: {
    readonly cwd: string;
    readonly host: string;
    readonly document: string;
    readonly allowReserve: boolean;
    readonly run: (document: string) => Effect.Effect<A, GitHubCliError>;
  }) =>
    Effect.gen(function* () {
      const credential = yield* PinnedGitHubCredential;
      const selectedEnv = yield* SelectedAccountEnv;
      const selectedToken = selectedEnv?.GH_TOKEN ?? selectedEnv?.GITHUB_TOKEN;
      const fingerprint =
        credential?.credentialFingerprint ??
        (selectedToken
          ? `${input.host}:${NodeCrypto.createHash("sha256").update(selectedToken).digest("hex")}`
          : "");
      const key = { provider: "github" as const, host: input.host };
      const guarded = Effect.gen(function* () {
        const lease = yield* limits.check(
          key,
          input.allowReserve ? { allowPaused: true } : undefined,
        );
        // A failed reading leaves the budget unknown; it never blocks the read itself.
        yield* Cache.get(
          budgetReading,
          `${input.host}\0${yield* SourceControlRateLimit.CredentialScope}`,
        ).pipe(Effect.ignore);
        return yield* budget
          .query(
            input.host,
            input.document,
            input.allowReserve ? { allowReserve: true } : undefined,
          )
          .pipe(
            Effect.flatMap(input.run),
            Effect.tap(() => limits.recordSuccess({ ...key, lease })),
            Effect.tapError((error) =>
              error._tag === "GitHubCliRateLimitError"
                ? limits.recordRateLimit({ ...key, lease })
                : Effect.void,
            ),
          );
      });
      return yield* guarded.pipe(
        Effect.provideService(
          SourceControlRateLimit.CredentialScope,
          fingerprint || (yield* SourceControlRateLimit.CredentialScope),
        ),
        Effect.catchTags({
          SourceControlRateLimitPausedError: (cause) =>
            Effect.fail(
              new GitHubCliRateLimitError({
                command: "gh",
                cwd: input.cwd,
                retryAt: cause.retryAt,
                cause,
              }),
            ),
        }),
      );
    });

  const executeWithEnv: GitHubCli["Service"]["execute"] = Effect.fn("GitHubCli.execute")(
    function* (input) {
      const [command, action] = input.args;
      if (
        !(
          (command === "pr" && (action === "list" || action === "view")) ||
          (command === "repo" && action === "view")
        )
      )
        return yield* executeRaw(input);
      const credential = yield* PinnedGitHubCredential;
      if (credential !== null && !targetsVerifiedHost(input.args, credential.host))
        return yield* executeRaw(input);
      return yield* guardedRead({
        cwd: input.cwd,
        host: (
          credential?.host ??
          commandHosts(input.args).find((host) => host !== null) ??
          input.rateLimitHost ??
          input.env?.GH_HOST ??
          globalThis.process.env.GH_HOST ??
          "github.com"
        ).toLowerCase(),
        document: "query {}",
        allowReserve: input.allowReserve ?? (yield* AllowGitHubReserve),
        run: () => executeRaw(input),
      });
    },
  );

  const execute: GitHubCli["Service"]["execute"] = (input) =>
    resolveCommandEnv(input).pipe(
      Effect.flatMap((env) =>
        executeWithEnv(input).pipe(Effect.provideService(SelectedAccountEnv, env)),
      ),
    );

  const listPullRequestsWithCli = (input: {
    readonly cwd: string;
    readonly headSelector: string;
    readonly state: PullRequestListState;
    readonly limit: number;
    readonly rateLimitHost?: string | undefined;
  }) =>
    execute({
      cwd: input.cwd,
      ...(input.rateLimitHost === undefined ? {} : { rateLimitHost: input.rateLimitHost }),
      args: [
        "pr",
        "list",
        "--head",
        input.headSelector,
        "--state",
        input.state,
        "--limit",
        String(input.limit),
        "--json",
        PULL_REQUEST_LIST_JSON_FIELDS,
      ],
    }).pipe(
      Effect.flatMap((result) => {
        const raw = result.stdout.trim();
        if (raw.length === 0) return Effect.succeed([]);
        const decoded = decodeGitHubPullRequestListJson(raw);
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              new GitHubChangeRequestListDecodeError({
                command: "gh",
                cwd: input.cwd,
                cause: decoded.failure,
              }),
            );
      }),
    );

  const git = (cwd: string, args: ReadonlyArray<string>) =>
    vcsProcess.run({
      operation: "GitHubCli.baseRepository",
      command: "git",
      args,
      cwd,
      allowNonZeroExit: true,
      timeoutMs: 5_000,
    });

  /** The repository gh reads in `cwd`, or null when gh could pick it another way. */
  const resolveBaseRepository = (cwd: string, host: string) =>
    globalThis.process.env.GH_REPO
      ? Effect.succeed(null)
      : Effect.all([
          git(cwd, ["remote", "-v"]),
          git(cwd, ["config", "--get-regexp", "^remote\\..*\\.gh-resolved$"]),
        ]).pipe(
          Effect.map(([remotes, resolved]) =>
            remotes.exitCode === 0
              ? selectGitHubBaseRepository({
                  remotes: remotes.stdout,
                  resolved: resolved.exitCode === 0 ? resolved.stdout : "",
                  host,
                })
              : null,
          ),
          Effect.orElseSucceed(() => null),
        );

  const headResolver = RequestResolver.makeGrouped<PullRequestsByHeadRead, string>({
    key: ({ request, context }) =>
      JSON.stringify([
        request.host,
        request.owner,
        request.name,
        Context.getOrElse(context, PinnedGitHubCredential, () => null)?.credentialFingerprint ??
          null,
        Context.getOrElse(context, SourceControlRateLimit.CredentialScope, () => ""),
      ]),
    resolver: (entries) => {
      const [first] = entries;
      const { cwd, host, owner, name } = first.request;
      const query = buildPullRequestsByHeadQuery(entries.map((entry) => entry.request));
      const readCli = (entry: (typeof entries)[number]) =>
        listPullRequestsWithCli({
          cwd: entry.request.cwd,
          headSelector: entry.request.headRefName,
          state: entry.request.state,
          limit: entry.request.limit,
          rateLimitHost: entry.request.host,
        }).pipe(
          Effect.exit,
          Effect.map((exit) => entry.completeUnsafe(exit)),
        );
      return guardedRead({
        cwd,
        host,
        document: query.document,
        allowReserve: false,
        run: (document) =>
          executeRaw({
            cwd,
            args: ["api", "graphql", "--hostname", host, "--input", "-"],
            // Up to 50 heads of 100 rows each. A default branch such as `main` can match a
            // hundred fork pull requests, so the 1 MB default would cut the answer short.
            maxOutputBytes: HEAD_LOOKUP_MAX_OUTPUT_BYTES,
            stdin: encodeGraphQlRequest({
              query: document,
              variables: { owner, name, ...query.variables },
            }),
          }).pipe(Effect.tap((result) => budget.observe(host, result.stdout))),
      }).pipe(
        Effect.flatMap((result) => {
          const decoded = decodePullRequestsByHead(result.stdout);
          if (!Result.isSuccess(decoded)) {
            return Effect.forEach(entries, readCli, { discard: true });
          }
          const aliases = decoded.success.data.repository;
          return Effect.forEach(
            entries,
            (entry, index) => {
              const alias = aliases[`h${index}`];
              if (alias == null) return readCli(entry);
              entry.completeUnsafe(Exit.succeed(decodeGitHubPullRequestEntries(alias.nodes)));
              return Effect.void;
            },
            { discard: true },
          );
        }),
        // A document GitHub refused as a whole (a renamed repository, a field an older
        // Enterprise host lacks) leaves each lookup to gh. A rate limit fails them all:
        // asking one at a time would only spend what the pause is saving.
        Effect.catchIf(
          (error) => error._tag !== "GitHubCliRateLimitError",
          () => Effect.forEach(entries, readCli, { discard: true }),
        ),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            for (const entry of entries) entry.completeUnsafe(Exit.failCause(cause));
          }),
        ),
      );
    },
  }).pipe(
    RequestResolver.setDelay(HEAD_LOOKUP_BATCH_WINDOW),
    RequestResolver.batchN(HEAD_LOOKUPS_PER_DOCUMENT),
  );

  const listPullRequestsByHead: GitHubCli["Service"]["listPullRequestsByHead"] = Effect.fn(
    "GitHubCli.listPullRequestsByHead",
  )(function* (input) {
    const host = input.rateLimitHost?.toLowerCase();
    const credential = yield* PinnedGitHubCredential;
    // `owner:branch` selectors and other hosts keep gh's own handling.
    const repository =
      host === undefined ||
      input.headSelector.includes(":") ||
      (credential !== null && credential.host !== host)
        ? null
        : yield* resolveBaseRepository(input.cwd, host);
    if (host === undefined || repository === null) {
      return yield* listPullRequestsWithCli(input);
    }
    return yield* Effect.request(
      new PullRequestsByHeadRead({
        cwd: input.cwd,
        host,
        owner: repository.owner,
        name: repository.name,
        headRefName: input.headSelector,
        state: input.state,
        limit: Math.min(Math.max(Math.trunc(input.limit), 1), 100),
      }),
      headResolver,
    );
  });

  return GitHubCli.of({
    execute,
    listPullRequestsByHead,
    getAccountBinding,
    setAccountBinding,
    beginLogin,
    getLoginStatus,
    logoutAccount,
    listOpenPullRequests: (input) =>
      execute({
        cwd: input.cwd,
        ...(input.rateLimitHost === undefined ? {} : { rateLimitHost: input.rateLimitHost }),
        allowReserve: true,
        args: [
          "pr",
          "list",
          "--head",
          input.headSelector,
          "--state",
          "open",
          "--limit",
          String(input.limit ?? 1),
          "--json",
          "number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,closedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => decodeGitHubPullRequestListJson(raw)).pipe(
                Effect.flatMap((decoded) => {
                  if (!Result.isSuccess(decoded)) {
                    return Effect.fail(
                      new GitHubPullRequestListDecodeError({
                        command: "gh",
                        cwd: input.cwd,
                        cause: decoded.failure,
                      }),
                    );
                  }

                  return Effect.succeed(decoded.success.map(pullRequestSummary));
                }),
              ),
        ),
      ),
    getPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        ...(input.rateLimitHost === undefined ? {} : { rateLimitHost: input.rateLimitHost }),
        allowReserve: true,
        args: [
          "pr",
          "view",
          input.reference,
          "--json",
          "number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,closedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          Effect.sync(() => decodeGitHubPullRequestJson(raw)).pipe(
            Effect.flatMap((decoded) => {
              if (!Result.isSuccess(decoded)) {
                return Effect.fail(
                  new GitHubPullRequestDecodeError({
                    command: "gh",
                    cwd: input.cwd,
                    cause: decoded.failure,
                  }),
                );
              }

              return Effect.succeed(pullRequestSummary(decoded.success));
            }),
          ),
        ),
      ),
    getRepositoryCloneUrls: (input) =>
      execute({
        cwd: input.cwd,
        ...(input.account ? { account: input.account } : {}),
        args: ["repo", "view", input.repository, "--json", "nameWithOwner,url,sshUrl"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeRawGitHubRepositoryCloneUrls(raw).pipe(
            Effect.mapError(
              (cause) =>
                new GitHubRepositoryDecodeError({
                  command: "gh",
                  cwd: input.cwd,
                  cause,
                }),
            ),
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    createRepository: (input) =>
      execute({
        cwd: input.cwd,
        ...(input.account ? { account: input.account } : {}),
        args: ["repo", "create", input.repository, `--${input.visibility}`],
      }).pipe(
        Effect.map((result) =>
          deriveRepositoryCloneUrlsFromCreateOutput(result.stdout, input.repository),
        ),
      ),
    createPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "create",
          "--base",
          input.baseBranch,
          "--head",
          input.headSelector,
          "--title",
          input.title,
          "--body-file",
          input.bodyFile,
        ],
      }).pipe(Effect.asVoid),
    getDefaultBranch: (input) =>
      execute({
        cwd: input.cwd,
        ...(input.rateLimitHost === undefined ? {} : { rateLimitHost: input.rateLimitHost }),
        args: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
      }).pipe(
        Effect.map((value) => {
          const trimmed = value.stdout.trim();
          return trimmed.length > 0 ? trimmed : null;
        }),
      ),
    checkoutPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "checkout", input.reference, ...(input.force ? ["--force"] : [])],
      }).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(GitHubCli, make).pipe(
  Layer.provideMerge(GitHubGraphQlBudget.layer),
  Layer.provideMerge(SourceControlRateLimit.layer),
);
