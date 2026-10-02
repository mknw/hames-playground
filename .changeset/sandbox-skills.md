---
'@hames-ai/sandbox': minor
'@hames-ai/agents': patch
---

`withSandbox` can mount Agent Skills. `WithSandboxConfig.skills` is a resolver called per run that returns `SandboxSkill[]` (a name, a description and the whole `SKILL.md`); each is written into the container as `/skills/<name>/SKILL.md` by a content-hash sync, and the description of `sandbox_bash` gains an index of them (name and description only) so the model reads a file only when it fits the task. The package enforces the specification's name rule, a 64 KiB per-file cap and at most 20 skills per run, and reports what it could not mount as a recoverable run event. The Docker backend mounts a 4 MiB `noexec` tmpfs at `/skills`. New exports: `SandboxSkill`, `SandboxSkillsResolver`, `SKILLS_DIR`, `SKILL_FILE_MAX_BYTES`, `MAX_MOUNTED_SKILLS`, `isSkillName` (and the `./skills` subpath, browser-safe). Without `skills`, nothing changes.

`@hames-ai/agents`: the sandbox-session agent's welcome text names the app's renamed Sandbox tab.
