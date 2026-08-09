import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { sameRepo } from "./github.ts";

const FALLBACK_AUTHOR = ["user.name=skill-sync", "user.email=skill-sync@localhost"];

export async function prepareRepo(repo: string, branch: string, repoDir: string) {
  if (repo.startsWith("-")) throw new Error("the repository cannot start with a dash");
  const branchCheck = await simpleGit().raw(["check-ref-format", "--branch", branch]).catch(() => "");
  if (branchCheck.trim() === "") throw new Error(`${branch} is not a valid Git branch name`);

  const gitHead = join(repoDir, ".git", "HEAD");
  if (!(await exists(gitHead))) {
    if (await exists(repoDir)) {
      throw new Error(`${repoDir} exists but is not a git checkout; move it aside and run setup again`);
    }
    await simpleGit().clone(repo, repoDir);
  }

  const git = simpleGit(repoDir);
  const origin = (await git.getConfig("remote.origin.url")).value ?? "";
  if (!sameRepo(origin, repo)) throw new Error(`${repoDir} is a checkout of ${origin || "no remote"}, not ${repo}`);

  await git.fetch("origin");
  const remoteBranch = `origin/${branch}`;
  if (await refExists(git, `refs/heads/${branch}`)) {
    await git.checkout(branch);
  } else if (await refExists(git, `refs/remotes/${remoteBranch}`)) {
    await git.checkoutBranch(branch, remoteBranch);
  } else {
    await git.checkoutLocalBranch(branch);
  }

  const [name, email] = await Promise.all([git.getConfig("user.name"), git.getConfig("user.email")]);
  return name.value && email.value ? git : simpleGit(repoDir, { config: FALLBACK_AUTHOR });
}

export async function refExists(git: SimpleGit, ref: string) {
  return git
    .revparse(["--verify", "--quiet", ref])
    .then((sha) => sha.trim() !== "")
    .catch(() => false);
}

const exists = (path: string) => lstat(path).then(() => true).catch(() => false);
