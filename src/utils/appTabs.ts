import type { AppTab } from "../types";

export const isFullWidthAppTab = (tab: AppTab) =>
  tab === "write";

export const requiresAuthenticatedAppTab = (tab: AppTab) =>
  tab === "knowledge" || tab === "write" || tab === "podcast";
