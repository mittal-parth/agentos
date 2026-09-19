// Integration tests for scripts/check-docs.mjs. Each case builds a minimal
// fake repo under a temp directory and runs the checker as a subprocess.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = join(dirname(fileURLToPath(import.meta.url)), "check-docs.mjs");

/** Run check-docs.mjs against `root` (same as CI / `pnpm check-docs`). */
function runCheck(root) {
	return spawnSync(process.execPath, [script, "--root", root], {
		encoding: "utf8",
	});
}

function checkOutput(result) {
	return `${result.stdout}\n${result.stderr}`;
}

function assertFails(root, pattern) {
	const result = runCheck(root);
	assert.equal(result.status, 1, checkOutput(result));
	assert.match(checkOutput(result), pattern);
	return result;
}

/** Write a valid MDX page under the temp repo with standard frontmatter. */
function writePage(root, relPath, body, frontmatterExtra = "") {
	const full = join(root, relPath);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(
		full,
		`---
title: "Test"
description: "Test page"
${frontmatterExtra}---
${body}`,
	);
}

function writeMinimalSidebar(root, pages = [{ title: "Home", href: "/agentos/docs" }]) {
	writeFileSync(
		join(root, "docs/sidebar.json"),
		JSON.stringify({ docs: [{ title: "General", pages }] }),
	);
}

function seedMinimalPassingTree(root) {
	writePage(root, "docs/content/docs/index.mdx", "\n");
	writeMinimalSidebar(root);
}

