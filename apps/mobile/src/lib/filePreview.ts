import { MISSING_FILE_ACCESS_MESSAGE } from "@t3tools/client-runtime/state/assets";
import { AuthFilesystemReadScope, EnvironmentAuthorizationError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

export function filePreviewErrorMessage(error: unknown, fallback: string): string {
  return isAuthorizationError(error) &&
    (error.requiredPermission ?? error.requiredScope) === AuthFilesystemReadScope
    ? MISSING_FILE_ACCESS_MESSAGE
    : fallback;
}

import { filePreviewKind } from "@t3tools/shared/filePreview";

export function inlineFilePreviewKind(file: { readonly name: string; readonly mimeType?: string }) {
  return filePreviewKind(file) === "audio" ? "audio" : null;
}

export function isPdfFile(file: { readonly name: string; readonly mimeType?: string }): boolean {
  const mimeType = file.mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mimeType && mimeType !== "application/octet-stream") return mimeType === "application/pdf";
  return /\.pdf$/i.test(file.name.split(/[?#]/, 1)[0] ?? "");
}
