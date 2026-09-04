import { access, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { from } from 'rxjs';
import { compile } from '../rsl/compile.ts';
import { toMermaid } from '../rsl/diagram.ts';
import { parseDocument } from '../rsl/document.ts';
import { RslError } from '../rsl/errors.ts';
import { toPipeView } from '../rsl/pipeview.ts';
import { errorName, traceLine, traceToJson } from '../rsl/trace.ts';
import type { TraceEvent } from '../rsl/trace.ts';
import type { Registry, RslMachine } from '../rsl/types.ts';
import { validate } from '../rsl/validate.ts';

/**
 * The `rsl` command line (spec §15). `main` is the whole program with its
 * input and output injected, so tests drive it directly; `bin.ts` wires it
 * to the process.
 */

export interface Io {
  readonly cwd: string;
  out(line: string): void;
  err(line: string): void;
}

export const USAGE = `rsl <command> <document.json> [options]

  validate <doc>                                   graph rules (spec §14), then the JSON Schema when ajv is installed
  pipe     <doc>                                   one line per state with the RxJS it stands for
  viz      <doc> [--out graph.mmd | graph.html] [--direction TD|LR]
  run      <doc> --registry <module> --input <values.json> [--trace trace.json] [--verbose]

The registry module's default export (or its "registry" export) is the registry.
--input is a JSON array; each element enters the machine as one token.
Exit codes: 0 ok, 1 the document or the run failed, 2 usage.`;

interface Flags {
  readonly out?: string;
  readonly direction?: string;
  readonly registry?: string;
  readonly input?: string;
  readonly trace?: string;
  readonly verbose?: boolean;
  readonly help?: boolean;
}

type Command = (path: string, flags: Flags, io: Io) => Promise<number>;

const COMMANDS = new Map<string, Command>([
  ['validate', validateCommand],
  ['pipe', pipeCommand],
  ['viz', vizCommand],
  ['run', runCommand],
]);

export async function main(argv: readonly string[], io: Io): Promise<number> {
  let command: string | undefined;
  let path: string | undefined;
  let flags: Flags;
  try {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        out: { type: 'string' },
        direction: { type: 'string' },
        registry: { type: 'string' },
        input: { type: 'string' },
        trace: { type: 'string' },
        verbose: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    });
    [command, path] = parsed.positionals;
    flags = parsed.values;
  } catch (error) {
    io.err(message(error));
    io.err(USAGE);
    return 2;
  }
  if (flags.help || command === 'help') {
    io.out(USAGE);
    return 0;
  }
  if (command === undefined) {
    io.err(USAGE);
    return 2;
  }
  const run = COMMANDS.get(command);
  if (run === undefined) {
    io.err(`unknown command "${command}"`);
    io.err(USAGE);
    return 2;
  }
  if (path === undefined) {
    io.err(`${command}: a document path is required`);
    io.err(USAGE);
    return 2;
  }
  try {
    return await run(resolve(io.cwd, path), flags, io);
  } catch (error) {
    io.err(error instanceof RslError ? error.message : `error: ${message(error)}`);
    return 1;
  }
}

// --- commands ---------------------------------------------------------------

async function validateCommand(path: string, _flags: Flags, io: Io): Promise<number> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    io.err(`${basename(path)}: not valid JSON: ${message(error)}`);
    return 1;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    io.err(`${basename(path)}: an RSL document is a JSON object with StartAt and States`);
    return 1;
  }
  const issues = validate(raw as RslMachine);
  for (const issue of issues) io.err(`${issue.path}: ${issue.message}`);
  const schema = await checkSchema(raw);
  for (const line of schema.errors) io.err(`schema: ${line}`);
  if (schema.skipped !== undefined) io.err(`schema: skipped (${schema.skipped})`);
  if (issues.length > 0 || schema.errors.length > 0) return 1;
  const machine = raw as RslMachine;
  io.out(`ok: ${Object.keys(machine.States).length} states, StartAt ${machine.StartAt}`);
  return 0;
}

async function pipeCommand(path: string, _flags: Flags, io: Io): Promise<number> {
  io.out(toPipeView(parseDocument(await readFile(path, 'utf8'))));
  return 0;
}