test("passes valid bundle pages and ignores website-owned routes", () => {
	const root = mkdtempSync(join(tmpdir(), "agentos-docs-check-"));
	try {
		writePage(
			root,
			"docs/content/docs/index.mdx",
			"\nSee [registry](/agentos/registry/) and [self-host](/agentos/self-host).\n",
		);
		writePage(
			root,
			"docs/content/docs/linked.mdx",
			"\nGo to [overview](/agentos/docs).\n",
		);
		writeMinimalSidebar(root, [
			{ title: "Overview", href: "/agentos/docs" },
			{
				title: "External",
				href: "https://github.com/rivet-dev/agentos/issues/new/choose",
			},
		]);
		mkdirSync(join(root, "examples/docs"), { recursive: true });
		writeFileSync(join(root, "examples/docs/sample.ts"), "export {};\n");
		writePage(
			root,
			"docs/content/docs/snippet.mdx",
			'\n<CodeSnippet file="examples/docs/sample.ts" />\n',
		);

		const result = runCheck(root);
		assert.equal(result.status, 0, checkOutput(result));
		assert.match(result.stdout, /check-docs: OK/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fails when frontmatter block is missing", () => {
	const root = mkdtempSync(join(tmpdir(), "agentos-docs-check-"));
	try {
		mkdirSync(join(root, "docs/content/docs"), { recursive: true });
		writeFileSync(
			join(root, "docs/content/docs/bad.mdx"),
			"# no frontmatter\n",
		);
		writeMinimalSidebar(root);

		assertFails(root, /missing frontmatter/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fails when frontmatter missing title", () => {
	const root = mkdtempSync(join(tmpdir(), "agentos-docs-check-"));
	try {
		mkdirSync(join(root, "docs/content/docs"), { recursive: true });
		writeFileSync(
			join(root, "docs/content/docs/index.mdx"),
			`---
description: "Only description"
---
`,
		);
		writeMinimalSidebar(root);

		assertFails(root, /frontmatter missing title/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fails when frontmatter missing description", () => {
	const root = mkdtempSync(join(tmpdir(), "agentos-docs-check-"));
	try {
		mkdirSync(join(root, "docs/content/docs"), { recursive: true });
		writeFileSync(
			join(root, "docs/content/docs/index.mdx"),
			`---
title: "Only title"
---
`,
		);
		writeMinimalSidebar(root);

		assertFails(root, /frontmatter missing description/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fails on broken markdown link and broken JSX href", () => {
	const root = mkdtempSync(join(tmpdir(), "agentos-docs-check-"));
	try {
		seedMinimalPassingTree(root);
		writePage(
			root,
			"docs/content/docs/bad-links.mdx",
			'\n[md](/agentos/docs/no-such-page)\n<Card href="/agentos/docs/also-missing" />\n',
		);

		const out = checkOutput(assertFails(root, /broken link.*no-such-page/));
		assert.match(out, /broken link.*also-missing/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fails on broken anchor and passes valid anchor", () => {
	const root = mkdtempSync(join(tmpdir(), "agentos-docs-check-"));
	try {
		writePage(
			root,
			"docs/content/docs/target.mdx",
			"\n## Resource Limits\n\nBody.\n",
		);
		writePage(
			root,
			"docs/content/docs/good-anchor.mdx",
			"\nSee [limits](/agentos/docs/target#resource-limits).\n",
		);
		writePage(
			root,
			"docs/content/docs/bad-anchor.mdx",
			"\nSee [nope](/agentos/docs/target#not-a-real-heading).\n",
		);
		writeMinimalSidebar(root);

		const out = checkOutput(assertFails(root, /broken anchor #not-a-real-heading/));
		assert.doesNotMatch(out, /broken anchor #resource-limits/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fails on broken same-page anchors and keeps ampersand double hyphens", () => {
	const root = mkdtempSync(join(tmpdir(), "agentos-docs-check-"));
	try {
		writePage(
			root,
			"docs/content/docs/index.mdx",
			`
## Mounts

See [mounts](#mounts) and [snapshot](#sdk-snapshotting--snapshot-safety).

### SDK snapshotting & snapshot-safety

See [bad](#not-a-heading) and [collapsed](#sdk-snapshotting-snapshot-safety).
`,
		);
		writeMinimalSidebar(root);

		const out = checkOutput(assertFails(root, /broken anchor #not-a-heading/));
		assert.match(out, /broken anchor #sdk-snapshotting-snapshot-safety/);
		assert.doesNotMatch(out, /broken anchor #mounts/);
		assert.doesNotMatch(out, /broken anchor #sdk-snapshotting--snapshot-safety/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolves slug.mdx and nested index.mdx paths", () => {
	const root = mkdtempSync(join(tmpdir(), "agentos-docs-check-"));
	try {
		writePage(root, "docs/content/docs/index.mdx", "\n");
		writePage(root, "docs/content/docs/flat.mdx", "\n");
		writePage(root, "docs/content/docs/nested/topic/index.mdx", "\n");
		writePage(
			root,
			"docs/content/docs/links.mdx",
			"\n[flat](/agentos/docs/flat)\n[nested](/agentos/docs/nested/topic)\n",
		);
		writeMinimalSidebar(root);

		const result = runCheck(root);
		assert.equal(result.status, 0, checkOutput(result));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("validates integrations and use-cases collections", () => {
	const root = mkdtempSync(join(tmpdir(), "agentos-docs-check-"));
	try {
		writePage(root, "docs/content/integrations/index.mdx", "\n");
		writePage(root, "docs/content/integrations/flue.mdx", "\n");
		writePage(root, "docs/content/use-cases/index.mdx", "\n");
		writePage(
			root,
			"docs/content/docs/links.mdx",
			"\n[i](/agentos/integrations/flue)\n[u](/agentos/use-cases)\n",
		);
		writeFileSync(
			join(root, "docs/sidebar.json"),
			JSON.stringify({
				integrations: [{ title: "Flue", href: "/agentos/integrations/flue" }],
			}),
		);

		const result = runCheck(root);
		assert.equal(result.status, 0, checkOutput(result));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fails broken sidebar href and skips website-owned sidebar href", () => {
	const root = mkdtempSync(join(tmpdir(), "agentos-docs-check-"));
	try {
		seedMinimalPassingTree(root);
		writeFileSync(
			join(root, "docs/sidebar.json"),
			JSON.stringify({
				docs: [
					{ title: "Bad", href: "/agentos/docs/missing-page" },
					{ title: "Registry", href: "/agentos/registry" },
				],
			}),
		);

		const out = checkOutput(assertFails(root, /sidebar href.*missing-page/));
		assert.doesNotMatch(out, /sidebar href.*registry/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fails missing CodeSnippet file", () => {
	const root = mkdtempSync(join(tmpdir(), "agentos-docs-check-"));
	try {
		seedMinimalPassingTree(root);
		writePage(
			root,
			"docs/content/docs/snippet-bad.mdx",
			'\n<CodeSnippet file="examples/missing.ts" />\n',
		);

		assertFails(root, /CodeSnippet file missing/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fails when docs/content is missing", () => {
	const root = mkdtempSync(join(tmpdir(), "agentos-docs-check-"));
	try {
		mkdirSync(join(root, "docs"), { recursive: true });
		writeMinimalSidebar(root);

		assertFails(root, /docs\/content\/ is missing/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fails when docs/sidebar.json is missing", () => {
	const root = mkdtempSync(join(tmpdir(), "agentos-docs-check-"));
	try {
		writePage(root, "docs/content/docs/index.mdx", "\n");

		assertFails(root, /docs\/sidebar\.json is missing/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
