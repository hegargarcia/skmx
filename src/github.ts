import { execa } from "execa";

export async function assertPrerequisites() {
  const git = await execa("git", ["--version"], { reject: false });
  if (git.exitCode !== 0) throw new Error("git is required and was not found on PATH");

  const gh = await execa("gh", ["--version"], { reject: false });
  if (gh.exitCode !== 0) {
    throw new Error("the GitHub CLI (gh) is required — install it from https://cli.github.com");
  }

  const auth = await execa("gh", ["auth", "status"], { reject: false });
  if (auth.exitCode !== 0) throw new Error("gh is not signed in — run `gh auth login`");
}

export async function resolveRepo(repo: string) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return repo;
  const configured = await execa("gh", ["config", "get", "git_protocol", "--host", "github.com"], {
    reject: false,
  });
  const field = configured.stdout.trim() === "https" ? "url" : "sshUrl";
  const result = await execa("gh", ["repo", "view", repo, "--json", field, "--jq", `.${field}`], {
    reject: false,
  });
  if (result.exitCode !== 0 || result.stdout.trim() === "") {
    throw new Error(`could not access ${repo}: ${result.stderr.trim() || "repository not found"}`);
  }
  return result.stdout.trim();
}

export function githubSlug(repo: string) {
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/.exec(
    repo,
  );
  return match?.[1] ?? (/^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null);
}

export const sameRepo = (one: string, other: string) =>
  (githubSlug(one) ?? one).toLowerCase() === (githubSlug(other) ?? other).toLowerCase();