async function vizCommand(path: string, flags: Flags, io: Io): Promise<number> {
  if (flags.direction !== undefined && flags.direction !== 'TD' && flags.direction !== 'LR') {
    io.err(`viz: --direction must be TD or LR, got "${flags.direction}"`);
    return 2;
  }
  const machine = parseDocument(await readFile(path, 'utf8'));
  const mermaid = toMermaid(machine, { direction: flags.direction });
  if (flags.out === undefined) {
    io.out(mermaid);
    return 0;
  }
  const out = resolve(io.cwd, flags.out);
  const title = machine.Comment ?? basename(path);
  await writeFile(out, out.endsWith('.html') ? toHtml(mermaid, title) : `${mermaid}\n`);
  io.err(`wrote ${out}`);
  return 0;
}

async function runCommand(path: string, flags: Flags, io: Io): Promise<number> {
  if (flags.registry === undefined || flags.input === undefined) {
    io.err('run: --registry <module> and --input <values.json> are required');
    io.err(USAGE);
    return 2;
  }
  const machine = parseDocument(await readFile(path, 'utf8'));
  const registry = await loadRegistry(resolve(io.cwd, flags.registry));
  const values: unknown = JSON.parse(await readFile(resolve(io.cwd, flags.input), 'utf8'));
  if (!Array.isArray(values)) {
    io.err('run: --input must be a JSON array, one element per token');
    return 2;
  }
  const events: TraceEvent[] = [];
  const trace = (event: TraceEvent): void => {
    events.push(event);
    if (flags.verbose === true) io.err(traceLine(event));
  };
  const operator = compile(machine, registry, { trace });
  const code = await new Promise<number>((done) => {
    from(values as unknown[])
      .pipe(operator)
      .subscribe({
        next: (value) => io.out(JSON.stringify(value) ?? 'undefined'),
        error: (error: unknown) => {
          io.err(`error: ${errorName(error)}: ${message(error)}`);
          done(1);
        },
        complete: () => done(0),
      });
  });
  if (flags.trace !== undefined) {
    const file = resolve(io.cwd, flags.trace);
    await writeFile(file, traceToJson(events));
    io.err(`wrote ${file} (${events.length} events)`);
  }
  return code;
}

// --- helpers ----------------------------------------------------------------

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadRegistry(file: string): Promise<Registry> {
  const module: unknown = await import(pathToFileURL(file).href);
  const exports = module as { default?: unknown; registry?: unknown };
  const registry = exports.default ?? exports.registry;
  if (registry === null || typeof registry !== 'object') {
    throw new RslError(`${file}: the registry module must export the registry object as default or as "registry"`);
  }
  return registry as Registry;
}

/** The JSON Schema check, when `ajv` can be imported and `rsl.schema.json` is found next to the package. */
async function checkSchema(document: unknown): Promise<{ errors: string[]; skipped?: string }> {
  const schemaPath = await findSchema();
  if (schemaPath === undefined) return { errors: [], skipped: 'rsl.schema.json not found' };
  let Ajv2020: (typeof import('ajv/dist/2020.js'))['default'];
  try {
    ({ default: Ajv2020 } = await import('ajv/dist/2020.js'));
  } catch {
    return { errors: [], skipped: 'ajv is not installed' };
  }
  const ajv = new Ajv2020({ allErrors: true });
  const check = ajv.compile(JSON.parse(await readFile(schemaPath, 'utf8')) as object);
  if (check(document)) return { errors: [] };
  return { errors: (check.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message ?? ''}`.trim()) };
}

/** `rsl.schema.json` sits at the package root, a different number of levels up from `src/cli/` and from `dist/lib/cli/`. */
async function findSchema(): Promise<string | undefined> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let level = 0; level < 5; level += 1) {
    const candidate = resolve(dir, 'rsl.schema.json');
    try {
      await access(candidate);
      return candidate;
    } catch {
      dir = dirname(dir);
    }
  }
  return undefined;
}

/** A self-contained page that renders the flowchart with Mermaid from a CDN. */
export function toHtml(mermaid: string, title: string): string {
  const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>${escape(title)}</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 24px; }
  h1 { font-size: 18px; }
</style>
<h1>${escape(title)}</h1>
<pre class="mermaid">
${escape(mermaid)}
</pre>
<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
  mermaid.initialize({ startOnLoad: true });
</script>
</html>
`;
}
