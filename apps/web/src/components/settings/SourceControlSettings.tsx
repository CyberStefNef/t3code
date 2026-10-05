import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  ChevronDownIcon,
  CopyIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import { useEffect, useState, type ReactNode } from "react";
import type {
  BackgroundActivitySettings,
  EnvironmentId,
  SourceControlProviderKind,
  SourceControlDiscoveryResult,
  SourceControlProviderAuth,
  SourceControlProviderAuthAccount,
  GitHubLoginStartResult,
  SourceControlProviderDiscoveryItem,
  VcsDriverKind,
  VcsDiscoveryItem,
} from "@t3tools/contracts";
import {
  getBackgroundActivityBaseProfile,
  getBackgroundActivityPresetSettings,
  resolveServerBackgroundActivitySettings,
} from "@t3tools/shared/backgroundActivitySettings";

import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { readLocalApi } from "../../localApi";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Switch } from "../ui/switch";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";

import {
  AzureDevOpsIcon,
  BitbucketIcon,
  GitHubIcon,
  GitIcon,
  GitLabIcon,
  ForgejoIcon,
  JujutsuIcon,
  type Icon,
} from "../Icons";
import { BitbucketCredentialsSettings } from "./BitbucketCredentialsSettings";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SourceControlWritingSettingsSection } from "./SourceControlWritingSettings";
import {
  PolicyTooltip,
  SettingResetButton,
  SettingsPageContainer,
  SettingsSearchTarget,
  SettingsSection,
  useSettingsSearchTargetId,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";

const EMPTY_DISCOVERY_RESULT: SourceControlDiscoveryResult = {
  versionControlSystems: [],
  sourceControlProviders: [],
};

const SOURCE_CONTROL_PROVIDER_ICONS: Partial<Record<SourceControlProviderKind, Icon>> = {
  github: GitHubIcon,
  gitlab: GitLabIcon,
  forgejo: ForgejoIcon,
  "azure-devops": AzureDevOpsIcon,
  bitbucket: BitbucketIcon,
};

const VCS_ICONS: Partial<Record<VcsDriverKind, Icon>> = {
  git: GitIcon,
  jj: JujutsuIcon,
};

const SOURCE_CONTROL_SKELETON_ROWS = ["primary", "secondary"] as const;
const GIT_FETCH_INTERVAL_STEP_SECONDS = 5;
type BackgroundActivityOverridePatch = Partial<{
  [K in keyof BackgroundActivitySettings["overrides"]]:
    | BackgroundActivitySettings["overrides"][K]
    | undefined;
}>;

function durationToSeconds(duration: Duration.Duration): number {
  return Math.round(Duration.toMillis(duration) / 1_000);
}

function normalizeFetchIntervalSeconds(value: number | null): number {
  if (value === null || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

function backgroundActivityOverrideSettings(
  current: BackgroundActivitySettings,
  overrides: BackgroundActivityOverridePatch,
) {
  const nextOverrides: BackgroundActivityOverridePatch = {
    ...current.overrides,
    ...overrides,
  };
  for (const [key, value] of Object.entries(nextOverrides)) {
    if (value === undefined) {
      delete nextOverrides[key as keyof typeof nextOverrides];
    }
  }
  return {
    backgroundActivity: {
      schemaVersion: 1 as const,
      profile: "custom" as const,
      baseProfile: getBackgroundActivityBaseProfile(current),
      overrides: nextOverrides as BackgroundActivitySettings["overrides"],
    },
  };
}

function optionLabel(value: Option.Option<string>): string | null {
  return Option.getOrNull(value);
}

function isProviderDiscoveryItem(
  item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem,
): item is SourceControlProviderDiscoveryItem {
  return "auth" in item;
}

function isVcsNotReady(item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem): boolean {
  return !isProviderDiscoveryItem(item) && !item.implemented;
}

function authPresentation(auth: SourceControlProviderAuth): {
  readonly label: string;
  readonly badge: "warning" | null;
} {
  if (auth.status === "authenticated") {
    return { label: "Authenticated", badge: null };
  }
  if (auth.status === "unauthenticated") {
    return { label: "Not authenticated", badge: "warning" };
  }
  return { label: "Status unknown", badge: null };
}

function RedactedAccount(props: { readonly account: string | null }) {
  return (
    <RedactedSensitiveText
      value={props.account}
      ariaLabel="Toggle source control account visibility"
      revealTooltip="Click to reveal account"
      hideTooltip="Click to hide account"
    />
  );
}

function itemStatusDot(item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem): string {
  if (isVcsNotReady(item)) return "bg-muted-foreground/35";
  if (item.status !== "available") return "bg-warning";
  if (isProviderDiscoveryItem(item) && item.auth.status !== "authenticated") return "bg-warning";
  return "bg-success";
}

function SourceControlItemMark({
  item,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
}) {
  const dotClassName = itemStatusDot(item);
  const Icon = isProviderDiscoveryItem(item)
    ? SOURCE_CONTROL_PROVIDER_ICONS[item.kind]
    : VCS_ICONS[item.kind];

  if (!Icon) {
    return <span className={cn("size-2 shrink-0 rounded-full", dotClassName)} aria-hidden />;
  }

  return (
    <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
      <Icon className="size-4.5 text-foreground/80" aria-hidden />
      <span
        className={cn(
          "pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background",
          dotClassName,
        )}
        aria-hidden
      />
    </span>
  );
}

function itemSummary({
  item,
  auth,
  authAccount,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
  readonly auth: SourceControlProviderAuth | null;
  readonly authAccount: string | null;
}) {
  if (isVcsNotReady(item)) {
    return <span>Support for {item.label} is coming soon.</span>;
  }

  if (item.status !== "available") {
    return <span>Not available on this server: {item.installHint}</span>;
  }

  if (auth) {
    if (auth.status === "authenticated") {
      if (item.kind === "github" && auth.accounts) {
        const authenticatedAccountCount = auth.accounts.filter(
          (account) => account.status === "authenticated",
        ).length;
        return (
          <span>
            {authenticatedAccountCount} {authenticatedAccountCount === 1 ? "account" : "accounts"}{" "}
            authenticated
          </span>
        );
      }

      return (
        <>
          <span>Authenticated</span>
          {authAccount ? (
            <>
              <span aria-hidden>as</span>
              <RedactedAccount account={authAccount} />
            </>
          ) : null}
        </>
      );
    }

    // API integrations have no CLI to sign in with; an unverified saved credential falls
    // through to the "could not verify" detail instead of repeating the setup hint.
    if (!item.executable && auth.status === "unauthenticated") {
      return <span>Available. {item.installHint}</span>;
    }

    if (auth.status === "unauthenticated") {
      return (
        <span>
          {item.label} is not authenticated on this server. Sign in or configure credentials using
          the <code className="rounded bg-muted px-1 py-px text-2xs">{item.executable}</code> tool
          on the server host to enable change request features.
        </span>
      );
    }
    const authDetail = optionLabel(auth.detail);
    return (
      <span>
        Could not verify {item.label}. {authDetail ?? item.installHint}
      </span>
    );
  }

  return <span>Available</span>;
}

function GitHubAccountRow({
  account,
  logoutPending,
  onSignOut,
}: {
  readonly account: SourceControlProviderAuthAccount;
  readonly logoutPending: boolean;
  readonly onSignOut: (account: SourceControlProviderAuthAccount) => void;
}) {
  const detail = optionLabel(account.detail);
  const authenticated = account.status === "authenticated";
  return (
    <div className="grid min-h-9 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 rounded-lg px-1 py-1.5">
      <div className="min-w-0 truncate text-xs leading-5 text-foreground">
        <span className="inline-flex min-w-0 items-center">
          <RedactedAccount account={account.account} />
        </span>
      </div>
      <div className="flex items-center justify-end gap-1">
        {!authenticated ? (
          <Badge size="sm" variant="warning">
            Sign-in required
          </Badge>
        ) : null}
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost-muted"
                className="size-7"
                disabled={logoutPending}
                aria-label={`Actions for ${account.account}`}
              />
            }
          >
            <EllipsisIcon className={cn("size-3.5", logoutPending && "animate-pulse")} />
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-36">
            <MenuItem
              variant="destructive"
              disabled={logoutPending}
              onClick={() => onSignOut(account)}
            >
              {authenticated ? "Sign out" : "Remove account"}
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {detail ? (
        <p className="col-span-2 min-w-0 truncate text-xs leading-5 text-warning">{detail}</p>
      ) : null}
    </div>
  );
}

function GitHubAccounts({
  auth,
  environmentId,
  onRefresh,
}: {
  readonly auth: SourceControlProviderAuth;
  readonly environmentId: EnvironmentId;
  readonly onRefresh: () => void;
}) {
  const accounts = auth.accounts ?? [];
  const startGitHubLogin = useAtomCommand(sourceControlEnvironment.startGitHubLogin, {
    reportFailure: false,
  });
  const getGitHubLoginStatus = useAtomCommand(sourceControlEnvironment.getGitHubLoginStatus, {
    reportFailure: false,
  });
  const logoutGitHubAccount = useAtomCommand(sourceControlEnvironment.logoutGitHubAccount, {
    reportFailure: false,
  });
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginPending, setLoginPending] = useState(false);
  const [login, setLogin] = useState<GitHubLoginStartResult | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [logoutPending, setLogoutPending] = useState<string | null>(null);

  useEffect(() => {
    if (!loginOpen || !login) return;
    let disposed = false;
    let checking = false;

    const checkStatus = async () => {
      if (disposed || checking) return;
      checking = true;
      const result = await getGitHubLoginStatus({
        environmentId,
        input: { loginId: login.loginId },
      });
      checking = false;
      if (disposed || result._tag !== "Success" || result.value.status === "pending") return;

      if (result.value.status === "failed") {
        setLogin(null);
        setLoginError(result.value.detail);
        return;
      }

      setLogin(null);
      setLoginOpen(false);
      onRefresh();
      toastManager.add({
        type: "success",
        title: result.value.alreadyAuthenticated
          ? `${result.value.account} is already signed in`
          : `${result.value.account} added`,
        description: result.value.alreadyAuthenticated
          ? "The existing account was kept; no duplicate was added."
          : "The account is now available in Project settings.",
      });
    };

    const initialCheck = window.setTimeout(() => void checkStatus(), 500);
    const interval = window.setInterval(() => void checkStatus(), 1_000);
    return () => {
      disposed = true;
      window.clearTimeout(initialCheck);
      window.clearInterval(interval);
    };
  }, [environmentId, getGitHubLoginStatus, login, loginOpen, onRefresh]);

  const beginLogin = async () => {
    setLoginOpen(true);
    setLoginPending(true);
    setLogin(null);
    setLoginError(null);
    const result = await startGitHubLogin({ environmentId, input: {} });
    setLoginPending(false);
    if (result._tag === "Success") {
      setLogin(result.value);
      void readLocalApi()
        ?.shell.openExternal(result.value.verificationUri)
        .catch(() => undefined);
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setLoginError(error instanceof Error ? error.message : "GitHub sign-in could not start.");
    }
  };

  const copyUserCode = async () => {
    if (!login) return;
    try {
      await navigator.clipboard.writeText(login.userCode);
      toastManager.add({ type: "success", title: "GitHub code copied" });
    } catch {
      toastManager.add({
        type: "error",
        title: "Could not copy GitHub code",
        description: "Select and copy the code manually.",
      });
    }
  };

  const signOutAccount = async (account: SourceControlProviderAuthAccount) => {
    const authenticated = account.status === "authenticated";
    const confirmed =
      (await readLocalApi()?.dialogs.confirm(
        `${authenticated ? "Sign out" : "Remove"} ${account.account}?\n\nProjects pinned to this account will require sign-in until you add it again.`,
        { variant: "destructive" },
      )) ?? false;
    if (!confirmed) return;

    const key = `${account.host}:${account.account}`;
    setLogoutPending(key);
    const result = await logoutGitHubAccount({
      environmentId,
      input: { account: account.account, host: account.host },
    });
    setLogoutPending(null);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: authenticated
          ? `${account.account} signed out`
          : `${account.account} removed from GitHub CLI`,
      });
      onRefresh();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: authenticated
          ? `Could not sign out ${account.account}`
          : `Could not remove ${account.account}`,
        description: error instanceof Error ? error.message : "GitHub CLI sign-out failed.",
      });
    }
  };

  return (
    <>
      <div className="grid gap-1">
        <div className="flex items-center justify-between gap-3 px-1 py-1">
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">Accounts</p>
            <p className="text-xs text-muted-foreground">
              Select an account for each project in Project settings.
            </p>
          </div>
          <Button size="xs" variant="outline" onClick={() => void beginLogin()}>
            <PlusIcon className="size-3.5" />
            Add account
          </Button>
        </div>
        {accounts.length > 0 ? (
          <div className="grid gap-0.5">
            {accounts.map((account) => (
              <GitHubAccountRow
                key={`${account.host}:${account.account}`}
                account={account}
                logoutPending={logoutPending === `${account.host}:${account.account}`}
                onSignOut={(selected) => void signOutAccount(selected)}
              />
            ))}
          </div>
        ) : (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            No GitHub CLI accounts were found on this server.
          </p>
        )}
      </div>
      <Dialog
        open={loginOpen}
        onOpenChange={(open) => {
          setLoginOpen(open);
          if (!open) {
            setLogin(null);
            setLoginError(null);
          }
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add GitHub account</DialogTitle>
            <DialogDescription>
              Sign in with GitHub to add another account to T3 Code.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {loginPending ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <RefreshCwIcon className="size-4 animate-spin" />
                Waiting for GitHub CLI…
              </div>
            ) : login ? (
              <div className="space-y-2">
                <p className="text-xs font-medium text-foreground">One-time code</p>
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-lg border border-border bg-muted/30 px-4 py-3 font-mono text-lg tracking-widest text-foreground"
                  aria-label={`Copy GitHub one-time code ${login.userCode}`}
                  onClick={() => void copyUserCode()}
                >
                  {login.userCode}
                  <CopyIcon className="size-4 text-muted-foreground" />
                </button>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Enter this code on GitHub. This dialog closes when sign-in is complete.
                </p>
              </div>
            ) : loginError ? (
              <p className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
                {loginError}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter variant="bare">
            {login ? (
              <Button
                variant="outline"
                render={
                  <a href={login.verificationUri} target="_blank" rel="noopener noreferrer" />
                }
              >
                <ExternalLinkIcon className="size-4" />
                Open GitHub
              </Button>
            ) : loginError ? (
              <Button variant="outline" onClick={() => void beginLogin()}>
                Try again
              </Button>
            ) : null}
            {login ? (
              <Button disabled>
                <RefreshCwIcon className="size-4 animate-spin" />
                Waiting for GitHub…
              </Button>
            ) : (
              <Button disabled={loginPending} onClick={() => setLoginOpen(false)}>
                Close
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function DiscoveryItemRow({
  item,
  children,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
  readonly children?: ReactNode;
}) {
  const version = optionLabel(item.version);
  const enabled = isProviderDiscoveryItem(item)
    ? item.status === "available" && item.auth.status === "authenticated"
    : item.status === "available" && item.implemented;
  const auth = isProviderDiscoveryItem(item) ? item.auth : null;
  const authStatus = auth ? authPresentation(auth) : null;
  const authAccount = auth ? optionLabel(auth.account) : null;
  const [isExpanded, setIsExpanded] = useState(false);
  const hasDetails = children !== undefined;
  const searchTargetId = useSettingsSearchTargetId();

  useEffect(() => {
    if (
      (item.kind === "git" && searchTargetId === searchableSetting("git-fetch-interval").id) ||
      (item.kind === "bitbucket" &&
        searchTargetId === searchableSetting("bitbucket-credentials").id)
    ) {
      setIsExpanded(true);
    }
  }, [item.kind, searchTargetId]);

  return (
    <div
      className={cn(
        "first:rounded-t-xl last:rounded-b-xl transition-colors hover:bg-muted/20",
        isVcsNotReady(item) && "opacity-80",
      )}
    >
      <div className="px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <SourceControlItemMark item={item} />
              <span className="truncate text-sm font-medium text-foreground">{item.label}</span>
              {version ? <code className="text-xs text-muted-foreground">{version}</code> : null}
              {isVcsNotReady(item) ? (
                <Badge variant="warning" size="sm">
                  Coming Soon
                </Badge>
              ) : null}
              {authStatus?.badge ? (
                <Badge variant={authStatus.badge} size="sm">
                  {authStatus.label}
                </Badge>
              ) : null}
            </div>
            <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs leading-normal text-muted-foreground/80">
              {itemSummary({ item, auth, authAccount })}
            </p>
          </div>
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {hasDetails ? (
              <Button
                size="icon-xs"
                variant="ghost-muted"
                onClick={() => setIsExpanded((open) => !open)}
                aria-expanded={isExpanded}
                aria-label={`Toggle ${item.label} details`}
              >
                <ChevronDownIcon
                  className={cn("size-3.5 transition-transform", isExpanded && "rotate-180")}
                />
              </Button>
            ) : null}
            {!isVcsNotReady(item) ? (
              <Switch checked={enabled} disabled aria-label={`${item.label} availability`} />
            ) : null}
          </div>
        </div>
      </div>

      {hasDetails ? (
        <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
          <CollapsibleContent>
            <div className="px-3 pb-4 pt-1 sm:px-4">{children}</div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

function GitFetchIntervalSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const automaticGitFetchIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.automaticGitFetchInterval,
  );
  const defaultAutomaticGitFetchIntervalSeconds = durationToSeconds(
    getBackgroundActivityPresetSettings(
      getBackgroundActivityBaseProfile(settings.backgroundActivity),
    ).automaticGitFetchInterval,
  );
  const canResetFetchInterval =
    automaticGitFetchIntervalSeconds !== defaultAutomaticGitFetchIntervalSeconds;
  const setting = searchableSetting("git-fetch-interval");

  return (
    <SettingsSearchTarget id={setting.id} className="grid gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 items-center gap-1">
            <span className="text-xs font-medium text-foreground">{setting.title}</span>
            <PolicyTooltip>
              This interval is configured for Git only. The shared Background activity policy still
              decides whether Git refreshes may run when the timer fires. Custom intervals appear as
              Advanced in General settings.
            </PolicyTooltip>
            <span
              className={cn(
                "inline-flex size-5 shrink-0 items-center justify-center transition-opacity",
                canResetFetchInterval ? "opacity-100" : "pointer-events-none opacity-0",
              )}
              aria-hidden={!canResetFetchInterval}
            >
              {canResetFetchInterval ? (
                <SettingResetButton
                  label="fetch interval"
                  onClick={() =>
                    updateSettings(
                      backgroundActivityOverrideSettings(settings.backgroundActivity, {
                        automaticGitFetchInterval: undefined,
                      }),
                    )
                  }
                />
              ) : null}
            </span>
          </div>
          <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
            Refresh remote branches in the background. Set to 0 to avoid automatic Git prompts.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <NumberField
            value={automaticGitFetchIntervalSeconds}
            min={0}
            step={GIT_FETCH_INTERVAL_STEP_SECONDS}
            size="sm"
            className="w-32"
            onValueChange={(value) =>
              updateSettings(
                backgroundActivityOverrideSettings(settings.backgroundActivity, {
                  automaticGitFetchInterval: Duration.seconds(normalizeFetchIntervalSeconds(value)),
                }),
              )
            }
          >
            <NumberFieldGroup>
              <NumberFieldDecrement aria-label="Decrease fetch interval" />
              <NumberFieldInput aria-label="Automatic Git fetch interval in seconds" />
              <NumberFieldIncrement aria-label="Increase fetch interval" />
            </NumberFieldGroup>
          </NumberField>
          <span className="text-xs text-muted-foreground">seconds</span>
        </div>
      </div>
    </SettingsSearchTarget>
  );
}

function SourceControlSectionSkeleton({
  title,
  headerAction,
}: {
  readonly title: string;
  readonly headerAction?: ReactNode;
}) {
  return (
    <SettingsSection title={title} headerAction={headerAction}>
      {SOURCE_CONTROL_SKELETON_ROWS.map((row) => (
        <div key={row} className="first:rounded-t-xl last:rounded-b-xl px-3 py-3 sm:px-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
                  <Skeleton className="size-4.5" />
                  <Skeleton
                    shape="pill"
                    className="pointer-events-none absolute -left-0.5 -top-0.5 size-2"
                    aria-hidden
                  />
                </span>
                <Skeleton shape="pill" className="h-4 w-28" />
                <Skeleton shape="pill" className="h-5 w-14" />
              </div>
              <Skeleton shape="pill" className="h-3 w-full max-w-xs" />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Skeleton className="size-7" />
              <Skeleton shape="pill" className="h-5 w-9" />
            </div>
          </div>
        </div>
      ))}
    </SettingsSection>
  );
}

function EmptySourceControlDiscovery({
  error,
  isPending,
  onScan,
}: {
  readonly error: string | null;
  readonly isPending: boolean;
  readonly onScan: () => void;
}) {
  const hasError = error !== null;

  return (
    <SettingsSection id={searchableSetting("source-control").id} title="Server environment">
      <Empty>
        <EmptyMedia variant="icon">
          <PullRequestGlyph.pullRequest />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>
            {hasError ? "Could not scan the server environment" : "Nothing detected yet"}
          </EmptyTitle>
          <EmptyDescription>
            {hasError
              ? error
              : "Install Git on the server, add optional hosting integrations or credentials your workspace needs, then rescan."}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" variant="outline" onClick={onScan} disabled={isPending}>
            <RefreshIcon size="sm" refreshing={isPending} />
            Scan
          </Button>
        </EmptyContent>
      </Empty>
    </SettingsSection>
  );
}

export function SourceControlSettingsPanel() {
  const { scope, environment, connectedEnvironments } = useSettingsScope();
  // Discovery scans one machine's tools, so it shows the representative
  // environment (named in the section title when several are selected);
  // the settings rows above it fan out like everywhere else.
  const environmentId =
    environment?.connection.phase === "connected" ? environment.environmentId : null;
  const aggregate = scope.environmentIds.length !== 1 && connectedEnvironments.length > 1;
  const environmentSuffix = aggregate && environment ? ` · ${environment.label}` : "";
  const discovery = useEnvironmentQuery(
    environmentId === null
      ? null
      : sourceControlEnvironment.discovery({
          environmentId,
          input: {},
        }),
  );
  const result = discovery.data ?? EMPTY_DISCOVERY_RESULT;
  const hasVersionControlSystems = result.versionControlSystems.length > 0;
  const hasDiscoveryItems = hasVersionControlSystems || result.sourceControlProviders.length > 0;
  const isInitialScanPending = discovery.isPending && discovery.data === null;
  const handleScan = () => {
    discovery.refresh();
  };
  const scanButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            onClick={handleScan}
            disabled={discovery.isPending}
            aria-label="Rescan server environment"
          >
            <RefreshIcon refreshing={discovery.isPending} />
          </Button>
        }
      />
      <TooltipPopup side="top">Rescan Git and hosting integrations</TooltipPopup>
    </Tooltip>
  );

  return (
    <SettingsPageContainer>
      <ProjectDefaultsSettings category="source-control" />
      {environmentId === null ? (
        <SettingsSection id={searchableSetting("source-control").id} title="Server environment">
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Connect an environment to inspect its version control tools and hosting integrations.
          </p>
        </SettingsSection>
      ) : isInitialScanPending ? (
        <>
          <SourceControlSectionSkeleton
            title={`Version Control${environmentSuffix}`}
            headerAction={scanButton}
          />
          <SourceControlSectionSkeleton title="Source Control Providers" />
        </>
      ) : hasDiscoveryItems ? (
        <>
          {hasVersionControlSystems ? (
            <SettingsSection
              id={searchableSetting("source-control").id}
              title={`Version Control${environmentSuffix}`}
              headerAction={scanButton}
            >
              {result.versionControlSystems.map((item) => (
                <DiscoveryItemRow key={`vcs:${item.kind}`} item={item}>
                  {item.kind === "git" ? <GitFetchIntervalSettings /> : undefined}
                </DiscoveryItemRow>
              ))}
            </SettingsSection>
          ) : null}

          {result.sourceControlProviders.length > 0 ? (
            <SettingsSection
              id={hasVersionControlSystems ? undefined : searchableSetting("source-control").id}
              title={
                hasVersionControlSystems
                  ? "Source Control Providers"
                  : `Source Control Providers${environmentSuffix}`
              }
              headerAction={hasVersionControlSystems ? null : scanButton}
            >
              {result.sourceControlProviders.map((item) => (
                <DiscoveryItemRow key={`provider:${item.kind}`} item={item}>
                  {item.kind === "github" && environmentId !== null ? (
                    <GitHubAccounts
                      auth={item.auth}
                      environmentId={environmentId}
                      onRefresh={handleScan}
                    />
                  ) : item.kind === "bitbucket" ? (
                    <SettingsSearchTarget id={searchableSetting("bitbucket-credentials").id}>
                      <BitbucketCredentialsSettings
                        key={environmentId}
                        environmentId={environmentId}
                        onSaved={handleScan}
                      />
                    </SettingsSearchTarget>
                  ) : undefined}
                </DiscoveryItemRow>
              ))}
            </SettingsSection>
          ) : null}
        </>
      ) : (
        <EmptySourceControlDiscovery
          error={discovery.error}
          isPending={discovery.isPending}
          onScan={handleScan}
        />
      )}

      <SourceControlWritingSettingsSection />
    </SettingsPageContainer>
  );
}
