/**
 * Checks docs/content MDX and docs/sidebar.json:
 *   - every page has title + description frontmatter
 *   - /agentos/{docs,tutorials,integrations,use-cases} links resolve to an MDX file
 *   - #anchors match ## / ### headings (same-page and cross-page)
 *   - sidebar hrefs resolve (https:// and website-owned /agentos/* routes are skipped)
 *   - <CodeSnippet file="..."> paths exist at the repo root
 * Does not compile MDX; theme components live in rivet-dev/website.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Only these /agentos/<collection>/... paths map to files under docs/content/.
// Other /agentos/* routes (registry, self-host, …) are owned by the website repo.
const BUNDLE_COLLECTIONS = new Set([
	"docs",
	"tutorials",
	"integrations",
	"use-cases",
]);

// `--root` lets tests point the checker at a temp tree instead of this repo.
const argv = process.argv.slice(2);
let root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--root") {
		root = resolve(argv[++i]);
	}
}

const failures = [];
const fail = (message) => failures.push(message);
const rel = (path) => relative(root, path).split(sep).join("/");
/** Convert a string index into a 1-based line number. */
const lineNumberAt = (text, index) => text.slice(0, index).split("\n").length;

const docsRoot = join(root, "docs");
const contentRoot = join(docsRoot, "content");

/** Heading text to slug: "Foo & Bar" → "foo--bar". */
const slugifyHeading = (text) =>
	text
		.trim()
		.toLowerCase()
		// replace all contiguous whitespace with hyphens, e.g. "foo   bar" → "foo-bar"
		.replace(/\s+/g, "-")
		// remove all non-word and non-hyphen characters, e.g. "foo & bar!" → "foo--bar"
		.replace(/[^\w-]/g, "")
		// trim leading/trailing hyphens, e.g. "--foo-bar--" → "foo-bar"
		.replace(/^-+|-+$/g, "");

/**
 * Recursively walks through a directory and calls the visit callback
 * on every .mdx file found.
 */
function walkMdx(dir, visit) {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			walkMdx(path, visit);
		} else if (entry.name.endsWith(".mdx")) {
			visit(path);
		}
	}
}

/**
 * Map a site path like /agentos/docs/quickstart to an MDX file on disk.
 * Returns { path }, { missing }, or { skip } for routes this bundle does not own.
 */
function hrefToMdxPath(hrefPath) {
	if (!hrefPath.startsWith("/agentos/")) {
		return { skip: true };
	}
	const rest = hrefPath.slice("/agentos/".length).replace(/\/+$/, "");
	const parts = rest.split("/").filter(Boolean);
	if (parts.length === 0) {
		return { skip: true };
	}
	const collection = parts[0];
	// /agentos/registry and similar live in the website repo, not here.
	if (!BUNDLE_COLLECTIONS.has(collection)) {
		return { skip: true };
	}
	const slugParts = parts.slice(1);
	const baseDir = join(contentRoot, collection);
	let candidates;
	if (slugParts.length === 0) {
		candidates = [join(baseDir, "index.mdx")];
	} else {
		const slugPath = slugParts.join("/");
		candidates = [
			join(baseDir, `${slugPath}.mdx`),
			join(baseDir, slugPath, "index.mdx"),
		];
	}
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return { path: candidate };
		}
	}
	return { missing: hrefPath };
}

