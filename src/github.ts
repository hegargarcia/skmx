import { $ } from "bun";
import { z } from "zod";

const RepoListSchema = z.array(
  z.object({ nameWithOwner: z.string(), visibility: z.string() }),
);

/** Everything here goes through the `gh` CLI, so there is no OAuth flow to run. */
export async function assertGhReady() {
  const version = await $`gh --version`.nothrow().quiet();
  if (version.exitCode !== 0) {
    throw new Error("the GitHub CLI (gh) is required — see https://cli.github.com");
  }

  const auth = await $`gh auth status`.nothrow().quiet();
  if (auth.exitCode !== 0) throw new Error("gh is not signed in — run `gh auth login`");
}

export async function listRepos(limit = 100) {
  const result =
    await $`gh repo list --limit ${limit} --json nameWithOwner,visibility`.nothrow().quiet();
  if (result.exitCode !== 0) {
    throw new Error(`could not list repositories: ${result.stderr.toString().trim()}`);
  }

  return RepoListSchema.parse(await new Response(result.stdout).json());
}

/** Returns the new repository's `owner/name`. */
export async function createRepo(name: string, visibility: "public" | "private") {
  const result = await $`gh repo create ${name} --${visibility}`.nothrow().quiet();
  if (result.exitCode !== 0) {
    throw new Error(`could not create ${name}: ${result.stderr.toString().trim()}`);
  }

  const owner = await $`gh api user --jq .login`.nothrow().quiet();
  return `${owner.stdout.toString().trim()}/${name}`;
}
