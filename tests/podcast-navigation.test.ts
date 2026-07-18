import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isFullWidthAppTab,
  requiresAuthenticatedAppTab,
} from "../src/utils/appTabs";

assert.equal(isFullWidthAppTab("feed"), false);
assert.equal(isFullWidthAppTab("discover"), false);
assert.equal(isFullWidthAppTab("knowledge"), false);
assert.equal(isFullWidthAppTab("write"), true);
assert.equal(isFullWidthAppTab("podcast"), true);

assert.equal(requiresAuthenticatedAppTab("feed"), false);
assert.equal(requiresAuthenticatedAppTab("discover"), false);
assert.equal(requiresAuthenticatedAppTab("knowledge"), true);
assert.equal(requiresAuthenticatedAppTab("write"), true);
assert.equal(requiresAuthenticatedAppTab("podcast"), true);

const testDir = path.dirname(fileURLToPath(import.meta.url));
const readSource = (relativePath: string) =>
  readFileSync(path.join(testDir, relativePath), "utf8");
const appSource = readSource("../src/App.tsx");
const navSource = readSource("../src/components/Nav.tsx");
const typesSource = readSource("../src/types.ts");
const packageSource = readSource("../package.json");

assert.match(
  typesSource,
  /export type AppTab\s*=\s*["']feed["']\s*\|\s*["']discover["']\s*\|\s*["']knowledge["']\s*\|\s*["']write["']\s*\|\s*["']podcast["']\s*;/,
  "src/types.ts must own the complete AppTab union",
);
assert.match(appSource, /import type \{ AppTab \} from ["'].\/types["'];/);
assert.match(appSource, /import \{ isFullWidthAppTab \} from ["'].\/utils\/appTabs["'];/);
assert.match(navSource, /import type \{ AppTab \} from ["']\.\.\/types["'];/);
assert.match(
  navSource,
  /import \{ requiresAuthenticatedAppTab \} from ["']\.\.\/utils\/appTabs["'];/,
);
assert.doesNotMatch(appSource, /useState\s*<\s*["']feed["']\s*\|/);
assert.doesNotMatch(navSource, /(?:activeTab|tab)\s*:\s*["']feed["']\s*\|/);

assert.match(
  appSource,
  /const PodcastPage = React\.lazy\(\(\) => import\(["']\.\/pages\/PodcastPage["']\)/,
  "PodcastPage must remain code-split",
);
assert.match(appSource, /const \[activeTab, setActiveTab\] = useState<AppTab>\(["']feed["']\);/);
assert.match(appSource, /const isPodcastTab = activeTab === ["']podcast["'];/);
assert.match(appSource, /const isFullWidthTab = isFullWidthAppTab\(activeTab\);/);

const podcastRouteStart = appSource.indexOf('{activeTab === "podcast" && (');
const discoverRouteStart = appSource.indexOf('{activeTab === "discover"', podcastRouteStart);
assert.ok(podcastRouteStart >= 0 && discoverRouteStart > podcastRouteStart, "podcast route must render before discover");
const podcastRoute = appSource.slice(podcastRouteStart, discoverRouteStart);
assert.match(podcastRoute, /<React\.Suspense/);
assert.match(podcastRoute, /<PodcastPage/);
assert.match(podcastRoute, /onBack=\{\(\) => setActiveTab\(["']feed["']\)\}/);
assert.match(podcastRoute, /onDiscover=\{\(\) => setActiveTab\(["']discover["']\)\}/);
assert.doesNotMatch(podcastRoute, /\bp-4\b/, "PodcastPage owns its edge-to-edge spacing");

assert.match(
  appSource,
  /style=\{\{ cursor: !isFullWidthTab && \(hoverCenterRightEdge \|\| dragging === ["']center-right["']\) \? ["']col-resize["'] : undefined \}\}/,
);
assert.match(appSource, /onMouseMove=\{\(event\) => \{\s*if \(isMobile \|\| isFullWidthTab\) return;/);
assert.match(appSource, /onMouseDownCapture=\{\(event\) => \{\s*if \(isMobile \|\| isFullWidthTab \|\| event\.button !== 0\) return;/);
assert.match(
  appSource,
  /useEffect\(\(\) => \{\s*if \(isFullWidthTab\) \{\s*setDragging\(null\);\s*setHoverCenterRightEdge\(false\);\s*\}\s*\}, \[isFullWidthTab\]\);/,
);
assert.match(
  appSource,
  /if \(dragging === ["']center-right["'] && !isFullWidthTab\) \{/,
  "document cursor must also respect full-width workspaces",
);
assert.match(appSource, /\$\{isMobile \? ["']flex-1["'] : isFullWidthTab \? ["']flex-1["'] : ["']shrink-0 border-r border-border["']\}/);
assert.match(appSource, /\$\{isMobile && !isFullWidthTab && readingArticle \? ["']hidden["'] : ["']["']\}/);
assert.match(appSource, /style=\{\{ width: isMobile \? ["']100%["'] : isFullWidthTab \? undefined : centerWidth \}\}/);
assert.match(appSource, /\{isMobile && !isPodcastTab && \(/);
assert.match(appSource, /\{!isFullWidthTab && \(\s*<div[\s\S]*?<ReaderPane/);

const writingIndex = navSource.indexOf("魔法写作");
const podcastIndex = navSource.indexOf("播客解读");
assert.ok(writingIndex >= 0 && podcastIndex > writingIndex, "播客解读 must follow 魔法写作");
assert.match(navSource, /Headphones size=\{14\}/);
assert.match(
  navSource,
  /<TabButton active=\{activeTab === ["']podcast["']\} onClick=\{\(\) => handleTabClick\(["']podcast["']\)\} fullWidth>/,
  "the podcast button must enter through the shared authenticated tab handler",
);
assert.match(navSource, /const handleTabClick = \(tab: AppTab\) => \{/);
assert.match(
  navSource,
  /if \(requiresAuthenticatedAppTab\(tab\) && !user\) \{\s*loginAndDo\(\(\) => setActiveTab\(tab\)\);\s*return;/,
);
assert.doesNotMatch(navSource, /tab === ["']knowledge["'] \|\| tab === ["']write["']/);
assert.doesNotMatch(navSource, /activeTab === ["']podcast["'] && \(/, "podcast filters stay inside PodcastPage");
assert.match(packageSource, /tests\/podcast-navigation\.test\.ts/);

console.log("PASS: podcast is an authenticated full-width app workspace");
