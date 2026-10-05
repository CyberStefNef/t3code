import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";
import { invalidateCachedVcsRefs } from "./vcsRefInvalidation.ts";

export function createSourceControlEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  return {
    discovery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:source-control-discovery",
      tag: WS_METHODS.serverDiscoverSourceControl,
    }),
    repository: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:repository",
      tag: WS_METHODS.sourceControlLookupRepository,
    }),
    githubAccount: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:github-account",
      tag: WS_METHODS.sourceControlGetGitHubAccount,
    }),
    setGitHubAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:set-github-account",
      tag: WS_METHODS.sourceControlSetGitHubAccount,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.cwd}`,
      },
    }),
    startGitHubLogin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:start-github-login",
      tag: WS_METHODS.sourceControlStartGitHubLogin,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    getGitHubLoginStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:get-github-login-status",
      tag: WS_METHODS.sourceControlGetGitHubLoginStatus,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.loginId}`,
      },
    }),
    logoutGitHubAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:logout-github-account",
      tag: WS_METHODS.sourceControlLogoutGitHubAccount,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.host}:${input.account}`,
      },
    }),
    cloneRepository: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:clone-repository",
      tag: WS_METHODS.sourceControlCloneRepository,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    // Clone-backed project creation. The RPC returns once the project exists
    // and the clone runs in the background; `projectClones` carries progress.
    startProjectClone: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:project-clone-start",
      tag: WS_METHODS.projectCloneStart,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    // Cancel and retry share the start queue so a double click cannot race
    // two actions against the same clone.
    cancelProjectClone: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:project-clone-cancel",
      tag: WS_METHODS.projectCloneCancel,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    retryProjectClone: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:project-clone-retry",
      tag: WS_METHODS.projectCloneRetry,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    // Every clone the environment tracks. Empty until a clone starts; a
    // finished clone drops out after a grace period, a failed one stays.
    projectClones: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:source-control:project-clones",
      tag: WS_METHODS.subscribeProjectClones,
    }),
    publishRepository: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:publish-repository",
      tag: WS_METHODS.sourceControlPublishRepository,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
      onSettled: (target, registry) =>
        invalidateCachedVcsRefs(registry, {
          environmentId: target.environmentId,
          cwd: target.input.cwd,
        }),
    }),
  };
}
