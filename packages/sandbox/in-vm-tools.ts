/**
 * The in-VM tool surface as a lazy sandbox advertises it BEFORE any VM exists.
 *
 * A booted transport lists the descriptions its in-VM MCP servers gave it. A lazy
 * one (`withSandbox({ lazy: true })`) has no VM until the first `sandbox_*` call,
 * but the actor's first prompt must already name the tools, so it lists this table.
 * The table is the CONTRACT for that prompt: the five file tools restate the pinned
 * `rust-mcp-filesystem` image's own descriptors under their `sandbox_` names, and
 * `sandbox_bash` restates `rootfs/mcp-shell/server.mjs`. Refreshing it after a bump
 * of that image or an edit of that server means re-recording
 * `__tests__/fixtures/in-vm-tools.recorded.json` (the drift pin fails until both
 * move together) and copying the same change here.
 *
 * Pure data: no `node:` imports.
 */
import type { MCPToolDescription } from '@hames-ai/harness-patterns/types'

const pathArg = (description: string) => ({ type: 'string', description })

export const IN_VM_TOOL_DESCRIPTORS: readonly MCPToolDescription[] = [
  {
    name: 'sandbox_read',
    description:
      'Read the complete contents of a text file from the file system as text. Handles various text encodings and provides detailed error messages if the file cannot be read. Use this tool when you need to examine the contents of a single file. Only works within allowed directories.',
    inputSchema: {
      type: 'object',
      properties: { path: pathArg('The path of the file to read.') },
      required: ['path'],
    },
  },
  {
    name: 'sandbox_write',
    description:
      'Create a new file or completely overwrite an existing file with new content. Use with caution as it will overwrite existing files without warning. Handles text content with proper encoding. Only works within allowed directories.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The content to write to the file.' },
        path: pathArg('The path of the file to write to.'),
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'sandbox_edit',
    description:
      'Make line-based edits to a text file. Each edit replaces exact line sequences with new content. Returns a git-style diff showing the changes made. Only works within allowed directories.',
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: {
          type: 'boolean',
          nullable: true,
          description: 'Preview changes using git-style diff format without applying them.',
        },
        edits: {
          type: 'array',
          description: 'The list of edit operations to apply.',
          items: {
            type: 'object',
            properties: {
              newText: { type: 'string', description: 'Text to replace the matched text with.' },
              oldText: {
                type: 'string',
                description: 'Text to search for - must match exactly.',
              },
            },
            required: ['oldText', 'newText'],
          },
        },
        path: pathArg('The path of the file to edit.'),
      },
      required: ['path', 'edits'],
    },
  },
  {
    name: 'sandbox_list',
    description:
      'Get a detailed listing of all files and directories in a specified path. Results clearly distinguish between files and directories with [FILE] and [DIR] prefixes. This tool is essential for understanding directory structure and finding specific files within a directory. Only works within allowed directories.',
    inputSchema: {
      type: 'object',
      properties: { path: pathArg('The path of the directory to list.') },
      required: ['path'],
    },
  },
  {
    name: 'sandbox_search',
    description:
      "Searches for text or regex patterns in the content of files matching matching a GLOB pattern.Returns detailed matches with file path, line number, column number and a preview of matched text.By default, it performs a literal text search; if the 'is_regex' parameter is set to true, it performs a regular expression (regex) search instead.Optional 'min_bytes' and 'max_bytes' arguments can be used to filter files by size, ensuring that only files within the specified byte range are included in the search. Ideal for finding specific code, comments, or text when you don’t know their exact location.",
    inputSchema: {
      type: 'object',
      properties: {
        excludePatterns: {
          type: 'array',
          nullable: true,
          description: 'Optional list of patterns to exclude from the search.',
          items: { type: 'string' },
        },
        is_regex: {
          type: 'boolean',
          nullable: true,
          description:
            'Whether the query is a regular expression. If false, the query as plain text. (Default : false)',
        },
        max_bytes: {
          type: 'integer',
          nullable: true,
          description: 'Maximum file size (in bytes) to include in the search (optional).',
        },
        min_bytes: {
          type: 'integer',
          nullable: true,
          description: 'Minimum file size (in bytes) to include in the search (optional).',
        },
        path: pathArg('The file or directory path to search in.'),
        pattern: { type: 'string', description: 'The file glob pattern to match (e.g., "*.rs").' },
        query: {
          type: 'string',
          description:
            "Text or regex pattern to find in file contents (e.g., 'TODO' or '^function\\\\s+').",
        },
      },
      required: ['path', 'pattern', 'query'],
    },
  },
  {
    name: 'sandbox_bash',
    description:
      'Run a shell command inside the sandbox via `bash -lc`. Use for Python ' +
      '(`python3 -c "..."` or run a script written to /work), package installs, ' +
      'file inspection, and any other shell work. Returns stdout, stderr, the ' +
      'exit code, and whether it timed out. Working directory defaults to /work.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute (passed to bash -lc).',
        },
        cwd: { type: 'string', description: 'Working directory. Defaults to /work.' },
        timeout_ms: {
          type: 'integer',
          exclusiveMinimum: 0,
          description: 'Wall-clock timeout in milliseconds. Defaults to 60000.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
]