/** Fail if #fragment is not a ## / ### heading slug in the target page. */
function checkFragment(sourcePath, line, targetText, fragment, suffix) {
	const headings = new Set();
	for (const headingLine of targetText.split("\n")) {
		// For each line in the page, check if it starts with '##' or '###'.
		const match = /^(#{2,3})\s+(.+)$/.exec(headingLine);
		// If it matches, generate a slug from the heading text and add it to the set of headings for lookup.
		if (match) {
			headings.add(slugifyHeading(match[2]));
		}
	}
	const fragSlug = slugifyHeading(decodeURIComponent(fragment));
	if (!headings.has(fragSlug)) {
		fail(`${rel(sourcePath)}:${line}: broken anchor #${fragment}${suffix}`);
	}
}

/**
 * Check one /agentos/... URL found in sourcePath.
 * skip = another product's route (e.g. /agentos/registry); ignore it.
 * missing = this bundle should have that page, but the MDX file is gone.
 * If the URL has #fragment, also require that heading on the target page.
 */
function checkCrossPage(sourcePath, sourceText, line, pathPart, fragment) {
	const resolved = hrefToMdxPath(pathPart);
	if (resolved.skip) {
		return;
	}
	if (resolved.missing) {
		fail(
			`${rel(sourcePath)}:${line}: broken link ${pathPart}${fragment ? `#${fragment}` : ""}`,
		);
		return;
	}
	if (fragment) {
		const targetText =
			resolved.path === sourcePath
				? sourceText
				: readFileSync(resolved.path, "utf8");
		checkFragment(sourcePath, line, targetText, fragment, ` on ${pathPart}`);
	}
}

/** Recursively check every href in sidebar.json. */
function walkSidebar(node) {
	if (Array.isArray(node)) {
		for (const item of node) {
			walkSidebar(item);
		}
		return;
	}
	if (typeof node !== "object" || node === null) {
		return;
	}
	if (typeof node.href === "string") {
		const href = node.href;
		if (/^https?:\/\//i.test(href)) {
			return;
		}
		const resolved = hrefToMdxPath(href.replace(/\/+$/, ""));
		if (resolved.skip) {
			return;
		}
		if (resolved.missing) {
			fail(`docs/sidebar.json: broken sidebar href ${href}`);
		}
	}
	for (const value of Object.values(node)) {
		walkSidebar(value);
	}
}

let pageCount = 0;

if (!existsSync(contentRoot)) {
	fail("docs/content/ is missing");
} else {
	// Scan every docs page.
	walkMdx(contentRoot, (mdxPath) => {
		pageCount += 1;
		const text = readFileSync(mdxPath, "utf8");

		// Each page must have a frontmatter with a title and description.
		const fm = /^---\n([\s\S]*?)\n---/.exec(text);
		if (!fm) {
			fail(`${rel(mdxPath)}: missing frontmatter`);
		} else {
			if (!/^title:\s/m.test(fm[1])) {
				fail(`${rel(mdxPath)}: frontmatter missing title`);
			}
			if (!/^description:\s/m.test(fm[1])) {
				fail(`${rel(mdxPath)}: frontmatter missing description`);
			}
		}

		// Links to other /agentos pages must point at a real MDX file, including any #anchor.
		for (const match of text.matchAll(
			/\]\((\/agentos\/[^)\s#]+)(#[^)\s]+)?\)/g,
		)) {
			checkCrossPage(
				mdxPath,
				text,
				lineNumberAt(text, match.index),
				match[1],
				match[2]?.slice(1) ?? "",
			);
		}
		// Same check for href="/agentos/..." on cards and other MDX components.
		for (const match of text.matchAll(/href="(\/agentos\/[^"#]+)(#[^"]+)?"/g)) {
			checkCrossPage(
				mdxPath,
				text,
				lineNumberAt(text, match.index),
				match[1],
				match[2]?.slice(1) ?? "",
			);
		}
		// Same-page #anchors must match a heading on this file.
		for (const match of text.matchAll(/\]\((#[^)\s]+)\)/g)) {
			checkFragment(
				mdxPath,
				lineNumberAt(text, match.index),
				text,
				match[1].slice(1),
				"",
			);
		}

		// Embedded example files in <CodeSnippet> must exist in the repo.
		for (const match of text.matchAll(/<CodeSnippet\s+[^>]*file="([^"]+)"/g)) {
			if (!existsSync(join(root, match[1]))) {
				fail(
					`${rel(mdxPath)}:${lineNumberAt(text, match.index)}: CodeSnippet file missing: ${match[1]}`,
				);
			}
		}
	});
}

const sidebarPath = join(docsRoot, "sidebar.json");
if (!existsSync(sidebarPath)) {
	fail("docs/sidebar.json is missing");
} else if (existsSync(contentRoot)) {
	walkSidebar(JSON.parse(readFileSync(sidebarPath, "utf8")));
}

if (failures.length > 0) {
	for (const failure of failures) {
		console.error(`check-docs: ${failure}`);
	}
	process.exit(1);
}

console.log(`check-docs: OK (${pageCount} pages)`);
